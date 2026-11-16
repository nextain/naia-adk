"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const classifier = require("../lib/deploy-command-classifier.js");

test("untrusted settings block classified remote targets and leave ordinary commands alone", () => {
 const blocked = ["ssh demo-test.invalid hostname", "scp file demo-test.invalid:/tmp/file", "env bash -c 'ssh demo-test.invalid hostname'", "VALUE=$(ssh demo-test.invalid hostname)"];
 for (const command of blocked) assert.ok(classifier.classifyProdMutations(command, process.cwd(), 0, false, "", {untrusted:true}).length, command);
 for (const command of ["ls", "git status", "npm test", "true"]) assert.deepEqual(classifier.classifyProdMutations(command, process.cwd(), 0, false, "", {untrusted:true}), [], command);
});

test("classifier config root comes from the hook, not cwd or environment", () => {
	const readiness = require("../lib/deploy-readiness.js");
	const originalLoader = readiness.loadDeployGateConfig;
	const oldRoot = process.env.DEPLOY_READINESS_ROOT;
	const oldConfig = process.env.DEPLOY_GATE_CONFIG;
	const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gate-root-test-"));
	const expected = path.resolve(__dirname, "../../..");
	const roots = [];
	try {
		fs.mkdirSync(path.join(fakeRoot, "config"));
		fs.writeFileSync(path.join(fakeRoot, "config", "deploy-gate.json"), JSON.stringify({ testHosts: ["demo.invalid"] }));
		process.env.DEPLOY_READINESS_ROOT = fakeRoot;
		process.env.DEPLOY_GATE_CONFIG = path.join(fakeRoot, "config", "deploy-gate.json");
		readiness.loadDeployGateConfig = root => { roots.push(root); return {}; };
		assert.ok(classifier.classifyProdMutations("scp file demo.invalid:/tmp/file", fakeRoot).length);
		assert.ok(roots.length);
		assert.ok(roots.every(root => root === expected), JSON.stringify(roots));
	} finally {
		readiness.loadDeployGateConfig = originalLoader;
		if (oldRoot === undefined) delete process.env.DEPLOY_READINESS_ROOT; else process.env.DEPLOY_READINESS_ROOT = oldRoot;
		if (oldConfig === undefined) delete process.env.DEPLOY_GATE_CONFIG; else process.env.DEPLOY_GATE_CONFIG = oldConfig;
		fs.rmSync(fakeRoot, { recursive: true, force: true });
	}
});
