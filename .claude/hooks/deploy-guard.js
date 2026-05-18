#!/usr/bin/env node
/**
 * Deploy Guard Hook (PreToolUse on Bash) — Claude adapter.
 * Envelope: ./_claude-bash-guard.js. Policy: shared tool-agnostic
 * .agents/hooks/policies/bash.js → deploy (also used by pi adapter).
 * DEPLOY_DIR is __dirname-dependent → this adapter resolves it and
 * passes via opts (byte-identical to original). (G-OC01 part2.)
 */
const path = require("path");
let H, P;
try {
	H = require("./_claude-bash-guard.js");
	P = require(path.join(__dirname, "..", "..", ".agents", "hooks", "policies", "bash.js"));
} catch {
	process.exit(0); // original main().catch fail-open
}

// __dirname = .claude/hooks → .claude/deploy (identical to original DEPLOY_DIR)
const deployDir = path.resolve(__dirname, "..", "deploy");

H.start((command, data) => P.deploy(command, data, { deployDir }));
