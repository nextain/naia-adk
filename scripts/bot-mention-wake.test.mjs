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
function setup(t) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'bot-wake-test-'));
  const sockets = [], timers = [], logs = [], fatals = [];
  const role = { id: 'assistant', botUserId: bot, token: 'test-credential-never-log', wakeDir: dir };
  const options = { tokens: [role.token, 'other-role-private-credential'], onFatal: () => fatals.push(true), log: value => logs.push(value), schedule: fn => { timers.push(fn); return fn; }, cancel: () => {}, gatewayOptions: { webSocketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket; }, setTimeoutImpl: () => 1, clearTimeoutImpl: () => {}, setIntervalImpl: () => 1, clearIntervalImpl: () => {} } };
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

test('MESSAGE_CREATE relay suppresses standby and collects own owner claim', async t => {
  const { createOwnerRouting } = await import('./bot-mention-wake.mjs');
  const f = setup(t);
  const roles = [f.role, { id: 'reviewer', botUserId: other, wakeDir: path.join(f.dir, 'reviewer') }];
  const timers = [];
  const routing = createOwnerRouting(roles, { stateFile: path.join(f.dir, 'owners.json'), now: () => 0, schedule: fn => { timers.push(fn); return fn; }, cancel: () => {} });
  // The old fixture worker is replaced with the real shared routing injected.
  await f.worker.stop();
  const routed = createRoleWake(f.role, { ...f.options, ownerRouting: routing });
  f.worker.stop = async () => { await routed.stop(); routing.stop(); };
  routed.start();
  const send = async data => { f.sockets.at(-1).receive({ op: 0, t: 'MESSAGE_CREATE', s: 1, d: data }); await routed.session.drain(); };
  await send(f.message('01', { author: { id: '500000000000000001' }, content: `<@${other}> <@${bot}> help`, mentions: [{ id: bot }, { id: other }] }));
  assert.equal(f.files().length, 0);
  await send(f.message('02', { author: { id: '500000000000000001' }, content: `<@${bot}> <@${other}> help`, mentions: [{ id: bot }, { id: other }] }));
  assert.equal(f.files().length, 1);
  await send(f.message('03', { author: { id: bot }, content: '맡음 12:30까지', message_reference: { message_id: f.message('02').id } }));
  const state = JSON.parse(fs.readFileSync(path.join(f.dir, 'owners.json')));
  assert.equal(state[f.message('02').id].claimed, true);
});
