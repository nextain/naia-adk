import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { acquireLock, dueNotices, messengerSender, noticeBody, readState, runOnce, wallNow } from './schedule-notify.mjs';
import { createClient } from '../messenger/msg.mjs';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-notify-'));
const timed = { id: 'ps-1', title: 'Planning', start: '2026-11-12 10:00', end: '2026-11-12 11:00', allDay: false, memo: '' };
const allDay = { id: 'ps-2', title: 'Offsite', start: '2026-11-12', end: '2026-11-13', allDay: true, memo: '' };
const early = { id: 'ps-3', title: 'Early call', start: '2026-11-12 07:00', end: '2026-11-12 07:30', allDay: false, memo: '' };
const config = {
  timeZone: 'UTC', morning: '08:30', beforeMinutes: [10], graceMinutes: 30, dashboardUrl: '',
  personal: [{ user: 'person', channel: 'person-dm', mention: '@person' }],
  milestones: { channel: 'general', source: 'http://127.0.0.1:1/board-schedule' },
};
const milestone = { id: 'm1', name: 'Beta', dueDate: '2026-11-12', completed: 1, total: 3 };

test('morning notice for timed and all-day items, milestone on its due date', () => {
  const keys = dueNotices({ now: '2026-11-12 08:35', personal: [{ user: 'person', items: [timed, allDay, early] }], milestones: [milestone] }).map((n) => n.key);
  assert.deepEqual(keys, [
    'personal:person:ps-1:2026-11-12 10:00:morning',
    'personal:person:ps-2:2026-11-12:morning',
    'milestone:m1:2026-11-12:morning',
  ]);
});

test('N minutes before: only inside the window and before the start; all-day items get none', () => {
  const at = (now) => dueNotices({ now, personal: [{ user: 'person', items: [timed, allDay] }], morning: '06:00' }).map((n) => n.key);
  assert.deepEqual(at('2026-11-12 09:49'), []);
  assert.deepEqual(at('2026-11-12 09:50'), ['personal:person:ps-1:2026-11-12 10:00:before10']);
  assert.deepEqual(at('2026-11-12 09:59'), ['personal:person:ps-1:2026-11-12 10:00:before10']);
  assert.deepEqual(at('2026-11-12 10:00'), []);
});

test('stale notices are not sent after the grace window; completed milestones are skipped', () => {
  assert.deepEqual(dueNotices({ now: '2026-11-12 09:01', personal: [{ user: 'person', items: [allDay] }] }), []);
  assert.deepEqual(dueNotices({ now: '2026-11-12 08:30', milestones: [{ ...milestone, completed: 3 }] }), []);
});

test('notice body links to the schedule detail and escapes markdown in titles', () => {
  const [notice] = dueNotices({ now: '2026-11-12 09:50', personal: [{ user: 'person', items: [{ ...timed, title: 'a [x](y) *b*' }] }], morning: '06:00' });
  const body = noticeBody(notice, { dashboardUrl: 'https://dash.example.test', mention: '@person' });
  assert.equal(body, '@person 10분 뒤 시작: **a \\[x\\](y) \\*b\\*** · 10:00~11:00\n[일정에서 보기](https://dash.example.test/schedule?item=personal%3Aps-1&date=2026-11-12)');
  const [ms] = dueNotices({ now: '2026-11-12 08:30', milestones: [milestone] });
  assert.match(noticeBody(ms), /^오늘 기한 마일스톤: \*\*Beta\*\* \(1\/3\)\n\[일정에서 보기\]\(\/schedule\?item=milestone%3Am1&date=2026-11-12\)$/);
});

test('an id the link cannot carry falls back to the schedule screen', () => {
  const [ms] = dueNotices({ now: '2026-11-12 08:30', milestones: [{ ...milestone, id: 'has space' }] });
  assert.match(noticeBody(ms, { dashboardUrl: 'https://dash.example.test/' }), /\(https:\/\/dash\.example\.test\/schedule\)$/);
});

test('wallNow uses the configured time zone', () => {
  assert.equal(wallNow(new Date('2026-11-11T23:35:00Z'), 'Asia/Seoul'), '2026-11-12 08:35');
  assert.equal(wallNow(new Date('2026-11-11T23:35:00Z'), 'UTC'), '2026-11-11 23:35');
});

function harness() {
  const dir = temp();
  const posts = [];
  let next = 1;
  return {
    dir, posts, stateFile: path.join(dir, 'state.json'),
    send: async (channel, body) => { posts.push({ channel, body }); return { id: `msg-${next++}` }; },
    loadPersonal: async () => ({ items: [timed, allDay] }),
    loadMilestones: async () => [milestone],
  };
}

test('no duplicate notices: a second run in the same window sends nothing and keeps the receipts', async () => {
  const h = harness();
  const nowDate = new Date('2026-11-12T08:31:00Z');
  const first = await runOnce({ config, nowDate, ...h });
  assert.deepEqual(first.map((r) => r.status), ['sent', 'sent', 'sent']);
  assert.deepEqual(h.posts.map((p) => p.channel), ['person-dm', 'person-dm', 'general']);
  assert.ok(h.posts[0].body.startsWith('@person 오늘 일정: **Planning**'));
  const receipts = readState(h.stateFile).receipts;
  assert.equal(receipts['personal:person:ps-1:2026-11-12 10:00:morning'].messageId, 'msg-1');
  const second = await runOnce({ config, nowDate: new Date('2026-11-12T08:40:00Z'), ...h });
  assert.deepEqual(second.map((r) => r.status), ['skipped', 'skipped', 'skipped']);
  assert.equal(h.posts.length, 3);
});

