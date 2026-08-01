import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { SessionStore } from "../helper/store.mjs";
import { readBootId, readProcessStartIdentity } from "../helper/projector.mjs";
import { assertOwnerOnly, protectOwnerOnly } from "../helper/platform-security.mjs";

const roots = [];
const cliPath = fileURLToPath(new URL("../helper/cli.mjs", import.meta.url));

afterEach(() => {
	while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function fixture(ownershipReader = {}) {
	const root = mkdtempSync(join(tmpdir(), "naia-discord-observability-"));
	roots.push(root);
	const configDir = join(root, "naia-settings/messenger-sessions");
	mkdirSync(configDir, { recursive: true });
	const configPath = join(configDir, "config.json");
	writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, enabled: true, workspaceId: "test", persona: { name: "Reviewer", instructions: "Review." }, role: { name: "reader", allowedActions: ["read", "reply"], requiresApproval: ["write"] }, backend: { selected: "codex", profiles: { codex: { enabled: true }, claude: { enabled: false } } }, discord: { credentialRef: "discord-token", botUserId: "111111111111111111", operatorUserIds: [], bindings: [{ kind: "guild_channel", guildId: "333333333333333333", channelId: "444444444444444444", respondWhen: "mentioned", allowedUserIds: ["222222222222222222"], canStartConversation: false, operatorActions: true }] }, runtime: { heartbeatSeconds: 10, softSilenceSeconds: 120, noProgressInterventionSeconds: 120, operatorResponseSeconds: 30, approvalPolicy: "never", permissionProfileEpoch: "profile-1", maxConcurrentJobs: 1 }, observability: { discordStatusProjection: true }, service: { autoStart: true, startAt: "login" }, recovery: { autoRetry: true } }));
	protectOwnerOnly(configPath, "file", "test messenger config");
	const stateDir = join(root, "naia-settings/.sessions/messenger-sessions");
	mkdirSync(stateDir, { recursive: true });
	const databasePath = join(stateDir, "runtime.sqlite3");
	return { root, databasePath, store: new SessionStore(databasePath, ownershipReader) };
}

function iso(offsetMs = 0) {
	return new Date(Date.UTC(2026, 6, 30, 0, 0, 0) + offsetMs).toISOString();
}

function storeStatusSchema(root) {
	const status = spawnSync(process.execPath, [cliPath, "--adk-root", root, "status", "--json"], { encoding: "utf8" });
	assert.equal(status.status, 0, status.stderr);
	return JSON.parse(status.stdout).schemaVersion;
}

function createRunningJob(store, options = {}) {
	store.heartbeatService({ generation: "generation-1", pid: options.servicePid ?? process.pid, now: iso(options.heartbeatOffset ?? 0) });
	const jobId = options.jobId ?? "job-1";
	store.createJob({
		jobId,
		backendId: options.backendId ?? "codex",
		revision: options.revision ?? "rev-1",
		activityDetail: options.activityDetail ?? "structured",
		now: iso(),
		softSilenceMs: options.softSilenceMs ?? 120_000,
		hardDeadlineAt: options.hardDeadlineAt ?? null,
		requiredChecks: options.requiredChecks ?? [],
		jobType: options.jobType ?? "issue_work",
	});
	const attemptId = store.startAttempt(jobId, {
		attemptId: `${jobId}-attempt-1`,
		now: iso(100),
		childPid: options.childPid ?? process.pid,
	});
	return { jobId, attemptId };
}

