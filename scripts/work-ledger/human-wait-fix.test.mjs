import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { watch } from './ledger-watch.mjs';
import { main as ledgerMain } from './ledger.mjs';
import { createAdapter } from './messenger.mjs';

const at = (time) => Date.parse(`2026-11-09T${time}Z`);
const config = () => ({ provider: { type: 'discord', guild_id: 'example-guild' }, channel_read_interval_ms: 0,
  human_wait: { after_min: 15 }, roles: [{ role: 'radio', user_ids: ['bot-a'], human_ids: ['owner-a'], channels: ['studio'], check_unrecorded_human: false }] });
// REST message objects intentionally omit guild_id. Discord returns a channel object for threads.
const msg = (id, author, time, content, extra = {}) => ({ id, channel_id: 'studio', author: { id: author },
  timestamp: new Date(at(time)).toISOString(), edited_timestamp: null, content,
  mentions: [...content.matchAll(/<@([^>]+)>/g)].map((m) => ({ id: m[1] })), ...extra });
const question = () => msg('question', 'bot-a', '01:04:23', '<@owner-a> 지금 바로 시작해도 될까요?');
const ok = (data) => ({ ok: true, status: 200, json: async () => data });
async function setup(t, messages, threads = [], conf = config(), failures = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'human-wait-fix-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests = [], sleeps = [];
  const adapter = createAdapter(conf.provider, { env: { DISCORD_BOT_TOKEN: 'fake-test-token' }, sleep: async (ms) => sleeps.push(ms),
    fetchImpl: async (url) => {
      const endpoint = new URL(url).pathname; requests.push(endpoint);
      if (failures[endpoint]) return failures[endpoint]();
      if (/\/messages\/[^/]+$/.test(endpoint)) return { ok: false, status: 404, text: async () => 'Unknown Message' };
      if (endpoint.endsWith('/threads/active')) return ok({ threads });
      const match = endpoint.match(/\/channels\/([^/]+)\/messages$/);
      if (match) return ok(messages[match[1]] || []);
      const channel = endpoint.match(/\/channels\/([^/]+)$/);
      if (channel) return ok({ id: channel[1], type: 0, guild_id: 'example-guild' });
      throw new Error(`Unexpected endpoint ${endpoint}`);
    } });
  const run = (time = '01:20:00') => watch({ root, config: conf, adapter, now: at(time), sleep: async () => {} });
  return { root, run, requests, sleeps };
}
async function wakeBodies(root) {
  const dir = path.join(root, '.agents/work/l4/wake');
  return Promise.all((await readdir(dir)).map(async (name) => ({ name, body: await readFile(path.join(dir, name), 'utf8') })));
}

