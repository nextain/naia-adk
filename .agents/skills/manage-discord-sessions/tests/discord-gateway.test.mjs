import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { authorizeDiscordMessage, validateDiscordBindings } from "../helper/discord-scope.mjs";
import { deliverJobResult } from "../helper/discord-delivery.mjs";
import { DiscordGatewaySession, MemoryGatewayState, StoredGatewayState } from "../helper/discord-gateway.mjs";
import { DiscordMessageRouter } from "../helper/discord-router.mjs";
import { SessionStore } from "../helper/store.mjs";
import { discordUnitIdentity, renderDiscordUserUnit } from "../helper/systemd.mjs";
import { classifyWindowsStopObservation, installServiceCommands, quoteWindowsTaskAction, renderOperatorLauncher, renderWindowsStartupLauncher, resolveBackendExecutable, resolveWindowsBackendCommand, restartWindowsTask, sampleWindowsStopObservation, verifyWindowsTaskAction } from "../helper/service-manager.mjs";
import { messengerInstancePaths, normalizeMessengerInstance } from "../helper/instance-paths.mjs";
import { loadOrCreateRecoveryKey, RecoveryCodec } from "../helper/recovery-crypto.mjs";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { DiscordStatusProjection } from "../helper/discord-projection.mjs";
import { FileCredentialResolver, loadMessengerConfig } from "../helper/discord-config.mjs";
import { runDiscordService } from "../helper/service.mjs";
import { protectOwnerOnly, trustedWindowsSystemExecutable } from "../helper/platform-security.mjs";
import { spawnSync } from "node:child_process";
import { terminateUnidentifiedChild } from "../helper/backend-runner.mjs";

const roots = [];
const BOT = "111111111111111111";
const USER = "222222222222222222";
const GUILD = "333333333333333333";
const CHANNEL = "444444444444444444";
const THREAD = "555555555555555555";

afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "naia-discord-gateway-"));
	roots.push(root);
	const directory = join(root, "state");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	return { root, databasePath: join(directory, "runtime.sqlite3"), store: new SessionStore(join(directory, "runtime.sqlite3")) };
}

function widenTestAcl(path) {
	if (process.platform !== "win32") { chmodSync(path, 0o644); return; }
	const executable = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
	const result = spawnSync(executable, [path, "/grant", "*S-1-1-0:(R)"], { windowsHide: true });
	assert.equal(result.status, 0);
}

function binding(kind = "guild_channel") {
	if (kind === "dm") return { kind, userId: USER, allowedUserIds: [USER], respondWhen: "always", canStartConversation: true };
	if (kind === "thread") return { kind, guildId: GUILD, channelId: CHANNEL, threadId: THREAD, allowedUserIds: [USER], respondWhen: "mentioned", canStartConversation: true };
	return { kind, guildId: GUILD, channelId: CHANNEL, allowedUserIds: [USER], respondWhen: "mentioned", canStartConversation: true };
}

test("DSG-001 authorizes DM, guild channel, and exact thread bindings with structured mentions only", () => {
	const bindings = validateDiscordBindings([binding("dm"), binding(), binding("thread")]);
	const common = { author: { id: USER }, mentions: [{ id: BOT }], content: "plain text", id: "666666666666666666" };
	assert.equal(authorizeDiscordMessage({ message: { ...common, channel_id: "777777777777777777" }, bindings, botUserId: BOT }).scope.kind, "dm");
	assert.equal(authorizeDiscordMessage({ message: { ...common, guild_id: GUILD, channel_id: CHANNEL }, bindings, botUserId: BOT }).scope.kind, "guild_channel");
	const threads = new Map([[THREAD, { parentChannelId: CHANNEL, guildId: GUILD }]]);
	assert.equal(authorizeDiscordMessage({ message: { ...common, guild_id: GUILD, channel_id: THREAD }, bindings, botUserId: BOT, threadParents: threads }).scope.kind, "thread");
	assert.equal(authorizeDiscordMessage({ message: { ...common, mentions: [], content: `<@${BOT}>`, guild_id: GUILD, channel_id: CHANNEL }, bindings, botUserId: BOT }).reasonCode, "mention_required");
	assert.equal(authorizeDiscordMessage({ message: { ...common, author: { id: "888888888888888888" }, guild_id: GUILD, channel_id: CHANNEL }, bindings, operatorUserIds: ["888888888888888888"], botUserId: BOT }).reasonCode, "user_not_allowed");
	assert.throws(() => validateDiscordBindings([{ ...binding(), respondWhen: "always" }]), /require messageContentIntent/);
	assert.doesNotThrow(() => validateDiscordBindings([{ ...binding(), respondWhen: "always" }], { messageContentIntent: true }));
});

