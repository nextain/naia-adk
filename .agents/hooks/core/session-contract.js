/**
 * Lightweight session-contract resolver shared by session injection and
 * mutation gates. Progress is evidence of execution state, never authority.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const createDelegationContract = require("./delegation-contract.js");
const createHookProjectRoot = require("./hook-project-root.js");
const { verifyFailureReceipts } = require("./subagent-failure-receipt.js");

const STATES = Object.freeze({
	BOUND: "BOUND",
	UNBOUND: "UNBOUND",
	AMBIGUOUS: "AMBIGUOUS",
	STALE: "STALE",
	CROSS_PROJECT: "CROSS_PROJECT",
});
const LEASE_FRESH_MS = 2 * 60 * 1000;

function stableValue(value) {
	if (Array.isArray(value)) return value.map(stableValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, stableValue(value[key])]),
	);
}

function contractDigest(contract) {
	const unsigned = { ...contract };
	delete unsigned.contract_digest;
	unsigned.session_bindings = (unsigned.session_bindings || []).map((binding) => {
		if (!binding || typeof binding !== "object") return binding;
		const normalized = { ...binding };
		delete normalized.contract_digest;
		return normalized;
	});
	return crypto
		.createHash("sha256")
		.update(JSON.stringify(stableValue(unsigned)))
		.digest("hex");
}

function inside(parent, candidate) {
	const relative = path.relative(path.resolve(parent), path.resolve(candidate));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function findProjectRoot(start) {
	let current = path.resolve(start || process.cwd());
	while (true) {
		if (fs.existsSync(path.join(current, ".agents", "context", "agents-rules.json"))) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

const resolveHookProjectRoot = createHookProjectRoot({ findProjectRoot });

function readJson(filePath) {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch {
		return null;
	}
}

function result(status, projectRoot, reason, extra = {}) {
	return { status, projectRoot, reason, ...extra };
}

function bindingSessionId(binding) {
	return typeof binding === "string" ? binding : binding?.session_id;
}

const REQUIRED_ARRAYS = [
	"scope",
	"non_goals",
	"success_criteria",
	"allowed_paths",
	"target_ownership",
	"audiences",
	"source_refs",
	"session_bindings",
];
const CONTRACT_KEYS = new Set([
	"schema_version", "id", "status", "project_root", "goal", "scope",
	"non_goals", "success_criteria", "allowed_paths", "target_ownership",
	"audiences", "source_refs", "session_bindings", "progress_file",
	"contract_digest", "allowed_shell_commands", "subagent_policy",
	"intent_anchor", "l3_session",
]);

const SUBAGENT_POLICY_KEYS = new Set([
	"profile", "context_mode", "budget_started_at",
	"root_input_token_baseline", "root_output_token_baseline",
	"maximum_risk",
	"max_children", "max_active_children", "max_prompt_bytes",
	"max_delegated_prompt_bytes", "max_input_tokens", "max_output_tokens",
	"orchestrator_execution",
]);
const SUBAGENT_HARD_MAX_CHILDREN = 8;
const ORCHESTRATOR_FAILURE_KINDS = new Set([
	"spawn_guard_incompatible",
	"spawn_api_incompatible",
	"runtime_binding_unavailable",
	"runtime_unavailable",
	"worker_start_failure",
]);
const ORCHESTRATOR_AUTO_CLOSE_EVENTS = ["delegation_success", "task_complete", "handoff"];
const ORCHESTRATOR_FALLBACK_MAX_MS = 30 * 60 * 1000;
function canonicalTimestamp(value) {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) return null;
	const normalized = /\.\d{3}Z$/.test(value) ? value : value.replace(/Z$/, ".000Z");
	return new Date(parsed).toISOString() === normalized ? normalized : null;
}

function validateOrchestratorExecutionPolicy(policy) {
	if (policy === undefined) return null;
	if (!policy || typeof policy !== "object" || Array.isArray(policy)) return "invalid_orchestrator_execution";
	const keys = new Set(["mode", "owner_direct_override", "technical_failure_fallback"]);
	if (Object.keys(policy).some((key) => !keys.has(key))) return "invalid_orchestrator_execution_property";
	if (policy.mode !== "delegate_required" || typeof policy.owner_direct_override !== "boolean") return "invalid_orchestrator_execution_mode";
	const fallback = policy.technical_failure_fallback;
	if (!fallback || typeof fallback !== "object" || Array.isArray(fallback)) return "invalid_orchestrator_failure_fallback";
	const fallbackKeys = new Set(["enabled", "minimum_failed_attempts", "allowed_failure_kinds", "scope", "auto_close_on"]);
	if (Object.keys(fallback).some((key) => !fallbackKeys.has(key))) return "invalid_orchestrator_failure_fallback_property";
	if (typeof fallback.enabled !== "boolean" || !Number.isSafeInteger(fallback.minimum_failed_attempts) || fallback.minimum_failed_attempts < 1 || fallback.minimum_failed_attempts > 3) {
		return "invalid_orchestrator_failure_fallback_limits";
	}
	if (fallback.scope !== "same_task_only") return "invalid_orchestrator_failure_fallback_scope";
	if (!Array.isArray(fallback.allowed_failure_kinds) || fallback.allowed_failure_kinds.length === 0 ||
		new Set(fallback.allowed_failure_kinds).size !== fallback.allowed_failure_kinds.length ||
		fallback.allowed_failure_kinds.some((kind) => !ORCHESTRATOR_FAILURE_KINDS.has(kind))) {
		return "invalid_orchestrator_failure_kinds";
	}
	if (JSON.stringify(fallback.auto_close_on) !== JSON.stringify(ORCHESTRATOR_AUTO_CLOSE_EVENTS)) return "invalid_orchestrator_auto_close_events";
	return null;
}

function validateSubagentPolicy(policy) {
	if (policy === undefined) return null;
	if (!policy || typeof policy !== "object" || Array.isArray(policy)) return "invalid_subagent_policy";
	if (Object.keys(policy).some((key) => !SUBAGENT_POLICY_KEYS.has(key))) return "invalid_subagent_policy_property";
	if (!new Set(["balanced", "control"]).has(policy.profile) || policy.context_mode !== "isolated") return "invalid_subagent_policy_mode";
	if (!new Set(["low", "medium"]).has(policy.maximum_risk)) return "invalid_subagent_policy_maximum_risk";
	const startedAt = typeof policy.budget_started_at === "string" ? Date.parse(policy.budget_started_at) : NaN;
	const canonicalStartedAt = Number.isFinite(startedAt) ? new Date(startedAt).toISOString() : null;
	const normalizedStartedAt = typeof policy.budget_started_at === "string"
		? (/\.\d{3}Z$/.test(policy.budget_started_at)
			? policy.budget_started_at
			: policy.budget_started_at.replace(/Z$/, ".000Z"))
		: null;
	if (
		typeof policy.budget_started_at !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(policy.budget_started_at) ||
		!Number.isFinite(startedAt) ||
		canonicalStartedAt !== normalizedStartedAt
	) return "invalid_subagent_policy_started_at";
	// A future activation epoch would hide already-running descendants and
	// effectively reset every durable budget counter. Allow only small clock
	// skew; contracts that need a later epoch must not become active yet.
	if (startedAt > Date.now() + 60_000) return "invalid_subagent_policy_future_started_at";
	for (const key of ["root_input_token_baseline", "root_output_token_baseline"]) {
		if (!Number.isSafeInteger(policy[key]) || policy[key] < 0) return `invalid_subagent_policy_${key}`;
	}
	for (const key of ["max_children", "max_active_children", "max_prompt_bytes", "max_delegated_prompt_bytes", "max_input_tokens", "max_output_tokens"]) {
		if (!Number.isSafeInteger(policy[key]) || policy[key] <= 0) return `invalid_subagent_policy_${key}`;
	}
	if (policy.max_children > SUBAGENT_HARD_MAX_CHILDREN) return "invalid_subagent_policy_max_children";
	if (policy.max_active_children > policy.max_children) return "invalid_subagent_policy_concurrency";
	if (policy.max_prompt_bytes > policy.max_delegated_prompt_bytes) return "invalid_subagent_policy_prompt_limits";
	const orchestratorError = validateOrchestratorExecutionPolicy(policy.orchestrator_execution);
	if (orchestratorError) return orchestratorError;
	return null;
}

function ownershipPatternCovers(parentPattern, childPattern) {
	if (!supportedOwnershipPattern(parentPattern) || !supportedOwnershipPattern(childPattern)) return false;
	const parentPrefix = String(parentPattern).replace(/\/\*\*$/, "").replace(/\/$/, "");
	const childPrefix = String(childPattern).replace(/\/\*\*$/, "").replace(/\/$/, "");
	return parentPattern.endsWith("/**")
		? childPrefix === parentPrefix || childPrefix.startsWith(`${parentPrefix}/`)
		: parentPattern === childPattern;
}

function fallbackPathCovered(contract, candidate) {
	return (contract.allowed_paths || []).some((pattern) => ownershipPatternCovers(pattern, candidate)) &&
		(contract.target_ownership || []).some((pattern) => ownershipPatternCovers(pattern, candidate));
}

function validateOrchestratorFallbackEvidence(contract, progress, opts = {}) {
	const fallback = progress?.orchestrator_fallback;
	if (fallback === undefined) return null;
	const policy = contract?.subagent_policy?.orchestrator_execution;
	if (validateOrchestratorExecutionPolicy(policy)) return "orchestrator_fallback_not_authorized";
	if (!fallback || typeof fallback !== "object" || Array.isArray(fallback)) return "invalid_orchestrator_fallback";
	const keys = new Set([
		"status", "activation_kind", "task_digest", "confirmed_by", "owner_authorization_ref",
		"confirmed_by_session_id",
		"failure_kind", "failure_receipts", "allowed_paths", "exact_validators", "auto_close_on",
		"task", "activated_at", "expires_at", "closed_at", "closed_reason", "delegation_succeeded_at", "task_completed_at", "handoff_at",
	]);
	if (Object.keys(fallback).some((key) => !keys.has(key))) return "invalid_orchestrator_fallback_property";
	if (!new Set(["active", "closed"]).has(fallback.status)) return "invalid_orchestrator_fallback_status";
	if (!new Set(["technical_failure", "owner_override"]).has(fallback.activation_kind)) return "invalid_orchestrator_fallback_activation";
	if (!/^[a-f0-9]{64}$/.test(fallback.task_digest || "") || fallback.confirmed_by !== "bound_orchestrator" ||
		typeof fallback.confirmed_by_session_id !== "string" || !(contract.session_bindings || []).some((binding) => bindingSessionId(binding) === fallback.confirmed_by_session_id)) return "invalid_orchestrator_fallback_binding";
	const activatedAt = canonicalTimestamp(fallback.activated_at);
	const expiresAt = canonicalTimestamp(fallback.expires_at);
	if (!activatedAt || !expiresAt || Date.parse(expiresAt) <= Date.parse(activatedAt) || Date.parse(expiresAt) - Date.parse(activatedAt) > ORCHESTRATOR_FALLBACK_MAX_MS) return "invalid_orchestrator_fallback_timestamp";
	const fallbackTask = fallback.task;
	if (!fallbackTask || typeof fallbackTask !== "object" || Array.isArray(fallbackTask) ||
		JSON.stringify(Object.keys(fallbackTask).sort()) !== JSON.stringify(["allowed_paths", "exact_validators", "schema_version", "scope", "success_criteria"].sort()) ||
		fallbackTask.schema_version !== "orchestrator-fallback-task-v1" ||
		fallback.task_digest !== crypto.createHash("sha256").update(JSON.stringify(stableValue(fallbackTask))).digest("hex") ||
		!Array.isArray(fallbackTask.scope) || fallbackTask.scope.length === 0 || fallbackTask.scope.some((item) => !(contract.scope || []).includes(item)) ||
		!Array.isArray(fallbackTask.success_criteria) || fallbackTask.success_criteria.length === 0 || fallbackTask.success_criteria.some((item) => !(contract.success_criteria || []).includes(item)) ||
		JSON.stringify(fallbackTask.allowed_paths) !== JSON.stringify(fallback.allowed_paths) ||
		JSON.stringify(fallbackTask.exact_validators) !== JSON.stringify(fallback.exact_validators)) return "invalid_orchestrator_fallback_task";
	if (JSON.stringify(fallback.auto_close_on) !== JSON.stringify(policy.technical_failure_fallback.auto_close_on)) return "invalid_orchestrator_fallback_lifecycle";
	if (!Array.isArray(fallback.allowed_paths) || fallback.allowed_paths.length === 0 ||
		new Set(fallback.allowed_paths).size !== fallback.allowed_paths.length ||
		fallback.allowed_paths.some((candidate) => !fallbackPathCovered(contract, candidate))) return "invalid_orchestrator_fallback_paths";
	if (!Array.isArray(fallback.exact_validators) || fallback.exact_validators.length === 0 ||
		new Set(fallback.exact_validators).size !== fallback.exact_validators.length ||
		fallback.exact_validators.some((command) => !(contract.allowed_shell_commands || []).includes(command))) return "invalid_orchestrator_fallback_validators";

	if (fallback.activation_kind === "technical_failure") {
		const technical = policy.technical_failure_fallback;
		if (!technical.enabled || !technical.allowed_failure_kinds.includes(fallback.failure_kind)) return "orchestrator_technical_fallback_disabled";
		if (!Array.isArray(fallback.failure_receipts) || fallback.failure_receipts.length < technical.minimum_failed_attempts) return "orchestrator_failure_receipts_insufficient";
		const receiptError = verifyFailureReceipts(fallback.failure_receipts, {
			session_id: fallback.confirmed_by_session_id,
			contract_digest: contract.contract_digest,
			task_digest: fallback.task_digest,
			failure_kind: fallback.failure_kind,
			activated_at: activatedAt,
		}, opts);
		if (receiptError) return receiptError;
	} else {
		if (!policy.owner_direct_override || typeof fallback.owner_authorization_ref !== "string" ||
			!(contract.source_refs || []).includes(fallback.owner_authorization_ref)) return "invalid_owner_direct_override";
		if (fallback.failure_kind !== undefined || fallback.failure_receipts !== undefined) return "invalid_owner_direct_override_evidence";
	}

	const closeMarkers = [fallback.delegation_succeeded_at, fallback.task_completed_at, fallback.handoff_at].filter((value) => value !== undefined);
	if (closeMarkers.some((value) => !canonicalTimestamp(value))) return "invalid_orchestrator_fallback_close_timestamp";
	if (fallback.status === "active") {
		if (Date.now() >= Date.parse(expiresAt)) return "orchestrator_fallback_expired";
		if (fallback.closed_at !== undefined || fallback.closed_reason !== undefined || closeMarkers.length > 0 || progress?.status !== "active" || progress?.current_phase === "close") {
			return "orchestrator_fallback_must_close";
		}
	} else {
		const eventMarker = {
			delegation_success: fallback.delegation_succeeded_at,
			task_complete: fallback.task_completed_at,
			handoff: fallback.handoff_at,
		}[fallback.closed_reason];
		if (!canonicalTimestamp(fallback.closed_at) || !fallback.auto_close_on.includes(fallback.closed_reason) || !canonicalTimestamp(eventMarker)) {
			return "invalid_orchestrator_fallback_closure";
		}
	}
	return null;
}

function orchestratorFallbackAccess(contract, progress) {
	const policy = contract?.subagent_policy?.orchestrator_execution;
	if (!policy || policy.mode !== "delegate_required") return { required: false, active: false, reason: null };
	const error = validateOrchestratorFallbackEvidence(contract, progress);
	if (error) return { required: true, active: false, reason: error };
	const fallback = progress?.orchestrator_fallback;
	if (!fallback || fallback.status !== "active") return { required: true, active: false, reason: "orchestrator_delegation_required" };
	return {
		required: true,
		active: true,
		reason: null,
		taskDigest: fallback.task_digest,
		allowedPaths: fallback.allowed_paths,
		exactValidators: fallback.exact_validators,
	};
}

function supportedOwnershipPattern(value) {
	if (typeof value !== "string" || !value || path.isAbsolute(value) || value.includes("..")) return false;
	const stars = value.match(/\*/g) || [];
	return stars.length === 0 || (stars.length === 2 && value.endsWith("/**"));
}

