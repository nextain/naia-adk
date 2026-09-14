#!/usr/bin/env node
/* Rebind one active local contract to the current session after an explicit restart. */
const fs = require("fs");
const path = require("path");
const core = require("../../.agents/hooks/core/session-contract.js");

const [contractId, sessionId] = process.argv.slice(2);
if (!contractId || !sessionId || !/^ses_[A-Za-z0-9._-]+$/.test(sessionId)) {
	console.error("usage: rebind-session.cjs <contract-id> <session-id>");
	process.exit(2);
}

const root = path.resolve(__dirname, "../..");
const contractPath = path.join(root, ".agents", "session-contracts", `${contractId}.json`);
const registryPath = path.join(root, ".agents", "session-contracts", ".session-map.json");
const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
if (contract.id !== contractId || contract.status !== "active") throw new Error("contract must be active and exact");

const previous = (contract.session_bindings || []).filter((binding) => binding.session_id !== sessionId);
contract.session_bindings = [{ session_id: sessionId }];
const digest = core.contractDigest(contract);
contract.contract_digest = digest;
contract.session_bindings[0].contract_digest = digest;

const progressPath = path.join(root, contract.progress_file);
const progress = JSON.parse(fs.readFileSync(progressPath, "utf8"));
progress.session_id = sessionId;
progress.contract_id = contractId;
progress.contract_digest = digest;
progress.current_phase = progress.current_phase || "rebound";

const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
if (!registry.bindings || typeof registry.bindings !== "object") throw new Error("invalid session registry");
for (const [id, pointer] of Object.entries(registry.bindings)) {
	if (pointer.contract_id === contractId && id !== sessionId) delete registry.bindings[id];
}
registry.bindings[sessionId] = {
	contract_id: contractId,
	contract_path: `.agents/session-contracts/${contractId}.json`,
	contract_digest: digest,
};

function atomic(file, value) {
	const temp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
	fs.renameSync(temp, file);
}

atomic(contractPath, contract);
atomic(progressPath, progress);
atomic(registryPath, registry);
console.log(JSON.stringify({ contractId, sessionId, digest, previousBindings: previous.map((binding) => binding.session_id) }));
