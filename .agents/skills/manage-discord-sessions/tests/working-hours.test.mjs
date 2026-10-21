import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { buildAgentContextSnapshot } from "../helper/agent-context.mjs";
import { DiscordMessageRouter } from "../helper/discord-router.mjs";
import { RecoveryCodec } from "../helper/recovery-crypto.mjs";
import { configurationRevision, participantAuthorityRevision } from "../helper/execution-profile.mjs";
import { mutationWindowStatus, normalizeMutationWindow } from "../helper/mutation-window.mjs";
import { randomBytes } from "node:crypto";
import { BOT, CHANNEL, GUILD, USER, RUNTIME_REVISION, binding, cleanupDiscordFixtureRoots, fixture } from "./fixtures/discord-fixture.mjs";

afterEach(cleanupDiscordFixtureRoots);

const OPEN = { timezone: "UTC", days: [1], start: "09:00", end: "18:00" };

function operatorConfig(mutationWindow = OPEN) {
	return {
		schemaVersion: 2,
		workspace: { agentId: "working-hours-agent" },
		persona: { name: "Operator", instructions: "Complete bounded operator work." },
		role: { name: "operator", allowedActions: ["read", "reply", "write", "execute"], requiresApproval: [] },
		backend: { selected: "codex", profiles: { codex: { enabled: true } } },
		discord: {
			bindings: [{ ...binding(), operatorActions: true, historyVisibility: "none" }],
			operatorUserIds: [USER],
			participantProfiles: {
				[USER]: { label: "workspace-owner", relationship: "workspace owner", allowedActions: ["read", "reply", "write", "execute"], ...(mutationWindow ? { mutationWindow } : {}) },
			},
		},
		runtime: { maxConcurrentJobs: 1, approvalPolicy: "never", permissionProfileEpoch: "working-hours-v1", networkAccess: false, credentialProfiles: [] },
		recovery: { autoRetry: false },
	};
}

function snapshotFor(root) {
	mkdirSync(join(root, ".agents", "context"), { recursive: true });
	writeFileSync(join(root, "AGENTS.md"), "# Working-hours agent\n", "utf8");
	writeFileSync(join(root, ".agents", "context", "policy.yaml"), "authority: bounded\n", "utf8");
	return buildAgentContextSnapshot({ workspace: root, agentId: "working-hours-agent", entrypoint: "AGENTS.md", contextFiles: [".agents/context/policy.yaml"] });
}

function message(id, content = "inspect this") {
	return { id, guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }], content: `<@${BOT}> ${content}` };
}

async function waitUntil(predicate, label) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
	assert.fail(`timed out waiting for ${label}`);
}

function failingRunner(store, calls, { block = null } = {}) {
	return async (input) => {
		calls.push(input);
		if (block) await block;
		const attemptId = store.startAttempt(input.jobId, { attemptId: `working-hours-${calls.length}` });
		store.recordEvent({ jobId: input.jobId, attemptId, source: "helper", kind: "failed", safePayload: { reasonCode: "process_exit" } });
		return { backendOutcome: "failure", transientResult: null, attemptId };
	};
}

test("working-hours validates named IANA zones, weekday/time boundaries, and DST", () => {
	assert.deepEqual(normalizeMutationWindow({ ...OPEN, days: [7, 1] }), { ...OPEN, days: [1, 7] });
	assert.equal(mutationWindowStatus(OPEN, Date.parse("2026-09-07T09:00:00Z")).allowed, true);
	assert.equal(mutationWindowStatus(OPEN, Date.parse("2026-09-07T18:00:00Z")).allowed, false);
	assert.equal(mutationWindowStatus(OPEN, Date.parse("2026-09-06T12:00:00Z")).allowed, false);
	const dstWindow = { timezone: "America/New_York", days: [1], start: "09:00", end: "10:00" };
	assert.equal(mutationWindowStatus(dstWindow, Date.parse("2026-03-02T14:00:00Z")).allowed, true);
	assert.equal(mutationWindowStatus(dstWindow, Date.parse("2026-03-09T13:00:00Z")).allowed, true);
	assert.throws(() => normalizeMutationWindow({ ...OPEN, timezone: "+09:00" }), /named IANA/);
	assert.throws(() => normalizeMutationWindow({ ...OPEN, start: "18:00", end: "09:00" }), /overnight/);
	assert.throws(() => normalizeMutationWindow({ ...OPEN, days: [1, 1] }), /unique/);
	assert.throws(() => mutationWindowStatus(OPEN, Number.NaN), /finite/);
});

