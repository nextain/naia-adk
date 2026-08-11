#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const contracts = require("../../.agents/hooks/core/session-contract.js");
const usage = require("../../scripts/codex-lineage-usage.cjs");
const { issueFailureReceipt } = require("../../.agents/hooks/core/subagent-failure-receipt.js");

// collaborationspawn_agent is the name the Windows Codex host actually passes
// to hooks — flattened, no separator — captured from a live run.
const SPAWN_NAMES = new Set(["spawn_agent", "collaboration.spawn_agent", "collaborationspawn_agent", "multi_agent_v1__spawn_agent"]);
const WAIT_NAMES = new Set(["wait_agent", "collaboration.wait_agent", "collaborationwait_agent", "multi_agent_v1__wait_agent"]);
const FOLLOWUP_NAMES = new Set(["followup_task", "followup-task", "followuptask", "resume_agent", "resume-agent"]);
const FOLLOWUP_MESSAGE_NAMES = new Set(["send_input", "send-input", "send_message", "send-message", "sendmessage"]);
const DELEGATION_NAMESPACES = new Set(["agent", "agents", "codex", "collaboration", "delegation", "multi_agent", "multi-agent", "subagent", "subagents"]);
const TASK_KEYS = new Set([
	"schema_version", "task_id", "task_digest", "parent_contract_id", "parent_contract_digest",
	"parent_intent_digest", "role", "project_root", "worktree", "scope", "allowed_paths",
	"success_criteria", "stop_condition", "risk", "exact_validator", "read_only", "result_contract",
]);
const READ_ONLY_ROLES = new Set(["explorer", "analysis", "design", "review"]);
const EXACT_VALIDATOR_ROLES = new Set(["implementation", "test", "generic_worker", "translation"]);
const LOW_RISK_ROLES = new Set(["implementation", "test", "translation", "generic_worker"]);
const ROLE_POLICY_ALIASES = Object.freeze({
	mechanical_implementation: "implementation",
	"mechanical-implementation": "implementation",
	mechanical_test: "test",
	"mechanical-test": "test",
	worker: "generic_worker",
	"generic-worker": "generic_worker",
	gateway: "secretary",
	issue_manager: "issue_leader",
});
const catalogPath = path.resolve(__dirname, "../../packages/benchmark-contract/baselines/development-composition-profiles.json");

function normalizedToolName(name) {
	const value = String(name || "").trim().toLowerCase();
	return { value, leaf: value.split(/__|[.:/]/).filter(Boolean).at(-1) || "" };
}

function namedLike(name, set) {
	const { value, leaf } = normalizedToolName(name);
	return set.has(value) || set.has(leaf);
}

function isSpawn(name) {
	return SPAWN_NAMES.has(normalizedToolName(name).value);
}

function isWait(name) {
	return WAIT_NAMES.has(normalizedToolName(name).value);
}

function delegationRuntime(name) {
	const value = normalizedToolName(name).value;
	if (value === "multi_agent_v1__spawn_agent" || value === "multi_agent_v1__wait_agent") return "multi_agent_v1";
	if (["spawn_agent", "wait_agent", "collaboration.spawn_agent", "collaboration.wait_agent", "collaborationspawn_agent", "collaborationwait_agent"].includes(value)) return "collaboration";
	return null;
}

function isFollowup(name, rawInput = {}) {
	if (namedLike(name, FOLLOWUP_NAMES)) return true;
	const { value, leaf } = normalizedToolName(name);
	if (!FOLLOWUP_MESSAGE_NAMES.has(leaf)) return false;
	const segments = value.split(/__|[.:/]/).filter(Boolean);
	if (segments.length > 1 && segments.slice(0, -1).some((segment) => DELEGATION_NAMESPACES.has(segment))) return true;
	// Native Codex send_input is unqualified. Require its agent-shaped input so
	// an unrelated connector with the same common leaf name is not intercepted.
	const input = inputOf(rawInput);
	return (leaf === "send_input" || leaf === "send-input") &&
		(typeof input.agent_id === "string" || (typeof input.id === "string" && !Object.hasOwn(input, "channel_id") && !Object.hasOwn(input, "channelId"))) &&
		["message", "input", "prompt"].some((key) => typeof input[key] === "string");
}

