import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { formatOperatorStatus } from "../helper/discord-delivery.mjs";
import { DiscordMessageRouter } from "../helper/discord-router.mjs";
import { SessionStore } from "../helper/store.mjs";
import { loadOrCreateRecoveryKey, RecoveryCodec } from "../helper/recovery-crypto.mjs";
import { configurationRevision } from "../helper/execution-profile.mjs";
import { randomBytes } from "node:crypto";
import { BOT, CHANNEL, GUILD, USER, binding, cleanupDiscordFixtureRoots, fixture, roots } from "./fixtures/discord-fixture.mjs";

afterEach(cleanupDiscordFixtureRoots);

test("DSO-013 preserves recovery authority when only the operator label changes", () => {
	const base = {
		persona: { name: "Recovery agent", instructions: "Stay read-only." },
		role: { name: "reader" },
		backend: { selected: "codex", profiles: { codex: { model: "gpt-5.4" } } },
		runtime: { approvalPolicy: "never" }, recovery: { autoRetry: true },
	};
	const legacyRevision = configurationRevision(base);
	assert.equal(configurationRevision({ ...base, persona: { ...base.persona, shortName: "온맘" } }), legacyRevision);
	assert.equal(configurationRevision({ ...base, persona: { ...base.persona, shortName: "다른표시" } }), legacyRevision);
	assert.notEqual(configurationRevision({ ...base, persona: { ...base.persona, name: "Changed execution persona" } }), legacyRevision);
});

test("DSG-007 reboot recovery preserves job identity and requires review without retry or resend", () => {
	const { store, databasePath } = fixture();
	store.createJob({ jobId: "codex-job", backendId: "codex", activityDetail: "structured", jobType: "conversation" });
	store.createJob({ jobId: "claude-job", backendId: "claude", activityDetail: "structured", jobType: "conversation" });
	store.startAttempt("claude-job", { attemptId: "claude-attempt" });
	assert.deepEqual(store.recoverInterruptedWork(), []);
	assert.equal(store.getJob("codex-job").lifecycle, "recovery_review");
	assert.equal(store.getJob("claude-job").lifecycle, "recovery_review");
	assert.deepEqual(store.recoverInterruptedWork(), []);
	store.close();
	const reopened = new SessionStore(databasePath);
	assert.deepEqual(reopened.listJobs().map((job) => job.jobId).sort(), ["claude-job", "codex-job"]);
	reopened.close();
});

test("DSO-009 quarantines pre-withdrawal coordinator envelopes during reboot recovery", async () => {
	const { store, root } = fixture();
	const codec = new RecoveryCodec(randomBytes(32));
	store.createJob({ jobId: "old-coordinator", backendId: "codex", activityDetail: "structured", jobType: "conversation", recoveryEnvelope: codec.seal(JSON.stringify({ mode: "coordinator", currentRequest: "old request", channelId: CHANNEL, binding: binding(), allowedUserIds: [USER] })) });
	const recovered = store.recoverInterruptedWork();
	let calls = 0;
	const config = { persona: { name: "Reviewer", instructions: "Review." }, role: { name: "reader", allowedActions: ["read", "reply"] }, backend: { selected: "codex" }, discord: { bindings: [binding()], operatorUserIds: [] }, runtime: { maxConcurrentJobs: 1, approvalPolicy: "never" } };
	const router = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), recoveryCodec: codec, send: async () => ({ state: "confirmed" }), runner: async () => { calls += 1; return { backendOutcome: "failure", transientResult: null }; } });
	router.resumeRecovered(recovered, { autoRetry: true });
	await router.waitForIdle();
	assert.equal(calls, 0);
	assert.equal(store.getJob("old-coordinator").lifecycle, "recovery_review");
	store.close();
});

test("DSO-009 Discord operator status discloses that foreign collaboration agents are unsupported", () => {
	const content = formatOperatorStatus({ service: { state: "running", reasonCode: "heartbeat_fresh" } }, []);
	assert.match(content, /Foreign collaboration agent supervision: unsupported/);
});

test("DSG-007 refuses an existing recovery key that was exposed on POSIX", { skip: process.platform === "win32" ? "POSIX permission semantics" : false }, () => {
	const root = mkdtempSync(join(tmpdir(), "naia-exposed-recovery-key-"));
	roots.push(root);
	const keyPath = join(root, "keys", "recovery-key");
	mkdirSync(join(root, "keys"), { recursive: true, mode: 0o700 });
	writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
	chmodSync(keyPath, 0o644);
	assert.throws(() => loadOrCreateRecoveryKey(keyPath), /owner-only|permissions/);
	assert.notEqual(lstatSync(keyPath).mode & 0o077, 0);
});

