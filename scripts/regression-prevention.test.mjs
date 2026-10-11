// Feature-regression prevention rules: required rules exist and are routed (docs/guides/drift-recovery.md).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { createRequire } from "node:module";
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
	coordinator_decision_not_basis: ["A decision without a requester quote, or marked unconfirmed, withdrawn, or superseded, is not a basis", "Do not turn an implementation into a decision"],
	keep_baseline_section: ["has a 'Existing behavior to keep' section", "the baseline commit and, one per line, each user entry point that passes through the changed code path", "'does not apply' with a reason"],
	impossible_needs_evidence: ["only together with the search result that found the previously working implementation (file:line) and a run result", "Without them the review fails"],
	deletion_needs_basis: ["has a 'Deletion basis' section giving, per file, a requester quote or the number of an issue that contains the requester's request for it", "an issue number without such a quote is not a basis", "A deleted test is replaced by one that exercises real behavior", "a mock-only test is never the sole evidence"],
	done_needs_all_entrypoints: ["only with evidence that every user entry point on the changed path was actually checked the same way as on the baseline", "Never widen a partial flow or a single measurement into an overall pass"],
	requester_quote_fail_not_overridden: ["the coordinator does not override it", "Fix it and pass a re-review of the same target", "escalate to the requester only when it cannot be fixed"],
	repeat_review_triage: ["After 5 review FAILs on the same target (every 4 after a triage)", "from a stronger model different from the implementer and reviewer, given the whole FAIL history, before the next round", "the same target path is the same target even under a different issue or gate", "it is the same target only when both the issue and the gate are the same", "Changing the path together with the issue or the gate starts new work", "Drop a finding only when the verdict is wrong instruction or over-review", "the path of that round's stored result copy and quotes from that copy, verbatim", "that round has no FAIL grounded in a requester quote", "Findings grounded in a requester quote are never dropped"],
	subtask_quotes_mission: ["carries a 'Goal:' line that quotes the requester's goal verbatim", "Coordinator summaries go only in a separate 'Coordinator interpretation' field"],
	drift_recovery_order: ["1) pin the goal 2) map the contaminated scope 3) quarantine-delete the wrong code and documents 4) assess, analyze gaps, design, then build", "Procedure: docs/guides/drift-recovery.md"],
};

// The whole rule set is pinned: any added, removed, or reworded sentence (including an appended
// exception such as "the coordinator may override") fails here. Change a rule deliberately by
// updating this hash in the same reviewed commit.
const RULES_SHA256 = "cacfce226152be8c7aae5d23397709701d2f2f344450ab4166581bc6531116ec";

function canonical(value) {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
	return JSON.stringify(value);
}

test("the rule set matches its pinned hash", () => {
	const r = JSON.parse(read(".agents/context/regression-prevention.json")).rules;
	assert.equal(crypto.createHash("sha256").update(canonical(r)).digest("hex"), RULES_SHA256);
});

test("the generated context mirror equals a fresh render of the JSON", () => {
	const require = createRequire(import.meta.url);
	const { syncContextMirror } = require(path.join(root, ".claude/hooks/agents-context-mirror.js"));
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rp-mirror-"));
	try {
		fs.mkdirSync(path.join(tmp, ".agents/context"), { recursive: true });
		fs.mkdirSync(path.join(tmp, ".users/context"), { recursive: true });
		fs.copyFileSync(path.join(root, ".agents/context/regression-prevention.json"), path.join(tmp, ".agents/context/regression-prevention.json"));
		syncContextMirror({ tool_input: { file_path: ".agents/context/regression-prevention.json" } }, tmp);
		assert.equal(read(".users/context/regression-prevention.md"), fs.readFileSync(path.join(tmp, ".users/context/regression-prevention.md"), "utf8"));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("rules keep their load-bearing clauses verbatim", () => {
	const r = JSON.parse(read(".agents/context/regression-prevention.json")).rules;
	assert.deepEqual(Object.keys(CLAUSES).sort(), [...REQUIRED].sort());
	for (const [k, clauses] of Object.entries(CLAUSES)) for (const c of clauses) assert.ok(r[k].includes(c), `${k}: ${c}`);
	// Negation guard: no rule may carry a word that flips a clause.
	assert.doesNotMatch(Object.values(r).join(" "), /\b(?:optional(?:ly)?|unless convenient|may be skipped|not required)\b/i);
	assert.doesNotMatch(JSON.stringify(r), /\b(?:may|can) (?:override|drop|remove) without\b/i);
});

test("entry point covers every preflight surface kind and the preflight applies to all feature work", () => {
	const spec = JSON.parse(read(".agents/context/regression-prevention.json"));
	const guide = read("docs/guides/drift-recovery.md");
	for (const kind of ["UI route or navigation", "screen", "button", "URL", "API", "CLI command", "library export", "data schema", "job", "package or deployment target", "operations or handoff path"]) {
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
	// Structural: the entry must be an item of on_demand_loading.sections, not just text somewhere.
	const lines = read(".agents/context/project-index.yaml").split("\n");
	const indent = (l) => l.length - l.trimStart().length;
	const blockAfter = (from, ind) => {
		const out = [];
		for (let i = from + 1; i < lines.length; i++) {
			const l = lines[i];
			if (!l.trim() || l.trimStart().startsWith("#")) continue;
			if (indent(l) <= ind) break;
			out.push(i);
		}
		return out;
	};
	const top = lines.findIndex((l) => /^on_demand_loading:\s*(#.*)?$/.test(l));
	assert.ok(top >= 0, "on_demand_loading");
	const sec = blockAfter(top, 0).find((i) => indent(lines[i]) === 2 && /^\s*sections:\s*(#.*)?$/.test(lines[i]));
	assert.ok(sec !== undefined, "on_demand_loading.sections");
	const items = blockAfter(sec, 2);
	const itemInd = indent(lines[items[0]]);
	const start = items.find((i) => indent(lines[i]) === itemInd && /^\s*- id: naia-adk:regression_prevention\s*$/.test(lines[i]));
	assert.ok(start !== undefined, "section item naia-adk:regression_prevention");
	const body = blockAfter(start, itemInd).map((i) => lines[i]);
	assert.ok(body.some((l) => /^\s*file: \.agents\/context\/regression-prevention\.json\s*$/.test(l)), "item file");
	assert.match(live(".agents/context/ai-work-index.yaml"), /- name: "drift-recovery"[\s\S]*?- "docs\/guides\/drift-recovery\.md"/);
});
