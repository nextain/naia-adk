import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runWatch, validateConfig } from './response-watch.mjs';

const base = resolve(process.env.RESPONSE_WATCH_TEST_TMP ?? 'tmp');
await mkdir(base, { recursive: true });
const epoch = Date.parse('2026-01-01T00:00:00Z');
const human = (id, extra = {}) => ({ id: String(id), type: 0, author: { id: '40' }, timestamp: new Date(epoch).toISOString(), mentions: [{ id: '20', bot: true }], ...extra });
async function fixture() {
  const directory = await mkdtemp(`${base}/response-watch-`);
  const config = { stateFile: `${directory}/state.json`, guilds: [{ id: '10', defaultBotId: '20', channels: [{ id: '30', mode: 'all-human' }], excludeChannelIds: [], nudgeChannelId: '31', escalation: { channelId: '32', userId: '41' } }] };
  const remote = { messages: [human(1)], posts: [], events: [], siteOk: true, failRead: false, failPost: false, uncertain: false };
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'example.org') return { ok: remote.siteOk };
    if (options.method === 'POST') {
      remote.posts.push(JSON.parse(options.body));
      if (remote.uncertain) throw new Error('private transport content');
      if (remote.failPost) return { ok: false, status: remote.failPost === true ? 403 : remote.failPost };
      return { ok: true, json: async () => ({ id: String(900 + remote.posts.length) }) };
    }
    if (remote.failRead) return { ok: false, status: 503 };
    if (parsed.pathname.endsWith('/channels/30')) return { ok: true, json: async () => ({ guild_id: '10' }) };
    const specific = parsed.pathname.match(/\/messages\/(\d+)$/);
    if (specific) {
      const found = remote.messages.find(m => m.id === specific[1]);
      return { ok: !!found, status: 404, json: async () => found };
    }
    const before = parsed.searchParams.get('before');
    const rows = remote.messages.filter(m => !before || BigInt(m.id) < BigInt(before)).sort((a, b) => Number(BigInt(b.id) - BigInt(a.id))).slice(0, Number(parsed.searchParams.get('limit')));
    return { ok: true, json: async () => rows };
  };
  const run = (minutes = 0, extra = {}) => runWatch(config, { token: 'fixture-token', fetchImpl, now: epoch + minutes * 60000, log: event => remote.events.push(event), ...extra });
  return { config, remote, run };
}

