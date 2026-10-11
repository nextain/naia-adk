// Feature-regression prevention rules: required rules exist and are routed (docs/guides/drift-recovery.md).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const live = (f) => read(f).split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");

const REQUIRED = [
	"remove_needs_requester_quote", "coordinator_decision_not_basis", "keep_baseline_section", "impossible_needs_evidence",
	"deletion_needs_basis", "done_needs_all_entrypoints", "requester_quote_fail_not_overridden", "repeat_review_triage",
	"subtask_quotes_mission", "drift_recovery_order",
];

test("every required rule is a non-trivial string", () => {
	const spec = JSON.parse(read(".agents/context/regression-prevention.json"));
	for (const k of REQUIRED) {
		assert.equal(typeof spec.rules?.[k], "string", k);
		assert.ok(spec.rules[k].trim().length >= 40, k);
	}
});

// Each load-bearing clause must appear verbatim, so a negated or truncated rule fails.
const CLAUSES = {
	remove_needs_requester_quote: ["only with a dated requester quote that asks for it", "AI inference or coordinator judgment is not grounds for removal", "without the quote the review fails"],
	deletion_needs_basis: ["an issue number without such a quote is not a basis", "a mock-only test is never the sole evidence"],
	done_needs_all_entrypoints: ["only with evidence that every user entry point on the changed path was actually checked", "Never widen a partial flow or a single measurement into an overall pass"],
	requester_quote_fail_not_overridden: ["the coordinator does not override it", "pass a re-review of the same target"],
	repeat_review_triage: ["After 5 review FAILs on the same target (every 4 after a triage)", "the same target path is the same target even under a different issue or gate", "it is the same target only when both the issue and the gate are the same", "Changing the path together with the issue or the gate starts new work", "verbatim from that round's stored result copy", "the record confirms the finding does not rest on a requester quote", "Findings grounded in a requester quote are never dropped"],
};

test("rules keep their load-bearing clauses verbatim", () => {
	const r = JSON.parse(read(".agents/context/regression-prevention.json")).rules;
	for (const [k, clauses] of Object.entries(CLAUSES)) for (const c of clauses) assert.ok(r[k].includes(c), `${k}: ${c}`);
	assert.doesNotMatch(JSON.stringify(r), /\b(?:may|can) (?:override|drop|remove) without\b/i);
});

test("entry point covers every preflight surface kind and the preflight applies to all feature work", () => {
	const spec = JSON.parse(read(".agents/context/regression-prevention.json"));
	const guide = read("docs/guides/drift-recovery.md");
	for (const kind of ["URL", "API", "CLI command", "library export", "data schema", "job", "package or deployment target", "operations or handoff path"]) {
		assert.ok(spec.terms["user entry point"].includes(kind), kind);
		assert.ok(guide.includes(kind), kind);
	}
	assert.ok(spec.source.includes("applies to all feature work including non-governed projects"));
	assert.ok(guide.includes("applies to all feature work including non-governed projects"));
	assert.doesNotMatch(spec.source + guide, /in governed mode/);
});

test("Korean and English human mirrors carry the same routing", () => {
	for (const f of [".users/context/ai-work-index.md", ".users/context/en/ai-work-index.md"]) {
		const mirror = read(f);
		assert.match(mirror, /\(drift-recovery\)/, f);
		assert.match(mirror, /docs\/guides\/drift-recovery\.md/, f);
		assert.equal((mirror.match(/\.agents\/context\/regression-prevention\.json/g) || []).length, 2, f);
	}
});

test("rules point to the procedure and the procedure exists", () => {
	assert.match(read(".agents/context/regression-prevention.json"), /docs\/guides\/drift-recovery\.md/);
	assert.ok(fs.existsSync(path.join(root, "docs/guides/drift-recovery.md")));
});

test("the rule file is routed from project-index on_demand and ai-work-index", () => {
	assert.match(live(".agents/context/project-index.yaml"), /- id: naia-adk:regression_prevention\n\s+file: \.agents\/context\/regression-prevention\.json\n/);
	assert.match(live(".agents/context/ai-work-index.yaml"), /- name: "drift-recovery"[\s\S]*?- "docs\/guides\/drift-recovery\.md"/);
});