function isPotentialDelegation(name, rawInput) {
	if (isSpawn(name) || isFollowup(name, rawInput)) return true;
	const { value, leaf } = normalizedToolName(name);
	// `task` is Claude Code's spawn tool; without it this guard waved Claude's
	// subagents through while blocking Codex's own.
	const namedAsDelegation = /(?:^|[_-])(?:task|spawn|subagent|delegate|delegation|agent|worker)(?:$|[_-])/u.test(leaf) ||
		/(?:spawn|subagent|delegate|delegation|launch_agent|create_agent|agent_run|agent_task|worker_run)/u.test(value);
	const input = inputOf(rawInput);
	const shapedAsDelegation = typeof input.model === "string" &&
		["message", "prompt", "task", "items"].some((key) => Object.hasOwn(input, key)) &&
		["fork_context", "fork_turns", "reasoning_effort", "reasoning"].some((key) => Object.hasOwn(input, key));
	return namedAsDelegation || shapedAsDelegation;
}

function inputOf(input) {
	if (typeof input === "string") {
		try { return JSON.parse(input); } catch { return {}; }
	}
	if (input && typeof input === "object") {
		for (const key of ["arguments", "input"]) {
			if (typeof input[key] === "string") {
				try { return { ...input, ...JSON.parse(input[key]) }; } catch { return {}; }
			}
		}
		return input;
	}
	return {};
}

function block(reason) {
	return { decision: "block", reason: `[SUBAGENT GUARD] ${reason}` };
}

function technicalBlock(reason, failureKind, errorCode, binding) {
	try {
		const receipt = issueFailureReceipt({
			session_id: binding.sessionId,
			contract_digest: binding.contract.contract_digest,
			task_digest: binding.task.task_digest,
			failure_kind: failureKind,
			error_code: errorCode,
		}, { env: binding.env });
		return block(`${reason}; host failure receipt: ${receipt.receipt_id}`);
	} catch {
		return block(`${reason}; host failure receipt issuance failed closed`);
	}
}

function taskDigest(task) {
	return contracts.delegationTaskDigest(task);
}

function parseBrief(message) {
	if (typeof message !== "string" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(message)) return null;
	let task;
	try { task = JSON.parse(message); } catch { return null; }
	if (!task || typeof task !== "object" || Array.isArray(task) || Object.keys(task).some((key) => !TASK_KEYS.has(key))) return null;
	return task;
}

function briefText(input, runtime = "multi_agent_v1") {
	if (!input || typeof input !== "object" || Object.hasOwn(input, "items")) return null;
	if (runtime === "multi_agent_v1") return typeof input.message === "string" ? input.message : null;
	return typeof input.prompt === "string" && !Object.hasOwn(input, "message") ? input.prompt : null;
}

function roleOf(input, runtime = "multi_agent_v1") {
	return canonicalRole(parseBrief(briefText(input, runtime))?.role);
}

function contextOk(input, runtime = "multi_agent_v1") {
	if (runtime === "multi_agent_v1") {
		if (!Object.hasOwn(input, "fork_context") || input.fork_context !== false) return false;
		return !Object.hasOwn(input, "fork_turns") || input.fork_turns === "none";
	}
	if (runtime === "collaboration") {
		return input.fork_turns === "none" && (!Object.hasOwn(input, "fork_context") || input.fork_context === false);
	}
	return false;
}

