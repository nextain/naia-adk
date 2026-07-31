import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertSupportedBackendVersion, getBackendAdapter, parseBackendLine } from "../helper/adapters.mjs";
import { prepareChildEnvironment, resolveExecutionCwd, runBackendAttempt } from "../helper/backend-runner.mjs";
import { commandOptionsForProfile } from "../helper/execution-profile.mjs";
import { SessionStore } from "../helper/store.mjs";

const roots = [];
const fakeBackendPath = fileURLToPath(new URL("./fixtures/fake-backend.mjs", import.meta.url));

async function waitForStoppedProcess(pid) {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			if (stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[0] === "Z") return "Z";
		} catch (error) {
			if (error.code === "ENOENT") return null;
			throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return "live";
}

afterEach(() => {
	while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function fixture(backendId) {
	const root = mkdtempSync(join(tmpdir(), "naia-backend-runner-"));
	roots.push(root);
	const databasePath = join(root, "naia-settings/.sessions/messenger-sessions/runtime.sqlite3");
	const stateRoot = join(root, "naia-settings/.sessions/messenger-sessions");
	const store = new SessionStore(databasePath);
	store.createJob({ jobId: `${backendId}-job`, backendId, revision: "rev-1", activityDetail: "structured", jobType: "issue_work" });
	return { root, stateRoot, store, jobId: `${backendId}-job` };
}

test("DSO-006 exposes independent Codex and Claude command contracts", () => {
	const probe = spawnSync(process.execPath, [fakeBackendPath, "exec"], { input: "probe", encoding: "utf8" });
	assert.equal(probe.status, 0, probe.stderr);
	assert.match(probe.stdout, /thread\.started/);
	const codex = getBackendAdapter("codex").command({ cwd: "/workspace", approvalPolicy: "never" });
	const claude = getBackendAdapter("claude").command({ cwd: "/workspace" });
	assert.deepEqual(codex.args.slice(0, 3), ["exec", "--json", "--ephemeral"]);
	assert.ok(codex.args.includes("--ignore-user-config"));
	assert.equal(codex.args[codex.args.indexOf("--config") + 1], 'approval_policy="never"');
	assert.equal(codex.args[codex.args.indexOf("--cd") + 1], "/workspace");
	assert.ok(claude.args.includes("stream-json"));
	assert.ok(claude.args.includes("dontAsk"));
	assert.equal(assertSupportedBackendVersion("codex", "codex-cli 0.146.0"), "0.146.0");
	assert.equal(assertSupportedBackendVersion("claude", "2.1.220 (Claude Code)"), "2.1.220");
	assert.throws(() => assertSupportedBackendVersion("codex", "codex-cli 0.145.0"), /not supported/);
	assert.throws(() => getBackendAdapter("missing"), /unsupported backend/);
	assert.throws(() => commandOptionsForProfile({ backendId: "codex", permissionProfileEpoch: "managed-1", authorizationMode: "managed", access: "workspace-write" }), /invalid execution profile/);
	assert.throws(() => resolveExecutionCwd("relative-workspace"), /must be absolute/);
});

test("DSO-006 normalizes provider streams without retaining model content", () => {
	const secret = "do-not-persist-this-prompt";
	const codex = parseBackendLine({ backendId: "codex", attemptId: "attempt-1", lineNumber: 1, line: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: secret } }) });
	const claude = parseBackendLine({ backendId: "claude", attemptId: "attempt-2", lineNumber: 1, line: JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: secret }] } }) });
	assert.deepEqual(codex.map((event) => event.kind), ["output_activity"]);
	assert.deepEqual(claude.map((event) => event.kind), ["output_activity"]);
	assert.ok(!JSON.stringify({ codex, claude }).includes(secret));
});