test('radio 80 minute incident: unrelated bot followups and bot collaboration retain one human wake', async (t) => {
  const conf = config(); conf.roles.push({ role: 'helper', user_ids: ['bot-b'], channels: [] });
  const s = await setup(t, { studio: [question(),
    msg('art', 'bot-a', '01:10:38', '<@owner-a> 배경 시안 둘입니다. 고르시면 반복 영상으로 만들겠습니다.'),
    msg('collaboration', 'bot-a', '01:30:17', '<@bot-b> 변경 반영 부탁합니다.') ] }, [], conf);
  assert.equal((await s.run('01:19:22')).wakes.length, 0);
  const result = await s.run('01:19:23');
  assert.equal(result.wakes.length, 1);
  assert.match((await wakeBodies(s.root))[0].body, /question/);
  assert.equal((await s.run('02:24:23')).wakes.length, 1, 'later selection request also wakes once');
  assert.equal((await s.run('02:34:23')).wakes.length, 0);
});
for (const lastQuestion of [false, true]) test(`split 2000 character post: question in ${lastQuestion ? 'last' : 'first'} fragment`, async (t) => {
  const first = msg('split-first', 'bot-a', '01:04:00', ('<@owner-a> ' + (lastQuestion ? '안내 '.repeat(665) : '지금 시작해도 될까요? ' + '안내 '.repeat(660))).slice(0, 2000));
  const last = msg('split-last', 'bot-a', '01:04:01', lastQuestion ? '지금 시작해도 될까요?' : '추가 안내입니다.');
  const s = await setup(t, { studio: [first, last] });
  assert.equal((await s.run()).wakes.length, 1);
  assert.equal((await s.run('02:20:00')).wakes.length, 0);
});
test('active thread owner supplies human target without mention or referenced message', async (t) => {
  const s = await setup(t, { discussion: [msg('thread-question', 'bot-a', '01:04:00', '지금 시작해도 될까요?', { channel_id: 'discussion', message_reference: { message_id: 'old-human' }, referenced_message: null })] },
    [{ id: 'discussion', type: 11, parent_id: 'studio', owner_id: 'owner-a', guild_id: 'example-guild', thread_metadata: { archived: false } }]);
  assert.equal((await s.run()).wakes.length, 1);
  assert.match((await wakeBodies(s.root))[0].body, /channels\/example-guild\/discussion\/thread-question/);
});
test('direct channel question needs no human mention', async (t) => {
  const conf = config(); conf.roles[0].channels = []; conf.roles[0].direct_channels = ['direct'];
  const s = await setup(t, { direct: [msg('direct-question', 'bot-a', '01:04:00', '지금 시작해도 될까요?', { channel_id: 'direct' })] }, [], conf);
  assert.equal((await s.run()).wakes.length, 1);
});
for (const kind of ['same-channel', 'thread', 'reference']) test(`only addressed human reply closes question: ${kind}`, async (t) => {
  const q = question(); const messages = { studio: [q] }; let threads = [];
  if (kind === 'same-channel') messages.studio.push(msg('answer', 'owner-a', '01:10:00', '진행하세요.'));
  if (kind === 'thread') { q.thread = { id: 'question', type: 11, parent_id: 'studio', thread_metadata: { archived: false } }; messages.question = [msg('answer', 'owner-a', '01:10:00', '진행하세요.', { channel_id: 'question' })]; }
  if (kind === 'reference') { messages.studio.push(msg('answer', 'owner-a', '01:10:00', '진행하세요.', { message_reference: { message_id: 'question' }, referenced_message: { id: 'question', author: { id: 'bot-a' } } })); }
  const s = await setup(t, messages, threads); assert.equal((await s.run()).wakes.length, 0);
});
test('other human does not close addressed question', async (t) => {
  const s = await setup(t, { studio: [question(), msg('bystander', 'owner-b', '01:10:00', '다른 이야기')] });
  assert.equal((await s.run()).wakes.length, 1);
});
test('editing previously answered question does not resurrect it', async (t) => {
  const q = question(); q.edited_timestamp = new Date(at('02:00:00')).toISOString();
  const s = await setup(t, { studio: [q, msg('answer', 'owner-a', '01:10:00', '진행하세요.')] });
  assert.equal((await s.run('02:20:00')).wakes.length, 0);
});
for (const body of ['<@owner-a> 완료했습니다.\n> 지금 시작해도 될까요?', '<@owner-a> 완료했습니다.\n```\n지금 시작해도 될까요?\n```', '<@owner-a> 문제가 있으면 말씀 주시면 바로 수정하겠습니다.', '<@owner-a> 추가로 필요하신 점 알려 주시면 반영하겠습니다.', '<@owner-a> 일꾼 결과를 기다리겠습니다.', '<@owner-a> 시작해도 될까요? 네, 기존 지시대로 바로 시작했습니다.', '<@bot-b> 포트 확인됐나요?', '<@owner-a> 완료 보고입니다.\n\n<@bot-b> 포트 확인됐나요?']) test(`no false wake: ${JSON.stringify(body)}`, async (t) => {
  const conf = config(); conf.roles.push({ role: 'helper', user_ids: ['bot-b'], channels: [] });
  const s = await setup(t, { studio: [msg('report', 'bot-a', '01:04:00', body, { message_reference: { message_id: 'old-human' }, referenced_message: { id: 'old-human', author: { id: 'owner-a' } } })] }, [], conf);
  assert.equal((await s.run()).wakes.length, 0);
});
test('corrupt state warns once and keeps durable question dedup', async (t) => {
  const s = await setup(t, { studio: [question()] });
  assert.equal((await s.run()).wakes.length, 1);
  const wakeDir = path.join(s.root, '.agents/work/l4/wake');
  for (const file of await readdir(wakeDir)) await rm(path.join(wakeDir, file));
  await writeFile(path.join(s.root, '.agents/work/ledger/watch-state.json'), '{broken');
  const reset = await s.run('02:20:00');
  assert.equal(reset.wakes.filter((w) => w.reason?.includes('사람')).length, 0);
  assert.ok(reset.warnings.length + reset.errors.length + reset.wakes.length > 0);
  assert.equal((await s.run('02:30:00')).wakes.length, 0);
  assert.equal((await wakeBodies(s.root)).filter((f) => f.name.includes('human-wait')).length, 0);
});
test('human-wait-only empty ledger avoids unrecorded human alarms and uses flat wake route', async (t) => {
  const s = await setup(t, { studio: [msg('human', 'owner-a', '00:00:00', '<@bot-a> 이전 대화입니다.'), question()] });
  const result = await s.run(); assert.equal(result.wakes.length, 1);
  const files = await wakeBodies(s.root); assert.equal(files.length, 1); assert.match(files[0].name, /-route-radio\.md$/);
});
test('guild active threads are fetched once per watch round across channels and roles', async (t) => {
  const conf = config(); conf.roles[0].channels.push('other'); conf.roles.push({ ...conf.roles[0], role: 'helper', user_ids: ['bot-b'] });
  const s = await setup(t, {}, [], conf); await s.run();
  assert.equal(s.requests.filter((p) => p.endsWith('/threads/active')).length, 1);
});
test('long retry_after is skipped within bounded wait and another role still detects question', async (t) => {
  const conf = config(); conf.roles[0].channels = ['blocked']; conf.roles.push({ ...conf.roles[0], role: 'helper', channels: ['studio'] });
  const limited = () => ({ ok: false, status: 429, headers: { get: () => null }, text: async () => JSON.stringify({ retry_after: 3600 }), json: async () => ({ retry_after: 3600 }) });
  const s = await setup(t, { studio: [question()] }, [], conf, { '/api/v10/channels/blocked/messages': limited });
  const result = await s.run(); assert.ok(result.warnings.length); assert.equal(result.wakes.length, 1);
  assert.ok(s.sleeps.reduce((a, b) => a + b, 0) < 60000);
});

