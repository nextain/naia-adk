import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { boardSection, compareViews, deliver, detectTool, inspect, legacyView, loadRegistry, main, readFailures, readLedger, sweep, waitRunning, watch } from './role-wake.mjs';
import { ledgerPath } from './work-ledger/ledger.mjs';
import { writeLedgerWake } from './work-ledger/ledger-watch.mjs';
import { formatStalledCardWake } from './lib/stalled-cards.mjs';

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
const SOURCE_CHANNEL = '300000000000000002';
const ORIGINAL_MESSAGE = '300000000000000003';
const STAGE_MESSAGE = '300000000000000004';
const ledgerRow = (id, patch = {}) => ({
  id, title: id, status: 'open', from: { channel: SOURCE_CHANNEL, msg_id: ORIGINAL_MESSAGE, quote: '' },
  due: '2026-01-11T00:00:00Z', checked_at: null, note: '', worker: null, ...patch,
});

function writeWorkLedger(file, role, items) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, role, items,
    report: { every_min: 0, channel: '', last_msg_id: null, last_at: null } }));
}

function readAtDelivery(f) {
  const run = f.deps.run;
  const received = [];
  f.deps.run = (bin, args, options) => {
    if (bin === '/opt/deliver') {
      const [role, file] = args;
      received.push({ role, file, body: fs.readFileSync(file, 'utf8') });
    }
    return run(bin, args, options);
  };
  return received;
}

test('work-header delivery uses producer metadata, falls back to recent work, and leaves the original intact', t => {
  const f = setup(t);
  f.doc.delivery.workHeader = true;
  f.doc.roles['role-a'].ledger = 'custom/role-a.json';
  writeWorkLedger(path.join(f.root, 'custom/role-a.json'), 'role-a', [
    ledgerRow('original'),
    ledgerRow('synthetic', { from: { channel: SOURCE_CHANNEL, msg_id: STAGE_MESSAGE, quote: '' }, due: '2026-01-12T00:00:00Z' }),
    ledgerRow('recent-1', { from: { channel: '', msg_id: '-', quote: '' }, due: '2026-01-13T00:00:00Z' }),
  ]);
  f.write();
  const received = readAtDelivery(f);
  const registry = f.load();
  deliver(registry, f.deps);
  const discordWake = auth => `# Discord wake\r\n\r\nRole: role-a\r\nChannel: general (${SOURCE_CHANNEL})\r\n${auth}\r\n\r\nWake body\r\n`;
  const bodies = [
    discordWake(`Author: Human\r\nMessage ID: ${ORIGINAL_MESSAGE}`),
    discordWake(`Author: agent-request-watch\r\nMessage ID: ${STAGE_MESSAGE}\r\nOriginal Message ID: ${ORIGINAL_MESSAGE}`),
    '[장부] 접수한 작업: a later reply\n작업카드: original\n출처: channel/follow-up\n',
    `# Liveness wake\n\nMessage ID: ${ORIGINAL_MESSAGE}\n`,
    discordWake(`Author: agent-request-watch\r\nMessage ID: ${STAGE_MESSAGE}`),
  ];
  const files = bodies.map((body, i) => {
    const file = f.put('role-a', `0${i}-wake.md`);
    fs.writeFileSync(file, body);
    fs.utimesSync(file, new Date(NOW), new Date(NOW));
    return file;
  });
  assert.equal(deliver(registry, f.deps).roles['role-a'].delivered, bodies.length);
  for (const [i, attempt] of received.entries()) {
    assert.equal(attempt.file, path.join(registry.stateDir, 'spool', 'role-a', path.basename(files[i])));
    assert.ok(attempt.body.startsWith(`[내 장부 먼저]\n- ${i < 3 ? 'original' : 'recent-1'} | open |`));
    assert.doesNotMatch(attempt.body.split('\n\n')[0], /synthetic/);
    assert.ok(attempt.body.endsWith(`\n\n${bodies[i]}`));
    assert.equal(fs.readFileSync(files[i], 'utf8'), bodies[i]);
    assert.equal(fs.existsSync(attempt.file), false);
  }
});

test('stalled wakes put the named card first in the receiving role’s work header', t => {
  const f = setup(t);
  f.doc.delivery.workHeader = true;
  f.doc.roles['role-a'].ledger = 'role-a.json';
  const target = ledgerRow('target', { checked_at: '2026-01-01T00:00:00Z' });
  const recent = ledgerRow('recent', { checked_at: '2026-01-09T00:00:00Z', from: { channel: '', msg_id: '-', quote: '' } });
  writeWorkLedger(path.join(f.root, 'role-a.json'), 'role-a', [target, recent]);
  f.write();
  const registry = f.load();
  const received = readAtDelivery(f);
  deliver(registry, f.deps);
  const wake = (roleId, wakeCount) => formatStalledCardWake({
    roleId, wakeCount, escalateAfterCount: 3,
    card: { ...target, stalledMs: 60 * 60_000, lastEvidenceAt: null, resultPaths: [] },
  });
  const cases = [
    [wake('role-a', 1), target.id],
    [wake('role-a', 3).replaceAll('\n', '\r\n'), target.id],
    [wake('role-b', 1), recent.id],
  ];
  for (const [i, [body, expected]] of cases.entries()) {
    const file = f.put('role-a', `0${i}-stalled.md`);
    fs.writeFileSync(file, body);
    assert.equal(deliver(registry, f.deps).roles['role-a'].delivered, 1);
    assert.ok(received[i].body.startsWith(`[내 장부 먼저]\n- ${expected} | open |`));
    assert.ok(received[i].body.endsWith(`\n\n${body}`));
    assert.equal(fs.readFileSync(file, 'utf8'), body);
  }
});

test('configured work ledgers fail open with one diagnostic and unconfigured roles use the original path', t => {
  const f = setup(t);
  f.doc.delivery.workHeader = true;
  f.write();
  const config = path.join(f.root, 'config/work-ledger.json');
  fs.mkdirSync(path.dirname(config));
  fs.writeFileSync(config, JSON.stringify({ roles: [{ role: 'role-a' }] }));
  const registry = f.load();
  const received = readAtDelivery(f);
  deliver(registry, f.deps);
  const noLedger = f.put('role-a', '01-missing.md');
  const unconfigured = f.put('role-b', '01-unconfigured.md');
  deliver(registry, f.deps);
  const file = ledgerPath(f.root, 'role-a');
  writeWorkLedger(file, 'role-a', []);
  f.put('role-a', '02-empty.md');
  deliver(registry, f.deps);
  fs.writeFileSync(file, '{"broken": PRIVATE');
  const broken = f.put('role-a', '03-broken.md');
  deliver(registry, f.deps);
  fs.rmSync(file);
  fs.mkdirSync(file);
  f.put('role-a', '04-unreadable.md');
  deliver(registry, f.deps);
  assert.deepEqual(received.map(attempt => attempt.body), [
    '[장부 읽기 실패: ENOENT]\n\nwake\n',
    'wake\n',
    '[내 장부 먼저]\n열린 업무 없음 — 이 글이 업무면 장부에 올릴 것\n\nwake\n',
    '[장부 읽기 실패: 잘못된 JSON]\n\nwake\n',
    '[장부 읽기 실패: EISDIR]\n\nwake\n',
  ]);
  assert.equal(received[1].file, unconfigured);
  assert.equal(fs.readFileSync(noLedger, 'utf8'), 'wake\n');
  assert.equal(fs.readFileSync(broken, 'utf8'), 'wake\n');
});

