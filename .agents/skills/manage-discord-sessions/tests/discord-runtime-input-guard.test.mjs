import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { buildAgentContextSnapshot } from "../helper/agent-context.mjs";
import { FileCredentialResolver, loadMessengerConfig } from "../helper/discord-config.mjs";
import { DiscordMessageRouter } from "../helper/discord-router.mjs";
import { messengerInstancePaths } from "../helper/instance-paths.mjs";
import { protectOwnerOnly } from "../helper/platform-security.mjs";
import { createRuntimeInputVerifier, handleJobControlRequest } from "../helper/service-runtime.mjs";
import { BOT, CHANNEL, GUILD, RUNTIME_REVISION, USER, binding, cleanupDiscordFixtureRoots, fixture } from "./fixtures/discord-fixture.mjs";

afterEach(cleanupDiscordFixtureRoots);

test("FET_DSO_014_003 dispatches only generation-bound job and operator submission controls", async () => {
	const calls = [];
	const router = {
		cancelJob: (jobId) => { calls.push(["cancel", jobId]); return { state: "accepted", action: "cancel", jobId }; },
		replaceJob: (jobId, options) => { calls.push([options.action, jobId, options.amendment]); return { state: "accepted", action: options.action, jobId, replacementJobId: "replacement" }; },
		submitOperatorRequest: async (input) => { calls.push(["submit", input.channelId, input.authorId, input.content]); return { state: "accepted", action: "submit", jobId: "submitted" }; },
	};
	const base = { schemaVersion: 1, requestId: "request-1", generation: "generation-1", jobId: "job-1" };
	assert.equal((await handleJobControlRequest(router, { ...base, action: "cancel" }, "generation-1")).state, "accepted");
	assert.equal((await handleJobControlRequest(router, { ...base, action: "restart" }, "generation-1")).replacementJobId, "replacement");
	assert.equal((await handleJobControlRequest(router, { ...base, action: "amend", amendment: "focused follow-up" }, "generation-1")).replacementJobId, "replacement");
	assert.equal((await handleJobControlRequest(router, { schemaVersion: 1, requestId: "request-2", generation: "generation-1", action: "submit", channelId: CHANNEL, authorId: USER, content: "resume work" }, "generation-1")).jobId, "submitted");
	assert.equal((await handleJobControlRequest(router, { ...base, action: "cancel", generation: "stale" }, "generation-1")).reasonCode, "invalid_control_request");
	assert.deepEqual(calls, [["cancel", "job-1"], ["restart", "job-1", undefined], ["amend", "job-1", "focused follow-up"], ["submit", CHANNEL, USER, "resume work"]]);
});

function v2Config(root) {
	const participant = { label: "workspace-owner", relationship: "workspace owner", allowedActions: ["read", "reply", "write", "execute"] };
	return {
		schemaVersion: 2,
		enabled: true,
		workspaceId: "runtime-input-guard",
		workspace: { path: ".", agentId: "runtime-input-agent", entrypoint: "AGENTS.md", contextFiles: [".agents/context/policy.yaml"] },
		persona: { name: "Runtime input agent", instructions: "Use only current authority." },
		role: { name: "project-agent", allowedActions: ["read", "reply", "write", "execute"], requiresApproval: [] },
		backend: { selected: "codex", profiles: { codex: { enabled: true } } },
		discord: { credentialRef: "discord-token", botUserId: BOT, operatorUserIds: [USER], bindings: [{ ...binding(), operatorActions: true, historyVisibility: "requester_only" }], participantProfiles: { [USER]: participant } },
		runtime: { heartbeatSeconds: 10, softSilenceSeconds: 120, noProgressInterventionSeconds: 120, maxConcurrentJobs: 1, approvalPolicy: "never", permissionProfileEpoch: "guard-v1" },
		observability: { discordStatusProjection: false },
		service: { autoStart: false, startAt: "login" },
		recovery: { autoRetry: false },
	};
}

function writePrivate(path, value) {
	writeFileSync(path, value, { mode: 0o600 });
	protectOwnerOnly(path, "file", "runtime input fixture");
}

