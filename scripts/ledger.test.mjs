import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseLedgerYaml, serializeLedgerYaml, readWorkLedger, readScheduleLedger, scheduleStatus, recordSchedule, validateWorkLedger, validateScheduleLedger } from './lib/ledger.mjs';
const root = process.env.LEDGER_TEST_TMP || process.env.SESSION_HEALTH_TEST_TMP || join((await import('node:os')).tmpdir(), 'ledger-test');
const now = Date.parse('2030-01-01T12:00:00Z');
const work = () => ({ version: 1, work: [{ id: 'task-a', role: 'role-a', task: 'Review draft', status: '진행 중', requested_at: '2030-01-01T09:00:00Z', due_at: '2030-01-02T09:00:00Z', evidence: 'https://example.invalid/request/1', result: null, updated_at: '2030-01-01T10:00:00Z' }] });
const schedule = () => ({ version: 1, timezone: 'UTC', schedules: [{ id: 'daily-a', role: 'role-a', task: 'Review draft', cadence: 'daily', time: '11:45', status: '있음', mechanism: { kind: 'timer', target: '<target>', timer: null }, approval: null, last_result: { at: null, outcome: 'not-run', evidence: '<artifact>' } }] });
async function fixture(doc = schedule()) { await mkdir(root, { recursive: true }); const dir = await mkdtemp(join(root, 'ledger-')); const path = join(dir, 'ledger.yaml'); await writeFile(path, serializeLedgerYaml(doc)); return { dir, path }; }
test('block parser round trips examples, quotes and unknown fields', async () => {
  const doc = schedule(); doc.schedules[0].task = 'A: "quoted" # task'; doc.schedules[0].extra = { note: 'keep' };
  assert.deepEqual(parseLedgerYaml(serializeLedgerYaml(doc)), doc);
  const existing = parseLedgerYaml(await readFile(new URL('../config/regular-schedule.example.yaml', import.meta.url), 'utf8'));
  assert.equal(validateScheduleLedger(existing, now).schedules.length, 5);
  assert.deepEqual(existing.schedules.filter(r => r.id.includes('security')).map(r => [r.id, r.cadence, r.status]), [["weekly-security-review", "weekly:MON", "제안"], ["daily-security-advisory", "daily", "제안"]]);
  assert.equal(parseLedgerYaml("version: 1\nvalue: 'it''s fine'\n").value, "it's fine");
});
test('parser rejects duplicates, indentation and advanced YAML', () => {
  for (const text of ['version: 1\nversion: 2', '__proto__: bad', '{"__proto__":{}}', 'version: 1\n work: x', 'version: &a 1', 'work: [1,2]', 'work: |\n  text', 'work:\n\t- id: a', 'work:\n    id: a']) assert.throws(() => parseLedgerYaml(text));
});
test('work read validates role fields and completion', async () => {
  const doc = work(), f = await fixture(doc); assert.deepEqual(await readWorkLedger(f.path, now), doc.work);
  for (const mutate of [d => d.work.push({ ...d.work[0] }), d => d.work[0].status = 'done', d => delete d.work[0].evidence, d => d.work[0].updated_at = '2030-01-02T00:00:00Z', d => d.work[0].requested_at = '2030-01-01 09:00:00', d => d.work[0].status = '끝', d => d.work[0].updated_at = '2030-02-30T00:00:00Z']) { const d = work(); mutate(d); assert.throws(() => validateWorkLedger(d, now)); }
  doc.work[0].status = '끝'; doc.work[0].result = 'https://example.invalid/result/1'; assert.equal(validateWorkLedger(doc, now)[0].status, '끝');
});
test('schedule grace boundary and actual execution including failure', () => {
  const doc = schedule(); assert.equal(scheduleStatus(doc, 'role-a', now)[0].status, 'pending');
  const late = now + 1; assert.equal(scheduleStatus(doc, 'role-a', late)[0].status, 'missed');
  doc.schedules[0].last_result = { at: '2030-01-01T11:44:59Z', outcome: 'success', evidence: null }; assert.equal(scheduleStatus(doc, 'role-a', late)[0].status, 'missed');
  doc.schedules[0].last_result.at = '2030-01-01T11:45:00Z'; assert.equal(scheduleStatus(doc, 'role-a', late)[0].status, 'recorded');
  doc.schedules[0].last_result.outcome = 'failed'; assert.equal(scheduleStatus(doc, 'role-a', late)[0].status, 'recorded');
  doc.schedules[0].last_result.outcome = 'not-run'; assert.equal(scheduleStatus(doc, 'role-a', late)[0].status, 'missed');
});
test('roles, inactive rows, weekly timezone and changing occurrence', () => {
  const doc = schedule(); assert.deepEqual(scheduleStatus(doc, 'other', now), []);
  for (const status of ['제안', '사람', '새로', '부분']) { doc.schedules[0].status = status; assert.deepEqual(scheduleStatus(doc, 'role-a', now), []); }
  doc.schedules[0].status = '제안'; doc.schedules[0].cadence = 'monthly'; assert.deepEqual(scheduleStatus(doc, 'role-a', now), []);
  doc.schedules[0].time = '25:00'; assert.throws(() => scheduleStatus(doc, 'role-a', now)); doc.schedules[0].time = '11:45';
  doc.schedules[0].status = '있음'; doc.timezone = 'Asia/Tokyo'; doc.schedules[0].time = '20:00'; doc.schedules[0].cadence = 'weekly:TUE';
  const row = scheduleStatus(doc, 'role-a', now)[0]; assert.equal(row.dueAt, Date.parse('2030-01-01T11:00:00Z')); assert.equal(row.status, 'missed');
  const next = scheduleStatus(doc, 'role-a', now + 7 * 86400000)[0]; assert.notEqual(row.occurrence, next.occurrence);
});
test('DST repeated hour uses latest passed occurrence, missing hour searches earlier day', () => {
  const doc = schedule(); doc.timezone = 'America/New_York'; doc.schedules[0].time = '01:30';
  assert.equal(scheduleStatus(doc, 'role-a', Date.parse('2030-11-03T07:00:00Z'))[0].dueAt, Date.parse('2030-11-03T06:30:00Z'));
  doc.schedules[0].time = '02:30'; assert.equal(scheduleStatus(doc, 'role-a', Date.parse('2030-03-10T08:00:00Z'))[0].dueAt, Date.parse('2030-03-09T07:30:00Z'));
  doc.schedules[0].cadence = 'weekly:SUN'; assert.equal(scheduleStatus(doc, 'role-a', Date.parse('2030-03-16T08:00:00Z'))[0].dueAt, Date.parse('2030-03-03T07:30:00Z'));
});
test('schedule invalid timezone, cadence, duplicates, future result and grace fail closed', () => {
  for (const mutate of [d => d.timezone = 'Invalid/Zone', d => d.schedules[0].cadence = 'monthly', d => d.schedules.push({ ...d.schedules[0] }), d => d.schedules[0].last_result.at = '2030-01-02T00:00:00Z', d => d.schedules[0].graceMinutes = -1, d => d.schedules[0].time = '25:00']) { const doc = schedule(); mutate(doc); assert.throws(() => validateScheduleLedger(doc, now)); }
});
test('record exact row preserves other rows, evidence and extension data', async () => {
  const doc = schedule(); doc.schedules.push({ ...structuredClone(doc.schedules[0]), id: 'other' }); doc.extra = 'preserve'; doc.empty = []; doc.metadata = {};
  const f = await fixture(doc); await recordSchedule(f.path, 'daily-a', 'failed', { now });
  const result = await readScheduleLedger(f.path, now); assert.equal(result.extra, 'preserve'); assert.deepEqual(result.schedules[1], doc.schedules[1]); assert.deepEqual(result.schedules[0].last_result, { at: new Date(now).toISOString(), outcome: 'failed', evidence: '<artifact>' });
});
test('unknown id, not-run, concurrent lock and symlink preserve originals', async () => {
  const f = await fixture(), before = await readFile(f.path, 'utf8');
  await assert.rejects(recordSchedule(f.path, 'unknown', 'success', { now })); await assert.rejects(recordSchedule(f.path, 'daily-a', 'not-run', { now }));
  await writeFile(`${f.path}.lock`, 'locked'); await assert.rejects(recordSchedule(f.path, 'daily-a', 'success', { now }), /EEXIST/);
  const link = join(f.dir, 'link.yaml'); await symlink(f.path, link); await assert.rejects(recordSchedule(link, 'daily-a', 'success', { now }), /symlink/);
  assert.equal(await readFile(f.path, 'utf8'), before);
});
test('CLI records valid execution and hides error details', async () => {
  const f = await fixture(); const cli = new URL('./schedule-record.mjs', import.meta.url);
  assert.match(execFileSync(process.execPath, [cli.pathname, f.path, 'daily-a', 'success'], { encoding: 'utf8' }), /recorded/);
  try { execFileSync(process.execPath, [cli.pathname, '/private/path/secret', 'daily-a', 'success'], { encoding: 'utf8', stdio: 'pipe' }); assert.fail('must fail'); } catch (error) { assert.match(String(error.stderr), /failed/); assert.ok(!String(error.stderr).includes('/private/path')); }
});
