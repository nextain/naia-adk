import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { boardSection, compareViews, deliver, detectTool, inspect, legacyView, loadRegistry, main, readLedger, sweep, waitRunning, watch } from './role-wake.mjs';

const NOW = Date.parse('2026-01-10T00:00:00Z');
const DAY = 86_400_000;
const botA = '100000000000000001', botB = '100000000000000002';

function setup(t, patch = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'role-wake-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'live'), retired = path.join(dir, 'old'), units = path.join(dir, 'units');
  const waitScript = path.join(dir, 'kit', 'wait.sh');
  for (const made of [path.join(root, 'wake', 'role-b'), retired, units, path.dirname(waitScript)]) fs.mkdirSync(made, { recursive: true });
  fs.writeFileSync(waitScript, '#!/bin/sh\n');
  const doc = {
    schema_version: 1, root, wake_root: 'wake', state_dir: path.join(dir, 'state'), retired_roots: [retired], unit_dirs: [units],
    pane: { kind: 'herdr', bin: '/opt/herdr' },
    delivery: { command: ['/opt/deliver', '{role}', '{file}'] },
    roles: {
      'role-a': { names: ['Role A'], bot_id: botA, user: 'svc', find: { type: 'pane', pane_id: 'w1:p1' }, tool: 'claude', wake_subdir: '', wait: { script: waitScript, mode: 'nudge' } },
      'role-b': { names: ['Role B'], bot_id: botB, user: 'svc', find: { type: 'pane', pane_id: 'w1:p2' }, tools: ['agy', 'muse'], wake_subdir: 'role-b' },
    },
    ...patch,
  };
  const file = path.join(dir, 'role-wake.json');
  const write = () => fs.writeFileSync(file, JSON.stringify(doc));
  write();
  const state = { now: NOW, runs: [], failOn: null, crontab: '', panes: { 'w1:p1': [{ argv: ['claude', '--resume', 'x'], pid: 10 }], 'w1:p2': [{ argv: ['/opt/bin/muse-bin-1.4', '--yolo'], pid: 20 }] }, processes: [{ pid: 10, ppid: 1, args: 'claude --resume x' }, { pid: 11, ppid: 10, args: `bash ${waitScript}` }, { pid: 20, ppid: 1, args: '/opt/bin/muse-bin-1.4 --yolo' }] };
  const deps = {
    now: () => state.now,
    run: (command, args) => { state.runs.push([command, ...args]); if (state.failOn && args.some(arg => arg.includes(state.failOn))) throw new Error('exit 1'); return ''; },
    paneProcesses: (bin, paneId) => { if (!state.panes[paneId]) throw new Error('no pane'); return state.panes[paneId]; },
    processes: () => state.processes,
    crontab: () => state.crontab,
  };
  const put = (role, name, ageDays = 0) => { const target = path.join(root, 'wake', role === 'role-a' ? '' : role, name); fs.writeFileSync(target, 'wake\n'); const at = new Date(NOW - ageDays * DAY); fs.utimesSync(target, at, at); return target; };
  return { dir, root, retired, units, waitScript, doc, file, write, state, deps, put, load: () => loadRegistry(file) };
}
const codes = report => report.findings.map(finding => `${finding.code}:${finding.role ?? ''}`).sort();

