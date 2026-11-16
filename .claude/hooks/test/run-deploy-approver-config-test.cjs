"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { discordConfirms } = require("../lib/deploy-plan.js");

test("Discord approval uses the protected instance identity, not caller-supplied expectations", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-approver-"));
	const configured = "111111111111111111", other = "333333333333333333";
	const code = "PLAN-ABC123", channelId = "222222222222222222", messageId = "444444444444444444";
	const sinceIso = new Date(Date.now() - 60000).toISOString();
	const priorConfig = process.env.DEPLOY_GATE_CONFIG;
	delete process.env.DEPLOY_GATE_CONFIG;
	let author = configured;
	const args = { root, code, sinceIso, approverId: configured, token: "test", refs: [{ code, channelId, messageId }],
		fetchImpl: async () => ({ ok: true, json: async () => ({ id: messageId, channel_id: channelId, content: code, timestamp: new Date().toISOString(), author: { id: author } }) }) };
	try {
		assert.equal((await discordConfirms(args)).ok, false, "missing configuration fails closed");
		fs.mkdirSync(path.join(root, "config"));
		fs.writeFileSync(path.join(root, "config/deploy-gate.json"), JSON.stringify({ approver: { discordUserId: configured } }));
		assert.equal((await discordConfirms(args)).ok, true, "configured human is accepted");
		author = other;
		assert.equal((await discordConfirms({ ...args, approverId: other, expectedApproverId: other })).why, "approver-id-mismatch");
		const alternate = path.join(root, "config/alternate.json");
		fs.writeFileSync(alternate, JSON.stringify({ approver: { discordUserId: other } }));
		process.env.DEPLOY_GATE_CONFIG = alternate;
		assert.equal((await discordConfirms({ ...args, approverId: other })).ok, true, "selected instance config is authoritative");
		assert.equal((await discordConfirms(args)).why, "approver-id-mismatch");
	} finally {
		if (priorConfig === undefined) delete process.env.DEPLOY_GATE_CONFIG; else process.env.DEPLOY_GATE_CONFIG = priorConfig;
		fs.rmSync(root, { recursive: true, force: true });
	}
});
