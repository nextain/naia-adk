#!/usr/bin/env node
/**
 * Protected Path Command Guard (PreToolUse on Bash) — Claude adapter.
 * Envelope: ./_claude-bash-guard.js. Policy: shared tool-agnostic
 * .agents/hooks/policies/protected-paths.js → commandPath. List:
 * .agents/context/protected-paths.json (empty list blocks nothing).
 */
const path = require("path");
let H, P;
try {
	H = require("./_claude-bash-guard.js");
	P = require(path.join(__dirname, "..", "..", ".agents", "hooks", "policies", "protected-paths.js"));
} catch {
	process.stdout.write(JSON.stringify({ decision: "block", reason: "[Harness] Protected-path policy module is unavailable (fail-closed)." }));
	process.exit(0);
}

H.start((command, data) => P.commandPath(command, { cwd: data && data.cwd }), {
	failClosed: true,
	failClosedReason: "[Harness] Protected-path policy could not be verified (fail-closed).",
});
