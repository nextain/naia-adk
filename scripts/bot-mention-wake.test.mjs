import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoleWake, loadConfig, redact } from './bot-mention-wake.mjs';
const bot = '100000000000000001', other = '100000000000000002', guild = '100000000000000003', channel = '100000000000000004', roleId = '100000000000000005';
class Socket {
  handlers = {}; sent = [];
  addEventListener(type, fn) { this.handlers[type] = fn; }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  receive(payload) { this.handlers.message({ data: JSON.stringify(payload) }); }
  close(code) { this.handlers.close({ code }); }
}
function setup(t, rolePatch = {}, optionPatch = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'bot-wake-test-'));
  const sockets = [], timers = [], logs = [], fatals = [];
  const role = { id: 'assistant', botUserId: bot, token: 'test-credential-never-log', wakeDir: dir, ...rolePatch };
  const options = { tokens: [role.token, 'other-role-private-credential'], onFatal: () => fatals.push(true), log: value => logs.push(value), schedule: fn => { timers.push(fn); return fn; }, cancel: () => {}, gatewayOptions: { webSocketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket; }, setTimeoutImpl: () => 1, clearTimeoutImpl: () => {}, setIntervalImpl: () => 1, clearIntervalImpl: () => {} }, ...optionPatch };
  const worker = createRoleWake(role, options); worker.start();
  t.after(async () => { await worker.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  let seq = 0;
  const dispatch = async (type, data) => { sockets.at(-1).receive({ op: 0, t: type, s: ++seq, d: data }); await worker.session.drain(); };
  const message = (id, patch = {}) => ({ id: `2000000000000000${id}`, guild_id: guild, channel_id: channel, author: { id: other, username: 'human' }, mentions: [{ id: bot }], content: 'hello', ...patch });
  const files = () => fs.readdirSync(dir).filter(name => name.endsWith('-gw.md'));
  return { dir, role, options, worker, sockets, timers, logs, fatals, dispatch, message, files };
}
test('bot mention publishes a redacted excerpt and source metadata', async t => {
  const f = setup(t);
  await f.dispatch('GUILD_CREATE', { id: guild, name: 'Workspace', channels: [{ id: channel, name: 'portal' }] });
  await f.dispatch('MESSAGE_CREATE', f.message('01', { content: `hello ${f.role.token} other-role-private-credential ${'A'.repeat(24)}.${'B'.repeat(6)}.${'C'.repeat(30)} ${'x'.repeat(2000)}` }));
  assert.equal(f.files().length, 1);
  const text = fs.readFileSync(path.join(f.dir, f.files()[0]), 'utf8');
  assert.match(f.files()[0], /^\d+-\d+-gw\.md$/);
  assert.match(text, /Workspace/); assert.match(text, /portal/); assert.match(text, /discord.com\/channels\//); assert.match(text, /\[REDACTED\]/);
  assert.ok(!text.includes(f.role.token)); assert.ok(!text.includes('other-role-private-credential')); assert.ok(!text.includes('C'.repeat(30))); assert.ok(text.length < 1600); assert.deepEqual(f.logs, []);
});
test('DM wakes; another bot mention and own messages do not', async t => {
  const f = setup(t);
  await f.dispatch('MESSAGE_CREATE', f.message('01', { mentions: [{ id: other }] }));
  await f.dispatch('MESSAGE_CREATE', f.message('02', { author: { id: bot } }));
  assert.equal(f.files().length, 0);
  await f.dispatch('MESSAGE_CREATE', f.message('03', { guild_id: undefined, mentions: [] }));
  assert.equal(f.files().length, 1); assert.match(fs.readFileSync(path.join(f.dir, f.files()[0]), 'utf8'), /Guild: DM \(@me\)/);
});
test('owned role mentions wake, membership changes refresh ownership', async t => {
  const f = setup(t);
  await f.dispatch('GUILD_CREATE', { id: guild, members: [{ user: { id: bot }, roles: [roleId] }] });
  await f.dispatch('MESSAGE_CREATE', f.message('01', { mentions: [], mention_roles: [roleId], content: '' }));
  assert.equal(f.files().length, 1);
  await f.dispatch('GUILD_MEMBER_UPDATE', { guild_id: guild, user: { id: bot }, roles: [] });
  await f.dispatch('MESSAGE_CREATE', f.message('02', { mentions: [], mention_roles: [roleId] }));
  assert.equal(f.files().length, 1);
});
test('duplicates stay suppressed after reconnect and consumed file removal', async t => {
  const f = setup(t);
  await f.dispatch('READY', { user: { id: bot }, session_id: 'session', resume_gateway_url: 'wss://gateway.discord.gg' });
  await f.dispatch('MESSAGE_CREATE', f.message('01'));
  await f.dispatch('MESSAGE_CREATE', f.message('01'));
  assert.equal(f.files().length, 1);
  fs.unlinkSync(path.join(f.dir, f.files()[0]));
  f.sockets.at(-1).close(1006); assert.equal(f.timers.length, 1); f.timers.shift()();
  f.sockets.at(-1).receive({ op: 10, d: { heartbeat_interval: 45000 } }); await f.worker.session.drain();
  assert.equal(f.sockets.at(-1).sent[0].op, 6);
  assert.equal(f.sockets.at(-1).sent[0].d.session_id, 'session');
  await f.dispatch('MESSAGE_CREATE', f.message('01')); assert.equal(f.files().length, 0);
  assert.deepEqual(f.logs, [{ event: 'gateway_disconnect', role: 'assistant', code: 1006, resumable: true }]);
});
test('state survives process-style restart and rejects a concurrent owner', async t => {
  const f = setup(t);
  assert.throws(() => createRoleWake(f.role, f.options), /already running/);
  await f.dispatch('MESSAGE_CREATE', f.message('01'));
  await f.worker.stop();
  // Replace the original stop for the registered cleanup.
  f.worker.stop = async () => {};
  const replacement = createRoleWake(f.role, f.options); replacement.start();
  const originalCleanupStop = f.worker.stop;
  f.worker.stop = async () => { await replacement.stop(); await originalCleanupStop(); };
  f.sockets.at(-1).receive({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: f.message('01') }); await replacement.session.drain();
  assert.equal(f.files().length, 1);
});
test('config resolves credentials privately and enforces unique roles', t => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'bot-wake-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  const role = { id: 'assistant', botUserId: bot, tokenEnv: 'TEST_TOKEN', wakeDir: 'wake' };
  fs.writeFileSync(file, JSON.stringify({ roles: [role] }));
  assert.equal(loadConfig(file, { TEST_TOKEN: 'credential-long-enough' })[0].wakeDir, path.join(dir, 'wake'));
  assert.throws(() => loadConfig(file, {}));
  fs.writeFileSync(path.join(dir, 'token'), 'file-private-credential\n');
  fs.writeFileSync(file, JSON.stringify({ roles: [{ ...role, tokenEnv: undefined, tokenFile: 'token' }] }));
  assert.equal(loadConfig(file)[0].token, 'file-private-credential');
  fs.writeFileSync(file, JSON.stringify({ roles: [role, role] })); assert.throws(() => loadConfig(file, { TEST_TOKEN: 'credential-long-enough' }));
  assert.equal(redact('Bearer abcdefghijklmnopqrstuvwxyz'), '[REDACTED]');
});
test('identify omits privileged content intent and fatal disconnect invokes supervisor', async t => {
  const f = setup(t);
  f.sockets[0].receive({ op: 10, d: { heartbeat_interval: 45000 } }); await f.worker.session.drain();
  assert.equal(f.sockets[0].sent[0].op, 2);
  assert.equal(f.sockets[0].sent[0].d.intents & 32768, 0);
  f.sockets[0].close(4014); assert.equal(f.timers.length, 0); assert.equal(f.fatals.length, 1);
});
test('restart finishes a pending durable handoff once', async t => {
  const f = setup(t);
  await f.worker.stop();
  const stateFile = path.join(f.dir, '.bot-mention-wake-state.json');
  const id = f.message('01').id, filename = `123-${id}-gw.md`;
  fs.writeFileSync(stateFile, JSON.stringify({ pending: { id, filename, body: 'durable excerpt' } }));
  const replacement = createRoleWake(f.role, f.options); replacement.start();
  f.worker.stop = () => replacement.stop();
  assert.equal(fs.readFileSync(path.join(f.dir, filename), 'utf8'), 'durable excerpt');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.seen[id], filename); assert.equal(state.pending, undefined);
  f.sockets.at(-1).receive({ op: 0, t: 'MESSAGE_CREATE', s: 1, d: f.message('01') }); await replacement.session.drain();
  assert.equal(f.files().length, 1);
});
test('stale lifetime lock recovery is serialized and leftover guard fails closed', async t => {
  const f = setup(t);
  await f.worker.stop();
  const lock = path.join(f.dir, '.bot-mention-wake.lock');
  fs.writeFileSync(lock, '2147483647');
  fs.writeFileSync(`${lock}.reclaim`, '2147483647');
  assert.throws(() => createRoleWake(f.role, f.options), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(lock, 'utf8'), '2147483647');
  fs.unlinkSync(`${lock}.reclaim`);
  const replacement = createRoleWake(f.role, f.options);
  f.worker.stop = () => replacement.stop();
  assert.equal(fs.readFileSync(lock, 'utf8'), String(process.pid));
  assert.equal(fs.existsSync(`${lock}.reclaim`), false);
});
for (const code of [4007, 4009]) test(`close ${code} clears invalid resume before reconnect`, async t => {
  const f = setup(t);
  await f.dispatch('READY', { user: { id: bot }, session_id: 'expired', resume_gateway_url: 'wss://gateway.discord.gg' });
  f.sockets[0].close(code); f.timers.shift()();
  f.sockets.at(-1).receive({ op: 10, d: { heartbeat_interval: 45000 } }); await f.worker.session.drain();
  assert.equal(f.sockets.at(-1).sent[0].op, 2);
  assert.equal(f.sockets.at(-1).sent[0].d.session_id, undefined);
});

