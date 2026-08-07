import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { DiscordMessageRouter } from "../helper/discord-router.mjs";
import { RecoveryCodec } from "../helper/recovery-crypto.mjs";
import { randomBytes } from "node:crypto";
import { fetchDiscordConversation, promptWithDiscordConversation, renderDiscordConversation, renderParticipantConversation, trustedParticipantPolicy } from "../helper/discord-conversation.mjs";
import { commandOptionsForProfile, currentExecutionProfile, effectiveAllowedActions, participantAuthorityRevision, sameExecutionProfile } from "../helper/execution-profile.mjs";
import { buildAgentContextSnapshot } from "../helper/agent-context.mjs";
import { BOT, CHANNEL, GUILD, OTHER_USER, RUNTIME_REVISION, THREAD, USER, binding, cleanupDiscordFixtureRoots, fixture } from "./fixtures/discord-fixture.mjs";

afterEach(cleanupDiscordFixtureRoots);

test("DSG-006 enforces configured read-only role in the actual backend invocation", async () => {
	const { store, root } = fixture();
	const calls = [];
	const config = {
		persona: { name: "Reviewer", instructions: "Review safely." },
		role: { name: "read-only", allowedActions: ["read", "reply"] },
		backend: { selected: "codex" },
		discord: { bindings: [binding()], operatorUserIds: [] },
		runtime: { maxConcurrentJobs: 1 },
	};
	const router = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), runtimeRevision: RUNTIME_REVISION, send: async () => ({ state: "confirmed" }), runner: async (input) => { calls.push(input); return { backendOutcome: "failure", transientResult: null }; } });
	const accepted = await router.onDispatch("MESSAGE_CREATE", { id: "666666666666666666", guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }], content: `<@${BOT}> inspect this` }, 8);
	assert.equal(accepted.state, "accepted");
	await router.waitForIdle();
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].commandOptions, { sandbox: "read-only", approvalPolicy: "never", costProfile: "balanced", networkAccess: false, credentialProfiles: [] });
	assert.match(calls[0].prompt, /Routine authority: A bounded user request authorizes its normal in-scope execution path/);
	assert.match(calls[0].prompt, /No approval click is available/);
	assert.match(calls[0].prompt, /Ask only when a material unresolved choice would change the requested scope/);
	assert.equal(JSON.stringify(store.listJobs()).includes("inspect this"), false);
	assert.equal(store.getJob(accepted.jobId, { includeEvents: false }).revision, `discord-v1:${RUNTIME_REVISION}`);
	assert.equal(store.getJob(accepted.jobId, { includeEvents: false }).executionBinding, null);
	store.close();
});