function validateIntentAnchor(anchor) {
	if (!anchor || typeof anchor !== "object" || Array.isArray(anchor) ||
		JSON.stringify(Object.keys(anchor).sort()) !== JSON.stringify(["schema_version", "source_path", "source_digest", "root_issue_id", "invariant_ids"].sort())) return "invalid_intent_anchor";
	if (anchor.schema_version !== "intent-anchor-v1" || !/^\.agents\/(?:progress|requirements)\/[^/]+\.json$/.test(anchor.source_path || "") ||
		!/^[a-f0-9]{64}$/.test(anchor.source_digest || "") || typeof anchor.root_issue_id !== "string" || !anchor.root_issue_id.trim() ||
		!Array.isArray(anchor.invariant_ids) || anchor.invariant_ids.length === 0 || new Set(anchor.invariant_ids).size !== anchor.invariant_ids.length ||
		anchor.invariant_ids.some((id) => typeof id !== "string" || !id.trim())) return "invalid_intent_anchor";
	return null;
}

function validateL3Session(value) {
	if (!value || typeof value !== "object" || Array.isArray(value) ||
		JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["generation", "handoff_state", "handoff_source_ref"].sort()) ||
		!Number.isSafeInteger(value.generation) || value.generation < 1 || !new Set(["active", "required"]).has(value.handoff_state)) return "invalid_l3_session";
	if (value.handoff_state === "active" && value.handoff_source_ref !== null) return "invalid_l3_session_handoff";
	if (value.handoff_state === "required" && (typeof value.handoff_source_ref !== "string" || !value.handoff_source_ref)) return "invalid_l3_session_handoff";
	return null;
}

