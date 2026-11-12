#!/usr/bin/env node
// W4 requires an operator's evidence for the actual work-watch deployment.
import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// alpha-wwtimer 2c3b31fcb: reverse Triggers and preserved TriggeredBy.
const approvedWatchSha256 = '9cc728738e21a4b9ea193f85a8e27eb1713a8d317248bb2ef2423b84532a751a';

export async function enableDueTimer({ configPath, watchPath, evidencePath, expectedWatchSha256 = approvedWatchSha256 }) {
  if (!configPath || !watchPath || !evidencePath) throw new Error('Required: --config, --work-watch, --evidence');
  const actualWatch = await realpath(watchPath);
  const watchHash = createHash('sha256').update(await readFile(actualWatch)).digest('hex');
  if (watchHash !== expectedWatchSha256) throw new Error('work-watch does not match the approved timer-service exclusion');
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  if (evidence.work_watch_path !== actualWatch || evidence.work_watch_sha256 !== watchHash ||
      evidence.running_code_verified !== true || evidence.no_extra_completion_wake_verified !== true) {
    throw new Error('Missing evidence for the running work-watch and no-extra-wake check');
  }
  const configFile = await realpath(configPath);
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      (config.due_timer !== undefined && (!config.due_timer || typeof config.due_timer !== 'object' || Array.isArray(config.due_timer)))) {
    throw new Error('Invalid due_timer configuration');
  }
  config.due_timer = { ...config.due_timer, enabled: true };
  const mode = (await stat(configFile)).mode & 0o777;
  const temp = `${configFile}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode });
    await rename(temp, configFile);
  } catch (error) {
    if (error.code !== 'EEXIST') await unlink(temp).catch(() => {});
    throw error;
  }
  return configFile;
}

export async function main(args = process.argv.slice(2)) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--config', '--work-watch', '--evidence'].includes(args[i]) || !args[i + 1] || values[args[i]]) throw new Error('Usage: enable-due-timer.mjs --config FILE --work-watch FILE --evidence FILE');
    values[args[i]] = args[i + 1];
  }
  return enableDueTimer({ configPath: values['--config'], watchPath: values['--work-watch'], evidencePath: values['--evidence'] });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(file => console.log(`Due timer enabled: ${file}`)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