test('old human reference resolves missing referenced_message through Discord message endpoint', async (t) => {
  const old = msg('old-human', 'owner-a', '00:00:00', '준비하세요.');
  const s = await setup(t, { studio: [msg('reply-question', 'bot-a', '01:04:00', '지금 시작해도 될까요?', { message_reference: { channel_id: 'studio', message_id: 'old-human' }, referenced_message: null })] }, [], config(), {
    '/api/v10/channels/studio/messages/old-human': () => ok(old),
  });
  assert.equal((await s.run()).wakes.length, 1);
  assert.equal(s.requests.filter((p) => p.endsWith('/messages/old-human')).length, 1);
});

test('human reply in parent channel closes thread question by message_reference', async (t) => {
  const s = await setup(t, {
    discussion: [msg('thread-question', 'bot-a', '01:04:00', '지금 시작해도 될까요?', { channel_id: 'discussion' })],
    studio: [msg('parent-answer', 'owner-a', '01:10:00', '진행하세요.', { message_reference: { channel_id: 'discussion', message_id: 'thread-question' }, referenced_message: { id: 'thread-question', author: { id: 'bot-a' } } })],
  }, [{ id: 'discussion', type: 11, parent_id: 'studio', owner_id: 'owner-a', guild_id: 'example-guild', thread_metadata: { archived: false } }]);
  assert.equal((await s.run()).wakes.length, 0);
});

