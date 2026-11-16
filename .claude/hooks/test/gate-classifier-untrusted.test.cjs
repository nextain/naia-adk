"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const classifier = require("../lib/deploy-command-classifier.js");

test("untrusted settings close all executable forms, including reads and unknown extensions", () => {
	const commands = [
		"ssh demo-test.invalid hostname",
		"scp file demo-test.invalid:/tmp/file",
		"az vm show -n demo-test",
		"kubectl get pods",
		"docker -H ssh://demo-test.invalid compose ps",
		"env bash -c 'ssh demo-test.invalid hostname'",
		"VALUE=$(ssh demo-test.invalid hostname)",
		"./an-instance-specific-command",
	];
	for (const command of commands) {
		const hits = classifier.classifyProdMutations(command, process.cwd(), 0, false, "", { untrusted: true });
		assert.equal(hits[0]?.service, "unclassified:untrusted-config", command);
	}
	assert.deepEqual(classifier.classifyProdMutations("  ", process.cwd(), 0, false, "", { untrusted: true }), []);
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
