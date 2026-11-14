import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processStart } from './work-ledger-drive.mjs';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('./work-ledger-drive.mjs', import.meta.url));
const PAST = '2020-01-01T00:00:00Z', FUTURE = '2999-01-01T00:00:00Z';
const OWNER = '111', OTHER = '222';

// Stand-in for the headless worker: records its arguments and stdin, stays alive
// for --sleep seconds, and writes the result file only with --write-result.
const FAKE_WORKER = `
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2), opt = name => args.find(a => a.startsWith(name + '='))?.split('=')[1];
const dir = opt('--calls'); mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, process.pid + '.json'), JSON.stringify({ args, stdin: readFileSync(0, 'utf8'), item: process.env.LEDGER_ITEM_ID, token: process.env.TEST_TOKEN ?? null }));
setTimeout(() => { if (args.includes('--write-result')) writeFileSync(process.env.LEDGER_RESULT_FILE, 'result'); }, Number(opt('--sleep') ?? 0) * 1000);
`;

async function fixture({ worker = [], config = {} } = {}) {
  const root = await mkdtemp(path.join(process.env.LEDGER_DRIVE_TEST_TMP || tmpdir(), 'ledger-drive-'));
  const calls = path.join(root, 'calls'), wake = path.join(root, 'wake');
  await writeFile(path.join(root, 'fake-worker.mjs'), FAKE_WORKER);
  await writeFile(path.join(root, 'task.md'), 'Do the assigned work.\n');
  const cfg = {
    version: 1, roles: [{ role: 'lead' }],
    worker: { command: [process.execPath, path.join(root, 'fake-worker.mjs'), '-p', '--model', '{model}', `--calls=${calls}`, ...worker], retry_min: 0, max_parallel: 5, ...config.worker },
    disk: { path: root, min_free_gb: 0, ...config.disk },
    notify: { wake_dir: wake, repeat_min: 60 },
    owner_confirm: { provider: 'discord', token_env: 'TEST_TOKEN', owner_ids: [OWNER], api_base: config.apiBase ?? 'http://127.0.0.1:9' },
  };
  await writeFile(path.join(root, 'drive.json'), JSON.stringify(cfg));
  const cli = async (...args) => {
    try { return { code: 0, out: (await run(process.execPath, [CLI, ...args, '--root', root, '--config', 'drive.json'], { env: { ...process.env, TEST_TOKEN: 'placeholder' } })).stdout.trim() }; }
    catch (error) { return { code: error.code, out: `${error.stdout}${error.stderr}`.trim() }; }
  };
  const add = (id, due, extra = []) => cli('add', '--id', id, '--title', `Task ${id}`, '--due', due, '--channel', '1', '--msg-id', '2',
    '--prompt', 'task.md', '--result-file', `out/${id}.md`, '--model', 'model-a', ...extra);
  const ledgerFile = path.join(root, '.agents/work/ledger/lead.json');
  const ledger = async () => JSON.parse(await readFile(ledgerFile, 'utf8'));
  const item = async id => (await ledger()).items.find(i => i.id === id);
  const edit = async change => { const l = await ledger(); change(l); await writeFile(ledgerFile, JSON.stringify(l)); };
  const list = async dir => readdir(dir).catch(() => []);
  const callsFor = async id => (await Promise.all((await list(calls)).map(async f => JSON.parse(await readFile(path.join(calls, f), 'utf8'))))).filter(c => c.item === id);
  const wakes = async reason => (await list(wake)).filter(f => f.includes(`-ledger-drive-${reason}-`));
  const tick = async () => { const r = await cli('tick'); assert.equal(r.code, 0, r.out); return JSON.parse(r.out); };
  return { root, cli, add, ledger, item, edit, callsFor, wakes, tick };
}
async function until(check, label) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 100)); }
  assert.fail(`timed out: ${label}`);
}
const exited = (f, id) => until(async () => processStart((await f.item(id)).run.pid) === null, 'worker exit');

test('registration without a usable instruction file is refused', async () => {
  const f = await fixture();
  const base = ['add', '--id', 'a1', '--title', 'T', '--due', FUTURE, '--channel', '1', '--msg-id', '2', '--result-file', 'out/a1.md', '--model', 'model-a'];
  const none = await f.cli(...base);
  assert.equal(none.code, 1); assert.match(none.out, /instruction file is required/);
  const missing = await f.cli(...base, '--prompt', 'absent.md');
  assert.equal(missing.code, 1); assert.match(missing.out, /registration refused: instruction file does not exist/);
  await writeFile(path.join(f.root, 'blank.md'), ' \n');
  const blank = await f.cli(...base, '--prompt', 'blank.md');
  assert.equal(blank.code, 1); assert.match(blank.out, /instruction file is empty/);
  const noResult = await f.cli('add', '--id', 'a1', '--title', 'T', '--due', FUTURE, '--channel', '1', '--msg-id', '2', '--prompt', 'task.md', '--model', 'model-a');
  assert.equal(noResult.code, 1); assert.match(noResult.out, /result file is required/);
  const noModel = await f.cli(...base.slice(0, -2), '--prompt', 'task.md');
  assert.equal(noModel.code, 1); assert.match(noModel.out, /model is required/);
  await assert.rejects(f.ledger(), { code: 'ENOENT' });
  assert.equal((await f.add('a1', FUTURE)).code, 0);
  assert.equal((await f.ledger()).items.length, 1);
});

