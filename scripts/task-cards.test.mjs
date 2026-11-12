import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, normalizeConfig, runCheck, eventMessage, checkMessage, cardLink, slugify, inboxSender, loadRoleCards } from './task-cards.mjs';

const NOW = '2026-11-12T03:00:00Z';

function repo(config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-cards-'));
  if (config) {
    fs.mkdirSync(path.join(root, 'config'));
    fs.writeFileSync(path.join(root, 'config', 'task-cards.json'), JSON.stringify(config));
  }
  return root;
}

const run = (root, args, deps = {}, now = NOW) => main(['--root', root, '--now', now, ...args], deps);

async function newCard(root, extra = [], deps) {
  const { out } = await run(root, ['new', '--role', 'ops', '--title', 'Ship the card alerts', '--source', 'msg 1000000000000000001', '--next', 'write tests', ...extra], deps);
  return out.split('\n')[0].split('/')[1];
}

// Fake messenger: channel list + message post, records every post body.
function fakeMessenger({ status = 200 } = {}) {
  const posts = [];
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith('/channels') && !init.method) return { ok: true, status: 200, json: async () => [{ id: 'c1', name: 'cards' }, { id: 'c2', name: 'owner' }] };
    posts.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return { ok: status < 400, status, headers: { get: () => null }, json: async () => ({ id: `m${posts.length}` }) };
  };
  return { posts, fetchImpl, env: { NAIA_MESSENGER_URL: 'http://127.0.0.1:3142', NAIA_MESSENGER_TOKEN: 'secret' } };
}

const messengerConfig = extra => ({ notify: { kind: 'messenger', channel: 'cards', routes: { check: { channel: 'owner' } } }, alerts: { owners: { ops: 'ops' }, ...extra } });

