#!/usr/bin/env node
/**
 * Commit Guard Hook (PreToolUse on Bash) — Claude adapter.
 * Envelope: ./_claude-bash-guard.js. Policy: shared tool-agnostic
 * .agents/hooks/policies/bash.js → commit (also used by pi adapter).
 * Behavior byte-identical (G-OC01 part2, pure refactor).
 */
const path = require("path");
const fs = require("fs");
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const roleMode = fs.existsSync(path.join(projectDir, ".naia-role.json"));
let H, P;
try {
	H = require("./_claude-bash-guard.js");
	P = require(path.join(__dirname, "..", "..", ".agents", "hooks", "policies", "bash.js"));
} catch {
	if (roleMode) {
		process.stdout.write(JSON.stringify({ decision: "block", reason: "[Harness] Commit policy module is unavailable (fail-closed)." }));
	}
	process.exit(0); // original main().catch fail-open
}

H.start((command, data) => {
	// Shared policy owns phase and missing-progress decisions; roles only redirect its root.
	return P.commit(command, roleMode
		? { ...data, cwd: path.resolve(process.env.NAIA_ADK_ROOT || projectDir) }
		: data);
}, {
	failClosed: roleMode,
	failClosedReason: "[Harness] Commit evidence could not be verified (fail-closed).",
});
