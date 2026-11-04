#!/usr/bin/env node
import { readFile, writeFile, mkdir, rename, open, unlink } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { runHealth } from './session-health.mjs';
import { fill } from './response-watch.mjs';

const id = value => typeof value === 'string' && /^\d+$/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
const compare = (a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const names = role => [role.id, ...(role.aliases ?? [])];
export function validateConfig(c) {
  if (!object(c) || typeof c.stateFile !== 'string' || !c.stateFile || !Array.isArray(c.roles) || c.roles.length < 2 || !Array.isArray(c.guilds) || !c.guilds.length) throw Error('stateFile, roles and guilds required');
  const ids = new Set(), bots = new Set(), aliases = new Set(), channels = new Set(), dirs = new Set();
  for (const r of c.roles) {
    if (!/^[\w-]+$/.test(r.id ?? '') || !id(r.botId) || (r.wakeDir !== undefined && (typeof r.wakeDir !== 'string' || !r.wakeDir)) || !Array.isArray(r.aliases ?? [])) throw Error('invalid role');
    if (ids.has(r.id) || bots.has(r.botId) || (r.wakeDir && dirs.has(resolve(r.wakeDir)))) throw Error('duplicate role');
    ids.add(r.id); bots.add(r.botId); if (r.wakeDir) dirs.add(resolve(r.wakeDir));
    for (const name of names(r)) { if (typeof name !== 'string' || !name.trim() || /[\r\n\[\]→:]/u.test(name) || aliases.has(name)) throw Error('invalid or duplicate alias'); aliases.add(name); }
  }
  for (const g of c.guilds) {
    if (!id(g.id) || !Array.isArray(g.channels) || !g.channels.length) throw Error('invalid guild');
    for (const ch of g.channels) { if (!id(ch.id) || channels.has(ch.id)) throw Error('invalid or duplicate channel'); channels.add(ch.id); }
  }
  if (!ids.has(c.recovery?.roleId) || typeof c.sessionHealthConfig !== 'string' || !c.sessionHealthConfig) throw Error('sessionHealthConfig and recovery role required');
  const n = c.thresholds?.nudgeMinutes ?? 10, e = c.thresholds?.escalateMinutes ?? 30;
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(e) || e <= n) throw Error('invalid thresholds');
  if (!Number.isInteger(c.maxPages ?? 100) || (c.maxPages ?? 100) < 1) throw Error('invalid limits');
  if (!Number.isInteger(c.timezoneOffsetMinutes ?? 0) || Math.abs(c.timezoneOffsetMinutes ?? 0) > 840) throw Error('invalid timezone offset');
  if (c.messages && (!object(c.messages) || Object.entries(c.messages).some(([key, value]) => !['nudge', 'overdue', 'escalate', 'recovery'].includes(key) || typeof value !== 'string' || !value.trim() || [...value.matchAll(/\{([^}]+)\}/g)].some(m => !['bot', 'role', 'health', 'link'].includes(m[1]))))) throw Error('invalid messages');
  return c;
}