test("DSG-006 refuses to construct a router without a confirmed Discord sender", () => {
	const { store, root } = fixture();
	const config = { persona: { name: "Reviewer", instructions: "Review safely." }, role: { name: "read-only", allowedActions: ["read", "reply"] }, backend: { selected: "codex" }, discord: { bindings: [binding()], operatorUserIds: [] }, runtime: { maxConcurrentJobs: 1 } };
	assert.throws(() => new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime") }), /confirmed Discord sender is required/);
	store.close();
});

test("DSG-016 loads bounded conversation context without retaining bot receipts or unrelated authors", async () => {
	const messages = [
		{ author: { id: BOT, bot: true }, content: "[메시지 받음]" },
		{ author: { id: BOT, bot: true }, content: "진행 중: 관련 코드와 현재 상태를 확인하고 있습니다." },
		{ author: { id: "888888888888888888" }, content: "unrelated-secret" },
		{ author: { id: BOT, bot: true }, content: "이전 작업의 실제 답변" },
		{ author: { id: USER }, content: `<@${BOT}> 위 작업 이어서 해줘` },
	];
	assert.equal(renderDiscordConversation(messages, { botUserId: BOT, allowedUserIds: [USER] }), "user: 위 작업 이어서 해줘\nassistant: 이전 작업의 실제 답변");
	const requests = [];
	const loaded = await fetchDiscordConversation({
		token: "token-value-long-enough", channelId: CHANNEL, beforeMessageId: "666666666666666666", botUserId: BOT, allowedUserIds: [USER],
		fetchImpl: async (url, init) => { requests.push({ url, init }); return { ok: true, json: async () => messages }; },
	});
	assert.equal(loaded.state, "loaded");
	assert.match(requests[0].url, /before=666666666666666666&limit=100$/);
	assert.equal(requests[0].init.method, "GET");
	const prompt = promptWithDiscordConversation("User request:\n현재 요청", loaded.history, "현재 요청");
	assert.equal(prompt.includes("unrelated-secret"), false);
	assert.match(prompt, /현재 요청$/);
	const markerRequest = "설명에 User request:\n이라는 문구가 들어간 요청";
	const markerPrompt = promptWithDiscordConversation(`Stable policy\nUser request:\n${markerRequest}`, loaded.history, markerRequest);
	assert.match(markerPrompt, /Discord recent conversation[\s\S]*User request:\n설명에 User request:\n이라는 문구가 들어간 요청$/);
});

test("DSG-021 enforces none, requester-only, and explicitly shared participant history", async () => {
	const participantProfiles = {
		[USER]: { label: "workspace-owner", relationship: "workspace owner", allowedActions: ["read", "reply"] },
		[OTHER_USER]: { label: "reviewer", relationship: "external reviewer", allowedActions: ["read", "reply"] },
	};
	const messages = [
		{ author: { id: BOT, bot: true }, content: "answer intended for someone else" },
		{ author: { id: OTHER_USER }, content: "other-private-context" },
		{ author: { id: USER }, content: "owner context" },
	];
	assert.equal(renderParticipantConversation(messages, { botUserId: BOT, allowedUserIds: [USER, OTHER_USER], participantProfiles, requesterUserId: USER, historyVisibility: "requester_only" }), "participant[workspace-owner]: owner context");
	const shared = renderParticipantConversation(messages, { botUserId: BOT, allowedUserIds: [USER, OTHER_USER], participantProfiles, requesterUserId: USER, historyVisibility: "shared" });
	assert.match(shared, /participant\[workspace-owner\]: owner context/);
	assert.match(shared, /participant\[reviewer\]: other-private-context/);
	assert.match(shared, /assistant: answer intended for someone else/);
	let fetches = 0;
	const disabled = await fetchDiscordConversation({ token: "token-value-long-enough", channelId: CHANNEL, beforeMessageId: "666666666666666666", botUserId: BOT, allowedUserIds: [USER], requesterUserId: USER, historyVisibility: "none", fetchImpl: async () => { fetches += 1; } });
	assert.deepEqual(disabled, { state: "disabled", history: "", messageCount: 0 });
	assert.equal(fetches, 0);
	const policy = trustedParticipantPolicy({ participantProfile: participantProfiles[USER], effectiveActions: ["read", "reply"] });
	assert.match(policy, /Current requester: participant\[workspace-owner\]/);
	assert.equal(policy.includes(USER), false);
});

test("DSG-021 reduces mutation authority by participant and operator policy and binds revisions", () => {
	const config = { schemaVersion: 2, role: { allowedActions: ["read", "reply", "write", "execute"], requiresApproval: [] }, runtime: { approvalPolicy: "never", permissionProfileEpoch: "participant-v1" } };
	const participantProfile = { label: "workspace-owner", relationship: "workspace owner", allowedActions: ["read", "reply", "write", "execute"] };
	const ownerAuthority = { participantProfile, isOperator: true, binding: { operatorActions: true } };
	const memberAuthority = { participantProfile, isOperator: false, binding: { operatorActions: true } };
	assert.deepEqual(effectiveAllowedActions(config, ownerAuthority), ["read", "reply", "write", "execute"]);
	assert.deepEqual(effectiveAllowedActions(config, memberAuthority), ["read", "reply"]);
	assert.equal(commandOptionsForProfile(currentExecutionProfile(config, "codex", ownerAuthority)).sandbox, "workspace-write");
	assert.equal(commandOptionsForProfile(currentExecutionProfile(config, "codex", memberAuthority)).sandbox, "read-only");
	const trustedConfig = { ...config, runtime: { ...config.runtime, accessProfile: "trusted-local" } };
	assert.equal(commandOptionsForProfile(currentExecutionProfile(trustedConfig, "codex", ownerAuthority)).sandbox, "danger-full-access");
	assert.equal(commandOptionsForProfile(currentExecutionProfile(trustedConfig, "claude", ownerAuthority)).permissionMode, "bypassPermissions");
	assert.equal(commandOptionsForProfile(currentExecutionProfile(trustedConfig, "opencode", ownerAuthority)).auto, true);
	assert.equal(commandOptionsForProfile(currentExecutionProfile(trustedConfig, "codex", memberAuthority)).sandbox, "read-only");
	assert.throws(() => effectiveAllowedActions(config), /participant authority/);
	const authorityRevision = participantAuthorityRevision({ workspaceIdentity: "workspace-1", bindingIdentity: "scope-1", participantUserId: USER, participantProfile, effectiveActions: ["read", "reply", "write", "execute"], permissionProfileEpoch: "participant-v1" });
	const bound = currentExecutionProfile(config, "codex", { ...ownerAuthority, authorityRevision, contextHash: "a".repeat(64) });
	assert.equal(sameExecutionProfile(bound, { ...bound, contextHash: "b".repeat(64) }), false);
});

test("FET_DSO_015_004 admits an owner-controlled local submission only through the exact operator binding", async () => {
	const { store, root } = fixture();
	mkdirSync(join(root, ".agents/context"), { recursive: true });
	writeFileSync(join(root, "AGENTS.md"), "# Operator agent\n", "utf8");
	writeFileSync(join(root, ".agents/context/policy.yaml"), "authority: bounded\n", "utf8");
	const snapshot = buildAgentContextSnapshot({ workspace: root, agentId: "operator-agent", entrypoint: "AGENTS.md", contextFiles: [".agents/context/policy.yaml"] });
	const participantProfile = { label: "workspace-owner", relationship: "workspace owner", allowedActions: ["read", "reply", "write", "execute"] };
	const operatorBinding = { ...binding(), operatorActions: true, historyVisibility: "none" };
	const config = {
		schemaVersion: 2,
		workspace: { agentId: "operator-agent" },
		persona: { name: "Operator", instructions: "Complete bounded operator work." },
		role: { name: "operator", allowedActions: ["read", "reply", "write", "execute"], requiresApproval: [] },
		backend: { selected: "codex", profiles: { codex: { enabled: true } } },
		discord: { bindings: [operatorBinding], operatorUserIds: [USER], participantProfiles: { [USER]: participantProfile } },
		runtime: { maxConcurrentJobs: 1, approvalPolicy: "never", permissionProfileEpoch: "operator-v1" },
		recovery: { autoRetry: false },
	};
	const calls = [];
	const router = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: snapshot.workspaceRoot, runtimeRoot: join(root, "runtime"), agentContextSnapshot: snapshot, runtimeRevision: RUNTIME_REVISION, send: async () => ({ state: "confirmed" }), runner: async (input) => { calls.push(input); return { backendOutcome: "failure", transientResult: null }; } });
	assert.equal((await router.submitOperatorRequest({ channelId: CHANNEL, authorId: OTHER_USER, content: "resume work" })).reasonCode, "operator_binding_unavailable");
	assert.equal((await router.submitOperatorRequest({ channelId: THREAD, authorId: USER, content: "resume work" })).reasonCode, "operator_binding_unavailable");
	const accepted = await router.submitOperatorRequest({ channelId: CHANNEL, authorId: USER, content: "resume work" });
	assert.equal(accepted.state, "accepted");
	assert.equal(accepted.semantics, "owner_controlled_operator_submission");
	await router.waitForIdle();
	assert.equal(calls.length, 1);
	assert.match(calls[0].prompt, /User request:\nresume work$/);
	store.close();
});

