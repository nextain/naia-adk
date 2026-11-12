import test from 'node:test';
import { approveFixture } from './due-test-helper.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { main as ledgerMain, readLedger, changeLedger } from './ledger.mjs';
import { watch } from './ledger-watch.mjs';
import { arm, disarm, fire, main as timerMain, plan, unitName } from './due-timer.mjs';

const now = Date.parse('2026-11-12T12:00:00Z');
const due = '2026-11-12T13:00:00.100Z';
const config = { roles: [{ role: 'a', channels: [] }], due_timer: { enabled: true } };
async function setup(t, conf = config) {
  const root = await mkdtemp(path.join(tmpdir(), 'due-integration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'config'));
  await writeFile(path.join(root, 'config/work-ledger.json'), JSON.stringify(conf));
  if (conf.due_timer?.enabled) await approveFixture(root, conf);
  return root;
}
function systemFake() {
  const timers = new Map();
  const calls = [];
  const runner = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'systemctl' && args.includes('list-units')) return [...timers.keys()].map(unit => `${unit} loaded active waiting`).join('\n');
    if (cmd === 'systemctl' && args.includes('show')) {
      const name = args.find(a => a.endsWith('.timer') || a.endsWith('.service'));
      const entry = timers.get(name.replace(/\.service$/, '.timer'));
      if (!entry) throw Error('unit vanished');
      return name.endsWith('.service') ? `{ argv[]=/node fire ${entry.configTag ? `--config-tag ${entry.configTag} ` : ""}--due ${entry.originalDue} ; }` : `{ OnCalendar=${entry.calendar} ; next_elapse=none }`;
    }
    if (cmd === 'systemctl' && args.includes('stop')) { timers.delete(args.find(a => a.endsWith('.timer'))); return ''; }
    if (cmd === 'systemd-run') {
      const unit = args.find(a => a.startsWith('--unit=')).slice(7) + '.timer';
      timers.set(unit, { calendar: args.find(a => a.startsWith('--on-calendar=')).slice(14), originalDue: args[args.indexOf('--due') + 1], configTag: args[args.indexOf('--config-tag') + 1] });
      return '';
    }
    throw Error(`unexpected fake command ${cmd}`);
  };
  return { timers, calls, runner };
}
const args = (root, command, id, more = []) => [command, ...(id ? [id] : []), '--root', root, '--role', 'a', ...more];
const add = (root, more = []) => args(root, 'add', null, ['--id', 'job', '--title', 'work', '--due', due, '--channel', 'c', '--msg-id', 'm', ...more]);

test('add, due, done and drop reconcile, preserving the ledger on timer failure', async t => {
  const root = await setup(t), f = systemFake();
  assert.equal(await ledgerMain(add(root), { runner: f.runner, now }), 'job');
  assert.equal(f.timers.size, 1);
  const item = (await readLedger(root, 'a')).items[0];
  assert.equal(item.created_at, '2026-11-12T12:00:00.000Z');
  await assert.rejects(ledgerMain(args(root, 'due', 'job', ['--due', due]), { runner: f.runner, now }), /reason/);
  const later = '2026-11-12T13:00:00.900Z';
  await ledgerMain(args(root, 'due', 'job', ['--due', later, '--reason', 'changed']), { runner: f.runner, now });
  assert.equal([...f.timers.values()][0].originalDue, later);
  assert.equal(f.calls.filter(call => call.args.includes('stop')).length, 1);
  await ledgerMain(args(root, 'done', 'job'), { runner: f.runner, now });
  assert.equal(f.timers.size, 0);
  await assert.rejects(ledgerMain(args(root, 'due', 'job', ['--due', due, '--reason', 'no']), { runner: f.runner, now }), /open/);
  await ledgerMain(add(root, ['--id', 'second']), { runner: f.runner, now });
  await ledgerMain(args(root, 'drop', 'second', ['--reason', 'cancel']), { runner: f.runner, now });
  assert.equal(f.timers.size, 0);
  const warnings = [];
  const failed = async () => { throw Error('fake unavailable'); };
  await ledgerMain(add(root, ['--id', 'third']), { runner: failed, now, warn: w => warnings.push(w) });
  assert.equal((await readLedger(root, 'a')).items.find(i => i.id === 'third').status, 'open');
  assert.match(warnings[0], /fake unavailable/);
});

test('disabled paths never use runner and old ledger without created_at remains valid', async t => {
  const root = await setup(t, { roles: config.roles });
  const forbidden = () => { throw Error('runner called'); };
  await ledgerMain(add(root), { runner: forbidden, now });
  await changeLedger(root, 'a', l => { delete l.items[0].created_at; });
  assert.equal((await readLedger(root, 'a')).items[0].created_at, undefined);
  await watch({ root, config: { roles: config.roles }, runner: forbidden, now });
});