function validateContractShape(contract) {
	if (!contract || typeof contract !== "object" || Array.isArray(contract)) return "contract_not_object";
	if (Object.keys(contract).some((key) => !CONTRACT_KEYS.has(key))) return "contract_additional_property";
	if (!new Set(["1.0", "1.1"]).has(contract.schema_version)) return "unsupported_schema_version";
	if (contract.schema_version === "1.1") {
		const anchorError = validateIntentAnchor(contract.intent_anchor);
		if (anchorError) return anchorError;
		const l3Error = validateL3Session(contract.l3_session);
		if (l3Error) return l3Error;
	} else if (contract.intent_anchor !== undefined || contract.l3_session !== undefined) return "v1_1_fields_require_schema_v1_1";
	if (typeof contract.id !== "string" || !contract.id) return "invalid_contract_id";
	if (!["active", "closed"].includes(contract.status)) return "invalid_contract_status";
	if (contract.project_root !== ".") return "invalid_project_root";
	for (const key of ["goal", "progress_file", "contract_digest"]) {
		if (typeof contract[key] !== "string" || !contract[key]) return `invalid_${key}`;
	}
	for (const key of REQUIRED_ARRAYS) {
		if (!Array.isArray(contract[key])) return `invalid_${key}`;
	}
	for (const key of ["scope", "non_goals", "success_criteria", "allowed_paths", "target_ownership", "audiences", "source_refs"]) {
		if (contract[key].some((item) => typeof item !== "string")) return `invalid_${key}_item`;
	}
	if (contract.allowed_shell_commands != null && (
		!Array.isArray(contract.allowed_shell_commands) ||
		contract.allowed_shell_commands.some((item) => typeof item !== "string" || !item.trim() || /[\r\n]/.test(item))
	)) return "invalid_allowed_shell_commands";
	const subagentPolicyError = validateSubagentPolicy(contract.subagent_policy);
	if (subagentPolicyError) return subagentPolicyError;
	for (const key of ["scope", "success_criteria", "allowed_paths", "target_ownership", "audiences", "source_refs", "session_bindings"]) {
		if (contract[key].length === 0) return `empty_${key}`;
	}
	if (!contract.allowed_paths.every(supportedOwnershipPattern)) return "unsupported_allowed_path_pattern";
	if (!contract.target_ownership.every(supportedOwnershipPattern)) return "unsupported_target_ownership_pattern";
	if (!contract.session_bindings.every((binding) =>
		binding && typeof binding === "object" && !Array.isArray(binding) &&
		Object.keys(binding).every((key) => ["session_id", "contract_digest"].includes(key)) &&
		typeof binding.session_id === "string" && binding.session_id &&
		/^[a-f0-9]{64}$/.test(binding.contract_digest || "")
	)) return "invalid_session_bindings";
	if (!/^\.agents\/progress\/[^/]+\.json$/.test(contract.progress_file)) return "invalid_progress_file";
	if (!/^[a-f0-9]{64}$/.test(contract.contract_digest)) return "invalid_contract_digest";
	return null;
}

