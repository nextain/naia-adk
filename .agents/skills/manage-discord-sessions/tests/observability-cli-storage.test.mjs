import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { SessionStore } from "../helper/store.mjs";
import { assertOwnerOnly } from "../helper/platform-security.mjs";
import { heartbeatServiceSafely } from "../helper/service.mjs";
import { cleanupRoots, createRunningJob, fixture, iso, roots } from "./observability-fixture.mjs";

const cliPath = fileURLToPath(new URL("../helper/cli.mjs", import.meta.url));

afterEach(cleanupRoots);

function storeStatusSchema(root) {
	const status = spawnSync(process.execPath, [cliPath, "--adk-root", root, "status", "--json"], { encoding: "utf8" });
	assert.equal(status.status, 0, status.stderr);
	return JSON.parse(status.stdout).schemaVersion;
}

test("DSO-003 CLI returns versioned job detail and watch events", () => {
	const { root, store } = fixture();
	const { jobId, attemptId } = createRunningJob(store);
	store.recordEvent({ jobId, attemptId, dedupeKey: "phase-cli-1", kind: "phase_changed", occurredAt: iso(1_000), source: "codex", safePayload: { phase: "testing" } });
	store.close();

	const detail = spawnSync(process.execPath, [cliPath, "--adk-root", root, "job", jobId, "--json"], { encoding: "utf8" });
	assert.equal(detail.status, 0, detail.stderr);
	const parsed = JSON.parse(detail.stdout);
	assert.equal(parsed.schemaVersion, 1);
	assert.equal(parsed.job.jobId, jobId);
	assert.equal(parsed.job.events.at(-1).kind, "phase_changed");
	assert.equal(storeStatusSchema(root), 1);

	const watch = spawnSync(process.execPath, [cliPath, "--adk-root", root, "watch", "--job", jobId, "--jsonl", "--once"], { encoding: "utf8" });
	assert.equal(watch.status, 0, watch.stderr);
	const watched = watch.stdout.trim().split("\n").map((line) => JSON.parse(line));
	assert.ok(watched.length >= 3);
	assert.equal(new Set(watched.map((item) => item.event.ordinal)).size, watched.length);

	const logs = spawnSync(process.execPath, [cliPath, "--adk-root", root, "logs", "--job", jobId, "--jsonl"], { encoding: "utf8" });
	assert.equal(logs.status, 0, logs.stderr);
	assert.deepEqual(logs.stdout.trim().split("\n").map((line) => JSON.parse(line).event.kind), watched.map((item) => item.event.kind));

	const monitor = spawnSync(process.execPath, [cliPath, "--adk-root", root, "monitor", "--once"], { encoding: "utf8" });
	assert.equal(monitor.status, 0, monitor.stderr);
	assert.match(monitor.stdout, /Jobs \(active and recent terminal\):/);
	assert.match(monitor.stdout, new RegExp(jobId));
	assert.match(monitor.stdout, /phase_changed/);

	const missing = spawnSync(process.execPath, [cliPath, "--adk-root", root, "job", "missing"], { encoding: "utf8" });
	assert.equal(missing.status, 2);
});

test("UCT_DSO_014_001 replays durable logs and keeps recent work visible in the named monitor", () => {
	const { root, store } = fixture();
	const { jobId, attemptId } = createRunningJob(store, { jobId: "operator-console-job" });
	store.recordEvent({ jobId, attemptId, source: "helper", kind: "failed", safePayload: { reasonCode: "process_exit" } });
	store.close();
	const logs = spawnSync(process.execPath, [cliPath, "--adk-root", root, "logs", "--job", jobId], { encoding: "utf8" });
	assert.equal(logs.status, 0, logs.stderr);
	assert.match(logs.stdout, /attempt_started/);
	assert.match(logs.stdout, /failed/);
	const monitor = spawnSync(process.execPath, [cliPath, "--adk-root", root, "monitor", "--once"], { encoding: "utf8" });
	assert.equal(monitor.status, 0, monitor.stderr);
	assert.match(monitor.stdout, /operator-console-job/);
	assert.match(monitor.stdout, /failed/);
});

test("FET_DSO_014_001 monitor distinguishes service state jobs and durable timeline", () => {
	const { root, store } = fixture();
	const { jobId, attemptId } = createRunningJob(store, { jobId: "timeline-job" });
	store.recordEvent({ jobId, attemptId, dedupeKey: "feature-phase", source: "codex", kind: "phase_changed", safePayload: { phase: "testing" } });
	store.close();
	const monitor = spawnSync(process.execPath, [cliPath, "--adk-root", root, "monitor", "--once"], { encoding: "utf8" });
	assert.equal(monitor.status, 0, monitor.stderr);
	assert.match(monitor.stdout, /service=/);
	assert.match(monitor.stdout, /Jobs \(active and recent terminal\):/);
	assert.match(monitor.stdout, /Latest timeline:/);
	assert.match(monitor.stdout, /phase_changed/);
});