test("DSG-002 accepts ingress and job atomically and deduplicates Gateway replay", () => {
	const { store } = fixture();
	const input = { sourceMessageId: "666666666666666666", scopeKey: "scope-1", jobId: "job-1", dispatchSequence: 42, backendId: "codex", backendCapabilities: { structuredProgress: true }, activityDetail: "structured" };
	assert.equal(store.acceptIngressAndCreateJob(input).duplicate, false);
	assert.equal(store.acceptIngressAndCreateJob({ ...input, jobId: "job-2" }).jobId, "job-1");
	assert.equal(store.listJobs().length, 1);
	assert.equal(store.getJob("job-1").events[0].kind, "job_accepted");
	store.close();
});

test("DSG-003 records a delivery before POST and never automatically resends an uncertain attempt", async () => {
	const { store, databasePath } = fixture();
	store.createJob({ jobId: "job-1", backendId: "codex", activityDetail: "structured", jobType: "conversation" });
	const attemptId = store.startAttempt("job-1", { attemptId: "attempt-1" });
	store.recordEvent({ jobId: "job-1", attemptId, kind: "attempt_exited", source: "helper", safePayload: { terminationKind: "exited", exitCode: 0 } });
	store.recordEvent({ jobId: "job-1", attemptId, kind: "attempt_succeeded", source: "helper", safePayload: {} });
	let posts = 0;
	const fetchImpl = async (_url, init) => {
		posts += 1;
		const body = JSON.parse(init.body);
		assert.deepEqual(body.allowed_mentions, { parse: [] });
		assert.equal(body.enforce_nonce, true);
		assert.equal(body.content.includes("/var/home/luke"), false);
		throw new Error("connection lost after send");
	};
	const first = await deliverJobResult({ store, jobId: "job-1", attemptId, token: "token-value-long-enough", channelId: CHANNEL, botUserId: BOT, content: "done /var/home/luke/private @everyone", fetchImpl });
	assert.equal(first.state, "unknown");
	const second = await deliverJobResult({ store, jobId: "job-1", attemptId, token: "token-value-long-enough", channelId: CHANNEL, botUserId: BOT, content: "done", fetchImpl });
	assert.equal(second.state, "unknown");
	assert.equal(posts, 1);
	assert.equal(store.getJob("job-1").lifecycle, "recovery_review");
	store.close();
	const bytes = readFileSync(databasePath);
	assert.equal(bytes.includes(Buffer.from("done /var/home/luke/private")), false);
});

class FakeSocket {
	constructor() { this.listeners = new Map(); this.sent = []; this.closed = []; }
	addEventListener(type, callback) { this.listeners.set(type, callback); }
	send(value) { this.sent.push(JSON.parse(value)); }
	close(code) { this.closed.push(code); this.listeners.get("close")?.({ code }); }
	emit(type, value) { this.listeners.get(type)?.(value); }
}

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
		runtime: { heartbeatSeconds: 10, softSilenceSeconds: 120, maxConcurrentJobs: 1 },
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
	const router = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), send: async () => ({ state: "confirmed" }), runner: async (input) => { calls.push(input); return { backendOutcome: "failure", transientResult: null }; } });
	const accepted = await router.onDispatch("MESSAGE_CREATE", { id: "666666666666666666", guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }], content: `<@${BOT}> inspect this` }, 8);
	assert.equal(accepted.state, "accepted");
	await router.waitForIdle();
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].commandOptions, { sandbox: "read-only", approvalPolicy: "never" });
	assert.equal(JSON.stringify(store.listJobs()).includes("inspect this"), false);
	store.close();
});

