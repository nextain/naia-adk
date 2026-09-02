#!/usr/bin/env node
/**
 * Session baseline adapter (Claude Code) — PostCompact.
 *
 * Compaction replaced the transcript with a lossy recap. Bump the session's
 * baseline epoch so the mutation gate refuses governed work until the session
 * re-reads its contract baseline via the ack command, and inject a short,
 * imperative pointer (recent + specific beats a wall of advisory text).
 *
 * Fail-safe: any error exits 0 silently — the gate itself remains the
 * enforcement; this adapter only arms it earlier and explains the door.
 */

const path = require("path");

let core = null;
let sessionBaseline = null;
try {
	core = require(path.join(__dirname, "..", "..", ".agents", "hooks", "core", "session-contract.js"));
	sessionBaseline = require(path.join(__dirname, "..", "..", ".agents", "harness", "session-baseline.cjs"));
} catch {
	process.exit(0);
}

async function main() {
	let input = "";
	try {
		process.stdin.setEncoding("utf8");
		for await (const chunk of process.stdin) input += chunk;
	} catch { /* continue with cwd */ }

	let cwd = process.cwd();
	let sessionId = null;
	if (input) {
		try {
			const data = JSON.parse(input);
			if (data.cwd) cwd = data.cwd;
			if (data.session_id) sessionId = data.session_id;
		} catch { /* ignore */ }
	}
	if (!sessionId) process.exit(0);

	let root = null;
	try { root = core.findProjectRoot(cwd); } catch { root = null; }
	if (!root) process.exit(0);

	// Only arm the gate for sessions whose bound contract declares a baseline.
	let ackCommand = null;
	try {
		const resolution = core.resolveSessionContract({ cwd: root, sessionId });
		if (resolution.status !== core.STATES.BOUND) process.exit(0);
		const baseline = resolution.contract.baseline;
		if (!baseline || !Array.isArray(baseline.required_reads) || baseline.required_reads.length === 0) process.exit(0);
		sessionBaseline.bumpEpoch(root, sessionId, "post_compact");
		ackCommand = sessionBaseline.ackCommandFor(sessionId);
	} catch {
		process.exit(0);
	}

	const eventName = process.argv[2] || "PostCompact";
	process.stdout.write(JSON.stringify({
		hookSpecificOutput: {
			hookEventName: eventName,
			additionalContext: [
				"⛔ [HARNESS: BASELINE] 컨텍스트가 compaction 으로 재작성되었습니다.",
				"요약본은 기준이 아닙니다. 변경 작업은 baseline 재확인 전까지 게이트가 차단합니다.",
				"지금 정확히 실행: " + ackCommand,
				"(명령이 계약의 의도·흐름·필수 읽기 파일 전문을 출력하고 잠금을 풉니다. 읽기 전용 조사는 허용됩니다.)",
			].join("\n"),
		},
	}));
	process.exit(0);
}

main().catch(() => process.exit(0));