test("DSO-003 status on a clean ADK is read-only and reports stopped", () => {
	const root = mkdtempSync(join(tmpdir(), "naia-discord-empty-"));
	roots.push(root);
	const status = spawnSync(process.execPath, [cliPath, "--adk-root", root, "status", "--json"], { encoding: "utf8" });
	assert.equal(status.status, 0, status.stderr);
	assert.equal(JSON.parse(status.stdout).service.state, "stopped");
	assert.equal(existsSync(join(root, "naia-settings")), false);
});

test("DSO-003 named or persisted state without its config fails closed", () => {
	const root = mkdtempSync(join(tmpdir(), "naia-discord-missing-config-"));
	roots.push(root);
	const named = spawnSync(process.execPath, [cliPath, "--adk-root", root, "--instance", "alpha", "status", "--json"], { encoding: "utf8" });
	assert.equal(named.status, 3);
	const databasePath = join(root, "naia-settings/.sessions/messenger-sessions/runtime.sqlite3");
	new SessionStore(databasePath).close();
	const persisted = spawnSync(process.execPath, [cliPath, "--adk-root", root, "status", "--json"], { encoding: "utf8" });
	assert.equal(persisted.status, 3);
});

test("DSO-003 status reads an existing ledger while another process owns the write lock", () => {
	const { root, databasePath, store } = fixture();
	store.heartbeatService({ generation: "generation-1", pid: process.pid, now: iso() });
	store.close();
	const writer = new DatabaseSync(databasePath);
	writer.exec("BEGIN IMMEDIATE");
	try {
		const status = spawnSync(process.execPath, [cliPath, "--adk-root", root, "status", "--json"], { encoding: "utf8", timeout: 2_000 });
		assert.equal(status.status, 0, status.stderr);
		assert.equal(JSON.parse(status.stdout).service.reasonCode, "heartbeat_stale");
	} finally {
		writer.exec("ROLLBACK");
		writer.close();
	}
});

test("DSO-002 bounds SQLite contention and skips only a busy heartbeat", () => {
	const { databasePath, store } = fixture();
	store.heartbeatService({ generation: "generation-1", pid: process.pid, now: iso() });
	store.close();
	const heartbeatStore = new SessionStore(databasePath, {}, { busyTimeoutMs: 25 });
	const writer = new DatabaseSync(databasePath);
	writer.exec("BEGIN IMMEDIATE");
	let busyCount = 0;
	try {
		assert.equal(heartbeatServiceSafely(heartbeatStore, { generation: "generation-1", pid: process.pid, now: iso(1_000) }, { onBusy: () => { busyCount += 1; } }), false);
		assert.equal(busyCount, 1);
	} finally {
		writer.exec("ROLLBACK");
		writer.close();
	}
	assert.equal(heartbeatServiceSafely(heartbeatStore, { generation: "generation-1", pid: process.pid, now: iso(2_000) }, { onBusy: () => { busyCount += 1; } }), true);
	assert.equal(busyCount, 1);
	heartbeatStore.close();
	assert.throws(() => heartbeatServiceSafely({ heartbeatService: () => { throw new Error("unexpected corruption"); } }, {}), /unexpected corruption/);
	assert.throws(() => heartbeatServiceSafely({ heartbeatService: () => { throw new Error("database is locked"); } }, {}), /database is locked/);
});

test("DSO-002 rejects a second live service generation", () => {
	const { store } = fixture();
	store.heartbeatService({ generation: "generation-1", pid: process.pid, now: iso() });
	assert.throws(() => store.heartbeatService({ generation: "generation-2", pid: process.pid, now: iso(1_000) }), /ownership conflict/);
	store.close();
});

test("DSO-002 lets the current service generation record a clean stop", () => {
	const { store } = fixture();
	store.heartbeatService({ generation: "generation-1", pid: process.pid, now: iso() });
	assert.doesNotThrow(() => store.heartbeatService({ generation: "generation-1", status: "stopped", pid: null, now: iso(1_000) }));
	assert.equal(store.status({ nowMs: Date.parse(iso(1_000)) }).service.state, "stopped");
	store.close();
});

test("DSO-002 rejects a clean-stop claim without owner identity evidence", () => {
	const { store } = fixture({ readBootId: () => null, readProcessStartIdentity: () => null });
	assert.throws(() => store.heartbeatService({ generation: "generation-1", pid: process.pid, now: iso() }), /ownership evidence is required/);
	store.close();
});

test("DSO-006 permits a new service generation across a boot boundary", () => {
	let bootId = "11111111-1111-1111-1111-111111111111";
	const { store } = fixture({ readBootId: () => bootId, readProcessStartIdentity: () => "1" });
	store.heartbeatService({ generation: "generation-1", pid: process.pid, now: iso() });
	bootId = "22222222-2222-2222-2222-222222222222";
	assert.doesNotThrow(() => store.heartbeatService({ generation: "generation-2", pid: process.pid, now: iso(1_000) }));
	store.close();
});