test("DSO-001 persists ordered events and deduplicates an external retry", () => {
	const { databasePath, store } = fixture();
	const { jobId, attemptId } = createRunningJob(store);
	const first = store.recordEvent({
		jobId,
		attemptId,
		dedupeKey: "codex:event-1",
		kind: "phase_changed",
		occurredAt: iso(1_000),
		source: "codex",
		safePayload: { phase: "testing" },
	});
	const duplicate = store.recordEvent({
		jobId,
		attemptId,
		dedupeKey: "codex:event-1",
		kind: "phase_changed",
		occurredAt: iso(1_000),
		source: "codex",
		safePayload: { phase: "testing" },
	});
	assert.equal(duplicate.eventId, first.eventId);
	assert.throws(() => store.recordEvent({
		jobId,
		attemptId,
		dedupeKey: "codex:event-1",
		kind: "phase_changed",
		occurredAt: iso(1_000),
		source: "codex",
		safePayload: { phase: "reviewing" },
	}), /dedupe key content conflict/);
	assert.throws(() => store.recordEvent({
		jobId,
		attemptId,
		dedupeKey: "codex:event-1",
		kind: "tool_started",
		occurredAt: iso(1_000),
		source: "codex",
		safePayload: { toolCategory: "test" },
	}), /dedupe key conflict/);
	assert.equal(store.eventsAfter({ jobId }).length, 4);
	store.close();

	const reopened = new SessionStore(databasePath);
	const events = reopened.eventsAfter({ jobId });
	assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4]);
	assert.ok(events.every((event, index) => index === 0 || event.ordinal > events[index - 1].ordinal));
	reopened.close();
});

test("DSO-002 separates fresh progress, unsupported detail, waiting, stall, deadline, and stale service", () => {
	const first = fixture();
	const { jobId, attemptId } = createRunningJob(first.store);
	first.store.recordEvent({ jobId, attemptId, dedupeKey: "phase-1", kind: "phase_changed", occurredAt: iso(1_000), source: "codex", safePayload: { phase: "testing" } });
	assert.equal(first.store.getJob(jobId, { nowMs: Date.parse(iso(2_000)) }).activityHealth.value, "progressing");

	first.store.recordEvent({ jobId, attemptId, dedupeKey: "approval-1", kind: "approval_required", occurredAt: iso(2_500), source: "codex", safePayload: { approvalType: "write" } });
	assert.equal(first.store.getJob(jobId, { nowMs: Date.parse(iso(200_000)) }).activityHealth.value, "unknown");
	first.store.heartbeatService({ generation: "generation-1", pid: process.pid, now: iso(200_000) });
	assert.equal(first.store.getJob(jobId, { nowMs: Date.parse(iso(200_000)) }).activityHealth.value, "waiting");
	first.store.close();

	const unsupported = fixture();
	const unsupportedJob = createRunningJob(unsupported.store, { activityDetail: "unsupported" });
	assert.equal(unsupported.store.getJob(unsupportedJob.jobId, { nowMs: Date.parse(iso(1_000)) }).activityHealth.value, "running_no_detail");
	unsupported.store.close();

	const stalled = fixture();
	const stalledJob = createRunningJob(stalled.store);
	stalled.store.heartbeatService({ generation: "generation-1", pid: process.pid, now: iso(130_000) });
	assert.equal(stalled.store.getJob(stalledJob.jobId, { nowMs: Date.parse(iso(130_000)) }).activityHealth.value, "suspected_stalled");
	stalled.store.close();

	const deadline = fixture();
	const deadlineJob = createRunningJob(deadline.store, { hardDeadlineAt: iso(10_000) });
	deadline.store.heartbeatService({ generation: "generation-1", pid: process.pid, now: iso(10_000) });
	assert.equal(deadline.store.getJob(deadlineJob.jobId, { nowMs: Date.parse(iso(10_000)) }).activityHealth.value, "unresponsive");
	deadline.store.close();

	const stale = fixture();
	const staleJob = createRunningJob(stale.store);
	assert.equal(stale.store.getJob(staleJob.jobId, { nowMs: Date.parse(iso(31_000)) }).activityHealth.reasonCode, "service_stale");
	stale.store.close();

	const missingProcess = fixture({
		readBootId: () => "11111111-1111-1111-1111-111111111111",
		readProcessStartIdentity: () => "1",
	});
	const missingProcessJob = createRunningJob(missingProcess.store, { servicePid: 2_147_483_647 });
	missingProcess.store.heartbeatService({ generation: "generation-1", pid: 2_147_483_647, now: iso(130_000) });
	assert.equal(missingProcess.store.status({ nowMs: Date.parse(iso(130_001)) }).service.reasonCode, "heartbeat_fresh_process_unobservable");
	assert.equal(missingProcess.store.status({ nowMs: Date.parse(iso(161_001)) }).service.reasonCode, "service_process_missing");
	missingProcess.store.close();

	const futureClock = fixture();
	const futureClockJob = createRunningJob(futureClock.store);
	futureClock.store.heartbeatService({ generation: "generation-1", pid: process.pid, now: iso(10_000) });
	assert.equal(futureClock.store.getJob(futureClockJob.jobId, { nowMs: Date.parse(iso(5_000)) }).activityHealth.reasonCode, "service_unknown");
	futureClock.store.close();

	const ownershipConflict = fixture({ readBootId: () => "fake-boot", readProcessStartIdentity: () => "0" });
	const ownershipJob = createRunningJob(ownershipConflict.store);
	assert.equal(ownershipConflict.store.getJob(ownershipJob.jobId, { nowMs: Date.parse(iso(1_000)) }).activityHealth.reasonCode, "service_degraded");
	ownershipConflict.store.close();

	const childMissing = fixture({
		readBootId: () => readBootId(),
		readProcessStartIdentity: (pid) => pid === process.pid ? readProcessStartIdentity(pid) : "1",
	});
	const childMissingJob = createRunningJob(childMissing.store, { childPid: 2_147_483_647 });
	assert.equal(childMissing.store.getJob(childMissingJob.jobId, { nowMs: Date.parse(iso(1_000)) }).activityHealth.value, "unresponsive");
	childMissing.store.heartbeatService({ generation: "generation-1", pid: process.pid, now: iso(130_000) });
	assert.equal(childMissing.store.getJob(childMissingJob.jobId, { nowMs: Date.parse(iso(130_000)) }).activityHealth.reasonCode, "owned_child_missing");
	childMissing.store.close();

	const actualBootId = readBootId();
	const actualProcessIdentity = readProcessStartIdentity(process.pid);
	let observedProcessIdentity = actualProcessIdentity;
	const childConflict = fixture({ readBootId: () => actualBootId, readProcessStartIdentity: () => observedProcessIdentity });
	childConflict.store.heartbeatService({ generation: "generation-1", pid: process.pid, now: iso() });
	childConflict.store.createJob({ jobId: "job-1", backendId: "codex", revision: "rev-1", activityDetail: "structured", now: iso(), jobType: "issue_work" });
	observedProcessIdentity = "0";
	const childConflictJob = { jobId: "job-1" };
	childConflict.store.startAttempt("job-1", { attemptId: "job-1-attempt-1", now: iso(100) });
	observedProcessIdentity = actualProcessIdentity;
	childConflict.store.heartbeatService({ generation: "generation-1", pid: process.pid, now: iso(130_000) });
	assert.equal(childConflict.store.getJob(childConflictJob.jobId, { nowMs: Date.parse(iso(130_000)) }).activityHealth.reasonCode, "child_ownership_conflict");
	childConflict.store.close();
});

