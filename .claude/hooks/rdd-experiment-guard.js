#!/usr/bin/env node
/**
 * RDD Experiment Guard Hook (PreToolUse on Bash) — Claude adapter.
 * Envelope: ./_claude-bash-guard.js. Policy: shared tool-agnostic
 * .agents/hooks/policies/experiment.js → experiment (also usable by pi adapter).
 *
 * fail-CLOSED inside an RDD project (.agents/research/ present): blocks running
 * exp*.py unless a pre-registered, freshly-audited hypothesis entry exists.
 * fail-OPEN in non-RDD projects and on any internal error.
 */
const path = require("path");
let H, P;
try {
	H = require("./_claude-bash-guard.js");
	P = require(path.join(__dirname, "..", "..", ".agents", "hooks", "policies", "experiment.js"));
} catch {
	process.stdout.write(JSON.stringify({ decision: "block", reason: "[Harness] Experiment policy module is unavailable (fail-closed)." }));
	process.exit(0);
}

H.start((command, data) => P.experiment(command, data), {
	failClosed: true,
	failClosedReason: "[Harness] Experiment policy could not be verified (fail-closed).",
});