test("DSG-006 refuses to construct a router without a confirmed Discord sender", () => {
	const { store, root } = fixture();
	const config = { persona: { name: "Reviewer", instructions: "Review safely." }, role: { name: "read-only", allowedActions: ["read", "reply"] }, backend: { selected: "codex" }, discord: { bindings: [binding()], operatorUserIds: [] }, runtime: { maxConcurrentJobs: 1 } };
	assert.throws(() => new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime") }), /confirmed Discord sender is required/);
	store.close();
});

test("DSG-006 preserves an unidentified Windows child reservation unless tree termination is confirmed", () => {
	const child = { pid: 43210, kill() { throw new Error("root-only kill must not be used on Windows"); } };
	assert.equal(terminateUnidentifiedChild(child, { platform: "win32", runTaskkill: () => ({ status: 1 }), isAlive: () => false }), true);
	assert.equal(terminateUnidentifiedChild(child, { platform: "win32", runTaskkill: () => ({ status: 1 }), isAlive: () => true }), false);
	assert.equal(terminateUnidentifiedChild(child, { platform: "win32", runTaskkill: () => ({ status: 0 }), isAlive: () => true }), false);
	assert.equal(terminateUnidentifiedChild(child, { platform: "win32", runTaskkill: () => ({ status: 0 }), isAlive: () => false }), true);
	assert.equal(terminateUnidentifiedChild({ pid: 43211, kill: () => false }, { platform: "linux", isAlive: () => true }), false);
	assert.equal(terminateUnidentifiedChild({ pid: 43212, kill: () => true }, { platform: "linux", isAlive: () => true }), false);
	assert.equal(terminateUnidentifiedChild({ pid: 43213, kill: () => true }, { platform: "linux", isAlive: () => false }), true);
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

test("DSG-007 resumes an encrypted prompt as a new attempt without plaintext persistence", async () => {
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
	assert.equal(calls[0].jobId, "recoverable-job");
	assert.equal(calls[0].prompt, prompt);
	store.close();
	assert.equal(readFileSync(databasePath).includes(Buffer.from(prompt)), false);
});

test("DSG-007 recovered work waits for a newly confirmed acknowledgement", async () => {
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
	assert.equal(calls.length, 1);
	store.close();
});

test("DSG-007 shutdown releases an unconfirmed recovered acknowledgement without execution", async () => {
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
	assert.equal(store.getJob("recovered-shutdown-job").lifecycle, "queued");
	store.close();
});

test("DSG-007 shutdown wins a race with recovered acknowledgement confirmation", async () => {
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
	store.close();
});

test("DSG-013 replaces a stale managed child profile with a fresh no-prompt child", async () => {
	const { store, root } = fixture();
	const codec = new RecoveryCodec(randomBytes(32));
	const prompt = "private-stale-profile-request";
	store.acceptIngressAndCreateJob({ sourceMessageId: "141414141414141414", scopeKey: "scope-1", jobId: "stale-profile-job", dispatchSequence: 12, backendId: "codex", backendCapabilities: { structuredProgress: true }, activityDetail: "structured", recoveryEnvelope: codec.seal(JSON.stringify({ prompt, channelId: CHANNEL, executionProfile: { backendId: "codex", permissionProfileEpoch: "managed-1", authorizationMode: "managed", access: "read-only" } })) });
	store.startAttempt("stale-profile-job", { attemptId: "old-managed-attempt" });
	const recovered = store.recoverInterruptedWork();
	const calls = [];
	const config = { persona: { name: "Reviewer", instructions: "Review." }, role: { name: "writer", allowedActions: ["read", "reply", "write", "execute"], requiresApproval: ["write", "execute"] }, backend: { selected: "codex" }, discord: { bindings: [binding()], operatorUserIds: [] }, runtime: { maxConcurrentJobs: 1, approvalPolicy: "never", permissionProfileEpoch: "never-2" } };
	const router = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), recoveryCodec: codec, send: async () => ({ state: "confirmed" }), runner: async (input) => { calls.push(input); return { backendOutcome: "failure", transientResult: null }; } });
	router.resumeRecovered(recovered, { autoRetry: true });
	await router.waitForIdle();
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].commandOptions, { sandbox: "workspace-write", approvalPolicy: "never" });
	assert.deepEqual(calls[0].executionProfile, { backendId: "codex", permissionProfileEpoch: "never-2", authorizationMode: "never", access: "workspace-write" });
	assert.equal(store.getJob("stale-profile-job").events.some((event) => event.kind === "profile_replaced"), true);
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
	assert.deepEqual(await router.watchdog({ nowMs }), { noProgress: 0, operatorResponse: 0 });
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

