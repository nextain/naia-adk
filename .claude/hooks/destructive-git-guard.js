#!/usr/bin/env node
/**
 * Destructive Git Guard Hook (PreToolUse on Bash) — Claude adapter.
 * Envelope: ./_claude-bash-guard.js. Policy: tool-agnostic shared module
 * .agents/hooks/policies/bash.js → destructiveGit (also used by the pi
 * adapter). Behavior byte-identical (G-OC01 part2, pure refactor).
 */
const path = require("path");
let H, P;
try {
	H = require("./_claude-bash-guard.js");
	P = require(path.join(__dirname, "..", "..", ".agents", "hooks", "policies", "bash.js"));
} catch {
	process.stdout.write(JSON.stringify({ decision: "block", reason: "[Harness] Destructive git policy module is unavailable (fail-closed)." }));
	process.exit(0);
}

H.start((command) => P.destructiveGit(command), {
	failClosed: true,
	failClosedReason: "[Harness] Destructive git policy could not be verified (fail-closed).",
});
