/**
 * harness-core — tool-agnostic harness logic (SoT).
 *
 * Pure logic, NO host I/O envelope. Host adapters (.claude/hooks/*,
 * future .pi/extensions/*) translate their event/stdin into these calls
 * and wrap the returned data in their host's expected output format.
 *
 * Extracted from .claude/hooks/{session-inject,post-compact-context}.js
 * (G-OC01 part1, scope A — pure refactor, behavior byte-identical).
 * No forbidden_actions schema here (deferred = option B).
 */

const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const { STATES, orchestratorFallbackAccess, resolveSessionContract } = require("./session-contract.js");
const harnessSwitch = require("./harness-switch.js");

const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const HARNESS_OFF_VALUES = new Set(["off", "0", "false", "no"]);

const PHASE_LABELS = {
	issue: "1. Issue",
	understand: "2. Understand ⛩ GATE",
	scope: "3. Scope ⛩ GATE",
	investigate: "4. Investigate",
	plan: "5. Plan ⛩ GATE",
	build: "6. Build",
	review: "7. Review",
	e2e_test: "8. E2E Test",
	post_test_review: "9. Post-test Review",
	sync: "10. Sync ⛩ GATE",
	sync_verify: "11. Sync Verify",
	report: "12. Report",
	commit: "13. Commit",
	close: "Closed (terminal state)",
};

const GATE_PHASES = new Set(["understand", "scope", "plan", "sync"]);

