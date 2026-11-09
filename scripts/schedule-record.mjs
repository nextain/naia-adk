#!/usr/bin/env node
import { isMain } from './lib/is-main.mjs';
import { randomUUID } from 'node:crypto';
import { recordSchedule } from './lib/ledger.mjs';
export { recordSchedule } from './lib/ledger.mjs';
if (isMain(import.meta.url)) {
  const trace = randomUUID(), started = Date.now();
  const emit = event => console.log(JSON.stringify({ trace, ...event }));
  emit({ stage: 'start' });
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3) throw Error('usage');
    await recordSchedule(...args);
    emit({ stage: 'end', result: 'recorded', durationMs: Date.now() - started });
  } catch { console.error(JSON.stringify({ trace, stage: 'end', result: 'failed', durationMs: Date.now() - started })); process.exitCode = 1; }
}