test("DSG-015 operator-channel response SLA creates a review handoff instead of silent execution", async () => {
	const { store, root } = fixture();
	let nowMs = 0;
	let runnerStarted = false;
	let abortReason = null;
	const config = { persona: { name: "Reviewer", instructions: "Review." }, role: { name: "reader", allowedActions: ["read", "reply"] }, backend: { selected: "codex" }, discord: { bindings: [binding()], operatorUserIds: [] }, runtime: { maxConcurrentJobs: 1, softSilenceSeconds: 60, noProgressInterventionSeconds: 60, operatorResponseSeconds: 1 } };
	const router = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), now: () => nowMs, send: async () => { throw new Error("channel unavailable"); }, runner: async ({ jobId, signal }) => {
		runnerStarted = true;
		store.startAttempt(jobId, { attemptId: "operator-response-attempt", childPid: process.pid, now: new Date(0).toISOString() });
		return new Promise((resolveRunner) => signal.addEventListener("abort", () => { abortReason = signal.reason; resolveRunner({ backendOutcome: "failure", transientResult: null }); }, { once: true }));
	} });
	await router.onDispatch("MESSAGE_CREATE", { id: "161616161616161616", guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }], content: `<@${BOT}> inspect this` }, 14);
	store.heartbeatService({ generation: "operator-service", pid: process.pid, now: new Date(1_000).toISOString() });
	nowMs = 1_001;
	const outcome = await router.watchdog({ nowMs });
	await router.waitForIdle();
	assert.equal(outcome.operatorResponse, 1);
	assert.equal(runnerStarted, false);
	assert.equal(abortReason, null);
	const job = store.getJob(store.listJobs()[0].jobId, { nowMs });
	assert.equal(job.lifecycle, "recovery_review");
	assert.equal(job.events.some((event) => event.kind === "operator_response_missed"), true);
	store.close();
});

test("DSG-008 renders a stable isolated user service with restart and single-owner controls", () => {
	const { root, store } = fixture();
	const first = renderDiscordUserUnit({ adkRoot: root, nodePath: "/usr/bin/node" });
	const second = renderDiscordUserUnit({ adkRoot: root, nodePath: "/usr/bin/node" });
	assert.equal(first.unitName, second.unitName);
	assert.equal(first.content, second.content);
	for (const required of ["flock", "--nonblock", "Restart=on-failure", "KillMode=mixed", "UMask=0077", "WantedBy=default.target"]) assert.equal(first.content.includes(required), true);
	assert.equal(/token|prompt|result/i.test(first.content), false);
	store.close();
});