test("working-hours window participates in configuration and authority revisions", () => {
	const withWindow = operatorConfig();
	const withoutWindow = operatorConfig(null);
	assert.notEqual(configurationRevision(withWindow), configurationRevision(withoutWindow));
	const base = { workspaceIdentity: "working-hours-agent", bindingIdentity: "guild_channel:guild:channel", participantUserId: USER, effectiveActions: ["read", "reply", "write", "execute"], permissionProfileEpoch: "working-hours-v1" };
	assert.notEqual(participantAuthorityRevision({ ...base, participantProfile: withWindow.discord.participantProfiles[USER] }), participantAuthorityRevision({ ...base, participantProfile: withoutWindow.discord.participantProfiles[USER] }));
	assert.equal(configurationRevision(withoutWindow), configurationRevision({ ...withoutWindow, discord: { ...withoutWindow.discord, participantProfiles: { [USER]: { ...withoutWindow.discord.participantProfiles[USER] } } } }));
});

test("working-hours downgrades off-hours mutation requests while preserving readonly access", async () => {
	const { store, root } = fixture();
	const snapshot = snapshotFor(root);
	let nowMs = Date.parse("2026-09-07T10:00:00Z");
	const calls = [];
	const router = new DiscordMessageRouter({ config: operatorConfig(), store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), agentContextSnapshot: snapshot, runtimeRevision: RUNTIME_REVISION, now: () => nowMs, send: async () => ({ state: "confirmed" }), runner: failingRunner(store, calls) });
	const open = await router.onDispatch("MESSAGE_CREATE", message("700000000000000001", "write this"), 1);
	await router.waitForIdle();
	assert.equal(open.state, "accepted");
	assert.equal(calls[0].executionProfile.access, "workspace-write");
	assert.equal(calls[0].commandOptions.sandbox, "workspace-write");
	nowMs = Date.parse("2026-09-07T18:00:00Z");
	const closed = await router.onDispatch("MESSAGE_CREATE", message("700000000000000002", "write this later"), 2);
	await router.waitForIdle();
	assert.equal(closed.state, "accepted");
	assert.equal(calls[1].executionProfile.access, "read-only");
	assert.equal(calls[1].commandOptions.sandbox, "read-only");
	assert.match(calls[1].prompt, /Mutation window/);
	assert.match(calls[1].prompt, /Allowed actions: read, reply/);
	const events = store.getJob(closed.jobId).events;
	assert.ok(events.some((event) => event.kind === "profile_replaced" && event.safeSummary.includes("mutation_window_closed")));
	const readOnly = await router.submitOperatorRequest({ channelId: CHANNEL, authorId: USER, content: "read this", access: "read-only" });
	await router.waitForIdle();
	assert.equal(readOnly.state, "accepted");
	assert.equal(calls[2].executionProfile.access, "read-only");
	store.close();
});

