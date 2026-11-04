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
  const ids = new Set(), bots = new Set(), dirs = new Set();
  return config.roles.map(role => {
    if (!/^[a-zA-Z0-9_-]+$/.test(role.id ?? '') || !snowflake(role.botUserId) || !role.wakeDir || Boolean(role.tokenFile) === Boolean(role.tokenEnv)) throw new Error('invalid role');
    const wakeDir = path.resolve(base, role.wakeDir);
    if (ids.has(role.id) || bots.has(role.botUserId) || dirs.has(wakeDir)) throw new Error('duplicate role');
    ids.add(role.id); bots.add(role.botUserId); dirs.add(wakeDir);
    const token = (role.tokenFile ? fs.readFileSync(path.resolve(base, role.tokenFile), 'utf8') : env[role.tokenEnv])?.trim();
    if (!token || token.length < 16) throw new Error('credential unavailable');
    return { id: role.id, botUserId: role.botUserId, wakeDir, token };
  });
}

export function createRoleWake(role, { gatewayOptions = {}, log = record => process.stderr.write(`${JSON.stringify(record)}\n`), reconnectMs = 1_000, schedule = setTimeout, cancel = clearTimeout, now = Date.now, tokens = [role.token], onFatal = () => {} } = {}) {
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
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('invalid state'); } catch (error) { if (error.code !== 'ENOENT') { fs.unlinkSync(lockFile); throw error; } state = { seen: {}, gateway: {}, guilds: {}, channels: {}, roles: {} }; }
  state.seen ??= {}; state.gateway ??= {}; state.guilds ??= {}; state.channels ??= {}; state.roles ??= {};
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
    if (type !== 'MESSAGE_CREATE' || (data?.guild_id != null && !snowflake(data.guild_id)) || !snowflake(data?.id) || !snowflake(data.channel_id) || data.author?.id === role.botUserId) return;
    const direct = !data.guild_id;
    const mentioned = data.mentions?.some(user => user.id === role.botUserId) || data.mention_roles?.some(id => state.roles[data.guild_id]?.includes(id));
    if ((!direct && !mentioned) || state.seen[data.id]) return;
    finishPending();
    const clean = value => safe(value).replace(/[\r\n]/g, ' ');
    const guild = data.guild_id ?? '@me';
    const body = `# Discord wake\n\nRole: ${role.id}\nGuild: ${clean(state.guilds[guild] ?? (direct ? 'DM' : guild))} (${guild})\nChannel: ${clean(state.channels[data.channel_id] ?? data.channel_id)} (${data.channel_id})\nAuthor: ${clean(data.author?.global_name ?? data.author?.username ?? 'unknown')} (${clean(data.author?.id)})\nMessage ID: ${data.id}\nURL: https://discord.com/channels/${guild}/${data.channel_id}/${data.id}\n\n${safe(data.content).slice(0, 1_000)}\n`;
    state.pending = { id: data.id, filename: `${now()}-${data.id}-gw.md`, body };
    persist(); finishPending();
  }
  let stopped = false, timer;
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
    try { session.connect(); } catch { log({ event: 'gateway_connect_failed', role: role.id }); timer = schedule(connect, reconnectMs); }
  }
  return { session, start: connect, stop: async () => { if (stopped) return; stopped = true; if (timer) cancel(timer); session.close(); try { await session.drain(); } finally { fs.unlinkSync(lockFile); } } };
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
