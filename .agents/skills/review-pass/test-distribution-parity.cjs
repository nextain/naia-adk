#!/usr/bin/env node

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..", "..");
const canonical = path.join(root, ".agents", "skills", "review-pass");
const distributed = path.join(root, "skills", "review-pass");
const mirrored = [
	"references/configuration-and-requirements.md",
	"references/consensus-and-convergence.md",
	"references/invocation-and-output.md",
	"references/preflight.md",
	"references/reporting-and-delivery.md",
	"references/stage-profiles.md",
	"scripts/check-output-boundary.cjs",
	"scripts/invoke-reviewer.mjs",
	"scripts/measure-complexity.mjs",
	"scripts/review-cost-log.mjs",
	"scripts/review-output-contract.mjs",
	"scripts/review-preflight.mjs",
	"scripts/validate-review-output.mjs",
];

const canonicalSkill = fs.readFileSync(path.join(canonical, "SKILL.md"), "utf8");
const distributedSkill = fs.readFileSync(path.join(distributed, "SKILL.md"), "utf8");
assert.equal(
	distributedSkill.replace(/^tier: T1\n/m, ""),
	canonicalSkill,
	"distributed SKILL.md must equal the canonical entry after removing its required T1 marker",
);
assert.equal((distributedSkill.match(/^tier: T1$/gm) || []).length, 1, "distributed skill must declare exactly one T1 marker");

for (const relative of mirrored) {
	assert.deepEqual(
		fs.readFileSync(path.join(distributed, relative)),
		fs.readFileSync(path.join(canonical, relative)),
		`distributed review-pass drift: ${relative}`,
	);
}


const listFiles = (directory) => fs.readdirSync(directory, { withFileTypes: true })
	.filter((entry) => entry.isFile())
	.map((entry) => entry.name)
	.sort();
const canonicalTestNames = listFiles(path.join(canonical, "tests"));
const distributedTestNames = listFiles(path.join(distributed, "tests"));
assert.deepEqual(distributedTestNames, canonicalTestNames, "distributed review-pass test set must equal canonical");
for (const name of canonicalTestNames) {
	assert.deepEqual(
		fs.readFileSync(path.join(distributed, "tests", name)),
		fs.readFileSync(path.join(canonical, "tests", name)),
		"distributed review-pass test drift: " + name,
	);
}

const supportedAdapterNames = ["agy", "claude", "codex", "grok", "opencode"];
const configTexts = [
	fs.readFileSync(path.join(canonical, "references", "configuration-and-requirements.md"), "utf8"),
	fs.readFileSync(path.join(root, ".users", "skills", "review-pass", "references", "configuration-and-requirements.md"), "utf8"),
];
for (const configText of configTexts) {
	assert.doesNotMatch(configText, /\bgemini\b/, "unsupported gemini adapter must not appear in review configuration");
	assert.doesNotMatch(configText, /--full-auto/, "review configuration must not enable full-auto mode");
	assert.doesNotMatch(configText, /\{prompt\}/, "review prompts must not be passed as an argv placeholder");
	for (const match of configText.matchAll(/reviewers:\s*\[([^\]]*)\]/g)) {
		for (const name of match[1].split(",").map((value) => value.trim()).filter(Boolean)) {
			assert.ok(supportedAdapterNames.includes(name), "unsupported configured reviewer: " + name);
		}
	}
}

const consensusContract = fs.readFileSync(path.join(canonical, "references", "consensus-and-convergence.md"), "utf8");
const invocationContract = fs.readFileSync(path.join(canonical, "references", "invocation-and-output.md"), "utf8");
const deliveryContract = fs.readFileSync(path.join(canonical, "references", "reporting-and-delivery.md"), "utf8");
const userConsensusContract = fs.readFileSync(path.join(root, ".users", "skills", "review-pass", "references", "consensus-and-convergence.md"), "utf8");
const humanSummary = fs.readFileSync(path.join(root, ".users", "skills", "review-pass", "SKILL.md"), "utf8");

const gracefulDegradationSection = (text) => {
	const match = text.match(/^## 7\. Graceful Degradation\n[\s\S]*?(?=^## 8\.)/m);
	assert.ok(match, "review-pass graceful degradation section must be present");
	return match[0];
};
assert.equal(
	gracefulDegradationSection(userConsensusContract),
	gracefulDegradationSection(consensusContract),
	".users review-pass graceful degradation must match the canonical contract",
);

assert.match(consensusContract, /Only `ACCEPTED` enters auto-fix/);
assert.match(consensusContract, /`REJECTED` is recorded without modification/);
assert.match(consensusContract, /`UNRESOLVED` blocks CLEAN and release eligibility/);
assert.match(invocationContract, /evidence_status: ACCEPTED \| REJECTED \| UNRESOLVED \| null/);
assert.match(invocationContract, /evidence_checked: string\[\]/);
assert.match(deliveryContract, /Consensus alone never authorizes a modification/);
assert.match(deliveryContract, /evidence-`UNRESOLVED` finding/);
assert.match(humanSummary, /`ACCEPTED`인 결함만 자동 수정/);
assert.match(humanSummary, /`UNRESOLVED`는 Clean을 차단/);

console.log("review-pass distribution parity: PASS");
