#!/usr/bin/env node
/**
 * Session State Inject Hook (UserPromptSubmit)
 *
 * Reads the active session's progress file and injects HARNESS state into
 * Claude's context on every user message. Survives context compression.
 *
 * Resolution order (most authoritative first):
 *   P0  progress file with embedded session_id matching the current session
 *   P1  .session-map.json entry for the current session
 *   (no auto-bind: if neither matches, emit a SELECTION PROMPT — never guess)
 *
 * "Active candidate" = mtime within ACTIVE_WINDOW_MS AND current_phase !== "close".
 * Listed in the selection prompt so user can pick one.
 *
 * Opt-out (silent exit, no HARNESS inject):
 *   - env: CLAUDE_HARNESS in {off, 0, false, no}
 *   - file: <cwd>/.claude/no-harness (any content; presence = opt-out)
 *
 * Progress file schema: { issue, issue_url?, current_phase, gates_cleared[],
 *   current_task?, key_decisions[], session_id?,
 *   review_log?: { phase, type, mode, total_passes, auto_fixes, escalations,
 *                  result, timestamp } }
 */

const fs = require("fs");
const path = require("path");

const DESIGN_DOC_UNLOCK = path.resolve(__dirname, "..", "design-doc-unlock");
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

async function main() {
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

	// Opt-out: env var or marker file
	const envFlag = (process.env.CLAUDE_HARNESS || "").trim().toLowerCase();
	if (HARNESS_OFF_VALUES.has(envFlag)) process.exit(0);
	if (fs.existsSync(path.join(cwd, ".claude", "no-harness"))) process.exit(0);

	// Collect progress directories: cwd + immediate submodule children
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

	const sessionMapDir = fs.existsSync(rootProgressDir) ? rootProgressDir : progressDirs[0];
	const sessionMapPath = path.join(sessionMapDir, ".session-map.json");
	let sessionMap = {};
	let sessionMapDirty = false;
	try {
		if (fs.existsSync(sessionMapPath)) {
			sessionMap = JSON.parse(fs.readFileSync(sessionMapPath, "utf8"));
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
		// corrupt map — treat as empty
		sessionMap = {};
	}

	// Collect all progress files
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
	let bindReason = null; // "p0" | "p1"

	// P0: progress file with embedded session_id
	if (sessionId) {
		for (const filePath of allProgressFiles) {
			const content = readProgress(filePath);
			if (content && content.session_id === sessionId) {
				latestFile = filePath;
				bindReason = "p0";
				break;
			}
		}
	}

	// P1: session-map lookup
	if (!latestFile && sessionId && sessionMap[sessionId]) {
		const claimed = sessionMap[sessionId];
		if (path.isAbsolute(claimed) && fs.existsSync(claimed)) {
			latestFile = claimed;
			bindReason = "p1";
		} else {
			for (const dir of progressDirs) {
				const candidate = path.join(dir, claimed);
				if (fs.existsSync(candidate)) {
					latestFile = candidate;
					bindReason = "p1";
					break;
				}
			}
		}
	}

	// Build candidate list for selection prompt (no auto-bind)
	const now = Date.now();
	const activeCandidates = []; // { filePath, mtime, progress }
	if (!latestFile) {
		for (const filePath of allProgressFiles) {
			let stat;
			try {
				stat = fs.statSync(filePath);
			} catch {
				continue;
			}
			if (now - stat.mtimeMs > ACTIVE_WINDOW_MS) continue;
			const progress = readProgress(filePath);
			if (!progress) continue;
			if (progress.current_phase === "close") continue;
			activeCandidates.push({ filePath, mtime: stat.mtimeMs, progress });
		}
		activeCandidates.sort((a, b) => b.mtime - a.mtime);
	}

	if (sessionMapDirty) {
		try {
			atomicWriteJson(sessionMapPath, sessionMap);
		} catch {
			// best-effort
		}
	}

	// No bind — emit a selection prompt
	if (!latestFile) {
		const lines = [
			"══ [HARNESS: SESSION UNBOUND] ════════════════════════════",
			"이 세션은 작업(progress 파일)에 바인딩되지 않았습니다.",
			"AI는 사용자가 명시적으로 작업을 지정하기 전까지",
			"어떤 진행 중 이슈로도 컨텍스트를 가정하지 마세요.",
			"",
		];
		if (activeCandidates.length > 0) {
			lines.push("활성 후보 (mtime 24h 이내, phase != close):");
			for (const c of activeCandidates.slice(0, 10)) {
				const rel = path.relative(cwd, c.filePath);
				const issue = c.progress.issue || "(no issue)";
				const phase = c.progress.current_phase || "(no phase)";
				const task = c.progress.current_task ? ` — ${c.progress.current_task}` : "";
				lines.push(`  • ${issue} [${phase}] ${rel}${task}`);
			}
			if (activeCandidates.length > 10) {
				lines.push(`  • ... (+${activeCandidates.length - 10}개 더)`);
			}
			lines.push("");
		} else {
			lines.push("활성 후보 없음 (24h 이내 갱신된 비-close progress 파일이 없습니다).", "");
		}
		lines.push(
			"바인딩 방법: 사용자가 작업을 지정하면 AI는 즉시 해당 progress 파일에",
			`"session_id": "${sessionId || "<현재 세션 ID>"}" 필드를 기록하세요. 다음 턴부터 P0로 안정 바인딩됩니다.`,
			"",
			"이 세션이 IDD 워크플로우 외 자유 작업이라면 HARNESS를 끌 수 있습니다:",
			"  • env: CLAUDE_HARNESS=off",
			"  • file: <cwd>/.claude/no-harness (touch)",
			"위 둘 중 하나가 있으면 hook은 매 턴 조용히 종료합니다.",
			"══════════════════════════════════════════════════════════",
		);
		process.stdout.write(
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "UserPromptSubmit",
					additionalContext: lines.join("\n"),
				},
			}),
		);
		process.exit(0);
	}

	const progress = readProgress(latestFile);
	if (!progress) process.exit(0);

	const currentPhase = progress.current_phase || "unknown";
	const phaseLabel = PHASE_LABELS[currentPhase] || currentPhase;
	const gatesCleared = (progress.gates_cleared || []).join(", ") || "none yet";

	const lines = [
		"══ [HARNESS: SESSION STATE] ══════════════════════════════",
		`Issue : ${progress.issue || "unknown"}${progress.issue_url ? " — " + progress.issue_url : ""}`,
		`Phase : ${phaseLabel}`,
		`Gates : cleared=[${gatesCleared}]`,
		...(sessionId ? [`Session: ${sessionId} (bind: ${bindReason})`] : []),
	];

	if (progress.current_task) {
		lines.push(`Task  : ${progress.current_task}`);
	}

	const decisions = progress.key_decisions || [];
	if (decisions.length > 0) {
		lines.push(`Decisions: ${decisions.join(" | ")}`);
	}

	// If bound via P1/P2 but file lacks session_id, nudge AI to anchor it
	if (sessionId && bindReason !== "p0" && progress.session_id !== sessionId) {
		lines.push(
			`⚠ [HARNESS] progress 파일에 session_id가 비어있거나 불일치합니다. ` +
				`다음 편집 시 "session_id": "${sessionId}" 필드를 ${path.basename(latestFile)} 에 기록하세요 ` +
				`(P0 anchor → session-map 손상에도 견고).`,
		);
	}

	const phaseKeys = Object.keys(PHASE_LABELS);
	const currentIdx = phaseKeys.indexOf(currentPhase);
	const nextPhase = phaseKeys[currentIdx + 1];
	if (nextPhase && GATE_PHASES.has(nextPhase)) {
		lines.push(
			`⚠ Next gate: ${PHASE_LABELS[nextPhase]} — user confirmation required before proceeding`,
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
			"⚠ [HARNESS] design-doc-unlock ACTIVE — design documents are currently editable. Remove .claude/design-doc-unlock when done.",
		);
	}

	lines.push(
		"── [HARNESS: METHODOLOGY] ────────────────────────────────",
		"Workflow: Issue-Driven Development (13 phases)",
		"Gates (user confirmation required): understand → scope → plan → sync",
		"Anti-compact: write ALL findings/decisions to files or GitHub Issue immediately",
		"Iterative review: repeat read→fix until 2 consecutive clean passes",
		"══════════════════════════════════════════════════════════",
	);

	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				additionalContext: lines.join("\n"),
			},
		}),
	);

	process.exit(0);
}

main().catch(() => process.exit(0));
