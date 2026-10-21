#!/usr/bin/env node
// Read-set budgets: every file an agent reads rides along on each later model
// call. When a set is over budget, split content into docs/ or docs/archive/
// instead of raising the budget. Budgets: .agents/context/context-budget.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkContextBudget(root) {
	const failures = [];
	const budget = JSON.parse(fs.readFileSync(path.join(root, '.agents/context/context-budget.json'), 'utf8'));
	if (!Array.isArray(budget.sets) || budget.sets.length === 0) return ['context budget has no sets'];
	for (const set of budget.sets) {
		if (!set.name || !Number.isInteger(set.max_bytes) || !Array.isArray(set.files) || set.files.length === 0) {
			failures.push(`context budget set is malformed: ${JSON.stringify(set.name ?? set)}`);
			continue;
		}
		let total = 0;
		for (const file of set.files) {
			const full = path.join(root, file);
			if (!fs.existsSync(full)) { failures.push(`context budget ${set.name} lists a missing file: ${file}`); continue; }
			total += fs.statSync(full).size;
		}
		if (total > set.max_bytes) {
			failures.push(`context budget ${set.name} is ${total} bytes (max ${set.max_bytes}); split content into docs/ or docs/archive/ instead of raising the budget`);
		}
	}
	return failures;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
	const failures = checkContextBudget(root);
	for (const failure of failures) console.error(`[context-budget] ${failure}`);
	if (!failures.length) console.log('context budget: PASS');
	process.exitCode = failures.length ? 1 : 0;
}
