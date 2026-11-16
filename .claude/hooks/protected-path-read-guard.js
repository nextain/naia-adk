#!/usr/bin/env node
/**
 * Protected Path Read Guard (PreToolUse on Read|Grep|Glob|NotebookRead) — Claude adapter.
 * Policy: shared tool-agnostic .agents/hooks/policies/protected-paths.js → readPath.
 * List: .agents/context/protected-paths.json (empty list blocks nothing).
 * Own stdin envelope: the Edit envelope (_claude-edit-hook.js) ignores read tools.
 */
const path = require("path");
const BLOCK_UNVERIFIED = "[Harness] Protected-path policy could not be verified (fail-closed).";
const emit = (reason) => process.stdout.write(JSON.stringify({ decision: "block", reason }));

let P;
try {
	P = require(path.join(__dirname, "..", "..", ".agents", "hooks", "policies", "protected-paths.js"));
} catch {
	emit("[Harness] Protected-path policy module is unavailable (fail-closed).");
	process.exit(0);
}

(async () => {
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	let data;
	try {
		data = JSON.parse(input);
	} catch {
		emit(BLOCK_UNVERIFIED);
		return;
	}
	const decision = P.readPath(data);
	if (decision && decision.block !== undefined) emit(decision.block);
})().catch(() => { emit(BLOCK_UNVERIFIED); }).finally(() => process.exit(0));
