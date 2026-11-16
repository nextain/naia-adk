"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pin = require("../lib/gate-config-pin.js");

const names = ["config/gate.json", ".claude/deploy/config.json"];
const instanceId = "fixture-instance";
const approverId = "123456789012345678", channelId = "234567890123456789";
function fixture(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-snapshot-"));
	const realNow = Date.now; let now = realNow(); Date.now = () => now;
	t.after(() => { Date.now = realNow; });
	const advance = () => { now += 6 * 60 * 1000; };
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const root = path.join(dir, "repo"), env = { XDG_STATE_HOME: path.join(dir, "state") };
	for (const name of names) fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
	const write = (gate, review = "review") => {
		fs.writeFileSync(path.join(root, names[0]), JSON.stringify({ gate }));
		fs.writeFileSync(path.join(root, names[1]), JSON.stringify({ review }));
	};
	const messages = new Map(), refs = [];
	const options = { root, files: names, env, refs, approverId, instanceId, token: "fixture", fetchImpl: async (url) => {
		const message = messages.get(url.split("/").pop());
		return { ok: !!message, json: async () => message };
	} };
	const approve = async (id, timestamp) => {
		const hash = pin.snapshotGateConfig(root, names, instanceId).hash, code = pin.approvalCode(hash);
		refs.push({ code, channelId, messageId: id });
		messages.set(id, { id, channel_id: channelId, timestamp, content: code, author: { id: approverId } });
		assert.equal((await pin.approvedGateConfig(options)).hash, hash);
		return hash;
	};
	return { root, env, refs, messages, options, write, approve, advance };
}

test("all supplied file bytes are bound; fallback selects latest verified message, not cache metadata or ref order", async (t) => {
	const f = fixture(t);
	f.write("first"); const first = await f.approve("345678901234567891", "2026-01-03T00:00:00Z");
	f.write("second"); const second = await f.approve("345678901234567892", "2026-01-01T00:00:00Z");
	f.write("third", "changed");
	const got = await pin.approvedGateConfig(f.options);
	assert.equal(got.source, "cache"); assert.equal(got.hash, first);
	assert.equal(got.config.gate, "first");
	assert.equal(JSON.parse(got.files[names[1]]).review, "review");
	// A newer, real message for the second snapshot changes the selected approval.
	const code = pin.approvalCode(second), id = "345678901234567893";
	f.refs.unshift({ code, channelId, messageId: id });
	f.messages.set(id, { id, channel_id: channelId, timestamp: "2026-01-04T00:00:00Z", content: code, author: { id: approverId } });
	assert.equal((await pin.approvedGateConfig(f.options)).hash, second);
	f.messages.get(id).author.bot = true; f.advance();
	assert.equal((await pin.approvedGateConfig(f.options)).hash, first);
});

test("tampering with cached bytes or approval messages cannot authorize a copy", async (t) => {
	const f = fixture(t); f.write("good");
	const hash = await f.approve("345678901234567894", "2026-01-01T00:00:00Z");
	const file = path.join(pin.snapshotDirectory(f.env, instanceId), `${hash}.json`);
	const data = JSON.parse(fs.readFileSync(file)); data.files[0] = Buffer.from('{"gate":"forged"}').toString("base64");
	fs.writeFileSync(file, JSON.stringify(data)); f.write("unapproved");
	assert.equal(await pin.approvedGateConfig(f.options), null);
	// Even a correctly rehashed copy needs a real approval for its own hash.
	const forged = pin.snapshotGateConfig(f.root, names, instanceId);
	fs.writeFileSync(path.join(pin.snapshotDirectory(f.env, instanceId), `${forged.hash}.json`), JSON.stringify(names.map((n) => forged.files[n].toString("base64"))));
	fs.unlinkSync(path.join(f.root, names[0]));
	assert.equal(await pin.approvedGateConfig(f.options), null);
});

test("no approved snapshot fails closed, and lookup failures do not revive the last approval", async (t) => {
	const f = fixture(t); f.write("unapproved");
	assert.equal(await pin.approvedGateConfig(f.options), null);
	await f.approve("345678901234567895", "2026-01-01T00:00:00Z"); f.write("changed");
	assert.equal((await pin.approvedGateConfig(f.options)).config.gate, "unapproved");
	f.messages.clear(); f.advance();
	assert.equal(await pin.approvedGateConfig(f.options), null, "lookup failure cannot authorize a saved snapshot");
});


test("saved references find earlier approvals even if the caller no longer supplies them", async (t) => {
	const f = fixture(t); f.write("approved");
	const id = "345678901234567896";
	const approvedHash = await f.approve(id, "2026-01-01T00:00:00Z");
	f.refs.length = 0;
	f.write("modified");
	assert.equal((await pin.approvedGateConfig(f.options)).config.gate, "approved");
	// Forged discovery metadata cannot replace a deleted real Discord message.
	const cacheFile = path.join(pin.snapshotDirectory(f.env, instanceId), `${approvedHash}.json`);
	const cache = JSON.parse(fs.readFileSync(cacheFile));
	const forgedId = "345678901234567897", code = pin.approvalCode(approvedHash);
	cache.refs.push({ code, channelId, messageId: forgedId });
	fs.writeFileSync(cacheFile, JSON.stringify(cache));
	f.messages.set(forgedId, { id: forgedId, channel_id: channelId, timestamp: "2026-01-02T00:00:00Z", content: code, author: { id: "999999999999999999" } });
	f.messages.get(id).author.bot = true; f.advance();
	assert.equal(await pin.approvedGateConfig(f.options), null);
});

