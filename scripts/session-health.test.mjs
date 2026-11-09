import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runHealth, compareRules, compactEvidence, collectWindow, validateConfig } from './session-health.mjs';
const root = process.env.SESSION_HEALTH_TEST_TMP || join((await import('node:os')).tmpdir(), 'session-health-test');
const now = Date.parse('2030-01-01T12:00:00Z');
async function fixture() {
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'health-')), repo = join(dir, 'repo');
  await mkdir(join(repo, '.agents/context'), { recursive: true }); await mkdir(join(repo, '.claude'));
  for (const [name, text] of [['AGENTS.md', 'rules\n'], ['.agents/context/agents-rules.json', '{}'], ['.claude/settings.json', '{"hooks":{}}'], ['work.md', '- in progress: task\n']]) await writeFile(join(repo, name), text);
  const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_AUTHOR_DATE: '2029-12-30T00:00:00Z', GIT_COMMITTER_DATE: '2029-12-30T00:00:00Z' } }).trim();
  git(['init', '-q']); git(['add', '.']); git(['commit', '-qm', 'fixture']);
  const snapshot = join(dir, 'windows.json'); await writeFile(snapshot, JSON.stringify({ windows: [{ name: 'agent', aiRunning: true, output: 'first' }] }));
  await utimes(join(repo, 'work.md'), (now - 4 * 3600000) / 1000, (now - 4 * 3600000) / 1000);
  const c = { stateFile: join(dir, 'state.json'), reportFile: join(dir, 'report.md'), baselineRepo: repo, baselineSha: git(['rev-parse', 'HEAD']), roles: [{ id: 'role-a', botId: '123', window: 'agent', workspace: repo, workFiles: [join(repo, 'work.md')], adapter: { kind: 'snapshot', path: snapshot } }], notifications: { nudgeChannelId: '111', escalation: { channelId: '222', userId: '333' } } };
  const sent = []; const opts = { now, token: 'fake-test', log: () => {}, fetchImpl: async (_, init) => { sent.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ id: String(sent.length) }) }; } };
  return { c, dir, repo, snapshot, sent, opts, run: (extra = {}) => runHealth(c, { ...opts, ...extra }) };
}
test('silent baseline creates one sheet with active assignment and stalled evidence', async () => { const f = await fixture(); const r = await f.run(); assert.equal(f.sent.length, 0); assert.match(r.report, /in progress: task/); assert.equal(r.rows[0].alive, 'alive'); assert.deepEqual(r.rows[0].anomalies, ['stalled']); assert.match(await readFile(f.c.reportFile, 'utf8'), /Rules/); });
test('stopped at exact 30 minutes, once per stage including restart', async () => { const f = await fixture(); await f.run(); await f.run({ now: now + 30 * 60000 }); assert.equal(f.sent.length, 3); await f.run({ now: now + 60 * 60000 }); assert.equal(f.sent.length, 4); await f.run({ now: now + 90 * 60000 }); assert.equal(f.sent.length, 4); });
test('output change and log mtime refresh activity', async () => { const f = await fixture(); await f.run(); await writeFile(f.snapshot, JSON.stringify({ windows: [{ name: 'agent', aiRunning: true, output: 'changed' }] })); assert.equal((await f.run({ now: now + 31 * 60000 })).rows[0].alive, 'alive'); const log = join(f.dir, 'session.jsonl'); await writeFile(log, '{}\n'); await utimes(log, (now + 61 * 60000) / 1000, (now + 61 * 60000) / 1000); f.c.roles[0].sessionLog = log; assert.equal((await f.run({ now: now + 61 * 60000 })).rows[0].alive, 'alive'); });
for (const [windows, code] of [[[], 'missing'], [[{ name: 'agent', aiRunning: false, output: '' }], 'empty']]) test(`${code} window`, async () => { const f = await fixture(); await writeFile(f.snapshot, JSON.stringify({ windows })); assert.equal((await f.run()).rows[0].alive, code); await f.run(); assert.ok(f.sent.some(s => s.content.endsWith(code))); });
test('task update and response state prevent stall; unrelated bot does not', async () => { const f = await fixture(); f.c.responseWatchState = join(f.dir, 'response.json'); await writeFile(f.c.responseWatchState, JSON.stringify({ replies: { '123': { at: now } } })); assert.ok(!(await f.run()).rows[0].anomalies.includes('stalled')); await writeFile(f.c.responseWatchState, JSON.stringify({ replies: { '456': { at: now } } })); assert.ok((await f.run()).rows[0].anomalies.includes('stalled')); await utimes(f.c.roles[0].workFiles[0], now / 1000, now / 1000); assert.ok(!(await f.run()).rows[0].anomalies.includes('stalled')); });
test('no active tasks means no stall', async () => { const f = await fixture(); await writeFile(f.c.roles[0].workFiles[0], 'done\n'); assert.ok(!(await f.run()).rows[0].anomalies.includes('stalled')); });
test('rule modifications expose line numbers/hashes, allowlist retains evidence', async () => { const f = await fixture(); await writeFile(join(f.repo, 'AGENTS.md'), 'private rule\n'); const r = await compareRules(f.c, f.c.roles[0]); assert.equal(r.status, 'drift'); assert.deepEqual(r.diffs[0].lines, [1]); assert.ok(!JSON.stringify(r).includes('private rule')); f.c.roles[0].allowedOverrides = ['AGENTS.md']; assert.equal((await compareRules(f.c, f.c.roles[0])).status, 'match'); });
test('settings compare hooks only and added rules are drift', async () => { const f = await fixture(); await writeFile(join(f.repo, '.claude/settings.json'), '{"hooks":{},"private":"ignored"}'); assert.equal((await compareRules(f.c, f.c.roles[0])).status, 'match'); await writeFile(join(f.repo, '.agents/context/agents-rules-extra.json'), '{}'); assert.equal((await compareRules(f.c, f.c.roles[0])).status, 'drift'); await writeFile(join(f.repo, '.claude/settings.json'), '{"hooks":{"Start":[]}}'); assert.equal((await compareRules(f.c, f.c.roles[0])).diffs.length, 2); });
test('compact requires explicit later entry read and unsupported is unknown', () => { assert.equal(compactEvidence('mentions AGENTS.md'), 'unknown'); const compact = '{"type":"compact","at":"2030-01-01T00:00:00Z"}\n'; assert.equal(compactEvidence(compact), 'not observed'); assert.equal(compactEvidence(compact + '{"type":"entry_read","path":"AGENTS.md","at":"2030-01-01T01:00:00Z"}'), 'confirmed'); });
test('dry preserves state/report bytes and posts nothing', async () => { const f = await fixture(); await f.run(); const before = await readFile(f.c.stateFile, 'utf8'), report = await readFile(f.c.reportFile, 'utf8'); const r = await f.run({ now: now + 90 * 60000, dry: true }); assert.ok(r.previews); assert.equal(f.sent.length, 0); assert.equal(await readFile(f.c.stateFile, 'utf8'), before); assert.equal(await readFile(f.c.reportFile, 'utf8'), report); });
test('uncertain sends never replay and recovery opens new episode', async () => { const f = await fixture(); await f.run(); let calls = 0; const fetchImpl = async () => { calls++; throw Error('private error'); }; await f.run({ fetchImpl }); await f.run({ fetchImpl }); assert.equal(calls, 1); const s = JSON.parse(await readFile(f.c.stateFile, 'utf8')); assert.equal(s.roles['role-a'].episodes.stalled.stages.nudge.status, 'uncertain'); await utimes(f.c.roles[0].workFiles[0], now / 1000, now / 1000); await f.run(); await utimes(f.c.roles[0].workFiles[0], (now - 4 * 3600000) / 1000, (now - 4 * 3600000) / 1000); await f.run(); assert.equal(f.sent.length, 1); });
test('rejected notification retries', async () => { const f = await fixture(); await f.run(); await f.run({ fetchImpl: async () => ({ ok: false, status: 403 }) }); await f.run(); assert.equal(f.sent.length, 1); });
test('exclusive lock prevents concurrent execution', async () => { const f = await fixture(); await writeFile(`${f.c.stateFile}.lock`, '{}'); await assert.rejects(f.run(), /EEXIST/); });
test('malformed state fails closed', async () => { const f = await fixture(); await writeFile(f.c.stateFile, '{broken'); await assert.rejects(f.run(), /refusing reset/); assert.equal(await readFile(f.c.stateFile, 'utf8'), '{broken'); });
test('probe and baseline errors display unknown and degraded', async () => { const f = await fixture(); f.c.baselineSha = '0'.repeat(40); const r = await f.run({ windowProbe: async () => { throw Error('private'); } }); assert.equal(r.rows[0].alive, 'unknown'); assert.equal(r.rows[0].rules.status, 'unknown'); assert.ok(r.degraded); assert.ok(!r.report.includes('private')); });
test('herdr argv adapter normalizes local fixture and rejects duplicate windows', async () => { const f = await fixture(); const r = f.c.roles[0]; r.adapter = { kind: 'herdr', command: [process.execPath, '-e', 'process.stdout.write(JSON.stringify({windows:[{name:"agent",aiRunning:true,output:"ok"}]}))'] }; assert.equal((await collectWindow(r)).aiRunning, true); r.adapter = { kind: 'snapshot', path: f.snapshot }; await writeFile(f.snapshot, JSON.stringify({ windows: [{ name: 'agent' }, { name: 'agent' }] })); await assert.rejects(collectWindow(r), /ambiguous/); });
test('invalid config rejects duplicate roles, placeholders and threshold zero', async () => { const f = await fixture(); f.c.roles.push(f.c.roles[0]); assert.throws(() => validateConfig(f.c), /unique/); f.c.roles.pop(); f.c.idleMinutes = 0; assert.throws(() => validateConfig(f.c), /positive/); });
test('first successful window observation remains silent after failed window baseline', async () => { const f = await fixture(); await f.run({ windowProbe: async () => { throw Error('unavailable'); } }); await writeFile(f.snapshot, JSON.stringify({ windows: [{ name: 'agent', aiRunning: false, output: '' }] })); await f.run(); assert.ok(!f.sent.some(s => s.content.endsWith('empty'))); await f.run(); assert.equal(f.sent.filter(s => s.content.endsWith('empty')).length, 1); });
test('active old task in unborn Git repository still stalls with commit unknown', async () => { const f = await fixture(); const workspace = join(f.dir, 'unborn'); await mkdir(workspace); execFileSync('git', ['-C', workspace, 'init', '-q']); const task = join(workspace, 'work.md'); await writeFile(task, '진행 중: task'); await utimes(task, (now - 3 * 3600000) / 1000, (now - 3 * 3600000) / 1000); f.c.roles[0].workspace = workspace; f.c.roles[0].workFiles = [task]; const r = await f.run(); assert.ok(r.rows[0].anomalies.includes('stalled')); assert.ok(r.rows[0].errors.includes('commit evidence unavailable')); });
test('tmux no-server becomes missing; permission failure remains unknown', async () => { const f = await fixture(); const bin = join(f.dir, 'bin'); await mkdir(bin); const tmux = join(bin, 'tmux'); const { chmod } = await import('node:fs/promises'); await writeFile(tmux, '#!/bin/sh\necho "no server running on fixture" >&2\nexit 1\n'); await chmod(tmux, 0o700); const before = process.env.PATH; process.env.PATH = `${bin}:${before}`; try { f.c.roles[0].adapter = { kind: 'tmux' }; assert.equal((await f.run()).rows[0].alive, 'missing'); await writeFile(tmux, '#!/bin/sh\necho "permission denied" >&2\nexit 1\n'); assert.equal((await f.run()).rows[0].alive, 'unknown'); } finally { process.env.PATH = before; } });