test("DSG-007 refuses an exposed existing recovery directory before mutating it on POSIX", { skip: process.platform === "win32" ? "POSIX permission semantics" : false }, () => {
	const root = mkdtempSync(join(tmpdir(), "naia-exposed-recovery-directory-"));
	roots.push(root);
	const keyDirectory = join(root, "keys");
	const keyPath = join(keyDirectory, "recovery-key");
	mkdirSync(keyDirectory, { mode: 0o700 });
	writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
	chmodSync(keyDirectory, 0o755);
	assert.throws(() => loadOrCreateRecoveryKey(keyPath), /owner-only|permissions/);
	assert.notEqual(lstatSync(keyDirectory).mode & 0o077, 0);
});

test("DSG-021 sends a legacy encrypted recovery envelope to review without plaintext persistence", async () => {
	const { store, databasePath, root } = fixture();
	const codec = new RecoveryCodec(randomBytes(32));
	const prompt = "private-reboot-canary-request";
	store.acceptIngressAndCreateJob({ sourceMessageId: "131313131313131313", scopeKey: "scope-1", jobId: "recoverable-job", dispatchSequence: 11, backendId: "codex", backendCapabilities: { structuredProgress: true }, activityDetail: "structured", recoveryEnvelope: codec.seal(JSON.stringify({ prompt, channelId: CHANNEL, executionProfile: { backendId: "codex", permissionProfileEpoch: "default", authorizationMode: "never", access: "read-only" } })) });
	store.startAttempt("recoverable-job", { attemptId: "old-attempt" });
	const recovered = store.recoverInterruptedWork();
	assert.equal(recovered.length, 1);
	assert.equal(store.getJob("recoverable-job").lifecycle, "queued");
	assert.equal(store.getJob("recoverable-job").attemptId, null);
	const calls = [];
	const config = { persona: { name: "Reviewer", instructions: "Review." }, role: { name: "reader", allowedActions: ["read", "reply"] }, backend: { selected: "codex" }, discord: { bindings: [binding()], operatorUserIds: [] }, runtime: { maxConcurrentJobs: 1 } };
	const router = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), recoveryCodec: codec, send: async () => ({ state: "confirmed" }), runner: async (input) => { calls.push(input); return { backendOutcome: "failure", transientResult: null }; } });
	router.resumeRecovered(recovered, { autoRetry: true });
	await router.waitForIdle();
	assert.equal(calls.length, 0);
	assert.equal(store.getJob("recoverable-job", { includeEvents: false }).lifecycle, "recovery_review");
	store.close();
	assert.equal(readFileSync(databasePath).includes(Buffer.from(prompt)), false);
});

test("DSG-021 legacy recovery is reviewed without sending an acknowledgement", async () => {
	const { store, root } = fixture();
	const codec = new RecoveryCodec(randomBytes(32));
	const prompt = "private-recovered-ack-request";
	store.acceptIngressAndCreateJob({ sourceMessageId: "171717171717171717", scopeKey: "scope-1", jobId: "recovered-ack-job", dispatchSequence: 15, backendId: "codex", backendCapabilities: { structuredProgress: true }, activityDetail: "structured", recoveryEnvelope: codec.seal(JSON.stringify({ prompt, channelId: CHANNEL, executionProfile: { backendId: "codex", permissionProfileEpoch: "default", authorizationMode: "never", access: "read-only" } })) });
	store.startAttempt("recovered-ack-job", { attemptId: "old-attempt" });
	const recovered = store.recoverInterruptedWork();
	let confirm;
	const acknowledgement = new Promise((resolve) => { confirm = resolve; });
	const calls = [];
	const config = { persona: { name: "Reviewer", instructions: "Review." }, role: { name: "reader", allowedActions: ["read", "reply"] }, backend: { selected: "codex" }, discord: { bindings: [binding()], operatorUserIds: [] }, runtime: { maxConcurrentJobs: 1 } };
	const router = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), recoveryCodec: codec, send: async () => acknowledgement, runner: async (input) => { calls.push(input); return { backendOutcome: "failure", transientResult: null }; } });
	router.resumeRecovered(recovered, { autoRetry: true });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls.length, 0);
	confirm({ state: "confirmed" });
	await router.waitForIdle();
	assert.equal(calls.length, 0);
	assert.equal(store.getJob("recovered-ack-job", { includeEvents: false }).lifecycle, "recovery_review");
	store.close();
});

