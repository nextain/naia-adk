#!/usr/bin/env node
/**
 * BEH session-start notice (SessionStart) — Claude Code adapter (§3.4, §6.4).
 *
 * Advisory only: SessionStart cannot block, so this just surfaces a handshake
 * problem proactively at session start. The actual fail-CLOSED enforcement is
 * beh-pretool.js (PreToolUse). Opt-in (`.claude/beh-on`); fail-safe exit 0.
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
		/* defaults */
	}
	const cwd = data.cwd || process.cwd();
	if (!beh.behEnabled(cwd, process.env)) process.exit(0);

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
		/* none */
	}
	const hs = lc.evaluateHandshake({ handshake, currentHash, now: Date.now(), maxAgeMs: 12 * 60 * 60 * 1000 });
	if (hs.ok) process.exit(0);

	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "SessionStart",
				additionalContext:
					`⚠ [BEH] session-start handshake 무효: ${hs.reason}. 도구 실행이 fail-CLOSED 차단됩니다.\n` +
					`복구: bash .claude/hooks/beh-launch.sh "${cwd}"`,
			},
		}),
	);
	process.exit(0);
}
main().catch(() => process.exit(0));