test('registry rejects roles without a consumer, duplicate boxes and a retired root', t => {
  const f = setup(t);
  assert.deepEqual(f.load().roles.map(role => [role.id, role.tools, path.relative(f.root, role.wakeDir)]), [['role-a', ['claude'], 'wake'], ['role-b', ['agy', 'muse'], 'wake/role-b']]);
  const broken = change => { const copy = structuredClone(f.doc); change(copy); fs.writeFileSync(f.file, JSON.stringify(copy)); return () => loadRegistry(f.file); };
  assert.throws(broken(doc => { delete doc.delivery; }), /role-b: no wake consumer/);
  assert.throws(broken(doc => { doc.roles['role-b'].wake_subdir = ''; }), /duplicate/);
  assert.throws(broken(doc => { doc.roles['role-b'].find.pane_id = 'w1:p1'; }), /duplicate/);
  assert.throws(broken(doc => { doc.roles['role-b'].wake_subdir = '../x'; }), /wake_subdir/);
  assert.throws(broken(doc => { doc.roles['role-a'].tools = ['agy', 'claude']; }), /tool must equal tools\[0\]/);
  assert.throws(broken(doc => { doc.retired_roots = [path.dirname(f.root)]; }), /inside a retired root/);
  assert.throws(broken(doc => { doc.retention = { archive_dir: 'wake/done' }; }), /outside wake_root/);
  assert.throws(broken(doc => { doc.wake_root = '../elsewhere'; }), /inside root/);
  assert.throws(broken(doc => { doc.delivery.command = ['/opt/deliver']; }), /\{file\}/);
});

test('tool detection reads the foreground program, not the registry', () => {
  const known = ['claude', 'agy', 'muse'];
  assert.deepEqual(detectTool([{ argv: ['/x/muse-bin-1.4.20', '--yolo', 'you are agy'] }], known), { alive: true, tool: 'muse' });
  assert.deepEqual(detectTool([{ argv: ['sudo', '-iu', 'svc', 'bash', '/home/svc/kit/agy-start-1.sh'] }], known), { alive: true, tool: 'agy' });
  assert.deepEqual(detectTool([{ cmdline: 'claude --resume abc' }], known), { alive: true, tool: 'claude' });
  assert.deepEqual(detectTool([{ argv: ['-bash'] }, { argv: ['sudo', '-iu', 'svc', 'bash'] }], known), { alive: false, tool: 'shell' });
  assert.deepEqual(detectTool([{ argv: ['vim', 'notes'] }], known), { alive: true, tool: 'unknown' });
  assert.deepEqual(detectTool([], known), { alive: false, tool: 'shell' });
});

test('a wait script counts only under the pane agent', () => {
  const procs = [{ pid: 10, ppid: 1, args: 'claude' }, { pid: 11, ppid: 10, args: 'bash -c wrapper' }, { pid: 12, ppid: 11, args: 'bash /kit/wait.sh' }, { pid: 30, ppid: 1, args: 'bash /kit/wait.sh' }, { pid: 31, ppid: 10, args: 'bash /other/wait.sh' }, { pid: 32, ppid: 10, args: 'cat /kit/wait.sh' }];
  assert.equal(waitRunning(procs, '/kit/wait.sh', [10]), true);
  assert.equal(waitRunning(procs.filter(proc => proc.pid !== 12), '/kit/wait.sh', [10]), false);
  assert.equal(waitRunning(procs.filter(proc => proc.pid !== 12), '/kit/wait.sh', []), true);
});

test('delivery records a first-seen box without replaying it, then delivers in order', t => {
  const f = setup(t);
  f.put('role-a', '001-old.md'); f.put('role-b', '001-old.md');
  fs.writeFileSync(path.join(f.root, 'wake', 'note.txt'), 'not a wake');
  const registry = f.load();
  assert.deepEqual(deliver(registry, f.deps).roles, { 'role-a': { baseline: 1, delivered: 0, failed: 0, pending: 0 }, 'role-b': { baseline: 1, delivered: 0, failed: 0, pending: 0 } });
  assert.equal(f.state.runs.length, 0);
  const a2 = f.put('role-a', '002-new.md'), b3 = f.put('role-b', '003-new.md'), b2 = f.put('role-b', '002-new.md');
  assert.deepEqual(deliver(registry, f.deps).roles, { 'role-a': { delivered: 1, failed: 0, pending: 0 }, 'role-b': { delivered: 2, failed: 0, pending: 0 } });
  assert.deepEqual(f.state.runs, [['/opt/deliver', 'role-a', a2], ['/opt/deliver', 'role-b', b2], ['/opt/deliver', 'role-b', b3]]);
  deliver(registry, f.deps);
  assert.equal(f.state.runs.length, 3);
});

