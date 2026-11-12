import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { arm, canonicalRoot, clear, disarm, executePlan, list, plan, reconcile, rootPrefix, unitName } from './due-timer.mjs';

const now = Date.parse('2026-11-12T12:00:00Z');
const due = '2026-11-12T13:00:00Z';
const config = { due_timer: { enabled: true } };
const root = '/example/root';
const item = (id = 'job', time = due, status = 'open') => ({ id, due: time, status });
const ledger = (items = [item()], role = 'a') => ({ role, items });
const setup = async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'timer-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};
function fake(existing = []) {
  const calls = [];
  const runner = async (command, args, opts) => {
    calls.push({ command, args, opts });
    if (args.includes('list-units')) return existing.map(x => `${x.unit} loaded active waiting Example`).join('\n');
    if (args.includes('show')) {
      const found = existing.find(x => args.includes(x.unit));
      return `{ OnCalendar=${found.due.replace('T', ' ').replace('.000Z', ' UTC')} ; next_elapse=none }`;
    }
    return '';
  };
  return { calls, runner };
}

test('planning arms, replaces, removes, fires, and ignores another role/root', () => {
  const unit = unitName(root, 'a', 'job');
  const otherRole = unitName(root, 'other', 'job');
  const otherRoot = unitName('/another', 'a', 'job');
  const timers = [{ unit, due: '2026-11-12T12:45:00.000Z' }, { unit: otherRole, due }, { unit: otherRoot, due }];
  assert.deepEqual(plan({ root, ledgers: [ledger()], timers, now }).map(a => a.type), ['disarm', 'arm']);
  assert.deepEqual(plan({ root, ledgers: [ledger([item('job', due, 'done')])], timers, now }), [{ type: 'disarm', unit }]);
  assert.deepEqual(plan({ root, ledgers: [ledger([item('job', '2026-11-14T12:00:00Z')])], timers: [], now }), []);
  assert.equal(plan({ root, ledgers: [ledger([item('job', '2026-11-12T12:00:05Z')])], timers: [], now })[0].type, 'fire');
  assert.equal(plan({ root, ledgers: [ledger([item('job', '2026-11-12T11:00:00Z')])], timers: [], now })[0].type, 'fire');
  assert.deepEqual(plan({ root, ledgers: [ledger()], timers: [{ unit, due: '2026-11-12T13:00:00.000Z' }], now }), []);
});

test('names distinguish ambiguous roles, reject unsafe input, and bound long ids and roles', () => {
  assert.notEqual(unitName(root, 'a-b', 'c'), unitName(root, 'a', 'b-c'));
  assert.ok(unitName(root, 'a', 'x'.repeat(300)).length <= 200);
  assert.ok(unitName(root, 'a'.repeat(300), 'x').length <= 200);
  assert.throws(() => unitName(root, '../escape', 'x'), /Invalid/);
  assert.throws(() => unitName(root, 'a', 'x;id'), /Invalid/);
});

test('enabled fake runner uses UTC, argv, canonical root and selective stop', async t => {
  const dir = await setup(t);
  const link = path.join(dir, 'link');
  await symlink(dir, link);
  assert.equal(await canonicalRoot(link), await realpath(dir));
  const f = fake();
  await arm({ root: link, role: 'a', id: 'b', due: '2026-11-12T13:00:00.123Z', config, runner: f.runner });
  assert.equal(f.calls[0].command, 'systemd-run');
  assert.ok(f.calls[0].args.includes('--on-calendar=2026-11-12 13:00:01 UTC'));
  assert.ok(f.calls[0].args.includes(dir));
  assert.ok(f.calls[0].args.includes('--timer-property=AccuracySec=1s'));
  assert.ok(f.calls[0].opts.env.XDG_RUNTIME_DIR);
  assert.throws(() => plan({ root: dir, ledgers: [ledger([item('x', '2026-11-12T13:00:00+09:00')])], timers: [], now }), /UTC/);
  await assert.rejects(disarm({ root: dir, unit: unitName('/other', 'a', 'b'), config, runner: f.runner }), /outside root/);
});

test('disabled operations including clear never call systemd', async t => {
  const dir = await setup(t);
  const runner = () => { throw Error('must never run'); };
  for (const disabled of [{}, { due_timer: { enabled: false } }]) {
    assert.deepEqual(await list({ root: dir, config: disabled, runner }), []);
    assert.equal(await clear({ root: dir, config: disabled, runner }), 0);
    assert.equal(await arm({ root: dir, config: disabled, runner }), false);
    assert.equal(await disarm({ root: dir, config: disabled, runner }), false);
    assert.deepEqual(await reconcile({ root: dir, config: disabled, runner }), []);
    assert.deepEqual(await executePlan({ root: dir, config: disabled, runner }), []);
  }
});

test('list and clear select only this root; bad properties fail closed', async t => {
  const dir = await setup(t);
  const mine = unitName(dir, 'a', 'job'), other = unitName('/other', 'a', 'job');
  const f = fake([{ unit: mine, due: '2026-11-12T13:00:00.000Z' }, { unit: other, due: '2026-11-12T13:00:00.000Z' }]);
  assert.deepEqual(await list({ root: dir, config, runner: f.runner }), [{ unit: mine, due: '2026-11-12T13:00:00.000Z' }]);
  assert.equal(await clear({ root: dir, config, runner: f.runner }), 1);
  assert.equal(f.calls.filter(x => x.args.includes('stop')).length, 1);
  assert.ok(f.calls.some(x => x.args.includes('stop') && x.args.includes(mine)));
  const invalid = async (_, args) => args.includes('list-units') ? `${mine} loaded active waiting` : 'unknown';
  await assert.rejects(clear({ root: dir, config, runner: invalid }), /calendar/);
});

test('cap counts timers for all roles in same root', () => {
  const timers = Array.from({ length: 200 }, (_, n) => ({ unit: unitName(root, 'other', `id${n}`), due: '2026-11-12T13:00:00.000Z' }));
  assert.deepEqual(plan({ root, ledgers: [ledger()], timers, now }).map(a => a.type), ['warning']);
});

test('fake failure propagates and immediate action invokes only supplied fire', async t => {
  const dir = await setup(t);
  const fail = async () => { throw Error('systemd 사용자 세션 없음'); };
  await assert.rejects(arm({ root: dir, role: 'a', id: 'x', due, config, runner: fail }), /사용자 세션 없음/);
  let fired;
  const actions = plan({ root: dir, ledgers: [ledger([item('job', '2026-11-12T11:00:00Z')])], timers: [], now });
  await executePlan({ root: dir, config, actions, runner: fail, fire: x => { fired = x; } });
  assert.equal(fired.id, 'job');
});