test("working-hours closed window on a credentialed instance downgrades instead of failing the job", async () => {
	// The reviewed fixture pinned networkAccess:false, so the interaction that
	// breaks every read-only path on a credentialed instance was never walked.
	const { store, root } = fixture();
	const snapshot = snapshotFor(root);
	const config = operatorConfig();
	config.runtime.networkAccess = true;
	config.runtime.credentialProfiles = ["vercel"];
	let nowMs = Date.parse("2026-09-07T10:00:00Z");
	const calls = [];
	const router = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), agentContextSnapshot: snapshot, runtimeRevision: RUNTIME_REVISION, now: () => nowMs, send: async () => ({ state: "confirmed" }), runner: failingRunner(store, calls) });
	const open = await router.onDispatch("MESSAGE_CREATE", message("700000000000000201", "write this"), 201);
	await router.waitForIdle();
	assert.equal(open.state, "accepted");
	assert.equal(calls[0].executionProfile.access, "workspace-write");
	assert.equal(calls[0].commandOptions.networkAccess, true);
	assert.deepEqual(calls[0].commandOptions.credentialProfiles, ["vercel"]);
	nowMs = Date.parse("2026-09-07T18:00:00Z");
	const closed = await router.onDispatch("MESSAGE_CREATE", message("700000000000000202", "write this later"), 202);
	await router.waitForIdle();
	assert.equal(closed.state, "accepted");
	assert.equal(calls[1].executionProfile.access, "read-only");
	assert.equal(calls[1].commandOptions.sandbox, "read-only");
	// Codex refuses read-only plus network access, so leaving these set turned
	// every downgraded job into backend_invocation_invalid.
	assert.equal(calls[1].commandOptions.networkAccess, false);
	assert.deepEqual(calls[1].commandOptions.credentialProfiles, []);
	const job = store.getJob(closed.jobId);
	assert.equal(job.events.some((event) => event.kind === "failed" && event.safeSummary.includes("backend_invocation_invalid")), false);
	const readOnly = await router.submitOperatorRequest({ channelId: CHANNEL, authorId: USER, content: "read this", access: "read-only" });
	await router.waitForIdle();
	assert.equal(readOnly.state, "accepted");
	assert.equal(calls[2].commandOptions.networkAccess, false);
	assert.deepEqual(calls[2].commandOptions.credentialProfiles, []);
	store.close();
});

test("working-hours closed-window notice keeps its place when the request quotes the User request marker", async () => {
	const { store, root } = fixture();
	const snapshot = snapshotFor(root);
	const nowMs = Date.parse("2026-09-07T18:00:00Z");
	const calls = [];
	const router = new DiscordMessageRouter({ config: operatorConfig(), store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), agentContextSnapshot: snapshot, runtimeRevision: RUNTIME_REVISION, now: () => nowMs, send: async () => ({ state: "confirmed" }), runner: failingRunner(store, calls) });
	// A participant pasting an earlier prompt puts a second `User request:`
	// line in their own text. Searching for that marker moved the notice inside
	// the quoted block and broke the suffix the history loader matches on.
	const quoted = "please redo this\nUser request:\nthe earlier pasted request";
	const accepted = await router.onDispatch("MESSAGE_CREATE", message("700000000000000203", quoted), 203);
	await router.waitForIdle();
	assert.equal(accepted.state, "accepted");
	const prompt = calls[0].prompt;
	assert.equal(prompt.endsWith(`User request:\n${quoted}`), true, "the user text must stay the exact suffix");
	const notice = prompt.indexOf("Mutation window");
	assert.ok(notice > 0);
	assert.ok(notice < prompt.lastIndexOf("User request:"));
	assert.ok(notice < prompt.indexOf("please redo this"));
	// Exactly one notice, and none of it inside the participant's own text.
	assert.equal(prompt.split("Mutation window").length - 1, 1);
	store.close();
});

