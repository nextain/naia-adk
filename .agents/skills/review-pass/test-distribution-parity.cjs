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
	"scripts/measure-complexity.mjs",
	"scripts/review-preflight.mjs",
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

const consensusContract = fs.readFileSync(path.join(canonical, "references", "consensus-and-convergence.md"), "utf8");
const invocationContract = fs.readFileSync(path.join(canonical, "references", "invocation-and-output.md"), "utf8");
const deliveryContract = fs.readFileSync(path.join(canonical, "references", "reporting-and-delivery.md"), "utf8");
const humanSummary = fs.readFileSync(path.join(root, ".users", "skills", "review-pass", "SKILL.md"), "utf8");

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