test('an overdue item starts a worker from its instruction file; the lead is only notified', async () => {
  const f = await fixture();
  await f.add('late', PAST); await f.add('later', FUTURE);
  const out = await f.tick();
  assert.deepEqual(out.launched.map(l => l.id), ['late']);
  await until(async () => (await f.callsFor('late')).length === 1, 'worker call');
  const [call] = await f.callsFor('late');
  assert.deepEqual(call.args.slice(0, 3), ['-p', '--model', 'model-a']);
  assert.match(call.stdin, /Do the assigned work\./);
  assert.ok(call.stdin.includes(path.join(f.root, 'out/late.md')));
  assert.equal(call.token, null);
  assert.equal((await f.callsFor('later')).length, 0);
  assert.equal((await f.wakes('launched')).length, 1);
  const item = await f.item('late');
  assert.equal(item.status, 'open'); assert.equal(item.run.attempts, 1);
});

test('a running worker is not started twice; a dead one without a result is retried up to the limit', async () => {
  const f = await fixture({ worker: ['--sleep=2'], config: { worker: { max_attempts: 2 } } });
  await f.add('w1', PAST);
  await f.tick();
  assert.deepEqual((await f.tick()).launched, []);
  assert.deepEqual((await f.tick()).launched, []);
  await exited(f, 'w1');
  assert.equal((await f.callsFor('w1')).length, 1);
  assert.equal((await f.tick()).launched[0].attempt, 2);
  await exited(f, 'w1');
  const last = await f.tick();
  assert.deepEqual(last.launched, []);
  assert.deepEqual(last.alerts.map(a => a.reason), ['attempts-exhausted']);
  assert.equal((await f.callsFor('w1')).length, 2);
});

test('the parallel limit queues the rest and a present result stops further starts', async () => {
  const f = await fixture({ worker: ['--sleep=1', '--write-result'], config: { worker: { max_parallel: 1 } } });
  await f.add('p1', PAST); await f.add('p2', '2021-01-01T00:00:00Z');
  const first = await f.tick();
  assert.deepEqual(first.launched.map(l => l.id), ['p1']);
  assert.deepEqual(first.alerts.map(a => `${a.id}:${a.reason}`), ['p1:launched', 'p2:queued']);
  await exited(f, 'p1');
  const second = await f.tick();
  assert.deepEqual(second.launched.map(l => l.id), ['p2']);
  assert.ok(second.alerts.some(a => a.id === 'p1' && a.reason === 'result-ready'));
  assert.equal((await f.item('p1')).status, 'open');
  assert.equal((await f.callsFor('p1')).length, 1);
});

test('drop is refused, and an item marked dropped without a record is reopened and driven', async () => {
  const f = await fixture();
  await f.add('d1', PAST);
  const drop = await f.cli('drop', 'd1', '--reason', 'moved');
  assert.equal(drop.code, 1); assert.match(drop.out, /drop is not available/);
  assert.equal((await f.item('d1')).status, 'open');
  await f.edit(l => { l.items[0].status = 'dropped'; l.items[0].note = 'moved to a new row'; });
  const out = await f.tick();
  assert.deepEqual(out.launched.map(l => l.id), ['d1']);
  assert.ok(out.alerts.some(a => a.reason === 'reopened'));
  assert.equal((await f.item('d1')).status, 'open');
  await f.edit(l => { l.items[0].status = 'done'; l.items[0].closed = { by: 'owner' }; });
  assert.ok((await f.tick()).alerts.some(a => a.reason === 'reopened'));
});

test('done needs a real result address', async () => {
  const f = await fixture();
  await f.add('r1', FUTURE); await f.add('r2', FUTURE);
  const bare = await f.cli('done', 'r1');
  assert.equal(bare.code, 1); assert.match(bare.out, /done requires --result/);
  const absent = await f.cli('done', 'r1', '--result', 'out/r1.md');
  assert.equal(absent.code, 1); assert.match(absent.out, /result file is missing or empty/);
  await mkdir(path.join(f.root, 'out')); await writeFile(path.join(f.root, 'out/r1.md'), 'finished');
  assert.equal((await f.cli('done', 'r1', '--result', 'out/r1.md')).code, 0);
  const item = await f.item('r1');
  assert.equal(item.status, 'done'); assert.equal(item.closed.result, path.join(f.root, 'out/r1.md'));
  assert.equal((await f.cli('done', 'r2', '--result', 'https://example.invalid/result/2')).code, 0);
  assert.deepEqual((await f.tick()).alerts, []);
});