test('permanent commit failure cannot suppress reliable window and task alerts', async () => { const f = await fixture(); f.c.roles[0].workspace = f.dir; await writeFile(f.snapshot, JSON.stringify({ windows: [{ name: 'agent', aiRunning: false, output: '' }] })); await f.run(); await f.run(); assert.ok(f.sent.some(s => s.content.endsWith('empty'))); assert.ok(f.sent.some(s => s.content.endsWith('stalled'))); });
test('tmux descendant AI is detected behind shell and output is captured', async () => { const f = await fixture(); const bin = join(f.dir, 'bin'); await mkdir(bin); const { chmod } = await import('node:fs/promises'); const tmux = join(bin, 'tmux'), ps = join(bin, 'ps'); await writeFile(tmux, '#!/bin/sh\nif [ "$1" = list-panes ]; then printf "agent\\t100\\n"; else printf "output"; fi\n'); await writeFile(ps, '#!/bin/sh\nprintf "100 1 bash\\n101 100 node\\n102 101 codex\\n103 1 claude\\n"\n'); await chmod(tmux, 0o700); await chmod(ps, 0o700); const before = process.env.PATH; process.env.PATH = `${bin}:${before}`; try { const role = { ...f.c.roles[0], adapter: { kind: 'tmux' } }; assert.deepEqual(await collectWindow(role), { aiRunning: true, output: 'output' }); role.aiPrograms = ['unrelated']; assert.equal((await collectWindow(role)).aiRunning, false); } finally { process.env.PATH = before; } });

