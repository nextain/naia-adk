#!/usr/bin/env node
/**
 * RDD Align-Audit runner (out-of-loop, deterministic).
 * Copyright 2026 Nextain Inc. All rights reserved.
 *
 * Independence root (per adversarial review): the AUDIT INPUT is assembled here by
 * reading the ledger files directly — the in-loop AI cannot curate what the audit sees.
 * This is a RUNNER, not a skill: it must be invoked out-of-loop (human, cron, or CI),
 * mirroring the beh-launch handshake pattern. It writes the stamp the experiment-guard
 * hook requires; the AI cannot fabricate a valid stamp without passing these checks on
 * the ledger it actually wrote.
 *
 * Deterministic gates (physical traces, not meaning):
 *   G1 completeness : every OPEN entry has hypothesis, charter_subgoal, method_contract,
 *                     gate, decision_map(pass&fail), tags[].
 *   G2 charter-trace: charter_subgoal references a real sub_goal id in charter.yaml.
 *   G3 refutability : decision_map defines BOTH pass and fail next-actions.
 *   G4 tag-recall   : if any insight-ledger entry shares a tag with an OPEN entry and is
 *                     NOT listed in that entry's references[] → FAIL (forces recall).
 * On ALL pass → writes .align-audit-stamp.json {ts, ledger_hash, program, entry_ids}.
 *
 * Usage:  node scripts/rdd-audit.js <program>        # program = dir under .agents/research/
 *         node scripts/rdd-audit.js <program> --json
 * Exit 0 = PASS (stamp written), 1 = FAIL (no stamp), 2 = usage/IO error.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function sha(s) {
	return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function fail(msg, code = 1) {
	console.error(msg);
	process.exit(code);
}

const program = process.argv[2];
if (!program) fail("usage: node scripts/rdd-audit.js <program> [--json]", 2);

const root = process.cwd();
const dir = path.join(root, ".agents", "research", program);
if (!fs.existsSync(dir)) fail(`[RDD] program dir not found: ${dir}`, 2);

const charterPath = path.join(dir, "charter.yaml");
const ledgerPath = path.join(dir, "hypothesis-ledger.json");
const insightPath = path.join(dir, "insight-ledger.md");

if (!fs.existsSync(charterPath)) fail(`[RDD] charter.yaml missing — define the invariant goal first.`, 1);
if (!fs.existsSync(ledgerPath)) fail(`[RDD] hypothesis-ledger.json missing — pre-register first.`, 1);

const charterText = fs.readFileSync(charterPath, "utf8");
const subGoalIds = [...charterText.matchAll(/^\s*-?\s*id:\s*(\S+)/gm)].map((m) => m[1]);

const ledgerRaw = fs.readFileSync(ledgerPath, "utf8");
let ledger;
try {
	ledger = JSON.parse(ledgerRaw);
} catch (e) {
	fail(`[RDD] hypothesis-ledger.json parse error: ${e.message}`, 1);
}
const openEntries = (Array.isArray(ledger.entries) ? ledger.entries : []).filter((e) => e && e.status === "open");
if (openEntries.length === 0) fail(`[RDD] no OPEN entries to audit. Register a hypothesis (status:"open").`, 1);

// insight-ledger tags per entry (## <id> ... - tags: [..])
const insightText = fs.existsSync(insightPath) ? fs.readFileSync(insightPath, "utf8") : "";
const insightEntries = [];
{
	const blocks = insightText.split(/^##\s+/m).slice(1);
	for (const b of blocks) {
		const id = (b.match(/^(\S+)/) || [])[1] || "";
		const tm = b.match(/tags:\s*\[([^\]]*)\]/);
		const tags = tm ? tm[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
		insightEntries.push({ id, tags });
	}
}

const problems = [];
for (const e of openEntries) {
	const id = e.id || "(no-id)";
	// G1 completeness
	const missing = [];
	if (!e.hypothesis) missing.push("hypothesis");
	if (!e.charter_subgoal) missing.push("charter_subgoal");
	if (!e.method_contract) missing.push("method_contract");
	if (!e.gate) missing.push("gate");
	if (!e.decision_map || !e.decision_map.pass || !e.decision_map.fail) missing.push("decision_map.pass+fail");
	if (!Array.isArray(e.tags) || e.tags.length === 0) missing.push("tags");
	if (missing.length) problems.push(`  [${id}] G1 미완성 필드: ${missing.join(", ")}`);
	// G2 charter-trace
	if (e.charter_subgoal && subGoalIds.length && !subGoalIds.includes(e.charter_subgoal))
		problems.push(`  [${id}] G2 charter_subgoal "${e.charter_subgoal}" not in charter sub_goals (${subGoalIds.join(",")})`);
	// G4 tag-recall
	if (Array.isArray(e.tags) && e.tags.length) {
		const refs = new Set(e.references || []);
		const missedRecall = insightEntries.filter(
			(ie) => ie.id && ie.tags.some((t) => e.tags.includes(t)) && !refs.has(ie.id),
		);
		if (missedRecall.length)
			problems.push(
				`  [${id}] G4 회상 누락: 태그 겹치는 과거 insight 미참조 → ${missedRecall
					.map((m) => `${m.id}(${m.tags.filter((t) => e.tags.includes(t)).join("|")})`)
					.join(", ")}. references[]에 넣고 왜 다른지 기록하라.`,
			);
	}
}

const asJson = process.argv.includes("--json");
if (problems.length) {
	const out = `[RDD] Align-Audit FAIL (${program}) — 스탬프 미발급:\n${problems.join("\n")}`;
	if (asJson) console.log(JSON.stringify({ pass: false, program, problems }, null, 2));
	fail(out, 1);
}

// PASS → write stamp bound to current ledger hash
const stamp = {
	ts: Date.now(),
	ledger_hash: sha(ledgerRaw),
	program,
	entry_ids: openEntries.map((e) => e.id),
	audited_by: "rdd-audit-runner",
};
fs.writeFileSync(path.join(dir, ".align-audit-stamp.json"), JSON.stringify(stamp, null, 2));
const msg = `[RDD] Align-Audit PASS (${program}) — 스탬프 발급. open=${stamp.entry_ids.join(",")} ledger_hash=${stamp.ledger_hash}`;
if (asJson) console.log(JSON.stringify({ pass: true, ...stamp }, null, 2));
else console.log(msg);
process.exit(0);
