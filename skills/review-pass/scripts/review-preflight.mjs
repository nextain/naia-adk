#!/usr/bin/env node
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runComplexityMeasurement } from "./measure-complexity.mjs";

function parseArgs(argv) {
	const options = { root: null, base: null, json: false };
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		if (value === "--json") options.json = true;
		else if (value === "--root" || value === "--base") {
			const next = argv[++index];
			if (!next) throw new Error(`${value} requires a value`);
			options[value.slice(2)] = value === "--root" ? resolve(next) : next;
		} else throw new Error(`unknown review preflight option: ${value}`);
	}
	if (!options.root || !options.base) throw new Error("--root and --base are required");
	return options;
}

export function evaluateReviewPreflight(options) {
	const complexity = runComplexityMeasurement(options);
	const complexitySha256 = `sha256:${createHash("sha256").update(JSON.stringify(complexity)).digest("hex")}`;
	if (complexity.result === "REFACTOR_REQUIRED") return { schemaVersion: 1, verdict: "NOT_CLEAN", reason: "complexity_refactor_required", complexitySha256, complexity };
	if (complexity.result === "ATTENTION") return { schemaVersion: 1, verdict: "REVIEW_REQUIRED", reason: "complexity_attention_requires_named_review", complexitySha256, complexity };
	return { schemaVersion: 1, verdict: "PREFLIGHT_CLEAN", reason: null, complexitySha256, complexity };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const options = parseArgs(process.argv.slice(2));
		const report = evaluateReviewPreflight(options);
		console.log(options.json ? JSON.stringify(report, null, 2) : `review_preflight=${report.verdict}${report.reason ? ` reason=${report.reason}` : ""}`);
		if (report.verdict === "NOT_CLEAN") process.exitCode = 2;
		else if (report.verdict === "REVIEW_REQUIRED") process.exitCode = 3;
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
