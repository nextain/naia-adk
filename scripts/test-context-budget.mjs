import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkContextBudget } from './check-context-budget.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'context-budget-'));
try {
	fs.mkdirSync(path.join(root, '.agents/context'), { recursive: true });
	fs.writeFileSync(path.join(root, 'a.md'), 'x'.repeat(600));
	fs.writeFileSync(path.join(root, 'b.md'), 'x'.repeat(500));
	const write = (sets) => fs.writeFileSync(path.join(root, '.agents/context/context-budget.json'), JSON.stringify({ sets }));
	write([{ name: 'core', max_bytes: 1100, files: ['a.md', 'b.md'] }]);
	assert.deepEqual(checkContextBudget(root), []);
	write([{ name: 'core', max_bytes: 1099, files: ['a.md', 'b.md'] }]);
	assert.match(checkContextBudget(root)[0], /core is 1100 bytes \(max 1099\)/);
	write([{ name: 'core', max_bytes: 5000, files: ['a.md', 'gone.md'] }]);
	assert.match(checkContextBudget(root)[0], /missing file: gone\.md/);
	write([{ name: 'core', files: ['a.md'] }]);
	assert.match(checkContextBudget(root)[0], /malformed/);
	write([]);
	assert.deepEqual(checkContextBudget(root), ['context budget has no sets']);
	console.log('context budget tests passed');
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
