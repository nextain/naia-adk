"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pin = require("../lib/gate-config-pin.js");

const approverId = "123456789012345678";
const channelId = "234567890123456789";
const messageId = "345678901234567890";

function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-config-pin-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const file = path.join(root, ".claude/deploy/config.json");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, '{"review_models":{"fable":{"model":"claude-fable","effort":"high","executor":"claude"}}}\n');
	const hash = pin.snapshotGateConfig(root).hash;
	const code = pin.approvalCode(hash);
	const refs = [{ code, channelId, messageId }];
	const message = { id: messageId, channel_id: channelId, author: { id: approverId }, content: `승인 ${code}` };
	return { root, file, hash, refs, message };
}

function confirm(f, message = f.message, fetchImpl = async () => ({ ok: true, json: async () => message })) {
	return pin.approvedGateConfig({ root: f.root, approverId, refs: f.refs, token: "mock-token", fetchImpl });
}

test("approval code uses the documented SHA-256 and RFC 4648 Base32 formula", () => {
	// Independent Python hashlib/base64 vector for SHA256('gate-config-v1\\0' + 64 ASCII zeros).
	assert.equal(pin.approvalCode("0".repeat(64)), "CFG-M2Q4VMRQV3");
});

test("only the configured human's own Discord message approves a snapshot", async (t) => {
	const f = fixture(t);
	const accepted = await confirm(f);
	assert.equal(accepted.hash, f.hash);
	assert.equal(accepted.config.review_models.fable.model, "claude-fable");
	// The message has no timestamp: configuration approval does not compare issuance time.
	for (const altered of [
		{ author: { id: "456789012345678901" } },
		{ author: { id: approverId, bot: true } },
		{ author: { id: approverId, system: true } },
		{ webhook_id: "456789012345678901" },
		{ application_id: "456789012345678901" },
		{ content: "다른 코드" },
	]) assert.equal(await confirm(f, { ...f.message, ...altered }), null);
});

test("a changed byte or a change during the fetch invalidates approval", async (t) => {
	const f = fixture(t);
	fs.appendFileSync(f.file, " ");
	assert.notEqual(pin.snapshotGateConfig(f.root).hash, f.hash);
	assert.equal(await confirm(f), null);
	fs.writeFileSync(f.file, '{"review_models":{"fable":{"model":"claude-fable","effort":"high","executor":"claude"}}}\n');
	assert.equal(await confirm(f, f.message, async () => {
		fs.appendFileSync(f.file, " ");
		return { ok: true, json: async () => f.message };
	}), null);
});

test("the optional instance deploy configuration is bound to the same approval hash", async (t) => {
	const f = fixture(t);
	const deploy = path.join(f.root, "config/deploy-gate.json");
	fs.mkdirSync(path.dirname(deploy), { recursive: true });
	fs.writeFileSync(deploy, '{"testHosts":["box.example.invalid"]}');
	assert.notEqual(pin.snapshotGateConfig(f.root).hash, f.hash);
	assert.equal(await confirm(f), null);
	const newHash = pin.snapshotGateConfig(f.root).hash;
	const code = pin.approvalCode(newHash);
	f.refs = [{ code, channelId, messageId }];
	f.message.content = code;
	assert.equal((await confirm(f)).hash, newHash);
	fs.appendFileSync(deploy, " ");
	assert.equal(await confirm(f), null);
});

test("approval CLI shows committed resolved models and current order; compares only a verified prior snapshot", (t) => {
	const { spawnSync } = require("child_process");
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-approval-cli-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const previous = path.join(root, "previous"), current = path.join(root, "current");
	const write = (dir, config) => { const file = path.join(dir, ".claude/deploy/config.json"); fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, JSON.stringify(config, null, 2)); };
	const models = {argon: {model: "a", effort: "medium", runner: "agy"}, codex: {model: "c", effort: "high", runner: "codex"}, muse: {model: "m", effort: "high", runner: "muse"}, fable: {model: "f", effort: "high", runner: "claude"}};
	write(previous, {review_models: models});
	write(current, {review_models: {...models, fable: {...models.fable, model: "f / tricky", effort: "max"}}, planReview: {reviewer: "fable", until: "2099-01-01T00:00:00Z"}});
	assert.equal(spawnSync("git", ["init", "-q", current]).status, 0);
	assert.equal(spawnSync("git", ["-C", current, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "add", "."]).status, 0);
	assert.equal(spawnSync("git", ["-C", current, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "config"]).status, 0);
	const cli = path.join(__dirname, "../gate-config-approval.js");
	const run = (args, env = {}) => spawnSync(process.execPath, [cli, current, ...args], {encoding: "utf8", env: {...process.env, ...env}});
	const plain = run([]);
	assert.equal(plain.status, 0, plain.stderr);
	assert.match(plain.stdout, /"fable" \/ "f \/ tricky" \/ "max" \/ "claude"/);
	assert.match(plain.stdout, /muse: fable → argon(?:\n|\r)/);
	assert.match(plain.stdout, /claude: argon → codex/);
	assert.match(plain.stdout, new RegExp(pin.approvalCode(pin.snapshotGateConfig(current).hash)));
	assert.doesNotMatch(plain.stdout, /승인 판 .* 대비/);
	const preload = path.join(root, "fetch.cjs");
	const code = pin.approvalCode(pin.snapshotGateConfig(previous).hash);
	fs.writeFileSync(preload, `globalThis.fetch = async () => ({ok:true,json:async()=>(${JSON.stringify({id: messageId, channel_id: channelId, author: {id: approverId}, content: code})})});`);
	const flags = ["--approved-root", previous, "--approver-id", approverId, "--channel-id", channelId, "--message-id", messageId];
	const compared = run(flags, {NODE_OPTIONS: `--require=${preload}`, DISCORD_BOT_TOKEN: "test"});
	assert.equal(compared.status, 0, compared.stderr);
	assert.match(compared.stdout, /- "fable" \/ "f" \/ "high" \/ "claude"/);
	assert.match(compared.stdout, /\+ "fable" \/ "f \/ tricky" \/ "max" \/ "claude"/);
	assert.match(compared.stdout, /승인 판 대비 설정 줄/);
	fs.writeFileSync(preload, `globalThis.fetch = async () => ({ok:true,json:async()=>({id:${JSON.stringify(messageId)},author:{id:"999999999999999999"},content:${JSON.stringify(code)}})});`);
	assert.notEqual(run(flags, {NODE_OPTIONS: `--require=${preload}`, DISCORD_BOT_TOKEN: "test"}).status, 0);
	for (const invalid of ["{", JSON.stringify({review_models: {fable: {...models.fable, effort: "low"}}})]) {
		fs.writeFileSync(path.join(current, ".claude/deploy/config.json"), invalid);
		const result = run([]);
		assert.notEqual(result.status, 0);
		assert.doesNotMatch(result.stdout, /SHA-256:|승인 코드:|CFG-/);
	}
});