function activeContracts(contractsDir) {
	let names = [];
	try {
		names = fs.readdirSync(contractsDir);
	} catch {
		return [];
	}
	return names
		.filter((name) => name.endsWith(".json") && !name.startsWith("."))
		.map((name) => {
			const filePath = path.join(contractsDir, name);
			return { filePath, contract: readJson(filePath) };
		})
		.filter(({ contract }) => contract && contract.status === "active");
}

function ownershipPatterns(contract) {
	return Array.isArray(contract.target_ownership) ? contract.target_ownership : [];
}

function ownershipPrefix(pattern) {
	return String(pattern).replace(/\/\*\*.*$/, "").replace(/\/$/, "");
}

function ownershipOverlaps(left, right) {
	for (const a of ownershipPatterns(left)) {
		for (const b of ownershipPatterns(right)) {
			const ap = ownershipPrefix(a);
			const bp = ownershipPrefix(b);
			if (ap === bp || ap.startsWith(`${bp}/`) || bp.startsWith(`${ap}/`)) return true;
		}
	}
	return false;
}

function contractHasFreshLease(projectRoot, contract, now = Date.now()) {
	return (contract.session_bindings || []).some((binding) => {
		const sessionId = bindingSessionId(binding);
		if (!sessionId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(sessionId)) return false;
		const lease = readJson(path.join(projectRoot, ".agents", "session-contracts", ".recovery", "leases", `${sessionId}.json`));
		const updated = Date.parse(lease?.updated_at || "");
		return lease?.state === "active" && Number.isFinite(updated) && now - updated >= 0 && now - updated <= LEASE_FRESH_MS;
	});
}