test('a via wake retries with the latest work header, keeping the original delivery key', t => {
  const f = setup(t);
  f.doc.delivery.workHeader = true;
  const outside = path.join(f.dir, 'extra');
  const source = path.join(outside, 'via-wake.md');
  const ledgerFile = path.join(f.root, 'custom.json');
  f.doc.roles['role-a'].ledger = ledgerFile;
  f.doc.roles['role-a'].extra_boxes = [{ path: outside, via: ['/opt/read'] }];
  f.write();
  const received = readAtDelivery(f);
  const run = f.deps.run;
  let found = false, reads = 0;
  f.deps.run = (bin, args, options) => {
    if (bin === '/opt/read' && args[0] === 'find') return found ? `${NOW / 1000}\tvia-wake.md\n` : '';
    if (bin === '/opt/read' && args[0] === 'cat') {
      assert.deepEqual(args, ['cat', source]);
      reads += 1;
      return Buffer.from('via body\n');
    }
    return run(bin, args, options);
  };
  const registry = f.load();
  const [role] = registry.roles;
  deliver(registry, f.deps);
  found = true;
  f.state.failOn = 'via-wake.md';
  writeWorkLedger(ledgerFile, role.id, [ledgerRow('first')]);
  assert.equal(deliver(registry, f.deps).roles[role.id].failed, 1);
  assert.deepEqual(Object.keys(readFailures(registry, role)), [source]);
  assert.equal(fs.existsSync(received[0].file), false);
  writeWorkLedger(ledgerFile, role.id, [ledgerRow('second')]);
  f.state.now += 61_000;
  f.state.failOn = null;
  assert.equal(deliver(f.load(), f.deps).roles[role.id].delivered, 1);
  assert.equal(readLedger(registry, role).has(source), true);
  assert.deepEqual(readFailures(registry, role), {});
  assert.equal(reads, 2);
  assert.ok(received.every(attempt => attempt.file !== source && attempt.body.endsWith('\n\nvia body\n')));
  assert.deepEqual(received.map(attempt => attempt.body.split('\n')[1].split(' | ')[0]), ['- first', '- second']);
  assert.equal(readLedger(registry, role).has(received[1].file), false);
});

test('real work-ledger wake files in the shared box only reach their addressed roles', async t => {
  const f = setup(t);
  const shared = path.join(f.root, '.agents/work/l4/wake');
  f.doc.wake_root = path.relative(f.root, shared);
  f.write();
  fs.mkdirSync(path.join(shared, 'role-b'), { recursive: true });
  const registry = f.load();
  deliver(registry, f.deps);
  for (const [i, { id: role }] of registry.roles.entries()) {
    const stamp = new Date(NOW + i).toISOString().replace(/\D/g, '');
    await writeLedgerWake(shared, { stamp, role, id: `task-${role}`, reason: '기한 넘음', title: role, details: '' });
  }
  const generated = fs.readdirSync(shared).filter(name => name.endsWith('.md')).sort();
  assert.equal(generated.length, 2);
  assert.match(generated[0], /-ledger-task-role-a-route-role-a\.md$/);
  assert.match(generated[1], /-ledger-task-role-b-route-role-b\.md$/);
  fs.writeFileSync(path.join(shared, 'unknown-route-unregistered.md'), 'unknown\n');
  assert.equal(deliver(registry, f.deps, { only: 'role-a' }).roles['role-a'].delivered, 1);
  assert.equal(deliver(registry, f.deps, { only: 'role-b' }).roles['role-b'].delivered, 1);
  assert.deepEqual(f.state.runs, [
    ['/opt/deliver', 'role-a', path.join(shared, generated[0])],
    ['/opt/deliver', 'role-b', path.join(shared, generated[1])],
  ]);
});

test('optional busy probe observes the pane while normal delivery continues', t => {
  const f = setup(t);
  f.doc.delivery.busy_probe = ['/opt/status', '{role}', '{pane}'];
  f.write();
  const registry = f.load();
  let status = 'busy';
  const run = f.deps.run;
  f.deps.run = (bin, args, options) => {
    if (bin !== '/opt/status') return run(bin, args, options);
    assert.deepEqual(args, ['role-a', 'w1:p1']);
    return status;
  };
  const onlyA = { only: 'role-a' };
  assert.equal(Object.hasOwn(deliver(registry, f.deps, onlyA).roles['role-a'], 'busy'), false);
  for (const [i, [reply, expected]] of [['busy', true], ['idle', false], ['', null]].entries()) {
    status = reply;
    f.put('role-a', `new-${i}.md`);
    assert.deepEqual(deliver(registry, f.deps, onlyA).roles['role-a'], { delivered: 1, failed: 0, pending: 0, busy: expected });
  }
});

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
  assert.throws(broken(doc => { doc.roles['role-b'].extra_boxes = [{ path: 'relative/box' }]; }), /extra_boxes path/);
  assert.throws(broken(doc => { doc.roles['role-b'].extra_boxes = [{ path: path.join(f.root, 'wake') }]; }), /duplicate wake box/);
  assert.throws(broken(doc => { doc.roles['role-b'].extra_boxes = [{ path: '/srv/other/wake', via: [] }]; }), /via must be a command prefix/);
  assert.throws(broken(doc => { doc.roles['role-b'].dm_channels = ['12']; }), /dm_channels/);
  assert.throws(broken(doc => { doc.roles['role-b'].dm_users = 'someone'; }), /dm_users/);
  assert.throws(broken(doc => { doc.delivery.baseline_seen_file = 'seen'; }), /baseline_seen_file/);
  assert.throws(broken(doc => { doc.role_views = 'bad'; }), /role_views must be an array/);
  assert.throws(broken(doc => { doc.role_views = [{ kind: 'session-health', path: '/tmp/h.json', roles: [] }]; }), /role_views roles/);
  assert.throws(broken(doc => { doc.role_views = [{ kind: 'session-health', path: '/tmp/h.json', roles: null }]; }), /role_views roles/);
  assert.throws(broken(doc => { doc.role_views = [{ kind: 'session-health', path: '/tmp/h.json', roles: 'role-a' }]; }), /role_views roles/);
  assert.throws(broken(doc => { doc.role_views = [{ kind: 'session-health', path: '/tmp/h.json', roles: ['   '] }]; }), /role_views roles/);
  assert.throws(broken(doc => { doc.role_views = [{ kind: 'session-health', path: '/tmp/h.json', roles: [123] }]; }), /role_views roles/);
});

test('tool detection reads the foreground program, not the registry', () => {
  const known = ['claude', 'agy', 'muse'];
  assert.deepEqual(detectTool([{ argv: ['/x/muse-bin-1.4.20', '--yolo', 'you are agy'] }], known), { alive: true, tool: 'muse' });
  assert.deepEqual(detectTool([{ argv: ['sudo', '-iu', 'svc', 'bash', '/opt/kit/agy-start-1.sh'] }], known), { alive: true, tool: 'agy' });
  assert.deepEqual(detectTool([{ cmdline: 'claude --resume abc' }], known), { alive: true, tool: 'claude' });
  assert.deepEqual(detectTool([{ argv: ['-bash'] }, { argv: ['sudo', '-iu', 'svc', 'bash'] }], known), { alive: false, tool: 'shell' });
  assert.deepEqual(detectTool([{ argv: ['vim', 'notes'] }], known), { alive: true, tool: 'unknown' });
  assert.deepEqual(detectTool([], known), { alive: false, tool: 'shell' });
  // An argument that looks like a tool name is not the program.
  assert.deepEqual(detectTool([{ argv: ['vim', 'claude.log'] }], known), { alive: true, tool: 'unknown' });
  assert.deepEqual(detectTool([{ argv: ['tail', '-f', '/var/log/agy-1.log'] }], known), { alive: true, tool: 'unknown' });
  assert.deepEqual(detectTool([{ argv: ['bash', '-c', 'claude --resume x'] }], known), { alive: true, tool: 'claude' });
  assert.deepEqual(detectTool([{ argv: ['env', '-u', 'TOKEN', 'A=1', 'timeout', '30', 'claude'] }], known), { alive: true, tool: 'claude' });
  assert.deepEqual(detectTool([{ argv: ['node', '/opt/tools/muse.mjs'] }, { argv: ['python3'] }], known), { alive: true, tool: 'muse' });
  assert.deepEqual(detectTool([{ argv: ['python3'] }], known), { alive: false, tool: 'shell' });
});

