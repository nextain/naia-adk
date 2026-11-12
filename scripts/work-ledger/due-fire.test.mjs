import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { main, changeLedger, withLock } from './ledger.mjs';
import { watch } from './ledger-watch.mjs';
import { dueWake, fire, receiptPath, cleanReceipts } from './due-timer.mjs';

const due = '2026-11-12T12:00:00Z';
const now = Date.parse(due) + 180000;
const config = { roles: [{ role: 'a', channels: [] }], due_timer: { enabled: true } };
async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'due-fire-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await main(['add', '--root', root, '--role', 'a', '--id', 'job', '--title', '일', '--due', due, '--channel', 'c', '--msg-id', 'm']);
  return root;
}
const wakes = root => readdir(path.join(root, '.agents/work/l4/wake')).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
const runFire = (root, options = {}) => fire({ root, role: 'a', id: 'job', due, now, config, ...options });
const unavailable = async () => { throw Error('fake systemd unavailable'); };
const runWatch = (root, time = now) => watch({ root, config, now: time, runner: unavailable });

test('fire rechecks closed and changed items and keys receipts by due', async t => {
  const root = await setup(t);
  assert.equal(await runFire(root, { now: Date.parse(due) - 5001 }), false);
  await changeLedger(root, 'a', l => { l.items[0].status = 'done'; });
  assert.equal(await runFire(root), false);
  await changeLedger(root, 'a', l => { l.items[0].status = 'open'; l.items[0].due = '2026-11-12T12:01:00Z'; });
  assert.equal(await runFire(root), false);
  assert.equal(await runFire(root, { due: '2026-11-12T12:01:00Z' }), true);
  await changeLedger(root, 'a', l => { l.items[0].due = due; });
  assert.equal(await runFire(root), true);
  assert.equal((await wakes(root)).length, 2);
});

test('fire deduplicates and writes the normal wake format with delay and permissions', async t => {
  const root = await setup(t);
  assert.equal(await runFire(root), true);
  assert.equal(await runFire(root), false);
  const [name] = await wakes(root);
  const file = path.join(root, '.agents/work/l4/wake', name);
  assert.match(name, /-ledger-job-route-a\.md$/);
  assert.match(await readFile(file, 'utf8'), /^\[장부\] 정한 시각: 일\n출처: c\/m\n기한: .*\n결과: \(없음\)\n늦음 3분/m);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(receiptPath(root, 'a', 'job', due))).status, 'sent');
});

test('both concurrent fire and watch orders produce one initial wake and preserve 30 minute repeat', async t => {
  for (const first of ['timer', 'watch']) {
    const root = await setup(t);
    if (first === 'timer') {
      assert.equal(await runFire(root), true);
      assert.equal((await runWatch(root)).wakes.length, 0);
    } else {
      assert.equal((await runWatch(root)).wakes.length, 1);
      assert.equal(await runFire(root), false);
    }
    assert.equal((await runWatch(root, now + 29 * 60000)).wakes.length, 0);
    assert.equal((await runWatch(root, now + 30 * 60000)).wakes.length, 1);
    assert.equal((await wakes(root)).length, 2);
  }
  const root = await setup(t);
  await Promise.all([runFire(root), runFire(root), runWatch(root)]);
  assert.equal((await wakes(root)).length, 1);
});

test('a claim left by a crash is recovered by the watch', async t => {
  const root = await setup(t);
  const file = receiptPath(root, 'a', 'job', due);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '{"status":"claimed"}');
  assert.equal(await runFire(root), false);
  assert.equal((await runWatch(root)).wakes.length, 1);
  assert.equal(JSON.parse(await readFile(file)).status, 'sent');
});

test('watch waits for a live claim and then observes sent', async t => {
  const root = await setup(t);
  let release, claimed;
  const entered = new Promise(resolve => { claimed = resolve; });
  const proceed = new Promise(resolve => { release = resolve; });
  const timer = dueWake({ root, role: 'a', id: 'job', due, now, emit: async () => { claimed(); await proceed; } });
  await entered;
  const watching = runWatch(root);
  release();
  assert.equal(await timer, true);
  assert.equal((await watching).wakes.length, 0);
});