async function ledgerFixture() {
  const f = await fixture();
  f.c.roles[0].workFiles = [];
  f.c.workLedger = join(f.dir, 'work-ledger.yaml');
  f.c.regularSchedule = join(f.dir, 'regular-schedule.yaml');
  f.work = { version: 1, work: [
    { id: 'old', role: 'role-a', task: 'Review draft', status: '진행 중', requested_at: '2029-12-30T09:00:00Z', due_at: null, evidence: 'https://example.invalid/request/1', result: null, updated_at: '2030-01-01T09:00:00Z' },
    { id: 'other', role: 'role-b', task: 'Other assignment', status: '진행 중', requested_at: '2030-01-01T11:00:00Z', due_at: null, evidence: 'https://example.invalid/request/2', result: null, updated_at: '2030-01-01T12:00:00Z' }
  ] };
  f.schedule = { version: 1, timezone: 'UTC', schedules: [
    { id: 'daily', role: 'role-a', task: 'Write report', cadence: 'daily', time: '11:00', graceMinutes: 15, status: '있음', mechanism: { kind: 'timer', target: '<target>', timer: '<timer>' }, approval: null, last_result: { at: null, outcome: 'not-run', evidence: null } }
  ] };
  // JSON is a YAML subset accepted by the ledger reader; exercise block YAML in ledger.test.
  f.saveLedgers = async () => {
    await writeFile(f.c.workLedger, JSON.stringify(f.work));
    await writeFile(f.c.regularSchedule, JSON.stringify(f.schedule));
  };
  await f.saveLedgers();
  return f;
}
test('ledger role assignment and stale row ignore fresh unrelated commit/reply/work row', async () => {
  const f = await ledgerFixture();
  f.work.work.push({ ...f.work.work[1], id: 'fresh', role: 'role-a', task: 'Fresh assignment' });
  await f.saveLedgers();
  f.c.responseWatchState = join(f.dir, 'reply.json');
  await writeFile(f.c.responseWatchState, JSON.stringify({ replies: { '123': { at: now } } }));
  const r = await f.run();
  assert.deepEqual(r.rows[0].tasks, ['old: Review draft', 'fresh: Fresh assignment']);
  assert.ok(r.rows[0].anomalies.includes('stalled'));
  assert.match(r.report, /안 돎/);
  assert.equal(f.sent.length, 0);
});
test('work ledger update and completed/waiting/blocked rows clear stall', async () => {
  const f = await ledgerFixture(); await f.run();
  f.work.work[0].updated_at = new Date(now).toISOString(); await f.saveLedgers();
  assert.ok(!(await f.run()).rows[0].anomalies.includes('stalled'));
  for (const status of ['대기', '막힘', '끝']) {
    Object.assign(f.work.work[0], { status, result: status === '끝' ? 'https://example.invalid/result/1' : null });
    await f.saveLedgers(); const r = await f.run();
    assert.deepEqual(r.rows[0].tasks, []);
    assert.ok(!r.rows[0].anomalies.includes('stalled'));
  }
});
test('schedule baseline and both alert stages once per occurrence survive restart', async () => {
  const f = await ledgerFixture(); f.work.work = []; await f.saveLedgers();
  await f.run(); assert.equal(f.sent.length, 0);
  await f.run({ now: now + 60000 });
  const scheduled = () => f.sent.filter(s => s.content.includes('schedule-missed:'));
  assert.equal(scheduled().length, 1);
  await f.run({ now: now + 30 * 60000 });
  assert.equal(scheduled().length, 2);
  await f.run({ now: now + 60 * 60000 }); assert.equal(scheduled().length, 2);
  await f.run({ now: now + 24 * 3600000 }); assert.equal(scheduled().length, 3);
  await f.run({ now: now + 24 * 3600000 + 30 * 60000 }); assert.equal(scheduled().length, 4);
});
test('failed execution covers due run and next missed occurrence opens new episode', async () => {
  const f = await ledgerFixture(); await f.run(); await f.run();
  f.schedule.schedules[0].last_result = { at: '2030-01-01T11:05:00Z', outcome: 'failed', evidence: null };
  await f.saveLedgers(); const r = await f.run();
  assert.equal(r.rows[0].schedules[0].status, 'recorded');
  assert.ok(!r.rows[0].anomalies.some(x => x.startsWith('schedule-missed:')));
  await f.run({ now: now + 86400000 });
  assert.equal(f.sent.filter(s => s.content.includes('schedule-missed:')).length, 2);
});
test('unreadable ledgers retain episodes and report unknown; recovered first schedule baseline is silent', async () => {
  const f = await ledgerFixture(); await f.run();
  await writeFile(f.c.workLedger, '{bad'); await writeFile(f.c.regularSchedule, '{bad');
  const r = await f.run(); assert.ok(r.degraded); assert.match(r.report, /regular schedule: unknown/);
  const state = JSON.parse(await readFile(f.c.stateFile, 'utf8'));
  assert.ok(state.roles['role-a'].episodes.stalled);
  assert.ok(Object.keys(state.roles['role-a'].episodes).some(x => x.startsWith('schedule-missed:')));
  const fresh = await ledgerFixture(); await writeFile(fresh.c.regularSchedule, '{bad'); await fresh.run();
  await fresh.saveLedgers(); await fresh.run();
  assert.equal(fresh.sent.filter(s => s.content.includes('schedule-missed:')).length, 0);
  await fresh.run(); assert.equal(fresh.sent.filter(s => s.content.includes('schedule-missed:')).length, 1);
});
test('ledger dry run preserves input/state/report and validates absolute paths', async () => {
  const f = await ledgerFixture(); await f.run();
  const paths = [f.c.workLedger, f.c.regularSchedule, f.c.stateFile, f.c.reportFile];
  const before = await Promise.all(paths.map(p => readFile(p, 'utf8')));
  await f.run({ dry: true, now: now + 60 * 60000 });
  assert.deepEqual(await Promise.all(paths.map(p => readFile(p, 'utf8'))), before);
  assert.equal(f.sent.length, 0);
  f.c.workLedger = 'relative.yaml'; assert.throws(() => validateConfig(f.c), /absolute ledger/);
});
test('first valid work ledger gets its own silent baseline after a read failure', async () => {
  const f = await ledgerFixture(); f.schedule.schedules = []; await f.saveLedgers();
  await writeFile(f.c.workLedger, '{bad'); await f.run();
  await f.saveLedgers(); await f.run();
  assert.equal(f.sent.filter(s => s.content.endsWith('stalled')).length, 0);
  await f.run(); assert.equal(f.sent.filter(s => s.content.endsWith('stalled')).length, 1);
});
test('multiple roles remain in one contiguous Markdown table with schedule details', async () => {
  const f = await ledgerFixture();
  f.c.roles.push({ ...f.c.roles[0], id: 'role-b', botId: '456' });
  const { report, rows } = await f.run();
  assert.deepEqual(rows[1].tasks, ['other: Other assignment']);
  assert.ok(!rows[1].anomalies.includes('stalled'));
  const lines = report.split('\n'), a = lines.findIndex(line => line.startsWith('| role-a |'));
  assert.ok(a > 0); assert.ok(lines[a + 1].startsWith('| role-b |'));
  assert.ok(report.indexOf('role-a regular schedule:') > report.indexOf('| role-b |'));
});

