"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const execution = require("./preservation-execution-runner.js");

const PUBLIC_KEY_PATH = "/etc/naia-preservation/public-key.pem";
const TRUST_ANCHOR_PATH = "/etc/naia-preservation/verifier.json";
const MAX_BYTES = 1024 * 1024;
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/;

function canonicalJson(value) { return execution.canonicalJson(value); }
function sha256(value) { return execution.sha256(value); }

function readRegular(file, maxBytes = MAX_BYTES) {
	const resolved = path.resolve(file);
	if (!path.isAbsolute(file) || fs.realpathSync(file) !== resolved) throw new Error("not a pinned regular file");
	const before = fs.lstatSync(file, { bigint: true });
	if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maxBytes)) throw new Error("not a pinned regular file");
	const bytes = fs.readFileSync(file);
	const after = fs.lstatSync(file, { bigint: true });
	for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) if (before[field] !== after[field]) throw new Error("file changed while reading");
	return { bytes, stat: after };
}

function loadPinnedPublicKey(options = {}) {
	try {
		const unsafeTestBoundary = options.unsafeTestBoundary === true && process.env.NODE_ENV === "test";
		const file = unsafeTestBoundary && options.publicKeyPath ? options.publicKeyPath : PUBLIC_KEY_PATH;
		const loaded = readRegular(file);
		if (!unsafeTestBoundary && (Number(loaded.stat.uid) !== 0 || (Number(loaded.stat.mode) & 0o022) !== 0)) return null;
		return crypto.createPublicKey(loaded.bytes);
	} catch {
		return null;
	}
}

function loadTrustAnchor(options = {}) {
	try {
		const unsafeTestBoundary = options.unsafeTestBoundary === true && process.env.NODE_ENV === "test";
		if (unsafeTestBoundary && options.trustAnchor && options.publicKey) return { ...options.trustAnchor, publicKey: options.publicKey };
		const loaded = readRegular(TRUST_ANCHOR_PATH);
		if (Number(loaded.stat.uid) !== 0 || (Number(loaded.stat.mode) & 0o022) !== 0) return null;
		const anchor = JSON.parse(loaded.bytes);
		const keys = ["version", "credential_id", "credential_epoch", "policy_digest", "tcb", "allowed_sandbox_digests"];
		const tcbKeys = ["execution_runner_digest", "snapshot_digest", "worker_digest"];
		if (!anchor || anchor.version !== 1 || canonicalJson(Object.keys(anchor).sort()) !== canonicalJson(keys.sort()) || !ID.test(anchor.credential_id || "") || !ID.test(anchor.credential_epoch || "") || !anchor.tcb || canonicalJson(Object.keys(anchor.tcb).sort()) !== canonicalJson(tcbKeys.sort()) || ![anchor.policy_digest, ...Object.values(anchor.tcb)].every((value) => DIGEST.test(value || "")) || !Array.isArray(anchor.allowed_sandbox_digests) || !anchor.allowed_sandbox_digests.length || anchor.allowed_sandbox_digests.some((value) => !DIGEST.test(value || ""))) return null;
		const publicKey = loadPinnedPublicKey(options);
		return publicKey ? { ...anchor, publicKey } : null;
	} catch {
		return null;
	}
}

function readDecision(file) {
	try {
		const loaded = readRegular(file);
		return { decision: JSON.parse(loaded.bytes), errors: [] };
	} catch (error) {
		return { decision: null, errors: [error.code === "ENOENT" ? "preservation_real_entry_attestation_pending" : "preservation_decision_invalid"] };
	}
}

function decisionPayload(decision) {
	const payload = JSON.parse(JSON.stringify(decision));
	delete payload.signature;
	return payload;
}

function repositoryId(cwd) {
	const root = fs.realpathSync(cwd);
	const stat = fs.statSync(root);
	return sha256(canonicalJson({ path: root, dev: String(stat.dev), ino: String(stat.ino) }));
}