function canonicalRole(role) {
	const normalized = String(role || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
	return ROLE_POLICY_ALIASES[normalized] || normalized;
}

function realDirectory(value) {
	if (typeof value !== "string" || !path.isAbsolute(value)) return null;
	try {
		const resolved = fs.realpathSync(value);
		return fs.statSync(resolved).isDirectory() ? resolved : null;
	} catch { return null; }
}

function patternPrefix(pattern) {
	return String(pattern).replace(/\/\*\*$/, "").replace(/\/$/, "");
}

function patternCovers(parentPattern, childPattern) {
	if (!contracts.supportedOwnershipPattern(parentPattern) || !contracts.supportedOwnershipPattern(childPattern)) return false;
	const parentPrefix = patternPrefix(parentPattern);
	const childPrefix = patternPrefix(childPattern);
	if (parentPattern.endsWith("/**")) return childPrefix === parentPrefix || childPrefix.startsWith(`${parentPrefix}/`);
	return parentPattern === childPattern;
}

function coveredByEveryBoundary(candidate, contract) {
	return (contract.allowed_paths || []).some((pattern) => patternCovers(pattern, candidate)) &&
		(contract.target_ownership || []).some((pattern) => patternCovers(pattern, candidate));
}

function roleRules(profileId = "balanced") {
	const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
	const profile = catalog?.profiles?.find((item) => item.id === profileId);
	const policies = catalog?.balanced_role_policy;
	const bindings = catalog?.bindings;
	if (!profile || !bindings || String(profile.activation || "").startsWith("disabled")) throw new Error("development profile is not active");
	const assignments = profileId === "balanced" ? Object.fromEntries(Object.entries(policies || {}).map(([role, value]) => [role, value.binding])) : {
		secretary: profile.assignments.orchestrator, issue_leader: profile.assignments.integrator,
		explorer: profile.assignments.bounded_worker, analysis: profile.assignments.reviewer_pool[0],
		design: profile.assignments.reviewer_pool[0], review: profile.assignments.reviewer_pool[0],
		implementation: profile.assignments.bounded_worker, test: profile.assignments.tester,
		generic_worker: profile.assignments.mechanical_worker, translation: profile.assignments.mechanical_worker,
	};
	return Object.fromEntries(Object.keys(assignments).map((role) => {
		const bindingId = assignments[role], binding = bindings[bindingId];
		if (!binding?.model) throw new Error(`development profile binding invalid for ${role}`);
		const allowed = profileId === "balanced" ? policies[role].allowed_reasoning_efforts : profile.reasoning_effort ? [profile.reasoning_effort] : (binding.allowed_reasoning_efforts || [binding.default_reasoning_effort || "medium"]);
		return [role, [binding.model, allowed, bindingId]];
	}));
}

function availableBindings(env = process.env) {
	const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
	const envName = catalog?.activation?.codex_bound_sessions?.available_bindings_env;
	const known = new Set(Object.keys(catalog?.bindings || {}));
	if (!envName || known.size === 0) throw new Error("Balanced binding availability catalog missing");
	if (!Object.hasOwn(env, envName)) return new Set();
	const raw = String(env[envName] ?? "").trim();
	if (!raw || raw.toLowerCase() === "none" || raw === "[]") return new Set();
	const declared = raw.split(",").map((item) => item.trim()).filter(Boolean);
	if (declared.length === 0 || declared.some((binding) => !known.has(binding))) throw new Error("Balanced binding availability is invalid");
	return new Set(declared);
}

function validateBrief(task, { env, contract }) {
	if (!task) return "a digest-bound delegation task JSON object is required";
	const sharedError = contracts.validateDelegationTask(task, contract, env?.ADK_PROJECT_ROOT);
	if (sharedError) return sharedError.replaceAll("_", " ");
	if (task.schema_version !== "delegation-task-v1" || typeof task.task_id !== "string" || !/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(task.task_id)) {
		return "delegation task schema or task_id is invalid";
	}
	if (!/^[a-f0-9]{64}$/u.test(task.task_digest || "") || task.task_digest !== taskDigest(task)) return "delegation task digest mismatch";
	if (task.parent_contract_id !== contract?.id || task.parent_contract_digest !== contract?.contract_digest) return "delegation task is not bound to the current parent contract";
	const role = canonicalRole(task.role);
	if (!Object.hasOwn(roleRules(), role)) return "delegation task role is not in the canonical profile catalog";
	if (!Array.isArray(task.scope) || task.scope.length === 0 || task.scope.some((item) => typeof item !== "string" || !item.trim())) return "delegation task scope is invalid";
	if (task.scope.some((item) => !(contract?.scope || []).includes(item))) return "delegation task scope must be an exact subset of parent scope";
	if (!Array.isArray(task.success_criteria) || task.success_criteria.length === 0 || task.success_criteria.some((item) => typeof item !== "string" || !item.trim())) return "delegation task success criteria are invalid";
	if (task.success_criteria.some((item) => !(contract?.success_criteria || []).includes(item))) return "delegation task success criteria must be an exact subset of parent success criteria";
	if (!Array.isArray(task.allowed_paths) || task.allowed_paths.length === 0 || task.allowed_paths.some((item) => !coveredByEveryBoundary(item, contract))) {
		return "delegation task allowed_paths must be a supported subset of parent allowed_paths and target_ownership";
	}
	if (typeof task.stop_condition !== "string" || !task.stop_condition.trim()) return "delegation task stop_condition is required";
	if (!new Set(["low", "medium"]).has(task.risk)) return "delegation task risk must be low or medium";
	if (LOW_RISK_ROLES.has(role) && task.risk !== "low") return "Luna implementation, test, translation, and worker roles require low risk";
	if ({ low: 0, medium: 1 }[task.risk] > { low: 0, medium: 1 }[contract?.subagent_policy?.maximum_risk]) return "delegation task risk exceeds the parent policy maximum";
	if (typeof task.read_only !== "boolean") return "delegation task read_only must be boolean";
	if (EXACT_VALIDATOR_ROLES.has(role)) {
		if (typeof task.exact_validator !== "string" || !task.exact_validator.trim()) return "this Luna role requires an exact validator command";
		if (!(contract?.allowed_shell_commands || []).includes(task.exact_validator)) return "the exact validator command must be declared by the parent contract";
	} else if (task.exact_validator !== null) {
		return "non-implementation roles must declare exact_validator as null";
	}
	if (READ_ONLY_ROLES.has(role) && task.read_only !== true) return "this analysis role must be read-only";
	const projectRoot = realDirectory(task.project_root);
	const worktree = realDirectory(task.worktree);
	const environmentRoot = realDirectory(env?.ADK_PROJECT_ROOT);
	if (!projectRoot || !worktree || !environmentRoot || environmentRoot !== projectRoot || worktree !== projectRoot) {
		return "project_root, worktree, and inherited ADK_PROJECT_ROOT must resolve to the current governed worktree";
	}
	return null;
}

function evaluate({
	toolName,
	toolInput = {},
	sessionId = null,
	cwd = process.cwd(),
	env = process.env,
	contractLookup = null,
	sessionCollection = null,
	lineageReserve = null,
} = {}) {
	if (isFollowup(toolName, toolInput)) return block("follow-up or resumed delegation is disabled; create a new digest-bound task from the root session");
	if (!isSpawn(toolName) && isPotentialDelegation(toolName, toolInput)) {
		return block("unrecognized delegation-capable wrapper is disabled; use the governed spawn tool with a digest-bound task");
	}
	if (!isSpawn(toolName)) return null;
	const input = inputOf(toolInput);
	const runtime = delegationRuntime(toolName);
	const resolved = (contractLookup || ((value) => contracts.resolveSessionContract(value)))({ cwd: realDirectory(env?.ADK_PROJECT_ROOT) || cwd, sessionId });
	if (resolved?.status !== contracts.STATES.BOUND) {
		// Unbound is the ordinary working state, and requiring BOUND here meant a
		// Codex host could never spawn while a Claude host could. Same semantics
		// as the Claude guard, from the same implementation: an operator opt-in
		// marker plus a per-session spawn budget, for either runtime — the
		// result-envelope restriction below only governs the bound digest path.
		// Context inheritance stays blocked first either way.
		if (!contextOk(input, runtime)) return block("explicit fork_context false is required; fork_turns must be none when the runtime exposes it");
		const budget = require("../../.claude/hooks/subagent-spawn-guard.js").evaluate({ toolName: "task", sessionId, root: cwd, env });
		return budget ? { decision: "block", reason: budget.reason } : null;
	}
	// The collaboration transport has a different mailbox/result envelope. It
	// remains recognized so wrappers cannot bypass the guard, but is denied until
	// a captured host schema can be validated end-to-end. The active Codex host
	// uses multi_agent_v1 and is covered below;
	// the unbound budget path above is runtime-agnostic.
	if (runtime !== "multi_agent_v1") return block("this delegation runtime has no registered result-envelope adapter; use multi_agent_v1 or register captured host evidence first");
	const policy = resolved.contract?.subagent_policy;
	if (!Object.hasOwn(resolved.contract || {}, "subagent_policy") || contracts.validateSubagentPolicy(policy)) return block("a valid contract subagent_policy is required");
	if (!contextOk(input, runtime)) return block("explicit fork_context false is required; fork_turns must be none when the runtime exposes it");
	const message = briefText(input, runtime);
	if (!message) return block("one digest-bound delegation task is required");
	const task = parseBrief(message);
	const briefError = validateBrief(task, { env, contract: resolved.contract });
	if (briefError) return block(briefError);
	let rules;
	try { rules = roleRules(policy.profile || "balanced"); } catch { return block("the selected development profile is undefined or incomplete"); }
	const rule = rules[canonicalRole(task.role)];
	if (!rule || input.model !== rule[0] || !rule[1].includes(input.reasoning_effort) || Object.hasOwn(input, "reasoning")) {
		return block("role, model, or reasoning effort is not permitted by the selected development profile");
	}
	const failureBinding = { sessionId, contract: resolved.contract, task, env };
	let availability;
	try { availability = availableBindings(env); } catch { return technicalBlock("runtime binding availability is invalid", "runtime_binding_unavailable", "availability_catalog_invalid", failureBinding); }
	if (!availability.has(rule[2])) return technicalBlock("the selected Balanced binding is unavailable in this runtime", "runtime_binding_unavailable", `binding_unavailable:${rule[2]}`, failureBinding);
	const promptBytes = Buffer.byteLength(message, "utf8");
	const collected = (sessionCollection || (() => usage.collectSessions({
		since: Date.parse(policy.budget_started_at),
		includeSessionId: sessionId,
	})))();
	const lineage = usage.findLineage(collected, sessionId, policy);
	const evaluation = usage.evaluateLineage(lineage, { policy, spawningSessionId: sessionId, pendingPromptBytes: promptBytes });
	if (!evaluation.ok) return block(evaluation.reasons.join(" / "));
	const reserve = (lineageReserve || ((value) => usage.reserveLineageSpawn(value, policy, undefined, promptBytes)))(lineage, policy, promptBytes);
	if (!reserve?.ok) return block("lineage reservation failed closed");
	return null;
}

function evaluateResult({
	toolName,
	toolInput = {},
	toolResponse = {},
	sessionId = null,
	cwd = process.cwd(),
	env = process.env,
	contractLookup = null,
	sessionChainLookup = null,
} = {}) {
	if (!isWait(toolName)) return null;
	if (delegationRuntime(toolName) !== "multi_agent_v1") {
		return block("this delegation runtime has no registered result-envelope adapter; delegated results denied");
	}
	const input = inputOf(toolInput);
	const response = inputOf(toolResponse);
	if (!Array.isArray(input.targets) || input.targets.length === 0 ||
		new Set(input.targets).size !== input.targets.length || input.targets.some((target) => typeof target !== "string" || !target)) {
		return block("wait_agent targets are invalid; delegated results denied");
	}
	if (response.timed_out === true) return null;
	if (!response.status || typeof response.status !== "object" || Array.isArray(response.status)) {
		return block("wait_agent result evidence is missing; delegated results denied");
	}
	const projectRoot = realDirectory(env?.ADK_PROJECT_ROOT) || realDirectory(cwd);
	for (const target of input.targets) {
		const status = response.status[target];
		if (!status || typeof status !== "object" || Array.isArray(status) || !Object.hasOwn(status, "completed")) continue;
		if (typeof status.completed !== "string") return block("completed worker returned no structured result");
		let chain;
		try {
			chain = (sessionChainLookup || ((value) => usage.collectSessionChain(value)))({ sessionId: target });
		} catch {
			return block("completed worker lineage is unavailable or ambiguous");
		}
		if (chain?.ambiguous || !Array.isArray(chain?.sessions) || chain.sessions.length < 2) return block("completed worker lineage is unavailable or ambiguous");
		const child = chain.sessions[0];
		const parent = chain.sessions[1];
		if (child?.sessionId !== target || !child.isSubagent || child.parentId !== sessionId || parent?.sessionId !== sessionId || typeof child.delegatedPrompt !== "string") {
			return block("completed worker is not a direct child of the bound orchestrator");
		}
		const resolved = (contractLookup || ((value) => contracts.resolveExplicitSessionContract(value)))({ cwd: projectRoot || cwd, sessionId });
		if (resolved?.status !== contracts.STATES.BOUND) return block("completed worker parent contract is not bound");
		const task = contracts.parseDelegationTask(child.delegatedPrompt);
		const taskError = contracts.validateDelegationTask(task, resolved.contract, projectRoot);
		if (taskError) return block(`completed worker task binding is invalid: ${taskError}`);
		const result = contracts.parseDelegationResult(status.completed);
		const resultError = contracts.validateDelegationResult(result, task);
		if (resultError) return block(`completed worker result is invalid: ${resultError}`);
	}
	return null;
}

async function main() {
	let raw = "";
	for await (const chunk of process.stdin) raw += chunk;
	let input;
	try { input = JSON.parse(raw); } catch {
		process.stdout.write(JSON.stringify(block("malformed hook input; denied")));
		return;
	}
	if (!input || typeof input !== "object" || typeof input.tool_name !== "string" || !input.tool_name.trim()) {
		process.stdout.write(JSON.stringify(block("required hook evidence is missing; denied")));
		return;
	}
	const args = {
		toolName: input.tool_name,
		toolInput: input.tool_input,
		sessionId: input.session_id,
		cwd: input.cwd || process.cwd(),
	};
	const result = input.hook_event_name === "PostToolUse"
		? evaluateResult({ ...args, toolResponse: input.tool_response })
		: evaluate(args);
	if (result) process.stdout.write(JSON.stringify(result));
}

if (require.main === module) main().catch(() => process.stdout.write(JSON.stringify(block("guard error; denied"))));

module.exports = {
	EXACT_VALIDATOR_ROLES,
	READ_ONLY_ROLES,
	availableBindings,
	contextOk,
	delegationRuntime,
	evaluate,
	evaluateResult,
	inputOf,
	isFollowup,
	isPotentialDelegation,
	isSpawn,
	isWait,
	parseBrief,
	patternCovers,
	roleOf,
	roleRules,
	canonicalRole,
	taskDigest,
	validateBrief,
};