test('a failed delivery holds that role and is retried; other roles continue', t => {
  const f = setup(t);
  const registry = f.load();
  deliver(registry, f.deps);
  f.put('role-a', '002-a.md'); f.put('role-a', '003-b.md'); f.put('role-b', '002-c.md');
  f.state.failOn = '002-a.md';
  assert.deepEqual(deliver(registry, f.deps).roles, { 'role-a': { delivered: 0, failed: 1, pending: 2 }, 'role-b': { delivered: 1, failed: 0, pending: 0 } });
  assert.equal(readLedger(registry, registry.roles[0]).has('003-b.md'), false);
  f.state.failOn = null;
  assert.deepEqual(deliver(registry, f.deps).roles['role-a'], { delivered: 2, failed: 0, pending: 0 });
  assert.equal(main(['deliver', '--config', f.file], {}, f.deps, () => {}), 0);
});

test('delivery skips a run while another owner holds the lock and reclaims a dead one', t => {
  const f = setup(t);
  const registry = f.load();
  fs.mkdirSync(registry.stateDir, { recursive: true });
  fs.writeFileSync(path.join(registry.stateDir, 'deliver.lock'), String(process.pid));
  assert.deepEqual(deliver(registry, f.deps), { skipped: 'locked' });
  fs.writeFileSync(path.join(registry.stateDir, 'deliver.lock'), '2147483646');
  assert.ok(deliver(registry, f.deps).roles);
  assert.equal(fs.existsSync(path.join(registry.stateDir, 'deliver.lock')), false);
});

test('inspect is quiet on a healthy instance and names each fault', t => {
  const f = setup(t);
  const registry = f.load();
  deliver(registry, f.deps);
  assert.deepEqual(codes(inspect(registry, f.deps)), ['tool-fallback:role-b']);

  f.state.panes['w1:p2'] = [{ argv: ['codex'], pid: 20 }];
  f.state.panes['w1:p1'] = [{ argv: ['-bash'], pid: 10 }];
  f.state.processes = f.state.processes.filter(proc => proc.pid !== 11);
  f.put('role-b', '009-late.md', 1);
  f.state.now = NOW + 301_000;
  const report = inspect(registry, f.deps);
  assert.deepEqual(codes(report), ['delivery-lag:role-b', 'delivery-stale:', 'session-down:role-a', 'tool-drift:role-b', 'wait-down:role-a']);
  assert.equal(report.findings.find(finding => finding.code === 'wait-down').level, 'warn');
  assert.equal(main(['check', '--config', f.file, '--json'], {}, f.deps, () => {}), 1);

  delete f.state.panes['w1:p2'];
  fs.rmSync(f.waitScript);
  assert.ok(codes(inspect(registry, f.deps)).includes('pane-unreadable:role-b'));
  assert.ok(codes(inspect(registry, f.deps)).includes('wait-script-missing:role-a'));
});

test('a stopped wait script is an error when nothing else delivers', t => {
  const f = setup(t);
  delete f.doc.delivery;
  f.doc.roles['role-b'].wait = { script: f.waitScript, mode: 'observe' };
  f.write();
  f.state.processes = f.state.processes.filter(proc => proc.pid !== 11);
  const findings = inspect(f.load(), f.deps).findings.filter(finding => finding.code === 'wait-down');
  assert.deepEqual(findings.map(finding => [finding.role, finding.level]), [['role-a', 'error'], ['role-b', 'warn']]);
});

