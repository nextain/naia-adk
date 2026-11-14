import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliverAudit } from '../lib/audit-delivery.mjs';
import { runAudit } from '../session-audit.mjs';
import { readFixture } from '../lib/audit-signals.mjs';

const at = Date.parse('2026-11-12T12:00:00Z');
const configHash = 'a'.repeat(64), promptHash = 'b'.repeat(64);
const placeholder = digit => digit.repeat(18);
const internal = placeholder('1'), day = placeholder('2'), night = placeholder('3');
const bot = placeholder('4'), owner = placeholder('5'), leader = placeholder('6');
const warn = { stage: 'warn', code: 'repeat-review', target: 'plan', at, episodeAt: at };
const report = { ...warn, stage: 'report', at: at + 3600000 };

async function setup(t, overrides = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'audit-delivery-test-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const role = { id: 'role', wakeDir: join(workspace, 'wake'), sessionDirs: [join(workspace, 'session')], botIds: [bot], leaderId: leader };
  const config = { workspace, schedule: { file: join(workspace, 'schedule.yaml'), id: 'session-audit' }, dry: false, timezone: 'UTC', night: { start: 0, end: 9 }, channels: { internal, day, night }, ownerId: owner, ...overrides };
  const sent = [];
  const sender = async message => { sent.push(message); return { id: String(sent.length) }; };
  const args = { role, config, reportPath: join(workspace, 'report.md'), configHash, promptHash, now: at, sender };
  return { args, sent };
}

test('warning and report use only configured mentions, have a hash suffix and no table text', async t => {
  const { args, sent } = await setup(t);
  const injected = { code: warn.code, headline: '표', facts: ['| 제목 | 값 |', '내용 | 값', `불청객 <@${placeholder('7')}>`], ask: `처리 | 확인 <@${placeholder('8')}>` };
  const result = await deliverAudit({ ...args, events: [{ ...warn, output: injected }, report] });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].channelId, internal);
  assert.equal(sent[1].channelId, day);
  assert.deepEqual(sent[0].mentions, [bot]);
  assert.deepEqual(new Set(sent[1].mentions), new Set([owner, leader]));
  for (const item of sent) {
    assert.ok(!item.content.includes('|'));
    assert.ok(item.content.endsWith(`prompt=${promptHash.slice(0, 8)} config=${configHash.slice(0, 8)}`));
    const mentions = [...item.content.matchAll(/<@(\d+)>/g)].map(match => match[1]);
    assert.deepEqual(new Set(mentions), new Set(item.mentions));
  }
  assert.match(sent[0].content, /^\[감사\] role repeat-review 표\n/);
  assert.match(sent[0].content, /보고서:/);
  assert.match(sent[1].content, /^\[감사 보고\] role repeat-review 감사 신호를 확인했습니다\n/);
  assert.doesNotMatch(sent[1].content, /승인\s*코드/);
  const files = await readdir(args.role.wakeDir);
  assert.equal(files.length, 1);
  const wake = await readFile(join(args.role.wakeDir, files[0]), 'utf8');
  assert.match(wake, /^# Discord wake\n\nRole: role\nChannel: \d+\nAuthor: session-audit\nMessage ID: \d+\n\n/);
  assert.ok(wake.trimEnd().endsWith(sent[0].content));
  assert.equal(result.dry, false);
});

test('직접 전달한 머리줄의 구분자와 줄바꿈은 발신 글과 깨움 파일에서 제거한다', async t => {
  for (const separator of ['|', '\r', '\n', '\u0085', '\u2028', '\u2029', '｜']) {
    const { args, sent } = await setup(t);
    const output = { code: warn.code, headline: `앞${separator}뒤`, facts: [], ask: '확인' };
    await deliverAudit({ ...args, events: [{ ...warn, output }] });
    assert.match(sent[0].content, /^\[감사\] role repeat-review 앞 뒤\n/);
    assert.doesNotMatch(sent[0].content, /[|｜\r\u0085\u2028\u2029]/u);
    assert.equal(sent[0].content.split('\n').length, 5);
    const [file] = await readdir(args.role.wakeDir);
    const wake = await readFile(join(args.role.wakeDir, file), 'utf8');
    assert.ok(wake.endsWith(`${sent[0].content}\n`));
    assert.doesNotMatch(wake, /[|｜\r\u0085\u2028\u2029]/u);
  }
});