test('first observation baselines old messages without alerting', async () => {
  const { remote, run } = await fixture(); const state = await run(60);
  assert.equal(state.channels['10/30'].cursor, '1'); assert.deepEqual(state.channels['10/30'].pending, {}); assert.equal(remote.posts.length, 0);
});
test('10 minute nudge and 30 minute owner notice persist once per stage across restart', async () => {
  const { remote, run } = await fixture(); await run(); remote.messages.push(human(2));
  await run(9); assert.equal(remote.posts.length, 0);
  await run(10); assert.equal(remote.posts.length, 1); assert.deepEqual(remote.posts[0].allowed_mentions.users, ['20']);
  await run(29); assert.equal(remote.posts.length, 1);
  await run(30); assert.equal(remote.posts.length, 2); assert.deepEqual(remote.posts[1].allowed_mentions.users, ['41']);
  await run(60); assert.equal(remote.posts.length, 2);
});
test('only explicit expected bot reply satisfies obligation', async () => {
  const { remote, run } = await fixture(); await run(); remote.messages.push(human(2)); await run(1);
  remote.messages.push(human(3, { author: { id: '21', bot: true }, message_reference: { message_id: '2' } }), human(4, { author: { id: '20', bot: true } }));
  await run(10); assert.equal(remote.posts.length, 1);
  remote.messages.push(human(5, { author: { id: '20', bot: true }, message_reference: { message_id: '2' } }));
  const state = await run(30); assert.equal(remote.posts.length, 1); assert.deepEqual(state.channels['10/30'].pending, {});
});
test('human conversation, other bot mentions and system messages are excluded', async () => {
  const { remote, run } = await fixture(); await run();
  remote.messages.push(human(2, { message_reference: { message_id: '1' }, mentions: [] }), human(3, { mentions: [{ id: '21', bot: true }] }), human(4, { type: 7 }));
  await run(40); assert.equal(remote.posts.length, 0);
});
test('channel assignment, role selection and exclusions are configurable', async () => {
  const { config, remote, run } = await fixture(); config.guilds[0].roles = [{ id: '50', name: 'Helper', botId: '22' }];
  await run(); remote.messages.push(human(2, { mentions: [], mention_roles: ['50'] })); await run(10);
  assert.deepEqual(remote.posts[0].allowed_mentions.users, ['22']);
  config.guilds[0].excludeChannelIds = ['30']; remote.messages.push(human(3)); await run(40); assert.equal(remote.posts.length, 1);
});
test('complete pagination preserves requests older than 100 recent messages', async () => {
  const { remote, run } = await fixture(); await run();
  remote.messages.push(human(2)); for (let id = 3; id < 210; id++) remote.messages.push(human(id, { author: { id: '21', bot: true } }));
  const state = await run(10); assert.equal(state.channels['10/30'].cursor, '209'); assert.equal(remote.posts.length, 1);
});
test('read failures and incomplete pagination retain cursor and emit failure', async () => {
  const { config, remote, run } = await fixture(); await run(); remote.failRead = true; let state = await run(10);
  assert.equal(state.channels['10/30'].cursor, '1'); assert.match(state.channels['10/30'].error.reason, /503/);
  remote.failRead = false; config.maxPages = 1;
  for (let id = 2; id < 104; id++) remote.messages.push(human(id)); state = await run(10);
  assert.equal(state.channels['10/30'].cursor, '1'); assert.equal(remote.posts.length, 0); assert.match(state.channels['10/30'].error.reason, /pagination limit/);
});
test('DRY sends nothing and leaves persisted state byte identical', async () => {
  const { config, remote, run } = await fixture(); await run(); remote.messages.push(human(2));
  const before = await readFile(config.stateFile, 'utf8'); await run(30, { dry: true });
  assert.equal(await readFile(config.stateFile, 'utf8'), before); assert.equal(remote.posts.length, 0); assert.equal(remote.events.filter(e => e.result === 'would_send').length, 2);
});
test('uncertain send is retained for reconciliation without duplicate retry', async () => {
  const { remote, run } = await fixture(); await run(); remote.messages.push(human(2)); remote.uncertain = true;
  const state = await run(10); assert.equal(Object.values(state.channels['10/30'].pending['2'].stages)[0].status, 'uncertain');
  remote.uncertain = false; await run(11); assert.equal(remote.posts.length, 1); assert.ok(remote.events.some(e => e.result === 'reconciliation_required'));
  assert.ok(!JSON.stringify(remote.events).includes('private transport content'));
});
test('rejected sends retry and never become successful receipts', async () => {
  const { remote, run } = await fixture(); await run(); remote.messages.push(human(2)); remote.failPost = true;
  let state = await run(10); assert.equal(Object.values(state.channels['10/30'].pending['2'].stages)[0].status, 'rejected');
  remote.failPost = false; state = await run(11); assert.equal(Object.values(state.channels['10/30'].pending['2'].stages)[0].status, 'confirmed');
});
test('overlap and corrupt state fail closed', async () => {
  const { config, run } = await fixture(); await writeFile(`${config.stateFile}.lock`, 'existing');
  await assert.rejects(run(), /EEXIST/);
  const other = await fixture(); await writeFile(other.config.stateFile, 'broken'); await assert.rejects(other.run(), /state unreadable/);
});
test('site consecutive failure and one recovery notice', async () => {
  const { config, remote, run } = await fixture(); config.sites = [{ url: 'https://example.org/', channelId: '32', failureThreshold: 2 }];
  remote.siteOk = false; await run(); assert.equal(remote.posts.length, 0); await run(1); assert.equal(remote.posts.length, 1); await run(2); assert.equal(remote.posts.length, 1);
  remote.siteOk = true; await run(3); assert.equal(remote.posts.length, 2); await run(4); assert.equal(remote.posts.length, 2);
});
test('configuration rejects ambiguous duplicates and unsafe site URLs', async () => {
  const { config } = await fixture(); config.guilds[0].channels.push({ id: '30' }); assert.throws(() => validateConfig(config), /duplicate/);
  config.guilds[0].channels.pop(); config.sites = [{ url: 'https://example.org/?token=private', channelId: '32' }]; assert.throws(() => validateConfig(config), /site URL/);
});