// These are addressing forms, not a semantic classification of the prose.
export function detectRequests(message, roles) {
  if (!message.author?.bot || message.webhook_id || ![0, 19].includes(message.type ?? 0)) return [];
  const author = roles.find(r => r.botId === message.author.id);
  if (!author) return [];
  const text = message.content ?? '';
  return roles.filter(r => r !== author && (
    (message.mentions ?? []).some(m => m.id === r.botId) || new RegExp(`<@!?${r.botId}>`).test(text) ||
    names(r).some(name => new RegExp(`^\\s*\\[(?:${names(author).map(escape).join('|')})\\s*→\\s*${escape(name)}\\]`, 'u').test(text) ||
      new RegExp(`(?:^|\\s)${escape(name)}(?:에게|께)(?=\\s|[,:.!?]|$)|(?:^|\\n)\\s*-\\s*${escape(name)}\\s*:`, 'u').test(text))
  ));
}
export function isReceipt(message, request) {
  if (message.author?.bot !== true || message.webhook_id || ![0, 19].includes(message.type ?? 0) || message.author.id !== request.to) return false;
  const reference = message.message_reference?.message_id;
  if (reference) return reference === request.messageId || Boolean(request.receiptId && reference === request.receiptId);
  return (message.mentions ?? []).some(m => m.id === request.from) || new RegExp(`<@!?${request.from}>`).test(message.content ?? '');
}
export function parseDeadline(text, at, offsetMinutes = 0) {
  const matches = [...String(text).matchAll(/(?<![\d:])(?:(내일)\s+)?(\d{2}):(\d{2})(까지)?(?![\d:])/gu)].filter(m => m[1] || m[4]);
  if (matches.length !== 1) return null;
  const [, tomorrow, hh, mm] = matches[0];
  if (+hh > 23 || +mm > 59) return null;
  const local = new Date(at + offsetMinutes * 60000);
  const deadline = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + (tomorrow ? 1 : 0), +hh, +mm) - offsetMinutes * 60000;
  return deadline;
}
const defaults = {
  nudge: '<@{bot}> 부탁의 받음 답을 확인해 주세요: {link}',
  overdue: '<@{bot}> 약속한 끝 시각이 지났습니다. 결과를 확인해 주세요: {link}',
  escalate: '<@{bot}> 아직 답 없음 — 다시 부를지·다른 역할인지 확인해 주세요: {link}',
  recovery: '<@{bot}> {role} 세션이 {health} 상태입니다. 복구를 확인해 주세요: {link}',
};