test('an owner confirmation message closes an item; anything else does not', async t => {
  const messages = {
    10: { id: '10', author: { id: OTHER }, content: 'close c1c1c1c1 please' },
    11: { id: '11', author: { id: OWNER }, content: 'stop that one' },
    12: { id: '12', author: { id: OWNER }, content: 'stop c1c1c1c1' },
    13: { id: '13', author: { id: OWNER }, content: 'yes, stop it', message_reference: { message_id: '14' } },
    14: { id: '14', author: { id: OTHER }, content: 'May I close c2c2c2c2?' },
  };
  const server = createServer((req, res) => {
    const message = messages[req.url.split('/').pop()];
    res.writeHead(message && req.headers.authorization === 'Bot placeholder' ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(message ?? {}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const f = await fixture({ config: { apiBase: `http://127.0.0.1:${server.address().port}` } });
  await f.add('c1c1c1c1-x', PAST); await f.add('c2c2c2c2-x', PAST);
  for (const [msg, pattern] of [['10', /not written by a configured owner/], ['11', /does not name item c1c1c1c1/], ['99', /message lookup failed/]]) {
    const r = await f.cli('confirm', 'c1c1c1c1-x', '--channel', '5', '--msg-id', msg);
    assert.equal(r.code, 1); assert.match(r.out, pattern);
  }
  assert.equal((await f.item('c1c1c1c1-x')).status, 'open');
  assert.equal((await f.cli('confirm', 'c1c1c1c1-x', '--channel', '5', '--msg-id', '12')).code, 0);
  assert.equal((await f.cli('confirm', 'c2c2c2c2-x', '--channel', '5', '--msg-id', '13', '--as', 'done')).code, 0);
  const closed = await f.item('c1c1c1c1-x');
  assert.equal(closed.status, 'dropped'); assert.deepEqual([closed.closed.by, closed.closed.author, closed.closed.msg_id], ['owner', OWNER, '12']);
  assert.equal((await f.item('c2c2c2c2-x')).status, 'done');
  const out = await f.tick();
  assert.deepEqual([out.launched, out.alerts], [[], []]);
});

test('low free space starts nothing and notifies', async () => {
  const f = await fixture({ config: { disk: { min_free_gb: 1e9 } } });
  await f.add('s1', PAST);
  const out = await f.tick();
  assert.deepEqual(out.launched, []);
  assert.deepEqual(out.alerts.map(a => a.reason), ['disk-low']);
  assert.equal((await f.callsFor('s1')).length, 0);
  assert.equal((await f.item('s1')).run, null);
  assert.equal((await f.wakes('disk-low')).length, 1);
  assert.deepEqual((await f.tick()).alerts, []);
  const start = await f.cli('start', 's1');
  assert.equal(start.code, 1); assert.match(start.out, /free space/);
});

test('an existing row without an instruction is reported, then driven once adopted', async () => {
  const f = await fixture();
  await f.add('seed', FUTURE);
  await f.edit(l => l.items.push({ id: 'old1', title: 'Old row', from: { channel: '1', msg_id: '2', quote: '' }, due: PAST, status: 'open', worker: null, checked_at: null, note: '' },
    { id: 'old2', title: 'Old closed row', from: { channel: '1', msg_id: '2', quote: '' }, due: PAST, status: 'dropped', worker: null, checked_at: null, note: 'before drive' }));
  const out = await f.tick();
  assert.deepEqual([out.launched, out.alerts.map(a => `${a.id}:${a.reason}`)], [[], ['old1:no-instruction']]);
  assert.equal((await f.cli('adopt', 'old1', '--result-file', 'out/old1.md', '--model', 'model-a')).code, 1);
  assert.equal((await f.cli('adopt', 'old1', '--prompt', 'task.md', '--result-file', 'out/old1.md', '--model', 'model-a')).code, 0);
  assert.deepEqual((await f.tick()).launched.map(l => l.id), ['old1']);
  assert.equal((await f.item('old2')).status, 'dropped');
});

test('start and attach register a worker before the deadline so the tick does not add another', async () => {
  const f = await fixture({ worker: ['--sleep=2'] });
  await f.add('m1', FUTURE); await f.add('m2', PAST);
  assert.match((await f.cli('start', 'm1')).out, /worker pid \d+ \(attempt 1\)/);
  const again = await f.cli('start', 'm1');
  assert.equal(again.code, 1); assert.match(again.out, /worker already running/);
  assert.equal((await f.cli('attach', 'm2', '--pid', String(process.pid))).code, 0);
  assert.deepEqual((await f.tick()).launched, []);
  assert.equal((await f.cli('attach', 'm2', '--pid', '0')).code, 1);
});
