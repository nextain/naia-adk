#!/usr/bin/env node
/**
 * Catastrophic Delete Guard Hook (PreToolUse on Bash) — Claude adapter.
 * Envelope: ./_claude-bash-guard.js. Policy: tool-agnostic shared module
 * .agents/hooks/policies/bash.js → catastrophicDelete.
 */
const path = require("path");
let H, P;
try {
	H = require("./_claude-bash-guard.js");
	P = require(path.join(__dirname, "..", "..", ".agents", "hooks", "policies", "bash.js"));
} catch {
	process.stdout.write(JSON.stringify({ decision: "block", reason: "[Harness] Catastrophic delete policy module is unavailable (fail-closed)." }));
	process.exit(0);
}

H.start((command) => P.catastrophicDelete(command), {
	failClosed: true,
	failClosedReason: "[Harness] Catastrophic delete policy could not be verified (fail-closed).",
});