test("DSG-008 isolates named bot instances while preserving the default instance contract", () => {
	const { root, store } = fixture();
	const defaultPaths = messengerInstancePaths(root);
	const alphaPaths = messengerInstancePaths(root, "alpha");
	assert.equal(defaultPaths.configPath, join(root, "naia-settings/messenger-sessions/config.json"));
	assert.equal(defaultPaths.databasePath, join(root, "naia-settings/.sessions/messenger-sessions/runtime.sqlite3"));
	assert.equal(alphaPaths.configPath, join(root, "naia-settings/messenger-sessions/instances/alpha/config.json"));
	assert.equal(alphaPaths.databasePath, join(root, "naia-settings/.sessions/messenger-sessions/instances/alpha/runtime.sqlite3"));
	assert.notEqual(alphaPaths.lockPath, defaultPaths.lockPath);
	assert.notEqual(alphaPaths.stopRequestPath, defaultPaths.stopRequestPath);
	assert.notEqual(alphaPaths.recoveryKeyPath, defaultPaths.recoveryKeyPath);
	const defaultUnit = discordUnitIdentity(root);
	const alphaUnit = discordUnitIdentity(root, "alpha");
	assert.notEqual(alphaUnit.unitName, defaultUnit.unitName);
	const alpha = renderDiscordUserUnit({ adkRoot: root, instance: "alpha", nodePath: "/usr/bin/node" });
	assert.equal(alpha.instance, "alpha");
	assert.match(alpha.content, /--instance" "alpha"/);
	assert.match(alpha.content, /Description=Naia ADK Discord sessions \(alpha\)/);
	assert.throws(() => normalizeMessengerInstance("../alpha"), /lowercase identifier/);
	assert.throws(() => normalizeMessengerInstance("Alpha"), /lowercase identifier/);
	assert.throws(() => normalizeMessengerInstance("service"), /command name/);
	store.close();
});

test("DSG-008 pins the selected backend executable independently of the systemd PATH", () => {
	const root = mkdtempSync(join(tmpdir(), "naia-discord-systemd-backend-"));
	roots.push(root);
	const bin = join(root, "bin");
	mkdirSync(bin, { mode: 0o700 });
	const codex = join(bin, "codex");
	writeFileSync(codex, "#!/bin/sh\n", { mode: 0o700 });
	const resolved = resolveBackendExecutable("codex", bin);
	if (process.platform === "win32") {
		const launcher = renderOperatorLauncher(root);
		assert.match(launcher, /@echo off/);
		assert.match(launcher, /managed by naia-adk manage-discord-sessions/);
		assert.match(launcher, /cli\.mjs/);
		const cli = join(import.meta.dirname, "../helper/cli.mjs");
		const service = spawnSync(process.execPath, [cli, "--adk-root", root, "service", "unit"], { encoding: "utf8", windowsHide: true });
		assert.equal(service.status, 0, service.stderr);
		assert.match(service.stdout, /Windows Task Scheduler: NaiaDiscordSessions-/);
		return;
	}
	const unit = renderDiscordUserUnit({ adkRoot: root, nodePath: "/opt/node/bin/node", backendExecutables: { codex: resolved } });
	assert.match(unit.content, new RegExp(`Environment=\\"NAIA_CODEX_EXECUTABLE=${resolved.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\"`));
	assert.match(unit.content, /Environment="PATH=\/opt\/node\/bin:/);
	assert.match(unit.content, new RegExp(`PATH=[^\\n]*${bin.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}`));
	assert.throws(() => resolveBackendExecutable("claude", bin), /not found/);
	assert.deepEqual(installServiceCommands(unit.unitName), [["enable", unit.unitName], ["restart", unit.unitName]]);
	assert.throws(() => installServiceCommands("other.service"), /invalid/);
	const launcher = renderOperatorLauncher(root);
	assert.match(launcher, /managed by naia-adk manage-discord-sessions/);
	assert.match(launcher, /manage-discord-sessions\.sh' "\$@"/);
});

test("DSG-008 Bash entrypoint preserves every top-level CLI command", () => {
	const script = readFileSync(join(import.meta.dirname, "../scripts/manage-discord-sessions.sh"), "utf8");
	for (const command of ["status", "jobs", "job", "watch", "history", "latest", "attachment", "reply", "service"]) {
		assert.match(script, new RegExp(`\\b${command}\\b`));
	}
});

test("DSG-008 quotes and verifies the exact Windows Task Scheduler action", () => {
	const action = "C:\\Program Files\\Naia Workspace\\service-launch.cmd";
	assert.equal(quoteWindowsTaskAction(action), action);
	assert.equal(verifyWindowsTaskAction(
		`<?xml version="1.0"?><Task><Principals><Principal><UserId>S-1-5-21-1</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Triggers><LogonTrigger /></Triggers><Actions><Exec><Command>C:\\Program Files\\Naia Workspace\\service-launch.cmd</Command></Exec></Actions></Task>`,
		action, "S-1-5-21-1",
	), true);
	assert.equal(verifyWindowsTaskAction(
		`<?xml version="1.0"?><Task><Principals><Principal><UserId>S-1-5-21-1</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Actions><Exec><Command>C:\\Program Files\\Naia Workspace\\service-launch.cmd</Command></Exec></Actions></Task>`,
		action, "S-1-5-21-1",
	), true);
	assert.throws(
		() => verifyWindowsTaskAction("<Task><Principals><Principal><UserId>S-1-5-21-1</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Triggers><LogonTrigger /></Triggers><Actions><Exec><Command>C:\\Other\\launch.cmd</Command></Exec></Actions></Task>", action, "S-1-5-21-1"),
		/does not match/,
	);
	assert.throws(() => verifyWindowsTaskAction(
		"<Task><Principals><Principal><UserId>S-1-5-21-1</UserId><LogonType>Password</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals><Triggers><BootTrigger /><LogonTrigger /></Triggers><Actions><Exec><Command>C:\\Program Files\\Naia Workspace\\service-launch.cmd</Command></Exec><ComHandler /></Actions></Task>",
		action, "S-1-5-21-1",
	), /one executable action|only one logon trigger|limited interactive principal/);
	assert.throws(() => verifyWindowsTaskAction(
		"<Task><Principals><Principal><UserId>S-1-5-21-1</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal><Principal><UserId>S-1-5-21-1</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Triggers><LogonTrigger /></Triggers><Actions><Exec><Command>C:\\Program Files\\Naia Workspace\\service-launch.cmd</Command><Arguments>unsafe</Arguments></Exec><SendEmail /></Actions></Task>",
		action, "S-1-5-21-1",
	), /one executable action|only the launcher command|principal is not uniquely defined/);
	assert.throws(() => verifyWindowsTaskAction(
		"<Task><Principals><Principal><UserId>S-1-5-21-1</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel><ProcessTokenSidType>Unrestricted</ProcessTokenSidType><RequiredPrivileges><Privilege>SeDebugPrivilege</Privilege></RequiredPrivileges></Principal></Principals><Triggers><LogonTrigger /></Triggers><Actions><Exec><Command>C:\\Program Files\\Naia Workspace\\service-launch.cmd</Command></Exec></Actions></Task>",
		action, "S-1-5-21-1",
	), /unsupported privileges/);
	assert.throws(() => quoteWindowsTaskAction("relative\\launch.cmd"), /absolute/);
});

test("DSG-008 renders a hidden per-user Startup fallback without embedding credentials", () => {
	const content = renderWindowsStartupLauncher("C:\\Naia Workspace\\service-launch.cmd");
	assert.match(content, /WScript\.Shell/);
	assert.match(content, /service-launch\.cmd/);
	assert.match(content, /, 0, False/);
	assert.equal(/token|credential|secret/i.test(content), false);
});

test("DSG-008 resolves the installed Windows npm shim to pinned node and script paths", { skip: process.platform !== "win32" }, () => {
	const command = resolveWindowsBackendCommand("codex");
	assert.equal(typeof command, "object");
	assert.match(command.command, /node\.exe$/i);
	assert.equal(command.prefixArgs.length, 1);
	assert.match(command.prefixArgs[0], /[\\/]codex\.js$/i);
});

test("DSG-008 rejects caller-controlled Windows system roots", { skip: process.platform !== "win32" }, () => {
	const originalRoot = process.env.SystemRoot;
	const originalWinDir = process.env.WINDIR;
	const fakeRoot = mkdtempSync(join(tmpdir(), "naia-fake-system-root-"));
	roots.push(fakeRoot);
	try {
		process.env.SystemRoot = fakeRoot;
		process.env.WINDIR = fakeRoot;
		assert.throws(() => trustedWindowsSystemExecutable("taskkill.exe"), /identity mismatch/);
	} finally {
		process.env.SystemRoot = originalRoot;
		process.env.WINDIR = originalWinDir;
	}
});

test("DSG-008 retries Windows Task Scheduler restart within a fixed bound", () => {
	const calls = [];
	const waits = [];
	let starts = 0;
	const attempts = restartWindowsTask("NaiaDiscordSessions-123456789abc", {
		maxAttempts: 4,
		retryDelayMs: 10,
		wait: (milliseconds) => waits.push(milliseconds),
		run: (args, options = {}) => {
			calls.push({ args, options });
			if (args[0] === "/End") return { status: 0, output: "" };
			starts += 1;
			return { status: starts < 3 ? 1 : 0, output: "" };
		},
	});
	assert.equal(attempts, 3);
	assert.deepEqual(calls.map((call) => call.args[0]), ["/End", "/Run", "/Run", "/Run"]);
	assert.deepEqual(waits, [10, 10]);
	assert.throws(() => restartWindowsTask("NaiaDiscordSessions-123456789abc", {
		maxAttempts: 2,
		retryDelayMs: 0,
		wait: () => {},
		run: () => ({ status: 1, output: "" }),
	}), /bounded retry window/);
});

test("DSG-008 tolerates transient Windows ownership gaps while stopping", () => {
	const owner = { generation: "generation-a" };
	assert.equal(classifyWindowsStopObservation({ owner, currentOwner: owner, observation: { state: "unknown" } }), "wait");
	assert.equal(classifyWindowsStopObservation({ owner, currentOwner: owner, observation: { state: "owned" } }), "wait");
	assert.equal(classifyWindowsStopObservation({ owner, currentOwner: owner, observation: { state: "missing" } }), "stopped");
	assert.equal(classifyWindowsStopObservation({ owner, currentOwner: null, observation: { state: "unknown" } }), "stopped");
	assert.throws(() => classifyWindowsStopObservation({ owner, currentOwner: { generation: "generation-b" }, observation: { state: "owned" } }), /generation changed/);
	assert.throws(() => classifyWindowsStopObservation({ owner, currentOwner: { generation: "generation-b" }, observation: { state: "missing" } }), /generation changed/);
	assert.throws(() => classifyWindowsStopObservation({ owner, currentOwner: owner, observation: { state: "conflict" } }), /ownership changed/);
	const calls = [];
	let currentOwner = owner;
	assert.throws(() => sampleWindowsStopObservation({
		owner,
		observe: () => { calls.push("observe"); currentOwner = { generation: "generation-b" }; return { state: "missing" }; },
		getCurrentOwner: () => { calls.push("owner"); return currentOwner; },
	}), /generation changed/);
	assert.deepEqual(calls, ["observe", "owner"]);
});

test("DSG-009 participant status projection is limited to the current Discord scope", async () => {
	const { store, root } = fixture();
	const config = { persona: { name: "Reviewer", instructions: "Review." }, role: { name: "reader", allowedActions: ["read", "reply"] }, backend: { selected: "codex" }, discord: { bindings: [binding()], operatorUserIds: [] }, runtime: { maxConcurrentJobs: 1 } };
	const scope = authorizeDiscordMessage({ message: { guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }] }, bindings: config.discord.bindings, botUserId: BOT }).scopeKey;
	store.createJob({ jobId: "visible-job", backendId: "codex", activityDetail: "structured", jobType: "conversation", scopeKey: scope });
	store.createJob({ jobId: "hidden-job", backendId: "codex", activityDetail: "structured", jobType: "conversation", scopeKey: "different-scope" });
	const sent = [];
	const router = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), send: async (input) => { sent.push(input); return { state: "confirmed" }; } });
	const result = await router.onDispatch("MESSAGE_CREATE", { id: "999999999999999999", guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }], content: `<@${BOT}> !naia jobs` }, 9);
	assert.equal(result.state, "command_handled");
	assert.equal(sent[0].content.includes("visible-job"), true);
	assert.equal(sent[0].content.includes("hidden-job"), false);
	store.close();
});