test("DSG-021 launches v2 work in its bound workspace with a stable prefix and fails closed after context drift", async () => {
	const { store, root } = fixture();
	mkdirSync(join(root, ".agents/context"), { recursive: true });
	writeFileSync(join(root, "AGENTS.md"), "# Bound agent\nRead the project context first.\n", "utf8");
	writeFileSync(join(root, ".agents/context/policy.yaml"), "authority: bounded\n", "utf8");
	const snapshot = buildAgentContextSnapshot({ workspace: root, agentId: "bound-agent", entrypoint: "AGENTS.md", contextFiles: [".agents/context/policy.yaml"] });
	const participantProfile = { label: "workspace-owner", relationship: "workspace owner", allowedActions: ["read", "reply", "write", "execute"] };
	const v2Binding = { ...binding(), operatorActions: true, historyVisibility: "shared" };
	const config = {
		schemaVersion: 2,
		workspace: { agentId: "bound-agent" },
		persona: { name: "Bound agent", instructions: "Operate only in the configured project." },
		role: { name: "project-agent", allowedActions: ["read", "reply", "write", "execute"], requiresApproval: [] },
		backend: { selected: "codex", profiles: { codex: { enabled: true, model: "gpt-5.4" } } },
		discord: { bindings: [v2Binding], operatorUserIds: [USER], participantProfiles: { [USER]: participantProfile } },
		runtime: { maxConcurrentJobs: 1, approvalPolicy: "never", permissionProfileEpoch: "bound-v1" },
		recovery: { autoRetry: false },
	};
	const calls = [];
	const router = new DiscordMessageRouter({
		config, store, token: "token-value-long-enough", botUserId: BOT, cwd: snapshot.workspaceRoot, runtimeRoot: join(root, "runtime"), agentContextSnapshot: snapshot, runtimeRevision: RUNTIME_REVISION,
		send: async () => ({ state: "confirmed" }),
		loadHistory: async () => ({ state: "loaded", history: "participant[workspace-owner]: earlier context", messageCount: 1 }),
		runner: async (input) => { calls.push(input); return { backendOutcome: "failure", transientResult: null }; },
	});
	for (const [id, request] of [["676767676767676761", "first request"], ["676767676767676762", "second request"]]) {
		assert.equal((await router.onDispatch("MESSAGE_CREATE", { id, guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, member: { roles: ["999999999999999999"] }, mentions: [{ id: BOT }], content: `<@${BOT}> ${request}` }, 40)).state, "accepted");
		await router.waitForIdle();
	}
	assert.equal(calls.length, 2);
	assert.equal(calls.every((call) => call.cwd === snapshot.workspaceRoot && call.commandOptions.sandbox === "workspace-write"), true);
	assert.equal(calls.every((call) => call.commandOptions.costProfile === "balanced"), true);
	assert.equal(store.listJobs().every((job) => job.revision === `v2w:${RUNTIME_REVISION}`), true);
	assert.equal(store.listJobs().every((job) => job.executionBinding === null), true);
	const stablePrefix = (prompt) => prompt.slice(0, prompt.indexOf("Current requester:"));
	assert.equal(stablePrefix(calls[0].prompt), stablePrefix(calls[1].prompt));
	assert.match(calls[0].prompt, /Discord recent conversation[\s\S]*earlier context[\s\S]*User request:\nfirst request$/);
	assert.match(calls[0].prompt, /Gateway execution contract: workspace-write\. Cost profile: balanced\./);
	assert.match(calls[0].prompt, /Do not downgrade it to read-only merely because no interactive session binding exists/);
	assert.equal(calls[0].prompt.includes(USER), false);
	writeFileSync(join(root, ".agents/context/policy.yaml"), "authority: changed\n", "utf8");
	assert.equal((await router.onDispatch("MESSAGE_CREATE", { id: "676767676767676763", guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }], content: `<@${BOT}> third request` }, 41)).state, "accepted");
	await router.waitForIdle();
	assert.equal(calls.length, 2);
	const driftedJob = store.listJobs().map((job) => store.getJob(job.jobId, { includeEvents: false })).find((job) => job.latestSafeError?.includes("context_changed_restart_required"));
	assert.ok(driftedJob);
	assert.match(driftedJob.latestSafeError, /context_changed_restart_required/);
	store.close();
});