test('a wait script counts only under the pane agent', () => {
  const procs = [{ pid: 10, ppid: 1, args: 'claude' }, { pid: 11, ppid: 10, args: 'bash -c wrapper' }, { pid: 12, ppid: 11, args: 'bash /kit/wait.sh' }, { pid: 30, ppid: 1, args: 'bash /kit/wait.sh' }, { pid: 31, ppid: 10, args: 'bash /other/wait.sh' }, { pid: 32, ppid: 10, args: 'cat /kit/wait.sh' }];
  assert.equal(waitRunning(procs, '/kit/wait.sh', [10]), true);
  assert.equal(waitRunning(procs.filter(proc => proc.pid !== 12), '/kit/wait.sh', [10]), false);
  // Without the pane's pids nothing ties a script to the pane.
  assert.equal(waitRunning(procs, '/kit/wait.sh', []), false);
});

test('a pane without readable pids leaves the wait state unknown, not running', t => {
  const f = setup(t);
  const registry = f.load();
  deliver(registry, f.deps);
  f.state.panes['w1:p1'] = [{ argv: ['claude'] }];
  const report = inspect(registry, f.deps);
  assert.equal(report.rows[0].wait, 'unknown');
  // The role depends on the script, so "cannot tell" fails the check; an observed script only warns.
  assert.equal(report.findings.find(finding => finding.code === 'wait-unknown').level, 'error');
  f.doc.roles['role-a'].wait.mode = 'observe';
  f.write();
  assert.equal(inspect(f.load(), f.deps).findings.find(finding => finding.code === 'wait-unknown').level, 'warn');
  f.state.panes['w1:p1'] = [{ argv: ['claude'], pid: 10 }];
  f.deps.processes = () => { throw new Error('ps failed'); };
  assert.equal(inspect(registry, f.deps).findings.find(finding => finding.code === 'wait-unknown').level, 'error');
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

test('a failed file does not stop the files behind it, is reported at once and is retried with backoff', t => {
  const f = setup(t);
  const registry = f.load();
  deliver(registry, f.deps);
  f.put('role-a', '002-a.md', 0.003); f.put('role-a', '003-b.md', 0.002); f.put('role-b', '002-c.md');
  f.state.failOn = '002-a.md';
  assert.deepEqual(deliver(registry, f.deps).roles, { 'role-a': { delivered: 1, failed: 1, pending: 1 }, 'role-b': { delivered: 1, failed: 0, pending: 0 } });
  assert.equal(readLedger(registry, registry.roles[0]).has('003-b.md'), true);
  assert.equal(readLedger(registry, registry.roles[0]).has('002-a.md'), false);
  assert.equal(readFailures(registry, registry.roles[0])['002-a.md'].count, 1);
  // The check names the failure at once, however fresh the file is.
  const report = inspect(registry, f.deps);
  assert.ok(codes(report).includes('delivery-failed:role-a'));
  assert.equal(report.findings.find(finding => finding.code === 'delivery-failed').level, 'error');
  assert.equal(main(['deliver', '--config', f.file], {}, f.deps, () => {}), 1);
  // Inside the backoff the file is not tried again; after it, it is.
  const tries = () => f.state.runs.filter(run => run[2].endsWith('002-a.md')).length;
  assert.equal(tries(), 1);
  f.state.now = NOW + 61_000;
  deliver(registry, f.deps);
  assert.equal(tries(), 2);
  f.state.now = NOW + 122_000;
  deliver(registry, f.deps);
  assert.equal(tries(), 2);
  f.state.failOn = null;
  f.state.now = NOW + 400_000;
  assert.deepEqual(deliver(registry, f.deps).roles['role-a'], { delivered: 1, failed: 0, pending: 0 });
  assert.deepEqual(readFailures(registry, registry.roles[0]), {});
  assert.ok(!codes(inspect(registry, f.deps)).includes('delivery-failed:role-a'));
  assert.equal(main(['deliver', '--config', f.file], {}, f.deps, () => {}), 0);
});

test('the heartbeat separates "the runner ran" from "the run was clean"', t => {
  const f = setup(t);
  const registry = f.load();
  const heartbeat = () => JSON.parse(fs.readFileSync(path.join(registry.stateDir, 'deliver-heartbeat.json'), 'utf8'));
  deliver(registry, f.deps);
  assert.equal(heartbeat().ok_at, new Date(NOW).toISOString());
  f.put('role-a', '002-a.md');
  f.state.failOn = '002-a.md';
  f.state.now = NOW + 60_000;
  deliver(registry, f.deps);
  assert.equal(heartbeat().at, new Date(NOW + 60_000).toISOString());
  assert.equal(heartbeat().ok_at, new Date(NOW).toISOString());
  assert.deepEqual(codes(watch(registry, f.deps)), ['delivery-failed:role-a', 'tool-fallback:role-b']);
});

test('new files go before retries and a role that fails three in a row stops for that run only', t => {
  const f = setup(t);
  const registry = f.load();
  deliver(registry, f.deps);
  for (const [index, name] of ['010.md', '011.md', '012.md', '013.md', '014.md'].entries()) f.put('role-a', name, (10 - index) / 1000);
  f.put('role-b', '010.md');
  f.state.failOn = path.join(f.root, 'wake', '01');
  // The session is down: three tries, then the role waits for the next run; role-b is untouched.
  assert.deepEqual(deliver(registry, f.deps).roles, { 'role-a': { delivered: 0, failed: 3, pending: 5 }, 'role-b': { delivered: 1, failed: 0, pending: 0 } });
  assert.deepEqual(f.state.runs.filter(run => run[1] === 'role-a').map(run => path.basename(run[2])), ['010.md', '011.md', '012.md']);
  // Next run: the two untried files go first even though the first three are due again.
  f.state.failOn = '010.md';
  f.state.now = NOW + 301_000;
  f.state.runs.length = 0;
  assert.deepEqual(deliver(registry, f.deps).roles['role-a'], { delivered: 4, failed: 1, pending: 1 });
  assert.deepEqual(f.state.runs.map(run => path.basename(run[2])), ['013.md', '014.md', '010.md', '011.md', '012.md']);
});

test('a file that failed once is retried before files that keep failing', t => {
  const f = setup(t);
  const registry = f.load();
  deliver(registry, f.deps);
  for (const [index, name] of ['020-refused.md', '021-refused.md', '022-refused.md'].entries()) f.put('role-a', name, (10 - index) / 1000);
  f.state.failOn = 'refused';
  deliver(registry, f.deps);
  f.state.now = NOW + 61_000;
  deliver(registry, f.deps);
  // A later file fails once (the session blinked); the refused ones are older and all due again.
  f.put('role-a', '030-blink.md');
  f.state.failOn = '0';
  f.state.now = NOW + 400_000;
  deliver(registry, f.deps);
  f.state.failOn = 'refused';
  f.state.now = NOW + 800_000;
  f.state.runs.length = 0;
  assert.deepEqual(deliver(registry, f.deps).roles['role-a'], { delivered: 1, failed: 3, pending: 3 });
  assert.equal(path.basename(f.state.runs[0][2]), '030-blink.md');
});

test('a role whose delivery run breaks is named by the check, not hidden behind a fresh heartbeat', t => {
  const f = setup(t);
  f.doc.delivery.baseline_seen_file = path.join(f.dir, 'no-such-record');
  f.write();
  const registry = f.load();
  f.put('role-a', '001-new.md');
  assert.match(deliver(registry, f.deps).roles['role-a'].error, /ENOENT/);
  const report = inspect(registry, f.deps);
  assert.ok(!codes(report).includes('delivery-stale:'));
  assert.deepEqual(report.findings.filter(finding => finding.code === 'delivery-error').map(finding => [finding.role, finding.level]), [['role-a', 'error'], ['role-b', 'error']]);
  assert.equal(main(['check', '--config', f.file, '--json'], {}, f.deps, () => {}), 1);
  fs.writeFileSync(f.doc.delivery.baseline_seen_file, '');
  deliver(registry, f.deps);
  assert.ok(!codes(inspect(registry, f.deps)).includes('delivery-error:role-a'));
});

test('a role whose box cannot be read is reported and does not stop the other roles', t => {
  const f = setup(t);
  const registry = f.load();
  deliver(registry, f.deps);
  fs.rmSync(path.join(f.root, 'wake', 'role-b'), { recursive: true });
  f.put('role-a', '002-new.md');
  const result = deliver(registry, f.deps);
  assert.deepEqual(result.roles['role-a'], { delivered: 1, failed: 0, pending: 0 });
  assert.match(result.roles['role-b'].error, /role-b: not found/);
  assert.equal(main(['deliver', '--config', f.file], {}, f.deps, () => {}), 1);
  const report = inspect(registry, f.deps);
  assert.ok(codes(report).includes('box-unreadable:role-b'));
  assert.equal(report.rows[1].box, null);
  assert.match(boardSection(report), /\| unreadable \|/);
  assert.equal(sweep(registry, f.deps, { apply: true }).roles['role-a'].moved, 0);
});

test('delivery and the table follow arrival time, not file names', t => {
  const f = setup(t);
  const registry = f.load();
  deliver(registry, f.deps);
  // Three naming styles in one box: epoch ms, a date stamp, a free title.
  f.put('role-b', 'old-title-note.md', 5);
  f.put('role-b', '20260109000000000-date-stamp.md', 1);
  f.put('role-b', '1767916800000-epoch.md', 0.001);
  deliver(registry, f.deps);
  assert.deepEqual(f.state.runs.map(run => path.basename(run[2])), ['old-title-note.md', '20260109000000000-date-stamp.md', '1767916800000-epoch.md']);
  f.put('role-b', 'another-title.md', 0.01);
  const row = inspect(registry, f.deps).rows[1];
  assert.equal(Math.round(row.newestMs), NOW - 0.001 * DAY);
  assert.equal(Math.round(row.oldestPendingMs), NOW - 0.01 * DAY);
});

test('delivery skips a run while a live owner holds the lock and reclaims a dead, empty or damaged one', t => {
  const f = setup(t);
  const registry = f.load();
  const lock = path.join(registry.stateDir, 'deliver.lock');
  fs.mkdirSync(registry.stateDir, { recursive: true });
  fs.writeFileSync(lock, String(process.pid));
  assert.deepEqual(deliver(registry, f.deps), { skipped: 'locked' });
  // A live pid with no start time cannot be told from a recycled one: such a lock holds only while it is recent.
  for (const unverified of [String(process.pid), JSON.stringify({ pid: process.pid }), '1']) {
    fs.writeFileSync(lock, unverified);
    assert.deepEqual(deliver(registry, f.deps), { skipped: 'locked' }, `fresh lock ${unverified}`);
    fs.utimesSync(lock, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    assert.ok(deliver(registry, f.deps).roles, `old lock ${unverified}`);
  }
  // A lock this version wrote, whose owner is alive, holds however old it is.
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, start: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] }));
  fs.utimesSync(lock, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
  assert.deepEqual(deliver(registry, f.deps), { skipped: 'locked' });
  // A pid that is alive but was started at another time is someone else's recycled pid.
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, start: 'another-start' }));
  assert.ok(deliver(registry, f.deps).roles);
  for (const stale of ['2147483646', '', 'not a pid', '0', '-1', '{"pid":"x"}']) {
    fs.writeFileSync(lock, stale);
    assert.ok(deliver(registry, f.deps).roles, `lock ${JSON.stringify(stale)}`);
    assert.equal(fs.existsSync(lock), false);
  }
  assert.deepEqual(fs.readdirSync(registry.stateDir).filter(name => name.startsWith('deliver.lock')), []);
});

