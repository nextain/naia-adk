import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectRequests, isReceipt, parseDeadline, validateConfig, runWatch } from './agent-request-watch.mjs';
const roles = [{ id: 'a', botId: '1', aliases: ['갑'] }, { id: 'b', botId: '2', aliases: ['을'] }, { id: 'ops', botId: '3', aliases: ['운영'] }];
const at = Date.parse('2026-11-04T14:00:00Z');
const message = (id, from, content, extra = {}) => ({ id, author: { id: from, bot: true }, timestamp: new Date(at).toISOString(), content, ...extra });
const config = dir => ({ ownerRoutingStateFile: join(dir, 'owners.json'), roles: structuredClone(roles), stateFile: join(dir, 'state.json'), sessionHealthConfig: join(dir, 'health.json'), recovery: { roleId: 'ops' }, guilds: [{ id: '10' }], timezoneOffsetMinutes: 540 });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'agent-request-test-')), c = config(dir);
  await writeFile(c.ownerRoutingStateFile, '{}');
  let rows = [], sent = [], failPost = false, probes = 0;
  const fetchImpl = async (url, init) => {
    if (init.method === 'POST') { sent.push(JSON.parse(init.body)); if (failPost) throw Error('network failed'); return { ok: true, json: async () => ({ id: '999' }) }; }
    if (url.includes('/messages?')) { const after = new URL(url).searchParams.get('after'); return { ok: true, json: async () => rows.filter(m => BigInt(m.id) > BigInt(after)).sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1).slice(0, 100).reverse() }; }
    if (url.endsWith('/threads/active')) return { ok: true, json: async () => ({ threads: [] }) };
    if (url.endsWith('/guilds/10/channels')) return { ok: true, json: async () => [{ id: '11', guild_id: '10', type: 0 }] };
    throw Error(`unexpected URL ${url}`);
  };
  const run = (now, extra = {}) => runWatch(c, { token: 'test', fetchImpl, now, log() {}, healthProbe: async () => { probes++; return [{ role: 'b', alive: 'alive' }]; }, ...extra });
  await writeFile(c.stateFile, JSON.stringify({ version: 1, channels: { '10/11': { cursor: '0', pending: {} } }, errors: {} }));
  await run(at);
  return { c, dir, run, sent, rows: value => { rows = value; }, fail: () => { failPost = true; }, probes: () => probes };
}
test('request forms use bot identities and addressing boundaries', () => {
  for (const text of ['<@2> 부탁', '<@!2> 부탁', '[갑 → 을] 부탁', '을에게 부탁', '을께 부탁', '- 을: 부탁']) assert.deepEqual(detectRequests(message('100', '1', text), roles).map(r => r.id), ['b'], text);
  for (const text of ['을 이야기', '이름은 을', '가을에게 부탁', '[ops → 을] 부탁', '을에게서 소식', '운영 역할']) assert.deepEqual(detectRequests(message('100', '1', text), roles), [], text);
  assert.equal(detectRequests(message('100', '1', '을에게', { author: { id: '1', bot: false } }), roles).length, 0);
  assert.equal(detectRequests(message('100', '1', '<@2>', { webhook_id: '4' }), roles).length, 0);
  assert.equal(detectRequests(message('100', '1', '<@1>'), roles).length, 0);
});
test('receipt requires recipient identity and reply or caller mention', () => {
  const req = { from: '1', to: '2', messageId: '100' };
  assert.ok(isReceipt(message('101', '2', '<@1> 받음'), req));
  assert.ok(isReceipt(message('101', '2', '받음', { message_reference: { message_id: '100' } }), req));
  assert.ok(!isReceipt(message('101', '3', '<@1> 받음'), req));
  assert.ok(!isReceipt(message('101', '2', '갑 받음'), req));
});
test('reply mention policy defaults to strict and preserves identity and reference boundaries', () => {
  const req = { from: '1', to: '2', messageId: '100', receiptId: '101' };
  for (const strict of [undefined, true]) {
    assert.equal(isReceipt(message('102', '2', '받음 23:50까지'), req, strict), false);
    assert.equal(isReceipt(message('102', '2', '<@!1> 받음'), req, strict), true);
    assert.equal(isReceipt(message('102', '2', '받음', { mentions: [{ id: '1' }] }), req, strict), true);
    for (const reference of ['100', '101']) assert.equal(isReceipt(message('102', '2', '받음', { message_reference: { message_id: reference } }), req, strict), true);
  }
  assert.equal(isReceipt(message('102', '2', '받음'), req, false), true);
  for (const strict of [true, false]) {
    for (const extra of [{ author: { id: '3', bot: true } }, { author: { id: '2', bot: false } }, { webhook_id: '4' }, { type: 7 }, { message_reference: { message_id: '999' } }]) {
      assert.equal(isReceipt(message('102', '2', '<@1> 받음', extra), req, strict), false);
    }
  }
});
test('requireMentionInReply accepts only booleans when configured', () => {
  for (const value of [true, false]) assert.doesNotThrow(() => validateConfig({ ...config('/unused'), requireMentionInReply: value }));
  for (const value of [null, 0, 1, 'true', 'false', [], {}]) assert.throws(() => validateConfig({ ...config('/unused'), requireMentionInReply: value }), /requireMentionInReply must be boolean/);
});
test('unaddressed receipt retains nudge and escalation under the default and explicit strict policy', async () => {
  for (const strict of [undefined, true]) {
    const h = await setup(); if (strict !== undefined) h.c.requireMentionInReply = strict;
    h.rows([message('100', '1', '<@2> 부탁'), message('101', '2', '받음 23:50까지')]);
    let state = await h.run(at + 600000);
    assert.equal(state.channels['10/11'].pending['100/2'].receiptId, undefined);
    assert.equal(h.sent.length, 1); assert.match(h.sent[0].content, /<@2>.*받음 답/);
    state = await h.run(at + 1800000);
    assert.equal(state.channels['10/11'].pending['100/2'].receiptId, undefined);
    assert.equal(h.sent.length, 2); assert.match(h.sent[1].content, /<@1>.*아직 답 없음/);
    await h.run(at + 1900000); assert.equal(h.sent.length, 2);
  }
});
test('disabled reply mention requirement accepts one unaddressed receipt with its deadline', async () => {
  const h = await setup(); h.c.requireMentionInReply = false;
  h.rows([message('100', '1', '<@2> 부탁'), message('101', '2', '받음 23:50까지')]);
  const state = await h.run(at + 1800000), request = state.channels['10/11'].pending['100/2'];
  assert.equal(request.receiptId, '101'); assert.equal(request.deadline, at + 50 * 60000); assert.equal(h.sent.length, 0);
  await h.run(at + 50 * 60000); assert.equal(h.sent.length, 1); assert.match(h.sent[0].content, /끝 시각/);
});
test('disabled reply mention requirement still rejects ambiguous unaddressed receipts', async () => {
  const h = await setup(); h.c.requireMentionInReply = false;
  h.rows([message('100', '1', '<@2> 첫 부탁'), message('101', '1', '<@2> 둘째 부탁'), message('102', '2', '받음')]);
  const state = await h.run(at + 600000);
  for (const key of ['100/2', '101/2']) assert.equal(state.channels['10/11'].pending[key].receiptId, undefined);
  assert.equal(h.sent.length, 2);
});
test('deadline only parses one supported form with explicit offset', () => {
  assert.equal(parseDeadline('23:50까지', at, 540), Date.parse('2026-11-04T14:50:00Z'));
  assert.equal(parseDeadline('내일 01:20', at, 540), Date.parse('2026-11-04T16:20:00Z'));
  for (const s of ['곧', '23:50', '25:00까지', '23:99까지', '23:10까지 또는 23:20까지']) assert.equal(parseDeadline(s, at, 540), null, s);
});
test('10 and 30 minute actions once, alive probe, receipt closes and no reverse request', async () => {
  const h = await setup(); h.rows([message('100', '1', '<@2> 부탁')]);
  await h.run(at + 599999); assert.equal(h.sent.length, 0);
  await h.run(at + 600000); assert.equal(h.sent.length, 1); assert.match(h.sent[0].content, /<@2>/); assert.equal(h.probes(), 1);
  await h.run(at + 1800000); assert.equal(h.sent.length, 2); assert.match(h.sent[1].content, /<@1>/);
  await h.run(at + 1900000); assert.equal(h.sent.length, 2);
  h.rows([message('101', '2', '<@1> 받음', { timestamp: new Date(at + 1900001).toISOString() }), message('100', '1', '<@2> 부탁')]);
  const s = await h.run(at + 2000000); assert.equal(Object.keys(s.channels['10/11'].pending).length, 1); assert.equal(h.sent.length, 2);
});
test('deadline receipt delays followup then result reply closes', async () => {
  const h = await setup(); h.rows([message('101', '2', '<@1> 23:50까지', { timestamp: new Date(at + 1000).toISOString() }), message('100', '1', '<@2> 부탁')]);
  await h.run(at + 600000); assert.equal(h.sent.length, 0);
  await h.run(at + 50 * 60000); assert.equal(h.sent.length, 1); assert.match(h.sent[0].content, /끝 시각/);
  await h.run(at + 70 * 60000); assert.equal(h.sent.length, 2);
  h.rows([message('102', '2', '완료', { timestamp: new Date(at + 71 * 60000).toISOString(), message_reference: { message_id: '101' } })]);
  await h.run(at + 72 * 60000); assert.equal(h.sent.length, 2);
});
test('dead session notifies recovery; unknown health is degraded and retries', async () => {
  const h = await setup(); h.rows([message('100', '1', '<@2> 부탁')]);
  let s = await h.run(at + 600000, { healthProbe: async () => [{ role: 'b', alive: 'unknown' }] }); assert.equal(s.lastRun.result, 'degraded'); assert.equal(h.sent.length, 1);
  await h.run(at + 700000, { healthProbe: async () => [{ role: 'b', alive: 'missing' }] }); assert.equal(h.sent.length, 2); assert.match(h.sent[1].content, /<@3>/);
  await h.run(at + 800000); assert.equal(h.sent.length, 2);
});
test('wake file matches Discord wake format and dry mode has no writes', async () => {
  const h = await setup(); h.c.roles[1].wakeDir = join(h.dir, 'wake'); h.rows([message('100', '1', '<@2> 부탁')]);
  const before = await readFile(h.c.stateFile, 'utf8'); await h.run(at + 600000, { dry: true });
  assert.equal(await readFile(h.c.stateFile, 'utf8'), before); assert.equal(h.sent.length, 0); await assert.rejects(readdir(h.c.roles[1].wakeDir), { code: 'ENOENT' });
  await h.run(at + 600000); const files = await readdir(h.c.roles[1].wakeDir); assert.equal(files.length, 1); assert.match(await readFile(join(h.c.roles[1].wakeDir, files[0]), 'utf8'), /^# Discord wake\n\nRole: b/);
  await h.run(at + 700000); assert.equal((await readdir(h.c.roles[1].wakeDir)).length, 1);
});
test('uncertain sends fail closed without duplicates', async () => {
  const h = await setup(); h.rows([message('100', '1', '<@2> 부탁')]); h.fail();
  assert.equal((await h.run(at + 600000)).lastRun.result, 'degraded'); await h.run(at + 700000); assert.equal(h.sent.length, 1);
});
test('pagination failure retains cursor', async () => {
  const h = await setup(); h.rows([message('100', '1', '<@2> 부탁')]); h.c.maxPages = 1;
  h.rows(Array.from({ length: 100 }, (_, i) => message(String(100 + i), '1', '<@2> 부탁')));
  const s = await h.run(at + 600000); assert.equal(s.channels['10/11'].cursor, '0'); assert.equal(s.lastRun.result, 'degraded'); assert.equal(h.sent.length, 0);
});
test('invalid config and damaged state fail closed', async () => {
  const h = await setup();
  for (const mutate of [c => { c.roles[1].botId = '1'; }, c => { c.roles[1].aliases = ['a']; }, c => { c.thresholds = { nudgeMinutes: 30, escalateMinutes: 10 }; }, c => { c.recovery.roleId = 'absent'; }, c => { c.timezoneOffsetMinutes = 900; }, c => { c.guilds[0].excludeChannels = ['bad']; }, c => { c.guilds[0].channels = []; }]) { const c = structuredClone(h.c); mutate(c); assert.throws(() => validateConfig(c)); }
  await writeFile(h.c.stateFile, '{broken'); await assert.rejects(h.run(at), /state unreadable/);
});
test('ambiguous mention ACK cannot close multiple requests; direct reply can', async () => {
  const h = await setup(); h.rows([message('102', '2', '<@1> 받음'), message('101', '1', '<@2> 두 번째'), message('100', '1', '<@2> 첫 번째')]);
  let s = await h.run(at + 1000); assert.ok(!s.channels['10/11'].pending['100/2'].receiptId); assert.ok(!s.channels['10/11'].pending['101/2'].receiptId);
  h.rows([message('103', '2', '받음', { message_reference: { message_id: '100' } })]);
  s = await h.run(at + 2000); assert.equal(s.channels['10/11'].pending['100/2'].receiptId, '103'); assert.ok(!s.channels['10/11'].pending['101/2'].receiptId);
});
test('stage wake identities differ and consumed files do not republish', async () => {
  const h = await setup(); h.c.roles[1].wakeDir = join(h.dir, 'wake'); h.rows([message('100', '1', '<@2> 부탁')]);
  await h.run(at + 600000);
  h.rows([message('101', '2', '<@1> 23:50까지', { timestamp: new Date(at + 700000).toISOString() })]);
  await h.run(at + 800000); await h.run(at + 50 * 60000);
  assert.equal(h.probes(), 2);
  const files = await readdir(h.c.roles[1].wakeDir), ids = [];
  for (const f of files) ids.push((await readFile(join(h.c.roles[1].wakeDir, f), 'utf8')).match(/^Message ID: (\d+)$/m)[1]);
  assert.equal(ids.length, 2); assert.equal(new Set(ids).size, 2); assert.ok(!ids.includes('100'));
  await unlink(join(h.c.roles[1].wakeDir, files[0])); await h.run(at + 51 * 60000); assert.equal((await readdir(h.c.roles[1].wakeDir)).length, 1);
});
test('watcher messages are not ingested as fresh bot requests', async () => {
  const h = await setup(); h.rows([message('100', '1', '<@2> 부탁')]); await h.run(at + 600000);
  h.rows([message('999', '1', '<@2> followup')]); const s = await h.run(at + 700000);
  assert.equal(Object.keys(s.channels['10/11'].pending).length, 1);
});
test('unknown message templates and placeholders are rejected', async () => {
  const h = await setup(); h.c.messages = { typo: 'hi' }; assert.throws(() => validateConfig(h.c));
  h.c.messages = { nudge: '{typo}' }; assert.throws(() => validateConfig(h.c));
});
test('closed requests do not make later receipt ambiguous; explicit replies never fallback to mentions', async () => {
  const h = await setup(); h.rows([message('101', '2', '<@1> 받음'), message('100', '1', '<@2> 부탁')]); await h.run(at + 1000);
  h.rows([message('103', '2', '<@1> 받음'), message('102', '1', '<@2> 새 부탁')]);
  const s = await h.run(at + 2000); assert.equal(s.channels['10/11'].pending['102/2'].receiptId, '103');
  assert.equal(isReceipt(message('104', '2', '<@1> 받음', { message_reference: { message_id: '999' } }), { from: '1', to: '2', messageId: '102' }), false);
});
test('malformed pending state is rejected before API activity', async () => {
  const h = await setup(); const state = JSON.parse(await readFile(h.c.stateFile, 'utf8'));
  state.channels['10/11'].pending.bad = { messageId: '100', from: '1', to: '2', roleId: 'b', at: 'yesterday', stages: {} };
  await writeFile(h.c.stateFile, JSON.stringify(state)); await assert.rejects(h.run(at + 600000), /invalid pending state/); assert.equal(h.sent.length, 0);
});
test('deadline phase can escalate and recover even when original phase already did', async () => {
  const h = await setup(); h.rows([message('100', '1', '<@2> 부탁')]); const dead = { healthProbe: async () => [{ role: 'b', alive: 'missing' }] };
  await h.run(at + 30 * 60000, dead); assert.equal(h.sent.length, 3);
  h.rows([message('101', '2', '<@1> 23:50까지', { timestamp: new Date(at + 31 * 60000).toISOString() })]);
  await h.run(at + 32 * 60000, dead); await h.run(at + 70 * 60000, dead); assert.equal(h.sent.length, 6);
  await h.run(at + 80 * 60000, dead); assert.equal(h.sent.length, 6);
});
test('uncertain notification echoed with nonce is not ingested as request', async () => {
  const h = await setup(); h.rows([message('100', '1', '<@2> 부탁')]); h.fail(); await h.run(at + 600000);
  h.rows([message('999', '1', '<@2> followup', { nonce: h.sent[0].nonce })]); const s = await h.run(at + 700000);
  assert.equal(Object.keys(s.channels['10/11'].pending).length, 1); assert.equal(h.sent.length, 1);
});

const snowflake = time => ((BigInt(time - 1420070400000) << 22n) + 1n).toString();
async function discoveryHarness() {
  const dir = await mkdtemp(join(tmpdir(), 'agent-request-discovery-')), c = config(dir), calls = [], logs = [];
  await writeFile(c.ownerRoutingStateFile, '{}');
  let listed = [0, 5, 15, 2].map((type, index) => ({ id: String(11 + index), guild_id: '10', type }));
  let threads = [{ id: '20', guild_id: '10', parent_id: '13', type: 11 }], denied = new Set(), rows = new Map();
  const run = (now = at) => runWatch(c, {
    token: 'test', now, log: entry => logs.push(entry), healthProbe: async () => roles.map(r => ({ role: r.id, alive: 'alive' })),
    fetchImpl: async (url, init) => {
      const path = new URL(url); calls.push({ path: path.pathname, query: path.searchParams, method: init.method });
      if (path.pathname.endsWith('/guilds/10/channels')) return { ok: true, json: async () => listed };
      if (path.pathname.endsWith('/threads/active')) return { ok: true, json: async () => ({ threads }) };
      const match = path.pathname.match(/\/channels\/(\d+)\/messages$/);
      assert.ok(match, `unexpected request ${url}`);
      assert.equal(init.method, 'GET');
      assert.ok(!listed.some(ch => ch.id === match[1] && ch.type === 15), 'forum containers have no message endpoint');
      if (denied.has(match[1])) return { ok: false, status: 403 };
      assert.ok(path.searchParams.has('after'));
      assert.ok(!path.searchParams.has('before'));
      const after = BigInt(path.searchParams.get('after'));
      return { ok: true, json: async () => (rows.get(match[1]) ?? []).filter(m => BigInt(m.id) > after).sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1).slice(0, 100).reverse() };
    },
  });
  return { c, calls, logs, run, rows, denied, setListed: value => { listed = value; }, setThreads: value => { threads = value; } };
}

