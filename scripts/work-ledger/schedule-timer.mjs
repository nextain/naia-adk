#!/usr/bin/env node
// Turn approved regular-schedule rows into reviewable systemd user unit drafts.
// Writes files only into --out; never installs, enables or starts anything.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readScheduleLedger } from '../lib/ledger.mjs';

const DAYS = { MON: 'Mon', TUE: 'Tue', WED: 'Wed', THU: 'Thu', FRI: 'Fri', SAT: 'Sat', SUN: 'Sun' };
const quote = value => {
  if (/[\r\n]/.test(value)) throw new Error('Newlines are unsupported in unit arguments');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
};
export function onCalendar(row, timezone) {
  if (!/^[A-Za-z0-9_+\-/]+$/.test(timezone)) throw new Error('Invalid timezone');
  const weekly = /^weekly:(MON|TUE|WED|THU|FRI|SAT|SUN)$/.exec(row.cadence);
  if (row.cadence !== 'daily' && !weekly) throw new Error(`Unsupported cadence ${row.cadence}`);
  return `${weekly ? `${DAYS[weekly[1]]} ` : ''}*-*-* ${row.time}:00 ${timezone}`;
}
const unitBase = id => `adk-sched-${id}`;

/**
 * Pure. Only a 새로 timer row with an approval and a reviewed command mapping gets
 * a draft; every other row is reported as skipped with the reason.
 * commands maps mechanism.target to an argv array (reviewed instance configuration).
 */
export function draftUnits({ doc, scheduleFile, commands = {}, node = process.execPath, recorder }) {
  if (!isAbsolute(scheduleFile) || !isAbsolute(recorder)) throw new Error('Absolute paths required');
  const drafts = [], skipped = [];
  for (const row of doc.schedules) {
    if (row.status !== '새로') { skipped.push({ id: row.id, reason: `status ${row.status}` }); continue; }
    if (row.mechanism.kind !== 'timer') { skipped.push({ id: row.id, reason: `mechanism ${row.mechanism.kind}` }); continue; }
    if (!row.approval) { skipped.push({ id: row.id, reason: 'no approval' }); continue; }
    const argv = commands[row.mechanism.target];
    if (!Array.isArray(argv) || !argv.length || argv.some(a => typeof a !== 'string' || !a)) { skipped.push({ id: row.id, reason: 'no reviewed command mapping' }); continue; }
    if (!/^[A-Za-z0-9_-]+$/.test(row.id)) { skipped.push({ id: row.id, reason: 'id not unit-safe' }); continue; }
    const name = unitBase(row.id), calendar = onCalendar(row, doc.timezone);
    // ExecStopPost runs on success and failure; $SERVICE_RESULT is the outcome.
    const service = `[Unit]\nDescription=ADK regular schedule ${row.id} (${row.role})\n\n[Service]\nType=oneshot\nExecStart=${argv.map(quote).join(' ')}\nExecStopPost=${[node, recorder, scheduleFile, row.id, '$SERVICE_RESULT'].map((a, i) => i === 4 ? a : quote(a)).join(' ')}\n`;
    const timer = `[Unit]\nDescription=ADK regular schedule ${row.id} (${row.role})\n\n[Timer]\nOnCalendar=${calendar}\nPersistent=true\nAccuracySec=1min\n\n[Install]\nWantedBy=timers.target\n`;
    drafts.push({ id: row.id, name, calendar, files: { [`${name}.service`]: service, [`${name}.timer`]: timer } });
  }
  return { drafts, skipped };
}

export async function main(args = process.argv.slice(2)) {
  const opt = {};
  for (let i = 0; i < args.length; i += 2) { if (!args[i].startsWith('--') || args[i + 1] === undefined) throw new Error('Usage: schedule-timer.mjs --schedule FILE --commands JSON --out DIR'); opt[args[i].slice(2)] = args[i + 1]; }
  if (!opt.schedule || !opt.out) throw new Error('--schedule and --out required');
  const scheduleFile = resolve(opt.schedule);
  const doc = await readScheduleLedger(scheduleFile);
  const commands = opt.commands ? JSON.parse(await readFile(resolve(opt.commands), 'utf8')) : {};
  const recorder = resolve(new URL('../schedule-record.mjs', import.meta.url).pathname);
  const result = draftUnits({ doc, scheduleFile, commands, recorder });
  const out = resolve(opt.out);
  await mkdir(out, { recursive: true });
  for (const draft of result.drafts) for (const [file, text] of Object.entries(draft.files)) await writeFile(join(out, file), text, { flag: 'wx', mode: 0o644 });
  return { out, drafts: result.drafts.map(d => ({ id: d.id, calendar: d.calendar })), skipped: result.skipped };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().then(v => console.log(JSON.stringify(v))).catch(e => { console.error(`schedule-timer: ${e.message}`); process.exitCode = 1; });