test('server-side send failure is uncertain and never retried automatically', async () => {
  const { remote, run } = await fixture(); await run(); remote.messages.push(human(2)); remote.failPost = 502;
  let state = await run(10); assert.equal(state.lastRun.result, 'degraded');
  assert.equal(Object.values(state.channels['10/30'].pending['2'].stages)[0].status, 'uncertain');
  remote.failPost = false; state = await run(11); assert.equal(remote.posts.length, 1); assert.equal(state.lastRun.result, 'degraded');
});
test('first baseline read failure persists error without creating a baseline', async () => {
  const { remote, run } = await fixture(); remote.failRead = true;
  let state = await run(); assert.equal(state.lastRun.result, 'degraded'); assert.equal(state.channels['10/30'], undefined); assert.match(state.errors['10/30'].reason, /503/);
  remote.failRead = false; state = await run(60); assert.equal(state.channels['10/30'].cursor, '1'); assert.equal(state.errors['10/30'], undefined); assert.equal(remote.posts.length, 0);
});
test('explicit bot mention in a human reply remains a request', async () => {
  const { remote, run } = await fixture(); await run(); remote.messages.push(human(2, { message_reference: { message_id: '1' } }));
  await run(10); assert.equal(remote.posts.length, 1);
});
test('ambiguous role assignment retains cursor and records failure', async () => {
  const { config, remote, run } = await fixture(); config.guilds[0].roles = [{ id: '50', botId: '22' }];
  await run(); remote.messages.push(human(2, { mention_roles: ['50'] })); const state = await run(10);
  assert.equal(state.channels['10/30'].cursor, '1'); assert.equal(state.lastRun.result, 'degraded'); assert.match(state.errors['10/30'].reason, /ambiguous/); assert.equal(remote.posts.length, 0);
});

test('first site observation remains silent at failure threshold one', async () => {
  const { config, remote, run } = await fixture(); config.sites = [{ url: 'https://example.org/', channelId: '32', failureThreshold: 1 }];
  remote.siteOk = false; let state = await run(); assert.equal(remote.posts.length, 0); assert.equal(state.lastRun.result, 'degraded');
  await run(1); assert.equal(remote.posts.length, 1);
});
test('role names match complete configured names only', async () => {
  const { config, remote, run } = await fixture(); config.guilds[0].channels[0].mode = 'mentions'; config.guilds[0].roles = [{ id: '50', name: 'Helper', botId: '22' }];
  await run(); remote.messages.push(human(2, { mentions: [], content: '@HelperExtra request' })); await run(10); assert.equal(remote.posts.length, 0);
  remote.messages.push(human(3, { mentions: [], content: '@Helper request' })); await run(11); assert.equal(remote.posts.length, 1); assert.deepEqual(remote.posts[0].allowed_mentions.users, ['22']);
});

