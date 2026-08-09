const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const batch = require('../context-translation-batch.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'context-batch-'));
try {
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, '.users', 'context'), { recursive: true });

  assert.deepEqual(batch.eventPaths({
    tool_input: { command: '*** Begin Patch\n*** Update File: .users/context/rules.md\n*** Move to: .users/context/moved.md\n*** End Patch' },
  }), ['.users/context/rules.md', '.users/context/moved.md']);

  assert.equal(batch.queueChangedFile(root, path.join(root, '.users', 'context', 'rules.md')), true);
  assert.equal(batch.queueChangedFile(root, path.join(root, '.users', 'context', 'en', 'rules.md')), false);
  assert.equal(batch.queueChangedFile(root, path.join(root, 'README.md')), false);
  assert.deepEqual(batch.readQueue(root), ['rules']);

  batch.writeQueue(root, ['zeta', 'rules', 'zeta']);
  assert.deepEqual(batch.readQueue(root), ['rules', 'zeta']);

  const originalSpawnSync = cp.spawnSync;
  let successfulCalls = 0;
  cp.spawnSync = () => {
    successfulCalls++;
    if (successfulCalls === 1) batch.queueChangedFile(root, path.join(root, '.users', 'context', 'queued-during-flush.md'));
    return { status: 0, stdout: '', stderr: '' };
  };
  assert.equal(batch.flush(root), 0);
  assert.equal(successfulCalls, 2);
  assert.deepEqual(batch.readQueue(root), []);

  batch.writeQueue(root, ['retry-me']);
  cp.spawnSync = () => {
    batch.queueChangedFile(root, path.join(root, '.users', 'context', 'also-new.md'));
    return { status: 1, stdout: '', stderr: '' };
  };
  assert.equal(batch.flush(root), 1);
  assert.deepEqual(batch.readQueue(root), ['also-new', 'retry-me']);
  cp.spawnSync = originalSpawnSync;

  batch.writeQueue(root, ['cli-retry']);
  const cli = cp.spawnSync(process.execPath, [path.resolve(__dirname, '..', 'context-translation-batch.cjs'), '--flush'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(cli.status, 0, 'a retryable translation failure must not fail the host Stop lifecycle');
  assert.match(cli.stderr, /context-translation.*deferred/);
  assert.deepEqual(batch.readQueue(root), ['cli-retry']);

  console.log('context translation batch tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
