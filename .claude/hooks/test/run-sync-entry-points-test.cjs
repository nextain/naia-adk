const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sync = require('../sync-entry-points.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-sync-'));
try {
  fs.mkdirSync(path.join(root, '.git'));
  for (const name of sync.ENTRY_POINTS) fs.writeFileSync(path.join(root, name), name);
  assert.deepEqual(sync.checkEntryPoints(root), ['CLAUDE.md', 'GEMINI.md']);
  assert.deepEqual(sync.syncEntryPoints(root, path.join(root, 'AGENTS.md')), ['CLAUDE.md', 'GEMINI.md']);
  assert.deepEqual(sync.checkEntryPoints(root), []);
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'changed by Claude\n');
  assert.deepEqual(sync.syncEntryPoints(root, path.join(root, 'CLAUDE.md')), ['CLAUDE.md']);
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), 'AGENTS.md');
  assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), 'AGENTS.md');
  fs.writeFileSync(path.join(root, 'GEMINI.md'), 'changed by Gemini\n');
  assert.deepEqual(sync.syncEntryPoints(root, path.join(root, 'GEMINI.md')), ['GEMINI.md']);
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), 'AGENTS.md');
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'nested', 'AGENTS.md'), 'nested');
  assert.deepEqual(sync.syncEntryPoints(root, path.join(root, 'nested', 'AGENTS.md')), []);
  console.log('entry point sync tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
