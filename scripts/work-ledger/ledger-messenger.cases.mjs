import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  utimes,
  symlink,
  mkdir,
  readdir,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { main, readLedger, ledgerPath, changeLedger, wakeHeader } from "./ledger.mjs";
import { watch } from "./ledger-watch.mjs";
import { startWorkerRun } from "./worker-run.mjs";
import { dueWake } from "./due-timer.mjs";
import { tick as drive } from "./drive.mjs";
import { registerWorker, updateWorkerRuntime, watchWorkers } from "../work-watch.mjs";
import { createAdapter } from "./messenger.mjs";
import {now,headerRow,createdRoots,config,setup,edit} from './ledger-test-fixture.mjs';

test("edited messages are re-evaluated as new while suppressing duplicate wakes for unchanged judgment", async () => {
  const discordAdapter = createAdapter(
    { type: "discord", token_env: "T" },
    {
      env: { T: "tok" },
      fetchImpl: async () => ({
        ok: true,
        json: async () => [
          {
            id: "edit-1",
            author: { id: "human" },
            timestamp: new Date(now - 25 * 3600000).toISOString(),
            edited_timestamp: new Date(now - 60000).toISOString(),
            content: "<@bot> 수정해서 추가 지시함",
            mentions: [{ id: "bot" }],
          },
        ],
      }),
    },
  );
  const fetched = await discordAdapter.messages("channel", now - 24 * 3600000);
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].id, "edit-1");

  const root = await setup();
  const conf = {
    roles: [
      {
        ...config.roles[0],
        channels: ["channel"],
        answered_by_any_role_post_after: true,
      },
    ],
  };
  let phase = 1;
  const adapter = {
    async messages() {
      if (phase === 1) {
        return [
          {
            id: "same-judgment",
            author_id: "human",
            body: "<@bot> 처음부터 호출",
            mentions: ["bot"],
            created_at: new Date(now - 600000).toISOString(),
          },
          {
            id: "later-mentioned",
            author_id: "human",
            body: "그냥 혼잣말",
            created_at: new Date(now - 600000).toISOString(),
          },
        ];
      }
      return [
        {
          id: "same-judgment",
          author_id: "human",
          body: "<@bot> 오타 고침",
          mentions: ["bot"],
          created_at: new Date(now - 600000).toISOString(),
          edited_timestamp: new Date(now - 30000).toISOString(),
        },
        {
          id: "later-mentioned",
          author_id: "human",
          body: "<@bot> 수정으로 호출 추가",
          mentions: ["bot"],
          created_at: new Date(now - 600000).toISOString(),
          edited_timestamp: new Date(now - 30000).toISOString(),
        },
        {
          id: "replied-then-edited",
          author_id: "human",
          body: "<@bot> 답변 뒤 추가 지시",
          mentions: ["bot"],
          created_at: new Date(now - 600000).toISOString(),
          edited_timestamp: new Date(now - 20000).toISOString(),
        },
        {
          id: "bot-reply",
          author_id: "bot",
          reply_to_id: "replied-then-edited",
          created_at: new Date(now - 300000).toISOString(),
        },
        {
          id: "source",
          author_id: "human",
          body: "<@bot> 장부 등록 뒤 수정 지시",
          mentions: ["bot"],
          created_at: new Date(now - 600000).toISOString(),
          edited_timestamp: new Date(now - 10000).toISOString(),
        },
        {
          id: "old-edited",
          author_id: "human",
          body: "<@bot> 25시간 전 글 수정",
          mentions: ["bot"],
          created_at: new Date(now - 25 * 3600000).toISOString(),
          edited_timestamp: new Date(now - 15000).toISOString(),
        },
      ];
    },
  };
  const first = await watch({ root, config: conf, adapter, now: now - 300000 });
  assert.deepEqual(first.wakes.map((w) => w.id), ["human-same-judgment"]);

  phase = 2;
  const second = await watch({ root, config: conf, adapter, now });
  assert.deepEqual(
    second.wakes.map((w) => w.id),
    [
      "human-later-mentioned",
      "human-replied-then-edited",
      "human-source",
      "human-old-edited",
    ],
  );
});

