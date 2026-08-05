#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const core = require("./harness-core.js");
const contractCore = require("./session-contract.js");

const repoRoot = path.resolve(__dirname, "..", "..", "..");

function workspace() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "naia-harness-inject-"));
	fs.mkdirSync(path.join(cwd, ".agents", "progress"), { recursive: true });
	fs.mkdirSync(path.join(cwd, ".agents", "context"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".agents", "context", "agents-rules.json"), "{}\n");
	const catalogDir = path.join(cwd, "packages", "benchmark-contract", "baselines");
	fs.mkdirSync(catalogDir, { recursive: true });
	fs.copyFileSync(
		path.join(repoRoot, "packages", "benchmark-contract", "baselines", "development-composition-profiles.json"),
		path.join(catalogDir, "development-composition-profiles.json"),
	);
	return cwd;
}

function writeProgress(cwd, name, value) {
	fs.writeFileSync(
		path.join(cwd, ".agents", "progress", name),
		JSON.stringify(value, null, 2),
	);
}

function bind(cwd, sessionId, progressName, progress) {
	const contract = {
		schema_version: "1.0",
		id: "inject-contract",
		status: "active",
		project_root: ".",
		goal: "Bound work",
		scope: ["src/**"],
		non_goals: [],
		success_criteria: ["inject correct state"],
		allowed_paths: ["src/**"],
		target_ownership: ["src/**"],
		audiences: ["developer"],
		source_refs: ["USR-TEST:E01"],
		session_bindings: [{ session_id: sessionId }],
		progress_file: `.agents/progress/${progressName}`,
	};
	const digest = contractCore.contractDigest(contract);
	contract.contract_digest = digest;
	contract.session_bindings[0].contract_digest = digest;
	progress.contract_id = contract.id;
	progress.contract_digest = digest;
	writeProgress(cwd, progressName, progress);
	const contractsDir = path.join(cwd, ".agents", "session-contracts");
	fs.mkdirSync(contractsDir, { recursive: true });
	fs.writeFileSync(path.join(contractsDir, "inject-contract.json"), JSON.stringify(contract, null, 2));
	fs.writeFileSync(path.join(contractsDir, ".session-map.json"), JSON.stringify({
		schema_version: "1.0",
		bindings: {
			[sessionId]: {
				contract_id: contract.id,
				contract_path: ".agents/session-contracts/inject-contract.json",
				contract_digest: digest,
			},
		},
	}, null, 2));
}

function runNode(script, input) {
	return spawnSync(process.execPath, [script], {
		input: JSON.stringify(input),
		encoding: "utf8",
		timeout: 3000,
		env: {
			...process.env,
			CLAUDE_HARNESS: "",
			CODEX_HARNESS: "",
		},
	});
}

function assertSilent(result, label) {
	assert.strictEqual(result.status, 0, `${label} exited ${result.status}: ${result.stderr}`);
	assert.strictEqual(result.stdout, "", `${label} exposed internal unbound state`);
	assert.strictEqual(result.stderr, "", `${label} wrote unexpected stderr`);
}

{
	const cwd = workspace();
	writeProgress(cwd, "other.json", {
		issue: "Unrelated active work",
		current_phase: "build",
		session_id: "OTHER",
	});

	const result = core.buildSessionInject({
		cwd,
		sessionId: "CURRENT",
		hooksDir: path.join(repoRoot, ".codex", "hooks"),
		optOutEnvVar: "CODEX_HARNESS",
		hostConfigDir: ".codex",
		env: {},
	});
	assert.strictEqual(result, null, "core must be silent for an unbound session");

	assertSilent(
		runNode(path.join(repoRoot, ".codex", "hooks", "session-inject.cjs"), {
			cwd,
			session_id: "CURRENT",
		}),
		"Codex UserPromptSubmit adapter",
	);
	assertSilent(
		runNode(path.join(repoRoot, ".claude", "hooks", "session-inject.js"), {
			cwd,
			session_id: "CURRENT",
		}),
		"Claude UserPromptSubmit adapter",
	);
}

{
	const cwd = workspace();
	bind(cwd, "CURRENT", "bound.json", {
		issue: "Bound work",
		current_phase: "build",
		gates_cleared: ["plan"],
	});
	const result = core.buildSessionInject({
		cwd,
		sessionId: "CURRENT",
		hooksDir: path.join(repoRoot, ".codex", "hooks"),
		optOutEnvVar: "CODEX_HARNESS",
		hostConfigDir: ".codex",
		env: {},
	});
	assert.match(result.text, /HARNESS: SESSION STATE/);
	assert.match(result.text, /Bound work/);
	assert.match(result.text, /Contract: inject-contract/);
	assert.match(result.text, /Active profile: balanced \(source: catalog_default\)/);
	assert.match(result.text, /Available bindings: sol, terra/);
	assert.match(result.text, /Fallback: control; deterministic fallback then fail closed/);
	assert.match(result.text, /total development cost reduction is not proven/);

	const overridden = core.buildSessionInject({
		cwd,
		sessionId: "CURRENT",
		hooksDir: path.join(repoRoot, ".codex", "hooks"),
		optOutEnvVar: "CODEX_HARNESS",
		hostConfigDir: ".codex",
		env: {
			CODEX_DEVELOPMENT_PROFILE: "control",
			CODEX_AVAILABLE_BINDINGS: "sol",
		},
	});
	assert.match(overridden.text, /Active profile: control \(source: environment_override\)/);
	assert.match(overridden.text, /Available bindings: sol/);
	assert.throws(
		() => core.buildSessionInject({
			cwd,
			sessionId: "CURRENT",
			hooksDir: path.join(repoRoot, ".codex", "hooks"),
			optOutEnvVar: "CODEX_HARNESS",
			hostConfigDir: ".codex",
			env: { CODEX_DEVELOPMENT_PROFILE: "unknown" },
		}),
		/unknown Codex development profile/,
	);
	const catalogPath = path.join(cwd, "packages", "benchmark-contract", "baselines", "development-composition-profiles.json");
	const invalidCatalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
	invalidCatalog.claim_boundary.forbidden_until_phase_2 = [];
	fs.writeFileSync(catalogPath, JSON.stringify(invalidCatalog));
	assert.throws(
		() => core.buildSessionInject({
			cwd,
			sessionId: "CURRENT",
			hooksDir: path.join(repoRoot, ".codex", "hooks"),
			optOutEnvVar: "CODEX_HARNESS",
			hostConfigDir: ".codex",
			env: {},
		}),
		/Codex development profile catalog identity invalid/,
	);

	const claudeResult = core.buildSessionInject({
		cwd,
		sessionId: "CURRENT",
		hooksDir: path.join(repoRoot, ".claude", "hooks"),
		hostConfigDir: ".claude",
		env: { CODEX_DEVELOPMENT_PROFILE: "unknown" },
	});
	assert.doesNotMatch(claudeResult.text, /CODEX DEVELOPMENT PROFILE/);
}

{
	const gate = require(path.join(repoRoot, ".codex", "hooks", "session-contract-gate.cjs"));
	assert.strictEqual(
		gate.readOnlyShell("touch customer-data"),
		false,
		"mutation must remain outside the unbound read-only allowlist",
	);
	assert.strictEqual(
		gate.readOnlyShell("git status"),
		true,
		"unbound read-only inspection must remain allowed",
	);
}

console.log("harness session injection: PASS");
