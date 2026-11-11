// Shared alert channel for the watch scripts: notify.kind picks Discord (default) or the Naia messenger.
// send() returns { id } (the posted message ID, stored where the Discord message ID was) or throws an
// Error with .uncertain (may have been delivered: transport failure, 5xx, unreadable receipt) or not
// (rejected: other 4xx). Errors with .setup were raised before anything was posted (URL, token or channel
// lookup). HTTP 429 is retried in-process only in messenger mode or when notify.retries is set; Discord by
// default sends once, as the watch scripts did before.
import { setTimeout as delay } from 'node:timers/promises';

const KINDS = ['discord', 'messenger'];
const NAME = /^[\p{L}\p{N}_-]+$/u;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const own = (map, key) => object(map) && Object.hasOwn(map, key);
const originOk = value => {
  let url;
  try { url = new URL(value); } catch { return false; }
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
};
const target = value => typeof value === 'string' && /^[\p{L}\p{N}_-]+$/u.test(value);

export const notifyKind = notify => notify?.kind ?? 'discord';

export function validateNotify(notify) {
  if (notify === undefined) return;
  if (!object(notify) || !KINDS.includes(notifyKind(notify))) throw Error('notify.kind must be discord or messenger');
  if (notify.retries !== undefined && (!Number.isInteger(notify.retries) || notify.retries < 0 || notify.retries > 5)) throw Error('notify.retries must be 0-5');
  if (notifyKind(notify) === 'discord') return;
  if (notify.url !== undefined && !originOk(notify.url)) throw Error('notify.url must be http(s) with no credentials, query or fragment');
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
const setupFailure = message => Object.assign(failure(message, false), { setup: true });

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

// names: default messenger names for configured IDs (for example role bot ID → messenger role ID); notify.mentions
// wins. Values in send({ people }) are persons: in messenger mode they are already messenger names and are
// used as is, so a person never turns into a role that shares the ID.
export function createNotifier(notify = {}, { token, env = process.env, fetchImpl = fetch, names = {}, sleep = ms => delay(ms) } = {}) {
  validateNotify(notify);
  const kind = notifyKind(notify), retries = notify.retries ?? (kind === 'messenger' ? 2 : 0);
  if (kind === 'discord') {
    return { kind, async send({ channelId, content, mentions = [], nonce }) {
      if (!token) throw setupFailure('Discord token missing');
      return post(fetchImpl, `https://discord.com/api/v10/channels/${channelId}/messages`, { method: 'POST', headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ content, allowed_mentions: { parse: [], users: mentions }, ...(nonce ? { nonce, enforce_nonce: true } : {}) }) }, 'Discord', retries, sleep);
    } };
  }
  const url = notify.url ?? env[notify.urlEnv ?? 'NAIA_MESSENGER_URL'];
  const agentToken = env[notify.tokenEnv ?? 'NAIA_MESSENGER_TOKEN'];
  const nameOf = value => own(notify.mentions, value) ? notify.mentions[value] : own(names, value) ? names[value] : value;
  let channels;
  return { kind, async send({ stage, content, people = [] }) {
    if (!url || !agentToken) throw setupFailure('messenger URL or token missing');
    if (!originOk(url)) throw setupFailure('messenger URL must be http(s) with no credentials, query or fragment');
    const base = new URL(url);
    const prefix = `${base.href.replace(/\/$/, '')}/api/portal/messenger`;
    const headers = { 'X-AX-Agent-Token': agentToken };
    const route = notify.routes?.[stage] ?? {};
    const wanted = route.channel ?? notify.channel, threadId = route.threadId ?? (route.channel ? undefined : notify.threadId);
    if (!channels) {
      let response;
      try { response = await fetchImpl(`${prefix}/channels`, { headers, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
      catch { throw setupFailure('messenger transport failure'); }
      if (!response.ok) throw Object.assign(setupFailure(`messenger HTTP ${response.status}`), { status: response.status });
      try { channels = await response.json(); } catch { throw setupFailure('messenger invalid channel list'); }
      if (!Array.isArray(channels)) { channels = undefined; throw setupFailure('messenger invalid channel list'); }
    }
    const channel = channels.find(c => c.id === wanted || c.name === wanted);
    if (!channel) throw setupFailure('messenger channel not found');
    // Discord-style <@id> becomes a messenger @name so the person or role is mentioned there.
    const body = String(content).replace(/<@!?([\p{L}\p{N}_-]+)>/gu, (m, value) => `@${people.includes(value) ? value : nameOf(value)}`);
    return post(fetchImpl, `${prefix}/channels/${encodeURIComponent(channel.id)}/messages`, { method: 'POST', redirect: 'error', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ body, ...(threadId ? { reply_to_id: threadId } : {}) }) }, 'messenger', retries, sleep);
  } };
}