const dmA = '300000000000000001', dmB = '300000000000000002';
// A fake REST endpoint: `rooms[channel]` is the room's messages oldest first, or a status number or Error to fail with.
function rest(rooms) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    const channel = pathname.split('/').at(-2), room = rooms[channel];
    calls.push({ channel, query: searchParams.toString(), authorization: init.headers.Authorization });
    if (room instanceof Error) throw room;
    if (typeof room === 'number') return { ok: false, status: room, json: async () => ({ message: 'no' }) };
    const after = searchParams.get('after'), limit = Number(searchParams.get('limit'));
    const page = after === null ? room.slice(-limit) : room.filter(item => BigInt(item.id) > BigInt(after)).slice(0, limit);
    return { ok: true, status: 200, json: async () => page.toReversed() };
  };
  return { calls, fetchImpl };
}
const dm = (id, patch = {}) => ({ id: `2000000000000000${id}`, channel_id: dmA, author: { id: other, username: 'human' }, content: `dm ${id}`, ...patch });
const readState = dir => JSON.parse(fs.readFileSync(path.join(dir, '.bot-mention-wake-state.json'), 'utf8'));
test('configured DM rooms are caught up over REST with the role credential; the first look replays nothing', async t => {
  const rooms = { [dmA]: [dm('01')] };
  const api = rest(rooms);
  const f = setup(t, { dmChannelIds: [dmA] }, { fetchImpl: api.fetchImpl, now: () => 1_700_000_000_000 });
  await f.worker.catchUp();
  assert.equal(f.files().length, 0);
  assert.deepEqual(api.calls, [{ channel: dmA, query: 'limit=1', authorization: `Bot ${f.role.token}` }]);
  assert.equal(readState(f.dir).dm[dmA].last, dm('01').id);
  // Messages that arrived while the gateway was away, the bot's own reply among them.
  rooms[dmA].push(dm('02'), dm('03', { author: { id: bot } }), dm('04', { content: `late ${f.role.token}` }));
  await f.worker.catchUp();
  assert.equal(api.calls.at(-1).query, `after=${dm('01').id}&limit=100`);
  assert.deepEqual(f.files().map(name => name.split('-')[1]).sort(), [dm('02').id, dm('04').id]);
  const text = fs.readFileSync(path.join(f.dir, f.files().find(name => name.includes(dm('04').id))), 'utf8');
  assert.match(text, /Guild: DM \(@me\)/); assert.match(text, new RegExp(`channels/@me/${dmA}/${dm('04').id}`)); assert.ok(!text.includes(f.role.token));
  const state = readState(f.dir).dm[dmA];
  assert.equal(state.last, dm('04').id); assert.equal(state.okAt, new Date(1_700_000_000_000).toISOString()); assert.equal(state.error, undefined);
  // The gateway replaying the same message, or a second catch-up, adds nothing.
  await f.dispatch('MESSAGE_CREATE', dm('02'));
  await f.worker.catchUp();
  assert.equal(f.files().length, 2); assert.deepEqual(f.logs, []);
});
test('a gateway message does not move the catch-up cursor past a message the gateway missed', async t => {
  const rooms = { [dmA]: [dm('01')] };
  const api = rest(rooms);
  const f = setup(t, { dmChannelIds: [dmA] }, { fetchImpl: api.fetchImpl });
  await f.worker.catchUp();
  rooms[dmA].push(dm('02'), dm('03'));
  await f.dispatch('MESSAGE_CREATE', dm('03'));
  assert.equal(f.files().length, 1);
  await f.worker.catchUp();
  assert.deepEqual(f.files().map(name => name.split('-')[1]).sort(), [dm('02').id, dm('03').id]);
});
test('a DM room first seen on the gateway joins the catch-up, and READY starts one', async t => {
  const rooms = { [dmB]: [dm('01', { channel_id: dmB })] };
  const api = rest(rooms);
  const f = setup(t, {}, { fetchImpl: api.fetchImpl });
  await f.dispatch('READY', { user: { id: bot }, session_id: 'session', resume_gateway_url: 'wss://gateway.discord.gg' });
  await f.worker.catchUp();
  assert.equal(api.calls.length, 0);
  await f.dispatch('MESSAGE_CREATE', dm('01', { channel_id: dmB }));
  rooms[dmB].push(dm('02', { channel_id: dmB }));
  await f.dispatch('RESUMED', {});
  await f.worker.catchUp();
  assert.equal(api.calls[0].query, 'limit=1');
  rooms[dmB].push(dm('05', { channel_id: dmB }));
  await f.dispatch('RESUMED', {});
  await f.worker.catchUp();
  assert.ok(f.files().some(name => name.includes(dm('05').id)));
});
test('a room that cannot be read keeps its cursor, records why, and does not stop the other rooms', async t => {
  const rooms = { [dmA]: [dm('01')], [dmB]: [dm('01', { channel_id: dmB })] };
  const api = rest(rooms);
  let clock = 1_700_000_000_000;
  const f = setup(t, { dmChannelIds: [dmA, dmB] }, { fetchImpl: api.fetchImpl, now: () => clock });
  await f.worker.catchUp();
  const saved = rooms[dmA];
  rooms[dmA] = 403; rooms[dmB].push(dm('02', { channel_id: dmB }));
  clock += 600_000;
  await f.worker.catchUp();
  assert.equal(f.files().length, 1);
  let state = readState(f.dir).dm;
  assert.deepEqual([state[dmA].last, state[dmA].okAt, state[dmA].error.status], [dm('01').id, new Date(1_700_000_000_000).toISOString(), 403]);
  assert.equal(state[dmB].okAt, new Date(clock).toISOString());
  assert.deepEqual(f.logs, [{ event: 'dm_catchup_failed', role: 'assistant', channel: dmA, status: 403 }]);
  rooms[dmA] = new Error(`socket hang up ${f.role.token}`);
  await f.worker.catchUp();
  assert.equal(readState(f.dir).dm[dmA].error.status, 'unreachable');
  assert.ok(!JSON.stringify(f.logs).includes(f.role.token)); assert.ok(!JSON.stringify(readState(f.dir)).includes(f.role.token));
  // Once it reads again, what arrived meanwhile is delivered and the error clears.
  saved.push(dm('03'));
  rooms[dmA] = saved;
  await f.worker.catchUp();
  state = readState(f.dir).dm;
  assert.equal(state[dmA].error, undefined); assert.equal(state[dmA].last, dm('03').id);
  assert.equal(f.files().length, 2);
});
test('a DM room named by its other member is found over REST and caught up like a configured one', async t => {
  const human = '400000000000000001';
  const rooms = { [dmB]: [dm('01', { channel_id: dmB })] };
  const api = rest(rooms);
  const opened = [];
  let openStatus = 403;
  const fetchImpl = async (url, init) => {
    if (!url.endsWith('/users/@me/channels')) return api.fetchImpl(url, init);
    opened.push([init.method, init.headers.Authorization, JSON.parse(init.body)]);
    return openStatus === 200 ? { ok: true, status: 200, json: async () => ({ id: dmB, type: 1 }) } : { ok: false, status: openStatus, json: async () => ({}) };
  };
  const f = setup(t, { dmUserIds: [human] }, { fetchImpl });
  await f.worker.catchUp();
  assert.deepEqual(opened, [['POST', `Bot ${f.role.token}`, { recipient_id: human }]]);
  assert.equal(readState(f.dir).dmUsers[human].error.status, 403);
  assert.deepEqual(f.logs, [{ event: 'dm_room_lookup_failed', role: 'assistant', user: human, status: 403 }]);
  openStatus = 200;
  await f.worker.catchUp();
  assert.deepEqual(readState(f.dir).dmUsers[human], { channel: dmB });
  assert.equal(readState(f.dir).dm[dmB].last, dm('01').id);
  rooms[dmB].push(dm('02', { channel_id: dmB }));
  await f.worker.catchUp();
  assert.equal(opened.length, 2);
  assert.deepEqual(f.files().map(name => name.split('-')[1]), [dm('02').id]);
});
test('a reconnect during a catch-up round gets a full round of its own', async t => {
  const rooms = { [dmA]: [dm('01')], [dmB]: [dm('01', { channel_id: dmB })] };
  const api = rest(rooms);
  let onSecondRoom = () => {};
  const fetchImpl = async (url, init) => { if (url.includes(`/channels/${dmB}/`)) await onSecondRoom(); return api.fetchImpl(url, init); };
  const f = setup(t, { dmChannelIds: [dmA, dmB] }, { fetchImpl });
  await f.worker.catchUp();
  // The round has read the first room; then a message lands there and the gateway resumes.
  onSecondRoom = async () => { onSecondRoom = () => {}; rooms[dmA].push(dm('02')); await f.dispatch('RESUMED', {}); };
  await f.worker.catchUp();
  assert.deepEqual(f.files().map(name => name.split('-')[1]), [dm('02').id]);
});
test('a long gap is read page by page in order', async t => {
  const rooms = { [dmA]: [dm('0001')] };
  const api = rest(rooms);
  const f = setup(t, { dmChannelIds: [dmA] }, { fetchImpl: api.fetchImpl });
  await f.worker.catchUp();
  for (let index = 2; index <= 151; index += 1) rooms[dmA].push(dm(String(index).padStart(4, '0')));
  await f.worker.catchUp();
  assert.equal(f.files().length, 150);
  assert.deepEqual(api.calls.slice(1).map(call => call.query), [`after=${dm('0001').id}&limit=100`, `after=${dm('0101').id}&limit=100`]);
});
test('config accepts DM rooms and a catch-up period and rejects malformed ones', t => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'bot-wake-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  const role = { id: 'assistant', botUserId: bot, tokenEnv: 'TEST_TOKEN', wakeDir: 'wake' };
  const load = doc => { fs.writeFileSync(file, JSON.stringify(doc)); return loadConfig(file, { TEST_TOKEN: 'credential-long-enough' }); };
  assert.deepEqual([load({ roles: [role] })[0].dmChannelIds, load({ roles: [role] })[0].dmCatchupMs], [[], 300_000]);
  assert.deepEqual([load({ dmCatchupSeconds: 120, roles: [{ ...role, dmChannelIds: [dmA] }] })[0].dmChannelIds, load({ dmCatchupSeconds: 120, roles: [role] })[0].dmCatchupMs], [[dmA], 120_000]);
  assert.throws(() => load({ roles: [{ ...role, dmChannelIds: ['12'] }] }), /invalid role/);
  assert.deepEqual(load({ roles: [{ ...role, dmUserIds: ['400000000000000001'] }] })[0].dmUserIds, ['400000000000000001']);
  assert.throws(() => load({ roles: [{ ...role, dmUserIds: ['someone'] }] }), /invalid role/);
  assert.throws(() => load({ dmCatchupSeconds: 0, roles: [role] }), /dmCatchupSeconds/);
});