test("DSO-002 rejects a forged owner tuple within one generation", () => {
	let processIdentity = "1";
	const { store } = fixture({ readBootId: () => "11111111-1111-1111-1111-111111111111", readProcessStartIdentity: () => processIdentity });
	store.heartbeatService({ generation: "generation-1", pid: process.pid, now: iso() });
	processIdentity = "2";
	assert.throws(() => store.heartbeatService({ generation: "generation-1", pid: process.pid, now: iso(1_000) }), /ownership conflict within generation/);
	store.close();
});

test("DSO-001 rejects a newer database schema without mutating it", () => {
	const { databasePath, store } = fixture();
	store.close();
	const db = new DatabaseSync(databasePath);
	db.prepare("UPDATE metadata SET value = '999' WHERE key = 'schema_version'").run();
	db.close();
	const before = readFileSync(databasePath);
	assert.throws(() => new SessionStore(databasePath), /schema is newer/);
	assert.deepEqual(readFileSync(databasePath), before);
});

test("DSO-009 fresh stores do not recreate the withdrawn coordinator API or table", () => {
	const { databasePath, store } = fixture();
	assert.equal(store.upsertCoordinatorScope, undefined);
	assert.equal(store.getCoordinatorScope, undefined);
	for (const internal of ["db", "events", "conversations", "jobs", "reader"]) assert.equal(store[internal], undefined);
	store.close();
	const db = new DatabaseSync(databasePath, { readOnly: true });
	const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'coordinator_scopes'").get();
	db.close();
	assert.equal(row, undefined);
});

test("DSO-009 reopening a legacy store preserves withdrawn coordinator rows without exposing them", () => {
	const { databasePath, store } = fixture();
	store.close();
	const legacy = new DatabaseSync(databasePath);
	legacy.exec("CREATE TABLE coordinator_scopes(scope_key TEXT PRIMARY KEY, policy_revision TEXT NOT NULL, last_ingress_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
	legacy.prepare("INSERT INTO coordinator_scopes VALUES (?, ?, ?, ?, ?)").run("legacy-scope", "legacy-policy", "legacy-ingress", iso(), iso());
	legacy.close();
	const reopened = new SessionStore(databasePath);
	assert.equal(reopened.getCoordinatorScope, undefined);
	reopened.close();
	const verified = new DatabaseSync(databasePath, { readOnly: true });
	assert.deepEqual({ ...verified.prepare("SELECT scope_key, policy_revision, last_ingress_id FROM coordinator_scopes").get() }, { scope_key: "legacy-scope", policy_revision: "legacy-policy", last_ingress_id: "legacy-ingress" });
	verified.close();
});

test("DSO-003 rejects ambiguous CLI arguments", () => {
	const root = mkdtempSync(join(tmpdir(), "naia-discord-cli-"));
	roots.push(root);
	for (const args of [
		["watch", "--job"],
		["status", "--unknown"],
		["status", "extra"],
		["jobs", "--active", "--failed"],
	]) {
		const result = spawnSync(process.execPath, [cliPath, "--adk-root", root, ...args], { encoding: "utf8" });
		assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
	}
});

test("DSO-005 refuses a symlinked session database", (context) => {
	const root = mkdtempSync(join(tmpdir(), "naia-discord-symlink-"));
	roots.push(root);
	const stateDir = join(root, "state");
	mkdirSync(stateDir, { mode: 0o700 });
	const external = join(root, "external.sqlite3");
	writeFileSync(external, "not a database", { mode: 0o600 });
	const linked = join(stateDir, "runtime.sqlite3");
	try { symlinkSync(external, linked); }
	catch (error) { if (process.platform === "win32" && error.code === "EPERM") return context.skip("Windows symlink privilege is unavailable"); throw error; }
	assert.throws(() => new SessionStore(linked), /real file|symbolic link/);
});

test("DSO-005 refuses symlinked SQLite sidecars before open", (context) => {
	const root = mkdtempSync(join(tmpdir(), "naia-discord-sidecar-symlink-"));
	roots.push(root);
	const stateDir = join(root, "state");
	mkdirSync(stateDir, { mode: 0o700 });
	const databasePath = join(stateDir, "runtime.sqlite3");
	writeFileSync(databasePath, "", { mode: 0o600 });
	const external = join(root, "external-wal");
	writeFileSync(external, "unchanged", { mode: 0o600 });
	try { symlinkSync(external, `${databasePath}-wal`); }
	catch (error) { if (process.platform === "win32" && error.code === "EPERM") return context.skip("Windows symlink privilege is unavailable"); throw error; }
	const before = readFileSync(external, "utf8");
	assert.throws(() => new SessionStore(databasePath), /sidecar must be a real file/);
	assert.equal(readFileSync(external, "utf8"), before);
});

test("DSO-005 keeps SQLite database and sidecars private", () => {
	const { databasePath, store } = fixture();
	createRunningJob(store);
	for (const suffix of ["", "-wal", "-shm"]) {
		const path = `${databasePath}${suffix}`;
		if (!existsSync(path)) continue;
		if (process.platform === "win32") assert.doesNotThrow(() => assertOwnerOnly(path, "file", "SQLite state"));
		else assert.equal(statSync(path).mode & 0o777, 0o600, path);
	}
	store.close();
});
