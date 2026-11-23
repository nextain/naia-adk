"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { verifiedPlanBinding } = require("../lib/deploy-readiness.js");
function fixture(t, extension) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "verified-plugin-context-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(path.join(root, "config"));
	fs.writeFileSync(path.join(root, "config/deploy-gate.json"), JSON.stringify({ plugin: "config/policy.cjs", gatesDir: "/ignored/configuration/path" }));
	fs.writeFileSync(path.join(root, "config/policy.cjs"), extension);
	const entry = { id: "s1", commands: ["printf fixture"], files: {} };
	const plan = { services: ["local:fixture"], scenario: [entry] };
	const gatesDir = path.join(root, ".agents/progress/exact-plan/gates");
	return { root, gatesDir, binding: { plan, entry, command: entry.commands[0], cwd: root, gatesDir } };
}
test("plan binding extension receives the exact existing verified gates directory", t => {
	const f = fixture(t, "module.exports={verifyPlanBinding(ctx){return {ok:true,fact:String(ctx.gatesDir)}}};");
	const result = verifiedPlanBinding(f.binding, "candidate", "plan", ["local:fixture"], f.root);
	assert.equal(result.ok, true, result.why); assert.equal(result.fact, f.gatesDir);
});
test("service assessment extension receives the same gates directory", t => {
	const f = fixture(t, "module.exports={assessService(_service,ctx){return {ok:true,fact:String(ctx.gatesDir)}}};");
	const result = verifiedPlanBinding(f.binding, "candidate", "plan", ["local:fixture"], f.root);
	assert.equal(result.ok, true, result.why); assert.equal(result.fact, f.gatesDir);
});
test("legacy plugins still work and missing context never picks a configuration path", t => {
	const f = fixture(t, "module.exports={verifyPlanBinding(ctx){return {ok:true,fact:ctx.gatesDir===undefined?'legacy':'unexpected'}}};");
	delete f.binding.gatesDir;
	const result = verifiedPlanBinding(f.binding, "candidate", "plan", ["local:fixture"], f.root);
	assert.equal(result.ok, true, result.why); assert.equal(result.fact, "legacy");
});