test("UCT_DSO_014_003 preserves an exact safe pre-attempt stage when fixture history loading fails", async () => {
	const { store, root } = fixture();
	mkdirSync(join(root, ".agents/context"), { recursive: true });
	writeFileSync(join(root, "AGENTS.md"), "# Bound agent\n", "utf8");
	writeFileSync(join(root, ".agents/context/policy.yaml"), "authority: bounded\n", "utf8");
	const snapshot = buildAgentContextSnapshot({ workspace: root, agentId: "diagnostic-agent", entrypoint: "AGENTS.md", contextFiles: [".agents/context/policy.yaml"] });
	const participantProfile = { label: "workspace-owner", relationship: "workspace owner", allowedActions: ["read", "reply", "write", "execute"] };
	const v2Binding = { ...binding(), operatorActions: true, historyVisibility: "shared" };
	const config = { schemaVersion: 2, workspace: { agentId: "diagnostic-agent" }, persona: { name: "Diagnostic", instructions: "Diagnose." }, role: { name: "operator", allowedActions: ["read", "reply", "write", "execute"], requiresApproval: [] }, backend: { selected: "codex", profiles: { codex: { enabled: true } } }, discord: { bindings: [v2Binding], operatorUserIds: [USER], participantProfiles: { [USER]: participantProfile } }, runtime: { maxConcurrentJobs: 1, approvalPolicy: "never", permissionProfileEpoch: "diagnostic-v1" }, recovery: { autoRetry: false } };
	let runnerCalls = 0;
	const router = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: snapshot.workspaceRoot, runtimeRoot: join(root, "runtime"), agentContextSnapshot: snapshot, runtimeRevision: RUNTIME_REVISION, send: async () => ({ state: "confirmed" }), loadHistory: async () => { throw new Error("private upstream detail"); }, runner: async () => { runnerCalls += 1; return { backendOutcome: "failure" }; } });
	const accepted = await router.onDispatch("MESSAGE_CREATE", { id: "676767676767676799", guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }], content: `<@${BOT}> diagnose` }, 99);
	await router.waitForIdle();
	const job = store.getJob(accepted.jobId);
	assert.equal(runnerCalls, 0);
	assert.equal(job.attemptId, null);
	assert.equal(job.latestSafeError, "Job failed: discord_history_load_failed");
	assert.equal(JSON.stringify(job).includes("private upstream detail"), false);
	store.close();
});

