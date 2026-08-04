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

console.log("review-pass distribution parity: PASS");