test('T6 counts other audit posts from a fixture without suppressing delivery', async t => {
  const { args, sent } = await setup(t, { senderBotId: placeholder('9') });
  const first = await deliverAudit({ ...args, events: [warn] });
  const channelMessages = [
    { id: '1', content: '[감사] 자기 영수증 글' },
    { id: '2', author: { id: args.config.senderBotId }, content: '[감사] 자기 봇 글' },
    { id: '3', content: '[감사] 다른 글' },
    { id: '4', content: '[감사 보고] 다른 글' },
    { id: '5', content: '일반 글' }
  ];
  const result = await deliverAudit({ ...args, state: first.state, events: [report], channelMessages });
  assert.equal(sent.length, 2);
  assert.match(result.report, /같은 채널 다른 감사 글 2건/);
});

test('daily cap sends exactly one self-report and suppresses subsequent alerts', async t => {
  const { args, sent } = await setup(t, { dailyCap: 2 });
  const first = await deliverAudit({ ...args, events: [warn, report] });
  assert.equal(sent.length, 3);
  assert.equal(sent[2].stage, 'cap');
  assert.equal(sent[2].channelId, day);
  assert.equal(sent[2].content.split('\n').length, 1);
  assert.ok(sent[2].content.endsWith(`prompt=${promptHash.slice(0, 8)} config=${configHash.slice(0, 8)}`));
  await deliverAudit({ ...args, state: first.state, events: [{ ...warn, code: 'wake-backlog' }] });
  assert.equal(sent.length, 3);
});

test('상한으로 건너뛴 사건만 중복 없이 보고하고 다음 날 처리한다', async t => {
  const { args, sent } = await setup(t, { dailyCap: 1 });
  const skipped = { ...warn, code: 'wake-backlog' };
  const first = await deliverAudit({ ...args, events: [warn, skipped, skipped, report] });
  assert.match(first.report, /(?:^|\n)상한으로 보류 2건(?:\n|$)/);
  assert.deepEqual(sent.map(item => item.stage), ['warn', 'cap']);
  const next = await deliverAudit({ ...args, now: at + 86400000, state: first.state, events: [skipped] });
  assert.doesNotMatch(next.report, /상한으로 보류/);
  assert.deepEqual(sent.map(item => item.stage), ['warn', 'cap', 'warn', 'cap']);
});

test('상한으로 남은 대기 사건 수가 실제 보고서에 표시된다', async t => {
  const { args } = await setup(t, { dailyCap: 1 });
  const config = { ...args.config, roles: [args.role], stateFile: join(args.config.workspace, 'state.json'), reportFile: args.reportPath, judge: { runner: 'none' } };
  const input = await readFixture('scripts/test/fixtures/session-audit/case-normal');
  input.reviews.plans = [];
  input.session.period.from = '2026-11-12T00:00:00Z';
  input.session.edits = [];
  input.session.hourly_tool_calls = [{ hour: '2026-11-12T01', total: 100 }];
  input.session.text_markers = [];
  input.wake.files = Array.from({ length: 50 }, () => ({ name_at: '2026-11-12T01:00:00Z' }));
  input.ledger.rows = [];
  const now = Date.parse('2026-11-12T04:00:00Z');
  await runAudit({ config, role: 'role', input, now, sender: args.sender });
  await runAudit({ config, role: 'role', input, now: now + 1800000, sender: args.sender });
  const state = JSON.parse(await readFile(config.stateFile, 'utf8'));
  assert.equal(state.pending.role.length, 1);
  assert.match(await readFile(config.reportFile, 'utf8'), /(?:^|\n)상한으로 보류 1건(?:\n|$)/);
});

