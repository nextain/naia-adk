/**
 * beh-second-stream — BEH §3.5 advisory 2nd-stream plumbing (tool-agnostic SoT).
 *
 * Plan: .agents/progress/behavior-enforcement-harness-plan-2026-06-11.md (§3.5, §6.6).
 *
 * A probabilistic 2nd-LLM that reads ONLY the structured ledger events (never
 * source code / model internals) and produces an ADVISORY note. It NEVER gates
 * — deterministic enforcement (§3.1–§3.4) is unaffected by its output, death,
 * or absence (hierarchy: deterministic > modality > 2nd-LLM, plan §1·2). Per
 * the plan, only the PLUMBING is unit-tested (not an actual LLM): the structured
 * summary it would send, and that a missing/throwing LLM is a clean no-op.
 *
 * Pure: the LLM call is an injected boundary (llmFn). Default = none.
 */

/**
 * Reduce a raw ledger into a compact STRUCTURED summary — counts and shapes
 * only, NO source content. This is the sole input the 2nd-stream may see.
 */
function summarizeForAdvisory(ledger) {
	const events = Array.isArray(ledger) ? ledger : [];
	const byTool = {};
	const byItem = {};
	let milestones = 0;
	let toolLess = 0;
	let lastTurn = -1;
	for (const e of events) {
		if (e.tool) byTool[e.tool] = (byTool[e.tool] || 0) + 1;
		const item = e.scope_item || "(none)";
		byItem[item] = byItem[item] || { tools: 0, milestones: 0 };
		byItem[item].tools += 1;
		if (e.matched_milestone) {
			milestones += 1;
			byItem[item].milestones += 1;
		}
		if (e.tool_less) toolLess += 1;
		if ((e.turn ?? -1) > lastTurn) lastTurn = e.turn ?? -1;
	}
	return {
		total_events: events.length,
		last_turn: lastTurn,
		tool_counts: byTool,
		per_item: byItem,
		milestones_hit: milestones,
		tool_less_events: toolLess,
	};
}

/**
 * Run the advisory pass. ADVISORY ONLY — the return value carries no gate,
 * decision, or block. llmFn(summary) → string|null (injected; default none).
 * Any llmFn error/absence yields {advisory:null} (clean no-op).
 * @returns {{advisory:(string|null), summary:object, gated:false}}
 */
function runAdvisory(ledger, llmFn) {
	const summary = summarizeForAdvisory(ledger);
	let advisory = null;
	if (typeof llmFn === "function") {
		try {
			const r = llmFn(summary);
			advisory = typeof r === "string" && r.trim() ? r.trim() : null;
		} catch {
			advisory = null; //  2nd-stream failure must never affect anything
		}
	}
	return { advisory, summary, gated: false };
}

module.exports = { summarizeForAdvisory, runAdvisory };
