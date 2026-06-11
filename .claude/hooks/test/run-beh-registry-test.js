#!/usr/bin/env node
/**
 * BEH §3.6 registry + §3.5 second-stream — test (plan §4, §6.5, §6.6).
 *
 * Validates the REAL registry schema, cross-checks it against the REAL
 * settings.json (registration-drift guard), and unit-tests the advisory
 * 2nd-stream plumbing (structured-summary only; missing/throwing LLM = no-op;
 * never gates).
 *
 * Usage: node run-beh-registry-test.js
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..", "..", "..");
const reg = require(path.join(ROOT, ".agents", "hooks", "core", "beh-registry.js"));
const ss = require(path.join(ROOT, ".agents", "hooks", "core", "beh-second-stream.js"));

let PASS = 0,
	FAIL = 0;
const FAILED = [];
function assert(c, n, d) {
	c ? PASS++ : (FAIL++, FAILED.push(n), console.log(`  ✗ FAIL: ${n}${d ? "\n     " + d : ""}`));
}

// ── registry schema (real file) ────────────────────────────────────────────
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, ".agents", "hooks", "beh-registry.json"), "utf8"));
{
	const v = reg.validateRegistry(registry);
	assert(v.ok, "1. real registry passes schema validation", v.errors.join("; "));
}
// negative: a missing required field is caught.
{
	const bad = { entries: [{ name: "x", surface: "Stop", trigger: "t", check: "c", action: "a", fail_mode: "f", escalation: "e" }] };
	const v = reg.validateRegistry(bad);
	assert(!v.ok && v.errors.some((e) => /recovery/.test(e)), "2. missing field → validation error");
}
// negative: bad surface caught.
{
	const v = reg.validateRegistry({ entries: [{ name: "x", surface: "Nope", trigger: "t", check: "c", action: "a", fail_mode: "f", escalation: "e", recovery: "r" }] });
	assert(!v.ok && v.errors.some((e) => /surface/.test(e)), "3. bad surface → validation error");
}

// ── cross-check vs real settings.json (registration-drift guard) ─────────────
const settingsText = fs.readFileSync(path.join(ROOT, ".claude", "settings.json"), "utf8");
{
	const x = reg.crossCheckSettings(registry, settingsText);
	assert(x.ok, "4. registry ↔ settings.json consistent (no registration drift)", x.errors.join("; "));
}
// negative: a registered hook absent from settings → drift error.
{
	const x = reg.crossCheckSettings({ entries: [{ name: "ghost", hook_file: "beh-ghost.js", registered: true }] }, settingsText);
	assert(!x.ok && x.errors.some((e) => /미등록|드리프트/.test(e)), "5. registered hook absent in settings → drift error");
}
// negative: a settings beh hook not catalogued → undocumented error.
{
	const x = reg.crossCheckSettings({ entries: [] }, '{"x":"node .claude/hooks/beh-tick.js"}');
	assert(!x.ok && x.errors.some((e) => /미등재|미문서화/.test(e)), "6. uncatalogued settings hook → undocumented error");
}

// every catalogued hook_file actually exists on disk (no phantom entries).
{
	const missing = (registry.entries || [])
		.map((e) => e.hook_file)
		.filter(Boolean)
		.filter((f) => !fs.existsSync(path.join(ROOT, ".claude", "hooks", f)));
	assert(missing.length === 0, "6b. every registry hook_file exists on disk", `missing: ${missing.join(", ")}`);
}

// ── second-stream advisory plumbing ──────────────────────────────────────────
const ledger = [
	{ turn: 1, tool: "Edit", scope_item: "a", matched_milestone: "m1" },
	{ turn: 2, tool: "Bash", scope_item: "a" },
	{ turn: 3, tool: "Edit", scope_item: "b", matched_milestone: "m2" },
	{ turn: 3, tool_less: true, scope_item: "b" },
];
{
	const s = ss.summarizeForAdvisory(ledger);
	assert(s.total_events === 4 && s.milestones_hit === 2 && s.tool_less_events === 1 && s.last_turn === 3, "7. summary: structured counts", JSON.stringify(s));
	assert(s.tool_counts.Edit === 2 && s.per_item.a.milestones === 1, "8. summary: per-tool + per-item shape");
}
// no llmFn → advisory null, never gates.
{
	const r = ss.runAdvisory(ledger, null);
	assert(r.advisory === null && r.gated === false, "9. no llmFn → advisory null, gated false");
}
// stub llmFn → advisory string, still never gates.
{
	const r = ss.runAdvisory(ledger, (sum) => `note: ${sum.total_events} events`);
	assert(/note: 4 events/.test(r.advisory) && r.gated === false, "10. stub llmFn → advisory present, gated false");
}
// throwing llmFn → clean no-op (2nd-stream failure must not affect anything).
{
	const r = ss.runAdvisory(ledger, () => {
		throw new Error("llm down");
	});
	assert(r.advisory === null && r.gated === false, "11. throwing llmFn → no-op (advisory null)");
}

console.log(`\nBEH registry + second-stream: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) {
	console.log("FAILED: " + FAILED.join(", "));
	process.exit(1);
}