function stableValue(value) {
	if (Array.isArray(value)) return value.map(stableValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function codexDevelopmentProfile(projectRoot, env) {
	const catalogPath = path.join(
		projectRoot,
		"packages",
		"benchmark-contract",
		"baselines",
		"development-composition-profiles.json",
	);
	const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
	if (
		catalog.schema_revision !== "development-composition-profiles-v3" ||
		catalog.status !== "active_balanced_default_no_total_cost_claim" ||
		catalog.default_profile !== "balanced" ||
		catalog.fallback_profile !== "control" ||
		catalog.activation?.codex_bound_sessions?.mode !== "default_active" ||
		catalog.activation.codex_bound_sessions.override_env !== "CODEX_DEVELOPMENT_PROFILE" ||
		catalog.activation.codex_bound_sessions.available_bindings_env !== "CODEX_AVAILABLE_BINDINGS" ||
		!Array.isArray(catalog.profiles) ||
		!catalog.profiles.some((profile) => profile.id === catalog.default_profile) ||
		!catalog.profiles.some((profile) => profile.id === catalog.fallback_profile) ||
		!Array.isArray(catalog.availability?.default_available_bindings) ||
		!catalog.claim_boundary?.forbidden_until_phase_2?.includes("proven_total_cost_reduction")
	) {
		throw new Error("Codex development profile catalog identity invalid");
	}
	if (catalog.availability.default_available_bindings.some((binding) => !catalog.bindings?.[binding])) {
		throw new Error("Codex development profile catalog availability invalid");
	}
	const overrideName = catalog.activation.codex_bound_sessions.override_env;
	const override = Object.prototype.hasOwnProperty.call(env, overrideName)
		? String(env[overrideName]).trim()
		: "";
	const profileId = override || catalog.default_profile;
	const selectedProfile = catalog.profiles.find((profile) => profile.id === profileId);
	if (!selectedProfile) {
		throw new Error(`unknown development profile ${profileId}`);
	}
	const availabilityName = catalog.activation.codex_bound_sessions.available_bindings_env;
	const rawAvailability = Object.prototype.hasOwnProperty.call(env, availabilityName)
		? String(env[availabilityName]).trim()
		: null;
	const availableBindings = rawAvailability === null
		? []
		: rawAvailability === "" || rawAvailability === "[]" || rawAvailability.toLowerCase() === "none"
			? []
			: rawAvailability.split(",").map((binding) => binding.trim()).filter(Boolean);
	if (!availableBindings.every((binding) => catalog.bindings[binding])) {
		throw new Error("available Codex development bindings are invalid");
	}
	const assignedBindings = new Set([
		selectedProfile.assignments.orchestrator,
		selectedProfile.assignments.integrator,
		selectedProfile.assignments.bounded_worker,
		selectedProfile.assignments.mechanical_worker,
		selectedProfile.assignments.tester,
		...selectedProfile.assignments.reviewer_pool,
	]);
	if (profileId === "delegated") assignedBindings.delete("implementation_worker");
	const unavailableBindings = [...assignedBindings]
		.filter((binding) => !availableBindings.includes(binding))
		.sort();
	if (unavailableBindings.length > 0) {
		throw new Error(
			`development profile ${profileId} is unavailable; missing bindings: ${unavailableBindings.join(", ")}`,
		);
	}
	const catalogDigest = crypto
		.createHash("sha256")
		.update(JSON.stringify(stableValue(catalog)), "utf8")
		.digest("hex");
	return {
		profileId,
		activationSource: override ? "environment_override" : "catalog_default",
		availableBindings: [...availableBindings].sort(),
		fallbackProfile: catalog.fallback_profile,
		unavailablePolicy: catalog.availability.unavailable_policy,
		catalogDigest,
	};
}

function atomicWriteJson(filePath, value) {
	const dir = path.dirname(filePath);
	const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
	fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
	fs.renameSync(tmp, filePath);
}

function readProgress(filePath) {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch {
		return null;
	}
}

/**
 * Canonical post-compact / session-start re-read reminder.
 * @param {{entryPoint?:string}} [opts]  entryPoint default "CLAUDE.md"
 *   (host-neutral override; a pi adapter passes e.g. "AGENTS.md").
 * @returns {string}
 */
function compactReminderMessage(opts) {
	const entryPoint = (opts && opts.entryPoint) || "CLAUDE.md";
	return [
		"⚠️ Context compacted or new session started.",
		"",
		"MANDATORY — read before any action:",
		"  1. .agents/context/agents-rules.json",
		"  2. .agents/context/project-index.yaml",
		"  3. the registry-bound .agents/session-contracts contract and its progress file",
		"  4. every contract source_ref needed to recover the parent issue intent",
		"",
		"Contract preservation:",
		"  current_task is a child execution unit, never the whole parent contract.",
		"  Do not shrink, delete, supersede, or mark parent obligations complete from worker-local context.",
		"",
		"If working inside a subproject (projects/<name>/):",
		"  Read projects/<name>/AGENTS.md FIRST.",
		"  Do not assume context from root — each subproject carries its own truth.",
		"",
		"Context placement rule:",
		`  Root context  → .agents/context/ or ${entryPoint}`,
		"  Project context → projects/<name>/AGENTS.md or .agents/context/",
		"  Do NOT cross-pollinate.",
	].join("\n");
}

/**
 * Resolve the active session's progress state and build the harness
 * inject text. Tool-agnostic: caller supplies cwd, sessionId, hooksDir.
 *
 * @param {{cwd:string, sessionId:(string|null), hooksDir:string,
 *          env?:NodeJS.ProcessEnv, optOutEnvVar?:string,
 *          hostConfigDir?:string}} opts
 *   optOutEnvVar  default "CLAUDE_HARNESS" (host-neutral override)
 *   hostConfigDir default ".claude" (opt-out marker + unlock msg dir)
 * @returns {{text:string}|null}  null = suppress (opt-out / no progress / unbound).
 */
function buildSessionInject(opts) {
	const cwd = opts.cwd;
	const sessionId = opts.sessionId || null;
	const env = opts.env || process.env;
	// Host-neutral conventions. Defaults preserve Claude Code behavior
	// byte-identically; a non-Claude adapter (e.g. pi) passes its own.
	const optOutEnvVar = opts.optOutEnvVar || "CLAUDE_HARNESS";
	const hostConfigDir = opts.hostConfigDir || ".claude";
	const DESIGN_DOC_UNLOCK = path.resolve(opts.hooksDir, "..", "design-doc-unlock");

	// Opt-out: env var or marker file
	const envFlag = (env[optOutEnvVar] || "").trim().toLowerCase();
	if (HARNESS_OFF_VALUES.has(envFlag)) return null;
	// Walks upward: a marker at the repository root also disables enforcement
	// for a session whose cwd is a sub-project.
	if (harnessSwitch.findHarnessMarker({ cwd, configDirs: [hostConfigDir] })) return null;

	const resolution = resolveSessionContract({
		cwd,
		sessionId,
		...(opts.sessionChainLookup ? { sessionChainLookup: opts.sessionChainLookup } : {}),
	});
	// Unbound and invalid bindings are deliberately silent in prompt injection.
	// The mutation gate uses the same result and reports the actionable reason.
	if (resolution.status !== STATES.BOUND) return null;
	const progress = resolution.progress;
	const contract = resolution.contract;
	const parentContract = resolution.parentContract || contract;

	const currentPhase = progress.current_phase || "unknown";
	const phaseLabel = PHASE_LABELS[currentPhase] || currentPhase;
	const gatesCleared = (progress.gates_cleared || []).join(", ") || "none yet";

	const lines = [
		"══ [HARNESS: SESSION STATE] ══════════════════════════════",
		`Issue : ${progress.issue || "unknown"}${progress.issue_url ? " — " + progress.issue_url : ""}`,
		`Phase : ${phaseLabel}`,
		`Gates : cleared=[${gatesCleared}]`,
		`Execution contract: ${contract.id} (${contract.contract_digest.slice(0, 12)})`,
		`Parent contract: ${parentContract.id} (${parentContract.contract_digest.slice(0, 12)})`,
		...(sessionId ? [`Session: ${sessionId} (bind: ${resolution.reason === "derived_delegation_verified" ? "derived delegation" : "explicit"})`] : []),
		"── [HARNESS: PARENT CONTRACT — PRESERVE] ───────────────",
		`Goal: ${parentContract.goal}`,
		...parentContract.scope.map((item, index) => `Scope ${index + 1}: ${item}`),
		...parentContract.success_criteria.map((item, index) => `Acceptance ${index + 1}: ${item}`),
		...parentContract.non_goals.map((item, index) => `Non-goal ${index + 1}: ${item}`),
		...parentContract.source_refs.map((item, index) => `Intent ref ${index + 1}: ${item}`),
		"Invariant: current_task is a child unit; it cannot replace, shrink, delete, or complete the parent contract.",
	];

	if (resolution.reason === "derived_delegation_verified") {
		const task = resolution.derivedTask;
		lines.push(
			"── [HARNESS: CURRENT CHILD CONTRACT] ─────────────────",
			...task.scope.map((item, index) => `Child scope ${index + 1}: ${item}`),
			...task.success_criteria.map((item, index) => `Child acceptance ${index + 1}: ${item}`),
			...task.allowed_paths.map((item, index) => `Child path ${index + 1}: ${item}`),
			`Stop condition: ${task.stop_condition}`,
			`Task digest: ${task.task_digest}`,
			`Parent intent digest: ${task.parent_intent_digest}`,
			"Nested delegation is forbidden for a derived worker; return to the bound orchestrator instead.",
			"Final response MUST be one raw delegation-result-v1 JSON object with exactly the required_fields; no Markdown fence or commentary.",
			"Completion applies to child_task_only. On drift or ambiguity, return status=handoff with a non-empty handoff_reason.",
		);
	}

	if (hostConfigDir === ".codex") {
		const activation = codexDevelopmentProfile(resolution.projectRoot, env);
		const fallback = resolution.reason === "derived_delegation_verified"
			? { required: false }
			: orchestratorFallbackAccess(contract, progress);
		lines.push(
			"── [HARNESS: CODEX DEVELOPMENT PROFILE] ────────────────",
			`Active profile: ${activation.profileId} (source: ${activation.activationSource})`,
			`Catalog: ${activation.catalogDigest}`,
			`Available bindings: ${activation.availableBindings.join(", ") || "none"}`,
			`Fallback: ${activation.fallbackProfile}; ${activation.unavailablePolicy}`,
			"Claim boundary: total development cost reduction is not proven",
		);
		if (fallback.required) {
			lines.push(
				"── [HARNESS: ORCHESTRATOR EXECUTION] ────────────────",
				"Root role: L3 secretary / L2 issue leader; delegate implementation, testing, and translation",
				"Accept a worker completion only through wait_agent after its delegation-result-v1 passes the PostToolUse result guard.",
				fallback.active
					? `Direct fallback: ACTIVE for same task only (${fallback.taskDigest.slice(0, 12)}); cost, context, validation, and review guards remain active`
					: `Direct fallback: BLOCKED (${fallback.reason}); use a governed worker or obtain a source-bound owner override after a confirmed technical failure`,
			);
		}
	}

	if (progress.current_task) {
		lines.push(
			"── [HARNESS: CURRENT CHILD TASK] ──────────────────────",
			`Task  : ${progress.current_task}`,
			"Authority: execute this child task only; parent intent and remaining obligations stay owned by the orchestrator.",
		);
	}

	if (currentPhase === "close") {
		lines.push(
			"⛔ [HARNESS] Progress is marked closed, but this session contract is still active. Close or unbind the contract before treating mutation authority as ended.",
		);
	}

	const decisions = progress.key_decisions || [];
	if (decisions.length > 0) {
		lines.push(`Decisions: ${decisions.join(" | ")}`);
	}

	const phaseKeys = Object.keys(PHASE_LABELS);
	const currentIdx = phaseKeys.indexOf(currentPhase);
	const nextPhase = phaseKeys[currentIdx + 1];
	if (nextPhase && GATE_PHASES.has(nextPhase)) {
		lines.push(
			`⚠ Next checkpoint: ${PHASE_LABELS[nextPhase]} — internal checkpoint; ask only if an unresolved material choice remains`,
		);
	}

	const REVIEW_REQUIRED_PHASES = new Set(["review", "post_test_review"]);
	const REVIEW_RECOMMENDED_PHASES = new Set([
		"e2e_test",
		"sync",
		"sync_verify",
		"commit",
	]);

	const reviewLog = progress.review_log;
	const isReviewLogCurrent =
		reviewLog &&
		(!reviewLog.phase ||
			reviewLog.phase === currentPhase ||
			(currentPhase === "e2e_test" && reviewLog.phase === "review") ||
			(currentPhase === "sync" && reviewLog.phase === "post_test_review") ||
			(currentPhase === "sync_verify" && reviewLog.phase === "post_test_review") ||
			(currentPhase === "commit" &&
				(reviewLog.phase === "post_test_review" || reviewLog.phase === "review")) ||
			(currentPhase === "report" &&
				(reviewLog.phase === "post_test_review" || reviewLog.phase === "review")));
	const effectiveReviewLog = isReviewLogCurrent ? reviewLog : null;

	if (REVIEW_REQUIRED_PHASES.has(currentPhase) && !effectiveReviewLog) {
		lines.push(
			`⛔ [HARNESS] Phase "${phaseLabel}" REQUIRES /review-pass completion. No review_log found in progress file. Run /review-pass before proceeding.`,
		);
	} else if (REVIEW_RECOMMENDED_PHASES.has(currentPhase) && !effectiveReviewLog) {
		lines.push(
			`⚠ [HARNESS] No review_log in progress file. Verify that /review-pass was completed in a prior phase before proceeding.`,
		);
	} else if (effectiveReviewLog && effectiveReviewLog.result !== "2_consecutive_clean") {
		lines.push(
			`⚠ [HARNESS] Last review did not achieve 2 consecutive clean passes (result: ${effectiveReviewLog.result}). Consider re-running /review-pass.`,
		);
	}

	if (currentPhase === "e2e_test") {
		lines.push(
			"⛔ [HARNESS] E2E = 실제 사용자 시나리오 재현. 함수 호출/기능 흐름 통과는 통합테스트일 뿐. 반드시 실제 앱(Tauri/웹서버)을 실행하고, 해당 기능이 닿는 사용자 여정 전체를 훑을 것.",
		);
	}

	if (fs.existsSync(DESIGN_DOC_UNLOCK)) {
		lines.push(
			`⚠ [HARNESS] design-doc-unlock ACTIVE — design documents are currently editable. Remove ${hostConfigDir}/design-doc-unlock when done.`,
		);
	}

	lines.push(
		"── [HARNESS: METHODOLOGY] ────────────────────────────────",
		"Workflow: Issue-Driven Development (13 phases + terminal close state)",
		"Decision checkpoints: understand → scope → plan → sync — bounded requests proceed internally; ask only if an unresolved material choice remains",
		"Anti-compact: write ALL findings/decisions to files or GitHub Issue immediately",
		"Iterative review: repeat read→fix until 2 consecutive clean passes",
		"══════════════════════════════════════════════════════════",
	);

	return { text: lines.join("\n") };
}

// ── Tool-agnostic command sanitizers (shared by Bash-guard adapters;
//    reusable by a future pi tool_call adapter). Exact ports of the
//    three quote-strip variants used across the .claude Bash guards.
//    Pure functions — no host coupling.

/** Blank quoted content: `'x'`→`''`, `"x"`→`""`
 *  (destructive-git-guard, git-push-guard). */
function stripQuotesBlank(command) {
	return String(command).replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
}

/** Collapse a quoted run, dropping the quote chars (email-send-guard). */
function stripQuotesCollapse(command) {
	return String(command).replace(/['"][^'"]*['"]/g, (m) =>
		m.replace(/'/g, "").replace(/"/g, ""),
	);
}

/** Unwrap quotes, keep inner text: `'x'`→`x`, `"x"`→`x` (deploy-guard). */
function stripQuotesUnwrap(command) {
	return String(command).replace(/'([^']*)'/g, "$1").replace(/"([^"]*)"/g, "$1");
}

module.exports = {
	ACTIVE_WINDOW_MS,
	HARNESS_OFF_VALUES,
	PHASE_LABELS,
	GATE_PHASES,
	atomicWriteJson,
	readProgress,
	compactReminderMessage,
	buildSessionInject,
	stripQuotesBlank,
	stripQuotesCollapse,
	stripQuotesUnwrap,
};