test("working-hours parked recovery tells the requester once instead of going silent", async () => {
	const { store, root } = fixture();
	const snapshot = snapshotFor(root);
	const codec = new RecoveryCodec(randomBytes(32));
	const nowMs = Date.parse("2026-09-07T10:00:00Z");
	const config = operatorConfig();
	const calls = [];
	const router = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), agentContextSnapshot: snapshot, runtimeRevision: RUNTIME_REVISION, recoveryCodec: codec, now: () => nowMs, send: async () => ({ state: "confirmed" }), runner: failingRunner(store, calls) });
	const submitted = await router.submitOperatorRequest({ channelId: CHANNEL, authorId: USER, content: "secret business request", access: "read-only" });
	await router.waitForIdle();
	const envelope = store.loadJobRecovery(submitted.jobId);
	const parkedJobId = "working-hours-parked";
	store.createJob({ jobId: parkedJobId, backendId: "codex", activityDetail: "structured", jobType: "conversation", recoveryEnvelope: envelope });
	store.startAttempt(parkedJobId, { attemptId: "parked-attempt" });
	const recovered = store.recoverInterruptedWork().find((item) => item.jobId === parkedJobId);
	const controls = [];
	const recoveryCalls = [];
	// autoRetry:false is the fixture default and the state a managed cutover
	// leaves behind, so this is the common path, not an edge case.
	const recoveryRouter = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime-parked"), agentContextSnapshot: snapshot, runtimeRevision: RUNTIME_REVISION, recoveryCodec: codec, now: () => nowMs, send: async (input) => { controls.push(input); return { state: "confirmed" }; }, runner: failingRunner(store, recoveryCalls) });
	recoveryRouter.resumeRecovered([recovered], { autoRetry: false });
	await recoveryRouter.waitForIdle();
	await recoveryRouter.shutdown();
	assert.equal(recoveryCalls.length, 0, "parked work must not be replayed");
	const events = store.getJob(parkedJobId).events;
	assert.equal(events.filter((event) => event.kind === "recovery_review_required").length, 1);
	const notices = controls.filter((control) => control.content.includes(parkedJobId));
	assert.equal(notices.length, 1, "exactly one notice per parked job");
	assert.equal(notices[0].channelId, CHANNEL);
	assert.match(notices[0].content, /다시 보내|send the same request again/);
	// The parked notice must not leak the encrypted request back to the channel.
	assert.equal(notices[0].content.includes("secret business request"), false);
	store.close();
});

test("working-hours keeps closed-admission queue readonly when the clock opens and lets explicit retry reevaluate original intent", async () => {
	const { store, root } = fixture();
	const snapshot = snapshotFor(root);
	let nowMs = Date.parse("2026-09-07T10:00:00Z");
	let release;
	const blocked = new Promise((resolve) => { release = resolve; });
	const calls = [];
	const codec = new RecoveryCodec(randomBytes(32));
	const router = new DiscordMessageRouter({ config: operatorConfig(), store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), agentContextSnapshot: snapshot, runtimeRevision: RUNTIME_REVISION, recoveryCodec: codec, now: () => nowMs, send: async () => ({ state: "confirmed" }), runner: failingRunner(store, calls, { block: blocked }) });
	const first = await router.onDispatch("MESSAGE_CREATE", message("700000000000000011", "first"), 11);
	await waitUntil(() => calls.length === 1, "first runner");
	nowMs = Date.parse("2026-09-07T18:00:00Z");
	const queued = await router.onDispatch("MESSAGE_CREATE", message("700000000000000012", "queued"), 12);
	assert.equal(queued.state, "accepted");
	nowMs = Date.parse("2026-09-07T10:00:00Z");
	release();
	await router.waitForIdle();
	assert.equal(first.state, "accepted");
	assert.equal(calls[1].executionProfile.access, "read-only");
	assert.match(calls[1].prompt, /Mutation window/);
	assert.equal(calls[1].commandOptions.sandbox, "read-only");
	const queuedPayload = JSON.parse(codec.open(store.loadJobRecovery(queued.jobId)));
	assert.equal(queuedPayload.originalAccessCeiling, null);
	assert.equal(queuedPayload.accessCeiling, "read-only");
	const retry = router.replaceJob(queued.jobId);
	await router.waitForIdle();
	assert.equal(retry.state, "accepted");
	assert.equal(calls[2].executionProfile.access, "workspace-write");
	assert.match(calls[2].prompt, /Allowed actions:.*write/);
	assert.equal(calls[2].commandOptions.sandbox, "workspace-write");
	const replacementJob = store.getJob(retry.replacementJobId, { includeEvents: false });
	assert.equal(replacementJob.revision, `v2w:${RUNTIME_REVISION}`);
	assert.equal(replacementJob.executionBinding, null);
	const replacementPayload = JSON.parse(codec.open(store.loadJobRecovery(retry.replacementJobId)));
	assert.equal(replacementPayload.originalAccessCeiling, null);
	assert.equal(replacementPayload.accessCeiling, null);
	store.close();
});