export async function runWatch(config, { token, fetchImpl = fetch, dry = false, now = Date.now(), healthProbe, log = e => console.log(JSON.stringify(e)) } = {}) {
  validateConfig(config);
  if (!token) throw Error('configured token unavailable');
  const trace = randomUUID(), started = Date.now();
  const emit = (stage, result, extra = {}) => log({ trace, stage, result, ...extra });
  emit('start', dry ? 'dry' : 'running');
  const stateFile = resolve(config.stateFile);
  let lock, degraded = false;
  const atomic = async (file, text) => { await mkdir(dirname(file), { recursive: true, mode: 0o700 }); const tmp = `${file}.${process.pid}.tmp`; await writeFile(tmp, text, { mode: 0o600 }); await rename(tmp, file); };
  try {
    if (!dry) { await mkdir(dirname(stateFile), { recursive: true }); lock = await open(`${stateFile}.lock`, 'wx', 0o600); }
    let state;
    try { state = JSON.parse(await readFile(stateFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw Error('state unreadable; refusing reset'); state = { version: 1, channels: {}, errors: {} }; }
    if (state.version !== 1 || !object(state.channels) || !object(state.errors)) throw Error('invalid state');
    for (const ch of Object.values(state.channels)) {
      if (!object(ch) || !id(ch.cursor) || !object(ch.pending)) throw Error('invalid channel state');
      for (const r of Object.values(ch.pending)) {
        if (!object(r) || ![r.messageId, r.from, r.to].every(id) || !Number.isFinite(r.at) || r.at < 0 || !object(r.stages) || !config.roles.some(role => role.id === r.roleId && role.botId === r.to) || !config.roles.some(role => role.botId === r.from) ||
          (r.receiptId !== undefined && (!id(r.receiptId) || !(r.deadline === null || Number.isFinite(r.deadline)))) || (r.closedAt !== undefined && !Number.isFinite(r.closedAt)) ||
          Object.values(r.stages).some(stage => !object(stage) || !['confirmed', 'intent', 'uncertain'].includes(stage.status))) throw Error('invalid pending state');
      }
    }
    const save = () => dry ? Promise.resolve() : atomic(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    const api = async (path, body) => {
      const r = await fetchImpl(`https://discord.com/api/v10${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw Error(`Discord HTTP ${r.status}`);
      return r.json();
    };
    const notify = async (request, stage, role, guild, channel, health = '') => {
      const stageKey = request.receiptId ? `deadline-${stage}` : stage;
      if (request.stages[stageKey]) { if (request.stages[stageKey].status !== 'confirmed') degraded = true; return; }
      const key = hash(`${guild.id}/${channel.id}/${request.messageId}/${request.to}/${stageKey}`);
      const values = { bot: role.botId, role: request.roleId, health, link: `https://discord.com/channels/${guild.id}/${channel.id}/${request.messageId}` };
      const content = fill(config.messages?.[stage] ?? defaults[stage], values);
      if (dry) { emit(stage, 'would_send', { key }); return; }
      request.stages[stageKey] = { status: 'intent', at: now }; await save();
      try {
        if (role.wakeDir) {
          const filename = join(resolve(role.wakeDir), `${key}-agent-request.md`);
          // Deterministic filenames and persisted intent prevent duplicate publication.
          await atomic(filename, `# Discord wake\n\nRole: ${role.id}\nGuild: ${guild.id} (${guild.id})\nChannel: ${channel.id} (${channel.id})\nAuthor: agent-request-watch\nMessage ID: ${(1000000000000000000n + BigInt(`0x${key}`) % 9000000000000000000n).toString()}\nOriginal Message ID: ${request.messageId}\nRequest stage ID: ${key}\nURL: ${values.link}\n\n${content}\n`);
          request.stages[stageKey] = { status: 'confirmed', at: now, filename };
        } else {
          const sent = await api(`/channels/${channel.id}/messages`, { content, allowed_mentions: { parse: [], users: [role.botId] }, nonce: key, enforce_nonce: true });
          if (!id(sent.id)) throw Error('missing send receipt');
          request.stages[stageKey] = { status: 'confirmed', at: now, messageId: sent.id };
        }
        emit(stage, 'confirmed', { key });
      } catch (e) { request.stages[stageKey] = { status: 'uncertain', at: now }; degraded = true; emit(stage, 'reconciliation_required', { key, reason: e.message }); }
      await save();
    };
    let healthRows;
    const health = async role => {
      if (!healthRows) {
        if (healthProbe) healthRows = await healthProbe();
        else {
          const c = JSON.parse(await readFile(config.sessionHealthConfig, 'utf8'));
          healthRows = (await runHealth(c, { now, dry: true, log: e => emit('session-health', e.result ?? e.stage) })).rows;
        }
      }
      return healthRows.find(r => r.role === role.id)?.alive ?? 'unknown';
    };
    for (const guild of config.guilds) for (const channel of guild.channels) {
      const key = `${guild.id}/${channel.id}`;
      try {
        const metadata = await api(`/channels/${channel.id}`);
        if (metadata.guild_id !== guild.id) throw Error('channel guild mismatch');
        if (!state.channels[key]) {
          const rows = await api(`/channels/${channel.id}/messages?limit=1`);
          if (!Array.isArray(rows) || (rows[0] && !id(rows[0].id))) throw Error('invalid baseline');
          state.channels[key] = { cursor: rows[0]?.id ?? '0', pending: {}, baselineAt: now }; await save(); emit('baseline', 'recorded'); continue;
        }
        const next = structuredClone(state.channels[key]), messages = [];
        let before, complete = false;
        for (let page = 0; page < (config.maxPages ?? 100); page++) {
          const rows = await api(`/channels/${channel.id}/messages?limit=100${before ? `&before=${before}` : ''}`);
          if (!Array.isArray(rows) || rows.some(m => !id(m.id))) throw Error('invalid message page');
          messages.push(...rows.filter(m => compare(m.id, next.cursor) > 0));
          if (rows.length < 100 || rows.some(m => compare(m.id, next.cursor) <= 0)) { complete = true; break; }
          const oldest = rows.reduce((a, b) => compare(a.id, b.id) < 0 ? a : b).id;
          if (before === oldest) throw Error('pagination did not advance'); before = oldest;
        }
        if (!complete) throw Error('pagination limit reached; cursor retained');
        const ownMessages = new Set(Object.values(next.pending).flatMap(r => Object.values(r.stages).map(s => s.messageId).filter(Boolean)));
        for (const message of messages.sort((a, b) => compare(a.id, b.id))) {
          const ownNonce = Object.values(next.pending).some(r => Object.keys(r.stages).some(stage => String(message.nonce ?? '') === hash(`${guild.id}/${channel.id}/${r.messageId}/${r.to}/${stage}`)));
          if (ownMessages.has(message.id) || ownNonce) continue;
          const at = Date.parse(message.timestamp);
          if (!Number.isFinite(at) || at > now) throw Error('invalid message timestamp');
          const matched = Object.values(next.pending).filter(r => r.closedAt === undefined && at >= r.at && isReceipt(message, r));
          // A mention reply with multiple outstanding requests is ambiguous; require an explicit reply.
          const receipts = message.message_reference?.message_id ? matched : matched.length === 1 ? matched : [];
          for (const r of receipts) {
            if (!r.receiptId) { r.receiptId = message.id; delete r.health; r.deadline = parseDeadline(message.content, at, config.timezoneOffsetMinutes ?? 0); if (r.deadline === null) r.closedAt = at; }
            else if (compare(message.id, r.receiptId) > 0) r.closedAt = at;
          }
          if (!receipts.length) for (const role of detectRequests(message, config.roles)) next.pending[`${message.id}/${role.botId}`] = { messageId: message.id, from: message.author.id, to: role.botId, roleId: role.id, at, stages: {} };
        }
        if (messages.length) next.cursor = messages.at(-1).id;
        state.channels[key] = next; delete state.errors[key]; await save();
        for (const request of Object.values(next.pending)) {
          if (request.closedAt !== undefined) continue;
          const target = config.roles.find(r => r.botId === request.to), source = config.roles.find(r => r.botId === request.from);
          if (!target || !source || !object(request.stages)) throw Error('request role/state mismatch');
          const due = request.receiptId ? request.deadline : request.at + (config.thresholds?.nudgeMinutes ?? 10) * 60000;
          if (now >= due) {
            await notify(request, request.receiptId ? 'overdue' : 'nudge', target, guild, channel);
            if (!request.health) {
              try { const alive = await health(target); request.health = { alive, at: now }; } catch { request.health = { alive: 'unknown', at: now }; }
              if (request.health.alive === 'unknown') { degraded = true; delete request.health; emit('session-health', 'unknown'); }
              await save();
            }
            if (request.health && ['missing', 'empty', 'stopped'].includes(request.health.alive)) await notify(request, 'recovery', config.roles.find(r => r.id === config.recovery.roleId), guild, channel, request.health.alive);
          }
          const escalationAt = request.receiptId ? request.deadline + ((config.thresholds?.escalateMinutes ?? 30) - (config.thresholds?.nudgeMinutes ?? 10)) * 60000 : request.at + (config.thresholds?.escalateMinutes ?? 30) * 60000;
          if (now >= escalationAt) await notify(request, 'escalate', source, guild, channel);
        }
      } catch (e) { degraded = true; state.errors[key] = { at: now, reason: e.message }; await save(); emit('channel', 'failed', { reason: e.message }); }
    }
    state.lastRun = { at: now, result: degraded ? 'degraded' : 'complete' }; await save(); emit('end', state.lastRun.result, { durationMs: Date.now() - started }); return state;
  } catch (e) { emit('end', 'failed', { durationMs: Date.now() - started, reason: e.message }); throw e; }
  finally { if (lock) { await lock.close(); await unlink(`${stateFile}.lock`); } }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), at = args.indexOf('--config');
    if (at < 0 || !args[at + 1] || args.some((x, i) => !['--config', '--dry'].includes(x) && i !== at + 1)) throw Error('Usage: agent-request-watch.mjs --config <file> [--dry]');
    const config = JSON.parse(await readFile(args[at + 1], 'utf8'));
    const result = await runWatch(config, { token: process.env[config.tokenEnv ?? 'DISCORD_BOT_TOKEN'], dry: args.includes('--dry') || process.env.DRY_RUN === '1' });
    process.exitCode = result.lastRun.result === 'degraded' ? 2 : 0;
  } catch (e) { console.error(JSON.stringify({ stage: 'startup', result: 'failed', reason: e.message })); process.exitCode = 1; }
}