test("DSO-005 creates a private minimal child environment and copies only provider auth", () => {
	const root = mkdtempSync(join(tmpdir(), "naia-child-env-"));
	roots.push(root);
	const authRoot = join(root, "auth-source");
	mkdirSync(join(authRoot, ".codex"), { recursive: true });
	mkdirSync(join(authRoot, ".claude"), { recursive: true });
	writeFileSync(join(authRoot, ".codex", "auth.json"), "codex-auth", { mode: 0o600 });
	writeFileSync(join(authRoot, ".codex", "config.toml"), "must-not-copy", { mode: 0o600 });
	writeFileSync(join(authRoot, ".claude", ".credentials.json"), "claude-auth", { mode: 0o600 });
	writeFileSync(join(authRoot, ".claude", "settings.json"), "must-not-copy", { mode: 0o600 });
	const parentEnv = { PATH: `${process.env.PATH}:${join(root, "workspace/node_modules/.bin")}:.`, LANG: "C.UTF-8", DISCORD_TOKEN: "discord-secret", CODEX_API_KEY: "codex-key", OPENAI_API_KEY: "wrong-key" };
	const codex = prepareChildEnvironment({ backendId: "codex", attemptId: "codex-attempt", runtimeRoot: join(root, "runtime"), parentEnv, authRoot });
	const codexOauth = prepareChildEnvironment({ backendId: "codex", attemptId: "codex-oauth-attempt", runtimeRoot: join(root, "runtime"), parentEnv: { PATH: process.env.PATH }, authRoot });
	const claude = prepareChildEnvironment({ backendId: "claude", attemptId: "claude-attempt", runtimeRoot: join(root, "runtime"), parentEnv, authRoot });
	assert.equal(codex.env.DISCORD_TOKEN, undefined);
	assert.equal(codex.env.OPENAI_API_KEY, undefined);
	assert.equal(codex.env.CODEX_API_KEY, "codex-key");
	assert.ok(!codex.env.PATH.includes("node_modules"));
	assert.ok(!codex.env.PATH.split(":").includes("."));
	assert.equal(statSync(codex.childHome).mode & 0o777, 0o700);
	assert.deepEqual(readdirSync(join(codex.childHome, ".codex")).sort(), []);
	assert.deepEqual(readdirSync(join(codexOauth.childHome, ".codex")).sort(), ["auth.json"]);
	assert.equal(readFileSync(join(codexOauth.childHome, ".codex", "auth.json"), "utf8"), "codex-auth");
	assert.deepEqual(readdirSync(join(claude.childHome, ".claude")).sort(), [".credentials.json"]);
});

test("DSO-005 rejects insecure auth permissions and cleans the partial child home", () => {
	const root = mkdtempSync(join(tmpdir(), "naia-insecure-auth-"));
	roots.push(root);
	const authRoot = join(root, "auth-source");
	mkdirSync(join(authRoot, ".codex"), { recursive: true });
	writeFileSync(join(authRoot, ".codex", "auth.json"), "unsafe", { mode: 0o644 });
	const runtimeRoot = join(root, "runtime");
	assert.throws(() => prepareChildEnvironment({ backendId: "codex", attemptId: "bad-auth", runtimeRoot, parentEnv: { PATH: process.env.PATH }, authRoot }), /permissions/);
	assert.deepEqual(readdirSync(join(runtimeRoot, "children")), []);
});

for (const backendId of ["codex", "claude"]) {
	test(`DSO-006 runs ${backendId} independently and persists only safe activity`, async () => {
		const { root, stateRoot, store, jobId } = fixture(backendId);
		const prompt = `private-${backendId}-prompt-987654`;
		const runtimeRoot = join(root, "runtime");
		const result = await runBackendAttempt({ store, jobId, backendId, prompt, cwd: root, runtimeRoot, executable: fakeBackendPath, backendVersion: backendId === "codex" ? "0.146.0" : "2.1.220", requireAuthentication: false, parentEnv: { PATH: process.env.PATH, LANG: "C.UTF-8", DISCORD_TOKEN: "must-not-leak" } });
		assert.equal(result.exitCode, 0);
		const job = store.getJob(jobId);
		assert.equal(job.lifecycle, "result_ready");
		assert.ok(job.events.some((event) => event.kind === "backend_ready"), JSON.stringify(job.events));
		assert.ok(job.events.some((event) => event.kind === "output_activity"));
		assert.ok(job.events.some((event) => event.kind === "attempt_exited"));
		assert.ok(job.events.some((event) => event.kind === "attempt_succeeded"));
		assert.deepEqual(readdirSync(join(runtimeRoot, "children")), []);
		store.close();
		for (const file of ["runtime.sqlite3", "runtime.sqlite3-wal", "runtime.sqlite3-shm"]) {
			const path = join(stateRoot, file);
			try { assert.ok(!readFileSync(path).includes(Buffer.from(prompt))); } catch (error) { if (error.code !== "ENOENT") throw error; }
		}
	});
}