test("working-hours re-evaluates queued work at dequeue and allows a later retry after reopening", async () => {
	const { store, root } = fixture();
	const snapshot = snapshotFor(root);
	let nowMs = Date.parse("2026-09-07T10:00:00Z");
	let release;
	const blocked = new Promise((resolve) => { release = resolve; });
	const calls = [];
	const router = new DiscordMessageRouter({ config: operatorConfig(), store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), agentContextSnapshot: snapshot, runtimeRevision: RUNTIME_REVISION, recoveryCodec: new RecoveryCodec(randomBytes(32)), now: () => nowMs, send: async () => ({ state: "confirmed" }), runner: failingRunner(store, calls, { block: blocked }) });
	const first = await router.onDispatch("MESSAGE_CREATE", message("700000000000000031", "first"), 31);
	await waitUntil(() => calls.length === 1, "first runner");
	const queued = await router.onDispatch("MESSAGE_CREATE", message("700000000000000032", "queued"), 32);
	nowMs = Date.parse("2026-09-07T18:00:00Z");
	release();
	await router.waitForIdle();
	assert.equal(first.state, "accepted");
	assert.equal(queued.state, "accepted");
	assert.equal(calls[1].executionProfile.access, "read-only");
	assert.match(calls[1].prompt, /Mutation window/);
	nowMs = Date.parse("2026-09-07T10:00:00Z");
	const retry = router.replaceJob(queued.jobId);
	await router.waitForIdle();
	assert.equal(retry.state, "accepted");
	assert.equal(calls[2].executionProfile.access, "workspace-write");
	store.close();
});

test("working-hours preserves explicit readonly ceiling through terminal restart and recovery", async () => {
	const { store, root } = fixture();
	const snapshot = snapshotFor(root);
	const codec = new RecoveryCodec(randomBytes(32));
	const calls = [];
	const config = operatorConfig();
	const router = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), agentContextSnapshot: snapshot, runtimeRevision: RUNTIME_REVISION, recoveryCodec: codec, now: () => Date.parse("2026-09-07T10:00:00Z"), send: async () => ({ state: "confirmed" }), runner: failingRunner(store, calls) });
	const submitted = await router.submitOperatorRequest({ channelId: CHANNEL, authorId: USER, content: "readonly restart", access: "read-only" });
	await router.waitForIdle();
	assert.equal(calls[0].executionProfile.access, "read-only");
	const originalPayload = JSON.parse(codec.open(store.loadJobRecovery(submitted.jobId)));
	assert.equal(originalPayload.originalAccessCeiling, "read-only");
	assert.equal(originalPayload.accessCeiling, "read-only");
	const restarted = router.replaceJob(submitted.jobId);
	await router.waitForIdle();
	assert.equal(restarted.state, "accepted");
	assert.equal(calls[1].executionProfile.access, "read-only");
	assert.equal(calls[1].commandOptions.sandbox, "read-only");
	const envelope = store.loadJobRecovery(restarted.replacementJobId);
	assert.ok(envelope);
	const replacementJob = store.getJob(restarted.replacementJobId, { includeEvents: false });
	assert.equal(replacementJob.revision, `v2r:${RUNTIME_REVISION}`);
	assert.equal(replacementJob.executionBinding?.access, "read-only");
	const recoveredJob = "working-hours-recovery";
	store.createJob({ jobId: recoveredJob, backendId: "codex", activityDetail: "structured", jobType: "conversation", recoveryEnvelope: envelope });
	store.startAttempt(recoveredJob, { attemptId: "stale-recovery-attempt" });
	const recovered = store.recoverInterruptedWork().find((item) => item.jobId === recoveredJob);
	const recoveryRouter = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime-recovery"), agentContextSnapshot: snapshot, runtimeRevision: RUNTIME_REVISION, recoveryCodec: codec, now: () => Date.parse("2026-09-07T10:00:00Z"), send: async () => ({ state: "confirmed" }), runner: failingRunner(store, calls) });
	recoveryRouter.resumeRecovered([recovered], { autoRetry: true });
	await recoveryRouter.waitForIdle();
	assert.equal(calls[2].executionProfile.access, "read-only");
	assert.equal(calls[2].commandOptions.sandbox, "read-only");
	store.close();
});

