#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const contractCore = require(path.resolve(__dirname, "../../../.agents/hooks/core/session-contract.js"));

function writeJson(filePath, value) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function bindSessionFixture({ root, sessionId, contractId, progressName, issue, phase }) {
	const contractPath = `.agents/session-contracts/${contractId}.json`;
	const progressPath = `.agents/progress/${progressName}`;
	const contract = {
		schema_version: "1.0",
		id: contractId,
		status: "active",
		project_root: ".",
		goal: `E2E fixture ${contractId}`,
		scope: ["src/**"],
		non_goals: [],
		success_criteria: ["session injection matches the bound contract"],
		allowed_paths: ["src/**"],
		target_ownership: [`src/${contractId}/**`],
		audiences: ["developer"],
		source_refs: ["USR-E2E:E01"],
		session_bindings: [{ session_id: sessionId }],
		progress_file: progressPath,
	};
	const digest = contractCore.contractDigest(contract);
	contract.contract_digest = digest;
	contract.session_bindings[0].contract_digest = digest;
	writeJson(path.join(root, contractPath), contract);
	writeJson(path.join(root, progressPath), {
		issue,
		current_phase: phase,
		contract_id: contractId,
		contract_digest: digest,
	});
	const contextPath = path.join(root, ".agents", "context", "agents-rules.json");
	if (!fs.existsSync(contextPath)) writeJson(contextPath, {});
	const registryPath = path.join(root, ".agents", "session-contracts", ".session-map.json");
	const registry = fs.existsSync(registryPath)
		? JSON.parse(fs.readFileSync(registryPath, "utf8"))
		: { schema_version: "1.0", bindings: {} };
	registry.bindings[sessionId] = {
		contract_id: contractId,
		contract_path: contractPath,
		contract_digest: digest,
	};
	writeJson(registryPath, registry);
}

if (require.main === module) {
	const [root, sessionId, contractId, progressName, issue, phase] = process.argv.slice(2);
	if ([root, sessionId, contractId, progressName, issue, phase].some((value) => !value)) {
		process.stderr.write("usage: session-contract-fixture.cjs ROOT SESSION CONTRACT PROGRESS ISSUE PHASE\n");
		process.exit(2);
	}
	bindSessionFixture({ root, sessionId, contractId, progressName, issue, phase });
}

module.exports = { bindSessionFixture };