test("DSG-010 approval-required mutation remains read-only until an explicit elevation contract exists", async () => {
	const { store, root } = fixture();
	const calls = [];
	const config = { persona: { name: "Builder", instructions: "Work safely." }, role: { name: "guarded", allowedActions: ["read", "reply", "write", "execute"], requiresApproval: ["write", "execute"] }, backend: { selected: "claude" }, discord: { bindings: [binding()], operatorUserIds: [] }, runtime: { maxConcurrentJobs: 1 } };
	const router = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), send: async () => ({ state: "confirmed" }), runner: async (input) => { calls.push(input); return { backendOutcome: "failure", transientResult: null }; } });
	await router.onDispatch("MESSAGE_CREATE", { id: "121212121212121212", guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }], content: `<@${BOT}> change a file` }, 10);
	await router.waitForIdle();
	assert.deepEqual(calls[0].commandOptions, { permissionMode: "plan", settingSources: "project", approvalPolicy: "never" });
	store.close();
});

test("DSG-011 creates, pins, and updates one scoped Discord status projection", async () => {
	const { store } = fixture();
	store.createJob({ jobId: "visible-job", backendId: "codex", activityDetail: "structured", jobType: "conversation", scopeKey: "scope-1" });
	store.createJob({ jobId: "hidden-job", backendId: "codex", activityDetail: "structured", jobType: "conversation", scopeKey: "scope-2" });
	const requests = [];
	const fetchImpl = async (url, init) => {
		requests.push({ url, init });
		if (init.method === "POST") return { ok: true, status: 200, json: async () => ({ id: "141414141414141414", channel_id: CHANNEL, author: { id: BOT }, nonce: JSON.parse(init.body).nonce }) };
		return { ok: true, status: 204, json: async () => ({}) };
	};
	const projection = new DiscordStatusProjection({ store, token: "token-value-long-enough", botUserId: BOT, fetchImpl });
	assert.equal((await projection.publishScope({ scopeKey: "scope-1", channelId: CHANNEL })).state, "created");
	assert.equal(requests.some((item) => item.url.includes("/pins/")), true);
	assert.equal(requests[0].init.body.includes("visible-job"), true);
	assert.equal(requests[0].init.body.includes("hidden-job"), false);
	assert.equal((await projection.publishScope({ scopeKey: "scope-1", channelId: CHANNEL })).state, "updated");
	assert.equal(requests.at(-1).init.method, "PATCH");
	store.close();
});

