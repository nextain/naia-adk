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
	process.exit(0);
}

H.start((command, data) => P.uncommittedArtifact(command, data));
