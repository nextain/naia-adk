import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { DiscordGatewaySession, MemoryGatewayState } from "../helper/discord-gateway.mjs";
import { buildAgentContextSnapshot } from "../helper/agent-context.mjs";
import { FileCredentialResolver, loadMessengerConfig } from "../helper/discord-config.mjs";
import { DiscordMessageRouter } from "../helper/discord-router.mjs";
import { configuredAgentContexts, createRuntimeInputVerifier } from "../helper/service-runtime.mjs";
import { messengerInstancePaths } from "../helper/instance-paths.mjs";
import { protectOwnerOnly } from "../helper/platform-security.mjs";
import { BOT, CHANNEL, GUILD, RUNTIME_REVISION, USER, cleanupDiscordFixtureRoots, fixture } from "./fixtures/discord-fixture.mjs";

afterEach(cleanupDiscordFixtureRoots);

class FakeSocket {
	constructor() { this.listeners = new Map(); this.sent = []; this.closed = []; }
	addEventListener(type, callback) { this.listeners.set(type, callback); }
	send(value) { this.sent.push(JSON.parse(value)); }
	close(code) { this.closed.push(code); this.listeners.get("close")?.({ code }); }
	emit(type, value) { this.listeners.get(type)?.(value); }
}

function context(root, name) {
	const workspace = join(root, name);
	mkdirSync(join(workspace, ".agents"), { recursive: true });
	writeFileSync(join(workspace, "AGENTS.md"), `# ${name}\n`, "utf8");
	writeFileSync(join(workspace, ".agents/policy.yaml"), `workspace: ${name}\nauthority: current\n`, "utf8");
	const snapshot = buildAgentContextSnapshot({ workspace, agentId: `${name}-agent`, entrypoint: "AGENTS.md", contextFiles: [".agents/policy.yaml"] });
	return { cwd: workspace, allowedPaths: [workspace], snapshot };
}

function routingConfig(profiles) {
	return {
		schemaVersion: 2,
		agentProfiles: {
			corp: { workspace: { agentId: "corp-agent", allowedPaths: [profiles.corp.cwd] }, persona: { name: "Corp agent", instructions: "Handle the configured company workspace." } },
			personal: { workspace: { agentId: "personal-agent", allowedPaths: [profiles.personal.cwd] }, persona: { name: "Personal agent", instructions: "Handle the configured personal workspace." } },
		},
		persona: { name: "fallback", instructions: "unused" },
		role: { name: "operator", allowedActions: ["read", "reply", "write", "execute"], requiresApproval: [] },
		backend: { selected: "codex", profiles: { codex: { enabled: true } } },
		discord: {
			bindings: [
				{ kind: "guild_channel", guildId: GUILD, channelId: CHANNEL, allowedUserIds: [USER], respondWhen: "mentioned", canStartConversation: true, operatorActions: true, historyVisibility: "none", agentProfileId: "corp" },
				{ kind: "dm", userId: USER, allowedUserIds: [USER], respondWhen: "always", canStartConversation: true, operatorActions: true, historyVisibility: "none", agentProfileId: "personal" },
			],
			operatorUserIds: [USER],
			participantProfiles: { [USER]: { label: "workspace-owner", relationship: "workspace owner", allowedActions: ["read", "reply", "write", "execute"] } },
		},
		runtime: { maxConcurrentJobs: 2, approvalPolicy: "never", permissionProfileEpoch: "bc4-gateway-test" },
		recovery: { autoRetry: false },
	};
}

function messageFor(profile, id) {
	if (profile === "corp") return { id, guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }], content: `<@${BOT}> company request` };
	return { id, channel_id: "777777777777777777", author: { id: USER }, mentions: [], content: "personal request" };
}

