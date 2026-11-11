// Shared alert channel for the watch scripts: notify.kind picks Discord (default) or the Naia messenger.
// send() returns { id } (the posted message ID, stored where the Discord message ID was) or throws an
// Error with .uncertain (may have been delivered: transport failure, 5xx, unreadable receipt) or not
// (rejected: other 4xx). Only HTTP 429 is retried in-process, because the server did not accept the post.
import { setTimeout as delay } from 'node:timers/promises';

const KINDS = ['discord', 'messenger'];
const NAME = /^[\p{L}\p{N}_-]+$/u;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const target = value => typeof value === 'string' && /^[\p{L}\p{N}_-]+$/u.test(value);

export const notifyKind = notify => notify?.kind ?? 'discord';

export function validateNotify(notify) {
  if (notify === undefined) return;
  if (!object(notify) || !KINDS.includes(notifyKind(notify))) throw Error('notify.kind must be discord or messenger');
  if (notify.retries !== undefined && (!Number.isInteger(notify.retries) || notify.retries < 0 || notify.retries > 5)) throw Error('notify.retries must be 0-5');
  if (notifyKind(notify) === 'discord') return;
  if (notify.url !== undefined) {
    const url = new URL(notify.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('notify.url must be http(s) with no credentials, query or fragment');
  }
  for (const key of ['urlEnv', 'tokenEnv']) if (notify[key] !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(notify[key])) throw Error(`invalid notify.${key}`);
  const routes = notify.routes ?? {};
  if (!object(routes) || Object.values(routes).some(r => !object(r) || (r.channel !== undefined && !target(r.channel)) || (r.threadId !== undefined && !target(r.threadId)))) throw Error('invalid notify.routes');
  if (notify.channel !== undefined && !target(notify.channel)) throw Error('invalid notify.channel');
  if (notify.threadId !== undefined && !target(notify.threadId)) throw Error('invalid notify.threadId');
  if (notify.mentions !== undefined && (!object(notify.mentions) || Object.values(notify.mentions).some(name => typeof name !== 'string' || !NAME.test(name)))) throw Error('invalid notify.mentions');
  if (!notify.channel) throw Error('notify.channel required for messenger');
}

// A recipient is a Discord ID or, in messenger mode, a messenger name.
export const recipientOk = (notify, value) => typeof value === 'string' && (notifyKind(notify) === 'messenger' ? NAME.test(value) : /^\d+$/.test(value));

const failure = (message, uncertain, status) => Object.assign(Error(message), { uncertain, ...(status ? { status } : {}) });

async function post(fetchImpl, url, init, label, retries, sleep) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try { response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15000) }); }
    catch { throw failure(`${label} transport failure`, true); }
    if (response.status === 429 && attempt < retries) {
      const wait = Number(response.headers?.get?.('retry-after'));
      await sleep(Math.min(Number.isFinite(wait) && wait > 0 ? wait * 1000 : 1000 * 2 ** attempt, 30000));
      continue;
    }
    if (!response.ok) throw failure(`${label} HTTP ${response.status}`, response.status >= 500, response.status);
    let data;
    try { data = await response.json(); } catch { throw failure(`${label} invalid JSON`, true); }
    if (!data || typeof data.id !== 'string' || !data.id) throw failure(`${label} missing send receipt`, true);
    return { id: data.id };
  }
}

// names: default messenger names for configured IDs (for example role bot ID → role ID); notify.mentions wins.
export function createNotifier(notify = {}, { token, env = process.env, fetchImpl = fetch, names = {}, sleep = ms => delay(ms) } = {}) {
  validateNotify(notify);
  const kind = notifyKind(notify), retries = notify.retries ?? 2;
  if (kind === 'discord') {
    return { kind, async send({ channelId, content, mentions = [], nonce }) {
      if (!token) throw failure('Discord token missing', false);
      return post(fetchImpl, `https://discord.com/api/v10/channels/${channelId}/messages`, { method: 'POST', headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ content, allowed_mentions: { parse: [], users: mentions }, ...(nonce ? { nonce, enforce_nonce: true } : {}) }) }, 'Discord', retries, sleep);
    } };
  }
  const url = notify.url ?? env[notify.urlEnv ?? 'NAIA_MESSENGER_URL'];
  const agentToken = env[notify.tokenEnv ?? 'NAIA_MESSENGER_TOKEN'];
  const nameOf = value => notify.mentions?.[value] ?? names[value] ?? value;
  let channels;
  return { kind, async send({ stage, content }) {
    if (!url || !agentToken) throw failure('messenger URL or token missing', false);
    const base = new URL(url);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw failure('messenger URL must be http(s) without credentials', false);
    const prefix = `${base.href.replace(/\/$/, '')}/api/portal/messenger`;
    const headers = { 'X-AX-Agent-Token': agentToken };
    const route = notify.routes?.[stage] ?? {};
    const wanted = route.channel ?? notify.channel, threadId = route.threadId ?? (route.channel ? undefined : notify.threadId);
    if (!channels) {
      let response;
      try { response = await fetchImpl(`${prefix}/channels`, { headers, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
      catch { throw failure('messenger transport failure', false); }
      if (!response.ok) throw failure(`messenger HTTP ${response.status}`, false, response.status);
      try { channels = await response.json(); } catch { throw failure('messenger invalid channel list', false); }
      if (!Array.isArray(channels)) { channels = undefined; throw failure('messenger invalid channel list', false); }
    }
    const channel = channels.find(c => c.id === wanted || c.name === wanted);
    if (!channel) throw failure('messenger channel not found', false);
    // Discord-style <@id> becomes a messenger @name so the person or role is mentioned there.
    const body = String(content).replace(/<@!?([\p{L}\p{N}_-]+)>/gu, (m, value) => `@${nameOf(value)}`);
    return post(fetchImpl, `${prefix}/channels/${encodeURIComponent(channel.id)}/messages`, { method: 'POST', redirect: 'error', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ body, ...(threadId ? { reply_to_id: threadId } : {}) }) }, 'messenger', retries, sleep);
  } };
}