test("DSG-021 requires exact v2 authority, configuration, and context revisions for read-only recovery", async () => {
	const { store, root } = fixture();
	mkdirSync(join(root, ".agents/context"), { recursive: true });
	writeFileSync(join(root, "AGENTS.md"), "# Recovery-bound agent\n", "utf8");
	writeFileSync(join(root, ".agents/context/policy.yaml"), "authority: bounded\n", "utf8");
	const snapshot = buildAgentContextSnapshot({ workspace: root, agentId: "recovery-agent", entrypoint: "AGENTS.md", contextFiles: [".agents/context/policy.yaml"] });
	const participantProfile = { label: "workspace-owner", relationship: "workspace owner", allowedActions: ["read", "reply"] };
	const v2Binding = { ...binding(), operatorActions: false, historyVisibility: "none" };
	const config = {
		schemaVersion: 2,
		workspace: { agentId: "recovery-agent" },
		persona: { name: "Recovery agent", instructions: "Stay read-only." },
		role: { name: "reader", allowedActions: ["read", "reply"], requiresApproval: [] },
		backend: { selected: "codex", profiles: { codex: { enabled: true } } },
		discord: { bindings: [v2Binding], operatorUserIds: [USER], participantProfiles: { [USER]: participantProfile } },
		runtime: { maxConcurrentJobs: 1, approvalPolicy: "never", permissionProfileEpoch: "recovery-v1" },
		recovery: { autoRetry: true },
	};
	const codec = new RecoveryCodec(randomBytes(32));
	const firstRouter = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: snapshot.workspaceRoot, runtimeRoot: join(root, "runtime"), agentContextSnapshot: snapshot, runtimeRevision: RUNTIME_REVISION, recoveryCodec: codec, send: async () => ({ state: "confirmed" }), runner: async () => ({ backendOutcome: "failure", transientResult: null }) });
	const accepted = await firstRouter.onDispatch("MESSAGE_CREATE", { id: "686868686868686861", guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }], content: `<@${BOT}> inspect recovery` }, 42);
	await firstRouter.waitForIdle();
	const admittedBinding = store.getJob(accepted.jobId, { includeEvents: false }).executionBinding;
	assert.equal(admittedBinding.configSchemaVersion, 2);
	assert.equal(admittedBinding.instance, "default");
	assert.equal(admittedBinding.agentId, "recovery-agent");
	assert.equal(admittedBinding.participantUserId, USER);
	assert.equal(admittedBinding.access, "read-only");
	assert.equal(admittedBinding.contextHash, snapshot.contextHash);
	const originalEnvelope = store.loadJobRecovery(accepted.jobId);
	const payload = JSON.parse(codec.open(originalEnvelope));
	assert.equal(payload.schemaVersion, 2);
	assert.equal(payload.contextHash, snapshot.contextHash);
	assert.equal(payload.currentRequest, "inspect recovery");
	assert.equal(payload.prompt, undefined);
	assert.equal(payload.runtimeRevision, RUNTIME_REVISION);
	const makeRecovered = (jobId, envelope) => {
		store.createJob({ jobId, backendId: "codex", activityDetail: "structured", jobType: "conversation", recoveryEnvelope: envelope });
		store.startAttempt(jobId, { attemptId: `${jobId}-attempt` });
		return store.recoverInterruptedWork().find((item) => item.jobId === jobId);
	};
	const tampered = { ...payload, contextHash: "f".repeat(64) };
	const mismatch = makeRecovered("v2-recovery-mismatch", codec.seal(JSON.stringify(tampered)));
	let mismatchCalls = 0;
	const mismatchRouter = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: snapshot.workspaceRoot, runtimeRoot: join(root, "runtime-mismatch"), agentContextSnapshot: snapshot, runtimeRevision: RUNTIME_REVISION, recoveryCodec: codec, send: async () => ({ state: "confirmed" }), runner: async () => { mismatchCalls += 1; return { backendOutcome: "failure", transientResult: null }; } });
	mismatchRouter.resumeRecovered([mismatch], { autoRetry: true });
	await mismatchRouter.waitForIdle();
	assert.equal(mismatchCalls, 0);
	assert.equal(store.getJob("v2-recovery-mismatch", { includeEvents: false }).lifecycle, "recovery_review");
	const disabledStart = makeRecovered("v2-recovery-binding-disabled", originalEnvelope);
	let disabledStartCalls = 0;
	const disabledStartConfig = { ...config, discord: { ...config.discord, bindings: [{ ...v2Binding, canStartConversation: false }] } };
	const disabledStartRouter = new DiscordMessageRouter({ config: disabledStartConfig, store, token: "token-value-long-enough", botUserId: BOT, cwd: snapshot.workspaceRoot, runtimeRoot: join(root, "runtime-binding-disabled"), agentContextSnapshot: snapshot, runtimeRevision: RUNTIME_REVISION, recoveryCodec: codec, send: async () => ({ state: "confirmed" }), runner: async () => { disabledStartCalls += 1; return { backendOutcome: "failure", transientResult: null }; } });
	disabledStartRouter.resumeRecovered([disabledStart], { autoRetry: true });
	await disabledStartRouter.waitForIdle();
	assert.equal(disabledStartCalls, 0);
	assert.equal(store.getJob("v2-recovery-binding-disabled", { includeEvents: false }).lifecycle, "recovery_review");
	const exact = makeRecovered("v2-recovery-exact", originalEnvelope);
	let exactCalls = 0;
	const exactRouter = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: snapshot.workspaceRoot, runtimeRoot: join(root, "runtime-exact"), agentContextSnapshot: snapshot, runtimeRevision: RUNTIME_REVISION, recoveryCodec: codec, send: async () => ({ state: "confirmed" }), runner: async (input) => { exactCalls += 1; assert.match(input.prompt, /User request:\ninspect recovery$/); return { backendOutcome: "failure", transientResult: null }; } });
	exactRouter.resumeRecovered([exact], { autoRetry: true });
	await exactRouter.waitForIdle();
	assert.equal(exactCalls, 1);
	store.close();
});

