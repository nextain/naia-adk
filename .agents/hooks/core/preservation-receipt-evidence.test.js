#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const execution = require("./preservation-execution-runner.js");
const evidence = require("./preservation-receipt-evidence.js");

const keys = crypto.generateKeyPairSync("ed25519");
const digest = (letter) => letter.repeat(64);

function sign(decision) {
	return { ...decision, signature: crypto.sign(null, Buffer.from(execution.canonicalJson(evidence.decisionPayload(decision))), keys.privateKey).toString("base64") };
}

const previousNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "test";
const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "receipt-evidence-test-"));
try {
	const file = path.join(root, "decision.json");
	const repositoryId = evidence.repositoryId(root);
	const decision = sign({
		version: 1,
		decision_id: digest("1"),
		state: "release_evidence_succeeded",
		repository_id: repositoryId,
		unit_id: "UNIT-test",
		contract_digest: digest("a"),
		scope_epoch: 2,
		binding_epoch: 3,
		planning_work_revision: 1,
		current_work_revision: 4,
		baseline_ref: "b".repeat(40),
		contract_inventory_digest: digest("d"),
		credential_id: "attestor-test",
		credential_epoch: "epoch-1",
		policy_digest: digest("9"),
		tcb: { worker_digest: digest("5"), execution_runner_digest: digest("6"), snapshot_digest: digest("7"), sandbox_digest: digest("8") },
		current_subject_digest: digest("c"),
		current_git_digest: digest("e"),
		current_adapter_digest: digest("f"),
		current_inventory_digest: digest("0"),
		repository_snapshot: { common_path: root, device: 1, inode: 2 },
		surface_ids: ["surface-test"],
		receipt_ids: [digest("2"), digest("3")],
		evidence_digest: digest("4"),
		issued_at: 10_000,
		expires_at: 100_000,
	});
	fs.writeFileSync(file, `${JSON.stringify(decision)}\n`);
	const trustAnchor = { version: 1, credential_id: "attestor-test", credential_epoch: "epoch-1", policy_digest: digest("9"), tcb: { worker_digest: digest("5"), execution_runner_digest: digest("6"), snapshot_digest: digest("7") }, allowed_sandbox_digests: [digest("8")] };
	const options = { cwd: root, unitId: "UNIT-test", file, publicKey: keys.publicKey, trustAnchor, unsafeTestBoundary: true, contract: { preservation: { baseline_ref: "b".repeat(40), inventory: { surface_ids: ["surface-test"], surface_inventory_digest: digest("d") } } }, binding: { binding_epoch: 3, planning_work_revision: 1 }, head: { contract_digest: digest("a"), scope_epoch: 2, work_revision: 4 }, now: 20_000 };
	assert.equal(evidence.evaluate(options).ok, true);
	const forged = { ...decision, current_work_revision: 5 };
	fs.writeFileSync(file, `${JSON.stringify(forged)}\n`);
	assert(evidence.evaluate(options).errors.includes("preservation_decision_current_work_revision_mismatch"));
	fs.writeFileSync(file, `${JSON.stringify(decision)}\n`);
	assert(evidence.evaluate({ ...options, trustAnchor: { ...trustAnchor, policy_digest: digest("7") } }).errors.includes("preservation_decision_policy_digest_mismatch"));
	assert(evidence.evaluate({ ...options, trustAnchor: { ...trustAnchor, tcb: { ...trustAnchor.tcb, worker_digest: digest("4") } } }).errors.includes("preservation_decision_tcb_worker_digest_mismatch"));
	const oldEnv = process.env.PRESERVATION_EXECUTION_PUBLIC_KEY;
	process.env.PRESERVATION_EXECUTION_PUBLIC_KEY = crypto.generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
	assert.equal(evidence.evaluate(options).ok, true, "caller environment cannot replace the test-pinned verifier key");
	if (oldEnv === undefined) delete process.env.PRESERVATION_EXECUTION_PUBLIC_KEY; else process.env.PRESERVATION_EXECUTION_PUBLIC_KEY = oldEnv;
	assert.equal(evidence.evaluate({ ...options, unsafeTestBoundary: false, publicKey: keys.publicKey }).ok, false, "production ignores caller-supplied verifier keys");
	process.stdout.write("preservation decision evidence: PASS (protected key boundary, binding, forgery)\n");
} finally {
	process.env.NODE_ENV = previousNodeEnv;
	fs.rmSync(root, { recursive: true, force: true });
}