test('custom stage messages expand all placeholders and restrict mentions', async () => {
  const f = await fixture();
  f.c.roles[0].workFiles = [];
  f.c.idleMinutes = 120;
  await writeFile(f.snapshot, JSON.stringify({ windows: [] }));
  f.c.messages = {
    nudge: '<@{user}> {role}: {codeText} ({code}) {report}; {role}',
    escalate: '확인 요청 <@{user}> {role} {code} {codeText} {report}'
  };
  f.c.codeText = { missing: '창 없음 — 담당자가 확인; {role} $& @everyone <@999>' };
  await f.run(); await f.run();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].content, `<@123> role-a: 창 없음 — 담당자가 확인; {role} $& @everyone <@999> (missing) ${f.c.reportFile}; role-a`);
  assert.deepEqual(f.sent[0].allowed_mentions, { parse: [], users: ['123'] });
  await f.run({ now: now + 30 * 60000 });
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].content, `확인 요청 <@333> role-a missing 창 없음 — 담당자가 확인; {role} $& @everyone <@999> ${f.c.reportFile}`);
  assert.deepEqual(f.sent[1].allowed_mentions, { parse: [], users: ['333'] });
});

test('omitted messages preserve exact legacy stage text even with descriptions', async () => {
  const f = await fixture(); f.c.idleMinutes = 120;
  f.c.codeText = { stalled: '설명' };
  await f.run(); await f.run(); await f.run({ now: now + 30 * 60000 });
  assert.deepEqual(f.sent.map(s => s.content), ['<@123> Session health role-a: stalled', '<@333> Session health role-a: stalled']);
});

