#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const POLICY_PATH = "/etc/naia-preservation/attestor.json";
const PUBLIC_KEY_PATH = "/etc/naia-preservation/public-key.pem";
const INSTALLED_ROOT = "/usr/local/lib/naia-preservation";
const EXECUTION_PATH = path.join(INSTALLED_ROOT, "preservation-execution-runner.js");
const SNAPSHOT_PATH = path.join(INSTALLED_ROOT, "preservation-snapshot.js");
const SOCKET_FD = 3;
const MAX_REQUEST = 16 * 1024;
const BASELINE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const CURRENT_TTL_MS = 15 * 60 * 1000;
const DECISION_TTL_MS = 15 * 60 * 1000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40,64}$/;

function fail(code, message = code) { throw Object.assign(new Error(message), { code }); }
function canonicalize(value) {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
	return value;
}
function canonicalJson(value) { return JSON.stringify(canonicalize(value)); }
function sha256(value) { return crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : String(value)).digest("hex"); }

function validRegistration(value) {
	const keys = ["repository_id", "unit_id", "contract_digest", "scope_epoch", "binding_epoch", "planning_work_revision", "baseline_ref", "inventory_digest", "surface_ids"];
	return Boolean(value && typeof value === "object" && !Array.isArray(value) && canonicalJson(Object.keys(value).sort()) === canonicalJson(keys.sort()) && DIGEST.test(value.repository_id || "") && ID.test(value.unit_id || "") && DIGEST.test(value.contract_digest || "") && Number.isSafeInteger(value.scope_epoch) && value.scope_epoch >= 0 && Number.isSafeInteger(value.binding_epoch) && value.binding_epoch >= 0 && Number.isSafeInteger(value.planning_work_revision) && value.planning_work_revision >= 0 && COMMIT.test(value.baseline_ref || "") && DIGEST.test(value.inventory_digest || "") && Array.isArray(value.surface_ids) && value.surface_ids.length > 0 && value.surface_ids.every((item) => ID.test(item || "")));
}

function readPinnedFile(file, code) {
	let before;
	let bytes;
	let after;
	try {
		if (!path.isAbsolute(file) || fs.realpathSync(file) !== path.resolve(file)) fail(code);
		before = fs.lstatSync(file, { bigint: true });
		if (!before.isFile() || before.isSymbolicLink()) fail(code);
		bytes = fs.readFileSync(file);
		after = fs.lstatSync(file, { bigint: true });
	} catch (error) { if (error.code === code) throw error; fail(code); }
	for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) if (before[field] !== after[field]) fail(code);
	return { bytes, stat: after };
}

function protectedRootFile(file, expectedDigest, code, unsafeTestBoundary) {
	const loaded = readPinnedFile(file, code);
	if (!DIGEST.test(expectedDigest || "") || sha256(loaded.bytes) !== expectedDigest) fail(`${code}_drift`);
	if (!unsafeTestBoundary && (Number(loaded.stat.uid) !== 0 || (Number(loaded.stat.mode) & 0o022) !== 0)) fail(`${code}_unprotected`);
	return loaded;
}

