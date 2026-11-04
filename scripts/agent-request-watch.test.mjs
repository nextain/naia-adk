import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectRequests, isReceipt, parseDeadline, validateConfig, runWatch } from './agent-request-watch.mjs';
const roles = [{ id: 'a', botId: '1', aliases: ['갑'] }, { id: 'b', botId: '2', aliases: ['을'] }, { id: 'ops', botId: '3', aliases: ['운영'] }];
const at = Date.parse('2026-11-04T14:00:00Z');
const message = (id, from, content, extra = {}) => ({ id, author: { id: from, bot: true }, timestamp: new Date(at).toISOString(), content, ...extra });
const config = dir => ({ roles: structuredClone(roles), stateFile: join(dir, 'state.json'), sessionHealthConfig: join(dir, 'health.json'), recovery: { roleId: 'ops' }, guilds: [{ id: '10', channels: [{ id: '11' }] }], timezoneOffsetMinutes: 540 });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'agent-request-test-')), c = config(dir);
  let rows = [], sent = [], failPost = false, probes = 0;
  const fetchImpl = async (url, init) => {
    if (init.method === 'POST') { sent.push(JSON.parse(init.body)); if (failPost) throw Error('network failed'); return { ok: true, json: async () => ({ id: '999' }) }; }
    if (url.includes('/messages?')) return { ok: true, json: async () => rows };
    return { ok: true, json: async () => ({ guild_id: '10' }) };
  };
  const run = (now, extra = {}) => runWatch(c, { token: 'test', fetchImpl, now, log() {}, healthProbe: async () => { probes++; return [{ role: 'b', alive: 'alive' }]; }, ...extra });
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
  for (const mutate of [c => { c.roles[1].botId = '1'; }, c => { c.roles[1].aliases = ['a']; }, c => { c.thresholds = { nudgeMinutes: 30, escalateMinutes: 10 }; }, c => { c.recovery.roleId = 'absent'; }, c => { c.timezoneOffsetMinutes = 900; }, c => { c.guilds[0].channels[0].id = 'bad'; }]) { const c = structuredClone(h.c); mutate(c); assert.throws(() => validateConfig(c)); }
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