test('watch rebuilds after reboot and retains other roots and failed-role timers', async t => {
  const root = await setup(t), f = systemFake();
  await ledgerMain(add(root), { runner: f.runner, now });
  f.timers.clear();
  const other = unitName('/other-root', 'a', 'other');
  const brokenRole = unitName(root, 'broken', 'other');
  f.timers.set(other, { calendar: '2026-11-12 13:00:01 UTC', originalDue: due });
  f.timers.set(brokenRole, { calendar: '2026-11-12 13:00:01 UTC', originalDue: due });
  const result = await watch({ root, config: { ...config, roles: [...config.roles, { role: 'broken', channels: [] }] }, runner: f.runner, now });
  assert.ok(f.timers.has(unitName(root, 'a', 'job')));
  assert.ok(f.timers.has(other));
  assert.ok(f.timers.has(brokenRole));
  assert.ok(result.warnings.some(w => w.startsWith('ledger:broken:')));
});

test('fallback distinguishes changed due and supports long ids', async t => {
  const root = await setup(t), f = systemFake();
  const long = 'x'.repeat(230);
  const first = '2026-11-12T11:50:00Z', second = '2026-11-12T11:55:00Z';
  await ledgerMain(add(root, ['--id', long, '--due', first]), { runner: async () => { throw Error('offline'); }, now, warn: () => {} });
  assert.equal((await watch({ root, config, runner: f.runner, now })).wakes.length, 1);
  await changeLedger(root, 'a', l => { l.items[0].due = second; });
  assert.equal((await watch({ root, config, runner: f.runner, now: now + 1000 })).wakes.length, 1);
  assert.equal((await readdir(path.join(root, '.agents/work/l4/wake'))).length, 2);
});

test('custom config is passed to the scheduled fire and controls post-fire command', async t => {
  const root = await setup(t), f = systemFake();
  const custom = path.join(root, 'config/custom path.json');
  await approveFixture(root, { ...config, due_timer: { enabled: true, after_fire: ['/fake/pump', 'literal'] } }, custom);
  await ledgerMain(add(root, ['--config', custom]), { runner: f.runner, now });
  const launch = f.calls.find(c => c.cmd === 'systemd-run');
  assert.equal(launch.args[launch.args.indexOf('--config') + 1], custom);
  const calls = [];
  const result = await timerMain(['fire', '--root', root, '--role', 'a', '--id', 'job', '--due', due, '--config', custom], { now: Date.parse(due), runner: async (...args) => calls.push(args) });
  assert.equal(result, true);
  assert.equal(calls[0][0], '/fake/pump');
  assert.deepEqual(calls[0][1], ['literal']);
});

test('single arm cannot bypass limit, horizon or immediate fire; unknown due is replaced', async t => {
  const root = await setup(t), f = systemFake();
  for (let i = 0; i < 200; i++) f.timers.set(unitName(root, 'other', `id${i}`), { calendar: '2026-11-12 13:00:01 UTC', originalDue: due });
  await assert.rejects(arm({ root, role: 'a', id: 'new', due, config, now, runner: f.runner }), /limit/);
  assert.equal(f.calls.filter(c => c.cmd === 'systemd-run').length, 0);
  f.timers.clear();
  assert.equal(await arm({ root, role: 'a', id: 'new', due: '2026-11-14T13:00:00Z', config, now, runner: f.runner }), false);
  let fired = 0;
  assert.equal(await arm({ root, role: 'a', id: 'new', due: '2026-11-12T12:00:03Z', config, now, runner: f.runner, fire: () => { fired++; } }), true);
  assert.equal(fired, 1);
  const unit = unitName(root, 'a', 'job');
  assert.deepEqual(plan({ root, ledgers: [{ role: 'a', items: [{ id: 'job', due: '2026-11-12T13:00:00.900Z', status: 'open' }] }], timers: [{ unit, due: '2026-11-12T13:00:01.000Z', originalDue: due }], now }).map(x => x.type), ['disarm', 'arm']);
  assert.deepEqual(plan({ root, ledgers: [{ role: 'a', items: [{ id: 'job', due, status: 'open' }] }], timers: [{ unit, due: '2026-11-12T13:00:01.000Z', originalDue: null }], now }).map(x => x.type), ['disarm', 'arm']);
});

