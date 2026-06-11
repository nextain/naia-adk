#!/usr/bin/env node
/**
 * BEH ledger record (PostToolUse) — Claude Code adapter (plan §3.1, §6.1).
 *
 * THIN ADAPTER. Logic lives in .agents/hooks/core/beh-ledger.js. This file:
 *   read PostToolUse stdin → (if BEH enabled) append ONE ledger entry
 *   for the tool outcome, attributing it to the single RUNNING scope item
 *   and matching it against that item's pre-declared milestones.
 *
 * Never blocks (PostToolUse). Fail-safe: any error → silent exit 0. BEH is
 * opt-in per session (`.claude/beh-on`); inert otherwise.
 */
const path = require("path");
let beh;
try {
	beh = require(path.join(__dirname, "..", "..", ".agents", "hooks", "core", "beh-ledger.js"));
} catch {
	process.exit(0);
}

async function main() {
	let input = "";
	try {
		process.stdin.setEncoding("utf8");
		for await (const c of process.stdin) input += c;
	} catch {
		/* no stdin */
	}
	let data = {};
	try {
		data = JSON.parse(input || "{}");
	} catch {
		process.exit(0);
	}
	const cwd = data.cwd || process.cwd();
	const sessionId = data.session_id || null;
	if (!beh.behEnabled(cwd, process.env)) process.exit(0);

	const { ledger, state } = beh.behPaths(cwd, sessionId);
	const st = beh.loadState(state);
	const bound = beh.findBoundProgress(cwd, sessionId);
	const items = (bound && bound.progress.scope_items) || [];
	const running = items.filter((it) => it.state === beh.RUNNING);

	const tool = data.tool_name;
	const target = beh.canonTarget(tool, data.tool_input || {}, { cwd });
	// best-effort outcome from tool_response
	const tr = data.tool_response;
	let outcome = "ok";
	if (tr && typeof tr === "object" && (tr.is_error || tr.error)) outcome = "error";

	// attribute to the single running item; ambiguous (0 or >1) → no credit.
	const scopeItem = running.length === 1 ? running[0] : null;
	let matched = null;
	if (scopeItem) {
		matched = beh.matchMilestone(scopeItem, { tool, target_canon: target, outcome });
	}

	try {
		beh.appendLedger(ledger, {
			turn: st.turn,
			ts: Date.now(),
			tool,
			target_canon: target,
			outcome,
			tool_less: false,
			scope_item: scopeItem ? scopeItem.id : null,
			matched_milestone: matched,
		});
	} catch {
		/* best-effort */
	}
	process.exit(0);
}
main().catch(() => process.exit(0));