test('an extra box outside root is delivered, through its reader command when it has one', t => {
  const f = setup(t);
  const open = path.join(f.dir, 'other-open'), closed = '/srv/other-owner/wake';
  fs.mkdirSync(open);
  f.doc.roles['role-b'].extra_boxes = [{ path: open }, { path: closed, via: ['sudo', '-n'] }];
  f.write();
  const registry = f.load();
  const remote = {};
  const delivered = [];
  const run = f.deps.run;
  f.deps.run = (command, args) => {
    if (command === 'sudo' && args[1] === 'find') { assert.equal(args[2], closed); return Object.entries(remote).map(([name, item]) => `${item.at / 1000}\t${name}\n`).join(''); }
    if (command === 'sudo' && args[1] === 'cat') { const item = remote[path.basename(args[2])]; if (!item) throw new Error('exit 1'); return item.body; }
    if (command === '/opt/deliver') delivered.push([args[0], args[1], fs.readFileSync(args[1], 'utf8')]);
    return run(command, args);
  };
  remote['001-before.md'] = { at: NOW - DAY, body: 'before\n' };
  fs.writeFileSync(path.join(open, '001-before.md'), 'before\n');
  assert.deepEqual(deliver(registry, f.deps).roles['role-b'], { baseline: 2, delivered: 0, failed: 0, pending: 0 });
  remote['002-letter.md'] = { at: NOW + 2000, body: 'letter draft\n' };
  fs.writeFileSync(path.join(open, '003-open.md'), 'open box\n');
  fs.utimesSync(path.join(open, '003-open.md'), new Date(NOW + 1000), new Date(NOW + 1000));
  assert.deepEqual(deliver(registry, f.deps).roles['role-b'], { delivered: 2, failed: 0, pending: 0 });
  const spool = path.join(registry.stateDir, 'spool', 'role-b', '002-letter.md');
  assert.deepEqual(delivered, [['role-b', path.join(open, '003-open.md'), 'open box\n'], ['role-b', spool, 'letter draft\n']]);
  assert.equal(fs.existsSync(spool), false);
  assert.equal(readLedger(registry, registry.roles[1]).has(path.join(closed, '002-letter.md')), true);
  deliver(registry, f.deps);
  assert.equal(delivered.length, 2);
  const row = inspect(registry, f.deps).rows[1];
  assert.deepEqual([row.box, row.pending], [4, 0]);
  // Extra boxes are another owner's: sweep counts them and moves nothing.
  f.state.now = NOW + 30 * DAY;
  assert.deepEqual(sweep(registry, f.deps, { apply: true }).roles['role-b'], { moved: 0, undelivered: 0, recent: 0, external: 4 });
  assert.equal(fs.existsSync(path.join(open, '003-open.md')), true);
  // A reader that fails is an error on that box only.
  f.deps.run = (command, args) => { if (command === 'sudo') throw new Error('sudo: a password is required'); return run(command, args); };
  f.put('role-b', '009-own.md');
  f.state.now = NOW;
  const result = deliver(registry, f.deps).roles['role-b'];
  assert.equal(result.delivered, 1);
  assert.match(result.error, /\/srv\/other-owner\/wake: unreadable/);
  assert.ok(codes(inspect(registry, f.deps)).includes('box-unreadable:role-b'));
});