test("DSO-005 rejects unsafe event shapes and coalesces high-rate activity", () => {
	const { store } = fixture();
	assert.throws(() => store.createJob({
		jobId: "unsafe-job",
		backendId: "codex",
		jobType: "sk-secretvalue123456789",
		revision: "rev-1",
		now: iso(),
	}), /jobType is not an allowed value/);
	const { jobId, attemptId } = createRunningJob(store);
	assert.throws(() => store.recordEvent({
		jobId,
		attemptId,
		dedupeKey: "unsafe-shape-1",
		kind: "phase_changed",
		source: "codex",
		safePayload: { phase: "testing" },
		raw: "do not accept me",
	}), /unsupported field/);
	assert.throws(() => store.recordEvent({
		jobId,
		attemptId,
		dedupeKey: "unsafe-shape-2",
		kind: "phase_changed",
		source: "codex",
		safePayload: { phase: "testing", token: "do-not-accept" },
	}), /unsupported field/);
	assert.throws(() => store.recordEvent({
		jobId,
		attemptId,
		dedupeKey: "unsafe-shape-3",
		kind: "phase_changed",
		source: "codex",
		safePayload: { phase: "/home/luke/private" },
	}), /not an allowed value/);
	assert.throws(() => store.recordEvent({
		jobId,
		attemptId,
		dedupeKey: "unsafe-metric-1",
		kind: "delivery_started",
		source: "helper",
		safePayload: { phase: "testing" },
	}), /unsupported field/);
	assert.throws(() => store.recordEvent({
		jobId,
		attemptId,
		dedupeKey: "unsafe-metric-2",
		kind: "phase_changed",
		source: "codex",
		safePayload: { phase: "testing" },
		metrics: { command: 1 },
	}), /unsafe metric key/);
	assert.throws(() => store.recordEvent({
		jobId,
		attemptId,
		dedupeKey: "unsafe-metric-3",
		kind: "phase_changed",
		source: "codex",
		safePayload: { phase: "testing" },
		metrics: { count: -1 },
	}), /non-negative safe integer/);

	const first = store.recordEvent({ jobId, attemptId, dedupeKey: "out-1", kind: "output_activity", occurredAt: iso(1_000), source: "codex", safePayload: { bytes: 20 }, metrics: { bytes: 20 } });
	const coalesced = store.recordEvent({ jobId, attemptId, dedupeKey: "out-2", kind: "output_activity", occurredAt: iso(1_500), source: "codex", safePayload: { bytes: 30 }, metrics: { bytes: 30 } });
	assert.equal(coalesced.eventId, first.eventId);
	assert.throws(() => store.recordEvent({ jobId, attemptId, kind: "phase_changed", source: "codex", safePayload: { phase: "testing" } }), /stable dedupeKey/);
	assert.throws(() => store.recordEvent({ jobId, dedupeKey: "missing-attempt", kind: "phase_changed", source: "codex", safePayload: { phase: "testing" } }), /current attemptId/);
	assert.throws(() => store.recordEvent({ jobId, attemptId, dedupeKey: "backend-complete", kind: "completed", source: "codex", safePayload: {} }), /cannot produce completed/);
	store.close();
});

