import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { DiscordGatewaySession, MemoryGatewayState, StoredGatewayState } from "../helper/discord-gateway.mjs";
import { SessionStore } from "../helper/store.mjs";
import { EventEmitter } from "node:events";
import { cleanupDiscordServiceResources, runDiscordService } from "../helper/service.mjs";
import { protectOwnerOnly } from "../helper/platform-security.mjs";
import { acquireDiscordTokenOwnerLock, discordTokenFingerprint } from "../helper/token-owner-lock.mjs";
import { BOT, CHANNEL, GUILD, OTHER_USER, USER, binding, cleanupDiscordFixtureRoots, fixture, roots } from "./fixtures/discord-fixture.mjs";

afterEach(cleanupDiscordFixtureRoots);

class FakeSocket {
	constructor() { this.listeners = new Map(); this.sent = []; this.closed = []; }
	addEventListener(type, callback) { this.listeners.set(type, callback); }
	send(value) { this.sent.push(JSON.parse(value)); }
	close(code) { this.closed.push(code); this.listeners.get("close")?.({ code }); }
	emit(type, value) { this.listeners.get(type)?.(value); }
}

test("DSO-011 cleanup releases token ownership and closes the ledger despite earlier cleanup faults", async () => {
	const calls = [];
	await assert.rejects(cleanupDiscordServiceResources({
		gateway: { async drain() { calls.push("gateway"); throw new Error("drain failed"); } },
		router: { async shutdown() { calls.push("router"); throw new Error("router failed"); } },
		store: {
			heartbeatService(input) { calls.push(`heartbeat:${input.status}`); },
			close() { calls.push("store"); },
		},
		tokenOwnerLock: { release() { calls.push("lock"); } },
		generation: "cleanup-generation",
	}), /router failed/);
	assert.deepEqual(calls, ["router", "gateway", "heartbeat:stopped", "store", "lock"]);
});

test("DSG-008 service shutdown does not wait for a stuck native WebSocket close", async () => {
	const { root, store: fixtureStore } = fixture();
	fixtureStore.close();
	const settings = join(root, "naia-settings");
	const configDirectory = join(settings, "messenger-sessions");
	const credentialDirectory = join(settings, ".keys/messenger-sessions");
	mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
	mkdirSync(credentialDirectory, { recursive: true, mode: 0o700 });
	const config = {
		schemaVersion: 1,
		enabled: true,
		workspaceId: "shutdown-test",
		persona: { name: "Reviewer", instructions: "Review safely." },
		role: { name: "read-only", allowedActions: ["read", "reply"], requiresApproval: [] },
		backend: { selected: "codex", profiles: { codex: { enabled: true }, claude: { enabled: true } } },
		discord: {
			credentialRef: "discord-token",
			botUserId: BOT,
			operatorUserIds: [USER],
			bindings: [binding()],
		},
		runtime: { heartbeatSeconds: 10, softSilenceSeconds: 120, maxConcurrentJobs: 1, approvalPolicy: "never" },
		observability: { discordStatusProjection: false },
		service: { autoStart: false, startAt: "login" },
		recovery: { autoRetry: false },
	};
	writeFileSync(join(configDirectory, "config.json"), JSON.stringify(config), { mode: 0o600 });
	writeFileSync(join(credentialDirectory, "discord-token"), "token-value-long-enough\n", { mode: 0o600 });
	protectOwnerOnly(configDirectory, "directory", "test config directory");
	protectOwnerOnly(join(configDirectory, "config.json"), "file", "test config");
	protectOwnerOnly(credentialDirectory, "directory", "test credential directory");
	protectOwnerOnly(join(credentialDirectory, "discord-token"), "file", "test credential");
	const socket = new FakeSocket();
	socket.close = (code) => { socket.closed.push(code); };
	const signals = new EventEmitter();
	let releasePost;
	let markPostStarted;
	const postStarted = new Promise((resolve) => { markPostStarted = resolve; });
	const fetchImpl = async (_url, init) => {
		const request = JSON.parse(init.body);
		markPostStarted();
		await new Promise((resolve) => { releasePost = resolve; });
		return {
			ok: true,
			status: 200,
			json: async () => ({ id: "999999999999999999", channel_id: CHANNEL, author: { id: BOT }, nonce: request.nonce }),
		};
	};
	const running = runDiscordService({ adkRoot: root, webSocketFactory: () => socket, fetchImpl, signalSource: signals });
	await new Promise((resolve) => setImmediate(resolve));
	socket.emit("message", { data: JSON.stringify({ op: 0, s: 7, t: "MESSAGE_CREATE", d: { id: "666666666666666666", guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }], content: `<@${BOT}> !naia status` } }) });
	await postStarted;
	signals.emit("SIGTERM");
	let settled = false;
	void running.then(() => { settled = true; });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(settled, false);
	releasePost();
	await Promise.race([
		running,
		new Promise((_, reject) => setTimeout(() => reject(new Error("service shutdown timed out")), 500)),
	]);
	assert.deepEqual(socket.closed, [1_000]);
	const stopped = new SessionStore(join(settings, ".sessions/messenger-sessions/runtime.sqlite3"));
	assert.equal(stopped.status().service.state, "stopped");
	assert.equal(stopped.loadGatewayState().sequence, 7);
	stopped.close();
});