test("working-hours preserves writable intent across closed admission and explicit reopening", async () => {
	const { store, root } = fixture();
	const snapshot = snapshotFor(root);
	const codec = new RecoveryCodec(randomBytes(32));
	const calls = [];
	let nowMs = Date.parse("2026-09-07T18:00:00Z");
	const config = operatorConfig();
	const router = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), agentContextSnapshot: snapshot, runtimeRevision: RUNTIME_REVISION, recoveryCodec: codec, now: () => nowMs, send: async () => ({ state: "confirmed" }), runner: failingRunner(store, calls) });
	const submitted = await router.submitOperatorRequest({ channelId: CHANNEL, authorId: USER, content: "closed admission then retry" });
	await router.waitForIdle();
	assert.equal(submitted.state, "accepted");
	assert.equal(calls[0].executionProfile.access, "read-only");
	assert.match(calls[0].prompt, /Allowed actions: read, reply/);
	assert.doesNotMatch(calls[0].prompt, /Allowed actions:.*write/);
	const closedPayload = JSON.parse(codec.open(store.loadJobRecovery(submitted.jobId)));
	assert.equal(closedPayload.originalAccessCeiling, null);
	assert.equal(closedPayload.accessCeiling, "read-only");
	nowMs = Date.parse("2026-09-07T10:00:00Z");
	const restarted = router.replaceJob(submitted.jobId);
	await router.waitForIdle();
	assert.equal(restarted.state, "accepted");
	assert.equal(calls[1].executionProfile.access, "workspace-write");
	assert.match(calls[1].prompt, /Allowed actions: read, reply, write, execute/);
	assert.equal(calls[1].commandOptions.sandbox, "workspace-write");
	const replacementJob = store.getJob(restarted.replacementJobId, { includeEvents: false });
	assert.equal(replacementJob.revision, `v2w:${RUNTIME_REVISION}`);
	assert.equal(replacementJob.executionBinding, null);
	const replacementPayload = JSON.parse(codec.open(store.loadJobRecovery(restarted.replacementJobId)));
	assert.equal(replacementPayload.originalAccessCeiling, null);
	assert.equal(replacementPayload.accessCeiling, null);
	store.close();
});

test("working-hours active closed-admission retry reevaluates writable intent with a fresh prompt and binding", async () => {
	const { store, root } = fixture();
	const snapshot = snapshotFor(root);
	const codec = new RecoveryCodec(randomBytes(32));
	let nowMs = Date.parse("2026-09-07T18:00:00Z");
	let release;
	const blocked = new Promise((resolve) => { release = resolve; });
	const calls = [];
	const router = new DiscordMessageRouter({ config: operatorConfig(), store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), agentContextSnapshot: snapshot, runtimeRevision: RUNTIME_REVISION, recoveryCodec: codec, now: () => nowMs, send: async () => ({ state: "confirmed" }), runner: failingRunner(store, calls, { block: blocked }) });
	const submitted = await router.onDispatch("MESSAGE_CREATE", message("700000000000000021", "active retry"), 21);
	await waitUntil(() => calls.length === 1, "closed active runner");
	assert.equal(calls[0].executionProfile.access, "read-only");
	nowMs = Date.parse("2026-09-07T10:00:00Z");
	const retry = router.replaceJob(submitted.jobId);
	assert.equal(retry.state, "accepted");
	release();
	await router.waitForIdle();
	assert.equal(calls[1].executionProfile.access, "workspace-write");
	assert.match(calls[1].prompt, /Allowed actions: read, reply, write, execute/);
	assert.equal(calls[1].commandOptions.sandbox, "workspace-write");
	const replacementJob = store.getJob(retry.replacementJobId, { includeEvents: false });
	assert.equal(replacementJob.revision, `v2w:${RUNTIME_REVISION}`);
	assert.equal(replacementJob.executionBinding, null);
	const replacementPayload = JSON.parse(codec.open(store.loadJobRecovery(retry.replacementJobId)));
	assert.equal(replacementPayload.originalAccessCeiling, null);
	assert.equal(replacementPayload.accessCeiling, null);
	store.close();
});

