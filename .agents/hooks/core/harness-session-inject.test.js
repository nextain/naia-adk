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
	fs.mkdirSync(path.join(cwd, ".codex"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".codex", "hooks.json"), "{}\n");
	for (const relative of [
		".agents/hooks/core/harness-core.js",
		".agents/hooks/core/delegation-contract.js",
		".agents/hooks/core/hook-project-root.js",
		".agents/hooks/core/preservation-contract.js",
		".agents/hooks/core/request-contract-adapter.js",
		".agents/hooks/core/request-contract.js",
		".agents/hooks/core/request-contract-foundation.js",
		".agents/hooks/core/request-contract-lifecycle.js",
		".agents/hooks/core/request-contract-transactions.js",
		".agents/hooks/core/request-contract-workspace.js",
		".agents/hooks/core/request-contract-quarantine.js",
		".agents/hooks/core/request-contract-validation.js",
		".agents/hooks/core/request-contract-semantics.js",
		".agents/hooks/core/request-contract-binding.js",
		".agents/hooks/core/request-contract-review.js",
		".agents/hooks/core/request-contract-review-records.js",
		".agents/hooks/core/request-contract-completion.js",
		".agents/hooks/core/request-contract-completion-state.js",
		".agents/hooks/core/request-contract-events.js",
		".agents/hooks/core/request-contract-event-handler.js",
		".agents/hooks/core/session-contract.js",
		".agents/hooks/core/harness-switch.js",
		".agents/hooks/core/subagent-failure-receipt.js",
		".codex/hooks/session-inject.cjs",
		".claude/hooks/session-inject.js",
	]) {
		const target = path.join(cwd, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.copyFileSync(path.join(repoRoot, relative), target);
	}
	const optionalCodexGuard = ".codex/hooks/context-budget-guard.cjs";
	if (fs.existsSync(path.join(repoRoot, optionalCodexGuard))) {
		const target = path.join(cwd, optionalCodexGuard);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.copyFileSync(path.join(repoRoot, optionalCodexGuard), target);
	}
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

function orchestratorPolicy() {
	return {
		profile: "balanced",
		context_mode: "isolated",
		budget_started_at: "2026-08-08T00:00:00Z",
		root_input_token_baseline: 0,
		root_output_token_baseline: 0,
		maximum_risk: "medium",
		max_children: 4,
		max_active_children: 2,
		max_prompt_bytes: 16_384,
		max_delegated_prompt_bytes: 65_536,
		max_input_tokens: 256_000,
		max_output_tokens: 32_000,
		orchestrator_execution: {
			mode: "delegate_required",
			owner_direct_override: true,
			technical_failure_fallback: {
				enabled: true,
				minimum_failed_attempts: 1,
				allowed_failure_kinds: ["spawn_guard_incompatible"],
				scope: "same_task_only",
				auto_close_on: ["delegation_success", "task_complete", "handoff"],
			},
		},
	};
}

function bind(cwd, sessionId, progressName, progress, contractOverrides = {}) {
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
		...contractOverrides,
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
	return { contract, digest };
}

function runNode(script, input, extraEnv = {}) {
	return spawnSync(process.execPath, [script], {
		input: JSON.stringify(input),
		encoding: "utf8",
		timeout: 3000,
		env: {
			...process.env,
			ADK_PROJECT_ROOT: "",
			CLAUDE_HARNESS: "",
			CODEX_HARNESS: "",
			...extraEnv,
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
		runNode(path.join(cwd, ".codex", "hooks", "session-inject.cjs"), {
			cwd,
			session_id: "CURRENT",
		}),
		"Codex UserPromptSubmit adapter",
	);
	assertSilent(
		runNode(path.join(cwd, ".claude", "hooks", "session-inject.js"), {
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
	}, { subagent_policy: orchestratorPolicy() });
	const result = core.buildSessionInject({
		cwd,
		sessionId: "CURRENT",
		hooksDir: path.join(repoRoot, ".codex", "hooks"),
		optOutEnvVar: "CODEX_HARNESS",
		hostConfigDir: ".codex",
		env: { CODEX_AVAILABLE_BINDINGS: "luna,sol" },
	});
	assert.match(result.text, /HARNESS: SESSION STATE/);
	assert.match(result.text, /Bound work/);
	assert.match(result.text, /Execution contract: inject-contract/);
	assert.match(result.text, /HARNESS: PARENT CONTRACT — PRESERVE/);
	assert.match(result.text, /Goal: Bound work/);
	assert.match(result.text, /Scope 1: src\/\*\*/);
	assert.match(result.text, /Acceptance 1: inject correct state/);
	assert.match(result.text, /current_task is a child unit/);
	assert.match(result.text, /Active profile: balanced \(source: catalog_default\)/);
	assert.match(result.text, /Available bindings: luna, sol/);
	assert.match(result.text, /Fallback: control; fail closed; return the task to L2 for decomposition or explicit profile rollback/);
	assert.match(result.text, /total development cost reduction is not proven/);
	assert.match(result.text, /Root role: L3 secretary \/ L2 issue leader/);
	assert.match(result.text, /Direct fallback: BLOCKED \(orchestrator_delegation_required\)/);
	assert.throws(
		() => core.buildSessionInject({
			cwd,
			sessionId: "CURRENT",
			hooksDir: path.join(repoRoot, ".codex", "hooks"),
			optOutEnvVar: "CODEX_HARNESS",
			hostConfigDir: ".codex",
			env: {},
		}),
		/development profile balanced is unavailable; missing bindings: luna, sol/,
	);

	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "naia-harness-scratch-"));
	try {
		const requestAdapter = require(path.join(cwd, ".agents", "hooks", "core", "request-contract-adapter.js"));
		const inherited = runNode(
			path.join(cwd, ".codex", "hooks", "session-inject.cjs"),
			{ cwd: scratch, session_id: "CURRENT" },
			{ ADK_PROJECT_ROOT: cwd, CODEX_AVAILABLE_BINDINGS: "luna,sol" },
		);
		assert.strictEqual(inherited.status, 0, inherited.stderr);
		assert.match(inherited.stdout, /HARNESS: SESSION STATE/);
		assert.match(inherited.stdout, /Bound work/);

		const invalidInherited = runNode(
			path.join(cwd, ".codex", "hooks", "session-inject.cjs"),
			{ cwd: scratch, session_id: "CURRENT" },
			{ ADK_PROJECT_ROOT: "." },
		);
		assert.strictEqual(invalidInherited.status, 0, invalidInherited.stderr);
		assert.match(invalidInherited.stdout, /session injection failed/);

		const codexEvent = requestAdapter.normalizeInput("codex", {
			cwd: scratch,
			client_version: "test",
			hook_event_name: "SessionStart",
			session_id: "CURRENT",
		}, "SessionStart", { env: { ADK_PROJECT_ROOT: cwd } });
		assert.strictEqual(codexEvent.cwd, fs.realpathSync(cwd));
		assert.throws(
			() => requestAdapter.normalizeInput("codex", {
				cwd: scratch,
				client_version: "test",
				hook_event_name: "SessionStart",
				session_id: "CURRENT",
			}, "SessionStart", { env: { ADK_PROJECT_ROOT: "." } }),
			/ADK_PROJECT_ROOT must be absolute/,
		);
		const claudeEvent = requestAdapter.normalizeInput("claude", {
			cwd,
			client_version: "test",
			hook_event_name: "SessionStart",
			session_id: "CURRENT",
		}, "SessionStart", { env: { ADK_PROJECT_ROOT: "." } });
		assert.strictEqual(claudeEvent.cwd, cwd, "Claude root discovery must remain payload-based");
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}

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
			env: { CODEX_AVAILABLE_BINDINGS: "sol" },
		}),
		/development profile balanced is unavailable; missing bindings: luna/,
	);
	assert.throws(
		() => core.buildSessionInject({
			cwd,
			sessionId: "CURRENT",
			hooksDir: path.join(repoRoot, ".codex", "hooks"),
			optOutEnvVar: "CODEX_HARNESS",
			hostConfigDir: ".codex",
			env: { CODEX_AVAILABLE_BINDINGS: "none" },
		}),
		/development profile balanced is unavailable; missing bindings: luna, sol/,
	);
	// A session whose subscription base is Claude has to reach an active profile
	// through this injection path too. The pure selector returning the right
	// binding is not evidence that a real session activates it.
	const injectWith = (env) => core.buildSessionInject({
		cwd,
		sessionId: "CURRENT",
		hooksDir: path.join(repoRoot, ".codex", "hooks"),
		optOutEnvVar: "CODEX_HARNESS",
		hostConfigDir: ".codex",
		env,
	});
	const claudeOnly = injectWith({
		CODEX_DEVELOPMENT_PROFILE: "claude-balanced",
		CODEX_AVAILABLE_BINDINGS: "claude_flagship,claude_workhorse,claude_light",
	});
	assert.match(claudeOnly.text, /Active profile: claude-balanced \(source: environment_override\)/);
	assert.match(claudeOnly.text, /Available bindings: claude_flagship, claude_light, claude_workhorse/);
	assert.throws(
		() => injectWith({ CODEX_DEVELOPMENT_PROFILE: "claude-balanced", CODEX_AVAILABLE_BINDINGS: "sol,luna" }),
		/development profile claude-balanced is unavailable; missing bindings: claude_flagship, claude_light, claude_workhorse/,
		"declaring only Codex bindings must fail closed on a Claude profile instead of substituting a Codex model",
	);
	const bothProviders = injectWith({
		CODEX_DEVELOPMENT_PROFILE: "mixed-balanced",
		CODEX_AVAILABLE_BINDINGS: "luna,claude_flagship",
	});
	assert.match(bothProviders.text, /Active profile: mixed-balanced \(source: environment_override\)/);
	assert.match(bothProviders.text, /Available bindings: claude_flagship, luna/);
	assert.throws(
		() => injectWith({ CODEX_DEVELOPMENT_PROFILE: "mixed-balanced", CODEX_AVAILABLE_BINDINGS: "luna" }),
		/development profile mixed-balanced is unavailable; missing bindings: claude_flagship/,
		"a cross-provider profile requires the reviewing provider to be declared, not quietly dropped",
	);
	assert.throws(
		() => core.buildSessionInject({
			cwd,
			sessionId: "CURRENT",
			hooksDir: path.join(repoRoot, ".codex", "hooks"),
			optOutEnvVar: "CODEX_HARNESS",
			hostConfigDir: ".codex",
			env: { CODEX_DEVELOPMENT_PROFILE: "unknown" },
		}),
		/unknown development profile/,
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
	const cwd = workspace();
	const binding = bind(cwd, "PARENT", "derived.json", {
		issue: "Broad parent issue",
		current_phase: "build",
		gates_cleared: ["plan"],
	}, {
		goal: "Preserve the complete parent objective across worker resume.",
		scope: ["Keep the broad parent obligation visible.", "Inspect the bounded worker hook."],
		non_goals: ["Do not declare the parent issue complete from a child result."],
		success_criteria: ["The parent objective remains visible.", "The child hook inspection is reported."],
		allowed_paths: ["src/**"],
		target_ownership: ["src/**"],
		subagent_policy: orchestratorPolicy(),
	});
	const delegatedTask = {
		schema_version: "delegation-task-v1",
		task_id: "resume-worker-01",
		task_digest: "",
		parent_contract_id: binding.contract.id,
		parent_contract_digest: binding.digest,
		parent_intent_digest: contractCore.parentIntentDigest(binding.contract),
		role: "review",
		project_root: cwd,
		worktree: cwd,
		scope: ["Inspect the bounded worker hook."],
		allowed_paths: ["src/worker-hook.js"],
		success_criteria: ["The child hook inspection is reported."],
		stop_condition: "Return the bounded result or hand off any drift.",
		risk: "medium",
		exact_validator: null,
		read_only: true,
		result_contract: {
			schema_version: "delegation-result-v1",
			completion_scope: "child_task_only",
			drift_action: "handoff_to_parent",
			required_fields: [
				"status", "task_digest", "parent_intent_digest", "changed_paths", "validator_results",
				"remaining_parent_obligations_preserved", "completion_scope", "handoff_reason",
			],
		},
	};
	delegatedTask.task_digest = contractCore.delegationTaskDigest(delegatedTask);
	const result = core.buildSessionInject({
		cwd,
		sessionId: "CHILD",
		hooksDir: path.join(repoRoot, ".codex", "hooks"),
		optOutEnvVar: "CODEX_HARNESS",
		hostConfigDir: ".codex",
		env: { CODEX_AVAILABLE_BINDINGS: "luna,sol" },
		sessionChainLookup: () => ({ ambiguous: false, sessions: [
			{ sessionId: "CHILD", parentId: "PARENT", isSubagent: true, delegatedPrompt: JSON.stringify(delegatedTask) },
			{ sessionId: "PARENT", parentId: null, isSubagent: false },
		] }),
	});
	assert.match(result.text, /Execution contract: inject-contract::resume-worker-01/);
	assert.match(result.text, /Parent contract: inject-contract/);
	assert.match(result.text, /Goal: Preserve the complete parent objective across worker resume\./);
	assert.match(result.text, /Scope 1: Keep the broad parent obligation visible\./);
	assert.match(result.text, /Acceptance 1: The parent objective remains visible\./);
	assert.match(result.text, /Child scope 1: Inspect the bounded worker hook\./);
	assert.match(result.text, /Child acceptance 1: The child hook inspection is reported\./);
	assert.match(result.text, /Nested delegation is forbidden/);
	assert.doesNotMatch(result.text, /Root role: L3 secretary/);
	fs.rmSync(cwd, { recursive: true, force: true });
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