test('concurrent changes reconcile the latest saved due last', async t => {
  const root = await setup(t), f = systemFake();
  await ledgerMain(add(root), { runner: f.runner, now });
  const first = '2026-11-12T14:00:00Z', latest = '2026-11-12T15:00:00Z';
  let release, entered;
  const paused = new Promise(resolve => { entered = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  let blocking = true;
  const runner = async (...a) => {
    if (blocking && a[1].includes('list-units')) { blocking = false; entered(); await resume; }
    return f.runner(...a);
  };
  const earlier = ledgerMain(args(root, 'due', 'job', ['--due', first, '--reason', 'first']), { runner, now });
  await paused;
  const later = ledgerMain(args(root, 'due', 'job', ['--due', latest, '--reason', 'later']), { runner, now });
  for (let i = 0; i < 200; i++) {
    if ((await readLedger(root, 'a')).items[0].due === latest) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal((await readLedger(root, 'a')).items[0].due, latest);
  release();
  await Promise.all([earlier, later]);
  assert.equal([...f.timers.values()][0].originalDue, latest);
});

test('switching config paths replaces an otherwise unchanged timer', async t => {
  const root = await setup(t), f = systemFake();
  const custom = path.join(root, 'config/other.json');
  await approveFixture(root, config, custom);
  await ledgerMain(add(root), { runner: f.runner, now });
  await watch({ root, config, configPath: custom, runner: f.runner, now });
  assert.equal(f.calls.filter(c => c.args.includes('stop')).length, 1);
  const runs = f.calls.filter(c => c.cmd === 'systemd-run');
  assert.equal(runs.length, 2);
  assert.equal(runs[1].args[runs[1].args.indexOf('--config') + 1], custom);
});


test('disarm and reconciliation serialize against the same timer', async t => {
  const root = await setup(t), f = systemFake();
  await ledgerMain(add(root), { runner: f.runner, now });
  let release, entered;
  const paused = new Promise(resolve => { entered = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  const runner = async (...a) => {
    if (a[1].includes('stop')) { entered(); await resume; }
    return f.runner(...a);
  };
  const removing = disarm({ root, unit: unitName(root, 'a', 'job'), config, runner });
  await paused;
  const watching = watch({ root, config, now, runner });
  release();
  await Promise.all([removing, watching]);
  assert.ok(f.timers.has(unitName(root, 'a', 'job')));
});

test('one clock snapshot controls planning and execution despite clock jumps', async t => {
  for (const jump of [-3600000, 3600000]) {
    const root = await setup(t), f = systemFake();
    let current = now;
    await ledgerMain(add(root), { runner: f.runner, clock: () => current });
    f.calls.length = 0;
    const next = '2026-11-12T12:30:00Z';
    const runner = async (...a) => {
      const output = await f.runner(...a);
      if (a[1].includes('list-units')) current += jump;
      return output;
    };
    await ledgerMain(args(root, 'due', 'job', ['--due', next, '--reason', 'changed']), { runner, clock: () => current });
    assert.equal(f.calls.filter(c => c.cmd === 'systemd-run').length, 1);
    assert.equal([...f.timers.values()][0].originalDue, next);
  }
});

test('watch removes timers for roles removed from config, preserving unreadable configured roles', async t => {
  const root = await setup(t), f = systemFake();
  const stale = unitName(root, 'removed', 'job'), broken = unitName(root, 'broken', 'job');
  for (const unit of [stale, broken]) f.timers.set(unit, { calendar: '2026-11-12 13:00:01 UTC', originalDue: due });
  const result = await watch({ root, config: { ...config, roles: [...config.roles, { role: 'broken', channels: [] }] }, runner: f.runner, now });
  assert.equal(f.timers.has(stale), false);
  assert.equal(f.timers.has(broken), true);
  assert.ok(result.warnings.some(w => w.startsWith('ledger:broken:')));
});

test('default and explicit config paths identify the same timer', async t => {
  const root = await setup(t), f = systemFake();
  await ledgerMain(add(root), { runner: f.runner, now });
  await watch({ root, config, configPath: path.join(root, 'config/work-ledger.json'), runner: f.runner, now });
  assert.equal(f.calls.filter(c => c.args.includes('stop')).length, 0);
  assert.equal(f.calls.filter(c => c.cmd === 'systemd-run').length, 1);
});

test('switching timer mode preserves a recorded fallback for the same due', async t => {
  const root = await setup(t, { roles: config.roles }), f = systemFake();
  await ledgerMain(add(root, ['--due', '2026-11-12T11:00:00Z']), { now, runner: f.runner });
  assert.equal((await watch({ root, config: { roles: config.roles }, now, runner: f.runner })).wakes.length, 1);
  await approveFixture(root, config);
  assert.equal((await watch({ root, config, now: now + 60000, runner: f.runner })).wakes.length, 0);
  assert.equal((await watch({ root, config, now: now + 30 * 60000, runner: f.runner })).wakes.length, 1);
  assert.equal((await watch({ root, config: { roles: config.roles }, now: now + 31 * 60000, runner: f.runner })).wakes.length, 0);
});


test('turning off after a timer fired honors its receipt without invoking systemd', async t => {
  const root = await setup(t), f = systemFake();
  await ledgerMain(add(root, ['--due', '2026-11-12T11:00:00Z']), { now, runner: f.runner });
  assert.equal(await fire({ root, role: 'a', id: 'job', due: '2026-11-12T11:00:00Z', now, config }), false);
  const forbidden = () => { throw Error('disabled runner called'); };
  const result = await watch({ root, config: { roles: config.roles }, now: now + 60000, runner: forbidden });
  assert.equal(result.wakes.length, 0);
  assert.equal((await readdir(path.join(root, '.agents/work/l4/wake'))).length, 1);
});