test('a retired root still wired into a unit, crontab or process is reported', t => {
  const f = setup(t);
  fs.writeFileSync(path.join(f.units, 'watch.service'), `[Service]\nExecStart=/usr/bin/node ${f.retired}/scripts/watch.mjs\n`);
  fs.writeFileSync(path.join(f.units, 'other.service'), `[Service]\nWorkingDirectory=${f.retired}-review\n`);
  fs.mkdirSync(path.join(f.units, 'board.service.d'));
  fs.writeFileSync(path.join(f.units, 'board.service.d', 'env.conf'), `[Service]\nEnvironment=ROOT=${f.retired}\n`);
  f.state.crontab = `# cd ${f.retired}\n* * * * * cd ${f.retired} && run\n`;
  f.state.processes.push({ pid: 99, ppid: 1, args: `node ${f.retired}/scripts/watch.mjs` });
  const registry = f.load();
  deliver(registry, f.deps);
  const details = inspect(registry, f.deps).findings.filter(finding => finding.code === 'retired-root-in-use').map(finding => finding.detail.split(' uses ')[0]).sort();
  assert.deepEqual(details, [path.join(f.units, 'board.service.d', 'env.conf'), path.join(f.units, 'watch.service'), 'crontab line 2', 'process 99'].sort());
});

test('other role lists that disagree with the registry are reported', t => {
  const f = setup(t);
  const view = (name, body) => { const file = path.join(f.dir, name); fs.writeFileSync(file, JSON.stringify(body)); return file; };
  f.doc.role_views = [
    { kind: 'l4-roles', path: path.join(f.dir, 'absent-roles.json') },
    { kind: 'wake-routes', path: view('routes.json', { roles: { 'role-a': { bot_id: botA, wake_subdir: '' }, 'role-b': { bot_id: botB, wake_subdir: 'elsewhere' } } }) },
    { kind: 'liveness', path: view('liveness.json', { roles: { 'role-a': { tool: 'claude', find: { pane_id: 'w1:p1' } }, 'role-b': { tool: 'muse', find: { pane_id: 'w1:p2' } }, 'role-c': { tool: 'claude' } } }) },
    { kind: 'session-health', path: view('health.json', { roles: [{ id: 'role-a', botId: botB }] }) },
    { kind: 'bot-mention-wake', path: view('mention.json', { roles: [{ id: 'role-a', botUserId: botA }, { id: 'role-b', botUserId: botB }] }) },
  ];
  f.write();
  const found = compareViews(f.load()).map(finding => `${finding.code}|${finding.role}|${finding.detail.split(' ')[0]}|${finding.detail.split(': ')[1]}`);
  assert.deepEqual(found, [
    'role-view-missing|null|l4-roles|file not found',
    'role-view-drift|role-b|wake-routes|wake_subdir differ',
    'role-view-drift|role-b|liveness|tool differ',
    'role-view-drift|role-c|liveness|role is not in the registry',
    'role-view-drift|role-a|session-health|bot_id differ',
    'role-view-drift|role-b|session-health|role is missing',
  ]);
  assert.deepEqual(legacyView(f.load(), 'l4-roles').roles[1], { id: 'role-b', names: ['Role B'], wakeDir: 'wake/role-b', botUserIds: [botB] });
  assert.deepEqual(legacyView(f.load(), 'wake-routes').roles['role-a'], { name: 'Role A', bot_id: botA, wake_subdir: '' });
});

test('watch --repair restarts a stopped delivery run and notifies once per period', t => {
  const f = setup(t, { notify: { command: ['/opt/notify', '{text}'], repeat_seconds: 600 } });
  const registry = f.load();
  deliver(registry, f.deps);
  f.put('role-b', '002-new.md');
  f.state.now = NOW + 400_000;
  assert.ok(codes(watch(registry, f.deps)).includes('delivery-stale:'));
  assert.equal(f.state.runs.length, 0);
  const repaired = watch(registry, f.deps, { repair: true });
  assert.deepEqual(codes(repaired), ['tool-fallback:role-b']);
  assert.deepEqual(repaired.actions.map(action => action.action), ['deliver']);
  assert.equal(f.state.runs.filter(run => run[0] === '/opt/deliver').length, 1);

  f.state.panes['w1:p1'] = [{ argv: ['bash'], pid: 10 }];
  const notices = () => f.state.runs.filter(run => run[0] === '/opt/notify');
  watch(registry, f.deps, { repair: true });
  watch(registry, f.deps, { repair: true });
  assert.equal(notices().length, 1);
  assert.match(notices()[0][1], /session-down role-a/);
  f.state.now += 601_000;
  watch(registry, f.deps, { repair: true });
  assert.equal(notices().filter(run => /session-down/.test(run[1])).length, 2);
});

