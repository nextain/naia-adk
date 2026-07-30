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
	process.exit(0); // original main().catch fail-open
}

H.start((command) => P.gitPush(command));
