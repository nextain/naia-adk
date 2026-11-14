#!/usr/bin/env node
/**
 * Git Push Guard — PreToolUse on Bash — Claude adapter.
 * Envelope: ./_claude-bash-guard.js. Policy: shared tool-agnostic
 * .agents/hooks/policies/bash.js → gitPush (stateless routine non-force,
 * non-deleting push allowance with force and remote-ref-delete blocking).
 */
const path = require("path");
let H, P;
try {
	H = require("./_claude-bash-guard.js");
	P = require(path.join(__dirname, "..", "..", ".agents", "hooks", "policies", "bash.js"));
} catch {
	process.stdout.write(JSON.stringify({ decision: "block", reason: "[Harness] Git push policy module is unavailable (fail-closed)." }));
	process.exit(0);
}

H.start((command) => P.gitPush(command), {
	failClosed: true,
	failClosedReason: "[Harness] Git push policy could not be verified (fail-closed).",
});