test('multiline bot question after human completion report does not wait for human', async (t) => {
  const conf = config(); conf.roles.push({ role: 'helper', user_ids: ['bot-b'], channels: [] });
  const s = await setup(t, { studio: [msg('mixed-report', 'bot-a', '01:04:00', '<@owner-a> 완료 보고입니다.\n\n<@bot-b>\n포트 확인됐나요?')] }, [], conf);
  assert.equal((await s.run()).wakes.length, 0);
});

test('real DM channel metadata skips guild threads and wakes pending question once', async (t) => {
  const conf = config(); delete conf.provider.guild_id;
  conf.roles[0].channels = []; conf.roles[0].direct_channels = ['direct'];
  const s = await setup(t, { direct: [msg('dm-question', 'bot-a', '01:04:00', '지금 시작해도 될까요?', { channel_id: 'direct' })] }, [], conf, {
    '/api/v10/channels/direct': () => ok({ id: 'direct', type: 1, recipients: [{ id: 'owner-a', bot: false }] }),
  });
  const first = await s.run();
  assert.deepEqual(first.errors, []);
  assert.deepEqual(first.warnings, []);
  assert.equal(first.wakes.length, 1);
  assert.equal((await s.run('02:20:00')).wakes.length, 0);
  assert.equal(s.requests.filter((endpoint) => endpoint.includes('/guilds/')).length, 0);
  assert.match((await wakeBodies(s.root))[0].body, /channels\/@me\/direct\/dm-question/);
});


test('migration keeps later split fragment dedup when grouping chooses first fragment', async (t) => {
  const s = await setup(t, { studio: [
    msg('split-first', 'bot-a', '01:04:00', '상세 안내 '.repeat(330)),
    msg('split-last', 'bot-a', '01:04:01', '<@owner-a> 지금 시작해도 될까요?'),
  ] });
  const ledgerDir = path.join(s.root, '.agents/work/ledger');
  await mkdir(ledgerDir, { recursive: true });
  const priorKey = JSON.stringify(['radio', 'studio', 'split-last']);
  await writeFile(path.join(ledgerDir, 'watch-state.json'), JSON.stringify({ version: 1, sent: {}, mentions: {}, thread_cursors: {}, human_wait_sent: { [priorKey]: at('01:19:01') } }));
  const result = await s.run('01:20:00');
  assert.deepEqual(result.errors, []);
  assert.equal(result.wakes.length, 0);
  assert.equal((await s.run('02:20:00')).wakes.length, 0);
});

test('configured guild still treats direct_channels as DM with @me link and no guild request', async (t) => {
  const conf = config(); conf.roles[0].channels = []; conf.roles[0].direct_channels = ['direct'];
  const s = await setup(t, { direct: [msg('dm-question', 'bot-a', '01:04:00', '지금 시작해도 될까요?', { channel_id: 'direct' })] }, [], conf, {
    '/api/v10/channels/direct': () => ok({ id: 'direct', type: 1, recipients: [{ id: 'owner-a', bot: false }] }),
  });
  const first = await s.run();
  assert.deepEqual(first.errors, []);
  assert.deepEqual(first.warnings, []);
  assert.equal(first.wakes.length, 1);
  assert.equal((await s.run('02:20:00')).wakes.length, 0);
  assert.equal(s.requests.filter((endpoint) => endpoint.includes('/guilds/')).length, 0);
  assert.match((await wakeBodies(s.root))[0].body, /channels\/@me\/direct\/dm-question/);
});

