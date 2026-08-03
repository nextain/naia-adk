#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..", "..");
const files = [
	path.join(root, ".agents", "skills", "review-pass", "SKILL.md"),
	path.join(root, "skills", "review-pass", "SKILL.md"),
];
const lenses = ["context_output_separation", "audience_surface_fit", "unjustified_product_surface"];

for (const file of files) {
	const content = fs.readFileSync(file, "utf8");
	for (const lens of lenses) {
		const occurrences = content.split(lens).length - 1;
		assert.ok(occurrences >= 9, `${path.relative(root, file)} must define ${lens} and include it in both profiles for all four stages`);
	}
	for (const code of ["FINDING-CONTEXT-OUTPUT-SEPARATION", "FINDING-AUDIENCE-SURFACE-FIT", "FINDING-UNJUSTIFIED-PRODUCT-SURFACE"]) {
		assert.match(content, new RegExp(code));
	}
}

console.log("review-pass context/output lenses: PASS");
