const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DELEGATION_TASK_KEYS = new Set([
	"schema_version", "task_id", "task_digest", "parent_contract_id", "parent_contract_digest",
	"parent_intent_digest", "role", "project_root", "worktree", "scope", "allowed_paths",
	"success_criteria", "stop_condition", "risk", "exact_validator", "read_only", "result_contract",
]);
const DELEGATION_RESULT_FIELDS = [
	"status", "task_digest", "parent_intent_digest", "changed_paths", "validator_results",
	"remaining_parent_obligations_preserved", "completion_scope", "handoff_reason",
];

module.exports = function createDelegationContract({
	stableValue,
	ownershipPatternCovers,
	resolveExplicitSessionContract,
	result,
	STATES,
}) {
	function delegationTaskDigest(task) {
		const unsigned = { ...task };
		delete unsigned.task_digest;
		return crypto.createHash("sha256").update(JSON.stringify(stableValue(unsigned))).digest("hex");
	}

	function parentIntentDigest(contract) {
		return crypto.createHash("sha256").update(JSON.stringify(stableValue({
			goal: contract?.goal,
			scope: contract?.scope,
			non_goals: contract?.non_goals,
			success_criteria: contract?.success_criteria,
			source_refs: contract?.source_refs,
			intent_anchor: contract?.intent_anchor,
			l3_session: contract?.l3_session,
		}))).digest("hex");
	}

	function parseDelegationTask(message) {
		if (typeof message !== "string" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(message)) return null;
		let task;
		try { task = JSON.parse(message); } catch { return null; }
		if (!task || typeof task !== "object" || Array.isArray(task) || Object.keys(task).some((key) => !DELEGATION_TASK_KEYS.has(key))) return null;
		return task;
	}

	function parseDelegationResult(message) {
		if (typeof message !== "string" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(message)) return null;
		let value;
		try { value = JSON.parse(message); } catch { return null; }
		return value && typeof value === "object" && !Array.isArray(value) ? value : null;
	}

	function validateDelegationResult(value, task) {
		if (!value || typeof value !== "object" || Array.isArray(value) ||
			JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...DELEGATION_RESULT_FIELDS].sort())) return "invalid_delegation_result";
		if (!new Set(["completed", "blocked", "handoff"]).has(value.status)) return "invalid_delegation_result_status";
		if (value.task_digest !== task?.task_digest || value.parent_intent_digest !== task?.parent_intent_digest) return "delegation_result_binding_mismatch";
		if (!Array.isArray(value.changed_paths) || new Set(value.changed_paths).size !== value.changed_paths.length ||
			value.changed_paths.some((candidate) => typeof candidate !== "string" || !candidate.trim() ||
				!(task?.allowed_paths || []).some((pattern) => ownershipPatternCovers(pattern, candidate)))) return "invalid_delegation_result_paths";
		if (task?.read_only && value.changed_paths.length > 0) return "read_only_delegation_changed_paths";
		if (!Array.isArray(value.validator_results)) return "invalid_delegation_validator_results";
		if (task?.exact_validator === null) {
			if (value.validator_results.length !== 0) return "unexpected_delegation_validator_result";
		} else {
			if (value.validator_results.length !== 1) return "invalid_delegation_validator_results";
			const validator = value.validator_results[0];
			if (!validator || typeof validator !== "object" || Array.isArray(validator) ||
				JSON.stringify(Object.keys(validator).sort()) !== JSON.stringify(["command", "status"]) ||
				validator.command !== task?.exact_validator || !new Set(["passed", "failed", "not_run"]).has(validator.status)) return "invalid_delegation_validator_result";
			if (value.status === "completed" && validator.status !== "passed") return "completed_delegation_validator_not_passed";
		}
		if (value.remaining_parent_obligations_preserved !== true || value.completion_scope !== "child_task_only") return "delegation_parent_obligations_not_preserved";
		if (value.status === "completed") {
			if (value.handoff_reason !== null) return "unexpected_delegation_handoff_reason";
		} else if (typeof value.handoff_reason !== "string" || !value.handoff_reason.trim()) {
			return "missing_delegation_handoff_reason";
		}
		return null;
	}

	function validateDelegationTask(task, contract, projectRoot) {
		if (!task || task.schema_version !== "delegation-task-v1" || typeof task.task_id !== "string" || !/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(task.task_id)) return "invalid_delegation_task";
		if (!/^[a-f0-9]{64}$/u.test(task.task_digest || "") || task.task_digest !== delegationTaskDigest(task)) return "delegation_task_digest_mismatch";
		if (task.parent_contract_id !== contract?.id || task.parent_contract_digest !== contract?.contract_digest) return "delegation_parent_mismatch";
		if (task.parent_intent_digest !== parentIntentDigest(contract)) return "delegation_parent_intent_mismatch";
		for (const [key, parentKey] of [["scope", "scope"], ["success_criteria", "success_criteria"]]) {
			if (!Array.isArray(task[key]) || task[key].length === 0 || task[key].some((item) => typeof item !== "string" || !(contract?.[parentKey] || []).includes(item))) return `invalid_delegation_${key}`;
		}
		if (!Array.isArray(task.allowed_paths) || task.allowed_paths.length === 0 || task.allowed_paths.some((candidate) =>
			!(contract?.allowed_paths || []).some((pattern) => ownershipPatternCovers(pattern, candidate)) ||
			!(contract?.target_ownership || []).some((pattern) => ownershipPatternCovers(pattern, candidate)))) return "invalid_delegation_allowed_paths";
		if (typeof task.stop_condition !== "string" || !task.stop_condition.trim() || typeof task.read_only !== "boolean" || !new Set(["low", "medium"]).has(task.risk)) return "invalid_delegation_execution_boundary";
		if (task.exact_validator !== null && (!(contract?.allowed_shell_commands || []).includes(task.exact_validator) || typeof task.exact_validator !== "string")) return "invalid_delegation_validator";
		let canonicalRoot;
		try { canonicalRoot = fs.realpathSync(projectRoot); } catch { return "invalid_delegation_project_root"; }
		for (const candidate of [task.project_root, task.worktree]) {
			if (typeof candidate !== "string" || !path.isAbsolute(candidate)) return "invalid_delegation_project_root";
			try { if (fs.realpathSync(candidate) !== canonicalRoot) return "invalid_delegation_project_root"; } catch { return "invalid_delegation_project_root"; }
		}
		const resultContract = task.result_contract;
		if (!resultContract || typeof resultContract !== "object" || Array.isArray(resultContract) ||
			JSON.stringify(Object.keys(resultContract).sort()) !== JSON.stringify(["completion_scope", "drift_action", "required_fields", "schema_version"].sort()) ||
			resultContract.schema_version !== "delegation-result-v1" || resultContract.completion_scope !== "child_task_only" ||
			resultContract.drift_action !== "handoff_to_parent" || JSON.stringify(resultContract.required_fields) !== JSON.stringify(DELEGATION_RESULT_FIELDS)) return "invalid_delegation_result_contract";
		return null;
	}

	function resolveDirectParentLineage({ cwd, sessionId, explicit, sessionChainLookup = null }) {
		let chain;
		try {
			chain = (sessionChainLookup || ((value) => require("../../../scripts/codex-lineage-usage.cjs").collectSessionChain(value)))({ sessionId });
		} catch {
			return result(STATES.STALE, explicit.projectRoot, "delegation_lineage_unavailable");
		}
		if (chain?.ambiguous) return result(STATES.STALE, explicit.projectRoot, "delegation_lineage_ambiguous");
		if (!Array.isArray(chain?.sessions) || chain.sessions.length < 2) {
			const child = chain?.sessions?.[0];
			return child?.sessionId === sessionId && child?.isSubagent
				? result(STATES.STALE, explicit.projectRoot, "delegation_lineage_incomplete")
				: explicit;
		}
		const child = chain.sessions[0];
		const parent = chain.sessions[1];
		if (child?.sessionId !== sessionId || !child.isSubagent || child.parentId !== parent?.sessionId || typeof child.delegatedPrompt !== "string") {
			return result(STATES.STALE, explicit.projectRoot, "delegation_lineage_invalid");
		}
		const parentResolution = resolveExplicitSessionContract({ cwd, sessionId: parent.sessionId });
		if (parentResolution.status !== STATES.BOUND) return result(STATES.STALE, explicit.projectRoot, "delegation_parent_unbound");
		const task = parseDelegationTask(child.delegatedPrompt);
		const taskError = validateDelegationTask(task, parentResolution.contract, explicit.projectRoot);
		if (taskError) return result(STATES.STALE, explicit.projectRoot, taskError);
		const contract = {
			schema_version: parentResolution.contract.schema_version,
			id: `${parentResolution.contract.id}::${task.task_id}`,
			status: "active",
			project_root: ".",
			goal: parentResolution.contract.goal,
			scope: task.scope,
			non_goals: parentResolution.contract.non_goals,
			success_criteria: task.success_criteria,
			allowed_paths: task.allowed_paths,
			target_ownership: task.allowed_paths,
			audiences: parentResolution.contract.audiences,
			source_refs: parentResolution.contract.source_refs,
			session_bindings: [{ session_id: sessionId, contract_digest: task.task_digest }],
			progress_file: parentResolution.contract.progress_file,
			contract_digest: task.task_digest,
			allowed_shell_commands: task.exact_validator === null ? [] : [task.exact_validator],
			...(parentResolution.contract.intent_anchor ? { intent_anchor: parentResolution.contract.intent_anchor } : {}),
			...(parentResolution.contract.l3_session ? { l3_session: parentResolution.contract.l3_session } : {}),
		};
		return result(STATES.BOUND, explicit.projectRoot, "derived_delegation_verified", {
			contract,
			progress: { status: "active", current_phase: "worker", contract_id: contract.id, contract_digest: task.task_digest },
			derivedTask: task,
			parentContract: parentResolution.contract,
		});
	}

	return {
		delegationTaskDigest,
		parentIntentDigest,
		parseDelegationTask,
		parseDelegationResult,
		validateDelegationTask,
		validateDelegationResult,
		resolveDirectParentLineage,
	};
};
