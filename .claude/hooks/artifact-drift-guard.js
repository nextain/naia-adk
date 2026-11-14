#!/usr/bin/env node
/**
 * Artifact Drift Guard Hook (PreToolUse on Bash) — Claude adapter.
 * Envelope: ./_claude-bash-guard.js. Policy: tool-agnostic shared module
 * .agents/hooks/policies/bash.js → uncommittedArtifact.
 */
const path = require("path");
let H, P;
try {
	H = require("./_claude-bash-guard.js");
	P = require(path.join(__dirname, "..", "..", ".agents", "hooks", "policies", "bash.js"));
} catch {
	process.stdout.write(JSON.stringify({ decision: "block", reason: "[Harness] Artifact drift policy module is unavailable (fail-closed)." }));
	process.exit(0);
}

H.start((command, data) => P.uncommittedArtifact(command, data), {
	failClosed: true,
	failClosedReason: "[Harness] Artifact drift policy could not be verified (fail-closed).",
});
