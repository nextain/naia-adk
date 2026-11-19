import test from 'node:test';
import assert from 'node:assert/strict';
import { postDiscordMessage, postDiscordDirectMessage, deliverJobResult } from '../helper/discord-delivery.mjs';
import { DiscordStatusProjection } from '../helper/discord-projection.mjs';
import { createDiscordApi, postDiscord } from '../../../../scripts/response-watch.mjs';

const channelId = '123456789012345678', userId = '223456789012345678';
const token = 'token-value-long-enough';
const reply = (id = channelId) => ({ ok: true, status: 200, json: async () => ({ id: '323456789012345678', channel_id: id }) });

test('Discord channel and watcher sends reject before POST and allow factual text', async () => {
  for (const sender of [
    (content, fetchImpl) => postDiscordMessage({ token, channelId, content, nonce: 'nonce', fetchImpl }),
    (content, fetchImpl) => postDiscord(createDiscordApi(fetchImpl, token), { channelId, content, mentions: [], nonce: 'nonce' }),
  ]) {
    let posts = 0;
    const fetchImpl = async () => { posts++; return reply(); };
    await assert.rejects(sender('철저히 하겠습니다.', fetchImpl));
    assert.equal(posts, 0);
    await sender('확인했습니다.', fetchImpl);
    assert.equal(posts, 1);
  }
});

test('DM validates before opening a channel and then sends allowed text once', async () => {
  let calls = [];
  const fetchImpl = async (url, init) => { calls.push({url, init}); return url.endsWith('/users/@me/channels') ? reply(channelId) : reply(); };
  await assert.rejects(postDiscordDirectMessage({ token, userId, content: '철저히 하겠습니다.', nonce: 'n', fetchImpl }));
  assert.equal(calls.length, 0);
  // Discord's create-DM endpoint returns a channel ID, then one message POST.
  const dmFetch = async (url, init) => { calls.push({url, init}); return url.endsWith('/users/@me/channels') ? { ok: true, json: async () => ({ id: channelId }) } : reply(); };
  await postDiscordDirectMessage({ token, userId, content: '확인했습니다.', nonce: 'n', fetchImpl: dmFetch });
  assert.equal(calls.filter(c => c.url.endsWith('/messages')).length, 1);
});

test('automatic delivery checks the final result before reserving or sending', async () => {
  let posts = 0, reservations = 0;
  const store = { reserveDelivery: () => { reservations++; return {status: 'started', deliveryKey:'d', nonce:'n'}; }, finishDelivery: () => {} };
  const fetchImpl = async () => { posts++; return reply(); };
  await assert.rejects(deliverJobResult({ store, token, channelId, content: '철저히 하겠습니다.', fetchImpl }));
  assert.equal(posts, 0); assert.equal(reservations, 0);
  await deliverJobResult({ store, token, channelId, content: '확인했습니다.', fetchImpl });
  assert.equal(posts, 1);
});

test('status projection checks the final text before PATCH', async () => {
  let patches = 0, summary = '철저히 하겠습니다.';
  const store = { status: () => ({service:{state:'running',reasonCode:'ok'}}), listJobsForScope: () => [{ jobId:'job', lifecycle:'running', activityHealth:{value:'ok'}, safeSummary:summary }], loadDiscordProjection: () => ({channelId, messageId:'323456789012345678'}) };
  const projection = new DiscordStatusProjection({ store, token, fetchImpl: async (_url, init) => { if (init.method === 'PATCH') patches++; return reply(); } });
  await assert.rejects(projection.publishScope({scopeKey:'s',channelId}));
  assert.equal(patches, 0);
  summary = '확인했습니다.';
  assert.equal((await projection.publishScope({scopeKey:'s',channelId})).state, 'updated');
  assert.equal(patches, 1);
});