test('deleted human reference does not block cursor or create an unaddressed request', async () => {
  const { remote, run } = await fixture(); await run();
  remote.messages.push(human(2, { mentions: [], message_reference: { message_id: '999' } }), human(3, { message_reference: { message_id: '998' } }));
  const state = await run(10); assert.equal(state.channels['10/30'].cursor, '3'); assert.equal(state.lastRun.result, 'complete');
  assert.equal(remote.posts.length, 1); assert.ok(remote.posts[0].content.endsWith('/3'));
});
test('role names require preceding boundary and scan all occurrences', async () => {
  const { config, remote, run } = await fixture(); config.guilds[0].channels[0].mode = 'mentions'; config.guilds[0].roles = [{ id: '50', name: 'Helper', botId: '22' }];
  await run(); remote.messages.push(human(2, { mentions: [], content: 'mail@Helper request' })); await run(10); assert.equal(remote.posts.length, 0);
  remote.messages.push(human(3, { mentions: [], content: '@HelperExtra then @Helper request' })); await run(11); assert.equal(remote.posts.length, 1); assert.deepEqual(remote.posts[0].allowed_mentions.users, ['22']);
});
test('confirmed referenced replies retain progress timestamps across scans', async () => {
  const { remote, run } = await fixture(); await run(); remote.messages.push(human(2)); await run(1);
  remote.messages.push(human(3, { timestamp: new Date(epoch + 2 * 60000).toISOString(), author: { id: '20', bot: true }, message_reference: { message_id: '2' } }));
  const state = await run(3); assert.equal(state.replies['20'].at, epoch + 2 * 60000); assert.equal((await run(4)).replies['20'].at, epoch + 2 * 60000);
});
test('failed channel batch cannot publish provisional reply progress', async () => {
  const { remote, run } = await fixture(); await run(); remote.messages.push(human(2)); await run(1);
  remote.messages.push(human(3, { timestamp: new Date(epoch + 2 * 60000).toISOString(), author: { id: '20', bot: true }, message_reference: { message_id: '2' } }), human(4, { timestamp: 'invalid' }));
  const state = await run(3); assert.equal(state.replies?.['20'], undefined); assert.equal(state.channels['10/30'].cursor, '2'); assert.ok(state.channels['10/30'].pending['2']);
});