test("DSG-021 shutdown remains bounded after legacy recovery is sent to review", async () => {
	const { store, root } = fixture();
	const codec = new RecoveryCodec(randomBytes(32));
	store.acceptIngressAndCreateJob({ sourceMessageId: "181818181818181818", scopeKey: "scope-1", jobId: "recovered-shutdown-job", dispatchSequence: 16, backendId: "codex", backendCapabilities: { structuredProgress: true }, activityDetail: "structured", recoveryEnvelope: codec.seal(JSON.stringify({ prompt: "private-shutdown-request", channelId: CHANNEL, executionProfile: { backendId: "codex", permissionProfileEpoch: "default", authorizationMode: "never", access: "read-only" } })) });
	store.startAttempt("recovered-shutdown-job", { attemptId: "old-attempt" });
	const recovered = store.recoverInterruptedWork();
	let calls = 0;
	const config = { persona: { name: "Reviewer", instructions: "Review." }, role: { name: "reader", allowedActions: ["read", "reply"] }, backend: { selected: "codex" }, discord: { bindings: [binding()], operatorUserIds: [] }, runtime: { maxConcurrentJobs: 1 } };
	const router = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), recoveryCodec: codec, send: async () => ({ state: "unknown" }), runner: async () => { calls += 1; return { backendOutcome: "failure", transientResult: null }; } });
	router.resumeRecovered(recovered, { autoRetry: true });
	await new Promise((resolve) => setImmediate(resolve));
	await Promise.race([router.shutdown(), new Promise((_, reject) => setTimeout(() => reject(new Error("router shutdown timed out")), 500))]);
	assert.equal(calls, 0);
	assert.equal(store.getJob("recovered-shutdown-job").lifecycle, "recovery_review");
	store.close();
});

test("DSG-021 legacy acknowledgement cannot race a denied recovery into execution", async () => {
	const { store, root } = fixture();
	const codec = new RecoveryCodec(randomBytes(32));
	store.acceptIngressAndCreateJob({ sourceMessageId: "191919191919191919", scopeKey: "scope-1", jobId: "recovered-race-job", dispatchSequence: 17, backendId: "codex", backendCapabilities: { structuredProgress: true }, activityDetail: "structured", recoveryEnvelope: codec.seal(JSON.stringify({ prompt: "private-race-request", channelId: CHANNEL, executionProfile: { backendId: "codex", permissionProfileEpoch: "default", authorizationMode: "never", access: "read-only" } })) });
	store.startAttempt("recovered-race-job", { attemptId: "old-attempt" });
	const recovered = store.recoverInterruptedWork();
	let confirm;
	const acknowledgement = new Promise((resolve) => { confirm = resolve; });
	let calls = 0;
	const config = { persona: { name: "Reviewer", instructions: "Review." }, role: { name: "reader", allowedActions: ["read", "reply"] }, backend: { selected: "codex" }, discord: { bindings: [binding()], operatorUserIds: [] }, runtime: { maxConcurrentJobs: 1 } };
	const router = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), recoveryCodec: codec, send: async () => acknowledgement, runner: async () => { calls += 1; return { backendOutcome: "failure", transientResult: null }; } });
	router.resumeRecovered(recovered, { autoRetry: true });
	await new Promise((resolve) => setImmediate(resolve));
	confirm({ state: "confirmed" });
	await router.shutdown();
	assert.equal(calls, 0);
	assert.equal(store.getJob("recovered-race-job", { includeEvents: false }).lifecycle, "recovery_review");
	store.close();
});