function evaluate(options) {
	const trust = loadTrustAnchor(options);
	const inventory = options.contract && options.contract.preservation && options.contract.preservation.inventory;
	if (!trust || !inventory) return { ok: false, errors: ["preservation_execution_unprovisioned"], evidence_digest: null };
	const loaded = readDecision(options.file);
	if (loaded.errors.length) return { ok: false, errors: loaded.errors, evidence_digest: null };
	const decision = loaded.decision;
	const errors = [];
	const expected = {
		repository_id: repositoryId(options.cwd),
		unit_id: options.unitId,
		contract_digest: options.head.contract_digest,
		scope_epoch: options.head.scope_epoch,
		binding_epoch: options.binding.binding_epoch,
		planning_work_revision: options.binding.planning_work_revision,
		current_work_revision: options.head.work_revision,
		baseline_ref: options.contract.preservation.baseline_ref,
		contract_inventory_digest: inventory.surface_inventory_digest,
		credential_id: trust.credential_id,
		credential_epoch: trust.credential_epoch,
		policy_digest: trust.policy_digest,
		surface_ids: [...inventory.surface_ids].sort(),
	};
	const tcb = decision && decision.tcb;
	const repositorySnapshot = decision && decision.repository_snapshot;
	const validRepositorySnapshot = repositorySnapshot && canonicalJson(Object.keys(repositorySnapshot).sort()) === canonicalJson(["common_path", "device", "inode"]) && typeof repositorySnapshot.common_path === "string" && path.isAbsolute(repositorySnapshot.common_path) && Number.isSafeInteger(repositorySnapshot.device) && Number.isSafeInteger(repositorySnapshot.inode);
	if (!decision || decision.version !== 1 || decision.state !== "release_evidence_succeeded" || !DIGEST.test(decision.decision_id || "") || !DIGEST.test(decision.evidence_digest || "") || !DIGEST.test(decision.current_subject_digest || "") || !DIGEST.test(decision.current_git_digest || "") || !DIGEST.test(decision.current_adapter_digest || "") || !DIGEST.test(decision.current_inventory_digest || "") || !validRepositorySnapshot || !Array.isArray(decision.receipt_ids) || decision.receipt_ids.length !== expected.surface_ids.length * 2 || decision.receipt_ids.some((value) => !DIGEST.test(value)) || !tcb || Object.keys(tcb).sort().join(",") !== "execution_runner_digest,sandbox_digest,snapshot_digest,worker_digest" || Object.values(tcb).some((value) => !DIGEST.test(value))) errors.push("preservation_decision_shape_invalid");
	for (const [field, value] of Object.entries(expected)) if (canonicalJson(decision && decision[field]) !== canonicalJson(value)) errors.push(`preservation_decision_${field}_mismatch`);
	for (const [field, value] of Object.entries(trust.tcb)) if (!tcb || tcb[field] !== value) errors.push(`preservation_decision_tcb_${field}_mismatch`);
	if (!tcb || !trust.allowed_sandbox_digests.includes(tcb.sandbox_digest)) errors.push("preservation_decision_tcb_sandbox_digest_mismatch");
	if (!decision || !Number.isInteger(decision.issued_at) || !Number.isInteger(decision.expires_at) || decision.issued_at > options.now || decision.expires_at < options.now) errors.push("preservation_decision_expired");
	try {
		if (!crypto.verify(null, Buffer.from(canonicalJson(decisionPayload(decision))), trust.publicKey, Buffer.from(decision.signature || "", "base64"))) errors.push("preservation_decision_signature_invalid");
	} catch { errors.push("preservation_decision_signature_invalid"); }
	return { ok: errors.length === 0, errors: [...new Set(errors)], evidence_digest: errors.length ? null : decision.evidence_digest };
}

module.exports = { PUBLIC_KEY_PATH, TRUST_ANCHOR_PATH, decisionPayload, evaluate, loadPinnedPublicKey, loadTrustAnchor, readDecision, repositoryId };