function inside(parent, child) {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

function sameKeyPair(privateKey, publicKey) {
	try {
		const derived = crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" });
		const declared = crypto.createPublicKey(publicKey).export({ type: "spki", format: "der" });
		return Buffer.compare(derived, declared) === 0;
	} catch { return false; }
}

function loadPolicy(options = {}) {
	if (process.platform !== "linux") fail("preservation_attestor_platform_unsupported");
	const uid = options.uid ?? process.geteuid();
	const policyPath = options.policyPath || POLICY_PATH;
	const workerPath = options.workerPath || __filename;
	const executionPath = options.executionPath || EXECUTION_PATH;
	const snapshotPath = options.snapshotPath || SNAPSHOT_PATH;
	const unsafeTestBoundary = options.unsafeTestBoundary === true && process.env.NODE_ENV === "test";
	const policyFile = readPinnedFile(policyPath, "preservation_attestor_policy_invalid");
	if (!unsafeTestBoundary && (Number(policyFile.stat.uid) !== 0 || (Number(policyFile.stat.mode) & 0o022) !== 0)) fail("preservation_attestor_policy_unprotected");
	let policy;
	try { policy = JSON.parse(policyFile.bytes); } catch { fail("preservation_attestor_policy_invalid"); }
	const keys = ["version", "credential_id", "credential_epoch", "worker_digest", "execution_runner_digest", "snapshot_digest", "private_key_path", "public_key_path", "state_root", "sandbox_path", "node_path", "git_path", "adapter_path", "allowed_adapter_digests", "allowed_sandbox_digests", "allowed_node_digests", "allowed_git_digests", "repositories", "registrations"];
	if (!policy || policy.version !== 1 || canonicalJson(Object.keys(policy).sort()) !== canonicalJson(keys.sort()) || !ID.test(policy.credential_id || "") || !ID.test(policy.credential_epoch || "") || ![policy.worker_digest, policy.execution_runner_digest, policy.snapshot_digest].every((value) => DIGEST.test(value || ""))) fail("preservation_attestor_policy_invalid");
	for (const field of ["allowed_adapter_digests", "allowed_sandbox_digests", "allowed_node_digests", "allowed_git_digests"]) if (!Array.isArray(policy[field]) || !policy[field].length || policy[field].some((value) => !DIGEST.test(value))) fail("preservation_attestor_policy_invalid");
	if (!Array.isArray(policy.registrations) || policy.registrations.some((registration) => !validRegistration(registration))) fail("preservation_attestor_policy_invalid");
	protectedRootFile(workerPath, policy.worker_digest, "preservation_attestor_worker", unsafeTestBoundary);
	protectedRootFile(executionPath, policy.execution_runner_digest, "preservation_attestor_execution_core", unsafeTestBoundary);
	protectedRootFile(snapshotPath, policy.snapshot_digest, "preservation_attestor_snapshot_core", unsafeTestBoundary);
	const keyPath = policy.private_key_path === "@systemd-credential" ? path.join(process.env.CREDENTIALS_DIRECTORY || "", "signing-key.pem") : policy.private_key_path;
	const key = readPinnedFile(keyPath, "preservation_attestor_key_invalid");
	if (!unsafeTestBoundary && (Number(key.stat.uid) !== uid || (Number(key.stat.mode) & 0o077) !== 0)) fail("preservation_attestor_key_unprotected");
	if (!unsafeTestBoundary && policy.public_key_path !== PUBLIC_KEY_PATH) fail("preservation_attestor_public_key_path_invalid");
	const publicKey = readPinnedFile(policy.public_key_path, "preservation_attestor_public_key_invalid");
	if (!unsafeTestBoundary && (Number(publicKey.stat.uid) !== 0 || (Number(publicKey.stat.mode) & 0o022) !== 0)) fail("preservation_attestor_public_key_unprotected");
	if (!sameKeyPair(key.bytes, publicKey.bytes)) fail("preservation_attestor_keypair_mismatch");
	const stateRoot = fs.realpathSync(policy.state_root);
	const stateStat = fs.lstatSync(stateRoot);
	if (!stateStat.isDirectory() || stateStat.isSymbolicLink() || (!unsafeTestBoundary && (stateStat.uid !== uid || (stateStat.mode & 0o077) !== 0))) fail("preservation_attestor_store_unprotected");
	return { ...policy, policy_digest: sha256(policyFile.bytes), privateKey: crypto.createPrivateKey(key.bytes), publicKey: crypto.createPublicKey(publicKey.bytes), stateRoot, uid, unsafeTestBoundary, executionPath, snapshotPath };
}

function repositoryPolicy(policy, requested) {
	const repositoryRoot = fs.realpathSync(requested);
	const candidate = policy.repositories.find((entry) => entry && entry.path === repositoryRoot);
	if (!candidate) fail("preservation_attestor_repository_not_allowed");
	const stat = fs.statSync(repositoryRoot);
	const repositoryId = sha256(canonicalJson({ path: repositoryRoot, dev: String(stat.dev), ino: String(stat.ino) }));
	if (candidate.repository_id !== repositoryId) fail("preservation_attestor_repository_identity_mismatch");
	if (!policy.unsafeTestBoundary && stat.uid === policy.uid) fail("preservation_attestor_same_uid_forbidden");
	return { repositoryRoot, repositoryId, registrations: policy.registrations };
}

function readActiveBinding(repositoryRoot, unitId) {
	if (!ID.test(unitId || "")) fail("preservation_attestor_unit_invalid");
	const unitRoot = path.join(repositoryRoot, ".agents", "harness", "units", unitId);
	const read = (name) => {
		const file = path.join(unitRoot, `${name}.json`);
		if (!inside(unitRoot, file)) fail("preservation_attestor_unit_invalid");
		try { return JSON.parse(readPinnedFile(file, `preservation_attestor_${name}_invalid`).bytes); } catch (error) { if (error.code) throw error; fail(`preservation_attestor_${name}_invalid`); }
	};
	const head = read("head");
	const binding = read("binding");
	const contract = read("contract");
	if (!head || !binding || !contract || head.lifecycle === "compacted" || binding.state !== "active" || binding.contract_id !== contract.id || head.contract_digest !== sha256(canonicalJson(contract)) || !Number.isInteger(binding.planning_work_revision)) fail("preservation_attestor_active_binding_invalid");
	if (!contract.preservation || !contract.preservation.inventory || !Array.isArray(contract.preservation.inventory.surface_ids) || !contract.preservation.inventory.surface_ids.length) fail("preservation_attestor_contract_inventory_invalid");
	return { unitRoot, head, binding, contract };
}

function openStore(policy) {
	const file = path.join(policy.stateRoot, "attestor.sqlite");
	const db = new DatabaseSync(file);
	db.exec([
		"PRAGMA journal_mode=WAL", "PRAGMA synchronous=FULL",
		"CREATE TABLE IF NOT EXISTS bindings (repository_id TEXT NOT NULL, unit_id TEXT NOT NULL, contract_digest TEXT NOT NULL, scope_epoch INTEGER NOT NULL, binding_epoch INTEGER NOT NULL, planning_work_revision INTEGER NOT NULL, baseline_ref TEXT NOT NULL, inventory_digest TEXT NOT NULL, surface_ids TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(repository_id,unit_id))",
		"CREATE TABLE IF NOT EXISTS challenges (challenge TEXT PRIMARY KEY, state TEXT NOT NULL, repository_id TEXT NOT NULL, unit_id TEXT NOT NULL, phase TEXT NOT NULL, surface_id TEXT NOT NULL, issued_at INTEGER NOT NULL)",
		"CREATE TABLE IF NOT EXISTS receipts (receipt_id TEXT PRIMARY KEY, challenge TEXT UNIQUE NOT NULL, repository_id TEXT NOT NULL, unit_id TEXT NOT NULL, phase TEXT NOT NULL, surface_id TEXT NOT NULL, payload TEXT NOT NULL, issued_at INTEGER NOT NULL)",
		"CREATE TABLE IF NOT EXISTS decisions (decision_id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, unit_id TEXT NOT NULL, payload TEXT NOT NULL, issued_at INTEGER NOT NULL)",
	].join("; "));
	db.prepare("UPDATE challenges SET state='unknown' WHERE state='running'").run();
	try { fs.chmodSync(file, 0o600); } catch {}
	return db;
}

function protectedBinding(active, repo) {
	return {
		repository_id: repo.repositoryId,
		unit_id: path.basename(active.unitRoot),
		contract_digest: active.head.contract_digest,
		scope_epoch: active.head.scope_epoch,
		binding_epoch: active.binding.binding_epoch,
		planning_work_revision: active.binding.planning_work_revision,
		baseline_ref: active.contract.preservation.baseline_ref,
		inventory_digest: active.contract.preservation.inventory.surface_inventory_digest,
		surface_ids: canonicalJson([...active.contract.preservation.inventory.surface_ids].sort()),
	};
}

function registrationMatches(registration, expected) {
	if (!registration || typeof registration !== "object" || Array.isArray(registration)) return false;
	const fields = ["repository_id", "unit_id", "contract_digest", "scope_epoch", "binding_epoch", "planning_work_revision", "baseline_ref", "inventory_digest"];
	if (fields.some((field) => registration[field] !== expected[field])) return false;
	return Array.isArray(registration.surface_ids) && canonicalJson([...new Set(registration.surface_ids)].sort()) === expected.surface_ids;
}

function pinOrVerifyBinding(db, active, repo, phase, now = Date.now()) {
	const expected = protectedBinding(active, repo);
	const prior = db.prepare("SELECT * FROM bindings WHERE repository_id=? AND unit_id=?").get(expected.repository_id, expected.unit_id);
	if (prior) for (const [field, value] of Object.entries(expected)) if (prior[field] !== value) fail("preservation_attestor_protected_binding_mismatch");
	if (!repo.registrations.some((registration) => registrationMatches(registration, expected))) fail("preservation_attestor_registration_missing");
	if (!prior) {
		if (phase !== "baseline") fail("preservation_attestor_baseline_not_pinned");
		db.prepare("INSERT INTO bindings(repository_id,unit_id,contract_digest,scope_epoch,binding_epoch,planning_work_revision,baseline_ref,inventory_digest,surface_ids,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(expected.repository_id, expected.unit_id, expected.contract_digest, expected.scope_epoch, expected.binding_epoch, expected.planning_work_revision, expected.baseline_ref, expected.inventory_digest, expected.surface_ids, now);
		return expected;
	}
	return expected;
}

function executeProbe(request, deps) {
	if (!request || canonicalJson(Object.keys(request).sort()) !== canonicalJson(["operation", "phase", "repository", "stage", "surface_id", "unit_id"].sort()) || request.operation !== "probe") fail("preservation_attestor_request_invalid");
	if ((request.stage === "planning") !== (request.phase === "baseline") || !new Set(["planning", "integration_completion"]).has(request.stage) || !new Set(["baseline", "current"]).has(request.phase) || !ID.test(request.surface_id || "")) fail("preservation_attestor_request_invalid");
	const repo = repositoryPolicy(deps.policy, request.repository);
	const active = readActiveBinding(repo.repositoryRoot, request.unit_id);
	if (!active.contract.preservation.inventory.surface_ids.includes(request.surface_id)) fail("preservation_attestor_surface_not_allowed");
	const adapterPath = path.resolve(repo.repositoryRoot, deps.policy.adapter_path);
	if (!inside(repo.repositoryRoot, adapterPath)) fail("preservation_attestor_adapter_invalid");
	const common = { adapterPath, nodeExecutable: deps.policy.node_path, sandboxExecutable: deps.policy.sandbox_path, allowedAdapterDigests: deps.policy.allowed_adapter_digests, allowedExecutableDigests: deps.policy.allowed_node_digests, allowedSandboxDigests: deps.policy.allowed_sandbox_digests };
	const discovery = deps.execution.discoverRoots(common);
	const expectedSurfaceIds = active.contract.preservation.inventory.surface_ids;
	const challenge = crypto.randomBytes(32).toString("hex");
	const db = openStore(deps.policy);
	const issuedAt = Date.now();
	pinOrVerifyBinding(db, active, repo, request.phase, issuedAt);
	db.prepare("INSERT INTO challenges(challenge,state,repository_id,unit_id,phase,surface_id,issued_at) VALUES(?,?,?,?,?,?,?)").run(challenge, "issued", repo.repositoryId, request.unit_id, request.phase, request.surface_id, issuedAt);
	db.prepare("UPDATE challenges SET state='running' WHERE challenge=? AND state='issued'").run(challenge);
	const temp = fs.mkdtempSync(path.join(deps.policy.stateRoot, "run-"));
	try {
		const gitOptions = { gitExecutable: deps.policy.git_path, allowedGitDigests: deps.policy.allowed_git_digests };
		const snapshot = deps.snapshot.materialize({ cwd: repo.repositoryRoot, destination: path.join(temp, "subject"), roots: discovery.snapshot_roots, phase: request.phase, ref: request.phase === "baseline" ? active.contract.preservation.baseline_ref : undefined, sha256, ...gitOptions });
		const evidence = deps.execution.run({ ...common, challenge, snapshot, phase: request.phase, stage: request.stage, surfaceId: request.surface_id, expectedSurfaceIds, verifySubjectStable: request.phase === "current" ? () => deps.snapshot.verifyCurrentStable(repo.repositoryRoot, discovery.snapshot_roots, snapshot, sha256, gitOptions) : undefined });
		const workRevision = request.phase === "baseline" ? active.binding.planning_work_revision : active.head.work_revision;
		const receipt = deps.execution.issueReceipt(evidence, { repository_id: repo.repositoryId, unit_id: request.unit_id, contract_digest: active.head.contract_digest, scope_epoch: active.head.scope_epoch, binding_epoch: active.binding.binding_epoch, work_revision: workRevision, credential_id: deps.policy.credential_id, credential_epoch: deps.policy.credential_epoch, policy_digest: deps.policy.policy_digest, baseline_ref: active.contract.preservation.baseline_ref, contract_inventory_digest: active.contract.preservation.inventory.surface_inventory_digest, runner_digest: deps.policy.worker_digest, execution_runner_digest: deps.policy.execution_runner_digest, snapshot_digest: deps.policy.snapshot_digest, sandbox_digest: evidence.sandbox.executable_digest, ttl_ms: request.phase === "baseline" ? BASELINE_TTL_MS : CURRENT_TTL_MS }, (bytes) => crypto.sign(null, bytes, deps.policy.privateKey));
		const payload = canonicalJson(receipt);
		db.exec("BEGIN IMMEDIATE");
		try {
			db.prepare("INSERT INTO receipts(receipt_id,challenge,repository_id,unit_id,phase,surface_id,payload,issued_at) VALUES(?,?,?,?,?,?,?,?)").run(receipt.receipt_id, challenge, repo.repositoryId, request.unit_id, request.phase, request.surface_id, payload, issuedAt);
			db.prepare("UPDATE challenges SET state='succeeded' WHERE challenge=? AND state='running'").run(challenge);
			db.exec("COMMIT");
		} catch (error) { db.exec("ROLLBACK"); throw error; }
		return receipt;
	} catch (error) {
		try { db.prepare("UPDATE challenges SET state='failed' WHERE challenge=? AND state='running'").run(challenge); } catch {}
		throw error;
	} finally { try { db.close(); } catch {} fs.rmSync(temp, { recursive: true, force: true }); }
}

function decisionPayload(decision) {
	const payload = JSON.parse(JSON.stringify(decision));
	delete payload.signature;
	return payload;
}

function materializeCurrentForSeal(repo, deps) {
	const adapterPath = path.resolve(repo.repositoryRoot, deps.policy.adapter_path);
	if (!inside(repo.repositoryRoot, adapterPath)) fail("preservation_attestor_adapter_invalid");
	const common = { adapterPath, nodeExecutable: deps.policy.node_path, sandboxExecutable: deps.policy.sandbox_path, allowedAdapterDigests: deps.policy.allowed_adapter_digests, allowedExecutableDigests: deps.policy.allowed_node_digests, allowedSandboxDigests: deps.policy.allowed_sandbox_digests };
	const discovery = deps.execution.discoverRoots(common);
	const temp = fs.mkdtempSync(path.join(deps.policy.stateRoot, "seal-"));
	const gitOptions = { gitExecutable: deps.policy.git_path, allowedGitDigests: deps.policy.allowed_git_digests };
	try {
		const snapshot = deps.snapshot.materialize({ cwd: repo.repositoryRoot, destination: path.join(temp, "subject"), roots: discovery.snapshot_roots, phase: "current", sha256, ...gitOptions });
		return { discovery, gitOptions, snapshot, temp };
	} catch (error) {
		fs.rmSync(temp, { recursive: true, force: true });
		throw error;
	}
}

function sealDecision(request, deps, now = Date.now()) {
	if (!request || canonicalJson(Object.keys(request).sort()) !== canonicalJson(["operation", "repository", "unit_id"].sort()) || request.operation !== "seal") fail("preservation_attestor_request_invalid");
	const repo = repositoryPolicy(deps.policy, request.repository);
	const active = readActiveBinding(repo.repositoryRoot, request.unit_id);
	const current = materializeCurrentForSeal(repo, deps);
	const db = openStore(deps.policy);
	try {
		const pinned = pinOrVerifyBinding(db, active, repo, "current", now);
		const rows = db.prepare("SELECT r.payload,c.state FROM receipts r JOIN challenges c ON c.challenge=r.challenge WHERE r.repository_id=? AND r.unit_id=? ORDER BY r.issued_at").all(repo.repositoryId, request.unit_id);
		const surfaceIds = JSON.parse(pinned.surface_ids);
		const selected = [];
		for (const phase of ["baseline", "current"]) for (const surfaceId of surfaceIds) {
			const revision = phase === "baseline" ? pinned.planning_work_revision : active.head.work_revision;
			const candidates = rows.filter((row) => row.state === "succeeded").map((row) => JSON.parse(row.payload)).filter((receipt) => receipt.phase === phase && receipt.surface_id === surfaceId && receipt.contract_digest === pinned.contract_digest && receipt.scope_epoch === pinned.scope_epoch && receipt.binding_epoch === pinned.binding_epoch && receipt.work_revision === revision);
			const receipt = candidates.at(-1);
			if (!receipt) fail("preservation_attestor_receipt_set_incomplete");
			const validation = deps.execution.verifyReceipt(receipt, { now, publicKey: deps.policy.publicKey, expected: { repository_id: repo.repositoryId, unit_id: request.unit_id, contract_digest: pinned.contract_digest, scope_epoch: pinned.scope_epoch, binding_epoch: pinned.binding_epoch, work_revision: revision, phase, stage: phase === "baseline" ? "planning" : "integration_completion", surface_id: surfaceId, credential_id: deps.policy.credential_id, credential_epoch: deps.policy.credential_epoch, policy_digest: deps.policy.policy_digest, runner_digest: deps.policy.worker_digest, execution_runner_digest: deps.policy.execution_runner_digest, snapshot_digest: deps.policy.snapshot_digest, sandbox_digest: receipt.sandbox && receipt.sandbox.executable_digest, contract_inventory_digest: pinned.inventory_digest }, allowedAdapterDigests: deps.policy.allowed_adapter_digests, allowedExecutableDigests: deps.policy.allowed_node_digests });
			if (!deps.policy.allowed_sandbox_digests.includes(receipt.sandbox_digest) || receipt.sandbox_digest !== (receipt.sandbox && receipt.sandbox.executable_digest)) fail("preservation_attestor_receipt_set_invalid");
			if (!validation.ok || receipt.reachable !== true || receipt.state !== "succeeded" || !receipt.parsed || receipt.parsed.reachable !== true || !Array.isArray(receipt.parsed.capabilities)) fail("preservation_attestor_receipt_set_invalid");
			selected.push(receipt);
		}
		const currentReceipts = selected.filter((receipt) => receipt.phase === "current");
		for (const receipt of currentReceipts) {
			if (receipt.subject_digest !== current.snapshot.digest || receipt.git_digest !== current.snapshot.git_digest || receipt.adapter_digest !== current.discovery.adapter_digest || canonicalJson(receipt.repository) !== canonicalJson(current.snapshot.repository)) fail("preservation_attestor_current_snapshot_mismatch");
		}
		for (const phase of ["baseline", "current"]) {
			const phaseReceipts = selected.filter((receipt) => receipt.phase === phase);
			for (const field of ["subject_digest", "git_digest", "adapter_digest", "inventory_digest"]) if (new Set(phaseReceipts.map((receipt) => receipt[field])).size !== 1) fail("preservation_attestor_receipt_set_inconsistent");
			if (new Set(phaseReceipts.map((receipt) => canonicalJson(receipt.repository))).size !== 1) fail("preservation_attestor_receipt_set_inconsistent");
		}
		if (new Set(selected.map((receipt) => receipt.sandbox_digest)).size !== 1) fail("preservation_attestor_tcb_inconsistent");
		if (!deps.snapshot.verifyCurrentStable(repo.repositoryRoot, current.discovery.snapshot_roots, current.snapshot, sha256, current.gitOptions)) fail("preservation_attestor_current_snapshot_drift");
		for (const surfaceId of surfaceIds) {
			const baseline = selected.find((receipt) => receipt.phase === "baseline" && receipt.surface_id === surfaceId);
			const current = selected.find((receipt) => receipt.phase === "current" && receipt.surface_id === surfaceId);
			for (const capability of baseline.parsed.capabilities) if (!current.parsed.capabilities.includes(capability)) fail("preservation_attestor_capability_lost");
		}
		const receiptIds = selected.map((receipt) => receipt.receipt_id);
		const decision = {
			version: 1,
			decision_id: sha256(canonicalJson({ receipt_ids: receiptIds, issued_at: now, nonce: crypto.randomBytes(32).toString("hex") })),
			state: "release_evidence_succeeded",
			repository_id: repo.repositoryId,
			unit_id: request.unit_id,
			contract_digest: pinned.contract_digest,
			scope_epoch: pinned.scope_epoch,
			binding_epoch: pinned.binding_epoch,
			planning_work_revision: pinned.planning_work_revision,
			current_work_revision: active.head.work_revision,
			baseline_ref: pinned.baseline_ref,
			contract_inventory_digest: pinned.inventory_digest,
			credential_id: deps.policy.credential_id,
			credential_epoch: deps.policy.credential_epoch,
			policy_digest: deps.policy.policy_digest,
			tcb: { worker_digest: deps.policy.worker_digest, execution_runner_digest: deps.policy.execution_runner_digest, snapshot_digest: deps.policy.snapshot_digest, sandbox_digest: selected[0].sandbox_digest },
			current_subject_digest: current.snapshot.digest,
			current_git_digest: current.snapshot.git_digest,
			current_adapter_digest: current.discovery.adapter_digest,
			current_inventory_digest: currentReceipts[0].inventory_digest,
			repository_snapshot: current.snapshot.repository,
			surface_ids: surfaceIds,
			receipt_ids: receiptIds,
			evidence_digest: sha256(canonicalJson(receiptIds)),
			issued_at: now,
			expires_at: now + DECISION_TTL_MS,
		};
		const signed = { ...decision, signature: crypto.sign(null, Buffer.from(canonicalJson(decisionPayload(decision))), deps.policy.privateKey).toString("base64") };
		if (!deps.snapshot.verifyCurrentStable(repo.repositoryRoot, current.discovery.snapshot_roots, current.snapshot, sha256, current.gitOptions)) fail("preservation_attestor_current_snapshot_drift");
		db.prepare("INSERT INTO decisions(decision_id,repository_id,unit_id,payload,issued_at) VALUES(?,?,?,?,?)").run(signed.decision_id, repo.repositoryId, request.unit_id, canonicalJson(signed), now);
		return signed;
	} finally { try { db.close(); } catch {} fs.rmSync(current.temp, { recursive: true, force: true }); }
}

function productionDeps() {
	const policy = loadPolicy();
	const execution = require(policy.executionPath);
	const snapshot = require(policy.snapshotPath);
	return { policy, execution, snapshot };
}

function dispatch(request, deps) {
	if (request && request.operation === "probe") return { receipt: executeProbe(request, deps) };
	if (request && request.operation === "seal") return { decision: sealDecision(request, deps) };
	fail("preservation_attestor_request_invalid");
}

function serve(deps = productionDeps()) {
	const server = net.createServer({ allowHalfOpen: true }, (socket) => {
		let input = "";
		socket.setEncoding("utf8");
		socket.setTimeout(5_000, () => socket.destroy());
		socket.on("data", (chunk) => { input += chunk; if (Buffer.byteLength(input) > MAX_REQUEST) socket.destroy(); });
		socket.on("end", () => {
			try { socket.end(`${canonicalJson({ ok: true, ...dispatch(JSON.parse(input), deps) })}\n`); }
			catch (error) { socket.end(`${canonicalJson({ ok: false, code: error.code || "preservation_attestor_failed" })}\n`); }
		});
	});
	server.maxConnections = 32;
	server.dropMaxConnection = true;
	server.listen({ fd: SOCKET_FD });
	return server;
}

if (require.main === module) serve();
module.exports = { BASELINE_TTL_MS, DECISION_TTL_MS, canonicalJson, decisionPayload, dispatch, executeProbe, loadPolicy, openStore, pinOrVerifyBinding, readActiveBinding, repositoryPolicy, sealDecision, serve, sha256 };
