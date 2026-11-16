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
