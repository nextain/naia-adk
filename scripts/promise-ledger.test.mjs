import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { containsPromise, checkPromise } from './promise-ledger.mjs';
import { addPromise, parseLedgerYaml } from './lib/ledger.mjs';

const now = Date.parse('2030-01-01T12:00:00Z');
const row = { id: 'one', role: 'a', task: 'Draft', status: '진행 중', requested_at: '2030-01-01T11:00:00Z', due_at: '2030-01-01T13:00:00Z', evidence: 'message-1', result: null, updated_at: '2030-01-01T11:00:00Z', source_channel: 'channel-a' };
const doc = () => ({ version: 1, work: [{ ...row }] });
async function fixture() { const dir = await mkdtemp(join(tmpdir(), 'promise-test-')); const file = join(dir, 'work.yaml'); await writeFile(file, 'version: 1\nwork: []\n'); return { dir, file }; }

test('recognizes common Korean and English promises and configurable expressions', () => {
  for (const text of ['15시 KST까지 올리겠습니다', '내일 아침까지 보내드리겠습니다', 'I will send it by 3pm', 'By tomorrow we will send it']) assert.equal(containsPromise(text), true, text);
  for (const text of ['오늘 회의가 있습니다', 'I will send it', 'The deadline is tomorrow']) assert.equal(containsPromise(text), false, text);
  assert.equal(containsPromise('custom commitment', ['custom commitment']), true);
  assert.throws(() => containsPromise('x', ['[']));
  assert.throws(() => containsPromise('x', ['x', '[']));
});
test('requires same-channel active row with strictly future due date', () => {
  const text = '오늘까지 하겠습니다';
  assert.equal(checkPromise(text, 'channel-a', doc(), { now }).allowed, true);
  assert.equal(checkPromise(text, 'channel-b', doc(), { now }).allowed, false);
  for (const status of ['대기', '막힘', '끝']) { const d = doc(); d.work[0].status = status; if (status === '끝') d.work[0].result = 'result'; assert.equal(checkPromise(text, 'channel-a', d, { now }).allowed, false); }
  for (const due of [null, '2030-01-01T12:00:00Z', '2030-01-01T11:59:59Z']) { const d = doc(); d.work[0].due_at = due; assert.equal(checkPromise(text, 'channel-a', d, { now }).allowed, false); }
  assert.equal(checkPromise('No promise', 'channel-a', doc(), { now }).allowed, true);
  assert.throws(() => checkPromise(text, 'channel-a', {}, { now }));
});
test('add persists a validated work row and prevents duplicate, past due and symlink writes', async () => {
  const f = await fixture(), options = { id: 'promise-1', role: 'a', title: 'Send draft', due: '2030-01-01T13:00:00Z', channel: 'channel-a', message: 'message-1', now };
  await addPromise(f.file, options);
  const ledger = parseLedgerYaml(await readFile(f.file, 'utf8'));
  assert.equal(checkPromise('오늘까지 하겠습니다', 'channel-a', ledger, { now }).allowed, true);
  assert.equal(ledger.work[0].evidence, 'message-1');
  const before = await readFile(f.file, 'utf8');
  await assert.rejects(addPromise(f.file, options), /duplicate/);
  await assert.rejects(addPromise(f.file, { ...options, id: 'two', due: '2030-01-01T12:00:00Z' }), /future/);
  const link = join(f.dir, 'link'); await symlink(f.file, link);
  await assert.rejects(addPromise(link, { ...options, id: 'two' }), /symlinks/);
  assert.equal(await readFile(f.file, 'utf8'), before);
});
test('CLI denies with exit 2 and fails closed for unreadable or corrupt ledger', async () => {
  const f = await fixture(), text = join(f.dir, 'text'); await writeFile(text, 'I will send it by tomorrow');
  const run = file => spawnSync(process.execPath, ['scripts/promise-ledger.mjs', 'check', '--ledger', file, '--channel', 'test', '--text-file', text], { encoding: 'utf8' });
  assert.equal(run(f.file).status, 2);
  assert.equal(run(join(f.dir, 'missing')).status, 1);
  await writeFile(f.file, '{bad'); assert.equal(run(f.file).status, 1);
});
test('CLI add and check share the actual work ledger', async () => {
  const f = await fixture(), text = join(f.dir, 'text'); await writeFile(text, 'I will send it by tomorrow');
  const due = new Date(Date.now() + 3600000).toISOString();
  const add = spawnSync(process.execPath, ['scripts/promise-ledger.mjs', 'add', '--ledger', f.file, '--channel', 'test', '--role', 'a', '--title', 'Send', '--due', due, '--message', 'source'], { encoding: 'utf8' });
  assert.equal(add.status, 0, add.stderr);
  const check = spawnSync(process.execPath, ['scripts/promise-ledger.mjs', 'check', '--ledger', f.file, '--channel', 'test', '--text-file', text], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr); assert.equal(JSON.parse(check.stdout).allowed, true);
});
