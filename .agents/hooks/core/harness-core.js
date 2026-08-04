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
const path = require("path");
const { STATES, resolveSessionContract } = require("./session-contract.js");

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
	close: "14. Close ⛩ GATE",
};

const GATE_PHASES = new Set(["understand", "scope", "plan", "sync"]);

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
	if (fs.existsSync(path.join(cwd, hostConfigDir, "no-harness"))) return null;

	const resolution = resolveSessionContract({ cwd, sessionId });
	// Unbound and invalid bindings are deliberately silent in prompt injection.
	// The mutation gate uses the same result and reports the actionable reason.
	if (resolution.status !== STATES.BOUND) return null;
	const progress = resolution.progress;
	const contract = resolution.contract;

	const currentPhase = progress.current_phase || "unknown";
	const phaseLabel = PHASE_LABELS[currentPhase] || currentPhase;
	const gatesCleared = (progress.gates_cleared || []).join(", ") || "none yet";

	const lines = [
		"══ [HARNESS: SESSION STATE] ══════════════════════════════",
		`Issue : ${progress.issue || "unknown"}${progress.issue_url ? " — " + progress.issue_url : ""}`,
		`Phase : ${phaseLabel}`,
		`Gates : cleared=[${gatesCleared}]`,
		`Contract: ${contract.id} (${contract.contract_digest.slice(0, 12)})`,
		...(sessionId ? [`Session: ${sessionId} (bind: explicit)`] : []),
	];

	if (progress.current_task) {
		lines.push(`Task  : ${progress.current_task}`);
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
		"Workflow: Issue-Driven Development (13 phases)",
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
