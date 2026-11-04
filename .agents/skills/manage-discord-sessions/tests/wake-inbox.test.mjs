import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { runDiscordService } from "../helper/service-runtime.mjs";
import { WakeInbox } from "../helper/wake-inbox.mjs";
import { messengerInstancePaths } from "../helper/instance-paths.mjs";
import { observeOwnedProcess, readBootId, readProcessStartIdentity, readProcessWorkingDirectory } from "../helper/projector.mjs";
import { SessionStore } from "../helper/store.mjs";

const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });
const watched = "4".repeat(18), source = "6".repeat(18), author = "2".repeat(18);
function fixture(submit = async () => ({ state: "accepted" })) {
	const root = mkdtempSync(join(tmpdir(), "wake-fixture-")); roots.push(root);
	const paths = messengerInstancePaths(root);
	const calls = [];
	const options = { paths, bindings: [{ channelId: watched }], submit: async (request) => { calls.push(request); return submit(request); } };
	const inbox = new WakeInbox(options);
	const put = (name, values = {}) => writeFileSync(join(paths.wakeDirectory, name), JSON.stringify({ schemaVersion: 1, requestId: name.replace(/\W/g, "_"), sourceChannelId: source, channelId: watched, authorId: author, content: "fixture wake", ...values }), { mode: 0o600 });
	return { root, paths, options, inbox, calls, put };
}

test("one service receives backlog, skips direct channel overlap and persists cursor across restart", async () => {
	const f = fixture();
	f.put("routed.json"); f.put("direct.json", { sourceChannelId: watched });
	mkdirSync(join(f.paths.wakeDirectory, "nested"));
	writeFileSync(join(f.paths.wakeDirectory, "partial.tmp"), "{");
	const results = await f.inbox.poll();
	assert.deepEqual(results.map((r) => r.state), ["skipped", "accepted"]);
	assert.equal(f.calls.length, 1);
	assert.match(f.calls[0].sourceMessageId, /^\d{19}$/);
	assert.equal(Object.keys(JSON.parse(readFileSync(f.paths.wakeSeenPath, "utf8")).seen).length, 2);
	assert.deepEqual(await new WakeInbox(f.options).poll(), []);
	assert.equal(f.calls.length, 1);
	f.put("later.json");
	assert.equal((await f.inbox.poll())[0].state, "accepted");
});

test("invalid input is recorded, repair is accepted, symlinks are ignored", async () => {
	const f = fixture();
	writeFileSync(join(f.paths.wakeDirectory, "bad.json"), "{", { mode: 0o600 });
	assert.equal((await f.inbox.poll())[0].reasonCode, "invalid_wake_request");
	f.put("bad.json");
	assert.equal((await f.inbox.poll())[0].state, "accepted");
	if (process.platform !== "win32") {
		symlinkSync(join(f.paths.wakeDirectory, "bad.json"), join(f.paths.wakeDirectory, "link.json"));
		assert.deepEqual(await f.inbox.poll(), []);
	}
});

test("failed admission retries with stable identity and never marks the cursor seen", async () => {
	let fail = true;
	const f = fixture(async () => { if (fail) throw new Error("fixture transient"); return { state: "accepted" }; });
	f.put("retry.json");
	await assert.rejects(f.inbox.poll(), /fixture transient/);
	fail = false;
	await new WakeInbox(f.options).poll();
	assert.equal(f.calls.length, 2);
	assert.equal(f.calls[0].sourceMessageId, f.calls[1].sourceMessageId);
});

test("corrupt cursor fails closed and oversized requests never reach admission", async () => {
	const f = fixture();
	writeFileSync(join(f.paths.wakeDirectory, "large.json"), "x".repeat(32_769), { mode: 0o600 });
	assert.equal((await f.inbox.poll())[0].reasonCode, "wake_too_large");
	assert.equal(f.calls.length, 0);
	writeFileSync(f.paths.wakeSeenPath, "{", { mode: 0o600 });
	assert.throws(() => new WakeInbox(f.options), SyntaxError);
});

