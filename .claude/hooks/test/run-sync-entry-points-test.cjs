const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sync = require('../sync-entry-points.js');
const actualRoot = sync.findRepoRoot(__dirname);
const actualCanonical = fs.readFileSync(path.join(actualRoot, 'AGENTS.md'));
assert.equal(sync.approvedDigestViolation(actualCanonical, actualRoot), null);
assert.match(sync.approvedDigestViolation(Buffer.concat([actualCanonical, Buffer.from('\nproduct copy\n')]), actualRoot), /not approved/);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-sync-'));
try {
  fs.mkdirSync(path.join(root, '.git'));
  const valid = '# Repo\n\n## Mandatory Reads\n\n- `.agents/context/agents-rules.json`\n';
  for (const name of sync.ENTRY_POINTS) fs.writeFileSync(path.join(root, name), name === 'AGENTS.md' ? valid : name);
  assert.deepEqual(sync.checkEntryPoints(root), ['CLAUDE.md', 'GEMINI.md']);
  assert.deepEqual(sync.syncEntryPoints(root, path.join(root, 'AGENTS.md')), ['CLAUDE.md', 'GEMINI.md']);
  assert.deepEqual(sync.checkEntryPoints(root), []);
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'changed by Claude\n');
  assert.deepEqual(sync.syncEntryPoints(root, path.join(root, 'CLAUDE.md')), ['CLAUDE.md']);
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), valid);
  assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), valid);
  fs.writeFileSync(path.join(root, 'GEMINI.md'), 'changed by Gemini\n');
  assert.deepEqual(sync.syncEntryPoints(root, path.join(root, 'GEMINI.md')), ['GEMINI.md']);
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), valid);
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'nested', 'AGENTS.md'), 'nested');
  assert.deepEqual(sync.syncEntryPoints(root, path.join(root, 'nested', 'AGENTS.md')), []);
  for (const invalid of [
    '# Repo\n\n## Current Work\n\nIssue: 17\n',
    '# Repo\n\n## 현재 작업\n\n현재 목표: 제품 카피 구현\n',
		'# Repo\n\n## Mandatory Reads\n\n### Implementation Plan\n',
		'# Repo\n\n## Repository Index\n\nShip the six-screen product copy now.\n',
		'# Repo\n\n## Session Boundaries\n\nThe current goal is to finish the launch copy.\n',
  ]) {
    assert.throws(() => sync.validateEntryPoint(invalid), /Entrypoint boundary violation/);
  }
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Repo\n\n## Current Work\n');
  assert.ok(sync.checkEntryPoints(root).some((failure) => failure.startsWith('AGENTS.md:')));
  assert.throws(
    () => sync.syncEntryPoints(root, path.join(root, 'AGENTS.md')),
    /Entrypoint boundary violation/,
    'validation must run before mirrors are updated',
  );
  console.log('entry point sync tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