// Read receipt: a reaction on a person's post once it is in the wake box.
const reactionCalls = () => { const calls = []; return { calls, fetchImpl: async (url, init) => { calls.push({ url, method: init.method, authorization: init.headers.Authorization }); return { ok: true, status: 204 }; } }; };
test('a person\'s mention gets a read reaction once; the wake is not blocked by a failing reaction', async t => {
  const api = reactionCalls();
  const f = setup(t, { ack: { enabled: true, emoji: '👀' } }, { fetchImpl: api.fetchImpl });
  await f.dispatch('MESSAGE_CREATE', f.message('01'));
  await f.dispatch('MESSAGE_CREATE', f.message('01'));
  assert.equal(api.calls.length, 1); assert.equal(api.calls[0].method, 'PUT');
  assert.ok(api.calls[0].url.endsWith(`/channels/${channel}/messages/200000000000000001/reactions/${encodeURIComponent('👀')}/@me`));
  assert.equal(api.calls[0].authorization, `Bot ${f.role.token}`);
  const failing = setup(t, { ack: { enabled: true, emoji: '👀' } }, { fetchImpl: async () => ({ ok: false, status: 403 }) });
  await failing.dispatch('MESSAGE_CREATE', failing.message('02'));
  assert.equal(failing.files().length, 1); assert.deepEqual(failing.logs, [{ event: 'ack_reaction_failed', role: 'assistant', status: 403 }]);
  const broken = setup(t, { ack: { enabled: true, emoji: '👀' } }, { fetchImpl: async () => { throw new Error('private'); } });
  await broken.dispatch('MESSAGE_CREATE', broken.message('03'));
  assert.equal(broken.files().length, 1); assert.equal(broken.logs[0].status, 'unreachable');
});
test('ack off, bot authors and non-listed people get no reaction', async t => {
  const off = reactionCalls();
  const a = setup(t, { ack: { enabled: false, emoji: '👀' } }, { fetchImpl: off.fetchImpl });
  await a.dispatch('MESSAGE_CREATE', a.message('01')); assert.equal(a.files().length, 1); assert.equal(off.calls.length, 0);
  const on = reactionCalls();
  const b = setup(t, { ack: { enabled: true, emoji: '✅', humanUserIds: [bot] } }, { fetchImpl: on.fetchImpl });
  await b.dispatch('MESSAGE_CREATE', b.message('01')); assert.equal(on.calls.length, 0);
  const c = setup(t, { ack: { enabled: true, emoji: '✅' } }, { fetchImpl: on.fetchImpl });
  await c.dispatch('MESSAGE_CREATE', c.message('02', { author: { id: other, bot: true } }));
  await c.dispatch('MESSAGE_CREATE', c.message('03', { webhook_id: '100000000000000009' }));
  assert.equal(on.calls.length, 0);
  await c.dispatch('MESSAGE_CREATE', c.message('04')); assert.equal(on.calls.length, 1); assert.ok(on.calls[0].url.includes(encodeURIComponent('✅')));
});
test('ack config defaults on with the eyes emoji and rejects a malformed one', t => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'bot-wake-ack-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json'), role = { id: 'assistant', botUserId: bot, tokenEnv: 'TEST_TOKEN', wakeDir: 'wake' }, env = { TEST_TOKEN: 'credential-long-enough' };
  fs.writeFileSync(file, JSON.stringify({ roles: [role] })); assert.deepEqual(loadConfig(file, env)[0].ack, { enabled: true, emoji: '👀', humanUserIds: [] });
  fs.writeFileSync(file, JSON.stringify({ ack: { enabled: false, emoji: '✅' }, roles: [role] })); assert.equal(loadConfig(file, env)[0].ack.enabled, false);
  fs.writeFileSync(file, JSON.stringify({ ack: { emoji: 'a/b' }, roles: [role] })); assert.throws(() => loadConfig(file, env));
});

