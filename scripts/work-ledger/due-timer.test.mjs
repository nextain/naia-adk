import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { arm, canonicalRoot, clear, disarm, executePlan, list, plan, reconcile, rootPrefix, systemRunner, unitName } from './due-timer.mjs';

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
      const service = args.find(x => x.endsWith('.service'));
      const found = existing.find(x => args.includes(x.unit) || service === x.unit.replace(/\.timer$/, '.service'));
      if (service) return `{ path=/node ; argv[]=/node script --due ${found.originalDue || found.due} ; }`;
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
  assert.deepEqual(plan({ root, ledgers: [ledger()], timers: [{ unit, due: '2026-11-12T13:00:00.000Z', originalDue: due }], now }), []);
});

test('names distinguish ambiguous roles, reject unsafe input, and bound long ids and roles', () => {
  assert.notEqual(unitName(root, 'a-b', 'c'), unitName(root, 'a', 'b-c'));
  assert.ok(unitName(root, 'a', 'x'.repeat(300)).length <= 200);
  assert.ok(unitName(root, 'a'.repeat(300), 'x').length <= 200);
  assert.throws(() => plan({ root, ledgers: [ledger([item()], 'a'.repeat(241))], timers: [], now }), /Role too long/);
  assert.throws(() => unitName(root, '../escape', 'x'), /Invalid/);
  assert.throws(() => unitName(root, 'a', 'x;id'), /Invalid/);
});

test('enabled fake runner uses UTC, argv, canonical root and selective stop', async t => {
  const dir = await setup(t);
  const link = path.join(dir, 'link');
  await symlink(dir, link);
  assert.equal(await canonicalRoot(link), await realpath(dir));
  const f = fake();
  await arm({ root: link, role: 'a', id: 'b', due: '2026-11-12T13:00:00.123Z', config, now, runner: f.runner });
  const call = f.calls.find(call => call.command === 'systemd-run');
  assert.ok(call);
  assert.ok(call.args.includes('--on-calendar=2026-11-12 13:00:01 UTC'));
  assert.ok(call.args.includes(dir));
  assert.ok(call.args.includes('--timer-property=AccuracySec=1s'));
  assert.ok(call.opts.env.XDG_RUNTIME_DIR);
  assert.throws(() => plan({ root: dir, ledgers: [ledger([item('x', '2026-11-12T13:00:00+09:00')])], timers: [], now }), /UTC/);
  await assert.rejects(disarm({ root: dir, unit: unitName('/other', 'a', 'b'), config, runner: f.runner }), /outside root/);
});

test('disabled scheduling operations never call systemd; explicit clear and disarm still work', async t => {
  const dir = await setup(t);
  const runner = () => { throw Error('must never run'); };
  for (const disabled of [{}, { due_timer: { enabled: false } }]) {
    assert.deepEqual(await list({ root: dir, config: disabled, runner }), []);
    assert.equal(await arm({ root: dir, config: disabled, runner }), false);
    assert.deepEqual(await reconcile({ root: dir, config: disabled, runner }), []);
    assert.deepEqual(await executePlan({ root: dir, config: disabled, runner }), []);
  }
  const unit = unitName(dir, 'a', 'job'), f = fake([{ unit, due: '2026-11-12T13:00:00.000Z' }]);
  assert.equal(await clear({ root: dir, config: {}, runner: f.runner }), 1);
  assert.equal(await disarm({ root: dir, unit, config: {}, runner: f.runner }), true);
});

test('system runner refuses tests without injection', () => {
  assert.throws(() => systemRunner('systemctl', ['--user']), /forbidden in tests/);
});

test('clear continues after invalid or failed units and reports each error', async t => {
  const dir = await setup(t), good = unitName(dir, 'a', 'job'), bad = `${rootPrefix(dir)}bad.timer`;
  const stopped = [];
  const runner = async (_, args) => {
    if (args.includes('list-units')) return `${bad} loaded active waiting\n${good} loaded active waiting`;
    stopped.push(args.at(-1));
  };
  await assert.rejects(clear({ root: dir, config: {}, runner }), /Failed to clear 1 timer.*outside root/);
  assert.deepEqual(stopped, [good]);
});

test('show output accepts property names and argv token forms', async t => {
  const dir = await setup(t), unit = unitName(dir, 'a', 'job'), tag = 'a'.repeat(64);
  for (const withProperty of [false, true]) {
    const runner = async (_, args) => {
      if (args.includes('list-units')) return `${unit} loaded active waiting`;
      if (args.some(arg => arg.endsWith('.service'))) return `${withProperty ? 'ExecStart=' : ''}{ path=/node ; argv[]=/node argv[]=script argv[]=--config-tag argv[]=${tag} argv[]=--due argv[]=${due} ; }`;
      return withProperty ? 'TimersCalendar={ OnCalendar=Thu 2026-11-12 13:00:00 UTC ; next_elapse=n/a }' : '2026-11-12 13:00:00 UTC';
    };
    assert.deepEqual(await list({ root: dir, config, runner }), [{ unit, due: '2026-11-12T13:00:00.000Z', originalDue: due, configTag: tag }]);
  }
});

test('list and clear select only this root; bad properties fail closed', async t => {
  const dir = await setup(t);
  const mine = unitName(dir, 'a', 'job'), other = unitName('/other', 'a', 'job');
  const f = fake([{ unit: mine, due: '2026-11-12T13:00:00.000Z' }, { unit: other, due: '2026-11-12T13:00:00.000Z' }]);
  assert.deepEqual(await list({ root: dir, config, runner: f.runner }), [{ unit: mine, due: '2026-11-12T13:00:00.000Z', originalDue: '2026-11-12T13:00:00.000Z', configTag: null }]);
  assert.equal(await clear({ root: dir, config, runner: f.runner }), 1);
  assert.equal(f.calls.filter(x => x.args.includes('stop')).length, 1);
  assert.ok(f.calls.some(x => x.args.includes('stop') && x.args.includes(mine)));
  const invalid = async (_, args) => args.includes('list-units') ? `${mine} loaded active waiting` : 'unknown';
  assert.equal(await clear({ root: dir, config, runner: invalid }), 1);
  await assert.rejects(list({ root: dir, config, runner: invalid }), /calendar/);
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