test('guild discovery reads text, announcement, forum and active threads every run', async () => {
  const h = await discoveryHarness(); let state = await h.run();
  assert.deepEqual(Object.keys(state.channels).sort(), ['10/11', '10/12', '10/20']);
  h.setListed([{ id: '21', guild_id: '10', type: 0 }]); h.setThreads([{ id: '22', guild_id: '10', type: 12 }]);
  state = await h.run(at + 1000);
  assert.ok(state.channels['10/21']); assert.ok(state.channels['10/22']);
  assert.equal(h.calls.filter(call => call.path.endsWith('/guilds/10/channels')).length, 2);
  assert.equal(h.calls.filter(call => call.path.endsWith('/threads/active')).length, 2);
  assert.ok(!h.calls.some(call => call.path.includes('/channels/14/')));
});

test('excludeChannels excludes a channel, its threads and individually excluded threads', async () => {
  const h = await discoveryHarness(); h.c.guilds[0].excludeChannels = ['13', '30'];
  h.setThreads([{ id: '20', guild_id: '10', parent_id: '13', type: 11 }, { id: '30', guild_id: '10', parent_id: '11', type: 12 }, { id: '31', guild_id: '10', parent_id: '11', type: 11 }]);
  const state = await h.run();
  assert.deepEqual(Object.keys(state.channels).sort(), ['10/11', '10/12', '10/31']);
  assert.deepEqual(h.calls.filter(call => call.path.includes('/channels/')).map(call => call.path.split('/')[4]), ['11', '12', '31']);
});