test('a new local day resets the cap but does not resend an earlier episode', async t => {
  const { args, sent } = await setup(t, { dailyCap: 1, timezone: 'Asia/Seoul' });
  const beforeMidnight = Date.parse('2026-11-12T14:59:00Z');
  const afterMidnight = Date.parse('2026-11-12T15:00:00Z');
  const first = await deliverAudit({ ...args, now: beforeMidnight, events: [warn] });
  assert.deepEqual(sent.map(item => item.stage), ['warn', 'cap']);
  const second = await deliverAudit({ ...args, state: first.state, now: afterMidnight, events: [warn, report] });
  assert.deepEqual(sent.map(item => item.stage), ['warn', 'cap', 'report', 'cap']);
  await deliverAudit({ ...args, state: second.state, now: afterMidnight, events: [report] });
  assert.equal(sent.length, 4);
});

test('report channel follows configured timezone and the fixed day/night boundary', async t => {
  const { args, sent } = await setup(t, { timezone: 'Asia/Seoul' });
  for (const time of ['2026-11-12T14:59:00Z', '2026-11-12T15:00:00Z', '2026-11-13T00:00:00Z']) {
    await deliverAudit({ ...args, now: Date.parse(time), events: [report] });
  }
  assert.deepEqual(sent.map(item => item.channelId), [day, night, day]);
});

test('dry mode and missing sender create no wake or HOLD files and report proposed sends', async t => {
  for (const mode of ['dry', 'missing']) {
    const { args, sent } = await setup(t, { dry: mode === 'dry' });
    if (mode === 'missing') delete args.sender;
    const result = await deliverAudit({ ...args, events: [warn, report] });
    assert.equal(sent.length, 0);
    assert.equal(result.dry, true);
    assert.match(result.report, /발신 예정/);
    await assert.rejects(readdir(args.role.wakeDir), { code: 'ENOENT' });
    await assert.rejects(readdir(join(args.config.workspace, '.agents', 'work', 'audit')), { code: 'ENOENT' });
  }
});

test('recovery is reported locally and sends no message or wake file', async t => {
  const { args, sent } = await setup(t);
  const result = await deliverAudit({ ...args, events: [{ ...warn, stage: 'recovered' }] });
  assert.equal(sent.length, 0);
  assert.match(result.report, /회복/);
  await assert.rejects(readdir(args.role.wakeDir), { code: 'ENOENT' });
});

test('HOLD is rejected before delivery because its path is outside audit outputs', async t => {
  const { args, sent } = await setup(t, { hold: true });
  await assert.rejects(deliverAudit({ ...args, events: [warn] }), /HOLD/);
  assert.equal(sent.length, 0);
  await assert.rejects(readdir(args.role.wakeDir), { code: 'ENOENT' });
});

test('T5 a continuing code sends only warning and report across repeated runs and state reloads', async t => {
  const { args, sent } = await setup(t);
  const config = { ...args.config, roles: [args.role], stateFile: join(args.config.workspace, 'state.json'), reportFile: args.reportPath, judge: { runner: 'none' } };
  const input = await readFixture('scripts/test/fixtures/session-audit/case-normal');
  input.reviews.plans = [];
  input.session.period.from = '2026-11-12T00:00:00Z';
  input.session.edits = [];
  input.session.hourly_tool_calls = Array.from({ length: 24 }, (_, i) => ({ hour: `2026-11-12T${String(i).padStart(2, '0')}`, total: 100 }));
  input.session.text_markers = [];
  input.wake.files = [];
  input.ledger.rows = [];
  for (let now = Date.parse('2026-11-12T04:00:00Z'); now < Date.parse('2026-11-13T00:00:00Z'); now += 30 * 60000) {
    await runAudit({ config, role: 'role', input, now, sender: args.sender });
  }
  assert.deepEqual(sent.map(item => item.stage), ['warn', 'report']);
  assert.ok(sent.every(item => /priority-idle/.test(item.content)));
  assert.equal((await readdir(args.role.wakeDir)).length, 1);
  assert.match(await readFile(config.reportFile, 'utf8'), /같은 채널 다른 감사 글 0건/);
});