test('a notice left "pending" by a crash is reported, not sent again', async () => {
  const h = harness();
  fs.writeFileSync(h.stateFile, JSON.stringify({ version: 1, receipts: { 'milestone:m1:2026-11-12:morning': { pending: true, startedAt: '2026-11-12T08:30:00Z' } } }));
  const results = await runOnce({ config, nowDate: new Date('2026-11-12T08:31:00Z'), ...h });
  assert.equal(results.find((r) => r.key.startsWith('milestone')).status, 'unknown');
  assert.equal(h.posts.filter((p) => p.channel === 'general').length, 0);
});

test('a server refusal is retried next run; a dropped connection is not', async () => {
  const h = harness();
  let mode = 'refuse';
  const send = async (channel, body) => {
    if (mode === 'refuse') throw new Error('메신저 요청 실패 (503)');
    if (mode === 'drop') throw new Error('fetch failed');
    return h.send(channel, body);
  };
  const nowDate = new Date('2026-11-12T08:31:00Z');
  const cfg = { ...config, milestones: undefined };
  assert.deepEqual((await runOnce({ config: cfg, nowDate, ...h, send })).map((r) => r.status), ['failed', 'failed']);
  mode = 'drop';
  const dropped = await runOnce({ config: cfg, nowDate, ...h, send, loadPersonal: async () => ({ items: [timed] }) });
  assert.deepEqual(dropped.map((r) => r.status), ['failed']);
  mode = 'ok';
  const after = await runOnce({ config: cfg, nowDate, ...h, send });
  assert.deepEqual(after.map((r) => r.status), ['unknown', 'sent']);
  assert.equal(h.posts.length, 1);
});

test('dry run writes no state and sends nothing', async () => {
  const h = harness();
  const results = await runOnce({ config, nowDate: new Date('2026-11-12T08:31:00Z'), ...h, dryRun: true });
  assert.deepEqual(results.map((r) => r.status), ['dry-run', 'dry-run', 'dry-run']);
  assert.equal(h.posts.length, 0);
  assert.ok(!fs.existsSync(h.stateFile));
});

test('lock: a live holder blocks a second run, a dead holder\'s lock is cleared', () => {
  const dir = temp();
  const file = path.join(dir, 'state.json');
  const release = acquireLock(file);
  assert.ok(release);
  assert.equal(acquireLock(file), null);
  release();
  fs.writeFileSync(`${file}.lock`, '999999999');
  const again = acquireLock(file);
  assert.ok(again);
  again();
});

test('lock: an empty or unreadable lock is treated as held until it is stale', () => {
  const dir = temp();
  const file = path.join(dir, 'state.json');
  // 잠금을 막 만든 실행이 pid 를 아직 못 적은 순간과 같은 모양. 지우면 두 실행이 함께 돈다.
  fs.writeFileSync(`${file}.lock`, '');
  assert.equal(acquireLock(file), null);
  assert.ok(fs.existsSync(`${file}.lock`));
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(`${file}.lock`, old, old);
  const release = acquireLock(file);
  assert.ok(release);
  assert.equal(fs.readFileSync(`${file}.lock`, 'utf8'), String(process.pid));
  release();
  assert.ok(!fs.existsSync(`${file}.lock`));
});

test('lock: release does not remove a lock someone else now holds', () => {
  const dir = temp();
  const file = path.join(dir, 'state.json');
  const release = acquireLock(file);
  fs.unlinkSync(`${file}.lock`);
  fs.writeFileSync(`${file}.lock`, '1');
  release();
  assert.equal(fs.readFileSync(`${file}.lock`, 'utf8'), '1');
});

test('lock race: many processes start at once, with or without a dead lock, and exactly one gets it', async () => {
  const modulePath = new URL('./schedule-notify.mjs', import.meta.url).href;
  const script = `
    import { acquireLock } from ${JSON.stringify(modulePath)};
    const [file, go] = process.argv.slice(1);
    while (Date.now() < Number(go)) {}
    const release = acquireLock(file);
    process.stdout.write(release ? 'got' : 'busy');
    if (release) { const until = Date.now() + 1500; while (Date.now() < until) {} release(); }
  `;
  for (const deadLock of [false, true]) {
    const dir = temp();
    const file = path.join(dir, 'state.json');
    if (deadLock) fs.writeFileSync(`${file}.lock`, '999999999');
    const go = String(Date.now() + 1500);
    const runs = Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, file, go], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.on('error', reject);
      child.on('close', () => resolve(out));
    }));
    const outcomes = await Promise.all(runs);
    assert.equal(outcomes.filter((o) => o === 'got').length, 1, `deadLock=${deadLock}: ${outcomes.join(',')}`);
    assert.equal(outcomes.filter((o) => o === 'busy').length, 7);
    assert.deepEqual(fs.readdirSync(dir), []);
  }
});

test('messengerSender posts to the channel by name through the messenger API', async (t) => {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, token: req.headers['x-ax-agent-token'], body });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/portal/messenger/channels') return res.end(JSON.stringify([{ id: 'c1', name: 'general' }]));
      res.end(JSON.stringify({ id: 'msg-9' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const send = messengerSender(createClient({ url: `http://127.0.0.1:${server.address().port}`, token: 'test-only' }));
  assert.deepEqual(await send('general', 'hello'), { id: 'msg-9' });
  await assert.rejects(send('missing', 'x'), /채널을 찾지 못했습니다/);
  assert.deepEqual(seen.map((s) => `${s.method} ${s.url}`), ['GET /api/portal/messenger/channels', 'POST /api/portal/messenger/channels/c1/messages']);
  assert.equal(seen[1].token, 'test-only');
  assert.deepEqual(JSON.parse(seen[1].body), { body: 'hello' });
});
