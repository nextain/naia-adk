import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { enableDueTimer } from './enable-due-timer.mjs';

export async function approveFixture(root, config, configPath = path.join(root, 'config/work-ledger.json')) {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config));
  const watchPath = path.join(root, 'fixture-watch.mjs');
  const evidencePath = path.join(root, 'fixture-evidence.json');
  const watcher = 'test watcher';
  const digest = createHash('sha256').update(watcher).digest('hex');
  await writeFile(watchPath, watcher);
  await writeFile(evidencePath, JSON.stringify({ work_watch_path: watchPath, work_watch_sha256: digest, running_code_verified: true, no_extra_completion_wake_verified: true }));
  await enableDueTimer({ configPath, watchPath, evidencePath, expectedWatchSha256: digest });
}
