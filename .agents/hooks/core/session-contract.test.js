#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const core = require("./session-contract.js");

function workspace(name = "session-contract-") {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), name));
	fs.mkdirSync(path.join(root, ".agents", "context"), { recursive: true });
	fs.mkdirSync(path.join(root, ".agents", "progress"), { recursive: true });
	fs.mkdirSync(path.join(root, ".agents", "session-contracts"), { recursive: true });
	fs.writeFileSync(path.join(root, ".agents", "context", "agents-rules.json"), "{}\n");
	return root;
}

function writeJson(filePath, value) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function bind(root, sessionId, contractId, progressName = `${contractId}.json`) {
	const contractPath = `.agents/session-contracts/${contractId}.json`;
	const progressPath = `.agents/progress/${progressName}`;
	const contract = {
		schema_version: "1.0",
		id: contractId,
		status: "active",
		project_root: ".",
		goal: `goal-${contractId}`,
		scope: ["src/**"],
		non_goals: [],
		success_criteria: ["tests pass"],
		allowed_paths: ["src/**"],
		target_ownership: [`src/${contractId}/**`],
		audiences: ["developer"],
		source_refs: ["USR-TEST:E01"],
		session_bindings: [],
		progress_file: progressPath,
	};
	contract.session_bindings = [{ session_id: sessionId }];
	const digest = core.contractDigest(contract);
	contract.session_bindings[0].contract_digest = digest;
	contract.contract_digest = digest;
	writeJson(path.join(root, contractPath), contract);
	writeJson(path.join(root, progressPath), {
		issue: contractId,
		current_phase: "build",
		contract_id: contractId,
		contract_digest: digest,
	});
	return { contract, contractPath, digest, progressPath };
}

function finishBinding(root, sessionId, contractId, progressName) {
	const entry = bind(root, sessionId, contractId, progressName);
	return entry;
}

function writeRegistry(root, entries) {
	writeJson(path.join(root, ".agents", "session-contracts", ".session-map.json"), {
		schema_version: "1.0",
		bindings: entries,
	});
}

const roots = [];
try {
	const root = workspace(); roots.push(root);
	const a = finishBinding(root, "A", "contract-a");
	const b = finishBinding(root, "B", "contract-b");
	writeRegistry(root, {
		A: { contract_id: "contract-a", contract_path: a.contractPath, contract_digest: a.digest },
		B: { contract_id: "contract-b", contract_path: b.contractPath, contract_digest: b.digest },
	});
	assert.equal(core.resolveSessionContract({ cwd: root, sessionId: "A" }).contract.id, "contract-a");
	assert.equal(core.resolveSessionContract({ cwd: root, sessionId: "B" }).contract.id, "contract-b");

	const duplicate = finishBinding(root, "A", "contract-a-copy", "contract-a-copy.json");
	assert.ok(duplicate);
	assert.equal(core.resolveSessionContract({ cwd: root, sessionId: "A" }).status, core.STATES.AMBIGUOUS);

	const ownershipRoot = workspace(); roots.push(ownershipRoot);
	const ownerA = finishBinding(ownershipRoot, "OA", "owner-a");
	const ownerB = finishBinding(ownershipRoot, "OB", "owner-b");
	for (const item of [ownerA, ownerB]) {
		const filePath = path.join(ownershipRoot, item.contractPath);
		const contract = JSON.parse(fs.readFileSync(filePath, "utf8"));
		contract.target_ownership = ["src/shared/**"];
		const digest = core.contractDigest(contract);
		contract.contract_digest = digest;
		contract.session_bindings[0].contract_digest = digest;
		writeJson(filePath, contract);
		const progressFile = path.join(ownershipRoot, item.progressPath);
		const progress = JSON.parse(fs.readFileSync(progressFile, "utf8"));
		progress.contract_digest = digest;
		writeJson(progressFile, progress);
		item.digest = digest;
	}
	writeRegistry(ownershipRoot, {
		OA: { contract_id: "owner-a", contract_path: ownerA.contractPath, contract_digest: ownerA.digest },
		OB: { contract_id: "owner-b", contract_path: ownerB.contractPath, contract_digest: ownerB.digest },
	});
	assert.equal(core.resolveSessionContract({ cwd: ownershipRoot, sessionId: "OA" }).reason, "target_ownership_conflict");

	const staleRoot = workspace(); roots.push(staleRoot);
	const stale = finishBinding(staleRoot, "S", "stale");
	writeRegistry(staleRoot, {
		S: { contract_id: "stale", contract_path: stale.contractPath, contract_digest: "0".repeat(64) },
	});
	assert.equal(core.resolveSessionContract({ cwd: staleRoot, sessionId: "S" }).status, core.STATES.STALE);

	const malformedRoot = workspace(); roots.push(malformedRoot);
	const malformed = finishBinding(malformedRoot, "M", "malformed");
	const malformedPath = path.join(malformedRoot, malformed.contractPath);
	const malformedContract = JSON.parse(fs.readFileSync(malformedPath, "utf8"));
	malformedContract.target_ownership = ["src/*.js"];
	const malformedDigest = core.contractDigest(malformedContract);
	malformedContract.contract_digest = malformedDigest;
	malformedContract.session_bindings[0].contract_digest = malformedDigest;
	writeJson(malformedPath, malformedContract);
	writeRegistry(malformedRoot, {
		M: { contract_id: "malformed", contract_path: malformed.contractPath, contract_digest: malformedDigest },
	});
	assert.equal(
		core.resolveSessionContract({ cwd: malformedRoot, sessionId: "M" }).reason,
		"unsupported_target_ownership_pattern",
	);
	for (const [mutation, expected] of [
		[(contract) => { contract.unexpected = true; }, "contract_additional_property"],
		[(contract) => { contract.scope = [42]; }, "invalid_scope_item"],
		[(contract) => { contract.allowed_paths = ["src/*.js"]; }, "unsupported_allowed_path_pattern"],
		[(contract) => { contract.allowed_shell_commands = ["bad\ncommand"]; }, "invalid_allowed_shell_commands"],
	]) {
		const candidate = JSON.parse(JSON.stringify(malformed.contract));
		mutation(candidate);
		assert.equal(core.validateContractShape(candidate), expected);
	}

	const parent = workspace("session-parent-"); roots.push(parent);
	const parentContract = finishBinding(parent, "PARENT", "parent-contract");
	writeRegistry(parent, {
		PARENT: { contract_id: "parent-contract", contract_path: parentContract.contractPath, contract_digest: parentContract.digest },
	});
	const child = path.join(parent, "projects", "child");
	fs.mkdirSync(path.join(child, ".agents", "context"), { recursive: true });
	fs.writeFileSync(path.join(child, ".agents", "context", "agents-rules.json"), "{}\n");
	assert.equal(core.resolveSessionContract({ cwd: child, sessionId: "PARENT" }).status, core.STATES.UNBOUND);

	const crossRoot = workspace(); roots.push(crossRoot);
	writeRegistry(crossRoot, {
		X: { contract_id: "external", contract_path: path.join(parent, parentContract.contractPath), contract_digest: parentContract.digest },
	});
	assert.equal(core.resolveSessionContract({ cwd: crossRoot, sessionId: "X" }).status, core.STATES.CROSS_PROJECT);

	console.log("session contract resolver: PASS");
} finally {
	for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
}