test('partial messages preserve stage fallback and unmapped codeText is raw code', async () => {
  const f = await fixture(); f.c.idleMinutes = 120;
  f.c.messages = { nudge: '{codeText}' };
  f.c.codeText = Object.create({ stalled: 'inherited description must be ignored' });
  await f.run(); await f.run(); await f.run({ now: now + 30 * 60000 });
  assert.deepEqual(f.sent.map(s => s.content), ['stalled', '<@333> Session health role-a: stalled']);
});

test('schedule descriptions use family mapping and exact occurrence override', async () => {
  const f = await ledgerFixture(); f.work.work = []; await f.saveLedgers();
  f.c.idleMinutes = 120;
  f.c.messages = { nudge: '{codeText}', escalate: '{codeText}' };
  f.c.codeText = { 'schedule-missed': '실행 기록 확인' };
  const first = await f.run();
  const code = first.rows[0].anomalies.find(code => code.startsWith('schedule-missed:'));
  assert.ok(code);
  await f.run(); assert.equal(f.sent[0].content, '실행 기록 확인');
  f.c.codeText[code] = '이 실행을 확인';
  await f.run({ now: now + 30 * 60000 });
  assert.equal(f.sent[1].content, '이 실행을 확인');
});

test('invalid message and description settings fail before sending or writing', async () => {
  const f = await fixture();
  for (const messages of [null, [], 'text', { unknown: 'text' }, { nudge: 1 }, { escalate: null }, { nudge: ' ' }, { nudge: '{unknown}' }, { nudge: '{bad-name}' }]) {
    f.c.messages = messages;
    await assert.rejects(f.run(), /message/);
  }
  delete f.c.messages;
  for (const codeText of [null, [], 'text', { missing: 1 }, { missing: null }, { missing: ' ' }, { '': 'text' }]) {
    f.c.codeText = codeText;
    await assert.rejects(f.run(), /codeText/);
  }
  assert.equal(f.sent.length, 0);
  await assert.rejects(readFile(f.c.stateFile), { code: 'ENOENT' });
  await assert.rejects(readFile(f.c.reportFile), { code: 'ENOENT' });
});