test("DSO-011 managed marker never bypasses the shared direct-launch token owner lock", async () => {
	const root = mkdtempSync(join(tmpdir(), "naia-managed-owner-lock-"));
	roots.push(root);
	const configDirectory = join(root, "naia-settings/messenger-sessions");
	const credentialDirectory = join(root, "naia-settings/.keys/messenger-sessions");
	const lockDirectory = join(root, "shared-token-locks");
	mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
	mkdirSync(credentialDirectory, { recursive: true, mode: 0o700 });
	const token = "fake-shared-managed-direct-token-value";
	const config = {
		schemaVersion: 1, enabled: true, workspaceId: "lock-test",
		persona: { name: "Reviewer", instructions: "Review safely." },
		role: { name: "read-only", allowedActions: ["read", "reply"], requiresApproval: [] },
		backend: { selected: "codex", profiles: { codex: { enabled: true }, claude: { enabled: false } } },
		discord: { credentialRef: "discord-token", botUserId: BOT, operatorUserIds: [USER], bindings: [binding()] },
		runtime: { heartbeatSeconds: 10, softSilenceSeconds: 120, maxConcurrentJobs: 1, approvalPolicy: "never" },
		observability: { discordStatusProjection: false }, service: { autoStart: false, startAt: "login" }, recovery: { autoRetry: false },
	};
	writeFileSync(join(configDirectory, "config.json"), JSON.stringify(config), { mode: 0o600 });
	writeFileSync(join(credentialDirectory, "discord-token"), token, { mode: 0o600 });
	protectOwnerOnly(configDirectory, "directory", "test config directory");
	protectOwnerOnly(credentialDirectory, "directory", "test credential directory");
	const owner = acquireDiscordTokenOwnerLock({ token, lockDirectory });
	const previous = process.env.NAIA_DISCORD_KERNEL_TOKEN_FINGERPRINT;
	process.env.NAIA_DISCORD_KERNEL_TOKEN_FINGERPRINT = discordTokenFingerprint(token);
	try {
		await assert.rejects(runDiscordService({ adkRoot: root, tokenLockDirectory: lockDirectory, webSocketFactory: () => assert.fail("Gateway must not start") }), /already owned/);
	} finally {
		if (previous === undefined) delete process.env.NAIA_DISCORD_KERNEL_TOKEN_FINGERPRINT;
		else process.env.NAIA_DISCORD_KERNEL_TOKEN_FINGERPRINT = previous;
		owner.release();
	}
});

