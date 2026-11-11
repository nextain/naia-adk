import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createNotifier, validateNotify, recipientOk } from './notify.mjs';

// A local stand-in for the messenger API: agent token, channel list, message POST.
async function fakeMessenger({ status = [], token = 'agent-token' } = {}) {
  const posts = [], requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, token: req.headers['x-ax-agent-token'] });
      const send = (code, value, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(value)); };
      if (req.headers['x-ax-agent-token'] !== token) return send(401, { error: 'token' });
      if (req.method === 'GET' && req.url === '/api/portal/messenger/channels') return send(200, [{ id: 'ch-ops', name: 'ops' }, { id: 'ch-req', name: 'requests' }]);
      const match = req.url.match(/^\/api\/portal\/messenger\/channels\/([^/]+)\/messages$/);
      if (req.method === 'POST' && match) {
        const next = status.shift();
        if (next === 429) return send(429, { error: 'slow' }, { 'Retry-After': '0' });
        if (next) return send(next, { error: 'fail' });
        posts.push({ channel: decodeURIComponent(match[1]), ...JSON.parse(raw) });
        return send(200, { id: `msg-${posts.length}` });
      }
      send(404, {});
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${server.address().port}`, posts, requests, close: () => new Promise(done => server.close(done)) };
}
const noSleep = async () => {};

test('discord is the default and keeps the existing request shape', async () => {
  const calls = [];
  const notifier = createNotifier(undefined, { token: 'bot-token', fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ id: '901' }) }; } });
  assert.equal(notifier.kind, 'discord');
  assert.deepEqual(await notifier.send({ stage: 'nudge', channelId: '31', content: '<@20> hi', mentions: ['20'], nonce: 'abc' }), { id: '901' });
  assert.equal(calls[0].url, 'https://discord.com/api/v10/channels/31/messages');
  assert.equal(calls[0].init.headers.Authorization, 'Bot bot-token');
  assert.deepEqual(JSON.parse(calls[0].init.body), { content: '<@20> hi', allowed_mentions: { parse: [], users: ['20'] }, nonce: 'abc', enforce_nonce: true });
});

test('discord failures are classified: 4xx rejected, 5xx/transport/missing receipt uncertain', async () => {
  const run = async fetchImpl => { try { await createNotifier({ kind: 'discord' }, { token: 't', fetchImpl, sleep: noSleep }).send({ channelId: '1', content: 'x' }); } catch (e) { return e; } };
  assert.equal((await run(async () => ({ ok: false, status: 403 }))).uncertain, false);
  assert.equal((await run(async () => ({ ok: false, status: 502 }))).uncertain, true);
  assert.equal((await run(async () => { throw Error('private'); })).uncertain, true);
  assert.equal((await run(async () => ({ ok: true, json: async () => ({}) }))).uncertain, true);
  assert.doesNotMatch((await run(async () => { throw Error('private'); })).message, /private/);
});

test('HTTP 429 is retried up to notify.retries, then recorded as rejected', async () => {
  let calls = 0;
  const limited = async () => { calls++; return { ok: false, status: 429, headers: new Headers({ 'Retry-After': '0' }) }; };
  const error = await createNotifier({ kind: 'discord', retries: 2 }, { token: 't', fetchImpl: limited, sleep: noSleep }).send({ channelId: '1', content: 'x' }).catch(e => e);
  assert.equal(calls, 3); assert.equal(error.status, 429); assert.equal(error.uncertain, false);
  calls = 0;
  const flaky = async () => (++calls === 1 ? { ok: false, status: 429, headers: new Headers() } : { ok: true, json: async () => ({ id: '7' }) });
  assert.deepEqual(await createNotifier({ retries: 1 }, { token: 't', fetchImpl: flaky, sleep: noSleep }).send({ channelId: '1', content: 'x' }), { id: '7' });
});

test('messenger posts to the named channel with the agent token and turns <@id> into @mentions', async () => {
  const fake = await fakeMessenger();
  try {
    const notifier = createNotifier({ kind: 'messenger', url: fake.url, channel: 'ops', mentions: { 41: 'owner' } }, { env: { NAIA_MESSENGER_TOKEN: 'agent-token' }, names: { 20: 'helper' } });
    assert.deepEqual(await notifier.send({ stage: 'nudge', channelId: '31', content: '<@20> please reply: link', mentions: ['20'] }), { id: 'msg-1' });
    assert.deepEqual(await notifier.send({ stage: 'escalate', content: '<@41> still unanswered', mentions: ['41'] }), { id: 'msg-2' });
    assert.deepEqual(await notifier.send({ stage: 'escalate', content: '<@alice> plain name' }), { id: 'msg-3' });
    assert.deepEqual(fake.posts, [{ channel: 'ch-ops', body: '@helper please reply: link' }, { channel: 'ch-ops', body: '@owner still unanswered' }, { channel: 'ch-ops', body: '@alice plain name' }]);
    assert.ok(fake.requests.every(r => r.token === 'agent-token'));
    assert.equal(fake.requests.filter(r => r.method === 'GET').length, 1, 'channel list is read once per notifier');
  } finally { await fake.close(); }
});

test('messenger routes pick a channel and thread per stage', async () => {
  const fake = await fakeMessenger();
  try {
    const notifier = createNotifier({ kind: 'messenger', url: fake.url, channel: 'ops', threadId: 'root-1', routes: { escalate: { channel: 'requests', threadId: 'root-2' }, recovery: { channel: 'ch-req' } } }, { env: { NAIA_MESSENGER_TOKEN: 'agent-token' } });
    await notifier.send({ stage: 'nudge', content: 'a' });
    await notifier.send({ stage: 'escalate', content: 'b' });
    await notifier.send({ stage: 'recovery', content: 'c' });
    assert.deepEqual(fake.posts, [{ channel: 'ch-ops', body: 'a', reply_to_id: 'root-1' }, { channel: 'ch-req', body: 'b', reply_to_id: 'root-2' }, { channel: 'ch-req', body: 'c' }]);
  } finally { await fake.close(); }
});

test('messenger failures: 429 retried, 4xx rejected, 5xx uncertain, missing setup rejected without a POST', async () => {
  const fake = await fakeMessenger({ status: [429, 400, 503] });
  try {
    const env = { NAIA_MESSENGER_TOKEN: 'agent-token' };
    const notifier = createNotifier({ kind: 'messenger', url: fake.url, channel: 'ops', retries: 1 }, { env, sleep: noSleep });
    const rejected = await notifier.send({ content: 'a' }).catch(e => e);
    assert.equal(rejected.status, 400); assert.equal(rejected.uncertain, false);
    const uncertain = await notifier.send({ content: 'b' }).catch(e => e);
    assert.equal(uncertain.status, 503); assert.equal(uncertain.uncertain, true);
    assert.deepEqual(await notifier.send({ content: 'c' }), { id: 'msg-1' });
    const before = fake.requests.length;
    assert.equal((await createNotifier({ kind: 'messenger', url: fake.url, channel: 'ops' }, { env: {} }).send({ content: 'x' }).catch(e => e)).uncertain, false);
    assert.equal((await createNotifier({ kind: 'messenger', url: fake.url, channel: 'missing' }, { env }).send({ content: 'x' }).catch(e => e)).message, 'messenger channel not found');
    assert.equal((await createNotifier({ kind: 'messenger', url: fake.url, channel: 'ops' }, { env: { NAIA_MESSENGER_TOKEN: 'wrong' } }).send({ content: 'x' }).catch(e => e)).uncertain, false);
    assert.equal(fake.requests.slice(before).filter(r => r.method === 'POST').length, 0);
  } finally { await fake.close(); }
});

test('messenger URL and token can come from configured environment names', async () => {
  const fake = await fakeMessenger({ token: 'other' });
  try {
    const notifier = createNotifier({ kind: 'messenger', urlEnv: 'MY_URL', tokenEnv: 'MY_TOKEN', channel: 'ops' }, { env: { MY_URL: fake.url, MY_TOKEN: 'other' } });
    assert.deepEqual(await notifier.send({ content: 'x' }), { id: 'msg-1' });
  } finally { await fake.close(); }
});

test('validateNotify rejects bad settings and recipientOk follows the kind', () => {
  validateNotify(undefined); validateNotify({ kind: 'discord' });
  validateNotify({ kind: 'messenger', channel: '업무-요청' });
  for (const bad of [{ kind: 'slack' }, { kind: 'messenger' }, { kind: 'messenger', channel: 'a b' }, { kind: 'messenger', channel: 'ops', url: 'https://user:pw@example.invalid' },
    { kind: 'messenger', channel: 'ops', tokenEnv: 'lower' }, { kind: 'messenger', channel: 'ops', mentions: { 1: 'a b' } }, { kind: 'messenger', routes: { nudge: {} } }, { kind: 'discord', retries: 9 }, []])
    assert.throws(() => validateNotify(bad), undefined, JSON.stringify(bad));
  assert.ok(recipientOk(undefined, '41')); assert.ok(!recipientOk(undefined, 'owner'));
  assert.ok(recipientOk({ kind: 'messenger', channel: 'ops' }, 'owner')); assert.ok(!recipientOk({ kind: 'messenger', channel: 'ops' }, '@owner'));
});

test('discord default sends once on HTTP 429, as before: no in-process retry unless notify.retries is set', async () => {
  for (const notify of [undefined, { kind: 'discord' }]) {
    let calls = 0; const sleeps = [];
    const error = await createNotifier(notify, { token: 't', fetchImpl: async () => { calls++; return { ok: false, status: 429, headers: new Headers({ 'Retry-After': '120' }) }; }, sleep: async ms => sleeps.push(ms) }).send({ channelId: '1', content: 'x' }).catch(e => e);
    assert.equal(calls, 1); assert.deepEqual(sleeps, []); assert.equal(error.message, 'Discord HTTP 429'); assert.equal(error.uncertain, false);
  }
});

test('mention names: only own keys, and a person mention is not replaced by a role default', async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => url.endsWith('/channels') ? { ok: true, json: async () => [{ id: 'c', name: 'c' }] } : (bodies.push(JSON.parse(init.body).body), { ok: true, json: async () => ({ id: 'm' }) });
  const notifier = createNotifier({ kind: 'messenger', url: 'http://h.invalid', channel: 'c' }, { env: { NAIA_MESSENGER_TOKEN: 'x' }, names: { 123: 'dev' }, fetchImpl });
  await notifier.send({ stage: 'nudge', content: '<@toString> <@constructor> hi' });
  await notifier.send({ stage: 'escalate', content: '<@123> owner please', people: ['123'] });
  await notifier.send({ stage: 'nudge', content: '<@123> role please' });
  assert.deepEqual(bodies, ['@toString @constructor hi', '@123 owner please', '@dev role please']);
});

test('messenger setup failures from the environment URL are rejected setup errors before any request', async () => {
  for (const value of ['not a url SECRET', 'http://h.invalid/?x=1', 'http://h.invalid/#f', 'ftp://h.invalid', 'http://u:p@h.invalid']) {
    let calls = 0;
    const error = await createNotifier({ kind: 'messenger', channel: 'c' }, { env: { NAIA_MESSENGER_URL: value, NAIA_MESSENGER_TOKEN: 'x' }, fetchImpl: async () => { calls++; return { ok: true, json: async () => [] }; } }).send({ content: 'x' }).catch(e => e);
    assert.equal(calls, 0, value); assert.equal(error.uncertain, false, value); assert.equal(error.setup, true, value);
    assert.doesNotMatch(error.message, /SECRET|h\.invalid/);
  }
  const error = await createNotifier({ kind: 'messenger', channel: 'missing', url: 'http://h.invalid' }, { env: { NAIA_MESSENGER_TOKEN: 'x' }, fetchImpl: async () => ({ ok: true, json: async () => [] }) }).send({ content: 'x' }).catch(e => e);
  assert.equal(error.setup, true); assert.equal(error.uncertain, false);
});