test('a failed notice is sent again on the next run', t => {
  const f = setup(t, { notify: { command: ['/opt/notify', '{text}'] } });
  const registry = f.load();
  deliver(registry, f.deps);
  f.state.panes['w1:p1'] = [{ argv: ['bash'], pid: 10 }];
  f.state.failOn = 'session-down';
  assert.deepEqual(watch(registry, f.deps, { repair: true }).actions.map(action => action.action), ['notify-failed']);
  f.state.failOn = null;
  assert.deepEqual(watch(registry, f.deps, { repair: true }).actions.map(action => action.action), ['notify']);
});

test('sweep archives only delivered files past retention and deletes nothing', t => {
  const f = setup(t, { retention: { delivered_days: 3, archive_dir: 'wake-archive' } });
  const registry = f.load();
  assert.deepEqual(sweep(registry, f.deps, { apply: true }).roles['role-a'], { skipped: 'no delivery ledger', kept: 0 });
  f.put('role-a', '001-old.md', 5); f.put('role-a', '002-recent.md', 1); f.put('role-b', '001-old.md', 9);
  deliver(registry, f.deps);
  const undelivered = f.put('role-a', '003-undelivered.md', 30);
  fs.mkdirSync(path.join(f.root, 'wake', 'done'));
  assert.deepEqual(sweep(registry, f.deps).roles, { 'role-a': { would_move: 1, undelivered: 1, recent: 1 }, 'role-b': { would_move: 1, undelivered: 0, recent: 0 } });
  assert.equal(fs.existsSync(path.join(f.root, 'wake-archive')), false);
  assert.deepEqual(sweep(registry, f.deps, { apply: true }).roles['role-a'], { moved: 1, undelivered: 1, recent: 1 });
  const stamp = new Date(NOW - 5 * DAY).toISOString().slice(0, 10).replaceAll('-', '');
  assert.equal(fs.readFileSync(path.join(f.root, 'wake-archive', '_top', stamp, '001-old.md'), 'utf8'), 'wake\n');
  assert.equal(fs.existsSync(path.join(f.root, 'wake-archive', 'role-b')), true);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'wake')).sort(), ['002-recent.md', '003-undelivered.md', 'done', 'role-b']);
  assert.equal(fs.existsSync(undelivered), true);
  deliver(registry, f.deps);
  assert.deepEqual(f.state.runs.map(run => path.basename(run[2])), ['003-undelivered.md']);
});

test('the role-session table shows the real tool, wait state and undelivered count', t => {
  const f = setup(t);
  const registry = f.load();
  deliver(registry, f.deps);
  f.put('role-b', '002-new.md');
  const text = boardSection(inspect(registry, f.deps));
  assert.match(text, /\| Role A \(role-a\) \| w1:p1 \| alive \| claude \(claude\) \| running \| 0 \| 0 \| - \|/);
  assert.match(text, /\| Role B \(role-b\) \| w1:p2 \| alive \| muse \(agy > muse\) \| none \| 1 \| 1 \(oldest 0m\) \| 0m \|/);
  assert.match(text, /- warn tool-fallback role-b/);
  let printed = '';
  assert.equal(main(['board', '--config', f.file], {}, f.deps, chunk => { printed += chunk; }), 0);
  assert.equal(main(['board'], { ADK_ROLE_WAKE_CONFIG: f.file }, f.deps, () => {}), 0);
  assert.match(printed, /registry: .*role-wake\.json/);
});

test('the example configuration is a valid registry', () => {
  const example = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../config/role-wake.example.json');
  assert.deepEqual(loadRegistry(example).roles.map(role => role.id), ['role-a', 'role-b']);
});