test('interruption after the first of multiple sends resumes only the remaining event', async t => {
  const { args, sent } = await setup(t);
  const config = { ...args.config, roles: [args.role], stateFile: join(args.config.workspace, 'state.json'), reportFile: args.reportPath, judge: { runner: 'none' } };
  const input = await readFixture('scripts/test/fixtures/session-audit/case-normal');
  input.reviews.plans = [];
  input.session.period.from = '2026-11-12T00:00:00Z';
  input.session.edits = [];
  input.session.hourly_tool_calls = [{ hour: '2026-11-12T01', total: 100 }];
  input.session.text_markers = [];
  input.wake.files = Array.from({ length: 50 }, () => ({ name_at: '2026-11-12T01:00:00Z' }));
  input.ledger.rows = [];
  const now = Date.parse('2026-11-12T04:00:00Z');
  await runAudit({ config, role: 'role', input, now, sender: args.sender });
  const obstruction = `${config.stateFile}.${process.pid}.tmp`;
  const failingSender = async message => { const receipt = await args.sender(message); await mkdir(obstruction); return receipt; };
  await assert.rejects(runAudit({ config, role: 'role', input, now: now + 1800000, sender: failingSender }));
  assert.equal(sent.length, 1);
  await rm(obstruction, { recursive: true });
  await runAudit({ config, role: 'role', input, now: now + 1800000, sender: args.sender });
  assert.equal(sent.length, 2);
  assert.equal(new Set(sent.map(item => item.nonce)).size, 2);
  assert.deepEqual(new Set(sent.map(item => item.content.match(/^\[감사\] role ([\w-]+)/)?.[1])), new Set(['priority-idle', 'wake-backlog']));
});

test('continuous dry runs preserve a separate simulation and never consume live sends', async t => {
  const { args, sent } = await setup(t);
  const config = { ...args.config, dry: true, roles: [args.role], stateFile: join(args.config.workspace, 'state.json'), reportFile: args.reportPath, judge: { runner: 'none' } };
  const input = await readFixture('scripts/test/fixtures/session-audit/case-normal');
  input.reviews.plans = [];
  input.session.period.from = '2026-11-12T00:00:00Z';
  input.session.edits = [];
  input.session.hourly_tool_calls = Array.from({ length: 24 }, (_, i) => ({ hour: `2026-11-12T${String(i).padStart(2, '0')}`, total: 100 }));
  input.session.text_markers = [];
  input.wake.files = [];
  input.ledger.rows = [];
  const begin = Date.parse('2026-11-12T04:00:00Z'), simulated = [];
  for (let now = begin; now < begin + 8 * 3600000; now += 30 * 60000) {
    const result = await runAudit({ config, role: 'role', input, now, sender: args.sender });
    simulated.push(...result.deliveries.map(item => item.stage));
    if (result.deliveries.length) assert.match(result.report, /발신 예정/);
  }
  assert.deepEqual(simulated, ['warn', 'report']);
  assert.equal(sent.length, 0);
  await assert.rejects(readFile(config.stateFile), { code: 'ENOENT' });
  await assert.rejects(readdir(args.role.wakeDir), { code: 'ENOENT' });
  config.dry = false;
  await runAudit({ config, role: 'role', input, now: begin, sender: args.sender });
  await runAudit({ config, role: 'role', input, now: begin + 30 * 60000, sender: args.sender });
  assert.deepEqual(sent.map(item => item.stage), ['warn']);
});
