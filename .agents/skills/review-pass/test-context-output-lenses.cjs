#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..", "..");
const sourceGroups = [
	[
		path.join(root, ".agents", "skills", "review-pass", "SKILL.md"),
		path.join(root, ".agents", "skills", "review-pass", "references", "stage-profiles.md"),
		path.join(root, ".agents", "skills", "review-pass", "references", "configuration-and-requirements.md"),
	],
	[path.join(root, "skills", "review-pass", "SKILL.md")],
];
const lenses = ["context_output_separation", "audience_surface_fit", "unjustified_product_surface"];

for (const files of sourceGroups) {
	const content = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
	const label = files.map((file) => path.relative(root, file)).join(" + ");
	for (const lens of lenses) {
		const occurrences = content.split(lens).length - 1;
		assert.ok(occurrences >= 9, `${label} must define ${lens} and include it in both profiles for all four stages`);
	}
	for (const code of ["FINDING-CONTEXT-OUTPUT-SEPARATION", "FINDING-AUDIENCE-SURFACE-FIT", "FINDING-UNJUSTIFIED-PRODUCT-SURFACE"]) {
		assert.match(content, new RegExp(code));
	}
}

console.log("review-pass context/output lenses: PASS");
