#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const snapshotCore = require("./preservation-snapshot.js");
const runner = require("./preservation-execution-runner.js");

let passed = 0;
function test(label, body) {
	try { body(); passed += 1; process.stdout.write(`ok - ${label}\n`); }
	catch (error) { process.stderr.write(`not ok - ${label}: ${error.stack || error}\n`); process.exitCode = 1; }
}

const root = path.resolve(__dirname, "../../..");
const adapterPath = path.join(root, ".agents/skills/manage-discord-sessions/preservation-adapter.cjs");
const sandboxExecutable = "/usr/bin/bwrap";
const allowedAdapterDigests = [runner.sha256(fs.readFileSync(adapterPath))];
const allowedExecutableDigests = [runner.sha256(fs.readFileSync(process.execPath))];
const allowedSandboxDigests = fs.existsSync(sandboxExecutable) ? [runner.sha256(fs.readFileSync(sandboxExecutable))] : [];
const expectedSurfaceIds = require(adapterPath).SURFACES.map((surface) => surface.id);
const common = { adapterPath, nodeExecutable: process.execPath, sandboxExecutable, allowedAdapterDigests, allowedExecutableDigests, allowedSandboxDigests, expectedSurfaceIds };
const baselineRef = "dd20504f57548dd27cb0e7971905495091077d74";

function withSnapshot(body, phase = "current") {
	const temp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "preservation-runner-test-"));
	try {
		const discovery = runner.discoverRoots(common);
		const snapshot = snapshotCore.materialize({ cwd: root, destination: path.join(temp, "snapshot"), roots: discovery.snapshot_roots, phase, ref: phase === "baseline" ? baselineRef : undefined, sha256: runner.sha256 });
		return body({ temp, discovery, snapshot });
	} finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