test("DSO-010 live config and credential revocation fail closed without waiting for restart", () => {
	const { root, store } = fixture();
	store.close();
	const paths = messengerInstancePaths(root);
	mkdirSync(join(root, ".agents/context"), { recursive: true, mode: 0o700 });
	mkdirSync(dirname(paths.configPath), { recursive: true, mode: 0o700 });
	mkdirSync(paths.credentialsDirectory, { recursive: true, mode: 0o700 });
	writeFileSync(join(root, "AGENTS.md"), "# Runtime input agent\n", "utf8");
	writeFileSync(join(root, ".agents/context/policy.yaml"), "authority: current\n", "utf8");
	const original = v2Config(root);
	writePrivate(paths.configPath, JSON.stringify(original));
	writePrivate(join(paths.credentialsDirectory, "discord-token"), "runtime-input-token-original");
	const config = loadMessengerConfig(paths.configPath);
	const token = new FileCredentialResolver(paths.credentialsDirectory).resolve(config.discord.credentialRef);
	const snapshot = buildAgentContextSnapshot({ workspace: root, agentId: config.workspace.agentId, entrypoint: config.workspace.entrypoint, contextFiles: config.workspace.contextFiles });
	const verify = createRuntimeInputVerifier({ root, paths, config, token, agentContext: { cwd: snapshot.workspaceRoot, snapshot } });
	assert.match(verify(), /^[a-f0-9]{64}$/);
	const revoked = structuredClone(original);
	revoked.discord.participantProfiles[USER].allowedActions = ["read", "reply"];
	writePrivate(paths.configPath, JSON.stringify(revoked));
	assert.throws(verify, (error) => error?.code === "context_changed_restart_required");
	writePrivate(paths.configPath, JSON.stringify(original));
	assert.throws(verify, (error) => error?.code === "context_changed_restart_required");
	const restoredConfig = loadMessengerConfig(paths.configPath);
	const restoredToken = new FileCredentialResolver(paths.credentialsDirectory).resolve(restoredConfig.discord.credentialRef);
	const verifyCredential = createRuntimeInputVerifier({ root, paths, config: restoredConfig, token: restoredToken, agentContext: { cwd: snapshot.workspaceRoot, snapshot } });
	assert.match(verifyCredential(), /^[a-f0-9]{64}$/);
	writePrivate(join(paths.credentialsDirectory, "discord-token"), "runtime-input-token-rotated");
	assert.throws(verifyCredential, (error) => error?.code === "context_changed_restart_required");
});

test("DSO-010 queued work revalidates authority before runner and immediately before spawn", async () => {
	const { root, store } = fixture();
	mkdirSync(join(root, ".agents/context"), { recursive: true });
	writeFileSync(join(root, "AGENTS.md"), "# Runtime input agent\n", "utf8");
	writeFileSync(join(root, ".agents/context/policy.yaml"), "authority: current\n", "utf8");
	const config = v2Config(root);
	const snapshot = buildAgentContextSnapshot({ workspace: root, agentId: config.workspace.agentId, entrypoint: config.workspace.entrypoint, contextFiles: config.workspace.contextFiles });
	let current = true;
	let releaseFirst;
	const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
	let calls = 0;
	const router = new DiscordMessageRouter({
		config, store, token: "runtime-input-token-original", botUserId: BOT, cwd: snapshot.workspaceRoot, runtimeRoot: join(root, "runtime"), agentContextSnapshot: snapshot, runtimeRevision: RUNTIME_REVISION,
		verifyRuntimeInputs: () => { if (!current) throw new Error("revoked"); },
		send: async () => ({ state: "confirmed" }),
		runner: async ({ preSpawnCheck }) => {
			preSpawnCheck();
			calls += 1;
			if (calls === 1) await firstBlocked;
			return { backendOutcome: "failure", transientResult: null };
		},
	});
	const message = (id, content) => ({ id, guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }], content: `<@${BOT}> ${content}` });
	assert.equal((await router.onDispatch("MESSAGE_CREATE", message("717171717171717171", "first"), 1)).state, "accepted");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal((await router.onDispatch("MESSAGE_CREATE", message("727272727272727272", "second"), 2)).state, "accepted");
	current = false;
	releaseFirst();
	await router.waitForIdle();
	assert.equal(calls, 1);
	await assert.rejects(router.onDispatch("MESSAGE_CREATE", message("737373737373737373", "third"), 3), (error) => error?.code === "context_changed_restart_required");
	assert.equal(store.listJobs().length, 2);
	assert.equal(store.listJobs().some((job) => job.latestSafeError?.includes("context_changed_restart_required")), true);
	store.close();
});
