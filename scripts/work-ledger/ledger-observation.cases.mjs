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

test("word-bounded everyone/here, mentionless replies to other roles, and unlisted bot mentions follow role priority", async () => {
  const root = await setup();
  const created_at = new Date(now - 1000).toISOString();
  const conf = {
    roles: [
      {
        role: "secretary",
        channels: ["ch-main"],
        direct_channels: ["ch-dm"],
        human_ids: ["human-1"],
        user_ids: ["bot-sec"],
      },
      {
        role: "reviewer",
        channels: ["ch-main"],
        human_ids: ["human-1"],
        user_ids: ["bot-rev"],
      },
    ],
  };
  const adapter = {
    async messages(ch) {
      if (ch === "ch-dm") {
        return [
          {
            id: "dm-unlisted-bot",
            author_id: "human-1",
            body: "<@unlisted-bot> 1:1 채널에서 다른 봇 언급",
            mentions: ["unlisted-bot"],
            created_at,
          },
        ];
      }
      return [
        {
          id: "email-here",
          author_id: "human-1",
          body: "문의는 help@here.com 으로 보내주세요",
          created_at,
        },
        {
          id: "email-everyone",
          author_id: "human-1",
          body: "메일 주소는 team@everyone.org 입니다",
          created_at,
        },
        {
          id: "reply-other-no-mention",
          author_id: "human-1",
          body: "이 부분 다시 봐주세요",
          reply_to_id: "rev-msg",
          reply_to_author_id: "bot-rev",
          mentions: [],
          created_at,
        },
        {
          id: "unlisted-bot-only",
          author_id: "human-1",
          body: "<@unlisted-bot> 이 작업 확인해줘",
          mentions: ["unlisted-bot"],
          created_at,
        },
        {
          id: "unlisted-bot-with-here",
          author_id: "human-1",
          body: "@here <@unlisted-bot> 같이 확인 부탁",
          mentions: ["unlisted-bot"],
          created_at,
        },
        {
          id: "reply-other-with-here",
          author_id: "human-1",
          body: "@here 이 부분 모두 확인 부탁",
          reply_to_id: "rev-msg",
          reply_to_author_id: "bot-rev",
          mentions: [],
          created_at,
        },
      ];
    },
  };
  const res = await watch({ root, config: conf, adapter, now });
  assert.deepEqual(
    res.wakes.filter((w) => w.role === "secretary").map((w) => w.id),
    [
      "human-unlisted-bot-with-here",
      "human-dm-unlisted-bot",
    ],
  );
  assert.deepEqual(
    res.wakes.filter((w) => w.role === "reviewer").map((w) => w.id),
    [
      "human-reply-other-no-mention",
      "human-unlisted-bot-with-here",
      "human-reply-other-with-here",
    ],
  );
});

test("F1: pagination continues past old created timestamps to catch recently edited messages on later pages", async () => {
  let n = 0;
  const old = new Date(now - 25 * 3600000).toISOString();
  const older = new Date(now - 26 * 3600000).toISOString();
  const pager = createAdapter(
    { type: "discord", token_env: "FAKE" },
    {
      env: { FAKE: "dummy" },
      fetchImpl: async (url) => {
        if (String(url).includes("/threads/active"))
          return { ok: true, json: async () => ({ threads: [] }) };
        return {
          ok: true,
          json: async () =>
            ++n === 1
              ? Array.from({ length: 100 }, (_, i) => ({
                  id: `old${i}`,
                  author: { id: "human" },
                  timestamp: old,
                  content: "",
                }))
              : [
                  {
                    id: "edited",
                    author: { id: "human" },
                    timestamp: older,
                    edited_timestamp: new Date(now - 1000).toISOString(),
                    content: "수정된 요청",
                    mentions: [{ id: "bot" }],
                  },
                ],
        };
      },
    },
  );
  const msgs = await pager.messages("main", now - 86400000);
  assert.equal(n, 2);
  assert.deepEqual(
    msgs.map((m) => m.id),
    ["edited"],
  );

  const root = await setup();
  n = 0;
  const res = await watch({
    root,
    config: { roles: [{ ...config.roles[0], channels: ["main"] }] },
    adapter: pager,
    now,
  });
  assert.deepEqual(
    res.wakes.map((w) => w.id),
    ["human-edited"],
  );
});

