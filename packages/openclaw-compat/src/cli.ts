#!/usr/bin/env node
/**
 * naia-openclaw-migrate — one-shot CLI to convert an OpenClaw skill folder
 * into a naia SkillDescriptor TypeScript module.
 *
 * Usage:
 *   naia-openclaw-migrate <openclaw-skills-dir> <output.ts>
 *
 * Examples:
 *   naia-openclaw-migrate ./openclaw/container/skills my-catalog.ts
 *   naia-openclaw-migrate ./openclaw/groups/global out/global-catalog.ts
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { emitCatalog } from "./emitter.js";
import { parseOpenClawCatalog, parseOpenClawGroups } from "./parser.js";

function usage(): void {
	console.error("Usage: naia-openclaw-migrate <openclaw-skills-dir> <output.ts>");
	console.error("       (--groups <openclaw-groups-dir> <output.ts>)");
	process.exit(2);
}

function main(argv: string[]): void {
	const args = argv.slice(2);
	if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
		usage();
		return;
	}

	let groupsMode = false;
	if (args[0] === "--groups") {
		groupsMode = true;
		args.shift();
	}
	if (args.length !== 2) {
		usage();
		return;
	}

	const inputDir = resolve(args[0]);
	const outputFile = resolve(args[1]);

	try {
		if (groupsMode) {
			const groups = parseOpenClawGroups(inputDir);
			const all = groups.flatMap((g) => g.skills);
			const ts = emitCatalog(all);
			writeFileSync(outputFile, ts, "utf8");
			console.log(
				`[naia-openclaw-migrate] groups=${groups.length} skills=${all.length} → ${outputFile}`,
			);
			for (const g of groups) {
				console.log(`  ${g.scope}: ${g.skills.length} skills`);
			}
		} else {
			const skills = parseOpenClawCatalog(inputDir);
			const ts = emitCatalog(skills);
			writeFileSync(outputFile, ts, "utf8");
			console.log(`[naia-openclaw-migrate] skills=${skills.length} → ${outputFile}`);
			for (const s of skills) {
				console.log(`  ${s.descriptor.name} (${s.descriptor.tier}) [${s.descriptor.tags?.join(",")}]`);
			}
		}
	} catch (e) {
		console.error(`[naia-openclaw-migrate] ERROR: ${(e as Error).message}`);
		process.exit(1);
	}
}

main(process.argv);