test('Gateway records an explicit human guild mention independently of the wake box', async t => {
  const origins = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-origin-'));
  t.after(() => fs.rmSync(origins, { recursive: true, force: true }));
  const f = setup(t, { activeMentionOriginDir: origins });
  const incoming = f.message('25', { content: `Please review this <@${bot}>` });
  await f.dispatch('MESSAGE_CREATE', incoming);
  const record = JSON.parse(fs.readFileSync(path.join(origins, 'assistant', incoming.id + '.json')));
  const wake = fs.readFileSync(path.join(f.dir, f.files()[0]));
  const { createHash } = await import('node:crypto');
  assert.equal(record.wake_sha256, createHash('sha256').update(wake).digest('hex'));
  assert.deepEqual([record.role, record.bot, record.author, record.channel, record.guild], ['assistant', bot, other, channel, guild]);
  for (const [suffix, patch] of [['26', { author: { id: other, bot: true } }], ['27', { webhook_id: other }],
    ['28', { guild_id: undefined }], ['29', { mentions: [] }], ['30', { content: 'implicit reply only' }]]) {
    await f.dispatch('MESSAGE_CREATE', { ...incoming, ...patch, id: f.message(suffix).id });
  }
  assert.deepEqual(fs.readdirSync(path.join(origins, 'assistant')), [incoming.id + '.json']);
});