/**
 * Resolve an explicit lightweight session binding in the nearest project only.
 * No ancestor workspace or child project is searched.
 */
function resolveExplicitSessionContract({ cwd, sessionId }) {
	const projectRoot = findProjectRoot(cwd);
	if (!projectRoot || !sessionId) {
		return result(STATES.UNBOUND, projectRoot, "missing_project_or_session");
	}

	const contractsDir = path.join(projectRoot, ".agents", "session-contracts");
	const registryPath = path.join(contractsDir, ".session-map.json");
	const registry = readJson(registryPath);
	if (!registry) return result(STATES.UNBOUND, projectRoot, "registry_missing");

	const pointer = registry.bindings?.[sessionId];
	if (!pointer) return result(STATES.UNBOUND, projectRoot, "binding_missing");
	if (!pointer.contract_path || !pointer.contract_id || !pointer.contract_digest) {
		return result(STATES.STALE, projectRoot, "binding_incomplete", { registryPath });
	}

	const contractPath = path.resolve(projectRoot, pointer.contract_path);
	if (!inside(contractsDir, contractPath) || path.basename(contractPath).startsWith(".")) {
		return result(STATES.CROSS_PROJECT, projectRoot, "contract_path_outside_project", {
			registryPath,
			contractPath,
		});
	}

	const contract = readJson(contractPath);
	if (!contract) {
		return result(STATES.STALE, projectRoot, "contract_missing_or_invalid", {
			registryPath,
			contractPath,
		});
	}
	const shapeError = validateContractShape(contract);
	if (shapeError) {
		return result(STATES.STALE, projectRoot, shapeError, {
			registryPath,
			contractPath,
		});
	}
	if (contract.id !== pointer.contract_id || contract.status !== "active") {
		return result(STATES.STALE, projectRoot, "contract_identity_or_status_mismatch", {
			registryPath,
			contractPath,
		});
	}
	const ownershipConflicts = activeContracts(contractsDir).filter(
		({ filePath, contract: candidate }) =>
			path.resolve(filePath) !== contractPath &&
			!(candidate.session_bindings || []).some((binding) => bindingSessionId(binding) === sessionId) &&
			contractHasFreshLease(projectRoot, candidate) && ownershipOverlaps(contract, candidate),
	);
	if (ownershipConflicts.length > 0) {
		return result(STATES.AMBIGUOUS, projectRoot, "target_ownership_conflict", {
			contractPath,
			conflictingContractPaths: ownershipConflicts.map(({ filePath }) => filePath),
		});
	}

	const declaredRoot = path.resolve(projectRoot, contract.project_root || ".");
	if (declaredRoot !== projectRoot) {
		return result(STATES.CROSS_PROJECT, projectRoot, "contract_project_mismatch", {
			registryPath,
			contractPath,
		});
	}

	const expectedDigest = contractDigest(contract);
	if (
		contract.contract_digest !== expectedDigest ||
		pointer.contract_digest !== expectedDigest
	) {
		return result(STATES.STALE, projectRoot, "contract_digest_mismatch", {
			registryPath,
			contractPath,
			expectedDigest,
		});
	}
	if (contract.schema_version === "1.1") {
		const anchorPath = path.resolve(projectRoot, contract.intent_anchor.source_path);
		if (!inside(projectRoot, anchorPath) || !fs.existsSync(anchorPath)) return result(STATES.STALE, projectRoot, "intent_anchor_missing", { contractPath, anchorPath });
		const digest = crypto.createHash("sha256").update(fs.readFileSync(anchorPath)).digest("hex");
		if (digest !== contract.intent_anchor.source_digest) return result(STATES.STALE, projectRoot, "intent_anchor_digest_mismatch", { contractPath, anchorPath });
		const anchor = readJson(anchorPath);
		const serialized = JSON.stringify(anchor || {});
		if (!anchor || !serialized.includes(contract.intent_anchor.root_issue_id) || contract.intent_anchor.invariant_ids.some((id) => !serialized.includes(id))) {
			return result(STATES.STALE, projectRoot, "intent_anchor_content_mismatch", { contractPath, anchorPath });
		}
		if (contract.l3_session.handoff_state === "required") return result(STATES.STALE, projectRoot, "l3_handoff_required", { contractPath, handoffSourceRef: contract.l3_session.handoff_source_ref });
	}

	const matchingBindings = (contract.session_bindings || []).filter(
		(binding) => bindingSessionId(binding) === sessionId,
	);
	if (matchingBindings.length > 1) {
		return result(STATES.AMBIGUOUS, projectRoot, "duplicate_binding_in_contract", {
			registryPath,
			contractPath,
		});
	}
	const binding = matchingBindings[0];
	if (!binding || typeof binding === "string" || binding.contract_digest !== expectedDigest) {
		return result(STATES.STALE, projectRoot, "contract_binding_mismatch", {
			registryPath,
			contractPath,
		});
	}

	const progressPath = path.resolve(projectRoot, contract.progress_file || "");
	const progressDir = path.join(projectRoot, ".agents", "progress");
	if (!contract.progress_file || !inside(progressDir, progressPath)) {
		return result(STATES.CROSS_PROJECT, projectRoot, "progress_path_outside_project", {
			registryPath,
			contractPath,
			progressPath,
		});
	}
	const progress = readJson(progressPath);
	if (
		!progress ||
		progress.contract_id !== contract.id ||
		progress.contract_digest !== expectedDigest
	) {
		return result(STATES.STALE, projectRoot, "progress_contract_mismatch", {
			registryPath,
			contractPath,
			progressPath,
		});
	}
	const fallbackError = validateOrchestratorFallbackEvidence(contract, progress);
	if (fallbackError) {
		return result(STATES.STALE, projectRoot, fallbackError, {
			registryPath,
			contractPath,
			progressPath,
		});
	}

	return result(STATES.BOUND, projectRoot, "explicit_binding_verified", {
		registryPath,
		contractPath,
		contract,
		progressPath,
		progress,
	});
}

