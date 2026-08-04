import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { messengerInstancePaths } from "../helper/instance-paths.mjs";
import { SessionStore } from "../helper/store.mjs";
import { projectUnattendedHealth } from "../helper/unattended-health.mjs";

const roots = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

test("DSO-009 hot-path projections read active jobs and aggregate historical attention", () => {
	const root = mkdtempSync(join(tmpdir(), "naia-operational-query-"));
	roots.push(root);
	const store = new SessionStore(join(root, "runtime.sqlite3"));
	for (let index = 0; index < 120; index += 1) {
		const jobId = `terminal-${String(index).padStart(3, "0")}`;
		store.createJob({ jobId, backendId: "codex", activityDetail: "structured", jobType: "conversation" });
		store.recordEvent({ jobId, source: "helper", kind: "failed", safePayload: { reasonCode: "internal_error" } });
	}
	store.createJob({ jobId: "review-job", backendId: "codex", activityDetail: "structured", jobType: "conversation" });
	store.recordEvent({ jobId: "review-job", source: "recovery", kind: "recovery_review_required", safePayload: {} });
	store.createJob({ jobId: "active-job", backendId: "codex", activityDetail: "structured", jobType: "conversation" });

	assert.equal(store.listJobs().length, 100, "operator history must be paged by default");
	assert.equal(store.listJobs({ limit: 200 }).length, 122);
	assert.deepEqual(store.listOperationalJobs().map((job) => job.jobId), ["active-job"]);
	assert.deepEqual(store.historicalAttentionCounts(), { recoveryReview: 1, deliveryIssues: 0 });
	const status = store.status({ nowMs: Date.now() });
	assert.deepEqual(status.jobs, { active: 1, suspectedStalled: 0, needsReview: 1 });
	const health = projectUnattendedHealth({ status, jobs: store.listOperationalJobs(), historicalAttention: store.historicalAttentionCounts() });
	assert.equal(health.attention.some((item) => item.code === "historical_attention" && item.recoveryReview === 1), true);
	assert.throws(() => store.listJobs({ limit: 1_001 }), /job page limit/);
	store.close();
});

test("DSO-009 operational snapshot stays indexed with large terminal history", () => {
	const root = mkdtempSync(join(tmpdir(), "naia-operational-query-large-"));
	roots.push(root);
	const databasePath = join(root, "runtime.sqlite3");
	new SessionStore(databasePath).close();
	const database = new DatabaseSync(databasePath);
	const insert = database.prepare(`INSERT INTO jobs(
		job_id, lifecycle, backend_id, revision, backend_capabilities_json, activity_detail,
		safe_summary, accepted_at, updated_at, soft_silence_ms, delivery_state
	) VALUES (?, ?, 'codex', 'test-revision', '{}', 'structured', 'safe', ?, ?, 120000, ?)`);
	database.exec("BEGIN IMMEDIATE");
	for (let index = 0; index < 20_000; index += 1) {
		const occurredAt = new Date(index + 1).toISOString();
		insert.run(`terminal-large-${index}`, "completed", occurredAt, occurredAt, "delivered");
	}
	insert.run("terminal-review", "recovery_review", new Date(20_001).toISOString(), new Date(20_001).toISOString(), "not_started");
	insert.run("terminal-delivery-issue", "failed", new Date(20_002).toISOString(), new Date(20_002).toISOString(), "unknown");
	insert.run("active-large", "queued", new Date(20_003).toISOString(), new Date(20_003).toISOString(), "not_started");
	database.exec("COMMIT");

	const explain = (sql) => database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((row) => row.detail).join(" | ");
	assert.match(explain("SELECT * FROM jobs WHERE lifecycle IN ('queued', 'running', 'waiting_approval', 'retry_wait', 'result_ready', 'delivering') ORDER BY updated_at ASC LIMIT 256"), /jobs_operational_updated_at/);
	assert.match(explain("SELECT COUNT(*) FROM jobs WHERE lifecycle = 'recovery_review'"), /jobs_recovery_review_attention/);
	assert.match(explain("SELECT COUNT(*) FROM jobs WHERE lifecycle IN ('completed', 'failed', 'cancelled', 'recovery_review') AND delivery_state IN ('unknown', 'failed')"), /jobs_terminal_delivery_attention/);
	database.close();

	const store = SessionStore.openReadOnly(databasePath);
	const snapshot = store.operationalSnapshot({ nowMs: Date.now() });
	assert.deepEqual(snapshot.jobs.map((job) => job.jobId), ["active-large"]);
	assert.deepEqual(snapshot.historicalAttention, { recoveryReview: 1, deliveryIssues: 1 });
	assert.deepEqual(snapshot.status.jobs, { active: 1, suspectedStalled: 0, needsReview: 1 });
	store.close();
});

