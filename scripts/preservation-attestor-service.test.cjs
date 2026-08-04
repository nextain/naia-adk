#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const attestor = require("./preservation-attestor-service.cjs");

let passed = 0;
function test(label, body) {
	try { body(); passed += 1; process.stdout.write(`ok - ${label}\n`); }
	catch (error) { process.stderr.write(`not ok - ${label}: ${error.stack || error}\n`); process.exitCode = 1; }
}

function tempRoot() { return fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "attestor-test-")); }
function repositoryId(root) {
	const stat = fs.statSync(root);
	return attestor.sha256(attestor.canonicalJson({ path: fs.realpathSync(root), dev: String(stat.dev), ino: String(stat.ino) }));
}

test("policy loader pins both core modules and has no same-user production fallback", () => {
	const root = tempRoot();
	const previous = process.env.NODE_ENV;
	try {
		process.env.NODE_ENV = "test";
		const stateRoot = path.join(root, "state");
		fs.mkdirSync(stateRoot, { mode: 0o700 });
		const keys = crypto.generateKeyPairSync("ed25519");
		const keyPath = path.join(root, "key.pem");
		const publicKeyPath = path.join(root, "public.pem");
		fs.writeFileSync(keyPath, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
		fs.writeFileSync(publicKeyPath, keys.publicKey.export({ type: "spki", format: "pem" }));
		const workerPath = path.resolve(__dirname, "preservation-attestor-service.cjs");
		const executionPath = path.resolve(__dirname, "../.agents/hooks/core/preservation-execution-runner.js");
		const snapshotPath = path.resolve(__dirname, "../.agents/hooks/core/preservation-snapshot.js");
		const policyPath = path.join(root, "policy.json");
			const policy = { version: 1, credential_id: "test-attestor", credential_epoch: "epoch-1", worker_digest: attestor.sha256(fs.readFileSync(workerPath)), execution_runner_digest: attestor.sha256(fs.readFileSync(executionPath)), snapshot_digest: attestor.sha256(fs.readFileSync(snapshotPath)), private_key_path: keyPath, public_key_path: publicKeyPath, state_root: stateRoot, sandbox_path: "/usr/bin/bwrap", node_path: process.execPath, git_path: "/usr/bin/git", adapter_path: ".agents/skills/manage-discord-sessions/preservation-adapter.cjs", allowed_adapter_digests: ["a".repeat(64)], allowed_sandbox_digests: ["b".repeat(64)], allowed_node_digests: ["c".repeat(64)], allowed_git_digests: ["d".repeat(64)], repositories: [], registrations: [] };
		fs.writeFileSync(policyPath, JSON.stringify(policy));
		assert.equal(attestor.loadPolicy({ policyPath, workerPath, executionPath, snapshotPath, unsafeTestBoundary: true }).credential_id, "test-attestor");
		policy.execution_runner_digest = "f".repeat(64);
		fs.writeFileSync(policyPath, JSON.stringify(policy));
		assert.throws(() => attestor.loadPolicy({ policyPath, workerPath, executionPath, snapshotPath, unsafeTestBoundary: true }), (error) => error.code === "preservation_attestor_execution_core_drift");
		const repo = path.join(root, "repo");
		fs.mkdirSync(repo);
		assert.throws(() => attestor.repositoryPolicy({ repositories: [{ path: fs.realpathSync(repo), repository_id: repositoryId(repo) }], uid: process.geteuid(), unsafeTestBoundary: false }, repo), (error) => error.code === "preservation_attestor_same_uid_forbidden");
	} finally { process.env.NODE_ENV = previous; fs.rmSync(root, { recursive: true, force: true }); }
});

test("service requires preregistration, uses planning revision for baseline, and seals protected evidence", () => {
	const root = tempRoot();
	try {
		const repository = path.join(root, "repo");
		const stateRoot = path.join(root, "state");
		fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
		const unitRoot = path.join(repository, ".agents", "harness", "units", "UNIT-test");
		fs.mkdirSync(unitRoot, { recursive: true });
		const contract = { id: "CONTRACT-test", preservation: { baseline_ref: "b".repeat(40), inventory: { surface_ids: ["surface-test"], surface_inventory_digest: "d".repeat(64) } } };
		const head = { contract_digest: attestor.sha256(attestor.canonicalJson(contract)), scope_epoch: 2, work_revision: 9, lifecycle: "active" };
		const binding = { state: "active", contract_id: contract.id, binding_epoch: 4, planning_work_revision: 3 };
		for (const [name, value] of Object.entries({ head, binding, contract })) fs.writeFileSync(path.join(unitRoot, `${name}.json`), JSON.stringify(value));
		const adapter = path.join(repository, "adapter.cjs");
		fs.writeFileSync(adapter, "module.exports={SURFACES:[{id:'surface-test'}]};\n");
		const keys = crypto.generateKeyPairSync("ed25519");
		const revisions = [];
			const snapshot = { digest: "f".repeat(64), git_digest: "d".repeat(64), repository: { common_path: repository, device: 1, inode: 2 } };
			const execution = {
				discoverRoots: () => ({ snapshot_roots: ["adapter.cjs"], adapter_digest: "a".repeat(64) }),
				run: (options) => ({ version: 1, challenge: options.challenge, run_id: `run-${options.phase}`, phase: options.phase, stage: options.stage, surface_id: options.surfaceId, subject_digest: options.snapshot.digest, git_digest: options.snapshot.git_digest, repository: options.snapshot.repository, adapter_digest: "a".repeat(64), inventory_digest: "0".repeat(64), reachable: true, state: "succeeded", parsed: { reachable: true, capabilities: ["capability-a"], entry_marker: "real-entry" }, sandbox: { executable_digest: "b".repeat(64) } }),
			issueReceipt: (evidence, bindingValue, signer, now = Date.now()) => { revisions.push(bindingValue.work_revision); const value = { ...evidence, ...bindingValue, receipt_id: attestor.sha256(`${evidence.challenge}:${bindingValue.work_revision}`), issued_at: now, expires_at: now + bindingValue.ttl_ms }; delete value.ttl_ms; return { ...value, signature: signer(Buffer.from(attestor.canonicalJson(value))).toString("base64") }; },
			verifyReceipt: () => ({ ok: true, errors: [] }),
		};
			const registration = { repository_id: repositoryId(repository), unit_id: "UNIT-test", contract_digest: head.contract_digest, scope_epoch: 2, binding_epoch: 4, planning_work_revision: 3, baseline_ref: "b".repeat(40), inventory_digest: "d".repeat(64), surface_ids: ["surface-test"] };
			const policy = { unsafeTestBoundary: true, uid: process.geteuid(), stateRoot, credential_id: "attestor-test", credential_epoch: "epoch-1", policy_digest: "9".repeat(64), worker_digest: "e".repeat(64), execution_runner_digest: "6".repeat(64), snapshot_digest: "7".repeat(64), privateKey: keys.privateKey, publicKey: keys.publicKey, adapter_path: "adapter.cjs", sandbox_path: "/usr/bin/bwrap", node_path: process.execPath, git_path: "/usr/bin/git", allowed_adapter_digests: ["a".repeat(64)], allowed_sandbox_digests: ["b".repeat(64)], allowed_node_digests: ["c".repeat(64)], allowed_git_digests: ["d".repeat(64)], repositories: [{ path: fs.realpathSync(repository), repository_id: repositoryId(repository) }], registrations: [registration] };
			const deps = { policy, execution, snapshot: { materialize: () => snapshot, verifyCurrentStable: () => true } };
			assert.throws(() => attestor.executeProbe({ operation: "probe", repository, unit_id: "UNIT-test", stage: "planning", phase: "baseline", surface_id: "surface-test" }, { ...deps, policy: { ...policy, registrations: [] } }), (error) => error.code === "preservation_attestor_registration_missing");
			attestor.executeProbe({ operation: "probe", repository, unit_id: "UNIT-test", stage: "planning", phase: "baseline", surface_id: "surface-test" }, deps);
		attestor.executeProbe({ operation: "probe", repository, unit_id: "UNIT-test", stage: "integration_completion", phase: "current", surface_id: "surface-test" }, deps);
		assert.deepEqual(revisions, [3, 9]);
		const decision = attestor.sealDecision({ operation: "seal", repository, unit_id: "UNIT-test" }, deps, Date.now());
		assert.equal(decision.state, "release_evidence_succeeded");
		assert.equal(decision.receipt_ids.length, 2);
		assert(crypto.verify(null, Buffer.from(attestor.canonicalJson(attestor.decisionPayload(decision))), keys.publicKey, Buffer.from(decision.signature, "base64")));
		const changed = { ...contract, preservation: { ...contract.preservation, baseline_ref: "c".repeat(40) } };
		fs.writeFileSync(path.join(unitRoot, "contract.json"), JSON.stringify(changed));
		fs.writeFileSync(path.join(unitRoot, "head.json"), JSON.stringify({ ...head, contract_digest: attestor.sha256(attestor.canonicalJson(changed)) }));
		assert.throws(() => attestor.sealDecision({ operation: "seal", repository, unit_id: "UNIT-test" }, deps), (error) => error.code === "preservation_attestor_protected_binding_mismatch");
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

if (!process.exitCode) process.stdout.write(`preservation attestor service: PASS (${passed})\n`);