test("DSG-021 never upgrades a stale legacy read-only recovery to workspace-write", async () => {
	const { store, root } = fixture();
	const codec = new RecoveryCodec(randomBytes(32));
	const prompt = "private-stale-profile-request";
	store.acceptIngressAndCreateJob({ sourceMessageId: "141414141414141414", scopeKey: "scope-1", jobId: "stale-profile-job", dispatchSequence: 12, backendId: "codex", backendCapabilities: { structuredProgress: true }, activityDetail: "structured", recoveryEnvelope: codec.seal(JSON.stringify({ prompt, channelId: CHANNEL, executionProfile: { backendId: "codex", permissionProfileEpoch: "managed-1", authorizationMode: "managed", access: "read-only" } })) });
	store.startAttempt("stale-profile-job", { attemptId: "old-managed-attempt" });
	const recovered = store.recoverInterruptedWork();
	const calls = [];
	const config = { persona: { name: "Reviewer", instructions: "Review." }, role: { name: "writer", allowedActions: ["read", "reply", "write", "execute"], requiresApproval: [] }, backend: { selected: "codex" }, discord: { bindings: [binding()], operatorUserIds: [] }, runtime: { maxConcurrentJobs: 1, approvalPolicy: "never", permissionProfileEpoch: "never-2" } };
	const router = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), recoveryCodec: codec, send: async () => ({ state: "confirmed" }), runner: async (input) => { calls.push(input); return { backendOutcome: "failure", transientResult: null }; } });
	router.resumeRecovered(recovered, { autoRetry: true });
	await router.waitForIdle();
	assert.equal(calls.length, 0);
	assert.equal(store.getJob("stale-profile-job", { includeEvents: false }).lifecycle, "recovery_review");
	assert.equal(store.getJob("stale-profile-job").events.some((event) => event.kind === "profile_replaced"), false);
	assert.equal(JSON.stringify(store.getJob("stale-profile-job")).includes(prompt), false);
	store.close();
});

test("DSG-014 watchdog aborts a no-progress owned child instead of leaving it running", async () => {
	const { store, root } = fixture();
	let nowMs = 0;
	let runnerStarted;
	const started = new Promise((resolveStarted) => { runnerStarted = resolveStarted; });
	let abortReason = null;
	const config = { persona: { name: "Reviewer", instructions: "Review." }, role: { name: "reader", allowedActions: ["read", "reply"] }, backend: { selected: "codex" }, discord: { bindings: [binding()], operatorUserIds: [] }, runtime: { maxConcurrentJobs: 1, softSilenceSeconds: 1, noProgressInterventionSeconds: 2, operatorResponseSeconds: 30 } };
	const router = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), now: () => nowMs, send: async () => ({ state: "confirmed" }), runner: async ({ jobId, signal }) => {
		store.startAttempt(jobId, { attemptId: "no-progress-attempt", childPid: process.pid, now: new Date(0).toISOString() });
		runnerStarted();
	return new Promise((resolveRunner) => signal.addEventListener("abort", () => { abortReason = signal.reason; store.recordEvent({ jobId, attemptId: "no-progress-attempt", source: "helper", kind: "failed", safePayload: { reasonCode: "no_progress_timeout" } }); resolveRunner({ backendOutcome: "failure", transientResult: null }); }, { once: true }));
	} });
	await router.onDispatch("MESSAGE_CREATE", { id: "151515151515151515", guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }], content: `<@${BOT}> inspect this` }, 13);
	await started;
	store.heartbeatService({ generation: "watchdog-service", pid: process.pid, now: new Date(1_000).toISOString() });
	nowMs = 1_001;
	assert.deepEqual(await router.watchdog({ nowMs }), { noProgress: 0 });
	nowMs = 2_001;
	const outcome = await router.watchdog({ nowMs });
	await router.waitForIdle();
	assert.equal(outcome.noProgress, 1);
	assert.equal(abortReason, "no_progress");
	const job = store.getJob(store.listJobs()[0].jobId, { nowMs });
	assert.equal(job.events.some((event) => event.kind === "watchdog_intervened" && event.safeSummary.includes("no_progress")), true);
	assert.equal(job.lifecycle, "failed");
	assert.equal(job.latestSafeError, "Job failed: no_progress_timeout");
	store.close();
});

test("DSG-015 acknowledgement failure never gates work or a later same-scope message", async () => {
	const { store, root } = fixture();
	let nowMs = 0;
	let runnerStarted = 0;
	const nonces = [];
	const config = { persona: { name: "Reviewer", instructions: "Review." }, role: { name: "reader", allowedActions: ["read", "reply"] }, backend: { selected: "codex" }, discord: { bindings: [binding()], operatorUserIds: [] }, runtime: { maxConcurrentJobs: 1, softSilenceSeconds: 60, noProgressInterventionSeconds: 60, operatorResponseSeconds: 1 } };
	const router = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), now: () => nowMs, send: async ({ content, nonce }) => { if (content === "[메시지 받음]") nonces.push(nonce); throw new Error("channel unavailable"); }, runner: async ({ jobId, signal }) => {
		runnerStarted += 1;
		const attemptId = `operator-response-attempt-${runnerStarted}`;
		store.startAttempt(jobId, { attemptId, childPid: process.pid, now: new Date(0).toISOString() });
		store.recordEvent({ jobId, attemptId, source: "helper", kind: "failed", safePayload: { reasonCode: "internal_error" } });
		return { backendOutcome: "failure", transientResult: null, attemptId };
	} });
	await router.onDispatch("MESSAGE_CREATE", { id: "161616161616161616", guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }], content: `<@${BOT}> inspect this` }, 14);
	await router.onDispatch("MESSAGE_CREATE", { id: "161616161616161617", guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }], content: `<@${BOT}> second request` }, 15);
	await router.waitForIdle();
	assert.equal(runnerStarted, 2);
	nowMs = 1_001;
	assert.deepEqual(await router.watchdog({ nowMs }), { noProgress: 0 });
	for (const item of store.listJobs()) {
		const job = store.getJob(item.jobId);
		assert.equal(job.lifecycle, "failed");
		assert.equal(job.events.some((event) => event.kind === "operator_response_missed"), true);
	}
	assert.equal(nonces.length, 2);
	store.close();
});