test('403 reads log one skip, retain existing cursor and allow other channels to complete', async () => {
  const h = await discoveryHarness(); await h.run();
  const stateBefore = JSON.parse(await readFile(h.c.stateFile, 'utf8')); h.denied.add('11');
  const state = await h.run(at + 1000);
  assert.equal(state.lastRun.result, 'complete'); assert.deepEqual(state.errors, {});
  assert.deepEqual(state.channels['10/11'], stateBefore.channels['10/11']);
  assert.equal(h.logs.filter(entry => entry.result === 'skipped' && entry.channelId === '11').length, 1);
  assert.ok(h.calls.some(call => call.path.endsWith('/channels/20/messages')));
});

test('first execution reads only two hours and later executions use saved after cursor', async () => {
  const h = await discoveryHarness(); h.setListed([{ id: '11', guild_id: '10', type: 0 }]); h.setThreads([]);
  const old = snowflake(at - 2 * 3600000 - 1), recent = snowflake(at - 1000);
  h.rows.set('11', [message(old, '1', '<@2> old'), message(recent, '1', '<@2> recent', { timestamp: new Date(at - 1000).toISOString() })]);
  let state = await h.run();
  const read = h.calls.find(call => call.path.endsWith('/messages'));
  assert.equal(read.query.get('after'), (BigInt(at - 2 * 3600000 - 1420070400000) << 22n).toString());
  assert.deepEqual(Object.keys(state.channels['10/11'].pending), [`${recent}/2`]);
  const next = snowflake(at + 1000); h.rows.get('11').push(message(next, '1', 'plain', { timestamp: new Date(at + 1000).toISOString() }));
  state = await h.run(at + 2000);
  assert.equal(h.calls.at(-1).query.get('after'), recent); assert.equal(state.channels['10/11'].cursor, next);
});

