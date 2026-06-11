#!/usr/bin/env node
/**
 * BEH PreToolUse gate (§3.4, §6.4) — Claude Code adapter.
 *
 * Two deterministic checks (logic in .agents/hooks/core/beh-launch-core.js):
 *   1. session-start handshake (fail-CLOSED): a BEH session must have been
 *      established by the external launcher (beh-launch.sh) with the CURRENT
 *      hook registration. Missing / stale / drifted handshake → block every
 *      tool with a recovery command. (Catches post-launch drift + sessions not
 *      launched via the launcher; the launcher itself is the external root.)
 *   2. unsupervised background → block: a Bash command that backgrounds/detaches
 *      a process (or run_in_background) must go through beh-supervise.js so it
 *      gets a wall+stall deadline (§3.3).
 *
 * Always-allowed: the launcher command itself (to establish the handshake) and
 * the supervise wrapper. Admin one-time escape: `.claude/beh-launch-bypass`.
 * Opt-in (`.claude/beh-on`); fail-safe exit 0 (never error the session).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
let beh, lc;
try {
	beh = require(path.join(__dirname, "..", "..", ".agents", "hooks", "core", "beh-ledger.js"));
	lc = require(path.join(__dirname, "..", "..", ".agents", "hooks", "core", "beh-launch-core.js"));
} catch {
	process.exit(0);
}

const HANDSHAKE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

function block(reason) {
	process.stdout.write(JSON.stringify({ decision: "block", reason }));
	process.exit(0);
}

async function main() {
	let input = "";
	try {
		process.stdin.setEncoding("utf8");
		for await (const c of process.stdin) input += c;
	} catch {
		/* no stdin */
	}
	let data = {};
	try {
		data = JSON.parse(input || "{}");
	} catch {
		process.exit(0);
	}
	const cwd = data.cwd || process.cwd();
	if (!beh.behEnabled(cwd, process.env)) process.exit(0);

	const tool = data.tool_name;
	const ti = data.tool_input || {};
	const cmd = tool === "Bash" ? String(ti.command || "") : "";

	// launcher always allowed (must be able to run to establish handshake).
	if (lc.isLauncher(cmd)) process.exit(0);

	// admin one-time bypass.
	const bypass = path.join(cwd, ".claude", "beh-launch-bypass");
	if (fs.existsSync(bypass)) {
		try {
			fs.unlinkSync(bypass);
		} catch {
			/* best-effort */
		}
		process.exit(0);
	}

	// 1. handshake fail-closed.
	let handshake = null;
	try {
		handshake = JSON.parse(fs.readFileSync(path.join(cwd, ".claude", "beh-handshake"), "utf8"));
	} catch {
		/* none */
	}
	let currentHash = null;
	try {
		currentHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(cwd, ".claude", "settings.json"))).digest("hex");
	} catch {
		/* no settings */
	}
	const hs = lc.evaluateHandshake({ handshake, currentHash, now: Date.now(), maxAgeMs: HANDSHAKE_MAX_AGE_MS });
	if (!hs.ok) {
		block(
			`[BEH] session-start fail-CLOSED: ${hs.reason} (plan §3.4).\n` +
				`이 세션은 외부 launcher 검증을 거치지 않았거나 훅 등록이 드리프트했습니다.\n` +
				`복구: bash .claude/hooks/beh-launch.sh "${cwd}"  (필수 훅 등록·코어 로드 self-probe 후 handshake 기록)\n` +
				`관리자 일시 우회: touch .claude/beh-launch-bypass (1회 소비).`,
		);
	}

	// 2. unsupervised background → block.
	if (tool === "Bash" && (lc.isBackgrounded(cmd) || ti.run_in_background === true) && !lc.isSuperviseWrapper(cmd)) {
		block(
			"[BEH] 미감독 백그라운드 실행 차단 (plan §3.3/§3.4).\n" +
				"백그라운드/장기 작업은 wall+stall 데드라인 감시를 받도록 supervise 래퍼를 경유해야 합니다:\n" +
				"  node .claude/hooks/beh-supervise.js --probe-type <file_lines|file_bytes|file_mtime|path_count|log_match_count> \\\n" +
				"    --probe-arg <경로> --max-wall <초> --max-stall <초> -- <명령>\n" +
				"짧은 포그라운드 명령이면 & / run_in_background 없이 그대로 실행하세요.",
		);
	}
	process.exit(0); //  allow
}
main().catch(() => process.exit(0));
