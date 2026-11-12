#!/usr/bin/env node
import { readFile, writeFile, mkdir, rename, open, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
// Instance-configurable message text; {name} placeholders are replaced, unknown ones are left as is.
export function fill(template, values) { return String(template).replace(/\{(\w+)\}/g, (m, k) => (k in values ? String(values[k]) : m)); }

const compare = (a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
const eligible = m => [0, 19].includes(m.type ?? 0) && !!m.author?.id && !m.author.bot && !m.webhook_id;
const ref = m => m.message_reference?.message_id;
const namedRole = (content, name) => {
  const marker = `@${name}`;
  for (let at = content.indexOf(marker); at >= 0; at = content.indexOf(marker, at + marker.length)) {
    const preceding = content[at - 1], following = content[at + marker.length];
    if ((!preceding || /\s/u.test(preceding)) && (!following || /[\s,.:;!?()[\]{}]/u.test(following))) return true;
  }
  return false;
};
const fingerprint = value => createHash('sha256').update(value).digest('hex').slice(0, 16);

export function validateConfig(config) {
  const id = value => typeof value === 'string' && /^\d+$/.test(value);
  const requireId = value => { if (!id(value)) throw new Error('invalid configured Discord id'); };
  if (!config.stateFile || !Array.isArray(config.guilds) || !config.guilds.length) throw new Error('stateFile and guilds required');
  const nudge = config.thresholds?.nudgeMinutes ?? 10;
  const escalate = config.thresholds?.escalateMinutes ?? 30;
  if (!(Number.isFinite(nudge) && nudge > 0 && Number.isFinite(escalate) && escalate > nudge)) throw new Error('invalid thresholds');
  const burst = config.thresholds?.burstMinutes ?? 10;
  if (!(Number.isFinite(burst) && burst >= 0)) throw new Error('invalid thresholds');
  if (!Number.isInteger(config.maxPages ?? 100) || (config.maxPages ?? 100) < 1) throw new Error('invalid maxPages');
  const channels = new Set();
  for (const guild of config.guilds) {
    [guild.id, guild.defaultBotId, guild.nudgeChannelId, guild.escalation?.channelId, guild.escalation?.userId].forEach(requireId);
    if (!Array.isArray(guild.channels) || !guild.channels.length) throw new Error('channels required');
    for (const channel of guild.channels) {
      requireId(channel.id); if (channel.botId) requireId(channel.botId);
      if (channels.has(channel.id)) throw new Error('duplicate watched channel');
      channels.add(channel.id);
      if (channel.mode && !['mentions', 'all-human'].includes(channel.mode)) throw new Error('invalid channel mode');
    }
    for (const role of guild.roles ?? []) { requireId(role.id); requireId(role.botId); }
    (guild.excludeChannelIds ?? []).forEach(requireId);
  }
  for (const site of config.sites ?? []) {
    const url = new URL(site.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('site URL must have no credentials, query or fragment');
    requireId(site.channelId);
    if (!Number.isInteger(site.failureThreshold ?? 2) || (site.failureThreshold ?? 2) < 1) throw new Error('invalid site threshold');
  }
  return config;
}

export async function runWatch(config, { fetchImpl = fetch, token, dry = false, now = Date.now(), log = event => console.log(JSON.stringify(event)) } = {}) {
  validateConfig(config);
  if (!token) throw new Error('configured token environment variable is empty');
  const trace = randomUUID(), started = Date.now(), stateFile = resolve(config.stateFile);
  const emit = (stage, result, extra = {}) => log({ trace, stage, result, ...extra });
  emit('start', dry ? 'dry' : 'running');
  let lock;
  if (!dry) {
    await mkdir(dirname(stateFile), { recursive: true });
    lock = await open(`${stateFile}.lock`, 'wx', 0o600);
    await lock.writeFile(JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
  }
  let state, degraded = false;
  try {
    try { state = JSON.parse(await readFile(stateFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('state unreadable; refusing reset'); state = { version: 1, channels: {}, sites: {} }; }
    if (state.version !== 1 || !state.channels || !state.sites) throw new Error('unsupported state');
    state.errors ??= {};
    const save = async () => {
      if (dry) return;
      const temporary = `${stateFile}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, stateFile);
    };
    const api = async (path, body) => {
      let response;
      try { response = await fetchImpl(`https://discord.com/api/v10${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) }); }
      catch { const error = new Error('Discord transport failure'); error.uncertain = !!body; throw error; }
      if (!response.ok) { const error = new Error(`Discord HTTP ${response.status}`); error.uncertain = !!body && response.status >= 500; throw error; }
      try { return await response.json(); }
      catch { const error = new Error('Discord invalid JSON'); error.uncertain = !!body; throw error; }
    };
    const send = async (holder, key, channelId, content, mentions) => {
      const existing = holder[key];
      if (existing?.status === 'confirmed' || existing?.status === 'intent' || existing?.status === 'uncertain') {
        if (existing.status !== 'confirmed') { degraded = true; emit('send', 'reconciliation_required', { key: fingerprint(key) }); }
        return;
      }
      if (dry) { emit('send', 'would_send', { key: fingerprint(key) }); return; }
      holder[key] = { status: 'intent', at: now };
      await save();
      try {
        const receipt = await api(`/channels/${channelId}/messages`, { content, allowed_mentions: { parse: [], users: mentions }, nonce: fingerprint(key), enforce_nonce: true });
        if (!receipt.id) { const error = new Error('Discord missing send receipt'); error.uncertain = true; throw error; }
        holder[key] = { status: 'confirmed', at: now, messageId: receipt.id };
        emit('send', 'confirmed', { key: fingerprint(key) });
      } catch (error) {
        degraded = true;
        holder[key] = { status: error.uncertain ? 'uncertain' : 'rejected', at: now, error: error.message };
        emit('send', holder[key].status, { reason: error.message, key: fingerprint(key) });
      }
      await save();
    };
    for (const guild of config.guilds) for (const channel of guild.channels) {
      if ((guild.excludeChannelIds ?? []).includes(channel.id)) continue;
      const key = `${guild.id}/${channel.id}`;
      const previous = state.channels[key];
      try {
        // Validate membership before consuming a cursor: a typo cannot silently monitor another guild.
        const metadata = await api(`/channels/${channel.id}`);
        if (metadata.guild_id !== guild.id) throw new Error('channel guild mismatch');
        if (!previous) {
          const latest = await api(`/channels/${channel.id}/messages?limit=1`);
          if (!Array.isArray(latest)) throw new Error('invalid message page');
          state.channels[key] = { cursor: latest[0]?.id ?? '0', pending: {}, baselineAt: now };
          delete state.errors[key];
          await save(); emit('baseline', 'recorded', { channel: fingerprint(key) }); continue;
        }
        const messages = [];
        let before, complete = false;
        for (let page = 0; page < (config.maxPages ?? 100); page++) {
          const rows = await api(`/channels/${channel.id}/messages?limit=100${before ? `&before=${before}` : ''}`);
          if (!Array.isArray(rows)) throw new Error('invalid message page');
          for (const message of rows) if (compare(message.id, previous.cursor) > 0) messages.push(message);
          if (rows.length < 100 || rows.some(m => compare(m.id, previous.cursor) <= 0)) { complete = true; break; }
          const oldest = rows.reduce((a, b) => compare(a.id, b.id) < 0 ? a : b).id;
          if (oldest === before) throw new Error('pagination did not advance');
          before = oldest;
        }
        if (!complete) throw new Error('pagination limit reached; cursor retained');
        const next = structuredClone(previous);
        const replies = structuredClone(state.replies ?? {});
        for (const message of messages.sort((a, b) => compare(a.id, b.id))) {
          if (![0, 19].includes(message.type ?? 0)) continue;
          if (message.author?.bot) {
            // One reply often answers a burst: it closes the referenced post and the same author's earlier posts still pending for this bot.
            const target = ref(message), replier = message.author.id;
            const poster = next.pending[target]?.author ?? (message.referenced_message?.author?.id ? fingerprint(message.referenced_message.author.id) : undefined);
            // Only posts within burstMinutes before the referenced post count as the same burst, so an unrelated older question stays pending.
            const targetAt = next.pending[target]?.at ?? Date.parse(message.referenced_message?.timestamp ?? message.timestamp);
            const since = Number.isFinite(targetAt) ? targetAt - (config.thresholds?.burstMinutes ?? 10) * 60000 : Infinity;
            // A post assigned only by the all-human fallback names no recipient, so another bot's reply answers it when that reply references a pending post.
            const answered = !target ? [] : Object.entries(next.pending).filter(([id, request]) => (request.botId === replier || (request.via === 'fallback' && next.pending[target])) && (id === target || (poster && request.author === poster && compare(id, target) < 0 && request.at >= since)));
            if (answered.length) {
              const at = Date.parse(message.timestamp);
              if (Number.isFinite(at) && at <= now) {
                const old = replies[replier]?.at ?? 0;
                replies[replier] = { at: Math.max(old, at) };
              }
              for (const [id] of answered) delete next.pending[id];
            }
            continue;
          }
          if (!eligible(message)) continue;
          const botId = channel.botId ?? guild.defaultBotId;
          const mentions = message.mentions ?? [];
          const roles = (guild.roles ?? []).filter(role => (message.mention_roles ?? []).includes(role.id) || (role.name && namedRole(message.content ?? '', role.name)));
          const direct = mentions.some(user => user.id === botId);
          const candidates = new Set(roles.map(role => role.botId));
          if (direct) candidates.add(botId);
          if (candidates.size > 1) throw new Error('ambiguous assignment; cursor retained');
          const fallback = !candidates.size && channel.mode === 'all-human' && !mentions.length && !ref(message);
          const assigned = [...candidates][0] ?? (fallback ? botId : undefined);
          const timestamp = Date.parse(message.timestamp);
          const author = fingerprint(message.author.id);
          // Naming an agent right after an unaddressed post ("now" then "@other now") re-addresses that burst, so its fallback posts stop waiting.
          // Mentioning a person does not: "thanks @friend" leaves the question pending.
          if ((mentions.some(user => user.bot) || roles.length) && Number.isFinite(timestamp)) {
            const since = timestamp - (config.thresholds?.burstMinutes ?? 10) * 60000;
            for (const [id, request] of Object.entries(next.pending)) if (request.via === 'fallback' && request.author === author && request.at >= since && compare(id, message.id) < 0) delete next.pending[id];
          }
          if (!assigned) continue;
          if (!Number.isFinite(timestamp)) throw new Error('invalid request timestamp');
          next.pending[message.id] = { botId: assigned, author, at: timestamp, stages: {}, ...(fallback ? { via: 'fallback' } : {}) };
        }
        if (messages.length) next.cursor = messages.at(-1).id;
        delete next.error;
        delete state.errors[key];
        state.channels[key] = next; state.replies = replies; await save();
        for (const [messageId, request] of Object.entries(next.pending)) {
          const age = (now - request.at) / 60000;
          const link = `https://discord.com/channels/${guild.id}/${channel.id}/${messageId}`;
          if (age >= (config.thresholds?.nudgeMinutes ?? 10)) await send(request.stages, `${key}/${messageId}/nudge`, guild.nudgeChannelId, fill(config.messages?.nudge ?? '<@{bot}> Please respond to the pending request: {link}', { bot: request.botId, link }), [request.botId]);
          if (age >= (config.thresholds?.escalateMinutes ?? 30)) await send(request.stages, `${key}/${messageId}/escalate`, guild.escalation.channelId, fill(config.messages?.escalate ?? '<@{user}> Response remains unconfirmed: {link}', { user: guild.escalation.userId, link }), [guild.escalation.userId]);
        }
      } catch (error) {
        degraded = true;
        state.errors[key] = { at: now, reason: error.message };
        if (state.channels[key]) state.channels[key].error = state.errors[key];
        emit('channel', 'failed', { channel: fingerprint(key), reason: error.message }); await save();
      }
    }
    for (const site of config.sites ?? []) {
      const key = fingerprint(site.url);
      const baseline = !state.sites[key];
      const record = state.sites[key] ??= { failures: 0, cycle: 0, stages: {} };
      let healthy = false;
      try { healthy = (await fetchImpl(site.url, { redirect: 'error', signal: AbortSignal.timeout(15000) })).ok; } catch { /* Count timeout and transport failures without logging the URL. */ }
      if (healthy) {
        if (record.alerted) {
          await send(record.stages, `site/${key}/${record.cycle}/recovery`, site.channelId, fill(config.messages?.siteRecovered ?? 'Configured site check {site} recovered.', { site: key }), []);
          if (record.stages[`site/${key}/${record.cycle}/recovery`]?.status === 'confirmed') { record.alerted = false; record.cycle++; record.stages = {}; }
        }
        record.failures = 0;
      } else {
        degraded = true;
        record.failures++;
        if (!baseline && record.failures >= (site.failureThreshold ?? 2)) {
          await send(record.stages, `site/${key}/${record.cycle}/failure`, site.channelId, fill(config.messages?.siteFailure ?? 'Configured site check {site} failed repeatedly.', { site: key }), []);
          record.alerted = true;
        }
      }
      emit('site', healthy ? 'healthy' : 'failed', { site: key, failures: record.failures }); await save();
    }
    state.lastRun = { at: now, result: degraded ? 'degraded' : 'complete' };
    await save();
    emit('end', state.lastRun.result, { durationMs: Date.now() - started });
    return state;
  } catch (error) { emit('end', 'failed', { reason: error.message, durationMs: Date.now() - started }); throw error; }
  finally { if (lock) { await lock.close(); await unlink(`${stateFile}.lock`); } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const configAt = args.indexOf('--config');
  if (configAt < 0 || !args[configAt + 1] || args.some((arg, i) => !['--config', '--dry'].includes(arg) && i !== configAt + 1)) {
    console.error('Usage: node scripts/response-watch.mjs --config <file> [--dry]'); process.exitCode = 1;
  } else {
    try {
      const config = JSON.parse(await readFile(args[configAt + 1], 'utf8'));
      const state = await runWatch(config, { token: process.env[config.tokenEnv ?? 'DISCORD_BOT_TOKEN'], dry: args.includes('--dry') || process.env.DRY_RUN === '1' });
      if (state.lastRun.result === 'degraded') process.exitCode = 2;
    } catch (error) { console.error(JSON.stringify({ stage: 'startup', result: 'failed', reason: error.message })); process.exitCode = 1; }
  }
}
