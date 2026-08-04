#!/usr/bin/env node
"use strict";

const assert = require("assert");
const cp = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const attestor = require("./preservation-attestor-service.cjs");
const client = require("./preservation-execution-runner.cjs");
const execution = require("../.agents/hooks/core/preservation-execution-runner.js");
const snapshot = require("../.agents/hooks/core/preservation-snapshot.js");
const decisionEvidence = require("../.agents/hooks/core/preservation-receipt-evidence.js");

function digestFile(file) { return execution.sha256(fs.readFileSync(file)); }
function repositoryId(root) {
	const stat = fs.statSync(root);
	return attestor.sha256(attestor.canonicalJson({ path: fs.realpathSync(root), dev: String(stat.dev), ino: String(stat.ino) }));
}
function git(root, ...args) { return cp.execFileSync("/usr/bin/git", ["-C", root, ...args], { encoding: "utf8" }).trim(); }

const sourceRoot = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "attestor-e2e-"));
const repository = path.join(temp, "repo");
const stateRoot = path.join(temp, "state");
const previousNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "test";

try {
	fs.mkdirSync(path.join(repository, ".agents", "skills"), { recursive: true });
	fs.cpSync(path.join(sourceRoot, ".agents", "skills", "manage-discord-sessions"), path.join(repository, ".agents", "skills", "manage-discord-sessions"), { recursive: true });
	fs.mkdirSync(path.join(repository, "naia-settings", "messenger-sessions"), { recursive: true });
	fs.copyFileSync(path.join(sourceRoot, "naia-settings", "messenger-sessions", "config.example.json"), path.join(repository, "naia-settings", "messenger-sessions", "config.example.json"));
	fs.mkdirSync(stateRoot, { mode: 0o700 });
	git(repository, "init", "-q");
	git(repository, "add", ".");
	git(repository, "-c", "user.name=Preservation Test", "-c", "user.email=preservation@example.invalid", "commit", "-m", "baseline");
	const baselineRef = git(repository, "rev-parse", "HEAD");

	const adapterPath = path.join(repository, ".agents", "skills", "manage-discord-sessions", "preservation-adapter.cjs");
	const adapter = require(adapterPath);
	const surfaceIds = adapter.SURFACES.map((surface) => surface.id);
	const inventoryDigest = "d".repeat(64);
	const unitId = "UNIT-e2e";
	const unitRoot = path.join(repository, ".agents", "harness", "units", unitId);
	fs.mkdirSync(unitRoot, { recursive: true });
	const contract = { id: "CONTRACT-e2e", preservation: { baseline_ref: baselineRef, inventory: { surface_ids: surfaceIds, surface_inventory_digest: inventoryDigest } } };
	const head = { contract_digest: attestor.sha256(attestor.canonicalJson(contract)), scope_epoch: 2, work_revision: 9, lifecycle: "active" };
	const binding = { state: "active", contract_id: contract.id, binding_epoch: 4, planning_work_revision: 3 };
	for (const [name, value] of Object.entries({ head, binding, contract })) fs.writeFileSync(path.join(unitRoot, `${name}.json`), `${JSON.stringify(value)}\n`);

	const keys = crypto.generateKeyPairSync("ed25519");
	const workerPath = path.join(sourceRoot, "scripts", "preservation-attestor-service.cjs");
	const executionPath = path.join(sourceRoot, ".agents", "hooks", "core", "preservation-execution-runner.js");
	const snapshotPath = path.join(sourceRoot, ".agents", "hooks", "core", "preservation-snapshot.js");
	const policyDigest = "9".repeat(64);
	const sandboxDigest = digestFile("/usr/bin/bwrap");
	const repoId = repositoryId(repository);
	const registration = { repository_id: repoId, unit_id: unitId, contract_digest: head.contract_digest, scope_epoch: head.scope_epoch, binding_epoch: binding.binding_epoch, planning_work_revision: binding.planning_work_revision, baseline_ref: baselineRef, inventory_digest: inventoryDigest, surface_ids: surfaceIds };
	const policy = {
		unsafeTestBoundary: true, uid: process.geteuid(), stateRoot,
		credential_id: "attestor-e2e", credential_epoch: "epoch-1", policy_digest: policyDigest,
		worker_digest: digestFile(workerPath), execution_runner_digest: digestFile(executionPath), snapshot_digest: digestFile(snapshotPath),
		privateKey: keys.privateKey, publicKey: keys.publicKey,
		adapter_path: ".agents/skills/manage-discord-sessions/preservation-adapter.cjs",
		sandbox_path: "/usr/bin/bwrap", node_path: process.execPath, git_path: "/usr/bin/git",
		allowed_adapter_digests: [digestFile(adapterPath)], allowed_sandbox_digests: [sandboxDigest],
		allowed_node_digests: [digestFile(process.execPath)], allowed_git_digests: [digestFile("/usr/bin/git")],
		repositories: [{ path: fs.realpathSync(repository), repository_id: repoId }], registrations: [registration],
	};
	const deps = { policy, execution, snapshot };
	for (const surfaceId of surfaceIds) attestor.executeProbe({ operation: "probe", repository, unit_id: unitId, stage: "planning", phase: "baseline", surface_id: surfaceId }, deps);
	for (const surfaceId of surfaceIds) attestor.executeProbe({ operation: "probe", repository, unit_id: unitId, stage: "integration_completion", phase: "current", surface_id: surfaceId }, deps);

	const changedFile = path.join(repository, ".agents", "skills", "manage-discord-sessions", "helper", "cli.mjs");
	const original = fs.readFileSync(changedFile);
	fs.appendFileSync(changedFile, "\n// stale-seal attack\n");
	assert.throws(() => attestor.sealDecision({ operation: "seal", repository, unit_id: unitId }, deps), (error) => error.code === "preservation_attestor_current_snapshot_mismatch");
	fs.writeFileSync(changedFile, original);

	const decision = attestor.sealDecision({ operation: "seal", repository, unit_id: unitId }, deps);
	client.writeDecision({ repository, unit_id: unitId }, decision);
	const trustAnchor = { version: 1, credential_id: policy.credential_id, credential_epoch: policy.credential_epoch, policy_digest: policy.policy_digest, tcb: { worker_digest: policy.worker_digest, execution_runner_digest: policy.execution_runner_digest, snapshot_digest: policy.snapshot_digest }, allowed_sandbox_digests: policy.allowed_sandbox_digests };
	const evaluated = decisionEvidence.evaluate({ cwd: repository, unitId, file: path.join(unitRoot, "preservation", "decision.json"), contract, binding, head, now: Date.now(), unsafeTestBoundary: true, publicKey: keys.publicKey, trustAnchor });
	assert.deepEqual(evaluated.errors, []);
	assert.equal(decision.receipt_ids.length, surfaceIds.length * 2);
	assert.equal(decision.current_subject_digest.length, 64);
	assert.throws(() => attestor.sealDecision({ operation: "seal", repository, unit_id: unitId }, deps, Date.now() + 16 * 60 * 1000), (error) => error.code === "preservation_attestor_receipt_set_invalid");
	const db = new DatabaseSync(path.join(stateRoot, "attestor.sqlite"));
	try { db.prepare("DELETE FROM receipts WHERE phase='current' AND surface_id=?").run(surfaceIds[0]); }
	finally { db.close(); }
	assert.throws(() => attestor.sealDecision({ operation: "seal", repository, unit_id: unitId }, deps), (error) => error.code === "preservation_attestor_receipt_set_incomplete");
	process.stdout.write(`preservation attestor E2E: PASS (${surfaceIds.length * 2} actual probes, stale seal rejected)\n`);
} finally {
	process.env.NODE_ENV = previousNodeEnv;
	fs.rmSync(temp, { recursive: true, force: true });
}
