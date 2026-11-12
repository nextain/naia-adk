import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { enableDueTimer } from './enable-due-timer.mjs';
import { main as ledgerMain, changeLedger, ledgerPath, withLock } from './ledger.mjs';
import { fire, dueWake, executePlan, list, reconcileCurrent, receiptPath, rootPrefix, unitName } from './due-timer.mjs';
import { watch } from './ledger-watch.mjs';

const now = Date.parse('2026-11-12T12:00:00Z'), due = '2026-11-12T13:00:00Z';
const cfg = { roles: [{ role: 'a', channels: [] }], due_timer: { enabled: true } };
async function setup(t, enabled = true) {
  const root = await mkdtemp(path.join(tmpdir(), 'fix2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'config'));
  const configPath = path.join(root, 'config/work-ledger.json');
  await writeFile(configPath, JSON.stringify(cfg));
  if (enabled) {
    const watcher = path.join(root, 'watcher'), evidence = path.join(root, 'evidence');
    await writeFile(watcher, 'fixture');
    const sha = createHash('sha256').update('fixture').digest('hex');
    await writeFile(evidence, JSON.stringify({ work_watch_path: watcher, work_watch_sha256: sha, running_code_verified: true, no_extra_completion_wake_verified: true }));
    await enableDueTimer({ configPath, watchPath: watcher, evidencePath: evidence, expectedWatchSha256: sha });
  }
  return { root, configPath };
}
const add = root => ledgerMain(['add', '--root', root, '--role', 'a', '--id', 'job', '--title', 'work', '--due', due, '--channel', 'c', '--msg-id', 'm'], { now, runner: async () => '' });

test('enable proof binds config, approval, time and enable script; direct or changed config is refused', async t => {
  const { root, configPath } = await setup(t, false);
  let calls = 0; const runner = async () => { calls++; return ''; };
  let warnings = await reconcileCurrent({ root, config: cfg, roles: ['a'], now, runner });
  assert.match(warnings.join(' '), /증빙|proof/i); assert.equal(calls, 0);
  assert.equal(await fire({ root, config: cfg, role: 'a', id: 'job', due, now: Date.parse(due), runner }), false);
  const good = await setup(t);
  const proof = JSON.parse(await readFile(`${good.configPath}.due-timer-proof.json`, 'utf8'));
  for (const k of ['config_sha256', 'approved_watch_sha256', 'enabled_at', 'enable_script_sha256']) assert.ok(proof[k], k);
  await writeFile(good.configPath, JSON.stringify({ ...cfg, changed: true }));
  warnings = await reconcileCurrent({ root: good.root, config: cfg, roles: ['a'], now, runner });
  assert.match(warnings.join(' '), /증빙|proof/i); assert.equal(calls, 0);
});

test('unit show errors are warnings and action failures do not prevent later arms', async t => {
  const { root } = await setup(t); const good = unitName(root, 'a', 'job'), bad = `${rootPrefix(root)}legacy.timer`;
  const warnings = [], calls = [];
  const runner = async (cmd, args) => {
    calls.push([cmd, args]);
    if (args.includes('list-units')) return `${bad} loaded\n${good} loaded`;
    if (args.includes(bad)) throw Error('vanished');
    if (args.some(x => x.endsWith('.service'))) return `{ argv[]=/node --due ${due} ; }`;
    if (args.includes('show')) return '2026-11-12 13:00:00 UTC';
    if (args.includes('stop')) throw Error('stop failed');
    return '';
  };
  assert.equal((await list({ root, config: cfg, runner, warnings })).length, 1);
  assert.ok(warnings.some(w => w.includes(bad)));
  await assert.rejects(executePlan({ root, config: cfg, runner, now, actions: [{ type: 'disarm', unit: good }, { type: 'arm', role: 'a', id: 'next', due }] }), /stop failed/);
  assert.ok(calls.some(([cmd]) => cmd === 'systemd-run'));
});

test('failed emit restores claimed receipt for immediate watch recovery', async t => {
  const { root } = await setup(t); await add(root);
  await assert.rejects(dueWake({ root, role: 'a', id: 'job', due, now: Date.parse(due), emit: () => { throw Error('disk'); } }), /disk/);
  assert.equal(JSON.parse(await readFile(receiptPath(root, 'a', 'job', due))).status, 'claimed');
});

test('bad roles are excluded while healthy roles still arm', async t => {
  const { root } = await setup(t); await add(root); let arms = 0;
  const longRole = 'a'.repeat(241);
  const longLedger = JSON.parse(await readFile(ledgerPath(root, 'a'), 'utf8'));
  longLedger.role = longRole;
  await writeFile(ledgerPath(root, longRole), JSON.stringify(longLedger));
  const warnings = await reconcileCurrent({ root, config: cfg, roles: ['a'.repeat(241), 'bad role', 'a'], now, runner: async (cmd) => { if (cmd === 'systemd-run') arms++; return ''; } });
  assert.equal(arms, 1); assert.ok(warnings.length >= 2);
});

test('reconciliation rereads a ledger changed while listing timers', async t => {
  const { root } = await setup(t); await add(root); const later = '2026-11-12T14:00:00Z'; let changed = false, armed;
  const runner = async (cmd, args) => {
    if (args.includes('list-units') && !changed) { changed = true; await changeLedger(root, 'a', l => { l.items[0].due = later; }); }
    if (cmd === 'systemd-run') armed = args[args.indexOf('--due') + 1];
    return '';
  };
  await reconcileCurrent({ root, config: cfg, roles: ['a'], now, runner });
  assert.equal(armed, later);
});

test('lock timeout records failed and watch uses due-time reason despite recent fallback', { timeout: 20000 }, async t => {
  const { root } = await setup(t); await add(root); const at = Date.parse(due) + 1000;
  await withLock(ledgerPath(root, 'a'), async () => {
    await assert.rejects(fire({ root, config: cfg, role: 'a', id: 'job', due, now: at }), /Lock/);
  });
  assert.equal(JSON.parse(await readFile(receiptPath(root, 'a', 'job', due))).status, 'failed');
  const key = JSON.stringify(['a', 'job', '기한 넘음', due]);
  await writeFile(path.join(root, '.agents/work/ledger/watch-state.json'), JSON.stringify({ version: 1, sent: { [key]: at - 1000 }, thread_cursors: {}, mentions: {} }));
  const result = await watch({ root, config: cfg, now: at, runner: async () => '' });
  assert.equal(result.wakes[0].reason, '정한 시각');
  assert.match(await readFile(path.join(root, '.agents/work/l4/wake', (await readdir(path.join(root, '.agents/work/l4/wake')))[0]), 'utf8'), /정한 시각/);
});

test('wake filename collision uses a different file without overwriting', async t => {
  const { root } = await setup(t); await add(root);
  const at = Date.parse(due), dir = path.join(root, '.agents/work/l4/wake');
  await mkdir(dir, { recursive: true });
  const stamp = new Date(at).toISOString().replace(/\D/g, '');
  const prefix = createHash('sha256').update(due).digest('hex').slice(0, 8);
  const existing = path.join(dir, `${stamp}-${prefix}-ledger-job-route-a.md`);
  await writeFile(existing, 'existing');
  assert.equal(await fire({ root, config: cfg, role: 'a', id: 'job', due, now: at }), true);
  assert.equal(await readFile(existing, 'utf8'), 'existing');
  assert.equal((await readdir(dir)).length, 2);
});

test('legacy units are reported and clear only stops them with explicit flag', async t => {
  const { root } = await setup(t); const legacy = `${rootPrefix(root)}old.timer`, calls = [];
  const runner = async (_, args) => { if (args.includes('list-units')) return `${legacy} loaded`; calls.push(args); return ''; };
  const warnings = [];
  assert.deepEqual(await list({ root, config: cfg, runner, warnings }), []);
  assert.match(warnings.join(' '), /legacy/i);
  const { main } = await import('./due-timer.mjs');
  await assert.rejects(main(['clear', '--root', root], { runner }), /outside root/);
  assert.equal(await main(['clear', '--root', root, '--include-legacy'], { runner }), 1);
  assert.equal(calls.filter(args => args.includes('stop')).length, 1);
});

test('repeated ledger changes stop reconciliation after three snapshots', async t => {
  const { root } = await setup(t); await add(root); let lists = 0, armed = 0;
  const runner = async (cmd, args) => {
    if (args.includes('list-units')) { lists++; await changeLedger(root, 'a', ledger => { ledger.items[0].note = `change ${lists}`; }); }
    if (cmd === 'systemd-run') armed++;
    return '';
  };
  await assert.rejects(reconcileCurrent({ root, config: cfg, roles: ['a'], now, runner }), /3 attempts/);
  assert.equal(lists, 3); assert.equal(armed, 0);
});

test('fire reports file creation failure and leaves recoverable claimed receipt', async t => {
  const { root } = await setup(t); await add(root);
  const wakeDir = path.join(root, '.agents/work/l4/wake');
  await mkdir(path.dirname(wakeDir), { recursive: true });
  await writeFile(wakeDir, 'not a directory');
  await assert.rejects(fire({ root, config: cfg, role: 'a', id: 'job', due, now: Date.parse(due) }));
  assert.equal(JSON.parse(await readFile(receiptPath(root, 'a', 'job', due))).status, 'claimed');
});