test("existing service timer handles inbox and Gateway in one service without launching a model", async () => {
	const f = fixture();
	const bot = "1".repeat(18), guild = "3".repeat(18);
	mkdirSync(join(f.root, "naia-settings/messenger-sessions"), { recursive: true, mode: 0o700 });
	mkdirSync(f.paths.credentialsDirectory, { recursive: true, mode: 0o700 });
	writeFileSync(f.paths.configPath, JSON.stringify({
		schemaVersion: 1, enabled: true, workspaceId: "wake-fixture",
		persona: { name: "Fixture", instructions: "Inspect safely." },
		role: { name: "read-only", allowedActions: ["read", "reply"], requiresApproval: [] },
		backend: { selected: "codex", profiles: { codex: { enabled: true }, claude: { enabled: true } } },
		discord: { messageContentIntent: true, credentialRef: "fixture-token", botUserId: bot, operatorUserIds: [author], bindings: [{ kind: "guild_channel", guildId: guild, channelId: watched, allowedUserIds: [author], respondWhen: "always", canStartConversation: true, operatorActions: true }] },
		runtime: { heartbeatSeconds: 10, softSilenceSeconds: 120, maxConcurrentJobs: 1, approvalPolicy: "never" },
		observability: { discordStatusProjection: false }, service: { autoStart: false, startAt: "login" }, recovery: { autoRetry: false },
	}), { mode: 0o600 });
	writeFileSync(join(f.paths.credentialsDirectory, "fixture-token"), "fake-wake-fixture-token-value\n", { mode: 0o600 });
	f.put("service.json", { content: "!naia status" });
	const listeners = new Map(), signals = new EventEmitter(), posts = [];
	const socket = { addEventListener: (type, callback) => listeners.set(type, callback), send() {}, close(code) { listeners.get("close")?.({ code }); } };
	const fetchImpl = async (_url, init) => {
		const request = JSON.parse(init.body); posts.push(request);
		return { ok: true, status: 200, json: async () => ({ id: "9".repeat(18), channel_id: watched, author: { id: bot }, nonce: request.nonce }) };
	};
	const running = runDiscordService({ adkRoot: f.root, webSocketFactory: () => socket, fetchImpl, signalSource: signals, tokenLockDirectory: join(f.root, "fixture-locks") });
	try {
		await new Promise((done) => setImmediate(done));
		listeners.get("message")({ data: JSON.stringify({ op: 0, s: 1, t: "MESSAGE_CREATE", d: { id: "7".repeat(18), guild_id: guild, channel_id: watched, author: { id: author }, content: "!naia status" } }) });
		const deadline = Date.now() + 3_000;
		while (posts.length < 2 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
		assert.equal(posts.length, 2);
		assert.equal(JSON.parse(readFileSync(f.paths.wakeSeenPath, "utf8")).schemaVersion, 1);
	} finally { signals.emit("SIGTERM"); await running; }
});

test("SQLite heartbeat records cwd and process observation uses cwd plus boot/start identity", { skip: process.platform !== "linux" }, async () => {
	const f = fixture();
	const store = new SessionStore(f.paths.databasePath);
	try {
		store.heartbeatService({ generation: "fixture-generation" });
		assert.equal(store.operationalSnapshot().status.service.state, "running");
		const child = spawn(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"], { cwd: f.root, stdio: ["ignore", "pipe", "ignore"] });
		try {
			await once(child.stdout, "data");
			const identity = { pid: child.pid, bootId: readBootId(), processStartIdentity: readProcessStartIdentity(child.pid), workingDirectory: resolve(f.root) };
			assert.equal(readProcessWorkingDirectory(child.pid), resolve(f.root));
			assert.equal(observeOwnedProcess(identity).state, "owned");
			assert.equal(observeOwnedProcess({ ...identity, workingDirectory: resolve(f.root, "wrong") }).reasonCode, "process_cwd_conflict");
			assert.equal(observeOwnedProcess({ ...identity, processStartIdentity: "wrong" }).reasonCode, "ownership_conflict");
		} finally { child.kill(); await once(child, "exit"); }
	} finally { store.close(); }
});