test('instance message templates replace known placeholders and keep unknown ones', async () => {
  const { fill } = await import('./response-watch.mjs');
  assert.equal(fill('<@{bot}> 답해 주세요: {link}', { bot: '1', link: 'https://x/y' }), '<@1> 답해 주세요: https://x/y');
  assert.equal(fill('{site} {unknown}', { site: 'a' }), 'a {unknown}');
});
test('one referenced reply closes the same author\'s earlier pending posts but not later ones', async () => {
  const { remote, run } = await fixture(); await run();
  const plain = (id, extra = {}) => human(id, { mentions: [], ...extra }), bot = (id, to, extra = {}) => human(id, { author: { id: '20', bot: true }, message_reference: { message_id: String(to) }, ...extra });
  remote.messages.push(plain(2), plain(3), plain(4), bot(5, 3));
  let state = await run(1); assert.deepEqual(Object.keys(state.channels['10/30'].pending), ['4']);
  remote.messages.push(plain(6), plain(7), plain(8), bot(9, 7)); state = await run(2); assert.deepEqual(Object.keys(state.channels['10/30'].pending), ['8']);
  await run(9); assert.equal(remote.posts.length, 0);
  await run(60); assert.equal(remote.posts.length, 2); assert.ok(remote.posts.every(post => post.content.endsWith('/8')));
});
test('batched reply never closes another author\'s, another bot\'s or unreferenced requests', async () => {
  const { remote, run } = await fixture(); await run();
  const plain = (id, extra = {}) => human(id, { mentions: [], ...extra });
  remote.messages.push(plain(2, { author: { id: '42' } }), plain(3, { mentions: [{ id: '21', bot: true }] }), plain(4), plain(5),
    human(6, { author: { id: '20', bot: true } }), human(7, { author: { id: '21', bot: true }, message_reference: { message_id: '5' } }), human(8, { author: { id: '20', bot: true }, message_reference: { message_id: '5' } }));
  const state = await run(1); assert.deepEqual(Object.keys(state.channels['10/30'].pending), ['2']);
  assert.equal(state.channels['10/30'].pending['2'].author.length, 16); assert.ok(!JSON.stringify(state).includes('"42"'));
});
test('batched reply closes only the author\'s posts within burstMinutes of the referenced post', async () => {
  const { remote, run } = await fixture(); await run();
  const at = minutes => new Date(epoch + minutes * 60000).toISOString(), plain = (id, minutes) => human(id, { mentions: [], timestamp: at(minutes) });
  remote.messages.push(plain(2, 0), plain(3, 15), plain(4, 20), human(5, { author: { id: '20', bot: true }, message_reference: { message_id: '4' }, timestamp: at(21) }));
  const state = await run(21); assert.deepEqual(Object.keys(state.channels['10/30'].pending), ['2']);
});
test('fallback posts close on any bot\'s reply or when the author names a recipient; mentioned requests still need the expected bot', async () => {
  const { remote, run } = await fixture(); await run();
  const at = minutes => new Date(epoch + minutes * 60000).toISOString(), plain = (id, minutes, extra = {}) => human(id, { mentions: [], timestamp: at(minutes), ...extra });
  remote.messages.push(plain(2, 0), plain(3, 1), human(4, { author: { id: '21', bot: true }, message_reference: { message_id: '3' }, timestamp: at(2) }));
  remote.messages.push(plain(5, 3), plain(6, 3, { mentions: [{ id: '21', bot: true }] }));
  remote.messages.push(plain(7, 30), plain(8, 31, { mentions: [{ id: '20', bot: true }] }), human(9, { author: { id: '21', bot: true }, message_reference: { message_id: '8' }, timestamp: at(32) }));
  const state = await run(32); assert.deepEqual(Object.keys(state.channels['10/30'].pending), ['8']);
  assert.equal(state.channels['10/30'].pending['8'].via, undefined);
});
test('a person mention, a mention outside burstMinutes and another bot\'s reply to an untracked post leave fallback posts pending', async () => {
  const { remote, run } = await fixture(); await run();
  const at = minutes => new Date(epoch + minutes * 60000).toISOString(), plain = (id, minutes, extra = {}) => human(id, { mentions: [], timestamp: at(minutes), ...extra });
  remote.messages.push(plain(2, 0), plain(3, 1, { mentions: [{ id: '99' }] }));
  remote.messages.push(plain(4, 20), plain(5, 40, { mentions: [{ id: '21', bot: true }] }));
  remote.messages.push(plain(6, 50), plain(7, 51, { message_reference: { message_id: '1' } }), human(8, { author: { id: '21', bot: true }, message_reference: { message_id: '7' }, referenced_message: { id: '7', author: { id: '40' }, timestamp: at(51) }, timestamp: at(52) }));
  let state = await run(52); assert.deepEqual(Object.keys(state.channels['10/30'].pending), ['2', '4', '6']);
  remote.messages.push(human(9, { author: { id: '21', bot: true }, message_reference: { message_id: '6' }, timestamp: at(53) }));
  state = await run(53); assert.deepEqual(Object.keys(state.channels['10/30'].pending), ['2', '4']);
});
test('reply to an unwatched post closes its author\'s earlier requests; requests stored before author tracking need their own reply', async () => {
  const { config, remote, run } = await fixture(); await run();
  remote.messages.push(human(2, { mentions: [] }), human(3, { mentions: [], message_reference: { message_id: '1' } }));
  remote.messages.push(human(4, { author: { id: '20', bot: true }, message_reference: { message_id: '3' }, referenced_message: { id: '3', author: { id: '40' } } }));
  let state = await run(1); assert.deepEqual(state.channels['10/30'].pending, {});
  remote.messages.push(human(5, { mentions: [] }), human(6, { mentions: [] })); state = await run(2);
  delete state.channels['10/30'].pending['5'].author; await writeFile(config.stateFile, JSON.stringify(state));
  remote.messages.push(human(7, { author: { id: '20', bot: true }, message_reference: { message_id: '6' } }));
  state = await run(3); assert.deepEqual(Object.keys(state.channels['10/30'].pending), ['5']);
});