test("DSG-004 persists sequence only after durable dispatch and resumes through the store adapter", async () => {
	const { store } = fixture();
	const socket = new FakeSocket();
	let release;
	const blocked = new Promise((resolve) => { release = resolve; });
	const session = new DiscordGatewaySession({
		token: "token-value-long-enough",
		stateRepository: new StoredGatewayState(store),
		onDispatch: async () => blocked,
		webSocketFactory: () => socket,
		setIntervalImpl: () => ({ unref() {} }),
		clearIntervalImpl: () => {},
	});
	session.connect();
	socket.emit("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 10_000 } }) });
	await session.dispatchChain;
	assert.equal(socket.sent.some((item) => item.op === 2), true);
	assert.equal(socket.sent.find((item) => item.op === 2).d.intents, 1 | 512 | 4_096);
	const messageContentSocket = new FakeSocket();
	const messageContent = new DiscordGatewaySession({ token: "token-value-long-enough", stateRepository: new MemoryGatewayState(), onDispatch: async () => {}, messageContentIntent: true, webSocketFactory: () => messageContentSocket, setIntervalImpl: () => ({ unref() {} }), clearIntervalImpl: () => {} });
	messageContent.connect();
	messageContentSocket.emit("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 10_000 } }) });
	await messageContent.dispatchChain;
	assert.equal(messageContentSocket.sent.find((item) => item.op === 2).d.intents, 1 | 512 | 4_096 | 32_768);
	messageContent.close();
	socket.emit("message", { data: JSON.stringify({ op: 0, s: 7, t: "MESSAGE_CREATE", d: {} }) });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(store.loadGatewayState().sequence ?? null, null);
	release();
	await session.dispatchChain;
	assert.equal(store.loadGatewayState().sequence, 7);
	session.close();
	store.close();
});

test("DSG-005 closes on a missed heartbeat ACK and rejects unsafe resume hosts", async () => {
	const socket = new FakeSocket();
	const state = new MemoryGatewayState();
	const callbacks = [];
	const session = new DiscordGatewaySession({ token: "token-value-long-enough", stateRepository: state, onDispatch: async () => {}, onDisconnect: (event) => callbacks.push(event), webSocketFactory: () => socket, setTimeoutImpl: (fn) => { fn(); return { unref() {} }; }, clearTimeoutImpl: () => {}, setIntervalImpl: (fn) => { fn(); return { unref() {} }; }, clearIntervalImpl: () => {}, random: () => 0 });
	session.connect();
	socket.emit("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 10_000 } }) });
	await session.dispatchChain;
	assert.equal(socket.closed.includes(4_000), true);
	assert.equal(callbacks.length, 1);
	const unsafe = new DiscordGatewaySession({ token: "token-value-long-enough", stateRepository: new MemoryGatewayState({ resumeUrl: "wss://evil.example" }), onDispatch: async () => {}, webSocketFactory: () => new FakeSocket() });
	assert.throws(() => unsafe.connect(), /unsafe Discord Gateway URL/);
});

test("DSO-011 rejects a READY identity that differs from the configured bot", async () => {
	const socket = new FakeSocket();
	const dispatched = [];
	const session = new DiscordGatewaySession({ token: "token-value-long-enough", expectedBotUserId: BOT, stateRepository: new MemoryGatewayState(), onDispatch: async (...args) => dispatched.push(args), webSocketFactory: () => socket });
	session.connect();
	socket.emit("message", { data: JSON.stringify({ op: 0, s: 1, t: "READY", d: { user: { id: OTHER_USER }, session_id: "session", resume_gateway_url: "wss://gateway.discord.gg" } }) });
	await session.dispatchChain;
	assert.deepEqual(socket.closed, [4_004]);
	assert.deepEqual(dispatched, []);
});

test("DSG-005 reconnects when a stuck native WebSocket never emits close", async () => {
	const socket = new FakeSocket();
	socket.close = (code) => { socket.closed.push(code); };
	const callbacks = [];
	const timers = [];
	let heartbeatTick;
	const session = new DiscordGatewaySession({
		token: "token-value-long-enough",
		stateRepository: new MemoryGatewayState(),
		onDispatch: async () => {},
		onDisconnect: (event) => callbacks.push(event),
		webSocketFactory: () => socket,
		setTimeoutImpl: (fn) => { timers.push(fn); return { unref() {} }; },
		clearTimeoutImpl: () => {},
		setIntervalImpl: (fn) => { heartbeatTick = fn; return { unref() {} }; },
		clearIntervalImpl: () => {},
		random: () => 0,
	});
	session.connect();
	socket.emit("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 10_000 } }) });
	await session.dispatchChain;
	timers.shift()();
	heartbeatTick();
	assert.deepEqual(socket.closed, [4_000]);
	timers.shift()();
	assert.deepEqual(callbacks, [{ code: 4_000, resumable: true }]);
	socket.emit("close", { code: 4_000 });
	assert.equal(callbacks.length, 1);
});