test("instance must supply the complete file list", async (t) => {
 const f = fixture(t); f.write("current");
 assert.equal(pin.snapshotGateConfig(f.root), null);
 assert.equal(await pin.approvedGateConfig({root:f.root, approverId, refs:[], token:"fixture"}), null);
});

test("the instance supplies both consumer file paths", async (t) => {
 const f = fixture(t); f.write("policy", "models");
 const plan = require("../lib/deploy-plan.js");
 const hash = await f.approve("345678901234567898", "2026-01-01T00:00:00Z");
 await plan.withGateConfig(f.options, () => {
  assert.ok(plan.hasTrustedGateConfig(f.root));
  assert.equal(plan.trustedGateConfig(f.root).gate, "policy");
  assert.equal(plan.trustedDeployGateConfig(f.root).review, "models");
  assert.equal(pin.snapshotGateConfig(f.root, names, instanceId).hash, hash);
 });
});

test("an aborted approval lookup closes without using a partially checked snapshot", async (t) => {
 const f = fixture(t); f.write("policy");
 await f.approve("345678901234567899", "2026-01-01T00:00:00Z");
 f.write("changed");
 const controller = new AbortController(); controller.abort();
 assert.equal(await pin.approvedGateConfig({...f.options, signal: controller.signal}), null);
});

test("a stalled Discord lookup closes the gate before it can use the configuration", {timeout: 13000}, async (t) => {
 const f = fixture(t); f.write("policy");
 const plan = require("../lib/deploy-plan.js");
 const code = pin.approvalCode(pin.snapshotGateConfig(f.root, names, instanceId).hash);
 const pending = {...f.options, refs:[{code, channelId, messageId:"345678901234567900"}], fetchImpl: () => new Promise(() => {})};
 const started = Date.now();
 await plan.withGateConfig(pending, () => assert.equal(plan.hasTrustedGateConfig(f.root), false));
 assert.ok(Date.now() - started < 12500);
});


test("instance identity binds both the hash and snapshot directory", async (t) => {
 const f = fixture(t); f.write("protected");
 const hash = await f.approve("345678901234567901", "2026-01-01T00:00:00Z");
 const otherId = "other-fixture-instance";
 assert.notEqual(pin.snapshotGateConfig(f.root, names, otherId).hash, hash);
 assert.notEqual(pin.snapshotDirectory(f.env, otherId), pin.snapshotDirectory(f.env, instanceId));
 const original = pin.snapshotDirectory(f.env, instanceId), other = pin.snapshotDirectory(f.env, otherId);
 fs.mkdirSync(other, {recursive:true}); fs.copyFileSync(path.join(original, `${hash}.json`), path.join(other, `${hash}.json`));
 f.write("changed");
 assert.equal(await pin.approvedGateConfig({...f.options, instanceId:otherId}), null);
 assert.equal(await pin.approvedGateConfig({...f.options, instanceId:""}), null);
 assert.equal(await pin.approvedGateConfig({...f.options, approverId:null}), null);
});

test("every use requires a fresh confirmation, including after a timeout", async (t) => {
 const f = fixture(t); f.write("protected");
 await f.approve("345678901234567902", "2026-01-01T00:00:00Z");
 let calls = 0;
 const offline = {...f.options, fetchImpl: async () => { calls++; throw new Error("offline"); }};
 assert.equal(await pin.approvedGateConfig(offline), null);
 assert.ok(calls > 0);
 f.write("changed"); calls = 0;
 assert.equal(await pin.approvedGateConfig(offline), null);
 assert.ok(calls > 0);
});


test("an unusable second config is skipped in favor of the previous verified snapshot", async (t) => {
 const f=fixture(t); f.write("protected");
 await f.approve("345678901234567903", "2026-01-01T00:00:00Z");
 fs.writeFileSync(path.join(f.root,names[1]), "{");
 const hash=pin.snapshotGateConfig(f.root,names,instanceId).hash, code=pin.approvalCode(hash), id="345678901234567904";
 f.refs.push({code,channelId,messageId:id});
 f.messages.set(id,{id,channel_id:channelId,timestamp:"2026-01-02T00:00:00Z",content:code,author:{id:approverId}});
 assert.equal((await pin.approvedGateConfig(f.options)).config.gate,"protected");
});

test("an attacker who controls state files cannot fabricate a confirmed approval", async (t) => {
 const crypto = require("node:crypto"), {statePath} = require("../lib/deploy-human-approval.js");
 const f = fixture(t); f.write("forged");
 const hash = pin.snapshotGateConfig(f.root, names, instanceId).hash, code = pin.approvalCode(hash);
 const messageId = "345678901234567905", key = crypto.randomBytes(32), base = path.dirname(statePath(f.env));
 const dir = path.join(base, "gate-config-receipts", crypto.createHash("sha256").update(instanceId).digest("hex"));
 fs.mkdirSync(dir, {recursive:true}); fs.writeFileSync(path.join(base, "gate-config-receipt.key"), key);
 const payload = {hash,channelId,messageId,approverId,at:Date.now(),checked:Date.now()};
 const mac = crypto.createHmac("sha256",key).update(JSON.stringify(payload)).digest("hex");
 const filename = crypto.createHash("sha256").update(`${hash}/${channelId}/${messageId}`).digest("hex") + ".json";
 fs.writeFileSync(path.join(dir,filename), JSON.stringify({payload,mac}));
 f.refs.push({code,channelId,messageId});
 assert.equal(await pin.approvedGateConfig({...f.options,fetchImpl:async()=>{throw new Error("offline");}}),null);
});