test("DSG-017 serializes jobs in one Discord scope even when global concurrency is larger", async () => {
	const { store, root } = fixture();
	let releaseFirst;
	const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
	const started = [];
	const config = { persona: { name: "Reviewer", instructions: "Review." }, role: { name: "reader", allowedActions: ["read", "reply"] }, backend: { selected: "codex" }, discord: { bindings: [binding()], operatorUserIds: [] }, runtime: { maxConcurrentJobs: 2 } };
	const router = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), send: async () => ({ state: "confirmed" }), runner: async ({ prompt }) => {
		started.push(prompt);
		if (started.length === 1) await firstBlocked;
		return { backendOutcome: "failure", transientResult: null };
	} });
	await router.onDispatch("MESSAGE_CREATE", { id: "212121212121212121", guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }], content: `<@${BOT}> first` }, 21);
	await router.onDispatch("MESSAGE_CREATE", { id: "222222222222222223", guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }], content: `<@${BOT}> second` }, 22);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(started.length, 1);
	releaseFirst();
	await router.waitForIdle();
	assert.equal(started.length, 2);
	store.close();
});

test("DSO-014 cancels queued work and persists its terminal lifecycle", async () => {
	const { store, root } = fixture();
	let releaseFirst;
	const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
	let calls = 0;
	const config = { persona: { name: "Reviewer", instructions: "Review." }, role: { name: "reader", allowedActions: ["read", "reply"] }, backend: { selected: "codex" }, discord: { bindings: [binding()], operatorUserIds: [] }, runtime: { maxConcurrentJobs: 1 } };
	const router = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), send: async () => ({ state: "confirmed" }), runner: async () => { calls += 1; if (calls === 1) await firstBlocked; return { backendOutcome: "failure" }; } });
	await router.onDispatch("MESSAGE_CREATE", { id: "252525252525252521", guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }], content: `<@${BOT}> first` }, 51);
	const queued = await router.onDispatch("MESSAGE_CREATE", { id: "252525252525252522", guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }], content: `<@${BOT}> second` }, 52);
	assert.deepEqual(router.cancelJob(queued.jobId), { state: "accepted", action: "cancel", jobId: queued.jobId, target: "queued" });
	assert.equal(store.getJob(queued.jobId).lifecycle, "cancelled");
	releaseFirst();
	await router.waitForIdle();
	assert.equal(calls, 1);
	store.close();
});