const {
	delegationTaskDigest,
	parentIntentDigest,
	parseDelegationTask,
	parseDelegationResult,
	resolveDirectParentLineage,
	validateDelegationTask,
	validateDelegationResult,
} = createDelegationContract({
	stableValue,
	ownershipPatternCovers,
	resolveExplicitSessionContract,
	result,
	STATES,
});

function resolveSessionContract({ cwd, sessionId, sessionChainLookup = null }) {
	const explicit = resolveExplicitSessionContract({ cwd, sessionId });
	if (explicit.status !== STATES.UNBOUND || explicit.reason !== "binding_missing") return explicit;
	return resolveDirectParentLineage({ cwd, sessionId, explicit, sessionChainLookup });
}

module.exports = {
	STATES,
	SUBAGENT_HARD_MAX_CHILDREN,
	contractDigest,
	delegationTaskDigest,
	findProjectRoot,
	inside,
	orchestratorFallbackAccess,
	parentIntentDigest,
	parseDelegationTask,
	parseDelegationResult,
	ownershipOverlaps,
	contractHasFreshLease,
	ownershipPatternCovers,
	resolveSessionContract,
	resolveExplicitSessionContract,
	resolveHookProjectRoot,
	stableValue,
	supportedOwnershipPattern,
	validateContractShape,
	validateDelegationTask,
	validateDelegationResult,
	validateOrchestratorExecutionPolicy,
	validateOrchestratorFallbackEvidence,
	validateSubagentPolicy,
};