test('an extra box added to a role that already delivers is recorded, not replayed', t => {
  const f = setup(t);
  f.put('role-b', '001-own.md');
  deliver(f.load(), f.deps);
  const added = path.join(f.dir, 'added-box');
  fs.mkdirSync(added);
  fs.writeFileSync(path.join(added, '001-history.md'), 'old\n'); fs.writeFileSync(path.join(added, '002-history.md'), 'old\n');
  f.doc.roles['role-b'].extra_boxes = [{ path: added }];
  f.write();
  const registry = f.load();
  assert.deepEqual(deliver(registry, f.deps).roles['role-b'], { baseline: 2, delivered: 0, failed: 0, pending: 0 });
  assert.equal(f.state.runs.length, 0);
  fs.writeFileSync(path.join(added, '003-new.md'), 'new\n');
  assert.deepEqual(deliver(registry, f.deps).roles['role-b'], { delivered: 1, failed: 0, pending: 0 });
  assert.deepEqual(f.state.runs.map(run => run[2]), [path.join(added, '003-new.md')]);
  // A box that cannot be read on its first look is looked at again later, still without a replay.
  const late = path.join(f.dir, 'late-box');
  f.doc.roles['role-b'].extra_boxes.push({ path: late });
  f.write();
  assert.match(deliver(f.load(), f.deps).roles['role-b'].error, /late-box: not found/);
  fs.mkdirSync(late);
  fs.writeFileSync(path.join(late, '001-history.md'), 'old\n');
  assert.deepEqual(deliver(f.load(), f.deps).roles['role-b'], { baseline: 1, delivered: 0, failed: 0, pending: 0 });
  assert.equal(f.state.runs.length, 1);
});

test('taking over from an old deliverer keeps its record and delivers what it had not', t => {
  const f = setup(t);
  const seenFile = path.join(f.dir, 'old-seen');
  const done = f.put('role-a', '001-done.md', 2), left = f.put('role-a', '002-left.md', 1);
  f.put('role-b', '001-left.md');
  fs.writeFileSync(seenFile, `${done}\n/some/other/file.md\n\n`);
  f.doc.delivery.baseline_seen_file = seenFile;
  f.write();
  const registry = f.load();
  assert.deepEqual(deliver(registry, f.deps).roles, { 'role-a': { baseline: 1, delivered: 1, failed: 0, pending: 0 }, 'role-b': { baseline: 0, delivered: 1, failed: 0, pending: 0 } });
  assert.deepEqual(f.state.runs.map(run => run[2]), [left, path.join(f.root, 'wake', 'role-b', '001-left.md')]);
  deliver(registry, f.deps);
  assert.equal(f.state.runs.length, 2);
  // The same record decides for an extra box, whenever that box is first seen.
  const extra = path.join(f.dir, 'extra-box');
  fs.mkdirSync(extra);
  fs.writeFileSync(path.join(extra, '001-done.md'), 'x\n'); fs.writeFileSync(path.join(extra, '002-left.md'), 'x\n');
  fs.appendFileSync(seenFile, `${path.join(extra, '001-done.md')}\n`);
  f.doc.roles['role-b'].extra_boxes = [{ path: extra }];
  f.write();
  assert.deepEqual(deliver(f.load(), f.deps).roles['role-b'], { baseline: 1, delivered: 1, failed: 0, pending: 0 });
  assert.equal(f.state.runs.at(-1)[2], path.join(extra, '002-left.md'));
  delete f.doc.roles['role-b'].extra_boxes;
  f.write();
  // A configured record that is missing stops the takeover instead of swallowing the box.
  fs.rmSync(registry.stateDir, { recursive: true });
  fs.rmSync(seenFile);
  f.put('role-a', '003-new.md');
  assert.match(deliver(registry, f.deps).roles['role-a'].error, /ENOENT/);
  assert.equal(readLedger(registry, registry.roles[0]), null);
});

test('each registered DM room needs a recent REST catch-up from the gateway tool', t => {
  const f = setup(t);
  const roomA = '300000000000000001', roomB = '300000000000000002';
  f.doc.roles['role-b'].dm_channels = [roomA, roomB];
  f.doc.dm_backup = { max_age_seconds: 600 };
  f.write();
  const registry = f.load();
  deliver(registry, f.deps);
  const stale = () => inspect(registry, f.deps).findings.filter(finding => finding.code === 'dm-backup-stale').map(finding => [finding.role, finding.level, finding.detail]);
  assert.deepEqual(stale().map(row => row[2]), [`DM room ${roomA} has never been caught up`, `DM room ${roomB} has never been caught up`]);
  const state = { dm: { [roomA]: { last: '1', okAt: new Date(NOW - 60_000).toISOString() }, [roomB]: { last: '1', okAt: new Date(NOW - 1_200_000).toISOString(), error: { status: 403 } } } };
  fs.writeFileSync(path.join(f.root, 'wake', 'role-b', '.bot-mention-wake-state.json'), JSON.stringify(state));
  assert.deepEqual(stale(), [['role-b', 'error', `DM room ${roomB} last caught up 20m ago, last error 403`]]);
  // A room named by the person on the other side is checked once the gateway tool has found it.
  f.doc.roles['role-a'].dm_users = ['400000000000000001'];
  f.write();
  const byUser = () => inspect(f.load(), f.deps).findings.filter(finding => finding.code === 'dm-backup-stale' && finding.role === 'role-a').map(finding => finding.detail);
  assert.deepEqual(byUser(), ['DM room of user 400000000000000001 is not resolved']);
  const roomC = '300000000000000003';
  fs.writeFileSync(path.join(f.root, 'wake', '.bot-mention-wake-state.json'), JSON.stringify({ dmUsers: { '400000000000000001': { channel: roomC } }, dm: { [roomC]: {} } }));
  assert.deepEqual(byUser(), [`DM room ${roomC} has never been caught up`]);
  fs.writeFileSync(path.join(f.root, 'wake', '.bot-mention-wake-state.json'), JSON.stringify({ dmUsers: { '400000000000000001': { channel: roomC } }, dm: { [roomC]: { okAt: new Date(NOW).toISOString() } } }));
  assert.deepEqual(byUser(), []);
  delete f.doc.roles['role-a'].dm_users;
  // The gateway tool's own role list must name the rooms too.
  const view = path.join(f.dir, 'mention.json');
  fs.writeFileSync(view, JSON.stringify({ roles: [{ id: 'role-a', botUserId: botA }, { id: 'role-b', botUserId: botB, dmChannelIds: [roomA] }] }));
  f.doc.role_views = [{ kind: 'bot-mention-wake', path: view }];
  f.write();
  assert.deepEqual(compareViews(f.load()).map(finding => `${finding.role}|${finding.detail.split(': ')[1]}`), ['role-b|dm_channels differ']);
  f.doc.roles['role-a'].dm_users = ['400000000000000001'];
  f.write();
  assert.deepEqual(compareViews(f.load()).map(finding => `${finding.role}|${finding.detail.split(': ')[1]}`), ['role-a|dm_users differ', 'role-b|dm_channels differ']);
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
  // The role depends on a `nudge` wait script even when delivery runs.
  assert.equal(report.findings.find(finding => finding.code === 'wait-down').level, 'error');
  assert.equal(main(['check', '--config', f.file, '--json'], {}, f.deps, () => {}), 1);

  delete f.state.panes['w1:p2'];
  fs.rmSync(f.waitScript);
  assert.ok(codes(inspect(registry, f.deps)).includes('pane-unreadable:role-b'));
  assert.ok(codes(inspect(registry, f.deps)).includes('wait-script-missing:role-a'));
});