test("working-hours explicit retry while the window is closed remains readonly", async () => {
	const { store, root } = fixture();
	const snapshot = snapshotFor(root);
	const codec = new RecoveryCodec(randomBytes(32));
	let nowMs = Date.parse("2026-09-07T10:00:00Z");
	const calls = [];
	const router = new DiscordMessageRouter({ config: operatorConfig(), store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), agentContextSnapshot: snapshot, runtimeRevision: RUNTIME_REVISION, recoveryCodec: codec, now: () => nowMs, send: async () => ({ state: "confirmed" }), runner: failingRunner(store, calls) });
	const submitted = await router.submitOperatorRequest({ channelId: CHANNEL, authorId: USER, content: "retry while closed" });
	await router.waitForIdle();
	assert.equal(calls[0].executionProfile.access, "workspace-write");
	nowMs = Date.parse("2026-09-07T18:00:00Z");
	const retry = router.replaceJob(submitted.jobId);
	await router.waitForIdle();
	assert.equal(retry.state, "accepted");
	assert.equal(calls[1].executionProfile.access, "read-only");
	assert.equal(calls[1].commandOptions.sandbox, "read-only");
	assert.match(calls[1].prompt, /Mutation window/);
	assert.match(calls[1].prompt, /Allowed actions: read, reply/);
	const replacementJob = store.getJob(retry.replacementJobId, { includeEvents: false });
	assert.equal(replacementJob.revision, `v2r:${RUNTIME_REVISION}`);
	assert.equal(replacementJob.executionBinding?.access, "read-only");
	const replacementPayload = JSON.parse(codec.open(store.loadJobRecovery(retry.replacementJobId)));
	assert.equal(replacementPayload.originalAccessCeiling, null);
	assert.equal(replacementPayload.accessCeiling, "read-only");
	store.close();
});

test("working-hours legacy envelope without original ceiling cannot promote a readonly attempt", async () => {
	const { store, root } = fixture();
	const snapshot = snapshotFor(root);
	const codec = new RecoveryCodec(randomBytes(32));
	let nowMs = Date.parse("2026-09-07T18:00:00Z");
	const calls = [];
	const router = new DiscordMessageRouter({ config: operatorConfig(), store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), agentContextSnapshot: snapshot, runtimeRevision: RUNTIME_REVISION, recoveryCodec: codec, now: () => nowMs, send: async () => ({ state: "confirmed" }), runner: failingRunner(store, calls) });
	const submitted = await router.submitOperatorRequest({ channelId: CHANNEL, authorId: USER, content: "legacy retry" });
	await router.waitForIdle();
	const legacyPayload = JSON.parse(codec.open(store.loadJobRecovery(submitted.jobId)));
	assert.equal(legacyPayload.originalAccessCeiling, null);
	delete legacyPayload.originalAccessCeiling;
	const legacyJob = "working-hours-legacy-retry";
	store.createJob({ jobId: legacyJob, backendId: "codex", activityDetail: "structured", jobType: "conversation", recoveryEnvelope: codec.seal(JSON.stringify(legacyPayload)) });
	const attemptId = store.startAttempt(legacyJob, { attemptId: "legacy-retry-attempt" });
	store.recordEvent({ jobId: legacyJob, attemptId, source: "helper", kind: "failed", safePayload: { reasonCode: "process_exit" } });
	nowMs = Date.parse("2026-09-07T10:00:00Z");
	const retry = router.replaceJob(legacyJob);
	await router.waitForIdle();
	assert.equal(retry.state, "accepted");
	assert.equal(calls[1].executionProfile.access, "read-only");
	assert.equal(calls[1].commandOptions.sandbox, "read-only");
	assert.doesNotMatch(calls[1].prompt, /Allowed actions:.*write/);
	const replacementJob = store.getJob(retry.replacementJobId, { includeEvents: false });
	assert.equal(replacementJob.revision, `v2r:${RUNTIME_REVISION}`);
	assert.equal(replacementJob.executionBinding?.access, "read-only");
	store.close();
});