test("DSG-012 loads only private closed settings and resolves an owner-only credential reference", () => {
	const { root, store } = fixture();
	store.close();
	const configPath = join(root, "config.json");
	const config = { schemaVersion: 1, enabled: true, workspaceId: "test", persona: { name: "Reviewer", instructions: "Review." }, role: { name: "reader", allowedActions: ["read", "reply"], requiresApproval: ["write"] }, backend: { selected: "codex", profiles: { codex: { enabled: true }, claude: { enabled: false } } }, discord: { credentialRef: "discord-token", botUserId: BOT, operatorUserIds: [], bindings: [binding()] }, runtime: { heartbeatSeconds: 10, softSilenceSeconds: 120, noProgressInterventionSeconds: 120, operatorResponseSeconds: 30, approvalPolicy: "never", permissionProfileEpoch: "profile-1", maxConcurrentJobs: 1 }, observability: { discordStatusProjection: true }, service: { autoStart: true, startAt: "login" }, recovery: { autoRetry: true } };
	writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
	protectOwnerOnly(configPath, "file", "test config");
	assert.equal(loadMessengerConfig(configPath).backend.selected, "codex");
	writeFileSync(configPath, JSON.stringify({ ...config, unexpected: true }), { mode: 0o600 });
	assert.throws(() => loadMessengerConfig(configPath), /unsupported field/);
	writeFileSync(configPath, JSON.stringify(config), { mode: 0o644 });
	widenTestAcl(configPath);
	assert.throws(() => loadMessengerConfig(configPath), /owner-only/);
	const keyDirectory = join(root, "keys");
	mkdirSync(keyDirectory, { mode: 0o700 });
	const keyPath = join(keyDirectory, "discord-token");
	writeFileSync(keyPath, "credential-value-long-enough", { mode: 0o600 });
	protectOwnerOnly(keyDirectory, "directory", "test credential directory");
	protectOwnerOnly(keyPath, "file", "test credential");
	assert.equal(new FileCredentialResolver(keyDirectory).resolve("discord-token"), "credential-value-long-enough");
	widenTestAcl(keyPath);
	assert.throws(() => new FileCredentialResolver(keyDirectory).resolve("discord-token"), /owner-only/);
});