test("DSO-009 minute observer bounds operational work and exposes overflow as unhealthy", () => {
	const root = mkdtempSync(join(tmpdir(), "naia-operational-overflow-"));
	roots.push(root);
	const databasePath = join(root, "runtime.sqlite3");
	new SessionStore(databasePath).close();
	const database = new DatabaseSync(databasePath);
	const insert = database.prepare(`INSERT INTO jobs(
		job_id, lifecycle, backend_id, revision, backend_capabilities_json, activity_detail,
		safe_summary, accepted_at, updated_at, soft_silence_ms, delivery_state
	) VALUES (?, 'queued', 'codex', 'test-revision', '{}', 'structured', 'safe', ?, ?, 120000, 'not_started')`);
	const nowMs = Date.now();
	database.exec("BEGIN IMMEDIATE");
	for (let index = 0; index < 300; index += 1) {
		const occurredAt = new Date(nowMs - 1_000 + index).toISOString();
		insert.run(`active-${String(index).padStart(3, "0")}`, occurredAt, occurredAt);
	}
	database.exec("COMMIT");
	database.close();

	const store = SessionStore.openReadOnly(databasePath);
	const snapshot = store.operationalSnapshot({ nowMs });
	assert.equal(snapshot.jobs.length, 256);
	assert.equal(snapshot.jobs[0].jobId, "active-000");
	assert.equal(snapshot.jobs.at(-1).jobId, "active-255");
	assert.deepEqual(snapshot.status.jobs, { active: 300, suspectedStalled: 0, needsReview: 0, operationalOverflow: 44 });
	const health = projectUnattendedHealth({ status: snapshot.status, jobs: snapshot.jobs, historicalAttention: snapshot.historicalAttention, nowMs });
	assert.equal(health.state, "unhealthy");
	assert.deepEqual(health.unhealthy.find((item) => item.code === "operational_jobs_truncated"), { code: "operational_jobs_truncated", omittedJobs: 44 });
	assert.throws(() => store.listOperationalJobs({ limit: 1_001 }), /job page limit/);
	store.close();
});

test("DSO-003 active operator pages honor the requested limit beyond the observer cap", () => {
	const root = mkdtempSync(join(tmpdir(), "naia-operational-cli-"));
	roots.push(root);
	const databasePath = messengerInstancePaths(root, "default").databasePath;
	new SessionStore(databasePath).close();
	const database = new DatabaseSync(databasePath);
	const insert = database.prepare(`INSERT INTO jobs(
		job_id, lifecycle, backend_id, revision, backend_capabilities_json, activity_detail,
		safe_summary, accepted_at, updated_at, soft_silence_ms, delivery_state
	) VALUES (?, 'queued', 'codex', 'test-revision', '{}', 'structured', 'safe', ?, ?, 120000, 'not_started')`);
	database.exec("BEGIN IMMEDIATE");
	for (let index = 0; index < 300; index += 1) {
		const occurredAt = new Date(index + 1).toISOString();
		insert.run(`active-cli-${String(index).padStart(3, "0")}`, occurredAt, occurredAt);
	}
	database.exec("COMMIT");
	database.close();

	const cliPath = fileURLToPath(new URL("../helper/cli.mjs", import.meta.url));
	const result = spawnSync(process.execPath, [cliPath, "--adk-root", root, "jobs", "--active", "--limit", "1000", "--json"], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	const payload = JSON.parse(result.stdout);
	assert.equal(payload.jobs.length, 300);
	assert.equal(payload.jobs[0].jobId, "active-cli-000");
	assert.equal(payload.jobs.at(-1).jobId, "active-cli-299");
});

test("DSO-012 backend selection instructions require cutover for existing registrations in both mirrors", () => {
	const english = readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");
	const korean = readFileSync(new URL("../../../../.users/skills/manage-discord-sessions/SKILL.md", import.meta.url), "utf8");
	assert.match(english, /For an existing registration, changing `backend\.selected` is a managed runtime change and must use the verified candidate cutover procedure/);
	assert.doesNotMatch(english, /After changing `backend\.selected`, run `service install` again/);
	assert.match(korean, /기존 등록의 `backend\.selected` 변경은 관리 런타임 전환이므로, 일반 `service install`이나 restart로 덮어쓰지 말고 아래의 검증된 후보 cutover 절차를 사용합니다/);
});
