#!/usr/bin/env node
/**
 * Protected Path Guard (PreToolUse on Edit|Write|NotebookEdit|MultiEdit) — Claude adapter.
 * Envelope: ./_claude-edit-hook.js. Policy: shared tool-agnostic
 * .agents/hooks/policies/protected-paths.js → editPath. List:
 * .agents/context/protected-paths.json (empty list blocks nothing).
 */
const path = require("path");
let H, P;
try {
	H = require("./_claude-edit-hook.js");
	P = require(path.join(__dirname, "..", "..", ".agents", "hooks", "policies", "protected-paths.js"));
} catch {
	process.stdout.write(JSON.stringify({ decision: "block", reason: "[Harness] Protected-path policy module is unavailable (fail-closed)." }));
	process.exit(0);
}

H.start((data) => P.editPath(data), {
	failClosed: true,
	failClosedReason: "[Harness] Protected-path policy could not be verified (fail-closed).",
});