test("DSG-015 aborts an acknowledgement request at its per-job deadline", async () => {
	const { store, root } = fixture();
	let nowMs = 0;
	let sendCalls = 0;
	let sendAborted = false;
	let runnerStarted = false;
	const config = { persona: { name: "Reviewer", instructions: "Review." }, role: { name: "reader", allowedActions: ["read", "reply"] }, backend: { selected: "codex" }, discord: { bindings: [binding()], operatorUserIds: [] }, runtime: { maxConcurrentJobs: 1, softSilenceSeconds: 60, noProgressInterventionSeconds: 60, operatorResponseSeconds: 1 } };
	const router = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), now: () => nowMs, send: async ({ signal }) => { sendCalls += 1; return new Promise((resolve) => signal.addEventListener("abort", () => { sendAborted = true; resolve({ state: "unknown" }); }, { once: true })); }, deliver: async () => {}, runner: async () => { runnerStarted = true; return { backendOutcome: "success", transientResult: "done", attemptId: "single-flight-attempt" }; } });
	await router.onDispatch("MESSAGE_CREATE", { id: "171717171717171717", guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }], content: `<@${BOT}> inspect this` }, 15);
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setTimeout(resolve, 1_050));
	await router.waitForIdle();
	assert.equal(sendCalls, 1);
	assert.equal(sendAborted, true);
	assert.equal(runnerStarted, true);
	const job = store.getJob(store.listJobs()[0].jobId, { nowMs, includeEvents: true });
	assert.equal(job.events.filter((event) => event.kind === "operator_response_sent").length, 0);
	assert.equal(job.events.filter((event) => event.kind === "operator_response_missed").length, 1);
	store.close();
});

test("DSG-015 graceful shutdown finalizes a hanging acknowledgement exactly once", async () => {
	const { store, root } = fixture();
	let sendAborted = false;
	const config = { persona: { name: "Reviewer", instructions: "Review." }, role: { name: "reader", allowedActions: ["read", "reply"] }, backend: { selected: "codex" }, discord: { bindings: [binding()], operatorUserIds: [] }, runtime: { maxConcurrentJobs: 1, softSilenceSeconds: 60, noProgressInterventionSeconds: 60, operatorResponseSeconds: 30 } };
	const router = new DiscordMessageRouter({
		config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"),
		send: async ({ content, signal }) => content === "[메시지 받음]" ? new Promise((resolve) => signal.addEventListener("abort", () => { sendAborted = true; resolve({ state: "unknown" }); }, { once: true })) : { state: "confirmed" },
		runner: async ({ jobId }) => {
			const attemptId = "shutdown-ack-attempt";
			store.startAttempt(jobId, { attemptId });
			store.recordEvent({ jobId, attemptId, source: "helper", kind: "failed", safePayload: { reasonCode: "internal_error" } });
			return { backendOutcome: "failure", transientResult: null, attemptId };
		},
	});
	await router.onDispatch("MESSAGE_CREATE", { id: "171717171717171718", guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }], content: `<@${BOT}> shutdown` }, 16);
	await router.waitForIdle({ includeDeliveries: false });
	await Promise.race([router.shutdown(), new Promise((_, reject) => setTimeout(() => reject(new Error("router shutdown exceeded bound")), 500))]);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(sendAborted, true);
	const job = store.getJob(store.listJobs()[0].jobId, { includeEvents: true });
	assert.equal(job.events.filter((event) => event.kind === "operator_response_sent").length, 0);
	assert.equal(job.events.filter((event) => event.kind === "operator_response_missed").length, 1);
	store.close();
});
