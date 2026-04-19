#!/usr/bin/env node
/**
 * Session State Inject Hook (UserPromptSubmit)
 *
 * Reads the most recent .agents/progress/*.json file and injects
 * the active session state + methodology reminder into Claude's context
 * on every user message.
 *
 * Survives context compression: Claude always knows the current issue/phase.
 *
 * Progress file must be created/updated by Claude at each phase transition.
 * Schema: { issue, issue_url?, current_phase, gates_cleared[], current_task?, key_decisions[],
 *           review_log?: { phase, type, mode, total_passes, auto_fixes, escalations, result, timestamp } }
 */

const fs = require("fs");
const path = require("path");

const DESIGN_DOC_UNLOCK = path.resolve(__dirname, "..", "design-doc-unlock");

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

async function main() {
	// Try to read stdin (may be absent for UserPromptSubmit)
	let input = "";
	try {
		process.stdin.setEncoding("utf8");
		for await (const chunk of process.stdin) {
			input += chunk;
		}
	} catch {
		// stdin not available — continue with process.cwd()
	}

	let cwd = process.cwd();
	let sessionId = null;
	if (input) {
		try {
			const data = JSON.parse(input);
			if (data.cwd) cwd = data.cwd;
			if (data.session_id) sessionId = data.session_id;
		} catch {
			// ignore parse errors
		}
	}

	// Collect all progress directories: cwd + immediate submodule children
	const progressDirs = [];
	const rootProgressDir = path.join(cwd, ".agents", "progress");
	if (fs.existsSync(rootProgressDir)) progressDirs.push(rootProgressDir);
	try {
		const entries = fs.readdirSync(cwd, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			const subDir = path.join(cwd, entry.name, ".agents", "progress");
			if (fs.existsSync(subDir)) progressDirs.push(subDir);
		}
	} catch {
		// ignore readdir errors
	}
	if (progressDirs.length === 0) process.exit(0);

	// Session-to-issue mapping: allows multiple sessions to track different issues
	// Map file lives in root progress dir (or first available)
	const sessionMapDir = fs.existsSync(rootProgressDir) ? rootProgressDir : progressDirs[0];
	const sessionMapPath = path.join(sessionMapDir, ".session-map.json");
	let sessionMap = {};
	let sessionMapDirty = false;
	try {
		if (fs.existsSync(sessionMapPath)) {
			sessionMap = JSON.parse(fs.readFileSync(sessionMapPath, "utf8"));
			// Prune stale entries (file no longer exists)
			for (const [sid, filePath] of Object.entries(sessionMap)) {
				const resolved = path.isAbsolute(filePath)
					? filePath
					: path.join(sessionMapDir, filePath);
				if (!fs.existsSync(resolved)) {
					delete sessionMap[sid];
					sessionMapDirty = true;
				}
			}
		}
	} catch {
		// corrupt map — ignore, fall through to mtime-based selection
	}

	// Collect all progress files (for Priority 0 scan)
	const allProgressFiles = [];
	for (const dir of progressDirs) {
		try {
			const files = fs
				.readdirSync(dir)
				.filter((f) => f.endsWith(".json") && !f.startsWith("."));
			for (const file of files) {
				allProgressFiles.push(path.join(dir, file));
			}
		} catch {
			continue;
		}
	}

	let latestFile = null;

	// Priority 0: scan progress files for embedded session_id claim
	// This is authoritative — AI writes its session_id into the progress file it owns
	if (sessionId) {
		for (const filePath of allProgressFiles) {
			try {
				const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
				if (content.session_id === sessionId) {
					latestFile = filePath;
					break;
				}
			} catch {
				continue;
			}
		}
	}

	// Priority 1: session-map lookup (previously registered mapping)
	if (!latestFile && sessionId && sessionMap[sessionId]) {
		const claimed = sessionMap[sessionId];
		// claimed can be absolute path or relative filename — check both
		if (path.isAbsolute(claimed) && fs.existsSync(claimed)) {
			latestFile = claimed;
		} else {
			// Search across all progress dirs
			for (const dir of progressDirs) {
				const candidate = path.join(dir, claimed);
				if (fs.existsSync(candidate)) {
					latestFile = candidate;
					break;
				}
			}
		}
	}

	// Priority 2: fallback to most recently modified progress file across all dirs
	// After selection, register this session → file mapping to prevent future cross-session drift
	if (!latestFile) {
		let latestMtime = 0;
		for (const filePath of allProgressFiles) {
			try {
				const stat = fs.statSync(filePath);
				if (stat.mtimeMs > latestMtime) {
					latestMtime = stat.mtimeMs;
					latestFile = filePath;
				}
			} catch {
				continue;
			}
		}

		// Register the mtime-selected file in session-map so this session sticks to it
		if (latestFile && sessionId) {
			sessionMap[sessionId] = latestFile;
			sessionMapDirty = true;
		}
	}

	// Flush session-map if any changes were made (stale pruning or new registration)
	if (sessionMapDirty) {
		try {
			fs.writeFileSync(sessionMapPath, JSON.stringify(sessionMap, null, 2));
		} catch {
			// Best-effort — failure is non-fatal
		}
	}

	if (!latestFile) process.exit(0);

	let progress;
	try {
		progress = JSON.parse(fs.readFileSync(latestFile, "utf8"));
	} catch {
		process.exit(0);
	}

	const currentPhase = progress.current_phase || "unknown";
	const phaseLabel = PHASE_LABELS[currentPhase] || currentPhase;
	const gatesCleared =
		(progress.gates_cleared || []).join(", ") || "none yet";

	const lines = [
		"══ [HARNESS: SESSION STATE] ══════════════════════════════",
		`Issue : ${progress.issue || "unknown"}${progress.issue_url ? " — " + progress.issue_url : ""}`,
		`Phase : ${phaseLabel}`,
		`Gates : cleared=[${gatesCleared}]`,
		...(sessionId ? [`Session: ${sessionId}`] : []),
	];

	if (progress.current_task) {
		lines.push(`Task  : ${progress.current_task}`);
	}

	const decisions = progress.key_decisions || [];
	if (decisions.length > 0) {
		lines.push(`Decisions: ${decisions.join(" | ")}`);
	}

	// Warn about upcoming gates
	const phaseKeys = Object.keys(PHASE_LABELS);
	const currentIdx = phaseKeys.indexOf(currentPhase);
	const nextPhase = phaseKeys[currentIdx + 1];
	if (nextPhase && GATE_PHASES.has(nextPhase)) {
		lines.push(
			`⚠ Next gate: ${PHASE_LABELS[nextPhase]} — user confirmation required before proceeding`
		);
	}

	// Review loop enforcement: warn if phase requires review_log but none exists
	const REVIEW_REQUIRED_PHASES = new Set([
		"review",
		"post_test_review",
	]);
	const REVIEW_RECOMMENDED_PHASES = new Set([
		"e2e_test",    // should have review_log from build phase
		"sync",        // should have review_log from post_test_review
		"sync_verify", // should have review_log from post_test_review
		"commit",      // final check — all reviews should be done
	]);

	const reviewLog = progress.review_log;
	// Check if review_log is stale (from a different/earlier phase)
	const isReviewLogCurrent = reviewLog && (
		!reviewLog.phase ||  // legacy format without phase — accept
		reviewLog.phase === currentPhase ||
		// Accept review_log from the immediately preceding review-type phase
		(currentPhase === "e2e_test" && reviewLog.phase === "review") ||
		(currentPhase === "sync" && reviewLog.phase === "post_test_review") ||
		(currentPhase === "sync_verify" && reviewLog.phase === "post_test_review") ||
		(currentPhase === "commit" && (reviewLog.phase === "post_test_review" || reviewLog.phase === "review")) ||
		(currentPhase === "report" && (reviewLog.phase === "post_test_review" || reviewLog.phase === "review"))
	);
	const effectiveReviewLog = isReviewLogCurrent ? reviewLog : null;

	if (REVIEW_REQUIRED_PHASES.has(currentPhase) && !effectiveReviewLog) {
		lines.push(
			`⛔ [HARNESS] Phase "${phaseLabel}" REQUIRES /review-pass completion. No review_log found in progress file. Run /review-pass before proceeding.`
		);
	} else if (REVIEW_RECOMMENDED_PHASES.has(currentPhase) && !effectiveReviewLog) {
		lines.push(
			`⚠ [HARNESS] No review_log in progress file. Verify that /review-pass was completed in a prior phase before proceeding.`
		);
	} else if (effectiveReviewLog && effectiveReviewLog.result !== "2_consecutive_clean") {
		lines.push(
			`⚠ [HARNESS] Last review did not achieve 2 consecutive clean passes (result: ${effectiveReviewLog.result}). Consider re-running /review-pass.`
		);
	}

	// E2E test phase enforcement: remind what E2E actually means
	if (currentPhase === "e2e_test") {
		lines.push(
			"⛔ [HARNESS] E2E = 실제 사용자 시나리오 재현. 함수 호출/기능 흐름 통과는 통합테스트일 뿐. 반드시 실제 앱(Tauri/웹서버)을 실행하고, 해당 기능이 닿는 사용자 여정 전체를 훑을 것."
		);
	}

	// Warn if design-doc-unlock file is active
	if (fs.existsSync(DESIGN_DOC_UNLOCK)) {
		lines.push(
			"⚠ [HARNESS] design-doc-unlock ACTIVE — design documents are currently editable. Remove .claude/design-doc-unlock when done."
		);
	}

	lines.push(
		"── [HARNESS: METHODOLOGY] ────────────────────────────────",
		"Workflow: Issue-Driven Development (13 phases)",
		"Gates (user confirmation required): understand → scope → plan → sync",
		"Anti-compact: write ALL findings/decisions to files or GitHub Issue immediately",
		"Iterative review: repeat read→fix until 2 consecutive clean passes",
		"══════════════════════════════════════════════════════════"
	);

	const additionalContext = lines.join("\n");

	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				additionalContext,
			},
		})
	);

	process.exit(0);
}

main().catch(() => process.exit(0));