async function idleFixture() {
  const f = await ledgerFixture();
  f.c.stoppedRequiresWork = true;
  f.work.work = f.work.work.filter(row => row.role !== 'role-a');
  f.schedule.schedules = [];
  await f.saveLedgers();
  return f;
}
test('quiet role without assigned work is idle only in the report, without alerts or degradation', async () => {
  const f = await idleFixture();
  assert.equal((await f.run()).rows[0].alive, 'alive');
  for (const minutes of [30, 60, 90]) {
    const r = await f.run({ now: now + minutes * 60000 });
    assert.equal(r.rows[0].alive, 'idle');
    assert.deepEqual(r.rows[0].anomalies, []);
    assert.equal(r.degraded, false);
    assert.equal(r.previews, 0);
    assert.match(r.report, /\| role-a \| idle \|/);
  }
  assert.equal(f.sent.length, 0);
});
test('quiet role with active work stops and sends both alert stages', async () => {
  const f = await idleFixture();
  f.work.work.push({ ...f.work.work[0], id: 'assigned', role: 'role-a' });
  await f.saveLedgers(); await f.run();
  const r = await f.run({ now: now + 30 * 60000 });
  assert.equal(r.rows[0].alive, 'stopped');
  assert.ok(r.rows[0].anomalies.includes('stopped'));
  await f.run({ now: now + 60 * 60000 });
  await f.run({ now: now + 90 * 60000 });
  assert.deepEqual(f.sent.filter(s => s.content.endsWith('stopped')).map(s => s.allowed_mentions.users), [['123'], ['333']]);
});
test('pending response requests are matched by bot across channels and clear stopped on recovery', async () => {
  const f = await idleFixture();
  f.c.responseWatchState = join(f.dir, 'response.json');
  const response = { channels: { '111': { pending: { one: { botId: '456', at: now } } }, '222': { pending: {} } } };
  const save = () => writeFile(f.c.responseWatchState, JSON.stringify(response));
  await save(); await f.run();
  assert.equal((await f.run({ now: now + 30 * 60000 })).rows[0].alive, 'idle');
  response.channels['222'].pending.two = { botId: '123', at: now };
  await save();
  assert.equal((await f.run({ now: now + 31 * 60000 })).rows[0].alive, 'stopped');
  assert.equal(f.sent.length, 1);
  delete response.channels['222'].pending.two; await save();
  assert.equal((await f.run({ now: now + 32 * 60000 })).rows[0].alive, 'idle');
  assert.equal(JSON.parse(await readFile(f.c.stateFile, 'utf8')).roles['role-a'].episodes.stopped, undefined);
  response.channels['222'].pending.three = { botId: '123', at: now };
  await save(); await f.run({ now: now + 33 * 60000 });
  assert.equal(f.sent.length, 2);
});
test('missing, unreadable and invalid work ledger conservatively preserve stopped', async () => {
  for (const source of ['unconfigured', 'missing', 'invalid']) {
    const f = await idleFixture();
    if (source === 'unconfigured') delete f.c.workLedger;
    if (source === 'missing') f.c.workLedger = join(f.dir, 'missing.yaml');
    if (source === 'invalid') await writeFile(f.c.workLedger, '{bad');
    await f.run();
    const r = await f.run({ now: now + 30 * 60000 });
    assert.equal(r.rows[0].alive, 'stopped', source);
    assert.ok(r.rows[0].anomalies.includes('stopped'), source);
    assert.equal(f.sent.filter(s => s.content.endsWith('stopped')).length, 1, source);
  }
});
test('unavailable or malformed response evidence conservatively preserves stopped', async () => {
  for (const contents of [null, '{bad', '{}', '{"channels":{},"errors":{"111":{"reason":"unavailable"}}}', '{"channels":[]}', '{"channels":{"111":{"pending":{},"error":"unavailable"}}}', '{"channels":{"111":{"pending":{"one":{}}}}}']) {
    const f = await idleFixture();
    f.c.responseWatchState = join(f.dir, 'response.json');
    if (contents !== null) await writeFile(f.c.responseWatchState, contents);
    await f.run();
    const r = await f.run({ now: now + 30 * 60000 });
    assert.equal(r.rows[0].alive, 'stopped');
    assert.ok(r.rows[0].errors.includes('response evidence unavailable'));
    assert.equal(f.sent.filter(s => s.content.endsWith('stopped')).length, 1);
  }
});
test('omitted and false stoppedRequiresWork preserve quiet stopped behavior', async () => {
  for (const enabled of [undefined, false]) {
    const f = await idleFixture();
    if (enabled === undefined) delete f.c.stoppedRequiresWork;
    else f.c.stoppedRequiresWork = enabled;
    await f.run();
    assert.equal((await f.run({ now: now + 30 * 60000 })).rows[0].alive, 'stopped');
    assert.equal(f.sent.length, 1);
  }
});
test('work-aware quiet detection retains missing and empty window anomalies', async () => {
  for (const windows of [[], [{ name: 'agent', aiRunning: false, output: '' }]]) {
    const f = await idleFixture();
    await writeFile(f.snapshot, JSON.stringify({ windows }));
    const r = await f.run();
    assert.equal(r.rows[0].alive, windows.length ? 'empty' : 'missing');
    assert.ok(r.rows[0].anomalies.includes(r.rows[0].alive));
  }
});
test('stoppedRequiresWork accepts only boolean and rejects before writing state', async () => {
  const f = await fixture();
  for (const value of [null, 0, 1, 'true', [], {}]) {
    f.c.stoppedRequiresWork = value;
    await assert.rejects(f.run(), /stoppedRequiresWork must be a boolean/);
  }
  assert.equal(f.sent.length, 0);
  await assert.rejects(readFile(f.c.stateFile), { code: 'ENOENT' });
});