test("DSO-004 trusts only predeclared host or human evidence for completion", () => {
	const { store } = fixture();
	const { jobId, attemptId } = createRunningJob(store, {
		requiredChecks: [{ checkId: "tests", kind: "test" }],
	});
	assert.equal(store.getJob(jobId).completionAssessment.assessment, "partial");
	store.recordEvidence({ jobId, checkId: "tests", attemptId, revision: "rev-1", producer: "backend_claim", verifier: "codex", result: "passed", observedAt: iso(1_000), metrics: { passed: 3 } });
	assert.equal(store.getJob(jobId).completionAssessment.assessment, "partial");
	store.recordEvidence({ jobId, checkId: "tests", attemptId, revision: "rev-1", producer: "host_verifier", verifier: "node-test-v1", result: "passed", observedAt: iso(2_000), metrics: { passed: 3 } });
	assert.equal(store.getJob(jobId).completionAssessment.assessment, "verified");
	store.recordEvidence({ jobId, checkId: "tests", attemptId, revision: "rev-1", producer: "host_verifier", verifier: "node-test-v1", result: "failed", observedAt: iso(3_000), metrics: { failed: 1 } });
	assert.equal(store.getJob(jobId).completionAssessment.assessment, "failed");
	store.startAttempt(jobId, { attemptId: "job-1-attempt-2", now: iso(4_000), replaceCurrent: true });
	assert.equal(store.getJob(jobId).completionAssessment.assessment, "partial");
	store.close();
});

test("DSO-004 rejects evidence before an owned attempt exists", () => {
	const { store } = fixture();
	store.createJob({ jobId: "pre-attempt-job", backendId: "codex", revision: "rev-1", now: iso(), requiredChecks: [{ checkId: "tests", kind: "test" }] });
	assert.throws(() => store.recordEvidence({ jobId: "pre-attempt-job", checkId: "tests", attemptId: null, revision: "rev-1", producer: "host_verifier", verifier: "node-test-v1", result: "passed", observedAt: iso(1_000) }), /stale attempt evidence/);
	store.close();
});