test("UCT_DSO_014_002 cancels active work and queues an explicit prompt-amended replacement", async () => {
	const { store, root } = fixture();
	const calls = [];
	const config = { persona: { name: "Reviewer", instructions: "Review." }, role: { name: "reader", allowedActions: ["read", "reply"] }, backend: { selected: "codex" }, discord: { bindings: [binding()], operatorUserIds: [] }, runtime: { maxConcurrentJobs: 1 } };
	const router = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), recoveryCodec: new RecoveryCodec(randomBytes(32)), send: async () => ({ state: "confirmed" }), runner: async ({ jobId, prompt, signal }) => {
		calls.push(prompt);
		if (calls.length === 1) await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { code: "ABORT_ERR" })), { once: true }));
		const attemptId = store.startAttempt(jobId, { attemptId: `replacement-${calls.length}` });
		store.recordEvent({ jobId, attemptId, source: "helper", kind: "failed", safePayload: { reasonCode: "process_exit" } });
		return { backendOutcome: "failure" };
	} });
	const accepted = await router.onDispatch("MESSAGE_CREATE", { id: "262626262626262626", guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }], content: `<@${BOT}> original request` }, 53);
	await new Promise((resolve) => setImmediate(resolve));
	const receipt = router.replaceJob(accepted.jobId, { action: "amend", amendment: "also run the focused test" });
	assert.equal(receipt.state, "accepted");
	assert.equal(receipt.semantics, "cancel_and_queue_replacement");
	await router.waitForIdle();
	assert.equal(store.getJob(accepted.jobId).lifecycle, "cancelled");
	assert.match(calls[1], /original request[\s\S]*Operator amendment:[\s\S]*also run the focused test/);
	assert.equal(store.getJob(receipt.replacementJobId).lifecycle, "failed");
	store.close();
});

test("UCT_DSO_015_002 restarts a failed terminal job from its encrypted recovery envelope", async () => {
	const { store, root } = fixture();
	mkdirSync(join(root, ".agents/context"), { recursive: true });
	writeFileSync(join(root, "AGENTS.md"), "# Restartable agent\n", "utf8");
	writeFileSync(join(root, ".agents/context/policy.yaml"), "authority: bounded\n", "utf8");
	const snapshot = buildAgentContextSnapshot({ workspace: root, agentId: "restartable-agent", entrypoint: "AGENTS.md", contextFiles: [".agents/context/policy.yaml"] });
	const participantProfile = { label: "workspace-owner", relationship: "workspace owner", allowedActions: ["read", "reply", "write", "execute"] };
	const config = { schemaVersion: 2, workspace: { agentId: "restartable-agent" }, persona: { name: "Restartable", instructions: "Finish bounded work." }, role: { name: "operator", allowedActions: ["read", "reply", "write", "execute"], requiresApproval: [] }, backend: { selected: "codex", profiles: { codex: { enabled: true } } }, discord: { bindings: [{ ...binding(), operatorActions: true, historyVisibility: "none" }], operatorUserIds: [USER], participantProfiles: { [USER]: participantProfile } }, runtime: { maxConcurrentJobs: 1, approvalPolicy: "never", permissionProfileEpoch: "restart-v1" }, recovery: { autoRetry: false } };
	const calls = [];
	const codec = new RecoveryCodec(randomBytes(32));
	const router = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: snapshot.workspaceRoot, runtimeRoot: join(root, "runtime"), agentContextSnapshot: snapshot, runtimeRevision: RUNTIME_REVISION, recoveryCodec: codec, send: async () => ({ state: "confirmed" }), runner: async ({ jobId, prompt }) => {
		calls.push(prompt);
		const attemptId = store.startAttempt(jobId, { attemptId: `failed-${calls.length}` });
		store.recordEvent({ jobId, attemptId, source: "helper", kind: "failed", safePayload: { reasonCode: "no_progress_timeout" } });
		return { backendOutcome: "failure" };
	} });
	const accepted = await router.onDispatch("MESSAGE_CREATE", { id: "272727272727272727", guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }], content: `<@${BOT}> continue the six remaining issues` }, 54);
	await router.waitForIdle();
	assert.ok(store.loadJobRecovery(accepted.jobId));
	const receipt = router.replaceJob(accepted.jobId);
	assert.equal(receipt.state, "accepted");
	assert.equal(receipt.semantics, "terminal_retry_from_encrypted_request");
	assert.equal(store.loadJobRecovery(accepted.jobId), null);
	await router.waitForIdle();
	assert.equal(calls.length, 2);
	assert.match(calls[1], /User request:\ncontinue the six remaining issues$/);
	assert.equal(store.getJob(receipt.replacementJobId).lifecycle, "failed");
	store.close();
});