test('two short independent questions within two minutes each wake exactly once', async (t) => {
  const s = await setup(t, { studio: [
    msg('short-first', 'bot-a', '01:04:00', '<@owner-a> 지금 시작해도 될까요?'),
    msg('short-second', 'bot-a', '01:05:00', '<@owner-a> 배경은 어느 것을 고르시겠어요?'),
  ] });
  assert.equal((await s.run()).wakes.length, 2);
  assert.equal((await s.run('02:20:00')).wakes.length, 0);
  const files = await wakeBodies(s.root);
  assert.equal(files.filter((f) => f.name.includes('human-wait')).length, 2);
  assert.ok(files.some((f) => f.name.includes('short-first')));
  assert.ok(files.some((f) => f.name.includes('short-second')));
});

test('unrelated progress paragraph does not self-answer pending human question', async (t) => {
  const s = await setup(t, { studio: [msg('question-with-other-progress', 'bot-a', '01:04:00', '<@owner-a> 지금 시작해도 될까요?\n\n다른 작업은 바로 시작했습니다.')] });
  assert.equal((await s.run()).wakes.length, 1);
  assert.equal((await s.run('02:20:00')).wakes.length, 0);
});

test('attached thread retains learned guild URL when active threads return 429', async (t) => {
  const conf = config(); delete conf.provider.guild_id;
  const limited = () => ({ ok: false, status: 429, headers: { get: () => null }, text: async () => JSON.stringify({ retry_after: 3600 }) });
  const s = await setup(t, {
    studio: [msg('starter', 'owner-a', '00:00:00', '이곳에서 준비하세요.', { thread: { id: 'attached', type: 11, parent_id: 'studio', thread_metadata: { archived: false } } })],
    attached: [msg('attached-question', 'bot-a', '01:04:00', '지금 시작해도 될까요?', { channel_id: 'attached' })],
  }, [], conf, { '/api/v10/channels/studio': () => ok({ id: 'studio', type: 0, guild_id: 'guild-learned' }), '/api/v10/guilds/guild-learned/threads/active': limited });
  const result = await s.run();
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.length > 0);
  assert.equal(result.wakes.length, 1);
  const [file] = await wakeBodies(s.root);
  assert.match(file.body, /channels\/guild-learned\/attached\/attached-question/);
  assert.doesNotMatch(file.body, /channels\/@me/);
});

test('retry budget across seven channels waits no more than thirty seconds', async (t) => {
  const conf = config(); conf.roles[0].channels = Array.from({ length: 7 }, (_, i) => `limited-${i}`);
  const limited = () => ({ ok: false, status: 429, headers: { get: () => null }, text: async () => JSON.stringify({ retry_after: 5 }) });
  const failures = Object.fromEntries(conf.roles[0].channels.map((ch) => [`/api/v10/channels/${ch}/messages`, limited]));
  const s = await setup(t, {}, [], conf, failures);
  const result = await s.run();
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.length >= 7);
  assert.equal(s.sleeps.reduce((sum, delay) => sum + delay, 0), 30000);
  assert.ok(s.sleeps.every((delay) => delay <= 5000));
  assert.equal(s.requests.filter((p) => p.endsWith('/messages')).length, 13);
});


test('all roles local overdue checks finish before first network request', async (t) => {
  const conf = config(); conf.roles.push({ ...conf.roles[0], role: 'helper', user_ids: ['bot-b'] });
  let root, firstNetworkChecked = false;
  const s = await setup(t, {}, [], conf, {
    '/api/v10/channels/studio/messages': async () => {
      const files = await wakeBodies(root);
      assert.ok(files.some((f) => f.name.endsWith('-route-radio.md')));
      assert.ok(files.some((f) => f.name.endsWith('-route-helper.md')));
      firstNetworkChecked = true;
      return ok([]);
    },
  });
  root = s.root;
  for (const role of ['radio', 'helper']) await ledgerMain(['add', '--root', root, '--role', role, '--id', 'overdue', '--title', '검토', '--due', '2026-11-09T00:00:00Z', '--channel', 'studio', '--msg-id', 'source']);
  const result = await s.run();
  assert.ok(firstNetworkChecked);
  assert.deepEqual(result.errors, []);
  assert.equal(result.wakes.filter((w) => w.reason === '기한 넘음').length, 2);
});
