#!/usr/bin/env node
/**
 * Git Push Guard — PreToolUse on Bash — Claude adapter.
 * Envelope: ./_claude-bash-guard.js. Policy: shared tool-agnostic
 * .agents/hooks/policies/bash.js → gitPush (MARKER_PATH is cwd-relative,
 * move-safe). Behavior byte-identical (G-OC01 part2, pure refactor).
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