test("F2: active threads use guild endpoint and surface 404 or 403 as error wakes", async () => {
  for (const status of [404, 403]) {
    const root = await setup();
    const calls = [];
    const adapter = createAdapter(
      { type: "discord", token_env: "FAKE", guild_id: "guild-1" },
      {
        env: { FAKE: "dummy" },
        fetchImpl: async (url) => {
          calls.push(String(url));
          if (String(url).includes("/threads/active"))
            return {
              ok: false,
              status,
              text: async () => `active threads error ${status}`,
            };
          return { ok: true, json: async () => [] };
        },
      },
    );
    const res = await watch({
      root,
      config: { roles: [{ ...config.roles[0], channels: ["main"] }] },
      adapter,
      now,
    });
    assert.ok(
      calls.some((u) => u.includes("/api/v10/guilds/guild-1/threads/active")),
    );
    assert.equal(
      calls.some((u) => u.includes("/api/v10/channels/main/threads/active")),
      false,
    );
    assert.deepEqual(res.errors, ["messenger:secretary:main:threads"]);
    assert.deepEqual(
      res.wakes.map((w) => ({ id: w.id, reason: w.reason })),
      [{ id: "messenger-error-main-threads", reason: "감시 실패" }],
    );
  }

  const rootOk = await setup();
  const okCalls = [];
  const recent = new Date(now - 1000).toISOString();
  const okAdapter = createAdapter(
    { type: "discord", token_env: "FAKE" },
    {
      env: { FAKE: "dummy" },
      fetchImpl: async (url) => {
        const pathname = new URL(url).pathname;
        okCalls.push(pathname);
        if (pathname === "/api/v10/channels/main")
          return {
            ok: true,
            json: async () => ({ id: "main", guild_id: "guild-resolved" }),
          };
        if (pathname === "/api/v10/guilds/guild-resolved/threads/active")
          return {
            ok: true,
            json: async () => ({
              threads: [{ id: "active-t1", parent_id: "main" }],
            }),
          };
        if (pathname === "/api/v10/channels/active-t1/messages")
          return {
            ok: true,
            json: async () => [
              {
                id: "msg-active",
                author: { id: "human" },
                timestamp: recent,
                content: "활성 쓰레드 요청",
                mentions: [{ id: "bot" }],
              },
            ],
          };
        return { ok: true, json: async () => [] };
      },
    },
  );
  const okRes = await watch({
    root: rootOk,
    config: { roles: [{ ...config.roles[0], channels: ["main"] }] },
    adapter: okAdapter,
    now,
  });
  assert.ok(okCalls.includes("/api/v10/guilds/guild-resolved/threads/active"));
  assert.deepEqual(
    okRes.wakes.map((w) => w.id),
    ["human-msg-active"],
  );
});

test("F3: threads beyond max_threads are visited via round-robin cursor across watch runs", async () => {
  const root = await setup();
  const conf = { roles: [{ ...config.roles[0], channels: ["main"] }] };
  const reads = [];
  const capped = {
    async threads() {
      return Array.from({ length: 26 }, (_, i) => `t${i}`);
    },
    async messages(ch) {
      reads.push(ch);
      return ch === "t25"
        ? [
            {
              id: "hidden",
              author_id: "human",
              body: "please check",
              mentions: ["bot"],
              created_at: new Date(now - 1000).toISOString(),
            },
          ]
        : [];
    },
  };
  const first = await watch({ root, config: conf, adapter: capped, now });
  assert.equal(first.wakes.length, 0);
  assert.equal(reads.includes("t25"), false);

  const second = await watch({
    root,
    config: conf,
    adapter: capped,
    now: now + 60000,
  });
  assert.equal(reads.includes("t25"), true);
  assert.deepEqual(
    second.wakes.map((w) => w.id),
    ["human-hidden"],
  );
});

test("F4: edited message with unchanged body but new mention or edit after checked_at wakes", async () => {
  const root = await setup();
  const conf = { roles: [{ ...config.roles[0], channels: ["main"] }] };
  await main([
    "add",
    "--root",
    root,
    "--role",
    "secretary",
    "--id",
    "recorded",
    "--title",
    "old task",
    "--due",
    "2026-11-09T14:00:00Z",
    "--channel",
    "main",
    "--msg-id",
    "edited",
  ]);
  await edit(root, (l) => {
    const item = l.items.find((i) => i.id === "recorded");
    item.status = "done";
    item.checked_at = new Date(now - 60000).toISOString();
    item.from.quote = "check please";
  });
  const res = await watch({
    root,
    config: conf,
    now,
    adapter: {
      async messages() {
        return [
          {
            id: "edited",
            author_id: "human",
            body: "check please",
            mentions: ["bot"],
            created_at: new Date(now - 120000).toISOString(),
            edited_at: new Date(now - 1000).toISOString(),
          },
        ];
      },
    },
  });
  assert.deepEqual(
    res.wakes.map((w) => w.id),
    ["human-edited"],
  );
});

test("F5: answered_by_any_role_post_after only counts role posts in the same channel or thread", async () => {
  const root = await setup();
  const conf = {
    roles: [
      {
        ...config.roles[0],
        channels: ["main"],
        answered_by_any_role_post_after: true,
      },
    ],
  };
  const res = await watch({
    root,
    config: conf,
    now,
    adapter: {
      async threads() {
        return ["t1", "t2"];
      },
      async messages(ch) {
        if (ch === "t1")
          return [
            {
              id: "request",
              author_id: "human",
              body: "please check",
              mentions: ["bot"],
              created_at: new Date(now - 10000).toISOString(),
            },
          ];
        if (ch === "t2")
          return [
            {
              id: "bot-post",
              author_id: "bot",
              body: "unrelated thread post",
              created_at: new Date(now - 1000).toISOString(),
            },
          ];
        return [
          {
            id: "main-bot-post",
            author_id: "bot",
            body: "unrelated main post",
            created_at: new Date(now - 1000).toISOString(),
          },
        ];
      },
    },
  });
  assert.deepEqual(
    res.wakes.map((w) => w.id),
    ["human-request"],
  );
});

