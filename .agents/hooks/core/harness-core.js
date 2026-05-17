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
 * @returns {{text:string}|null}  null = suppress (opt-out / no progress).
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
	if (progressDirs.length === 0) return null;

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
			`  • env: ${optOutEnvVar}=off`,
			`  • file: <cwd>/${hostConfigDir}/no-harness (touch)`,
			"위 둘 중 하나가 있으면 hook은 매 턴 조용히 종료합니다.",
			"══════════════════════════════════════════════════════════",
		);
		return { text: lines.join("\n") };
	}

	const progress = readProgress(latestFile);
	if (!progress) return null;

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
			`⚠ [HARNESS] design-doc-unlock ACTIVE — design documents are currently editable. Remove ${hostConfigDir}/design-doc-unlock when done.`,
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
