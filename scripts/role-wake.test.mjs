import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as roleWake from './role-wake.mjs';

const { boardSection, compareViews, deliver, detectTool, inspect, legacyView, loadRegistry, main, readFailures, readLedger, resolveToolCaps, sweep, waitRunning, watch } = roleWake;

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
  const state = { now: NOW, runs: [], runOptions: [], failOn: null, crontab: '', panes: { 'w1:p1': [{ argv: ['claude', '--resume', 'x'], pid: 10 }], 'w1:p2': [{ argv: ['/opt/bin/muse-bin-1.4', '--yolo'], pid: 20 }] }, processes: [{ pid: 10, ppid: 1, args: 'claude --resume x' }, { pid: 11, ppid: 10, args: `bash ${waitScript}` }, { pid: 20, ppid: 1, args: '/opt/bin/muse-bin-1.4 --yolo' }] };
  const deps = {
    now: () => state.now,
    run: (command, args, options = {}) => { state.runs.push([command, ...args]); state.runOptions.push(options); if (state.failOn && args.some(arg => arg.includes(state.failOn))) throw new Error('exit 1'); return ''; },
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
  assert.throws(broken(doc => { doc.roles['role-a'].tools = ['agy', 'claude']; }), /role role-a: tool must equal tools\[0\]/);
  assert.throws(broken(doc => { doc.roles['role-a'].tools = ['claude']; doc.roles['role-a'].tool = 'codex'; }), /role role-a: tool must equal tools\[0\]/);
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

test('tool caps validate types and resolve per-tool defaults and overrides', t => {
  const f = setup(t);
  const defaults = [
    ['claude', { bgNotify: true, submitKeys: ['Enter'] }],
    ['codex', { bgNotify: false, submitKeys: ['Enter', 'Tab'] }],
    ['agy', { bgNotify: false, submitKeys: ['Enter'] }],
    ['muse', { bgNotify: false, submitKeys: ['Enter'] }],
    ['opencode', { bgNotify: false, submitKeys: ['Enter'] }],
    ['unknown-tool', { bgNotify: false, submitKeys: ['Enter'] }],
  ];
  for (const [tool, expected] of defaults) assert.deepEqual(resolveToolCaps({}, { tool }), expected);
  assert.deepEqual(resolveToolCaps({ tool_caps: { bg_notify: { codex: true }, submit_keys: { codex: ['Tab'] } } }, { tool: 'codex' }), { bgNotify: true, submitKeys: ['Tab'] });
  assert.deepEqual(resolveToolCaps({ tool_caps: { bg_notify: { claude: false }, submit_keys: { claude: ['Tab'] } } }, { tool: 'claude' }), { bgNotify: false, submitKeys: ['Tab'] });

  const broken = change => { const copy = structuredClone(f.doc); change(copy); fs.writeFileSync(f.file, JSON.stringify(copy)); return () => loadRegistry(f.file); };
  assert.throws(broken(doc => { doc.tool_caps = 'bad'; }), /tool_caps must be an object/);
  assert.throws(broken(doc => { doc.tool_caps = { bg_notify: true }; }), /tool_caps\.bg_notify must be an object/);
  assert.throws(broken(doc => { doc.tool_caps = { bg_notify: { codex: 'true' } }; }), /tool_caps\.bg_notify\.codex must be a boolean/);
  assert.throws(broken(doc => { doc.tool_caps = { submit_keys: true }; }), /tool_caps\.submit_keys must be an object/);
  assert.throws(broken(doc => { doc.tool_caps = { submit_keys: { codex: [] } }; }), /tool_caps\.submit_keys\.codex must be a non-empty string array/);
  assert.throws(broken(doc => { doc.tool_caps = { submit_keys: { codex: ['Enter', 2] } }; }), /tool_caps\.submit_keys\.codex must be a non-empty string array/);
});

test('validate prints one capability row per role', t => {
  const f = setup(t, { tool_caps: { bg_notify: { claude: true, agy: false } } });
  let output = '';
  assert.equal(main(['validate', '--config', f.file], {}, f.deps, chunk => { output += chunk; }), 0);
  const parsed = JSON.parse(output);
  assert.deepEqual(parsed.roles, ['role-a', 'role-b']);
  assert.deepEqual(parsed.tool_caps, [
    { id: 'role-a', tool: 'claude', bg_notify: true, submit_keys: ['Enter'] },
    { id: 'role-b', tool: 'agy', bg_notify: false, submit_keys: ['Enter'] },
  ]);
  assert.equal(output.split('\n').filter(line => line.includes('"bg_notify"')).length, 2);
});

test('deliver forwards the resolved tool capabilities to the instance adapter', t => {
  const f = setup(t);
  deliver(f.load(), f.deps);
  const file = f.put('role-a', '001-wake.md');

  deliver(f.load(), f.deps);

  assert.equal(f.state.runs.at(-1)[2], file);
  assert.deepEqual({
    ROLE_WAKE_TOOL: f.state.runOptions.at(-1)?.env?.ROLE_WAKE_TOOL,
    ROLE_WAKE_SUBMIT_KEYS: f.state.runOptions.at(-1)?.env?.ROLE_WAKE_SUBMIT_KEYS,
    ROLE_WAKE_BG_NOTIFY: f.state.runOptions.at(-1)?.env?.ROLE_WAKE_BG_NOTIFY,
  }, { ROLE_WAKE_TOOL: 'claude', ROLE_WAKE_SUBMIT_KEYS: '["Enter"]', ROLE_WAKE_BG_NOTIFY: 'true' });
});

test('inspect and deliver resolve capabilities from the actual fallback foreground tool', t => {
  const f = setup(t, { tool_caps: { bg_notify: { agy: true, muse: false }, submit_keys: { agy: ['Space'], muse: ['F4'] } } });
  const registry = f.load();
  const row = inspect(registry, f.deps).rows.find(item => item.id === 'role-b');
  assert.deepEqual([row.tool, row.bgNotify, row.submitKeys], ['muse', false, ['F4']]);

  deliver(registry, f.deps);
  const file = f.put('role-b', '001-fallback.md');
  deliver(registry, f.deps);

  const deliveryIndex = f.state.runs.findIndex(run => run[2] === file);
  assert.deepEqual({
    ROLE_WAKE_TOOL: f.state.runOptions[deliveryIndex]?.env?.ROLE_WAKE_TOOL,
    ROLE_WAKE_SUBMIT_KEYS: f.state.runOptions[deliveryIndex]?.env?.ROLE_WAKE_SUBMIT_KEYS,
    ROLE_WAKE_BG_NOTIFY: f.state.runOptions[deliveryIndex]?.env?.ROLE_WAKE_BG_NOTIFY,
  }, { ROLE_WAKE_TOOL: 'muse', ROLE_WAKE_SUBMIT_KEYS: '["F4"]', ROLE_WAKE_BG_NOTIFY: 'false' });
});

test('tool names normalize case and close typos or unused capability keys are rejected', t => {
  const f = setup(t);
  f.doc.roles['role-b'].tool = 'Codex';
  f.doc.roles['role-b'].tools = ['codex', 'MUSE'];
  f.doc.tool_caps = { bg_notify: { CODEX: true }, submit_keys: { Codex: ['F8'] } };
  f.write();
  const role = f.load().roles.find(item => item.id === 'role-b');
  assert.deepEqual([role.tool, role.tools, role.bgNotify, role.submitKeys], ['codex', ['codex', 'muse'], true, ['F8']]);

  f.doc.roles['role-b'].tool = 'codxe';
  f.doc.roles['role-b'].tools = ['codxe'];
  f.doc.tool_caps = {};
  f.write();
  assert.throws(() => f.load(), /codxe.*codex/i);

  f.doc.roles['role-b'].tool = 'agy';
  f.doc.roles['role-b'].tools = ['agy', 'muse'];
  f.doc.tool_caps = { bg_notify: { codxe: false } };
  f.write();
  assert.throws(() => f.load(), /codxe.*codex/i);

  f.doc.tool_caps = { submit_keys: { codex: ['Tab'] } };
  f.write();
  assert.throws(() => f.load(), /tool_caps\.submit_keys\.codex.*unused/i);
});

test('prototype property names use the generic tool capability defaults', () => {
  assert.deepEqual(resolveToolCaps({}, { tool: 'constructor' }), { bgNotify: false, submitKeys: ['Enter'] });
});

test('tool detection reads the foreground program, not the registry', () => {
  const known = ['claude', 'agy', 'muse', 'codex'];
  assert.deepEqual(detectTool([{ argv: ['/opt/bin/Codex'] }], known), { alive: true, tool: 'codex' });
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
  f.doc.roles['role-b'].tool = 'claude';
  f.doc.roles['role-b'].tools = ['claude'];
  f.doc.roles['role-b'].wait = { script: f.waitScript, mode: 'observe' };
  f.write();
  f.state.processes = f.state.processes.filter(proc => proc.pid !== 11);
  const findings = inspect(f.load(), f.deps).findings.filter(finding => finding.code === 'wait-down');
  assert.deepEqual(findings.map(finding => [finding.role, finding.level]), [['role-a', 'error'], ['role-b', 'warn']]);
});

test('a tool without background notification needs a direct delivery consumer', t => {
  const f = setup(t);
  delete f.doc.delivery;
  f.doc.roles['role-b'].wait = { script: f.waitScript, mode: 'observe' };
  f.write();

  assert.throws(() => f.load(), /role-b:.*bg_notify=false.*delivery\.command/);
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
  assert.deepEqual(registry.roles.map(({ tool, bgNotify, submitKeys }) => ({ tool, bgNotify, submitKeys })), [
    { tool: 'claude', bgNotify: true, submitKeys: ['Enter'] },
    { tool: 'agy', bgNotify: false, submitKeys: ['Enter'] },
  ]);
  assert.deepEqual(registry.roleViews.map(view => ({ kind: view.kind, roles: view.roles })), [
    { kind: 'wake-routes', roles: null },
    { kind: 'session-health', roles: ['role-a'] },
  ]);
});