test('a stopped nudge wait script alone fails the check while delivery runs; an observed one warns', t => {
  const f = setup(t);
  f.doc.roles['role-b'].wait = { script: f.waitScript, mode: 'observe' };
  f.write();
  const registry = f.load();
  deliver(registry, f.deps);
  assert.equal(main(['check', '--config', f.file, '--json'], {}, f.deps, () => {}), 0);
  f.state.processes = f.state.processes.filter(proc => proc.pid !== 11);
  const findings = inspect(registry, f.deps).findings.filter(finding => finding.code === 'wait-down');
  assert.deepEqual(findings.map(finding => [finding.role, finding.level]), [['role-a', 'error'], ['role-b', 'warn']]);
  assert.equal(main(['check', '--config', f.file, '--json'], {}, f.deps, () => {}), 1);
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

test('role_views with roles scopes missing checks while still checking rows and unknown roles', t => {
  const f = setup(t);
  const view = (name, body) => { const file = path.join(f.dir, name); fs.writeFileSync(file, JSON.stringify(body)); return file; };
  const partial = view('health-partial.json', { roles: [{ id: 'role-a', botId: botA }] });
  const fmt = findings => findings.map(finding => `${finding.level}|${finding.code}|${finding.role}|${finding.detail.split(' ')[0]}|${finding.detail.split(': ')[1]}`);

  // roles present + partial list passes
  f.doc.role_views = [{ kind: 'session-health', path: partial, roles: ['role-a'] }];
  f.write();
  assert.deepEqual(compareViews(f.load()), []);
  assert.equal(main(['validate', '--config', f.file], {}, f.deps, () => {}), 0);
  deliver(f.load(), f.deps);
  assert.equal(main(['check', '--config', f.file, '--json'], {}, f.deps, () => {}), 0);

  // rows outside roles are still compared when present (matching passes; mismatch/unknown errors)
  const withExtraOk = view('health-extra-ok.json', { roles: [{ id: 'role-a', botId: botA }, { id: 'role-b', botId: botB }] });
  f.doc.role_views = [{ kind: 'session-health', path: withExtraOk, roles: ['role-a'] }];
  f.write();
  assert.deepEqual(compareViews(f.load()), []);

  const withExtraBad = view('health-extra-bad.json', { roles: [{ id: 'role-a', botId: botA }, { id: 'role-b', botId: botA }, { id: 'role-c', botId: botB }] });
  f.doc.role_views = [{ kind: 'session-health', path: withExtraBad, roles: ['role-a'] }];
  f.write();
  assert.deepEqual(fmt(compareViews(f.load())), [
    'error|role-view-drift|role-b|session-health|bot_id differ',
    'error|role-view-drift|role-c|session-health|role is not in the registry',
  ]);

  // role listed in roles is missing -> error (only listed roles are required)
  const emptyHealth = view('health-empty.json', { roles: [] });
  f.doc.role_views = [{ kind: 'session-health', path: emptyHealth, roles: ['role-a'] }];
  f.write();
  assert.deepEqual(fmt(compareViews(f.load())), ['error|role-view-drift|role-a|session-health|role is missing']);

  f.doc.role_views = [{ kind: 'session-health', path: partial, roles: ['role-a', 'role-b'] }];
  f.write();
  assert.deepEqual(fmt(compareViews(f.load())), ['error|role-view-drift|role-b|session-health|role is missing']);
  assert.equal(main(['check', '--config', f.file, '--json'], {}, f.deps, () => {}), 1);

  // unknown id in roles -> error (catches config typos)
  f.doc.role_views = [{ kind: 'session-health', path: partial, roles: ['role-a', 'role-typo'] }];
  f.write();
  assert.deepEqual(fmt(compareViews(f.load())), ['error|role-view-drift|role-typo|session-health|role in role_views is not in the registry']);
  assert.equal(main(['check', '--config', f.file, '--json'], {}, f.deps, () => {}), 1);

  // roles omitted -> existing full-registry behavior preserved
  f.doc.role_views = [{ kind: 'session-health', path: partial }];
  f.write();
  assert.deepEqual(fmt(compareViews(f.load())), ['error|role-view-drift|role-b|session-health|role is missing']);
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

test('sweep keeps going past an archive name collision and past a role in trouble', t => {
  const f = setup(t, { retention: { delivered_days: 3, archive_dir: 'wake-archive' } });
  const registry = f.load();
  f.put('role-a', '001-dup.md', 5); f.put('role-a', '002-ok.md', 5); f.put('role-b', '001-clean.md', 5);
  deliver(registry, f.deps);
  const stamp = new Date(NOW - 5 * DAY).toISOString().slice(0, 10).replaceAll('-', '');
  const folder = path.join(f.root, 'wake-archive', '_top', stamp);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, '001-dup.md'), 'earlier\n');
  const result = sweep(registry, f.deps, { apply: true }).roles;
  assert.deepEqual(result, { 'role-a': { moved: 2, undelivered: 0, recent: 0 }, 'role-b': { moved: 1, undelivered: 0, recent: 0 } });
  assert.deepEqual(fs.readdirSync(folder).sort(), ['001-dup.dup1.md', '001-dup.md', '002-ok.md']);
  assert.equal(fs.readFileSync(path.join(folder, '001-dup.md'), 'utf8'), 'earlier\n');
  assert.equal(fs.existsSync(path.join(f.root, 'wake', 'role-b', '001-clean.md')), false);
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
  const registry = loadRegistry(example);
  assert.deepEqual(registry.roles.map(role => role.id), ['role-a', 'role-b']);
  assert.deepEqual(registry.roleViews.map(view => ({ kind: view.kind, roles: view.roles })), [
    { kind: 'wake-routes', roles: null },
    { kind: 'session-health', roles: ['role-a'] },
  ]);
});

test('wakes for the same discord message are delivered once, merged', t => {
  const f = setup(t);
  const registry = f.load();
  deliver(registry, f.deps);
  const box = path.join(f.root, 'wake');
  const gw = path.join(box, '0001-100000000000000001-gw.md');
  const route = path.join(box, '0002-100000000000000001-route-role-a.md');
  const solo = path.join(box, '0003-100000000000000002-gw.md');
  fs.writeFileSync(gw, '# Discord wake\nMessage ID: 100000000000000001\nbody one\n');
  fs.writeFileSync(route, '[relay] https://discord.com/channels/1/2/100000000000000001\n');
  fs.writeFileSync(solo, '# Discord wake\nMessage ID: 100000000000000002\nsolo\n');
  for (const file of [gw, route, solo]) fs.utimesSync(file, new Date(NOW), new Date(NOW));
  assert.deepEqual(deliver(registry, f.deps).roles, {
    'role-a': { delivered: 2, failed: 0, pending: 0 },
    'role-b': { delivered: 0, failed: 0, pending: 0 },
  });
  assert.equal(f.state.runs.length, 2);
  assert.ok(f.state.runs[0][2].endsWith('.merged.md'));
  assert.equal(f.state.runs[1][2], solo);
  assert.deepEqual([...readLedger(registry, registry.roles[0])].filter(key => !key.startsWith('message:')).sort(), [gw, route, solo].map(file => path.basename(file)).sort());
  deliver(registry, f.deps);
  assert.equal(f.state.runs.length, 2);
});

test('ledger cards with one source message keep separate delivery attempts', t => {
  const f = setup(t);
  const registry = f.load();
  deliver(registry, f.deps);
  for (const id of ['card-a', 'card-b']) {
    const file = f.put('role-a', `0001-ledger-${id}-route-role-a.md`);
    fs.writeFileSync(file, `[장부] ${id}\n출처: 100000000000000003/100000000000000001\n`);
  }
  const result = deliver(registry, f.deps).roles['role-a'];
  assert.equal(result.delivered, 2);
  assert.equal(result.pending, 0);
  assert.equal(f.state.runs.length, 2);
  assert.ok(f.state.runs.every(run => !run[2].endsWith('.merged.md')));
});

test('oversized duplicate groups deliver complete originals without truncation', t => {
  const f = setup(t);
  const registry = f.load();
  deliver(registry, f.deps);
  const files = ['0001-100000000000000001-gw.md', '0002-100000000000000001-route-role-a.md'].map(name => f.put('role-a', name));
  const bodies = files.map((file, i) => `${i}`.repeat(20000));
  files.forEach((file, i) => fs.writeFileSync(file, bodies[i]));
  const received = [];
  f.deps.run = (command, args) => received.push(fs.readFileSync(args[1], 'utf8'));
  assert.equal(deliver(registry, f.deps).roles['role-a'].delivered, 2);
  assert.deepEqual(received, bodies);
  assert.equal(readLedger(registry, registry.roles[0]).size, 2);
});

test('bounded delivery leaves no unattempted merged spool files', t => {
  const f = setup(t);
  f.doc.delivery.max_per_run = 1;
  f.write();
  const registry = f.load();
  deliver(registry, f.deps);
  for (const id of ['100000000000000001', '100000000000000002']) {
    f.put('role-a', `0001-${id}-gw.md`);
    f.put('role-a', `0002-${id}-route-role-a.md`);
  }
  assert.equal(deliver(registry, f.deps).roles['role-a'].pending, 2);
  assert.deepEqual(fs.readdirSync(path.join(f.dir, 'state', 'spool', 'role-a')), []);
  assert.equal(deliver(registry, f.deps).roles['role-a'].pending, 0);
  assert.deepEqual(fs.readdirSync(path.join(f.dir, 'state', 'spool', 'role-a')), []);
});

test('failed merged delivery retains every member for retry and cleans its spool', t => {
  const f = setup(t);
  const registry = f.load();
  deliver(registry, f.deps);
  const first = f.put('role-a', '0001-100000000000000001-gw.md');
  const second = f.put('role-a', '0002-100000000000000001-route-role-a.md');
  f.state.failOn = '.merged.md';
  const failed = deliver(registry, f.deps).roles['role-a'];
  assert.deepEqual(failed, { delivered: 0, failed: 2, pending: 2 });
  assert.equal(readLedger(registry, registry.roles[0]).size, 0);
  assert.ok(fs.existsSync(first) && fs.existsSync(second));
  assert.deepEqual(fs.readdirSync(path.join(f.dir, 'state', 'spool', 'role-a')), []);
  f.state.now += 60000;
  f.state.failOn = null;
  assert.deepEqual(deliver(registry, f.deps).roles['role-a'], { delivered: 1, failed: 0, pending: 0 });
  assert.equal(readLedger(registry, registry.roles[0]).size, 3);
});

test('a duplicate relay arriving in a later run is recorded without another input', t => {
  const f = setup(t);
  const registry = f.load();
  deliver(registry, f.deps);
  f.put('role-a', '0001-100000000000000001-gw.md');
  assert.equal(deliver(registry, f.deps).roles['role-a'].delivered, 1);
  f.put('role-a', '0002-100000000000000001-route-role-a.md');
  assert.deepEqual(deliver(registry, f.deps).roles['role-a'], { delivered: 0, failed: 0, pending: 0 });
  assert.equal(f.state.runs.length, 1);
  assert.ok(readLedger(registry, registry.roles[0]).has('0002-100000000000000001-route-role-a.md'));
});

test('cross-run message receipts survive retention of the original relay', t => {
  const f = setup(t);
  const registry = f.load();
  deliver(registry, f.deps);
  const first = f.put('role-a', '0001-100000000000000001-gw.md');
  deliver(registry, f.deps);
  fs.unlinkSync(first);
  f.put('role-a', '0002-100000000000000001-route-role-a.md');
  assert.equal(deliver(registry, f.deps).roles['role-a'].delivered, 0);
  assert.equal(f.state.runs.length, 1);
});

test('oversized groups crossing the run limit preserve every original body', t => {
  const f = setup(t);
  f.doc.delivery.max_per_run = 1;
  f.write();
  const registry = f.load();
  deliver(registry, f.deps);
  const first = f.put('role-a', '0001-100000000000000001-gw.md');
  const second = f.put('role-a', '0002-100000000000000001-route-role-a.md');
  fs.writeFileSync(first, 'a'.repeat(20000));
  fs.writeFileSync(second, 'b'.repeat(20000));
  const received = [];
  f.deps.run = (command, args) => received.push(fs.readFileSync(args[1], 'utf8'));
  assert.equal(deliver(registry, f.deps).roles['role-a'].pending, 1);
  assert.equal(deliver(registry, f.deps).roles['role-a'].pending, 0);
  assert.deepEqual(received, ['a'.repeat(20000), 'b'.repeat(20000)]);
});


test('a ledger notice remains deliverable after its source Discord message was delivered', t => {
  const f = setup(t);
  const registry = f.load();
  deliver(registry, f.deps);
  f.put('role-a', '0001-100000000000000001-gw.md');
  deliver(registry, f.deps);
  const ledger = f.put('role-a', '0002-ledger-card-a-route-role-a.md');
  fs.writeFileSync(ledger, '[장부] overdue card a\n출처: 100000000000000003/100000000000000001\n');
  assert.deepEqual(deliver(registry, f.deps).roles['role-a'], { delivered: 1, failed: 0, pending: 0 });
  assert.equal(f.state.runs.length, 2);
  assert.equal(f.state.runs[1][2], ledger);
});


test('legacy successful filename receipts suppress a later relay after upgrade', t => {
  const f = setup(t);
  const registry = f.load();
  deliver(registry, f.deps);
  fs.appendFileSync(path.join(f.dir, 'state', 'delivered-role-a.jsonl'), JSON.stringify({
    file: '0001-100000000000000001-gw.md', at: new Date(NOW).toISOString(), status: 'delivered',
  }) + '\n');
  f.put('role-a', '0002-100000000000000001-route-role-a.md');
  assert.deepEqual(deliver(registry, f.deps).roles['role-a'], { delivered: 0, failed: 0, pending: 0 });
  assert.equal(f.state.runs.length, 0);
});

test('legacy baseline rows leave new source-message relays deliverable', t => {
  const f = setup(t);
  const registry = f.load();
  f.put('role-a', '0001-100000000000000001-gw.md');
  deliver(registry, f.deps);
  f.put('role-a', '0002-100000000000000001-route-role-a.md');
  assert.equal(deliver(registry, f.deps).roles['role-a'].delivered, 1);
  assert.equal(f.state.runs.length, 1);
});


test('real stalled ledger notices read their body before considering a filename id', t => {
  const f = setup(t);
  const registry = f.load();
  deliver(registry, f.deps);
  const names = [
    '100000000000000004-stalled-adk-canonical-100000000000000005-route-role-a.md',
    '100000000000000006-stalled-adk-canonical-100000000000000005-route-role-a.md',
  ];
  for (const name of names) {
    const file = f.put('role-a', name);
    fs.writeFileSync(file, '[장부] 멈춘 카드: 하네스북 기준 naia-adk 복구\n역할: alpha\n카드 id: adk-canonical-100000000000000005\n');
    assert.equal(deliver(registry, f.deps).roles['role-a'].delivered, 1);
  }
  assert.equal(f.state.runs.length, 2);
});

test('a ledger body overrides a filename that matches the direct relay format', t => {
  const f = setup(t);
  const registry = f.load();
  deliver(registry, f.deps);
  for (const stamp of ['0001', '0002']) {
    const file = f.put('role-a', `${stamp}-100000000000000001-route-role-a.md`);
    fs.writeFileSync(file, '[장부] overdue\n출처: 100000000000000003/100000000000000001\n');
    assert.equal(deliver(registry, f.deps).roles['role-a'].delivered, 1);
  }
  assert.equal(f.state.runs.length, 2);
});

test('notes referring to one source link retain their separate delivery attempts', t => {
  const f = setup(t);
  const registry = f.load();
  deliver(registry, f.deps);
  for (const name of ['0001-note.md', '0002-note.md']) {
    const file = f.put('role-a', name);
    fs.writeFileSync(file, `Evidence for ${name} https://discord.com/channels/1/2/100000000000000001\n`);
    assert.equal(deliver(registry, f.deps).roles['role-a'].delivered, 1);
  }
});

test('merged relays preserve the matching-source work header and both original bodies', t => {
  const f = setup(t);
  f.doc.delivery.workHeader = true;
  f.doc.roles['role-a'].ledger = 'custom.json';
  f.write();
  writeWorkLedger(path.join(f.root, 'custom.json'), 'role-a', [
    ledgerRow('original'),
    ledgerRow('recent', { from: { channel: '', msg_id: '-', quote: '' }, due: '2026-01-12T00:00:00Z' }),
  ]);
  const registry = f.load();
  const received = readAtDelivery(f);
  deliver(registry, f.deps);
  const route = f.put('role-a', `0001-${ORIGINAL_MESSAGE}-route-role-a.md`);
  const gw = f.put('role-a', `0002-${ORIGINAL_MESSAGE}-gw.md`);
  const routeBody = 'Relay copy with no source metadata\n';
  const gatewayBody = `# Discord wake\n\nRole: role-a\nChannel: general (${SOURCE_CHANNEL})\nAuthor: Human\nMessage ID: ${ORIGINAL_MESSAGE}\n\nOriginal request\n`;
  fs.writeFileSync(route, routeBody);
  fs.writeFileSync(gw, gatewayBody);
  assert.equal(deliver(registry, f.deps).roles['role-a'].delivered, 1);
  assert.equal(received.length, 1);
  assert.ok(received[0].body.startsWith('[내 장부 먼저]\n- original | open |'));
  assert.ok(received[0].body.includes(routeBody) && received[0].body.includes(gatewayBody));
  assert.equal(fs.readFileSync(route, 'utf8'), routeBody);
  assert.equal(fs.readFileSync(gw, 'utf8'), gatewayBody);
  assert.deepEqual(fs.readdirSync(path.join(registry.stateDir, 'spool', 'role-a')), []);
});

test('merged via relays retry with fresh work headers and preserve original receipt keys', t => {
  const f = setup(t);
  f.doc.delivery.workHeader = true;
  const outside = path.join(f.dir, 'remote');
  const ledger = path.join(f.root, 'custom.json');
  f.doc.roles['role-a'].ledger = ledger;
  f.doc.roles['role-a'].extra_boxes = [{ path: outside, via: ['/opt/read'] }];
  f.write();
  const names = [`0001-${ORIGINAL_MESSAGE}-gw.md`, `0002-${ORIGINAL_MESSAGE}-route-role-a.md`];
  const bodies = [
    `# Discord wake\n\nRole: role-a\nChannel: general (${SOURCE_CHANNEL})\nAuthor: Human\nMessage ID: ${ORIGINAL_MESSAGE}\n\nRequest\n`,
    'Relayed request\n',
  ];
  let found = false, reads = 0;
  const received = readAtDelivery(f);
  const run = f.deps.run;
  f.deps.run = (command, args, options) => {
    if (command === '/opt/read' && args[0] === 'find') return found ? names.map(name => `${NOW / 1000}\t${name}\n`).join('') : '';
    if (command === '/opt/read' && args[0] === 'cat') {
      reads += 1;
      return Buffer.from(bodies[names.indexOf(path.basename(args[1]))]);
    }
    return run(command, args, options);
  };
  const registry = f.load();
  deliver(registry, f.deps);
  found = true;
  writeWorkLedger(ledger, 'role-a', [ledgerRow('first')]);
  f.state.failOn = names[0];
  assert.equal(deliver(registry, f.deps).roles['role-a'].failed, 2);
  assert.equal(readLedger(registry, registry.roles[0]).has(path.join(outside, names[0])), false);
  writeWorkLedger(ledger, 'role-a', [ledgerRow('second')]);
  f.state.now += 61_000;
  f.state.failOn = null;
  assert.deepEqual(deliver(registry, f.deps).roles['role-a'], { delivered: 1, failed: 0, pending: 0 });
  assert.equal(reads, 4);
  assert.ok(received[0].body.startsWith('[내 장부 먼저]\n- first |'));
  assert.ok(received[1].body.startsWith('[내 장부 먼저]\n- second |'));
  for (const name of names) assert.equal(readLedger(registry, registry.roles[0]).has(path.join(outside, name)), true);
  assert.deepEqual(fs.readdirSync(path.join(registry.stateDir, 'spool', 'role-a')), []);
});

test('grouped delivery keeps role routing and the configured busy observation', t => {
  const f = setup(t);
  f.doc.delivery.busy_probe = ['/opt/probe', '{role}'];
  f.write();
  const received = readAtDelivery(f);
  const run = f.deps.run;
  const probed = [];
  f.deps.run = (command, args, options) => {
    if (command === '/opt/probe') { probed.push(args[0]); return 'busy'; }
    return run(command, args, options);
  };
  const registry = f.load();
  deliver(registry, f.deps);
  for (const role of ['role-a', 'role-b']) {
    for (const stamp of ['0001', '0002']) {
      const file = path.join(f.root, 'wake', `${stamp}-${ORIGINAL_MESSAGE}-route-${role}.md`);
      fs.writeFileSync(file, `Wake for ${role}\n`);
    }
  }
  const result = deliver(registry, f.deps).roles;
  for (const role of ['role-a', 'role-b']) assert.deepEqual(result[role], { delivered: 1, failed: 0, pending: 0, busy: true });
  assert.deepEqual(probed, ['role-a', 'role-b']);
  assert.equal(received.length, 2);
  for (const attempt of received) {
    assert.ok(attempt.body.includes(`Wake for ${attempt.role}`));
    assert.ok(!attempt.body.includes(`Wake for ${attempt.role === 'role-a' ? 'role-b' : 'role-a'}`));
  }
});
