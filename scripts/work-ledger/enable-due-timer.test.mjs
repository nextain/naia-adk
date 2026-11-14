import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { enableDueTimer, main } from './enable-due-timer.mjs';

test('W4 enable fails closed without matching watcher and deployment evidence', async t => {
  const dir = await mkdtemp(path.resolve('tmp/w4-gate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'config.json');
  const watchPath = path.join(dir, 'work-watch.mjs');
  const evidencePath = path.join(dir, 'evidence.json');
  const initial = '{"roles":[],"due_timer":{"enabled":false,"horizon_hours":24}}';
  const watcher = 'fixed watcher fixture';
  const expectedWatchSha256 = createHash('sha256').update(watcher).digest('hex');
  await writeFile(configPath, initial);
  await writeFile(watchPath, watcher);
  const evidence = { work_watch_path: await realpath(watchPath), work_watch_sha256: expectedWatchSha256, running_code_verified: true, no_extra_completion_wake_verified: true };
  await writeFile(evidencePath, JSON.stringify(evidence));
  await assert.rejects(main(['--config', configPath, '--work-watch', watchPath, '--evidence', evidencePath]), /approved/);
  assert.equal(await readFile(configPath, 'utf8'), initial);
  const opts = { configPath, watchPath, evidencePath, expectedWatchSha256 };
  for (const altered of [
    { running_code_verified: false },
    { no_extra_completion_wake_verified: false },
    { work_watch_sha256: 'wrong' },
    { work_watch_path: '/other/work-watch.mjs' }
  ]) {
    await writeFile(evidencePath, JSON.stringify({ ...evidence, ...altered }));
    await assert.rejects(enableDueTimer(opts), /evidence/);
    assert.equal(await readFile(configPath, 'utf8'), initial);
  }
  await writeFile(evidencePath, JSON.stringify(evidence));
  await enableDueTimer(opts);
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), { roles: [], due_timer: { enabled: true, horizon_hours: 24 } });
});