test("DSO-005 closes job metadata before it reaches projections", () => {
	const { store } = fixture();
	assert.throws(() => store.createJob({ jobId: "job-secret", backendId: "sk-secretvalue123456789", revision: "rev-1" }), /backend is not an allowed value/);
	assert.throws(() => store.createJob({ jobId: "job-path", backendId: "codex", revision: "/home/luke/private" }), /revision must be a safe identifier/);
	assert.throws(() => store.createJob({ jobId: "job-capability", backendId: "codex", revision: "rev-1", backendCapabilities: { token: true } }), /unsupported field/);
	assert.throws(() => store.createJob({ jobId: "job-capability-value", backendId: "codex", revision: "rev-1", backendCapabilities: { cancellation: "yes" } }), /must be boolean/);
	const { jobId, attemptId } = createRunningJob(store, { jobId: "metadata-job" });
	assert.throws(() => store.recordEvent({ jobId, attemptId: "sk-secretvalue123456789", dedupeKey: "bad-attempt", kind: "phase_changed", source: "codex", safePayload: { phase: "testing" } }), /attemptId resembles sensitive data/);
	assert.throws(() => store.recordEvent({ jobId, attemptId, dedupeKey: "bad-time", kind: "phase_changed", occurredAt: "/home/luke/private", source: "codex", safePayload: { phase: "testing" } }), /canonical ISO timestamp/);
	store.close();
});

test("DSO-001 rejects stale-attempt events and implicit recovery", () => {
	const { store } = fixture();
	const { jobId, attemptId } = createRunningJob(store);
	const retriedOldEvent = store.recordEvent({ jobId, attemptId, dedupeKey: "old-retry", kind: "phase_changed", occurredAt: iso(500), source: "codex", safePayload: { phase: "testing" } });
	const secondAttempt = store.startAttempt(jobId, { attemptId: "job-1-attempt-2", now: iso(1_000), replaceCurrent: true });
	const exactRetry = store.recordEvent({ jobId, attemptId, dedupeKey: "old-retry", kind: "phase_changed", occurredAt: iso(500), source: "codex", safePayload: { phase: "testing" } });
	assert.equal(exactRetry.eventId, retriedOldEvent.eventId);
	assert.throws(() => store.recordEvent({ jobId, attemptId, dedupeKey: "late-old-attempt", kind: "phase_changed", occurredAt: iso(2_000), source: "codex", safePayload: { phase: "testing" } }), /stale attempt event/);
	store.recordEvent({ jobId, attemptId: secondAttempt, kind: "delivery_started", occurredAt: iso(3_000), source: "helper", safePayload: {} });
	store.recordEvent({ jobId, attemptId: secondAttempt, kind: "delivery_unknown", occurredAt: iso(4_000), source: "helper", safePayload: {} });
	assert.throws(() => store.recordEvent({ jobId, attemptId: secondAttempt, dedupeKey: "implicit-recovery", kind: "phase_changed", occurredAt: iso(5_000), source: "codex", safePayload: { phase: "recovering" } }), /invalid lifecycle transition/);
	store.close();
});

test("DSO-001 records signal termination without inventing an exit code", () => {
	const { store } = fixture();
	const { jobId, attemptId } = createRunningJob(store);
	const event = store.recordEvent({
		jobId,
		attemptId,
		kind: "attempt_exited",
		source: "helper",
		safePayload: { terminationKind: "signaled", signal: "SIGTERM" },
	});
	assert.match(event.safeSummary, /SIGTERM/);
	assert.throws(() => store.recordEvent({
		jobId,
		attemptId,
		kind: "attempt_exited",
		source: "helper",
		safePayload: { terminationKind: "signaled", signal: "SIGTERM", exitCode: 143 },
	}), /cannot carry exitCode/);
	store.close();
});

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

	const missing = spawnSync(process.execPath, [cliPath, "--adk-root", root, "job", "missing"], { encoding: "utf8" });
	assert.equal(missing.status, 2);
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
