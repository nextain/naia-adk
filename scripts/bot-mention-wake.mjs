#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DiscordGatewaySession } from '../.agents/skills/manage-discord-sessions/helper/discord-gateway.mjs';

const snowflake = value => typeof value === 'string' && /^\d{17,20}$/.test(value);
function atomic(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temp, 'w', 0o600);
  try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  const dir = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
export function redact(value, token = '') {
  let text = String(value ?? '');
  if (token) text = text.split(token).join('[REDACTED]');
  return text.replace(/(?:mfa\.[\w-]{20,}|[\w-]{20,}\.[\w-]{6,}\.[\w-]{20,}|(?:sk-|ghp_|github_pat_)[\w-]{16,}|Bearer\s+[\w.\/-]{16,})/gi, '[REDACTED]');
}

export function loadConfig(file, env = process.env) {
  const base = path.dirname(path.resolve(file));
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(config.roles) || !config.roles.length) throw new Error('invalid roles');
  const dmCatchupMs = (config.dmCatchupSeconds ?? 300) * 1_000;
  if (!Number.isFinite(dmCatchupMs) || dmCatchupMs < 30_000) throw new Error('dmCatchupSeconds must be 30 or more');
  // Read receipt: a reaction on a person's post as soon as it is handed to the wake box. On unless `ack.enabled` is false.
  const ack = { enabled: config.ack?.enabled !== false, emoji: config.ack?.emoji ?? '👀', humanUserIds: config.ack?.humanUserIds ?? [] };
  if (typeof ack.emoji !== 'string' || !ack.emoji || ack.emoji.length > 64 || /[\s/?#%]/u.test(ack.emoji) || !Array.isArray(ack.humanUserIds) || !ack.humanUserIds.every(snowflake)) throw new Error('invalid ack');
  const ids = new Set(), bots = new Set(), dirs = new Set();
  return config.roles.map(role => {
    if (!/^[a-zA-Z0-9_-]+$/.test(role.id ?? '') || !snowflake(role.botUserId) || !role.wakeDir || Boolean(role.tokenFile) === Boolean(role.tokenEnv)) throw new Error('invalid role');
    const dmChannelIds = role.dmChannelIds ?? [];
    const dmUserIds = role.dmUserIds ?? [];
    if (!Array.isArray(dmChannelIds) || !dmChannelIds.every(snowflake) || !Array.isArray(dmUserIds) || !dmUserIds.every(snowflake)) throw new Error('invalid role');
    const wakeDir = path.resolve(base, role.wakeDir);
    if (ids.has(role.id) || bots.has(role.botUserId) || dirs.has(wakeDir)) throw new Error('duplicate role');
    ids.add(role.id); bots.add(role.botUserId); dirs.add(wakeDir);
    const token = (role.tokenFile ? fs.readFileSync(path.resolve(base, role.tokenFile), 'utf8') : env[role.tokenEnv])?.trim();
    if (!token || token.length < 16) throw new Error('credential unavailable');
    return { id: role.id, botUserId: role.botUserId, wakeDir, token, dmChannelIds, dmUserIds, dmCatchupMs, ack };
  });
}

export function createRoleWake(role, { gatewayOptions = {}, log = record => process.stderr.write(`${JSON.stringify(record)}\n`), reconnectMs = 1_000, schedule = setTimeout, cancel = clearTimeout, now = Date.now, tokens = [role.token], onFatal = () => {}, fetchImpl = globalThis.fetch, apiBase = 'https://discord.com/api/v10', catchupMs = role.dmCatchupMs ?? 300_000, every = setInterval, cancelEvery = clearInterval } = {}) {
  fs.mkdirSync(role.wakeDir, { recursive: true, mode: 0o700 });
  const stateFile = path.join(role.wakeDir, '.bot-mention-wake-state.json');
  const lockFile = path.join(role.wakeDir, '.bot-mention-wake.lock');
  // Every starter serializes both inspection and acquisition. A leftover guard
  // fails closed and requires operator recovery after verifying no owner runs.
  const guardFile = `${lockFile}.reclaim`;
  fs.writeFileSync(guardFile, String(process.pid), { flag: 'wx', mode: 0o600 });
  try {
    let prior = null;
    try { prior = Number(fs.readFileSync(lockFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (prior !== null) {
      if (!Number.isSafeInteger(prior) || prior < 1) throw new Error('invalid lock owner');
      try { process.kill(prior, 0); throw new Error('already running'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      fs.unlinkSync(lockFile);
    }
    fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx', mode: 0o600 });
  } finally { fs.unlinkSync(guardFile); }
  let state;
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('invalid state'); } catch (error) { if (error.code !== 'ENOENT') { fs.unlinkSync(lockFile); throw error; } state = { seen: {}, gateway: {}, guilds: {}, channels: {}, roles: {}, dm: {}, dmUsers: {} }; }
  state.seen ??= {}; state.gateway ??= {}; state.guilds ??= {}; state.channels ??= {}; state.roles ??= {}; state.dm ??= {}; state.dmUsers ??= {};
  // DM rooms to catch up over REST: the configured ones plus every room a DM arrives in.
  for (const channel of role.dmChannelIds ?? []) state.dm[channel] ??= {};
  const persist = () => atomic(stateFile, JSON.stringify(state));
  // Persist the pending handoff before publishing its file. Resume finishes an
  // interrupted publication using the same name. A consumer must durably claim
  // the message ID: a crash after publish and consumer deletion may republish.
  const finishPending = () => {
    if (!state.pending) return;
    const { id, filename, body } = state.pending;
    if (!fs.existsSync(path.join(role.wakeDir, filename))) atomic(path.join(role.wakeDir, filename), body);
    state.seen[id] = filename;
    delete state.pending;
    persist();
  };
  try { finishPending(); } catch (error) { fs.unlinkSync(lockFile); throw error; }
  const repository = {
    load: () => ({ ...state.gateway }),
    save: patch => { Object.assign(state.gateway, patch); persist(); },
    clearResume: () => { state.gateway = {}; persist(); },
  };
  const safe = value => tokens.reduce((text, token) => redact(text, token), String(value ?? ''));
  const cacheChannel = channel => { if (snowflake(channel?.id)) state.channels[channel.id] = safe(channel.name ?? 'DM'); };
  async function onDispatch(type, data) {
    if (type === 'GUILD_CREATE') {
      state.guilds[data.id] = safe(data.name ?? data.id);
      for (const channel of [...(data.channels ?? []), ...(data.threads ?? [])]) cacheChannel(channel);
      const member = data.members?.find(item => item.user?.id === role.botUserId);
      if (member) state.roles[data.id] = member.roles ?? [];
      persist();
    } else if (type === 'GUILD_MEMBER_UPDATE' && data.user?.id === role.botUserId) {
      state.roles[data.guild_id] = data.roles ?? []; persist();
    } else if (['CHANNEL_CREATE', 'CHANNEL_UPDATE', 'THREAD_CREATE', 'THREAD_UPDATE'].includes(type)) { cacheChannel(data); persist(); }
    else if (type === 'GUILD_UPDATE') { state.guilds[data.id] = safe(data.name ?? data.id); persist(); }
    if (type === 'READY' || type === 'RESUMED') void catchUp();
    if (type !== 'MESSAGE_CREATE') return;
    if (!data?.guild_id && snowflake(data?.channel_id) && !state.dm[data.channel_id]) { state.dm[data.channel_id] = {}; persist(); }
    publish(data);
  }
  function publish(data) {
    if ((data?.guild_id != null && !snowflake(data.guild_id)) || !snowflake(data?.id) || !snowflake(data.channel_id) || data.author?.id === role.botUserId) return;
    const direct = !data.guild_id;
    const mentioned = data.mentions?.some(user => user.id === role.botUserId) || data.mention_roles?.some(id => state.roles[data.guild_id]?.includes(id));
    if ((!direct && !mentioned) || state.seen[data.id]) return;
    finishPending();
    const clean = value => safe(value).replace(/[\r\n]/g, ' ');
    const guild = data.guild_id ?? '@me';
    const body = `# Discord wake\n\nRole: ${role.id}\nGuild: ${clean(state.guilds[guild] ?? (direct ? 'DM' : guild))} (${guild})\nChannel: ${clean(state.channels[data.channel_id] ?? data.channel_id)} (${data.channel_id})\nAuthor: ${clean(data.author?.global_name ?? data.author?.username ?? 'unknown')} (${clean(data.author?.id)})\nMessage ID: ${data.id}\nURL: https://discord.com/channels/${guild}/${data.channel_id}/${data.id}\n\n${safe(data.content).slice(0, 1_000)}\n`;
    state.pending = { id: data.id, filename: `${now()}-${data.id}-gw.md`, body };
    persist(); finishPending();
    void acknowledge(data);
  }
  // Read receipt for a person's post (not a bot, webhook or a configured-away author). It never blocks the wake:
  // a failure is logged with the status only and the post stays woken.
  async function acknowledge(data) {
    const ack = role.ack;
    if (!ack?.enabled || !data.author?.id || data.author.bot || data.webhook_id) return;
    if (ack.humanUserIds?.length && !ack.humanUserIds.includes(data.author.id)) return;
    try {
      const response = await fetchImpl(`${apiBase}/channels/${data.channel_id}/messages/${data.id}/reactions/${encodeURIComponent(ack.emoji)}/@me`, { method: 'PUT', headers: { Authorization: `Bot ${role.token}` }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) log({ event: 'ack_reaction_failed', role: role.id, status: response.status });
    } catch { log({ event: 'ack_reaction_failed', role: role.id, status: 'unreachable' }); }
  }
  // The gateway does not replay what it missed beyond its resume window. Each DM
  // room is therefore also read over REST with this role's own credential, from a
  // cursor only this reader moves; `seen` keeps the two paths from doubling. A room
  // looked at for the first time is recorded, not replayed. A room that fails
  // keeps its cursor and its last good time (`okAt`), which a monitor can check.
  async function catchUpRoom(channel) {
    const room = state.dm[channel];
    const get = async query => {
      const response = await fetchImpl(`${apiBase}/channels/${channel}/messages?${query}`, { headers: { Authorization: `Bot ${role.token}` }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw Object.assign(new Error('rest'), { status: response.status });
      const page = await response.json();
      if (!Array.isArray(page)) throw Object.assign(new Error('rest'), { status: 'invalid-body' });
      return page.filter(item => snowflake(item?.id)).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    };
    if (room.last === undefined) room.last = (await get('limit=1')).at(-1)?.id ?? '0';
    else for (let pages = 0; pages < 20 && !stopped; pages += 1) {
      const page = await get(`after=${room.last}&limit=100`);
      for (const item of page) { publish({ ...item, channel_id: channel, guild_id: undefined }); room.last = item.id; }
      if (page.length < 100) break;
    }
    room.okAt = new Date(now()).toISOString(); delete room.error;
    persist();
  }
  // A DM room configured by its other member (`dmUserIds`) is looked up once:
  // opening a DM returns the existing room and sends nothing.
  async function findRoom(user) {
    const response = await fetchImpl(`${apiBase}/users/@me/channels`, { method: 'POST', headers: { Authorization: `Bot ${role.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ recipient_id: user }), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw Object.assign(new Error('rest'), { status: response.status });
    const channel = (await response.json())?.id;
    if (!snowflake(channel)) throw Object.assign(new Error('rest'), { status: 'invalid-body' });
    state.dmUsers[user] = { channel }; state.dm[channel] ??= {};
    persist();
  }
  const failure = error => Number.isInteger(error?.status) || error?.status === 'invalid-body' ? error.status : 'unreachable';
  let stopped = false, timer, catchTimer, catching = null, again = false;
  async function catchUpRound() {
    for (const user of role.dmUserIds ?? []) {
      if (stopped) break;
      if (state.dmUsers[user]?.channel) continue;
      try { await findRoom(user); } catch (error) {
        const status = failure(error);
        state.dmUsers[user] = { error: { status, at: new Date(now()).toISOString() } };
        log({ event: 'dm_room_lookup_failed', role: role.id, user, status });
        try { persist(); } catch { /* the next round records it */ }
      }
    }
    for (const channel of Object.keys(state.dm)) {
      if (stopped) break;
      try { await catchUpRoom(channel); } catch (error) {
        const status = failure(error);
        state.dm[channel].error = { status, at: new Date(now()).toISOString() };
        log({ event: 'dm_catchup_failed', role: role.id, channel, status });
        try { persist(); } catch { /* the next round records it */ }
      }
    }
  }
  // A request that arrives while a round runs (a reconnect, most of all) gets a
  // full round of its own afterwards: the running one may already be past a room.
  function catchUp() {
    if (catching) { again = true; return catching; }
    catching = (async () => { do { again = false; await catchUpRound(); } while (again && !stopped); })().finally(() => { catching = null; });
    return catching;
  }
  const session = new DiscordGatewaySession({ ...gatewayOptions, token: role.token, expectedBotUserId: role.botUserId, stateRepository: repository, onDispatch,
    onDisconnect: ({ code, resumable }) => {
      log({ event: 'gateway_disconnect', role: role.id, code, resumable });
      if ([4007, 4009].includes(code)) {
        try { repository.clearResume(); } catch { onFatal(); return; }
      }
      if (!stopped && resumable) timer = schedule(connect, reconnectMs);
      else if (!stopped) onFatal();
    },
  });
  function connect() {
    if (stopped) return;
    if (!catchTimer) { catchTimer = every(() => void catchUp(), catchupMs); catchTimer?.unref?.(); }
    try { session.connect(); } catch { log({ event: 'gateway_connect_failed', role: role.id }); timer = schedule(connect, reconnectMs); }
  }
  return { session, start: connect, catchUp, stop: async () => { if (stopped) return; stopped = true; if (timer) cancel(timer); if (catchTimer) cancelEvery(catchTimer); session.close(); try { await session.drain(); await catching; } finally { fs.unlinkSync(lockFile); } } };
}

export async function main(args = process.argv.slice(2)) {
  let workers = [];
  try {
    if (args[0] === '--config') args = args.slice(1);
    if (args.length !== 1) throw new Error('config path required');
    const roles = loadConfig(args[0]);
    const onFatal = () => { process.exitCode = 1; for (const worker of workers) worker.stop().catch(() => {}); };
    for (const role of roles) workers.push(createRoleWake(role, { tokens: roles.map(item => item.token), onFatal }));
    for (const worker of workers) worker.start();
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await Promise.all(workers.map(worker => worker.stop())); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  } catch {
    await Promise.allSettled(workers.map(worker => worker.stop()));
    process.stderr.write(`${JSON.stringify({ event: 'bot_mention_wake_failed', reason: 'configuration_or_storage' })}\n`);
    process.exitCode = 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