async function gatewayWithRouter(router) {
	const socket = new FakeSocket();
	const disconnects = [];
	const state = new MemoryGatewayState();
	const session = new DiscordGatewaySession({
		token: "token-value-long-enough",
		expectedBotUserId: BOT,
		stateRepository: state,
		onDispatch: (...args) => router.onDispatch(...args),
		onDisconnect: (event) => disconnects.push(event),
		webSocketFactory: () => socket,
		setTimeoutImpl: () => ({ unref() {} }),
		setIntervalImpl: () => ({ unref() {} }),
		clearTimeoutImpl: () => {},
		clearIntervalImpl: () => {},
		random: () => 0,
	});
	session.connect();
	socket.emit("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 10_000 } }) });
	await session.drain();
	return { session, socket, state, disconnects };
}

async function dispatch(session, socket, sequence, message) {
	socket.emit("message", { data: JSON.stringify({ op: 0, s: sequence, t: "MESSAGE_CREATE", d: message }) });
	await session.drain();
}

function routerFor({ root, store, profiles, verifyRuntimeInputs, calls, sent, reserveIngressStore = store }) {
	const config = routingConfig(profiles);
	const router = new DiscordMessageRouter({
		config,
		store: reserveIngressStore,
		token: "token-value-long-enough",
		botUserId: BOT,
		cwd: profiles.corp.cwd,
		allowedPaths: profiles.corp.allowedPaths,
		agentContextSnapshot: profiles.corp.snapshot,
		agentContexts: profiles,
		runtimeRoot: join(root, "runtime"),
		runtimeRevision: RUNTIME_REVISION,
		verifyRuntimeInputs,
		send: async (input) => { sent.push(input); return { state: "confirmed" }; },
		deliver: async () => ({ state: "confirmed" }),
		directMessage: async () => ({ state: "failed" }),
		runner: async (input) => {
		input.preSpawnCheck?.();
		calls.push(input);
		return { backendOutcome: "success", attemptId: "attempt-bc4", transientResult: "done" };
		},
	});
	return { router, config };
}

test("BC4 replayed ingress does not repeat a queue-full or empty-request notice", async () => {
	// A Gateway RESUME can replay a MESSAGE_CREATE the process already judged
	// but had not yet committed a sequence for. The reservation is idempotent,
	// so the notice has to be too.
	const { root, store } = fixture();
	const profiles = { corp: context(root, "corp"), personal: context(root, "personal") };
	const calls = [];
	const sent = [];
	const { router } = routerFor({ root, store, profiles, verifyRuntimeInputs: () => "a".repeat(64), calls, sent });
	const { session, socket, disconnects } = await gatewayWithRouter(router);
	try {
		// Saturate the queue so the next request is refused for capacity.
		for (let index = 0; index < 40; index += 1) router.queue.push({ jobId: `filler-${index}`, scopeKey: null, backendId: "codex" });
		const full = messageFor("corp", "666666666666666671");
		await dispatch(session, socket, 1, full);
		await dispatch(session, socket, 2, full);
		const queueNotices = sent.filter((input) => input.content.includes("요청이 많아"));
		assert.equal(queueNotices.length, 1, "a replayed queue-full message must not notify twice");
		router.queue.length = 0;

		// A mention-only message carries no actionable request; the replay of the
		// same message must stay silent as well.
		const empty = { ...messageFor("corp", "666666666666666672"), content: `<@${BOT}>` };
		await dispatch(session, socket, 3, empty);
		await dispatch(session, socket, 4, empty);
		const emptyNotices = sent.filter((input) => input.content.includes("처리할 요청을 찾지 못했습니다"));
		assert.equal(emptyNotices.length, 1, "a replayed empty message must not notify twice");
		assert.equal(calls.length, 0);
		assert.deepEqual(socket.closed, []);
		assert.deepEqual(disconnects, []);
	} finally {
		await router.shutdown();
		store.close();
	}
});

test("BC4 rejects invalid corp ingress, commits its sequence, deduplicates it, and keeps personal healthy", async () => {
	const { root, store } = fixture();
	const profiles = { corp: context(root, "corp"), personal: context(root, "personal") };
	const calls = [];
	const sent = [];
	const verifyCalls = [];
	const verifyRuntimeInputs = ({ agentContextId }) => {
		verifyCalls.push(agentContextId);
		if (agentContextId === "corp") throw Object.assign(new Error("changed corp policy"), { code: "context_changed_restart_required" });
		return "b".repeat(64);
	};
	const { router } = routerFor({ root, store, profiles, verifyRuntimeInputs, calls, sent });
	const gateway = await gatewayWithRouter(router);
	try {
		await dispatch(gateway.session, gateway.socket, 1, messageFor("corp", "666666666666666661"));
		await dispatch(gateway.session, gateway.socket, 2, messageFor("corp", "666666666666666661"));
		await dispatch(gateway.session, gateway.socket, 3, messageFor("personal", "666666666666666662"));
		await router.waitForIdle();
		assert.equal(gateway.state.load().sequence, 3);
		assert.deepEqual(gateway.socket.closed, []);
		assert.deepEqual(gateway.disconnects, []);
		assert.deepEqual(calls.map((call) => call.cwd), [profiles.personal.cwd]);
		assert.deepEqual(verifyCalls.slice(0, 2), ["corp", "corp"]);
		assert.ok(verifyCalls.slice(2).every((agentContextId) => agentContextId === "personal"));
		assert.equal(sent.filter((input) => input.content.includes("Runtime policy changed")).length, 1);
		assert.equal(store.listJobs().length, 1);
	} finally {
		gateway.session.close();
		store.close();
	}
});

test("BC4 global invalidation rejects every profile without Gateway 4002 and deduplicates source IDs", async () => {
	const { root, store } = fixture();
	const profiles = { corp: context(root, "corp-global"), personal: context(root, "personal-global") };
	const calls = [];
	const sent = [];
	const verifyRuntimeInputs = () => { throw Object.assign(new Error("changed global policy"), { code: "context_changed_restart_required" }); };
	const { router } = routerFor({ root, store, profiles, verifyRuntimeInputs, calls, sent });
	const gateway = await gatewayWithRouter(router);
	try {
		await dispatch(gateway.session, gateway.socket, 1, messageFor("corp", "666666666666666671"));
		await dispatch(gateway.session, gateway.socket, 2, messageFor("corp", "666666666666666671"));
		await dispatch(gateway.session, gateway.socket, 3, messageFor("personal", "666666666666666672"));
		await router.waitForIdle();
		assert.equal(gateway.state.load().sequence, 3);
		assert.deepEqual(gateway.socket.closed, []);
		assert.deepEqual(gateway.disconnects, []);
		assert.equal(calls.length, 0);
		assert.equal(store.listJobs().length, 0);
		assert.equal(sent.filter((input) => input.content.includes("Runtime policy changed")).length, 2);
	} finally {
		gateway.session.close();
		store.close();
	}
});

test("BC4 normalizes a code-less runtime verifier failure without closing Gateway", async () => {
	const { root, store } = fixture();
	const profiles = { corp: context(root, "corp-no-code"), personal: context(root, "personal-no-code") };
	const calls = [];
	const sent = [];
	const { router } = routerFor({ root, store, profiles, verifyRuntimeInputs: () => { throw new Error("changed global policy"); }, calls, sent });
	const gateway = await gatewayWithRouter(router);
	try {
		await dispatch(gateway.session, gateway.socket, 1, messageFor("corp", "666666666666666673"));
		await dispatch(gateway.session, gateway.socket, 2, messageFor("corp", "666666666666666673"));
		await router.waitForIdle();
		assert.equal(gateway.state.load().sequence, 2);
		assert.deepEqual(gateway.socket.closed, []);
		assert.deepEqual(gateway.disconnects, []);
		assert.equal(calls.length, 0);
		assert.equal(sent.filter((input) => input.content.includes("Runtime policy changed")).length, 1);
		assert.equal(store.listJobs().length, 0);
	} finally {
		gateway.session.close();
		store.close();
	}
});

test("BC4 verifier invalidates only changed profile, then all profiles after global change, and accepts a reviewed restart", () => {
	const { root, store } = fixture();
	store.close();
	const profiles = { corp: context(root, "corp-digest"), personal: context(root, "personal-digest") };
	const paths = messengerInstancePaths(root);
	const configDirectory = dirname(paths.configPath);
	mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
	mkdirSync(paths.credentialsDirectory, { recursive: true, mode: 0o700 });
	const config = {
		schemaVersion: 2,
		enabled: true,
		workspaceId: "bc4-digest",
		agentProfiles: {
			corp: { workspace: { path: profiles.corp.cwd, agentId: "corp-agent", entrypoint: "AGENTS.md", contextFiles: [".agents/policy.yaml"], allowedPaths: [profiles.corp.cwd] }, persona: { name: "Corp", instructions: "Handle corp." } },
			personal: { workspace: { path: profiles.personal.cwd, agentId: "personal-agent", entrypoint: "AGENTS.md", contextFiles: [".agents/policy.yaml"], allowedPaths: [profiles.personal.cwd] }, persona: { name: "Personal", instructions: "Handle personal." } },
		},
		persona: { name: "Fallback", instructions: "Use the selected profile." },
		role: { name: "operator", allowedActions: ["read", "reply", "write", "execute"], requiresApproval: [] },
		backend: { selected: "codex", profiles: { codex: { enabled: true } } },
		discord: {
			credentialRef: "discord-token",
			botUserId: BOT,
			operatorUserIds: [USER],
			bindings: [
				{ kind: "guild_channel", guildId: GUILD, channelId: CHANNEL, allowedUserIds: [USER], respondWhen: "mentioned", canStartConversation: true, operatorActions: true, historyVisibility: "none", agentProfileId: "corp" },
				{ kind: "dm", userId: USER, allowedUserIds: [USER], respondWhen: "always", canStartConversation: true, operatorActions: true, historyVisibility: "none", agentProfileId: "personal" },
			],
			participantProfiles: { [USER]: { label: "workspace-owner", relationship: "workspace owner", allowedActions: ["read", "reply", "write", "execute"] } },
		},
		runtime: { maxConcurrentJobs: 1, heartbeatSeconds: 10, softSilenceSeconds: 120, noProgressInterventionSeconds: 120, operatorResponseSeconds: 30, approvalPolicy: "never", permissionProfileEpoch: "bc4-digest" },
		observability: { discordStatusProjection: false },
		service: { autoStart: false, startAt: "login" },
		recovery: { autoRetry: false },
	};
	const writePrivate = (path, value) => {
		writeFileSync(path, value, { mode: 0o600 });
		protectOwnerOnly(path, "file", "BC4 digest fixture");
	};
	writePrivate(paths.configPath, JSON.stringify(config));
	writePrivate(join(paths.credentialsDirectory, "discord-token"), "token-value-long-enough");
	protectOwnerOnly(configDirectory, "directory", "BC4 config fixture");
	protectOwnerOnly(paths.credentialsDirectory, "directory", "BC4 credential fixture");
	const loaded = loadMessengerConfig(paths.configPath);
	const token = new FileCredentialResolver(paths.credentialsDirectory).resolve(loaded.discord.credentialRef);
	const contexts = configuredAgentContexts(root, loaded);
	const verify = createRuntimeInputVerifier({ root, paths, config: loaded, token, agentContexts: contexts });
	assert.match(verify({ agentContextId: "corp" }), /^[a-f0-9]{64}$/);
	assert.match(verify({ agentContextId: "personal" }), /^[a-f0-9]{64}$/);
	writeFileSync(join(profiles.corp.cwd, ".agents/policy.yaml"), "workspace: corp-digest\nauthority: changed\n", "utf8");
	assert.throws(() => verify({ agentContextId: "corp" }), (error) => error?.code === "context_changed_restart_required");
	assert.match(verify({ agentContextId: "personal" }), /^[a-f0-9]{64}$/);
	assert.throws(() => verify({ agentContextId: "corp" }), (error) => error?.code === "context_changed_restart_required");
	const globallyChanged = structuredClone(config);
	globallyChanged.runtime.maxConcurrentJobs = 2;
	writePrivate(paths.configPath, JSON.stringify(globallyChanged));
	assert.throws(() => verify({ agentContextId: "personal" }), (error) => error?.code === "context_changed_restart_required");
	assert.throws(() => verify({ agentContextId: "corp" }), (error) => error?.code === "context_changed_restart_required");
	const reviewedConfig = loadMessengerConfig(paths.configPath);
	const reviewedContexts = configuredAgentContexts(root, reviewedConfig);
	const restarted = createRuntimeInputVerifier({ root, paths, config: reviewedConfig, token, agentContexts: reviewedContexts });
	assert.match(restarted({ agentContextId: "corp" }), /^[a-f0-9]{64}$/);
	assert.match(restarted({ agentContextId: "personal" }), /^[a-f0-9]{64}$/);
});

test("BC4 keeps unknown ingress storage errors visible and Gateway converts them to 4002", async () => {
	const { root, store } = fixture();
	const profiles = { corp: context(root, "corp-store"), personal: context(root, "personal-store") };
	const failure = new Error("store offline");
	const throwingStore = {
		reserveIngress() { throw failure; },
	};
	const { router } = routerFor({ root, store, profiles, verifyRuntimeInputs: () => { throw Object.assign(new Error("changed"), { code: "context_changed_restart_required" }); }, calls: [], sent: [], reserveIngressStore: throwingStore });
	await assert.rejects(router.onDispatch("MESSAGE_CREATE", messageFor("corp", "666666666666666681"), 1), (error) => error === failure);
	store.close();

	const { root: gatewayRoot, store: gatewayStore } = fixture();
	const gatewayProfiles = { corp: context(gatewayRoot, "corp-store-gateway"), personal: context(gatewayRoot, "personal-store-gateway") };
	const gatewayRouter = routerFor({ root: gatewayRoot, store: gatewayStore, profiles: gatewayProfiles, verifyRuntimeInputs: () => { throw Object.assign(new Error("changed"), { code: "context_changed_restart_required" }); }, calls: [], sent: [], reserveIngressStore: { reserveIngress() { throw failure; } } }).router;
	const gateway = await gatewayWithRouter(gatewayRouter);
	try {
		await dispatch(gateway.session, gateway.socket, 1, messageFor("corp", "666666666666666682"));
		assert.deepEqual(gateway.socket.closed, [4_002]);
		assert.deepEqual(gateway.disconnects.map((event) => event.code), [4_002]);
	} finally {
		gateway.session.close();
		gatewayStore.close();
	}
});