if (process.platform !== "linux" || !fs.existsSync(sandboxExecutable)) {
	test("unsupported platform fails closed", () => {
		assert.throws(() => runner.discoverRoots(common), /sealed preservation runner|trusted executable/);
	});
} else {
	test("all ten Discord surfaces reach their focused production paths in a sealed sandbox", () => withSnapshot(({ discovery, snapshot }) => {
		assert.deepStrictEqual(discovery.snapshot_roots, [".agents/skills/manage-discord-sessions", "naia-settings/messenger-sessions/config.example.json"]);
		const adapter = require(adapterPath);
		for (const surface of adapter.SURFACES) {
			const evidence = runner.run({ ...common, challenge: crypto.randomBytes(32).toString("hex"), snapshot, phase: "current", stage: "integration_completion", surfaceId: surface.id, verifySubjectStable: () => snapshotCore.verifyCurrentStable(root, discovery.snapshot_roots, snapshot, runner.sha256) });
			assert.strictEqual(evidence.parsed.reachable, true, surface.id);
			assert.deepStrictEqual(evidence.parsed.capabilities, adapter.capabilities(surface, "current"), surface.id);
			assert.strictEqual(evidence.sandbox.no_network, true);
			assert.strictEqual(evidence.sandbox.subject_read_only, true);
		}
	}));

	test("all ten baseline Discord surfaces remain reachable from the immutable baseline", () => withSnapshot(({ snapshot }) => {
		const adapter = require(adapterPath);
		for (const surface of adapter.SURFACES) {
			const evidence = runner.run({ ...common, challenge: crypto.randomBytes(32).toString("hex"), snapshot, phase: "baseline", stage: "planning", surfaceId: surface.id });
			assert.strictEqual(evidence.parsed.reachable, true, surface.id);
			for (const capability of adapter.capabilities(surface, "baseline")) assert(evidence.parsed.capabilities.includes(capability), `${surface.id}:${capability}`);
		}
	}, "baseline"));

	test("live evidence signs once and verifies against its protected binding", () => withSnapshot(({ discovery, snapshot }) => {
		const keys = crypto.generateKeyPairSync("ed25519");
		const evidence = runner.run({ ...common, challenge: crypto.randomBytes(32).toString("hex"), snapshot, phase: "current", stage: "integration_completion", surfaceId: "messenger-config-and-execution-revision", verifySubjectStable: () => snapshotCore.verifyCurrentStable(root, discovery.snapshot_roots, snapshot, runner.sha256) });
		const binding = { repository_id: "c".repeat(64), unit_id: "UNIT-test", contract_digest: "a".repeat(64), scope_epoch: 2, binding_epoch: 3, work_revision: 4, credential_id: "preservation-test", credential_epoch: "epoch-1", policy_digest: "9".repeat(64), baseline_ref: "b".repeat(40), runner_digest: "d".repeat(64), contract_inventory_digest: "e".repeat(64), ttl_ms: 48 * 60 * 60 * 1000 };
		const receipt = runner.issueReceipt(evidence, binding, (bytes) => crypto.sign(null, bytes, keys.privateKey), 10_000);
		assert.strictEqual(receipt.expires_at - receipt.issued_at, 48 * 60 * 60 * 1000);
		assert.throws(() => runner.issueReceipt(evidence, binding, () => "forged", 10_000), (error) => error.code === "preservation_live_evidence_missing");
		const options = { now: 10_001, publicKey: keys.publicKey, expected: { unit_id: binding.unit_id, stage: "integration_completion", work_revision: 4 }, allowedAdapterDigests, allowedExecutableDigests };
		assert.deepEqual(runner.verifyReceipt(receipt, options), { ok: true, errors: [] });
	}));

	test("tampering, wrong binding, and unpinned executables fail closed", () => withSnapshot(({ discovery, snapshot }) => {
		const evidence = runner.run({ ...common, challenge: crypto.randomBytes(32).toString("hex"), snapshot, phase: "current", stage: "integration_completion", surfaceId: "messenger-config-and-execution-revision", verifySubjectStable: () => snapshotCore.verifyCurrentStable(root, discovery.snapshot_roots, snapshot, runner.sha256) });
		evidence.parsed.reachable = false;
		assert.throws(() => runner.issueReceipt(evidence, { repository_id: "c".repeat(64), unit_id: "UNIT-test", contract_digest: "a".repeat(64), scope_epoch: 1, binding_epoch: 1, work_revision: 1, credential_id: "preservation-test", credential_epoch: "epoch-1", policy_digest: "9".repeat(64), baseline_ref: "b".repeat(40), runner_digest: "d".repeat(64), contract_inventory_digest: "e".repeat(64) }, () => "forged"), (error) => error.code === "preservation_live_evidence_missing");
		assert.throws(() => runner.discoverRoots({ ...common, allowedExecutableDigests: ["0".repeat(64)] }), (error) => error.code === "preservation_executable_not_allowed");
		fs.appendFileSync(path.join(snapshot.destination, ".agents/skills/manage-discord-sessions/helper/cli.mjs"), "\n// tampered after seal\n");
		assert.throws(() => runner.run({ ...common, challenge: crypto.randomBytes(32).toString("hex"), snapshot, phase: "current", stage: "integration_completion", surfaceId: "messenger-config-and-execution-revision" }), (error) => error.code === "preservation_subject_manifest_mismatch");
	}));

	test("generic Discord guard failures never count as production reachability", () => {
		const adapter = require(adapterPath);
		const input = { challenge: "a".repeat(64), phase: "current", subject_digest: "b".repeat(64), observation: { status: 3, signal: null, error_code: null, stdout: "", stderr: "No Discord session state\n" } };
		assert.deepStrictEqual(adapter.parse("cli-watch-default", input), { reachable: false, capabilities: [], entry_marker: "watch-default" });
		const oldTestOutput = { ...input, observation: { status: 0, signal: null, error_code: null, stdout: "DSO-003 CLI returns versioned job detail and watch events\npass 1\nfail 0\n", stderr: "" } };
		assert.deepStrictEqual(adapter.parse("cli-watch-default", oldTestOutput), { reachable: false, capabilities: [], entry_marker: "watch-default" });
	});
}

if (!process.exitCode) process.stdout.write(`preservation execution runner: PASS (${passed})\n`);