test('after pagination processes all closest pages in order without replaying history', async () => {
  const h = await discoveryHarness(); h.setListed([{ id: '11', guild_id: '10', type: 0 }]); h.setThreads([]);
  const rows = Array.from({ length: 205 }, (_, index) => message(snowflake(at - 1000 + index), '1', 'plain', { timestamp: new Date(at - 1000 + index).toISOString() }));
  rows[0].content = '<@2> request';
  rows[100] = { ...rows[100], author: { id: '2', bot: true }, content: 'received', message_reference: { message_id: rows[0].id } };
  h.rows.set('11', rows);
  const state = await h.run(); const reads = h.calls.filter(call => call.path.endsWith('/messages'));
  assert.equal(reads.length, 3); assert.equal(reads[1].query.get('after'), rows[99].id); assert.equal(reads[2].query.get('after'), rows[199].id);
  assert.equal(state.channels['10/11'].cursor, rows[204].id);
  assert.equal(state.channels['10/11'].pending[`${rows[0].id}/2`].receiptId, rows[100].id);
  assert.equal(state.channels['10/11'].pending[`${rows[0].id}/2`].closedAt, Date.parse(rows[100].timestamp));
  await h.run(at + 1000); assert.equal(h.calls.at(-1).query.get('after'), rows[204].id);
});