test("DSG-018 injects recent context without generic progress spam", async () => {
	const { store, root, databasePath } = fixture();
	const sent = [];
	const calls = [];
	const config = { persona: { name: "Reviewer", instructions: "Review." }, role: { name: "reader", allowedActions: ["read", "reply"] }, backend: { selected: "codex" }, discord: { bindings: [binding()], operatorUserIds: [] }, runtime: { maxConcurrentJobs: 1 } };
	const router = new DiscordMessageRouter({
		config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), recoveryCodec: new RecoveryCodec(randomBytes(32)),
		loadHistory: async () => ({ state: "loaded", history: "user: 앞 요청\nassistant: 앞 답변", messageCount: 2 }),
		send: async (input) => { sent.push(input.content); return { state: "confirmed" }; },
		runner: async (input) => {
			calls.push(input);
			return { backendOutcome: "failure", transientResult: null };
		},
	});
	await router.onDispatch("MESSAGE_CREATE", { id: "232323232323232323", guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }], content: `<@${BOT}> 이어서 고쳐줘` }, 23);
	await router.waitForIdle();
	assert.match(calls[0].prompt, /user: 앞 요청/);
	assert.match(calls[0].prompt, /Reply in the language used by the user/);
	assert.match(calls[0].prompt, /User request:\n이어서 고쳐줘$/);
	assert.deepEqual(sent, ["[메시지 받음]"]);
	store.close();
	assert.equal(readFileSync(databasePath).includes(Buffer.from("앞 요청")), false);
});

test("DSG-019 reports a terminal backend failure to the originating Discord scope", async () => {
	const { store, root } = fixture();
	const sent = [];
	const config = { persona: { name: "Reviewer", instructions: "Review." }, role: { name: "reader", allowedActions: ["read", "reply"] }, backend: { selected: "codex" }, discord: { bindings: [binding()], operatorUserIds: [] }, runtime: { maxConcurrentJobs: 1 } };
	const router = new DiscordMessageRouter({
		config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"),
		send: async (input) => { sent.push(input.content); return { state: "confirmed" }; },
		runner: async ({ jobId }) => {
			const attemptId = store.startAttempt(jobId, { attemptId: "failed-attempt" });
			store.recordEvent({ jobId, attemptId, source: "helper", kind: "failed", safePayload: { reasonCode: "no_progress_timeout" } });
			return { backendOutcome: "failure", transientResult: null };
		},
	});
	const accepted = await router.onDispatch("MESSAGE_CREATE", { id: "242424242424242424", guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }], content: `<@${BOT}> diagnose` }, 24);
	await router.waitForIdle();
	assert.equal(sent.length, 2);
	assert.match(sent[1], /일정 시간 동안 진행이 없어/);
	assert.match(sent[1], new RegExp(accepted.jobId));
	store.close();
});

test("DSG-021 denies model-produced cross-scope outbound DM requests", async () => {
	const { store, root } = fixture();
	let dmInput = null;
	let deliveredContent = null;
	const config = { persona: { name: "Reviewer", instructions: "Review." }, role: { name: "reader", allowedActions: ["read", "reply"] }, backend: { selected: "codex" }, discord: { bindings: [binding(), { ...binding("dm"), operatorActions: true }], operatorUserIds: [] }, runtime: { maxConcurrentJobs: 1 } };
	const router = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), send: async () => ({ state: "confirmed" }), directMessage: async (input) => { dmInput = input; return { state: "confirmed", messageId: "777777777777777777" }; }, deliver: async (input) => { deliveredContent = input.content; return { state: "confirmed" }; }, runner: async () => ({ backendOutcome: "success", attemptId: "dm-attempt", transientResult: JSON.stringify({ discordDm: { content: "restart command", successReply: "DM을 보냈습니다.", failureReply: "DM 발송에 실패했습니다." } }) }) });
	await router.onDispatch("MESSAGE_CREATE", { id: "181818181818181818", guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }], content: `<@${BOT}> DM으로 보내줘` }, 16);
	await router.waitForIdle();
	assert.equal(dmInput, null);
	assert.equal(deliveredContent, "DM 발송에 실패했습니다.");
	store.close();
});