test('new, move, defer, done keep the card and append the ledger', async () => {
  const root = repo();
  const id = await newCard(root, ['--due', '2026-11-16T09:00']);
  assert.match(id, /^20261112-Ship-the-card-alerts$/);
  await run(root, ['move', id, '--status', 'waiting', '--next', 'review']);
  await run(root, ['defer', id, '--reason', 'urgent work first', '--revisit', '2026-11-14']);
  const { out } = await run(root, ['done', id, '--result', 'https://example.test/pr/1']);
  assert.match(out, /^done ops\//);
  const [card] = loadRoleCards(root, normalizeConfig({}), 'ops');
  assert.equal(card.status, 'done');
  assert.equal(card.defer_count, 1);
  const ledger = fs.readFileSync(path.join(root, 'docs/team/cards/ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).cmd);
  assert.deepEqual(ledger, ['new', 'move', 'defer', 'done']);
});

test('defer without reason or revisit changes nothing', async () => {
  const root = repo();
  const id = await newCard(root);
  await assert.rejects(run(root, ['defer', id, '--reason', 'x']), /--reason and --revisit/);
  assert.equal(loadRoleCards(root, normalizeConfig({}), 'ops')[0].status, 'doing');
});

test('check finds overdue, stale, revisit and repeat; calendar only when required', async () => {
  const root = repo();
  const id = await newCard(root, ['--due', '2026-11-12']);
  let problems = runCheck(root, normalizeConfig({}), ['ops'], { now: Date.parse('2026-11-15T00:00:00Z') });
  assert.deepEqual(problems.map(p => p.kind), ['overdue', 'stale', 'repeat']);
  problems = runCheck(root, normalizeConfig({ requireCalendar: true }), ['ops'], { now: Date.parse(NOW) });
  assert.deepEqual(problems.map(p => p.kind), ['no-calendar']);
  await run(root, ['defer', id, '--reason', 'r', '--revisit', '2026-11-13']);
  problems = runCheck(root, normalizeConfig({}), ['ops'], { now: Date.parse('2026-11-14T00:00:00Z') });
  assert.ok(problems.some(p => p.kind === 'revisit'));
});

test('vanished card is reported from the ledger', async () => {
  const root = repo();
  const id = await newCard(root);
  fs.rmSync(path.join(root, 'docs/team/cards/ops', `${id}.md`));
  assert.deepEqual(runCheck(root, normalizeConfig({}), ['ops'], { now: Date.parse(NOW) }).map(p => p.kind), ['vanished']);
});

test('leader request without card is found only by message id, not channel id', async () => {
  const root = repo();
  const config = normalizeConfig({ inbox: { dir: 'inbox', leaderIds: ['42'] } });
  fs.mkdirSync(path.join(root, 'inbox/ops'), { recursive: true });
  fs.writeFileSync(path.join(root, 'inbox/ops/a.md'), '- From: lead (42)\n- Channel: 1000000000000000002\n- Message: 1000000000000000003\n\ndo it');
  fs.writeFileSync(path.join(root, 'inbox/ops/b.md'), '- From: other (7)\n- Message: 1000000000000000004\n');
  await newCard(root, ['--source', 'https://chat.example/channels/1000000000000000002']);
  const now = Date.now();
  assert.deepEqual(runCheck(root, config, ['ops'], { now }).filter(p => p.kind === 'unlinked-inbox').map(p => p.id), ['a']);
  await run(root, ['ack', '--role', 'ops', '--ref', '1000000000000000003', '--reason', 'answered in chat']);
  assert.deepEqual(runCheck(root, config, ['ops'], { now }).filter(p => p.kind === 'unlinked-inbox'), []);
  assert.equal(inboxSender('- 보낸 사람: 대표 (42)'), '42');
});

test('card events post to the messenger with an @owner mention and card link', async () => {
  const root = repo(messengerConfig({ linkBase: 'https://docs.example/repo' }));
  const fake = fakeMessenger();
  const id = await newCard(root, ['--due', '2026-11-16'], fake);
  await run(root, ['move', id, '--next', 'quiet'], fake);
  await run(root, ['done', id, '--result', 'https://example.test/pr/2'], fake);
  assert.equal(fake.posts.length, 2, 'move is not in the default events');
  assert.match(fake.posts[0].url, /\/api\/portal\/messenger\/channels\/c1\/messages$/);
  assert.equal(fake.posts[0].headers['X-AX-Agent-Token'], 'secret');
  assert.match(fake.posts[0].body.body, /^\[task card\] @ops ops\/20261112-Ship-the-card-alerts new: Ship the card alerts \| due 2026-11-16 .*https:\/\/docs\.example\/repo\/docs\/team\/cards\/ops\/20261112-Ship-the-card-alerts\.md$/);
  assert.match(fake.posts[1].body.body, /done: Ship the card alerts \| result: https:\/\/example\.test\/pr\/2$/);
});

test('check --notify goes to the check route; failure exits 3 but still prints', async () => {
  const root = repo(messengerConfig());
  const fake = fakeMessenger();
  await newCard(root, ['--due', '2026-11-12'], fake);
  const later = '2026-11-15T00:00:00Z';
  const { out, exitCode } = await run(root, ['check', '--notify'], fake, later);
  assert.equal(exitCode, 0);
  assert.match(out, /^\[overdue\]/);
  const post = fake.posts.at(-1);
  assert.match(post.url, /channels\/c2\/messages$/);
  assert.match(post.body.body, /^\[task card check\] @ops 3 problem\(s\)\n- \[overdue\]/);
  const broken = fakeMessenger({ status: 400 });
  const res = await run(root, ['check', '--notify'], broken, later);
  assert.equal(res.exitCode, 3);
  assert.match(res.out, /\[overdue\]/);
});

test('alert failure on a card event warns and keeps the card', async () => {
  const root = repo(messengerConfig());
  const { out } = await run(root, ['new', '--role', 'ops', '--title', 't', '--source', 's', '--next', 'n'], { env: {} });
  assert.match(out, /^created ops\/20261112-t\n\[warn\] alert not sent \(not delivered\): messenger URL or token missing$/);
  assert.equal(loadRoleCards(root, normalizeConfig({}), 'ops').length, 1);
});

test('Discord alerts use the bot token and allow only owner mentions', async () => {
  const root = repo({ alerts: { channelId: '123', tokenEnv: 'BOT', owners: { ops: '999' } } });
  const posts = [];
  const fetchImpl = async (url, init) => { posts.push({ url, init }); return { ok: true, status: 200, json: async () => ({ id: '1' }) }; };
  await newCard(root, [], { env: { BOT: 'tok' }, fetchImpl });
  assert.equal(posts[0].url, 'https://discord.com/api/v10/channels/123/messages');
  assert.equal(posts[0].init.headers.Authorization, 'Bot tok');
  const body = JSON.parse(posts[0].init.body);
  assert.match(body.content, /^\[task card\] <@999> ops\//);
  assert.deepEqual(body.allowed_mentions, { parse: [], users: ['999'] });
});

test('config validation', () => {
  assert.throws(() => normalizeConfig({ cardsDir: '../x' }), /cardsDir/);
  assert.throws(() => normalizeConfig({ alerts: {} }), /alerts.channelId/);
  assert.throws(() => normalizeConfig({ alerts: { channelId: '1', events: ['nope'] } }), /alerts.events/);
  assert.throws(() => normalizeConfig({ notify: { kind: 'messenger' }, alerts: {} }), /notify.channel required/);
  assert.throws(() => normalizeConfig({ notify: { kind: 'messenger', channel: 'c' }, alerts: { owners: { ops: 'bad name' } } }), /alerts.owners/);
  assert.throws(() => normalizeConfig({ alerts: { channelId: '1', linkBase: 'https://x/?q=1' } }), /linkBase/);
});

test('messages and helpers', () => {
  const config = normalizeConfig({});
  assert.equal(cardLink(config, 'ops', 'a b'), 'docs/team/cards/ops/a b.md');
  assert.equal(slugify('  업무 카드: 알림!  '), '업무-카드-알림');
  assert.equal(eventMessage(config, 'defer', 'ops', { id: 'x', defer_count: 2, defer_reason: 'a\nb', revisit: '2026-11-20' }), '[task card] ops/x deferred (2x): a b | revisit 2026-11-20 | docs/team/cards/ops/x.md');
  const many = Array.from({ length: 20 }, (_, i) => ({ kind: 'stale', role: 'r', id: `c${i}`, reason: 'x' }));
  const message = checkMessage(config, many).split('\n');
  assert.equal(message.length, 17);
  assert.equal(message.at(-1), '- … 5 more');
});

test('tick is quiet inside the interval and never throws', async () => {
  const root = repo();
  await newCard(root);
  const first = await run(root, ['tick', '--role', 'ops', '--session', 's1']);
  assert.match(first.out, /^\[task cards hourly check\]/);
  assert.equal((await run(root, ['tick', '--role', 'ops', '--session', 's1'])).out, '');
  assert.deepEqual(await run(root, ['--config', 'missing.json', 'tick', '--role', 'ops', '--session', 's2']), { out: '', exitCode: 0 });
});