test("DSO-006 times out, escalates termination, and records failure", async () => {
	const { root, stateRoot, store, jobId } = fixture("codex");
	const result = await runBackendAttempt({ store, jobId, backendId: "codex", prompt: "__fake_hang__", cwd: root, runtimeRoot: join(root, "runtime"), executable: fakeBackendPath, backendVersion: "0.146.0", requireAuthentication: false, timeoutMs: 150, killGraceMs: 20, parentEnv: { PATH: process.env.PATH } });
	assert.equal(result.terminationReason, "timeout");
	const job = store.getJob(jobId);
	assert.equal(job.lifecycle, "failed");
	assert.ok(job.events.some((event) => event.kind === "cancel_requested"));
	assert.ok(job.events.some((event) => event.kind === "attempt_exited" && event.safeSummary.includes("SIGKILL")));
	store.close();
});

test("DSO-007 no-progress intervention terminates an active child without an approval wait", async () => {
	const { root, store, jobId } = fixture("codex");
	const controller = new AbortController();
	const pending = runBackendAttempt({ store, jobId, backendId: "codex", prompt: "__fake_hang__", cwd: root, runtimeRoot: join(root, "runtime"), executable: fakeBackendPath, backendVersion: "0.146.0", requireAuthentication: false, signal: controller.signal, timeoutMs: 5_000, killGraceMs: 20, parentEnv: { PATH: process.env.PATH } });
	for (let attempt = 0; attempt < 50 && !store.getJob(jobId, { includeEvents: false })?.attemptId; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.ok(store.getJob(jobId, { includeEvents: false })?.attemptId, "child did not start in time");
	controller.abort("no_progress");
	const result = await pending;
	const job = store.getJob(jobId);
	assert.equal(result.terminationReason, "no_progress");
	assert.equal(job.lifecycle, "failed");
	assert.equal(job.latestSafeError, "Job failed: no_progress_timeout");
	assert.equal(job.events.some((event) => event.kind === "approval_required"), false);
	store.close();
});

test("DSO-006 rejects an approval UI instead of waiting for a child prompt", async () => {
	const { root, store, jobId } = fixture("codex");
	const result = await runBackendAttempt({ store, jobId, backendId: "codex", prompt: "__fake_approval_ui__", cwd: root, runtimeRoot: join(root, "runtime"), executable: fakeBackendPath, commandOptions: { sandbox: "workspace-write", approvalPolicy: "never" }, backendVersion: "0.146.0", requireAuthentication: false, timeoutMs: 1_000, killGraceMs: 20, parentEnv: { PATH: process.env.PATH } });
	assert.equal(result.terminationReason, "approval_ui");
	const job = store.getJob(jobId);
	assert.equal(job.lifecycle, "failed");
	assert.equal(job.events.some((event) => event.kind === "approval_required"), false);
	assert.equal(job.latestSafeError, "Job failed: approval_ui_detected");
	store.close();
});

for (const prompt of ["__fake_stderr_approval_ui__", "__fake_nested_approval_ui__"]) {
	test(`DSO-007 rejects ${prompt} without waiting for a newline or a hidden approval field`, async () => {
		const { root, store, jobId } = fixture("codex");
		const result = await runBackendAttempt({ store, jobId, backendId: "codex", prompt, cwd: root, runtimeRoot: join(root, "runtime"), executable: fakeBackendPath, commandOptions: { sandbox: "workspace-write", approvalPolicy: "never" }, backendVersion: "0.146.0", requireAuthentication: false, timeoutMs: 1_000, killGraceMs: 20, parentEnv: { PATH: process.env.PATH } });
		assert.equal(result.terminationReason, "approval_ui");
		assert.equal(store.getJob(jobId).latestSafeError, "Job failed: approval_ui_detected");
		store.close();
	});
}

test("DSO-006 binds each child to the requested absolute workspace despite parent cwd", async () => {
	const { root, store, jobId } = fixture("codex");
	const workspace = join(root, "explicit-workspace");
	mkdirSync(workspace, { mode: 0o700 });
	const marker = join(root, "child-cwd");
	await runBackendAttempt({ store, jobId, backendId: "codex", prompt: `__fake_cwd_marker__:${marker}`, cwd: workspace, runtimeRoot: join(root, "runtime"), executable: fakeBackendPath, backendVersion: "0.146.0", requireAuthentication: false, parentEnv: { PATH: process.env.PATH } });
	assert.equal(readFileSync(marker, "utf8"), resolve(workspace));
	store.close();
});

test("DSO-006 treats structured failure plus exit zero as failed", async () => {
	const { root, store, jobId } = fixture("claude");
	const result = await runBackendAttempt({ store, jobId, backendId: "claude", prompt: "__fake_structured_failure__", cwd: root, runtimeRoot: join(root, "runtime"), executable: fakeBackendPath, backendVersion: "2.1.220", requireAuthentication: false, parentEnv: { PATH: process.env.PATH } });
	assert.equal(result.backendOutcome, "failure");
	assert.equal(store.getJob(jobId).lifecycle, "failed");
	store.close();
});

test("DSO-006 records nonzero exit without accepting backend success", async () => {
	const { root, store, jobId } = fixture("codex");
	const result = await runBackendAttempt({ store, jobId, backendId: "codex", prompt: "__fake_nonzero__", cwd: root, runtimeRoot: join(root, "runtime"), executable: fakeBackendPath, backendVersion: "0.146.0", requireAuthentication: false, parentEnv: { PATH: process.env.PATH } });
	assert.equal(result.exitCode, 7);
	assert.equal(store.getJob(jobId).lifecycle, "failed");
	store.close();
});

test("DSO-006 pre-abort cancels the owned process and removes runtime credentials", async () => {
	const { root, store, jobId } = fixture("codex");
	const controller = new AbortController();
	controller.abort();
	const runtimeRoot = join(root, "runtime");
	const result = await runBackendAttempt({ store, jobId, backendId: "codex", prompt: "__fake_hang__", cwd: root, runtimeRoot, executable: fakeBackendPath, backendVersion: "0.146.0", requireAuthentication: false, signal: controller.signal, parentEnv: { PATH: process.env.PATH } });
	assert.equal(result.terminationReason, "cancelled");
	assert.equal(store.getJob(jobId).lifecycle, "cancelled");
	assert.deepEqual(readdirSync(join(runtimeRoot, "children")), []);
	store.close();
});

test("DSO-006 service interruption preserves a job for reboot recovery", async () => {
	const { store, jobId, root, runtimeRoot, executable } = fixture("codex");
	const controller = new AbortController();
	controller.abort("recovery");
	const result = await runBackendAttempt({ store, jobId, backendId: "codex", prompt: "recover me", cwd: root, runtimeRoot, executable, signal: controller.signal, backendVersion: "0.146.0", requireAuthentication: false });
	assert.equal(result.terminationReason, "recovery");
	assert.equal(store.getJob(jobId).lifecycle, "queued");
	assert.equal(store.getJob(jobId).events.at(-1).kind, "recovered");
	store.close();
});

test("DSO-006 spawn failure leaves no attempt credential directory", async () => {
	const { root, store, jobId } = fixture("codex");
	const runtimeRoot = join(root, "runtime");
	await assert.rejects(runBackendAttempt({ store, jobId, backendId: "codex", prompt: "spawn", cwd: root, runtimeRoot, executable: join(root, "missing-codex"), backendVersion: "0.146.0", requireAuthentication: false, parentEnv: { PATH: process.env.PATH } }), /ENOENT/);
	assert.deepEqual(readdirSync(join(runtimeRoot, "children")), []);
	store.close();
});

test("DSO-006 rejects backend mismatch and a second active attempt", async () => {
	const mismatch = fixture("codex");
	const mismatchMarker = join(mismatch.root, "mismatch-started");
	await assert.rejects(runBackendAttempt({ store: mismatch.store, jobId: mismatch.jobId, backendId: "claude", prompt: `__fake_marker__:${mismatchMarker}`, cwd: mismatch.root, runtimeRoot: join(mismatch.root, "runtime"), executable: fakeBackendPath, backendVersion: "2.1.220", requireAuthentication: false, parentEnv: { PATH: process.env.PATH } }), /backend mismatch/);
	assert.equal(existsSync(mismatchMarker), false);
	assert.deepEqual(readdirSync(join(mismatch.root, "runtime", "children")), []);
	mismatch.store.close();

	const concurrent = fixture("codex");
	concurrent.store.startAttempt(concurrent.jobId, { attemptId: "existing-attempt", backendId: "codex", childPid: process.pid });
	const concurrentMarker = join(concurrent.root, "concurrent-started");
	await assert.rejects(runBackendAttempt({ store: concurrent.store, jobId: concurrent.jobId, backendId: "codex", prompt: `__fake_marker__:${concurrentMarker}`, cwd: concurrent.root, runtimeRoot: join(concurrent.root, "runtime"), executable: fakeBackendPath, backendVersion: "0.146.0", requireAuthentication: false, parentEnv: { PATH: process.env.PATH } }), /active attempt/);
	assert.equal(existsSync(concurrentMarker), false);
	assert.equal(concurrent.store.getJob(concurrent.jobId).attemptId, "existing-attempt");
	concurrent.store.close();
});

test("DSO-005 rejects command options that weaken fixed safety boundaries", async () => {
	const { root, store, jobId } = fixture("codex");
	await assert.rejects(runBackendAttempt({ store, jobId, backendId: "codex", prompt: "unsafe", cwd: root, runtimeRoot: join(root, "runtime"), executable: fakeBackendPath, commandOptions: { sandbox: "danger-full-access" }, backendVersion: "0.146.0", requireAuthentication: false, parentEnv: { PATH: process.env.PATH } }), /unsafe Codex sandbox/);
	await assert.rejects(runBackendAttempt({ store, jobId, backendId: "codex", prompt: "unsafe", cwd: root, runtimeRoot: join(root, "runtime"), executable: fakeBackendPath, commandOptions: { executableArgs: ["--dangerously-bypass-approvals-and-sandbox"] }, backendVersion: "0.146.0", requireAuthentication: false, parentEnv: { PATH: process.env.PATH } }), /unsupported codex command option/);
	await assert.rejects(runBackendAttempt({ store, jobId, backendId: "codex", prompt: "unsafe", cwd: root, runtimeRoot: join(root, "runtime"), executable: fakeBackendPath, commandOptions: { approvalPolicy: "managed" }, backendVersion: "0.146.0", requireAuthentication: false, parentEnv: { PATH: process.env.PATH } }), /child approval policy must be never/);
	store.close();
});

test("DSO-006 keeps provider failure sticky when a later success marker appears", async () => {
	const { root, store, jobId } = fixture("codex");
	const result = await runBackendAttempt({ store, jobId, backendId: "codex", prompt: "__fake_failure_then_success__", cwd: root, runtimeRoot: join(root, "runtime"), executable: fakeBackendPath, backendVersion: "0.146.0", requireAuthentication: false, parentEnv: { PATH: process.env.PATH } });
	assert.equal(result.backendOutcome, "failure");
	assert.equal(store.getJob(jobId).lifecycle, "failed");
	store.close();
});

test("DSO-006 kills the owned process group including a grandchild", async () => {
	const { root, store, jobId } = fixture("codex");
	const pidFile = join(root, "grandchild.pid");
	await runBackendAttempt({ store, jobId, backendId: "codex", prompt: `__fake_grandchild__:${pidFile}`, cwd: root, runtimeRoot: join(root, "runtime"), executable: fakeBackendPath, backendVersion: "0.146.0", requireAuthentication: false, timeoutMs: 150, killGraceMs: 20, parentEnv: { PATH: process.env.PATH } });
	assert.ok(existsSync(pidFile));
	const grandchildPid = Number(readFileSync(pidFile, "utf8"));
	assert.throws(() => process.kill(grandchildPid, 0), /ESRCH/);
	store.close();
});

test("DSO-006 kills an orphaned process group after the leader exits", async () => {
	const { root, store, jobId } = fixture("codex");
	const pidFile = join(root, "orphan.pid");
	const result = await runBackendAttempt({ store, jobId, backendId: "codex", prompt: `__fake_orphan__:${pidFile}`, cwd: root, runtimeRoot: join(root, "runtime"), executable: fakeBackendPath, backendVersion: "0.146.0", requireAuthentication: false, parentEnv: { PATH: process.env.PATH } });
	assert.equal(result.exitCode, 0);
	const orphanPid = Number(readFileSync(pidFile, "utf8"));
	const state = await waitForStoppedProcess(orphanPid);
	assert.ok(state === null || state === "Z", `orphan process remained live with state ${state}`);
	store.close();
});

test("DSO-005 oversized backend lines fail safely without raw persistence", async () => {
	const { root, stateRoot, store, jobId } = fixture("codex");
	await runBackendAttempt({ store, jobId, backendId: "codex", prompt: "__fake_oversized_line__", cwd: root, runtimeRoot: join(root, "runtime"), executable: fakeBackendPath, backendVersion: "0.146.0", requireAuthentication: false, timeoutMs: 1_000, killGraceMs: 20, parentEnv: { PATH: process.env.PATH } });
	assert.equal(store.getJob(jobId).latestSafeError, "Job failed: internal_error");
	store.close();
	assert.ok(!readFileSync(join(stateRoot, "runtime.sqlite3")).includes(Buffer.from("x".repeat(1_024))));
});