test('initial failed read preserves its two-hour cursor across retries', async () => {
  const h = await discoveryHarness(); h.setListed([{ id: '11', guild_id: '10', type: 0 }]); h.setThreads([]); h.denied.add('11');
  const initial = await h.run(); const cursor = initial.channels['10/11'].cursor;
  h.denied.clear();
  const recent = snowflake(at - 2 * 3600000 + 1000);
  h.rows.set('11', [message(recent, '1', 'plain', { timestamp: new Date(at - 2 * 3600000 + 1000).toISOString() })]);
  const state = await h.run(at + 3 * 3600000);
  assert.equal(h.calls.at(-1).query.get('after'), cursor); assert.equal(state.channels['10/11'].cursor, recent);
});

test('shared gateway ownership suppresses bot-to-bot reminder and recovery publications', async () => {
  const f = await setup();
  f.c.ownerRoutingStateFile = join(f.dir, 'owners.json');
  await writeFile(f.c.ownerRoutingStateFile, JSON.stringify({ '100': { ownerRole: 'b' } }));
  f.rows([message('100', '1', '<@2> <@3> help')]);
  await f.run(at + 10 * 60000);
  await f.run(at + 40 * 60000);
  assert.equal(f.sent.length, 0); assert.equal(f.probes(), 0);
});