test("active threads and message-attached threads are read with count cap and isolated errors", async () => {
  const root = await setup();
  const conf = {
    provider: { type: "discord", token_env: "TEST_TOKEN", max_threads: 3 },
    roles: [{ ...config.roles[0], channels: ["ch-main"] }],
  };
  const recent = new Date(now - 1000).toISOString();
  const fetchedUrls = [];
  const adapter = createAdapter(conf.provider, {
    env: { TEST_TOKEN: "fake" },
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      fetchedUrls.push(pathname);
      if (pathname === "/api/v10/channels/ch-main/messages") {
        return {
          ok: true,
          json: async () => [
            {
              id: "parent-msg",
              author: { id: "bot" },
              timestamp: recent,
              content: "쓰레드 시작 글",
              thread: { id: "thread-from-msg" },
            },
          ],
        };
      }
      if (pathname === "/api/v10/guilds/ch-main/threads/active") {
        return {
          ok: true,
          json: async () => ({
            threads: [
              { id: "thread-from-msg", parent_id: "ch-main" },
              { id: "thread-active-1", parent_id: "ch-main" },
              { id: "thread-broken", parent_id: "ch-main" },
              { id: "thread-over-cap", parent_id: "ch-main" },
            ],
          }),
        };
      }
      if (pathname === "/api/v10/channels/thread-from-msg/messages") {
        return {
          ok: true,
          json: async () => [
            {
              id: "msg-in-thread-1",
              author: { id: "human" },
              timestamp: recent,
              content: "부모 봇 글에 대한 쓰레드 안 답글",
              message_reference: { message_id: "parent-msg" },
            },
          ],
        };
      }
      if (pathname === "/api/v10/channels/thread-active-1/messages") {
        return {
          ok: true,
          json: async () => [
            {
              id: "msg-in-thread-2",
              author: { id: "human" },
              timestamp: recent,
              content: "<@bot> 활성 쓰레드 지시",
              mentions: [{ id: "bot" }],
            },
          ],
        };
      }
      if (pathname === "/api/v10/channels/thread-broken/messages") {
        return {
          ok: false,
          status: 403,
          text: async () => "thread access denied",
        };
      }
      if (pathname === "/api/v10/channels/thread-over-cap/messages") {
        return {
          ok: true,
          json: async () => [
            {
              id: "msg-over-cap",
              author: { id: "human" },
              timestamp: recent,
              content: "<@bot> 상한 초과 쓰레드",
              mentions: [{ id: "bot" }],
            },
          ],
        };
      }
      return { ok: false, status: 404, text: async () => "not found" };
    },
  });
  const result = await watch({ root, config: conf, adapter, now });
  assert.equal(
    fetchedUrls.includes("/api/v10/channels/thread-over-cap/messages"),
    false,
  );
  assert.deepEqual(result.errors, ["messenger:secretary:thread-broken"]);
  assert.deepEqual(
    result.wakes.map((w) => w.id),
    [
      "messenger-error-thread-broken",
      "human-msg-in-thread-1",
      "human-msg-in-thread-2",
    ],
  );
});

test("relayed human messages, webhook messages, and Discord role mentions wake the assigned role", async () => {
  const recent = new Date(now - 1000).toISOString();
  const discordAdapter = createAdapter(
    { type: "discord", token_env: "T" },
    {
      env: { T: "tok" },
      fetchImpl: async (url) => {
        if (new URL(url).pathname.endsWith("/threads/active"))
          return { ok: true, json: async () => ({ threads: [] }) };
        return {
          ok: true,
          json: async () => [
            {
              id: "wh-role-msg",
              author: { id: "webhook-user" },
              webhook_id: "wh-100",
              timestamp: recent,
              content: "<@&role-sec> 웹훅 역할 호출",
              mention_roles: ["role-sec"],
            },
          ],
        };
      },
    },
  );
  const normalized = await discordAdapter.messages("ch-main", now - 60000);
  assert.equal(normalized[0].webhook_id, "wh-100");
  assert.deepEqual(normalized[0].mention_roles, ["role-sec"]);

  const root = await setup();
  const conf = {
    roles: [
      {
        role: "secretary",
        channels: ["ch-main"],
        human_ids: ["human-1"],
        relay_ids: ["relay-bot"],
        user_ids: ["bot-sec"],
        role_ids: ["role-sec"],
      },
      {
        role: "reviewer",
        channels: ["ch-main"],
        human_ids: ["human-1"],
        user_ids: ["bot-rev"],
        role_ids: ["role-rev"],
      },
    ],
  };
  const adapter = {
    async messages() {
      return [
        {
          id: "relay-1",
          author_id: "relay-bot",
          body: "[human-1] <@bot-sec> 대신 전달된 지시",
          mentions: ["bot-sec"],
          created_at: recent,
        },
        {
          id: "webhook-1",
          author_id: "webhook-author",
          webhook_id: "wh-100",
          body: "<@bot-sec> 웹훅 전달 지시",
          mentions: ["bot-sec"],
          created_at: recent,
        },
        {
          id: "role-tag-body",
          author_id: "human-1",
          body: "<@&role-sec> 역할 태그 호출",
          created_at: recent,
        },
        {
          id: "role-tag-array",
          author_id: "human-1",
          body: "배열 역할 호출",
          mention_roles: ["role-sec"],
          created_at: recent,
        },
        {
          id: "other-role-tag",
          author_id: "human-1",
          body: "<@&role-rev> 리뷰어 역할만 호출",
          mention_roles: ["role-rev"],
          created_at: recent,
        },
        {
          id: "unconfigured-bot",
          author_id: "random-bot",
          body: "<@bot-sec> 미등록 봇 자동 메시지",
          mentions: ["bot-sec"],
          created_at: recent,
        },
      ];
    },
  };
  const res = await watch({ root, config: conf, adapter, now });
  assert.deepEqual(
    res.wakes.filter((w) => w.role === "secretary").map((w) => w.id),
    [
      "human-relay-1",
      "human-webhook-1",
      "human-role-tag-body",
      "human-role-tag-array",
    ],
  );
  assert.deepEqual(
    res.wakes.filter((w) => w.role === "reviewer").map((w) => w.id),
    ["human-other-role-tag"],
  );
});

