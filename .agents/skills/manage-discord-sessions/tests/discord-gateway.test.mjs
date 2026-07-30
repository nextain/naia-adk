import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { authorizeDiscordMessage, validateDiscordBindings } from "../helper/discord-scope.mjs";
import { deliverJobResult } from "../helper/discord-delivery.mjs";
import { DiscordGatewaySession, MemoryGatewayState, StoredGatewayState } from "../helper/discord-gateway.mjs";
import { DiscordMessageRouter } from "../helper/discord-router.mjs";
import { SessionStore } from "../helper/store.mjs";
import { renderDiscordUserUnit } from "../helper/systemd.mjs";
import { resolveBackendExecutable } from "../helper/service-manager.mjs";
import { RecoveryCodec } from "../helper/recovery-crypto.mjs";
import { randomBytes } from "node:crypto";
import { DiscordStatusProjection } from "../helper/discord-projection.mjs";
import { FileCredentialResolver, loadMessengerConfig } from "../helper/discord-config.mjs";

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
	const router = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), runner: async (input) => { calls.push(input); return { backendOutcome: "failure", transientResult: null }; } });
	const accepted = await router.onDispatch("MESSAGE_CREATE", { id: "666666666666666666", guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }], content: `<@${BOT}> inspect this` }, 8);
	assert.equal(accepted.state, "accepted");
	await router.waitForIdle();
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].commandOptions, { sandbox: "read-only" });
	assert.equal(JSON.stringify(store.listJobs()).includes("inspect this"), false);
	store.close();
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

test("DSG-007 resumes an encrypted prompt as a new attempt without plaintext persistence", async () => {
	const { store, databasePath, root } = fixture();
	const codec = new RecoveryCodec(randomBytes(32));
	const prompt = "private-reboot-canary-request";
	store.acceptIngressAndCreateJob({ sourceMessageId: "131313131313131313", scopeKey: "scope-1", jobId: "recoverable-job", dispatchSequence: 11, backendId: "codex", backendCapabilities: { structuredProgress: true }, activityDetail: "structured", recoveryEnvelope: codec.seal(JSON.stringify({ prompt, channelId: CHANNEL, commandOptions: { sandbox: "read-only" } })) });
	store.startAttempt("recoverable-job", { attemptId: "old-attempt" });
	const recovered = store.recoverInterruptedWork();
	assert.equal(recovered.length, 1);
	assert.equal(store.getJob("recoverable-job").lifecycle, "queued");
	assert.equal(store.getJob("recoverable-job").attemptId, null);
	const calls = [];
	const config = { persona: { name: "Reviewer", instructions: "Review." }, role: { name: "reader", allowedActions: ["read", "reply"] }, backend: { selected: "codex" }, discord: { bindings: [binding()], operatorUserIds: [] }, runtime: { maxConcurrentJobs: 1 } };
	const router = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), recoveryCodec: codec, runner: async (input) => { calls.push(input); return { backendOutcome: "failure", transientResult: null }; } });
	router.resumeRecovered(recovered, { autoRetry: true });
	await router.waitForIdle();
	assert.equal(calls[0].jobId, "recoverable-job");
	assert.equal(calls[0].prompt, prompt);
	store.close();
	assert.equal(readFileSync(databasePath).includes(Buffer.from(prompt)), false);
});

test("DSG-008 renders a stable isolated user service with restart and single-owner controls", () => {
	const { root } = fixture();
	const first = renderDiscordUserUnit({ adkRoot: root, nodePath: "/usr/bin/node" });
	const second = renderDiscordUserUnit({ adkRoot: root, nodePath: "/usr/bin/node" });
	assert.equal(first.unitName, second.unitName);
	assert.equal(first.content, second.content);
	for (const required of ["flock", "--nonblock", "Restart=on-failure", "KillMode=mixed", "UMask=0077", "WantedBy=default.target"]) assert.equal(first.content.includes(required), true);
	assert.equal(/token|prompt|result/i.test(first.content), false);
});

test("DSG-008 pins the selected backend executable independently of the systemd PATH", () => {
	const root = mkdtempSync(join(tmpdir(), "naia-discord-systemd-backend-"));
	roots.push(root);
	const bin = join(root, "bin");
	mkdirSync(bin, { mode: 0o700 });
	const codex = join(bin, "codex");
	writeFileSync(codex, "#!/bin/sh\n", { mode: 0o700 });
	const resolved = resolveBackendExecutable("codex", bin);
	const unit = renderDiscordUserUnit({ adkRoot: root, nodePath: "/usr/bin/node", backendExecutables: { codex: resolved } });
	assert.match(unit.content, new RegExp(`Environment=\\"NAIA_CODEX_EXECUTABLE=${resolved.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\"`));
	assert.throws(() => resolveBackendExecutable("claude", bin), /not found/);
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
	const router = new DiscordMessageRouter({ config, store, token: "token-value-long-enough", botUserId: BOT, cwd: root, runtimeRoot: join(root, "runtime"), runner: async (input) => { calls.push(input); return { backendOutcome: "failure", transientResult: null }; } });
	await router.onDispatch("MESSAGE_CREATE", { id: "121212121212121212", guild_id: GUILD, channel_id: CHANNEL, author: { id: USER }, mentions: [{ id: BOT }], content: `<@${BOT}> change a file` }, 10);
	await router.waitForIdle();
	assert.deepEqual(calls[0].commandOptions, { permissionMode: "plan", settingSources: "project" });
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
	const config = { schemaVersion: 1, enabled: true, workspaceId: "test", persona: { name: "Reviewer", instructions: "Review." }, role: { name: "reader", allowedActions: ["read", "reply"], requiresApproval: ["write"] }, backend: { selected: "codex", profiles: { codex: { enabled: true }, claude: { enabled: false } } }, discord: { credentialRef: "discord-token", botUserId: BOT, operatorUserIds: [], bindings: [binding()] }, runtime: { heartbeatSeconds: 10, softSilenceSeconds: 120, maxConcurrentJobs: 1 }, observability: { discordStatusProjection: true }, service: { autoStart: true, startAt: "login" }, recovery: { autoRetry: true } };
	writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
	assert.equal(loadMessengerConfig(configPath).backend.selected, "codex");
	writeFileSync(configPath, JSON.stringify({ ...config, unexpected: true }), { mode: 0o600 });
	assert.throws(() => loadMessengerConfig(configPath), /unsupported field/);
	writeFileSync(configPath, JSON.stringify(config), { mode: 0o644 });
	chmodSync(configPath, 0o644);
	assert.throws(() => loadMessengerConfig(configPath), /owner-only/);
	const keyDirectory = join(root, "keys");
	mkdirSync(keyDirectory, { mode: 0o700 });
	const keyPath = join(keyDirectory, "discord-token");
	writeFileSync(keyPath, "credential-value-long-enough", { mode: 0o600 });
	assert.equal(new FileCredentialResolver(keyDirectory).resolve("discord-token"), "credential-value-long-enough");
	chmodSync(keyPath, 0o644);
	assert.throws(() => new FileCredentialResolver(keyDirectory).resolve("discord-token"), /owner-only/);
});