test("working-hours automatic recovery keeps closed-admission readonly work readonly after reopening", async () => {
	const { store, root } = fixture();
	const snapshot = snapshotFor(root);
	const codec = new RecoveryCodec(randomBytes(32));
	let nowMs = Date.parse("2026-09-07T18:00:00Z");
	const calls = [];
	const config = operatorConfig();
	const router = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), agentContextSnapshot: snapshot, runtimeRevision: RUNTIME_REVISION, recoveryCodec: codec, now: () => nowMs, send: async () => ({ state: "confirmed" }), runner: failingRunner(store, calls) });
	const submitted = await router.submitOperatorRequest({ channelId: CHANNEL, authorId: USER, content: "automatic readonly recovery" });
	await router.waitForIdle();
	assert.equal(calls[0].executionProfile.access, "read-only");
	const payload = JSON.parse(codec.open(store.loadJobRecovery(submitted.jobId)));
	assert.equal(payload.originalAccessCeiling, null);
	assert.equal(payload.accessCeiling, "read-only");
	const recoveredJob = "working-hours-writable-recovery";
	store.createJob({ jobId: recoveredJob, backendId: "codex", activityDetail: "structured", jobType: "conversation", recoveryEnvelope: codec.seal(JSON.stringify(payload)) });
	store.startAttempt(recoveredJob, { attemptId: "writable-recovery-attempt" });
	const recovered = store.recoverInterruptedWork().find((item) => item.jobId === recoveredJob);
	nowMs = Date.parse("2026-09-07T10:00:00Z");
	const recoveryCalls = [];
	const recoveryRouter = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime-auto-recovery"), agentContextSnapshot: snapshot, runtimeRevision: RUNTIME_REVISION, recoveryCodec: codec, now: () => nowMs, send: async () => ({ state: "confirmed" }), runner: failingRunner(store, recoveryCalls) });
	recoveryRouter.resumeRecovered([recovered], { autoRetry: true });
	await recoveryRouter.waitForIdle();
	assert.equal(recoveryCalls.length, 1);
	assert.equal(recoveryCalls[0].executionProfile.access, "read-only");
	assert.equal(recoveryCalls[0].commandOptions.sandbox, "read-only");
	assert.match(recoveryCalls[0].prompt, /Allowed actions: read, reply/);
	assert.doesNotMatch(recoveryCalls[0].prompt, /Allowed actions:.*write/);
	store.close();
});

test("working-hours pre-spawn clock close prevents provider spawn", async () => {
	const { store, root } = fixture();
	const snapshot = snapshotFor(root);
	let nowMs = Date.parse("2026-09-07T10:00:00Z");
	let spawned = false;
	const calls = [];
	const router = new DiscordMessageRouter({ config: operatorConfig(), store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), agentContextSnapshot: snapshot, runtimeRevision: RUNTIME_REVISION, now: () => nowMs, send: async () => ({ state: "confirmed" }), runner: async (input) => {
		calls.push(input);
		nowMs = Date.parse("2026-09-07T18:00:00Z");
		input.preSpawnCheck();
		spawned = true;
		return { backendOutcome: "failure", transientResult: null };
	} });
	const submitted = await router.submitOperatorRequest({ channelId: CHANNEL, authorId: USER, content: "pre-spawn race" });
	await router.waitForIdle();
	assert.equal(submitted.state, "accepted");
	assert.equal(calls.length, 1);
	assert.equal(spawned, false);
	const job = store.getJob(submitted.jobId);
	assert.equal(job.lifecycle, "failed");
	assert.ok(job.events.some((event) => event.kind === "failed" && event.safeSummary.includes("mutation_window_closed")));
	store.close();
});
