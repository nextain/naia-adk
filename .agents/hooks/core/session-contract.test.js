#!/usr/bin/env node

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const core = require("./session-contract.js");
const { issueFailureReceipt } = require("./subagent-failure-receipt.js");

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
		[(contract) => { contract.subagent_policy = null; }, "invalid_subagent_policy"],
		[(contract) => { contract.subagent_policy = { profile: "balanced" }; }, "invalid_subagent_policy_mode"],
	]) {
		const candidate = JSON.parse(JSON.stringify(malformed.contract));
		mutation(candidate);
		assert.equal(core.validateContractShape(candidate), expected);
	}
	const validPolicy = {
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
	};
	assert.equal(core.validateSubagentPolicy(validPolicy), null);
	assert.equal(core.validateSubagentPolicy({ ...validPolicy, profile: "control" }), null);
	assert.equal(core.validateSubagentPolicy({ ...validPolicy, profile: "economy" }), "invalid_subagent_policy_mode");
	assert.equal(core.validateSubagentPolicy(undefined), null);
	assert.equal(core.validateSubagentPolicy(null), "invalid_subagent_policy");
	assert.equal(core.validateSubagentPolicy({ ...validPolicy, maximum_risk: "high" }), "invalid_subagent_policy_maximum_risk");
	assert.equal(core.validateSubagentPolicy({ ...validPolicy, budget_started_at: "2026-08-08T00:00:00.000Z" }), null);
	assert.equal(core.validateSubagentPolicy({ ...validPolicy, budget_started_at: new Date(Date.now() + 120_000).toISOString() }), "invalid_subagent_policy_future_started_at");
	assert.equal(core.validateSubagentPolicy({ ...validPolicy, budget_started_at: "2026-02-31T00:00:00Z" }), "invalid_subagent_policy_started_at");
	assert.equal(core.validateSubagentPolicy({ ...validPolicy, max_children: 9 }), "invalid_subagent_policy_max_children");
	assert.equal(core.validateSubagentPolicy({ ...validPolicy, max_active_children: 5 }), "invalid_subagent_policy_concurrency");
	assert.equal(core.validateSubagentPolicy({ ...validPolicy, max_prompt_bytes: 65_537 }), "invalid_subagent_policy_prompt_limits");
	assert.equal(core.validateSubagentPolicy({ ...validPolicy, root_input_token_baseline: -1 }), "invalid_subagent_policy_root_input_token_baseline");

	const orchestratorExecution = {
		mode: "delegate_required",
		owner_direct_override: true,
		technical_failure_fallback: {
			enabled: true,
			minimum_failed_attempts: 1,
			allowed_failure_kinds: ["spawn_guard_incompatible", "runtime_unavailable"],
			scope: "same_task_only",
			auto_close_on: ["delegation_success", "task_complete", "handoff"],
		},
	};
	const governedPolicy = { ...validPolicy, orchestrator_execution: orchestratorExecution };
	assert.equal(core.validateSubagentPolicy(governedPolicy), null);
	assert.equal(core.validateSubagentPolicy({ ...validPolicy, orchestrator_execution: { ...orchestratorExecution, mode: "direct" } }), "invalid_orchestrator_execution_mode");
	assert.equal(core.validateSubagentPolicy({ ...validPolicy, orchestrator_execution: {
		...orchestratorExecution,
		technical_failure_fallback: { ...orchestratorExecution.technical_failure_fallback, allowed_failure_kinds: ["unknown"] },
	} }), "invalid_orchestrator_failure_kinds");

	const governedContract = {
		...malformed.contract,
		allowed_paths: ["src/**"],
		target_ownership: ["src/malformed/**"],
		allowed_shell_commands: ["pnpm test"],
		subagent_policy: governedPolicy,
	};
	const fallbackTask = {
		schema_version: "orchestrator-fallback-task-v1",
		scope: [governedContract.scope[0]],
		success_criteria: [governedContract.success_criteria[0]],
		allowed_paths: ["src/malformed/worker.js"],
		exact_validators: ["pnpm test"],
	};
	const fallbackTaskDigest = crypto.createHash("sha256").update(JSON.stringify(core.stableValue(fallbackTask))).digest("hex");
	const activatedAt = new Date(Date.now() - 60_000).toISOString();
	const expiresAt = new Date(Date.now() + 20 * 60_000).toISOString();
	const receiptRoot = workspace("failure-receipts-"); roots.push(receiptRoot);
	const previousReceiptDir = process.env.ADK_CODEX_FAILURE_RECEIPT_DIR;
	process.env.ADK_CODEX_FAILURE_RECEIPT_DIR = receiptRoot;
	const failureReceipt = issueFailureReceipt({
		session_id: "M",
		contract_digest: governedContract.contract_digest,
		task_digest: fallbackTaskDigest,
		failure_kind: "spawn_guard_incompatible",
		error_code: "pre_tool_use_block",
		observed_at: activatedAt,
	});
	const technicalFallback = {
		status: "active",
		activation_kind: "technical_failure",
		task_digest: fallbackTaskDigest,
		confirmed_by: "bound_orchestrator",
		confirmed_by_session_id: "M",
		failure_kind: "spawn_guard_incompatible",
		failure_receipts: [failureReceipt.receipt_id],
		allowed_paths: ["src/malformed/worker.js"],
		exact_validators: ["pnpm test"],
		auto_close_on: ["delegation_success", "task_complete", "handoff"],
		task: fallbackTask,
		activated_at: activatedAt,
		expires_at: expiresAt,
	};
	const fallbackProgress = { status: "active", current_phase: "build", orchestrator_fallback: technicalFallback };
	assert.equal(core.validateOrchestratorFallbackEvidence(governedContract, fallbackProgress), null);
	assert.deepEqual(core.orchestratorFallbackAccess(governedContract, fallbackProgress), {
		required: true,
		active: true,
		reason: null,
		taskDigest: fallbackTaskDigest,
		allowedPaths: ["src/malformed/worker.js"],
		exactValidators: ["pnpm test"],
	});
	assert.equal(core.validateOrchestratorFallbackEvidence(governedContract, {
		...fallbackProgress,
		orchestrator_fallback: { ...technicalFallback, allowed_paths: ["src/other.js"] },
	}), "invalid_orchestrator_fallback_task");
	assert.equal(core.validateOrchestratorFallbackEvidence(governedContract, {
		...fallbackProgress,
		orchestrator_fallback: { ...technicalFallback, failure_receipts: [] },
	}), "orchestrator_failure_receipts_insufficient");
	assert.equal(core.validateOrchestratorFallbackEvidence(governedContract, {
		...fallbackProgress,
		orchestrator_fallback: { ...technicalFallback, task_completed_at: activatedAt },
	}), "orchestrator_fallback_must_close");
	assert.equal(core.validateOrchestratorFallbackEvidence(governedContract, {
		...fallbackProgress,
		orchestrator_fallback: {
			...technicalFallback,
			status: "closed",
			closed_at: activatedAt,
			closed_reason: "task_complete",
			task_completed_at: activatedAt,
		},
	}), null);
	assert.equal(core.validateOrchestratorFallbackEvidence(governedContract, {
		...fallbackProgress,
		orchestrator_fallback: { ...technicalFallback, failure_receipts: ["FAIL-" + "0".repeat(32)] },
	}), "orchestrator_failure_receipt_missing");
	const ownerFallback = {
		...technicalFallback,
		activation_kind: "owner_override",
		owner_authorization_ref: "USR-TEST:E01",
	};
	delete ownerFallback.failure_kind;
	delete ownerFallback.failure_receipts;
	assert.equal(core.validateOrchestratorFallbackEvidence(governedContract, {
		...fallbackProgress,
		orchestrator_fallback: ownerFallback,
	}), null);
	if (previousReceiptDir === undefined) delete process.env.ADK_CODEX_FAILURE_RECEIPT_DIR;
	else process.env.ADK_CODEX_FAILURE_RECEIPT_DIR = previousReceiptDir;

	const parent = workspace("session-parent-"); roots.push(parent);
	const parentContract = finishBinding(parent, "PARENT", "parent-contract");
	writeRegistry(parent, {
		PARENT: { contract_id: "parent-contract", contract_path: parentContract.contractPath, contract_digest: parentContract.digest },
	});
	const delegatedTask = {
		schema_version: "delegation-task-v1",
		task_id: "worker-01",
		task_digest: "",
		parent_contract_id: parentContract.contract.id,
		parent_contract_digest: parentContract.digest,
		parent_intent_digest: core.parentIntentDigest(parentContract.contract),
		role: "implementation",
		project_root: parent,
		worktree: parent,
		scope: [parentContract.contract.scope[0]],
		allowed_paths: ["src/parent-contract/**"],
		success_criteria: [parentContract.contract.success_criteria[0]],
		stop_condition: "Stop after the child criterion is verified or hand off any drift.",
		risk: "low",
		exact_validator: null,
		read_only: false,
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
	delegatedTask.task_digest = core.delegationTaskDigest(delegatedTask);
	const delegatedChain = { sessions: [
		{ sessionId: "CHILD", parentId: "PARENT", isSubagent: true, delegatedPrompt: JSON.stringify(delegatedTask) },
		{ sessionId: "PARENT", parentId: null, isSubagent: false },
	], ambiguous: false };
	const derived = core.resolveSessionContract({ cwd: parent, sessionId: "CHILD", sessionChainLookup: () => delegatedChain });
	assert.equal(derived.status, core.STATES.BOUND);
	assert.equal(derived.reason, "derived_delegation_verified");
	assert.deepEqual(derived.contract.allowed_paths, delegatedTask.allowed_paths);
	assert.equal(derived.derivedTask.task_digest, delegatedTask.task_digest);
	const delegatedResult = {
		status: "completed",
		task_digest: delegatedTask.task_digest,
		parent_intent_digest: delegatedTask.parent_intent_digest,
		changed_paths: ["src/parent-contract/file.js"],
		validator_results: [],
		remaining_parent_obligations_preserved: true,
		completion_scope: "child_task_only",
		handoff_reason: null,
	};
	assert.deepEqual(core.parseDelegationResult(JSON.stringify(delegatedResult)), delegatedResult);
	assert.equal(core.validateDelegationResult(delegatedResult, delegatedTask), null);
	assert.equal(core.validateDelegationResult({ ...delegatedResult, completion_scope: "parent_contract" }, delegatedTask), "delegation_parent_obligations_not_preserved");
	assert.equal(core.validateDelegationResult({ ...delegatedResult, changed_paths: ["outside.txt"] }, delegatedTask), "invalid_delegation_result_paths");
	assert.equal(core.validateDelegationResult({ ...delegatedResult, status: "handoff", handoff_reason: "scope drift detected" }, delegatedTask), null);
	assert.equal(core.validateDelegationResult({ ...delegatedResult, status: "handoff", handoff_reason: null }, delegatedTask), "missing_delegation_handoff_reason");
	assert.equal(core.resolveSessionContract({
		cwd: parent,
		sessionId: "CHILD",
		sessionChainLookup: () => ({ ...delegatedChain, sessions: [{ ...delegatedChain.sessions[0], delegatedPrompt: "{}" }, delegatedChain.sessions[1]] }),
	}).reason, "invalid_delegation_task");
	assert.equal(core.resolveSessionContract({
		cwd: parent,
		sessionId: "CHILD",
		sessionChainLookup: () => { throw new Error("lineage backend unavailable"); },
	}).reason, "delegation_lineage_unavailable");
	assert.equal(core.resolveSessionContract({
		cwd: parent,
		sessionId: "CHILD",
		sessionChainLookup: () => ({ ...delegatedChain, ambiguous: true }),
	}).reason, "delegation_lineage_ambiguous");
	assert.equal(core.resolveSessionContract({
		cwd: parent,
		sessionId: "CHILD",
		sessionChainLookup: () => ({ sessions: [delegatedChain.sessions[0]], ambiguous: false }),
	}).reason, "delegation_lineage_incomplete");
	assert.equal(core.resolveSessionContract({
		cwd: parent,
		sessionId: "ROOT",
		sessionChainLookup: () => ({ sessions: [{ sessionId: "ROOT", parentId: null, isSubagent: false }], ambiguous: false }),
	}).status, core.STATES.UNBOUND);
	assert.equal(core.resolveSessionContract({
		cwd: parent,
		sessionId: "CHILD",
		sessionChainLookup: () => ({
			sessions: [delegatedChain.sessions[0], { sessionId: "MISSING", parentId: null, isSubagent: false }],
			ambiguous: false,
		}),
	}).reason, "delegation_lineage_invalid");
	assert.equal(core.resolveSessionContract({
		cwd: parent,
		sessionId: "CHILD",
		sessionChainLookup: () => ({
			sessions: [{ ...delegatedChain.sessions[0], parentId: "MISSING" }, { sessionId: "MISSING", parentId: null, isSubagent: false }],
			ambiguous: false,
		}),
	}).reason, "delegation_parent_unbound");
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