test('waiting, blocked and completed ledger rows do not count as active assignments', async () => {
  const f = await idleFixture();
  await f.run();
  for (const status of ['대기', '막힘', '끝']) {
    f.work.work = [{ ...f.work.work[0], role: 'role-a', status, result: status === '끝' ? 'https://example.invalid/result' : null }];
    await f.saveLedgers();
    assert.equal((await f.run({ now: now + 30 * 60000 })).rows[0].alive, 'idle');
  }
  assert.equal(f.sent.length, 0);
});

test('runHealth never emits card wakes even with legacy taskCardsRoot configuration', async () => {
  const f = await fixture();
  const { readdir } = await import('node:fs/promises');
  const cardsDir = join(f.repo, 'docs/common/team/cards/role-a');
  await mkdir(cardsDir, { recursive: true });
  await writeFile(join(cardsDir, '20300101-elapsed.md'), [
    '---',
    'id: 20300101-elapsed',
    'title: "elapsed wait"',
    'owner: role-a',
    'status: waiting',
    'source: chat-1',
    'received: 2030-01-01T10:00:00Z',
    'due: 2030-01-02',
    'next: "recheck"',
    'moved: 2030-01-01T10:00:00Z',
    'wait_reason: "다른 사람 결과물"',
    'recheck_at: 2030-01-01T11:30:00Z',
    '---',
    '',
  ].join('\n'));
  await writeFile(join(cardsDir, '20300101-legacy.md'), [
    '---',
    'id: 20300101-legacy',
    'title: "legacy wait"',
    'owner: role-a',
    'status: waiting',
    'source: chat-2',
    'received: 2030-01-01T09:00:00Z',
    'due: 2030-01-02',
    'next: "fill fields"',
    'moved: 2030-01-01T09:00:00Z',
    '---',
    '',
  ].join('\n'));
  f.c.taskCardsRoot = f.repo;
  const wakeDir = join(f.repo, '.agents/work/l4/wake');
  await f.run({ now, dry: true });
  await assert.rejects(readdir(wakeDir), { code: 'ENOENT' });
  await f.run({ now });
  await assert.rejects(readdir(wakeDir), { code: 'ENOENT' });
  await f.run({ now: now + 5 * 60000 });
  await assert.rejects(readdir(wakeDir), { code: 'ENOENT' });
});
