import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftUnits, onCalendar, main } from './schedule-timer.mjs';

const row = (o = {}) => ({ id: 'a-1', role: 'r', task: 't', cadence: 'daily', time: '22:00', status: '새로', mechanism: { kind: 'timer', target: 'x', timer: null }, approval: 'ok', last_result: { at: null, outcome: 'not-run', evidence: null }, ...o });
const args = (rows, commands = { x: ['/bin/true', '--a b'] }) => ({ doc: { version: 1, timezone: 'UTC', schedules: rows }, scheduleFile: '/s.yaml', commands, recorder: '/rec.mjs', node: '/node' });

test('calendar strings for daily and weekly', () => {
  assert.equal(onCalendar(row(), 'UTC'), '*-*-* 22:00:00 UTC');
  assert.equal(onCalendar(row({ cadence: 'weekly:MON', time: '18:30' }), 'Asia/Seoul'), 'Mon *-*-* 18:30:00 Asia/Seoul');
  assert.throws(() => onCalendar(row({ cadence: 'monthly' }), 'UTC'));
});
test('only approved 새로 timer rows with a mapping get drafts', () => {
  const r = draftUnits(args([row(), row({ id: 'b', status: '제안' }), row({ id: 'c', approval: null }), row({ id: 'd', mechanism: { kind: 'wake', target: 'x' } }), row({ id: 'e', mechanism: { kind: 'timer', target: 'nope' } }), row({ id: 'f', status: '있음' })]));
  assert.deepEqual(r.drafts.map(d => d.id), ['a-1']);
  assert.equal(r.skipped.length, 5);
  const t = r.drafts[0].files['adk-sched-a-1.timer'], s = r.drafts[0].files['adk-sched-a-1.service'];
  assert.match(t, /OnCalendar=\*-\*-\* 22:00:00 UTC\nPersistent=true/);
  assert.match(s, /ExecStart="\/bin\/true" "--a b"/);
  assert.match(s, /ExecStopPost="\/node" "\/rec.mjs" "\/s.yaml" "a-1" \$SERVICE_RESULT/);
});
test('writes drafts to --out only, refuses overwrite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sched-timer-'));
  const yaml = `version: 1\ntimezone: UTC\nschedules:\n  - id: s1\n    role: r\n    task: t\n    cadence: daily\n    time: "22:00"\n    status: 새로\n    mechanism:\n      kind: timer\n      target: x\n      timer: null\n    approval: ok\n    last_result:\n      at: null\n      outcome: not-run\n      evidence: null\n`;
  await writeFile(join(dir, 's.yaml'), yaml);
  await writeFile(join(dir, 'c.json'), JSON.stringify({ x: ['/bin/true'] }));
  const out = join(dir, 'out');
  const res = await main(['--schedule', join(dir, 's.yaml'), '--commands', join(dir, 'c.json'), '--out', out]);
  assert.equal(res.drafts.length, 1);
  assert.deepEqual((await readdir(out)).sort(), ['adk-sched-s1.service', 'adk-sched-s1.timer']);
  assert.match(await readFile(join(out, 'adk-sched-s1.timer'), 'utf8'), /Persistent=true/);
  await assert.rejects(main(['--schedule', join(dir, 's.yaml'), '--commands', join(dir, 'c.json'), '--out', out]));
});
