#!/usr/bin/env node
/**
 * OSS Communications Guard (PreToolUse on Bash) — Claude adapter (fail-closed).
 * Envelope: ./_claude-bash-guard.js. Policy: shared tool-agnostic
 * .agents/hooks/policies/bash.js → prGuard (also used by pi adapter).
 * Behavior byte-identical (G-OC01 part2, pure refactor).
 */
const path = require("path");
// Kept literal so a require failure still fails CLOSED (byte-identical to
// the original main().catch). policies/bash.js exports the same string.
const PR_FAIL_REASON =
	"[Guard] pr-guard 내부 오류 — 안전을 위해 GitHub 쓰기 차단.\n" +
	"명령을 직접 실행하거나 Luke에게 확인 요청하세요.";

let H, P;
try {
	H = require("./_claude-bash-guard.js");
	P = require(path.join(__dirname, "..", "..", ".agents", "hooks", "policies", "bash.js"));
} catch {
	process.stdout.write(JSON.stringify({ decision: "block", reason: PR_FAIL_REASON }));
	process.exit(0);
}

H.start((command, data) => P.prGuard(command, data), {
	failClosed: true,
	failClosedReason: PR_FAIL_REASON,
});