test('fire does not wait on the watch state lock', async t => {
  const root = await setup(t);
  await withLock(path.join(root, '.agents/work/ledger/watch-state.json'), async () => {
    assert.equal(await runFire(root), true);
  });
});

test('cleans receipts older than 48 hours without deleting recent receipts', async t => {
  const root = await setup(t);
  await runFire(root);
  const file = receiptPath(root, 'a', 'job', due);
  const old = Date.now() - 49 * 3600000;
  await utimes(file, old / 1000, old / 1000);
  await cleanReceipts(root, Date.now());
  await assert.rejects(stat(file), { code: 'ENOENT' });
});

test('post-fire command uses injected argv runner exactly once, including failure', async t => {
  const root = await setup(t);
  const calls = [];
  const runner = async (...args) => { calls.push(args); throw Error('post failed'); };
  const conf = { due_timer: { enabled: true, after_fire: ['/safe/wake', 'arg;literal'] } };
  await assert.rejects(runFire(root, { config: conf, runner }), /post failed/);
  assert.equal(await runFire(root, { config: conf, runner }), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/safe/wake');
  assert.deepEqual(calls[0][1], ['arg;literal']);
});

test('disabled configuration neither runs post-fire command nor changes watch behavior', async t => {
  const root = await setup(t);
  const disabled = { due_timer: { enabled: false, after_fire: ['systemctl'] } };
  const runner = () => { throw Error('must not run'); };
  assert.equal(await runFire(root, { config: disabled, runner }), false);
  const second = await setup(t);
  assert.equal((await watch({ root: second, config: { roles: config.roles }, now })).wakes.length, 1);
  await assert.rejects(stat(path.join(second, '.agents/work/ledger/due-fired')), { code: 'ENOENT' });
});

test('long names preserve the complete route within the filename limit', async t => {
  for (const size of [200, 240]) {
    const root = await setup(t);
    const role = 'r'.repeat(size), id = 'i'.repeat(100);
    const ledger = JSON.parse(await readFile(path.join(root, '.agents/work/ledger/a.json'), 'utf8'));
    ledger.role = role;
    ledger.items[0].id = id;
    await writeFile(path.join(root, '.agents/work/ledger', `${role}.json`), JSON.stringify(ledger));
    assert.equal(await fire({ root, role, id, due, now, config }), true);
    const [name] = await wakes(root);
    assert.ok(Buffer.byteLength(name) <= 255);
    assert.match(name, new RegExp(`-route-${role}\\.md$`));
  }
});

test('watch can also route an overdue item for a 240-character role', async t => {
  const root = await setup(t);
  const role = 'r'.repeat(240);
  const ledger = JSON.parse(await readFile(path.join(root, '.agents/work/ledger/a.json'), 'utf8'));
  ledger.role = role;
  await writeFile(path.join(root, '.agents/work/ledger', `${role}.json`), JSON.stringify(ledger));
  const result = await watch({ root, config: { roles: [{ role, channels: [] }], due_timer: { enabled: true } }, now, runner: unavailable });
  assert.equal(result.wakes.length, 1);
  const [name] = await wakes(root);
  assert.ok(Buffer.byteLength(name) <= 255);
  assert.match(name, new RegExp(`-route-${role}\\.md$`));
});

test('a crash after delivery cannot be recovered as a duplicate', async t => {
  const root = await setup(t);
  await assert.rejects(dueWake({ root, role: 'a', id: 'job', due, now,
    emit: async () => { await writeFile(path.join(root, 'delivered'), 'wake'); throw Error('simulated crash'); } }), /simulated crash/);
  assert.equal(await readFile(path.join(root, 'delivered'), 'utf8'), 'wake');
  assert.equal((await runWatch(root)).wakes.length, 0);
  assert.equal(JSON.parse(await readFile(receiptPath(root, 'a', 'job', due))).status, 'sent');
});

test('closing a ledger item and firing are serialized by the ledger lock', async t => {
  const root = await setup(t);
  let release, entered;
  const inside = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const firing = dueWake({ root, role: 'a', id: 'job', due, now,
    emit: async () => { entered(); await wait; } });
  await inside;
  let closed = false;
  const closing = changeLedger(root, 'a', ledger => { ledger.items[0].status = 'done'; closed = true; });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(closed, false);
  release();
  assert.equal(await firing, true);
  await closing;
  assert.equal(await runFire(root), false);
});
