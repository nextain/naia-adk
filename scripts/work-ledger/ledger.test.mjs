import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  utimes,
  mkdir,
  readdir,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  main,
  readLedger,
  ledgerPath,
  changeLedger,
  validateLedger,
  PLAN_ROW_KEYWORDS,
  isPlanRowTitle,
} from "./ledger.mjs";
import { watch } from "./ledger-watch.mjs";
import { createAdapter } from "./messenger.mjs";
const now = Date.parse("2026-11-08T12:00:00Z");
const createdRoots = [];
test.after(async () => {
  await Promise.all(
    createdRoots.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
const config = {
  roles: [
    {
      role: "secretary",
      channels: [],
      human_ids: ["human"],
      user_ids: ["bot"],
    },
  ],
};
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-ledger-"));
  createdRoots.push(root);
  await main([
    "add",
    "--root",
    root,
    "--role",
    "secretary",
    "--id",
    "task",
    "--title",
    "검토",
    "--due",
    "2026-11-08T13:00:00Z",
    "--channel",
    "channel",
    "--msg-id",
    "source",
  ]);
  return root;
}
const edit = (root, fn) => changeLedger(root, "secretary", fn);
test("overdue open and waiting_human repeat wake rules, 30 minute dedup and independent reasons", async () => {
  const root = await setup();
  assert.equal((await watch({ root, config, now })).wakes.length, 0);
  await edit(root, (l) => {
    l.items[0].due = "2026-11-08T11:00:00Z";
  });
  assert.equal(
    (await watch({ root, config, now })).wakes[0].reason,
    "기한 넘음",
  );
  assert.equal(
    (await watch({ root, config, now: now + 29 * 60000 })).wakes.length,
    0,
  );
  assert.equal(
    (await watch({ root, config, now: now + 30 * 60000 })).wakes.length,
    1,
  );
  await edit(root, (l) => {
    l.items[0].status = "done";
  });
  assert.equal(
    (await watch({ root, config, now: now + 60 * 60000 })).wakes.length,
    0,
  );
  // waiting_human 기한이 지나면 한 번 깨우고 기한을 다음 날로 밀어 하루 한 번만 깨운다.
  const tWait = now + 90 * 60000;
  await edit(root, (l) => {
    l.items[0].status = "waiting_human";
    l.items[0].due = "2026-11-08T11:00:00Z";
  });
  const waitWake = await watch({ root, config, now: tWait });
  assert.deepEqual(
    waitWake.wakes.map((w) => w.reason),
    ["기한 넘음"],
  );
  const pushed = await readLedger(root, "secretary");
  assert.equal(
    pushed.items[0].due,
    new Date(tWait + 24 * 3600000).toISOString(),
  );
  assert.equal(
    (await watch({ root, config, now: tWait + 23 * 3600000 })).wakes.length,
    0,
  );
  assert.deepEqual(
    (await watch({ root, config, now: tWait + 24 * 3600000 + 1 })).wakes.map(
      (w) => w.reason,
    ),
    ["기한 넘음"],
  );
});
test("done file wakes unread worker regardless of status, touch acknowledges", async () => {
  const root = await setup();
  await edit(root, (l) => {
    l.items[0].worker = {
      name: "worker",
      result: "result.md",
      done_file: "worker.done",
    };
  });
  assert.equal((await watch({ root, config, now })).wakes.length, 0);
  await writeFile(path.join(root, "worker.done"), "");
  await utimes(
    path.join(root, "worker.done"),
    new Date(now - 1000),
    new Date(now - 1000),
  );
  assert.equal(
    (await watch({ root, config, now })).wakes[0].reason,
    "일꾼 끝, 결과 안 읽음",
  );
  await edit(root, (l) => {
    l.items[0].checked_at = new Date(now).toISOString();
  });
  assert.equal(
    (await watch({ root, config, now: now + 31 * 60000 })).wakes.length,
    0,
  );
  await edit(root, (l) => {
    l.items[0].checked_at = null;
    l.items[0].status = "done";
  });
  assert.equal(
    (await watch({ root, config, now: now + 32 * 60000 })).wakes.length,
    1,
  );
});
test("all channels checked, registered messages and role replies excluded", async () => {
  const root = await setup();
  const conf = { roles: [{ ...config.roles[0], channels: ["one", "two"] }] };
  const seen = [];
  const adapter = {
    async messages(ch) {
      seen.push(ch);
      return [
        {
          id: "source",
          author_id: "human",
          created_at: new Date(now).toISOString(),
          body: "登録",
        },
        {
          id: "answered",
          author_id: "human",
          created_at: new Date(now).toISOString(),
          body: "answered",
        },
        {
          id: "reply",
          author_id: "bot",
          reply_to_id: "answered",
          created_at: new Date(now).toISOString(),
        },
        {
          id: "old",
          author_id: "human",
          created_at: new Date(now - 25 * 3600000).toISOString(),
        },
        {
          id: "missing",
          author_id: "human",
          created_at: new Date(now).toISOString(),
          body: "forgotten",
          mentions: ["bot"],
        },
      ].map((m) => ({
        ...m,
        id: ch === "two" && m.id === "missing" ? "missing-two" : m.id,
      }));
    },
  };
  const result = await watch({ root, config: conf, adapter, now });
  assert.deepEqual(seen, ["one", "two"]);
  assert.deepEqual(
    result.wakes.map((w) => w.id),
    ["human-missing", "human-missing-two"],
  );
});
test("report deadline and report command reset", async () => {
  const root = await setup();
  await edit(root, (l) => {
    l.report = {
      every_min: 60,
      channel: "reports",
      last_msg_id: "previous",
      last_at: new Date(now - 59 * 60000).toISOString(),
    };
  });
  assert.equal((await watch({ root, config, now })).wakes.length, 0);
  assert.equal(
    (await watch({ root, config, now: now + 60000 })).wakes[0].reason,
    "정기 보고 시각",
  );
  await main([
    "report",
    "--root",
    root,
    "--role",
    "secretary",
    "--channel",
    "reports",
    "--msg-id",
    "new",
  ]);
  assert.equal((await readLedger(root, "secretary")).report.last_msg_id, "new");
});
test("concurrent CLI adds preserve both and drop needs reason", async () => {
  const root = await setup();
  const args = [
    "add",
    "--root",
    root,
    "--role",
    "secretary",
    "--title",
    "other",
    "--due",
    "2026-11-08T13:00:00Z",
    "--channel",
    "channel",
    "--msg-id",
    "other",
  ];
  await Promise.all([
    main([...args, "--id", "one"]),
    main([...args, "--id", "two"]),
  ]);
  assert.equal((await readLedger(root, "secretary")).items.length, 3);
  await assert.rejects(
    main(["drop", "task", "--root", root, "--role", "secretary"]),
    /reason/,
  );
  await main([
    "drop",
    "task",
    "--root",
    root,
    "--role",
    "secretary",
    "--reason",
    "중복",
  ]);
  assert.equal(
    (await readLedger(root, "secretary")).items[0].status,
    "dropped",
  );
});
test("corrupt ledger and provider failure produce wake and errors", async () => {
  const root = await setup();
  await writeFile(ledgerPath(root, "secretary"), "{broken");
  const result = await watch({ root, config, now });
  assert.equal(result.errors.length, 1);
  assert.equal(result.wakes[0].reason, "감시 실패");
  const files = await readdir(path.join(root, ".agents/work/l4/wake"));
  assert.match(
    await readFile(path.join(root, ".agents/work/l4/wake", files[0]), "utf8"),
    /^\[장부\] 감시 실패/,
  );
  const second = await setup();
  const r = await watch({
    root: second,
    config: { roles: [{ ...config.roles[0], channels: ["channel"] }] },
    adapter: {
      messages() {
        throw new Error("offline");
      },
    },
    now,
  });
  assert.equal(r.errors.length, 1);
  assert.equal(r.wakes[0].id, "messenger-error-channel");
});
test("Discord adapter paginates until 24 hour boundary and normalizes replies", async () => {
  const calls = [];
  const recent = new Date(now).toISOString();
  const old = new Date(now - 25 * 3600000).toISOString();
  const adapter = createAdapter(
    { type: "discord", token_env: "TEST_TOKEN" },
    {
      env: { TEST_TOKEN: "test" },
      fetchImpl: async (url) => {
        calls.push(String(url));
        return {
          ok: true,
          json: async () =>
            calls.length === 1
              ? Array.from({ length: 100 }, (_, i) => ({
                  id: `m${i}`,
                  author: { id: "human" },
                  timestamp: recent,
                  content: "text",
                }))
              : [
                  { id: "old", author: { id: "human" }, timestamp: old },
                  {
                    id: "answer",
                    author: { id: "bot" },
                    timestamp: recent,
                    message_reference: { message_id: "m1" },
                  },
                ],
        };
      },
    },
  );
  const messages = await adapter.messages("channel", now - 24 * 3600000);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /before=m99/);
  assert.equal(messages.length, 101);
  assert.equal(messages.at(-1).reply_to_id, "m1");
});
test("concurrent watches deduplicate and corrupted state alerts", async () => {
  const root = await setup();
  await edit(root, (l) => {
    l.items[0].due = "2026-11-08T11:00:00Z";
  });
  const r = await Promise.all([
    watch({ root, config, now }),
    watch({ root, config, now }),
  ]);
  assert.equal(r.flatMap((v) => v.wakes).length, 1);
  await writeFile(
    path.join(root, ".agents/work/ledger/watch-state.json"),
    "broken",
  );
  assert.equal(
    (await watch({ root, config, now: now + 60000 })).errors.length,
    1,
  );
});
test("config report applies after add and unrecorded replies do not close human posts without ledger entry", async () => {
  const root = await setup();
  const conf = {
    roles: [
      {
        role: "secretary",
        channels: ["channel"],
        human_ids: ["human"],
        user_ids: ["bot"],
        report: { every_min: 60, channel: "reports" },
      },
      {
        role: "reviewer",
        channels: ["channel"],
        human_ids: ["human"],
        user_ids: ["review-bot"],
      },
    ],
  };
  const adapter = {
    messages: async () => [
      {
        id: "question",
        author_id: "human",
        body: "please check @everyone",
        created_at: new Date(now).toISOString(),
      },
      {
        id: "answer",
        author_id: "bot",
        reply_to_id: "question",
        created_at: new Date(now).toISOString(),
      },
    ],
  };
  const result = await watch({ root, config: conf, adapter, now });
  assert.equal(
    result.wakes.filter((w) => w.reason === "정기 보고 시각").length,
    1,
  );
  assert.deepEqual(
    result.wakes
      .filter((w) => w.reason === "장부에 없는 사람 글")
      .map((w) => w.role),
    ["secretary", "reviewer"],
  );
  await main([
    "add",
    "--root",
    root,
    "--role",
    "secretary",
    "--id",
    "q-item",
    "--title",
    "확인",
    "--due",
    "2026-11-08T14:00:00Z",
    "--channel",
    "channel",
    "--msg-id",
    "question",
  ]);
  const afterRecord = await watch({
    root,
    config: conf,
    adapter,
    now: now + 31 * 60000,
  });
  assert.deepEqual(
    afterRecord.wakes
      .filter((w) => w.reason === "장부에 없는 사람 글")
      .map((w) => w.role),
    ["reviewer"],
  );
});
test("schema corruption wakes instead of accepting partial worker", async () => {
  const root = await setup();
  const file = ledgerPath(root, "secretary");
  const ledger = JSON.parse(await readFile(file, "utf8"));
  ledger.items[0].worker = { done_file: "done" };
  await writeFile(file, JSON.stringify(ledger));
  assert.equal(
    (await watch({ root, config, now })).wakes[0].reason,
    "감시 실패",
  );
});

test("touch and report commands suppress the corresponding wake", async () => {
  const root = await setup();
  await edit(root, (l) => {
    l.items[0].worker = {
      name: "worker",
      result: "result.md",
      done_file: "worker.done",
    };
  });
  await writeFile(path.join(root, "worker.done"), "");
  await utimes(
    path.join(root, "worker.done"),
    new Date(now - 1000),
    new Date(now - 1000),
  );
  await main(["touch", "task", "--root", root, "--role", "secretary"]);
  const touched = await readLedger(root, "secretary");
  assert.ok(touched.items[0].checked_at);
  assert.equal((await watch({ root, config, now })).wakes.length, 0);
  await main([
    "report",
    "--root",
    root,
    "--role",
    "secretary",
    "--channel",
    "reports",
    "--msg-id",
    "sent",
    "--every-min",
    "60",
  ]);
  const reported = await readLedger(root, "secretary");
  const justAfter = Date.parse(reported.report.last_at) + 1000;
  await edit(root, (l) => {
    l.items[0].status = "done";
  });
  assert.equal(
    (await watch({ root, config, now: justAfter })).wakes.filter(
      (w) => w.reason === "정기 보고 시각",
    ).length,
    0,
  );
  const files = await readdir(path.join(root, ".agents/work/l4/wake"));
  assert.equal(files.length, 0);
});
test("24 hour inclusive boundary and another bot reply do not hide a request", async () => {
  const root = await setup();
  const conf = { roles: [{ ...config.roles[0], channels: ["channel"] }] };
  const adapter = {
    messages: async () => [
      {
        id: "boundary",
        author_id: "human",
        body: "request",
        mentions: ["bot"],
        created_at: new Date(now - 24 * 3600000).toISOString(),
      },
      {
        id: "other-answer",
        author_id: "other-bot",
        reply_to_id: "boundary",
        created_at: new Date(now).toISOString(),
      },
    ],
  };
  const result = await watch({ root, config: conf, adapter, now });
  assert.equal(result.wakes[0].id, "human-boundary");
  const files = await readdir(path.join(root, ".agents/work/l4/wake"));
  assert.match(files[0], /^\d{17}-ledger-human-boundary-route-secretary\.md$/);
  assert.match(
    await readFile(path.join(root, ".agents/work/l4/wake", files[0]), "utf8"),
    /^\[장부\] 장부에 없는 사람 글: request\n출처: channel\/boundary\n기한:/,
  );
});

test("kernel locks recover after owner SIGKILL for ledger and watch state", async () => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const { withLock } = await import("./ledger.mjs");
  const root = await setup();
  const moduleUrl = new URL("./ledger.mjs", import.meta.url).href;
  for (const file of [
    ledgerPath(root, "secretary"),
    path.join(root, ".agents/work/ledger/watch-state.json"),
  ]) {
    const code = `import { withLock } from ${JSON.stringify(moduleUrl)};
      await withLock(${JSON.stringify(file)}, async () => {
        process.stdout.write('acquired\\n');
        await new Promise(() => {});
      });`;
    const owner = spawn(process.execPath, ["--input-type=module", "-e", code], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const ready = await Promise.race([
      once(owner.stdout, "data"),
      once(owner, "exit").then(() => {
        throw new Error("Owner exited before acquiring lock");
      }),
    ]);
    assert.match(ready[0].toString(), /acquired/);
    const exited = once(owner, "exit");
    owner.kill("SIGKILL");
    await exited;
    let acquired = false;
    await withLock(file, async () => {
      acquired = true;
    });
    assert.equal(acquired, true);
  }
});

test("non-object dedup state alerts and recovers persisted suppression", async () => {
  for (const invalid of [[], 42, "broken", null]) {
    const root = await setup();
    await writeFile(
      path.join(root, ".agents/work/ledger/watch-state.json"),
      JSON.stringify({ version: 1, sent: invalid }),
    );
    const first = await watch({ root, config, now });
    assert.equal(first.errors.length, 1);
    assert.equal(first.wakes[0].reason, "감시 실패");
    const second = await watch({ root, config, now: now + 60000 });
    assert.equal(second.errors.length, 0);
    assert.equal(second.wakes.length, 0);
    const state = JSON.parse(
      await readFile(
        path.join(root, ".agents/work/ledger/watch-state.json"),
        "utf8",
      ),
    );
    assert.equal(Array.isArray(state.sent), false);
    assert.equal(Object.keys(state.sent).length, 1);
  }
});

test("role routing limits human wakes and optional later posts acknowledge", async () => {
  const root = await setup();
  const conf = { roles: [
    { ...config.roles[0], channels: ["group"], direct_channels: ["direct"] },
    { role: "other", user_ids: ["other-bot"], channels: [] },
  ] };
  const msg = (id, extra = {}) => ({
    id, author_id: "human", body: "plain",
    created_at: new Date(now - 1000).toISOString(), ...extra,
  });
  const adapter = { messages: async ch => ch === "direct" ? [msg("direct"), msg("direct-other", { body: "<@other-bot>" })] : [
    msg("unaddressed"),
    msg("only-other", { body: "<@other-bot>" }),
    msg("mention", { body: "<@bot>" }),
    msg("array", { mentions: [{ id: "bot" }] }),
    msg("reply", { reply_to_id: "parent" }),
    msg("external-reply", { reply_to_author_id: "bot" }),
    msg("everyone", { body: "@everyone" }), msg("here", { body: "@here" }),
    msg("other", { body: "<@other-bot> @everyone", reply_to_author_id: "bot" }),
    msg("both", { body: "<@other-bot> <@bot>" }),
    msg("parent", { author_id: "bot" }), msg("later", { author_id: "bot", created_at: new Date(now).toISOString() })
  ] };
  const result = await watch({ root, config: conf, adapter, now });
  assert.deepEqual(result.wakes.map(w => w.id), ["human-mention", "human-array", "human-reply", "human-external-reply", "human-everyone", "human-here", "human-other", "human-both", "human-direct", "human-direct-other"]);
  const second = await setup();
  conf.roles[0].answered_by_any_role_post_after = true;
  const unacknowledgedWithoutLedger = await watch({ root: second, config: conf, adapter, now });
  assert.deepEqual(unacknowledgedWithoutLedger.wakes.map(w => w.id), ["human-mention", "human-array", "human-reply", "human-external-reply", "human-everyone", "human-here", "human-other", "human-both", "human-direct", "human-direct-other"]);
});

test("replies to role, everyone/here, and direct channels wake even when another role is mentioned", async () => {
  const root = await setup();
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
  const created_at = new Date(now - 1000).toISOString();
  const adapter = {
    async messages(ch) {
      if (ch === "ch-dm")
        return [
          {
            id: "dm-1",
            author_id: "human-1",
            body: "<@bot-rev> 작업 상태 네가 확인해줘",
            mentions: ["bot-rev"],
            created_at,
          },
        ];
      return [
        {
          id: "reply-1",
          author_id: "human-1",
          body: "<@bot-rev> 내용도 합쳐서 다시 보고해줘",
          reply_to_id: "p1",
          reply_to_author_id: "bot-sec",
          mentions: ["bot-rev"],
          created_at,
        },
        {
          id: "every-1",
          author_id: "human-1",
          body: "@everyone <@bot-rev> 포함 각자 현황 올려줘",
          mention_everyone: true,
          mentions: ["bot-rev"],
          created_at,
        },
        {
          id: "only-rev",
          author_id: "human-1",
          body: "<@bot-rev> 이것만 봐줘",
          mentions: ["bot-rev"],
          created_at,
        },
      ];
    },
  };
  const res = await watch({ root, config: conf, adapter, now });
  assert.deepEqual(
    res.wakes.filter((w) => w.role === "secretary").map((w) => w.id),
    ["human-reply-1", "human-every-1", "human-dm-1"],
  );
  assert.deepEqual(
    res.wakes.filter((w) => w.role === "reviewer").map((w) => w.id),
    ["human-reply-1", "human-every-1", "human-only-rev"],
  );
});

test("channel failures include HTTP diagnostics, continue, and deduplicate separately", async () => {
  const root = await setup();
  const conf = {
    provider: { type: "discord", token_env: "TEST_TOKEN" },
    roles: [{ ...config.roles[0], channels: ["denied", "missing", "healthy"] }],
  };
  const calls = [];
  const adapter = createAdapter(conf.provider, { env: { TEST_TOKEN: "fake" }, fetchImpl: async url => {
    const pathname = new URL(url).pathname;
    if (!pathname.endsWith("/messages"))
      return { ok: true, json: async () => ({ guild_id: "guild-1", threads: [] }) };
    const ch = pathname.split("/").at(-2);
    calls.push(ch);
    if (ch !== "healthy") return {
      ok: false, status: ch === "denied" ? 403 : 404,
      text: async () => "x".repeat(210),
    };
    return { ok: true, json: async () => [{
      id: "request", author: { id: "human" },
      timestamp: new Date(now).toISOString(), content: "<@bot>",
      mentions: [{ id: "bot" }],
      referenced_message: { author: { id: "bot" } },
      message_reference: { message_id: "parent" },
    }] };
  } });
  const normalized = await adapter.messages("healthy", now - 1000);
  assert.deepEqual(normalized[0].mentions, ["bot"]);
  assert.equal(normalized[0].reply_to_author_id, "bot");
  calls.length = 0;
  const result = await watch({ root, config: conf, adapter, now });
  assert.deepEqual(calls, ["denied", "missing", "healthy"]);
  assert.equal(result.errors.length, 2);
  assert.equal(result.wakes.filter(w => w.reason === "감시 실패").length, 2);
  assert.ok(result.wakes.some(w => w.id === "human-request"));
  const texts = await Promise.all((await readdir(path.join(root, ".agents/work/l4/wake"))).map(f => readFile(path.join(root, ".agents/work/l4/wake", f), "utf8")));
  for (const [ch, status] of [["denied", 403], ["missing", 404]]) {
    const text = texts.find(t => t.includes(`채널: ${ch}`));
    assert.ok(text);
    assert.match(text, new RegExp(`HTTP ${status}`));
    assert.ok(text.includes("x".repeat(200)));
    assert.ok(!text.includes("x".repeat(201)));
  }
  assert.equal((await watch({ root, config: conf, adapter, now: now + 29 * 60000 })).wakes.length, 0);
  assert.equal((await watch({ root, config: conf, adapter, now: now + 30 * 60000 })).wakes.filter(w => w.reason === "감시 실패").length, 2);
});

test("later post acknowledgement excludes other roles, past and future posts", async () => {
  for (const post of [
    { author_id: "other-bot", at: now },
    { author_id: "bot", at: now - 2000 },
    { author_id: "bot", at: now + 1000 },
  ]) {
    const root = await setup();
    const conf = {
      roles: [{
        ...config.roles[0], channels: ["channel"],
        answered_by_any_role_post_after: true,
      }],
    };
    const adapter = {
      messages: async () => [{
        id: "question", author_id: "human", body: "request",
        mention_everyone: true,
        created_at: new Date(now - 1000).toISOString(),
      }, {
        id: "post", author_id: post.author_id,
        created_at: new Date(post.at).toISOString(),
      }],
    };
    assert.deepEqual(
      (await watch({ root, config: conf, adapter, now })).wakes.map(w => w.id),
      ["human-question"],
    );
  }
});

test("HTTP status survives a failed error body read", async () => {
  const adapter = createAdapter({ type: "discord" }, {
    env: { DISCORD_BOT_TOKEN: "fake" },
    fetchImpl: async () => ({
      ok: false, status: 403,
      text: async () => { throw new Error("stream interrupted"); },
    }),
  });
  await assert.rejects(adapter.messages("denied", now), /channel denied: HTTP 403.*stream interrupted/);
});

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

test("unsafe channel and message IDs emit single error wakes without aborting subsequent checks", async () => {
  const root = await setup();
  const created_at = new Date(now - 1000).toISOString();
  const conf = {
    roles: [
      {
        role: "secretary",
        channels: ["bad/channel", "#invalid-ch", "healthy-1", "healthy-2"],
        human_ids: ["human-1"],
        user_ids: ["bot-sec"],
      },
    ],
  };
  const visited = [];
  const adapter = {
    async messages(ch) {
      visited.push(ch);
      if (ch === "bad/channel") throw new Error("HTTP 404");
      if (ch === "#invalid-ch") {
        return [
          {
            id: "msg-in-invalid-ch",
            author_id: "human-1",
            body: "<@bot-sec> 확인",
            mentions: ["bot-sec"],
            created_at,
          },
        ];
      }
      if (ch === "healthy-1") {
        return [
          {
            id: "bad/msg:1",
            author_id: "human-1",
            body: "<@bot-sec> 잘못된 글 번호",
            mentions: ["bot-sec"],
            created_at,
          },
          {
            id: "good-msg-1",
            author_id: "human-1",
            body: "<@bot-sec> 같은 채널 정상 글",
            mentions: ["bot-sec"],
            created_at,
          },
        ];
      }
      return [
        {
          id: "good-msg-2",
          author_id: "human-1",
          body: "<@bot-sec> 다음 채널 정상 글",
          mentions: ["bot-sec"],
          created_at,
        },
      ];
    },
  };
  const res = await watch({ root, config: conf, adapter, now });
  assert.ok(visited.includes("healthy-1"));
  assert.ok(visited.includes("healthy-2"));
  assert.equal(
    res.wakes.filter((w) => w.reason === "감시 실패").length,
    3,
  );
  assert.deepEqual(
    res.wakes
      .filter((w) => w.reason === "장부에 없는 사람 글")
      .map((w) => w.id),
    ["human-good-msg-1", "human-good-msg-2"],
  );
});

test("direct reply only: receipt ack, unrelated role post, parent reply, and partial burst reply keep waking", async () => {
  const minhoId = "1559779745317789727";
  const humanId = "865850174651498506";
  const otherBotId = "1527145187342548992";
  const root = await setup();
  const base = now - 30 * 60000;
  const iso = (offsetSec) => new Date(base + offsetSec * 1000).toISOString();
  // 제거된 옵션(answered_by_own_post_after, report_prefixes)이 남아 있어도 무시하고 직접 답글만 인정한다.
  const conf = {
    roles: [
      {
        role: "minho",
        channels: ["1560846231406649484"],
        human_ids: [humanId],
        user_ids: [minhoId],
        answered_by_own_post_after: true,
        report_prefixes: ["[커스텀 보고]"],
      },
      {
        role: "other",
        channels: [],
        human_ids: [humanId],
        user_ids: [otherBotId],
      },
    ],
  };
  const adapter = {
    async messages() {
      return [
        // 1. 대표님 글 뒤 민호가 접수 확인("맡겠습니다") 일반 글만 올림 -> 계속 깨움 (HIGH #1/#2)
        {
          id: "1569941406775246969",
          author_id: humanId,
          channel: "1560846231406649484",
          body: `<@${minhoId}> 해당 부분 준비해줘`,
          mentions: [minhoId],
          created_at: iso(10),
        },
        {
          id: "1569941520973439110",
          author_id: minhoId,
          channel: "1560846231406649484",
          body: "[PC 민호] 지시 받았습니다. PC 민호가 맡겠습니다.",
          created_at: iso(40),
        },
        // 2. 같은 부모 글에 대한 역할 답글이 있어도 사람 후속 글은 직접 답글 없이는 계속 깨움 (HIGH #3)
        { id: "orig-req", author_id: minhoId, body: "승인 요청", created_at: iso(100) },
        { id: "h-parent-follow", author_id: humanId, reply_to_id: "orig-req", body: `<@${minhoId}> 승인 확인`, mentions: [minhoId], created_at: iso(110) },
        { id: "minho-parent-rep", author_id: minhoId, reply_to_id: "orig-req", body: "부모 글에 답글", created_at: iso(130) },
        // 3. 연쇄 발화 묶음 질문 둘 중 하나만 직접 답글 -> 답 안 한 것은 계속 깨움 (HIGH #4)
        { id: "burst-1", author_id: humanId, body: `<@${minhoId}> 첫째 질문`, mentions: [minhoId], created_at: iso(300) },
        { id: "burst-2", author_id: humanId, body: `<@${minhoId}> 둘째 질문`, mentions: [minhoId], created_at: iso(320) },
        { id: "minho-burst-1-rep", author_id: minhoId, reply_to_id: "burst-1", body: "첫째만 답함", created_at: iso(340) },
        // 4. 다른 역할의 직접 답글도 담당 역할에게는 답글 아님
        { id: "h-other-direct", author_id: humanId, body: `<@${minhoId}> 확인 필요`, mentions: [minhoId], created_at: iso(400) },
        { id: "other-direct-rep", author_id: otherBotId, reply_to_id: "h-other-direct", body: "다른 봇 답글", created_at: iso(420) },
      ];
    },
  };
  const res = await watch({ root, config: conf, adapter, now });
  assert.deepEqual(
    res.wakes.map((w) => w.id),
    [
      "human-1569941406775246969",
      "human-h-parent-follow",
      "human-burst-1",
      "human-burst-2",
      "human-h-other-direct",
    ],
  );
  // 30분 쿨다운 뒤에도 장부 미등록 건(직접 답글만 달린 burst-1 포함)이 모두 계속 깨어남을 확인
  const res2 = await watch({ root, config: conf, adapter, now: now + 30 * 60000 });
  assert.deepEqual(
    res2.wakes.map((w) => w.id),
    [
      "human-1569941406775246969",
      "human-h-parent-follow",
      "human-burst-1",
      "human-burst-2",
      "human-h-other-direct",
    ],
  );
});

test("answered-elsewhere requires explicit config, ISO timestamp, 7-day expiry, and yields to newer edits", async () => {
  const validRecentIso = new Date(now - 2 * 3600000).toISOString();
  const expiredIso = new Date(now - (7 * 24 * 3600000 + 60000)).toISOString();
  const editedBeforeIso = new Date(now - 3 * 3600000).toISOString();
  const editedAfterIso = new Date(now - 30 * 60000).toISOString();
  const createdOld = new Date(now - 5 * 3600000).toISOString();
  const posts = [
    { id: "msg-valid", author_id: "human", body: "<@bot> 다른 곳 응답 완료", mentions: ["bot"], created_at: createdOld },
    { id: "msg-expired", author_id: "human", body: "<@bot> 7일 지난 항목", mentions: ["bot"], created_at: createdOld },
    { id: "msg-bad-fmt", author_id: "human", body: "<@bot> 시각 없는 구형 줄", mentions: ["bot"], created_at: createdOld },
    { id: "msg-edited-before", author_id: "human", body: "<@bot> 기록 전 수정", mentions: ["bot"], created_at: createdOld, edited_timestamp: editedBeforeIso },
    { id: "msg-edited-after", author_id: "human", body: "<@bot> 기록 후 재수정", mentions: ["bot"], created_at: createdOld, edited_timestamp: editedAfterIso },
    { id: "msg-auto-should-wake", author_id: "human", body: "<@bot> 자동 탐색 금지", mentions: ["bot"], created_at: createdOld },
  ];

  // 1. 설정 없이 configPath 옆이나 .agents/work/ledger/answered-elsewhere.txt를 두어도 자동 탐색하지 않음 (HIGH #5)
  const rootNoCfg = await setup();
  const kitDir = path.join(rootNoCfg, "kit");
  await mkdir(kitDir, { recursive: true });
  const fakeConfigPath = path.join(kitDir, "work-ledger.json");
  await writeFile(path.join(kitDir, "answered-elsewhere.txt"), `msg-auto-should-wake ${validRecentIso} sibling\n`);
  await writeFile(path.join(rootNoCfg, ".agents/work/ledger/answered-elsewhere.txt"), `msg-valid ${validRecentIso} ledger-dir\n`);
  const resAutoOff = await watch({
    root: rootNoCfg,
    config: { roles: [{ ...config.roles[0], channels: ["ch"] }] },
    configPath: fakeConfigPath,
    adapter: { messages: async () => posts },
    now,
  });
  assert.deepEqual(
    resAutoOff.wakes.map((w) => w.id),
    [
      "human-msg-valid",
      "human-msg-expired",
      "human-msg-bad-fmt",
      "human-msg-edited-before",
      "human-msg-edited-after",
      "human-msg-auto-should-wake",
    ],
  );

  // 2. answered_elsewhere_file 명시 시 7일 이내·수정 이전 항목만 억제 (HIGH #5)
  const rootCfg = await setup();
  await writeFile(
    path.join(rootCfg, "explicit-elsewhere.txt"),
    [
      "# comment",
      `msg-valid ${validRecentIso} 다른 채널에서 답변`,
      `msg-expired ${expiredIso} 7일 지남`,
      `msg-bad-fmt - 구형 포맷`,
      `msg-edited-before ${validRecentIso} 수정 뒤 처리`,
      `msg-edited-after ${validRecentIso} 이 시각 뒤에 사람이 수정함`,
    ].join("\n") + "\n",
  );
  const resExplicit = await watch({
    root: rootCfg,
    config: { roles: [{ ...config.roles[0], channels: ["ch"], answered_elsewhere_file: "explicit-elsewhere.txt" }] },
    adapter: { messages: async () => posts },
    now,
  });
  assert.deepEqual(
    resExplicit.wakes.map((w) => w.id),
    ["human-msg-expired", "human-msg-bad-fmt", "human-msg-edited-after", "human-msg-auto-should-wake"],
  );
  assert.ok(resExplicit.warnings.some((w) => w.includes("msg-bad-fmt")));
});

test("waiting_human handles cap transition, overdue daily reminders, and edit/same-thread resets", async () => {
  const root = await setup();
  await edit(root, (l) => {
    l.items[0].status = "done";
  });
  const conf = { roles: [{ ...config.roles[0], channels: ["ch"] }] };
  let editedAt = null;
  let threadFollowAt = null;
  const adapter = {
    async threads() {
      return ["th-1"];
    },
    async messages(ch) {
      if (ch === "th-1") {
        const list = [
          {
            id: "th-post",
            author_id: "human",
            channel: "th-1",
            body: "<@bot> 쓰레드 작업 처리",
            mentions: ["bot"],
            created_at: new Date(now - 60000).toISOString(),
            ...(editedAt ? { edited_timestamp: new Date(editedAt).toISOString() } : {}),
          },
        ];
        if (threadFollowAt) {
          list.push({
            id: "th-human-follow",
            author_id: "human",
            channel: "th-1",
            body: "참고 로그 추가 올립니다",
            created_at: new Date(threadFollowAt).toISOString(),
          });
        }
        return list;
      }
      return [{ id: "root-msg", author_id: "human", channel: "ch", thread_id: "th-1", body: "쓰레드 시작", created_at: new Date(now - 120000).toISOString() }];
    },
  };

  // 진행 중(2회) 같은 쓰레드에 사람 새 글이 올라오면 상한 초기화 -> 총 3회 더 깨운 뒤에야 waiting_human 전환
  for (const round of [0, 30]) {
    const r = await watch({ root, config: conf, adapter, now: now + round * 60000 });
    assert.deepEqual(r.wakes.map((w) => w.id), ["human-th-post"]);
  }
  threadFollowAt = now + 45 * 60000;
  for (const round of [60, 90, 120]) {
    const r = await watch({ root, config: conf, adapter, now: now + round * 60000 });
    assert.deepEqual(r.wakes.map((w) => w.id), ["human-th-post"]);
  }
  assert.deepEqual(
    (await watch({ root, config: conf, adapter, now: now + 140 * 60000 })).wakes,
    [],
  );
  // 150분 시점에 상한 3회 뒤 waiting_human 등록
  const rCap = await watch({ root, config: conf, adapter, now: now + 150 * 60000 });
  assert.deepEqual(rCap.wakes, []);
  const ledCap = await readLedger(root, "secretary");
  const wh = ledCap.items.find((i) => i.from.msg_id === "th-post");
  assert.equal(wh.status, "waiting_human");

  // waiting_human 기한(+4시간) 전에는 조용하고, 기한 지나면 "기한 넘음"으로 한 번 깨우고 다음 날로 민다 (HIGH #6)
  assert.deepEqual(
    (await watch({ root, config: conf, adapter, now: now + 380 * 60000 })).wakes,
    [],
  );
  const tOver = now + 391 * 60000;
  const rOver = await watch({ root, config: conf, adapter, now: tOver });
  assert.deepEqual(
    rOver.wakes.map((w) => ({ id: w.id, reason: w.reason })),
    [{ id: wh.id, reason: "기한 넘음" }],
  );

  // waiting_human 등록 뒤에도 같은 쓰레드 새 글이 들어오면 isRecorded가 영구 억제하지 않고 상한 초기화 (HIGH #6)
  threadFollowAt = tOver + 5 * 60000;
  const rReopenThread = await watch({ root, config: conf, adapter, now: tOver + 10 * 60000 });
  assert.deepEqual(rReopenThread.wakes.map((w) => w.id), ["human-th-post"]);

  // 다시 3회 채우면 중복 항목 없이 기존 waiting_human 기한(+4h)·시각을 갱신한다
  for (const offset of [40, 70]) {
    const rx = await watch({ root, config: conf, adapter, now: tOver + offset * 60000 });
    assert.deepEqual(rx.wakes.map((w) => w.id), ["human-th-post"]);
  }
  const rReCap = await watch({ root, config: conf, adapter, now: tOver + 100 * 60000 });
  assert.deepEqual(rReCap.wakes, []);
  const ledAfter = await readLedger(root, "secretary");
  assert.equal(ledAfter.items.filter((i) => i.from.msg_id === "th-post").length, 1);

  // 갱신된 기한(+4h)이 지나면 한 번 깨운 뒤 +24h 밀어 하루 한 번만 깨운다
  const tOver2 = tOver + 341 * 60000;
  assert.deepEqual(
    (await watch({ root, config: conf, adapter, now: tOver2 })).wakes.map((w) => ({ id: w.id, reason: w.reason })),
    [{ id: wh.id, reason: "기한 넘음" }],
  );
  assert.deepEqual(
    (await watch({ root, config: conf, adapter, now: tOver2 + 12 * 3600000 })).wakes,
    [],
  );
  const tOverDay2 = tOver2 + 24 * 3600000 + 1000;
  assert.deepEqual(
    (await watch({ root, config: conf, adapter, now: tOverDay2 })).wakes.map((w) => ({ id: w.id, reason: w.reason })),
    [{ id: wh.id, reason: "기한 넘음" }],
  );

  // 24시간을 넘긴 뒤에도 원 글 수정이 들어오면 다시 감지해 깨운다
  editedAt = tOverDay2 + 5 * 60000;
  const rReopenEdit = await watch({ root, config: conf, adapter, now: tOverDay2 + 10 * 60000 });
  assert.deepEqual(rReopenEdit.wakes.map((w) => w.id), ["human-th-post"]);
});

test("messenger normalization keeps attachments/embeds; mention-only posts register waiting_human after 1 wake (HIGH #7)", async () => {
  const discordAdapter = createAdapter(
    { type: "discord", token_env: "T" },
    {
      env: { T: "tok" },
      fetchImpl: async (url) => {
        if (String(url).includes("/threads/active")) return { ok: true, json: async () => ({ threads: [] }) };
        return {
          ok: true,
          json: async () => [
            {
              id: "att-msg",
              author: { id: "human" },
              timestamp: new Date(now - 60000).toISOString(),
              content: "<@bot>",
              mentions: [{ id: "bot" }],
              attachments: [{ id: "a1", filename: "shot.png" }],
            },
            {
              id: "embed-msg",
              author: { id: "human" },
              timestamp: new Date(now - 50000).toISOString(),
              content: "<@bot>",
              mentions: [{ id: "bot" }],
              embeds: [{ title: "공유 카드" }],
            },
            {
              id: "pure-ping",
              author: { id: "human" },
              timestamp: new Date(now - 40000).toISOString(),
              content: "<@bot>",
              mentions: [{ id: "bot" }],
            },
          ],
        };
      },
    },
  );
  const msgs = await discordAdapter.messages("ch", now - 24 * 3600000);
  assert.equal(msgs.find((m) => m.id === "att-msg").attachments.length, 1);
  assert.equal(msgs.find((m) => m.id === "embed-msg").embeds.length, 1);
  assert.deepEqual(msgs.find((m) => m.id === "pure-ping").attachments, []);
  assert.deepEqual(msgs.find((m) => m.id === "pure-ping").embeds, []);

  const root = await setup();
  const conf = { roles: [{ ...config.roles[0], channels: ["ch"] }] };
  const r1 = await watch({ root, config: conf, adapter: { messages: async () => msgs }, now });
  assert.deepEqual(
    r1.wakes.map((w) => w.id),
    ["human-att-msg", "human-embed-msg", "human-pure-ping"],
  );
  // 2회차(30분): 첨부·임베드 글은 일반 글처럼 재깨움 계속, 순수 멘션 빈 글은 상한 1회 뒤 waiting_human 등록
  const r2 = await watch({ root, config: conf, adapter: { messages: async () => msgs }, now: now + 30 * 60000 });
  assert.deepEqual(r2.wakes.map((w) => w.id), ["human-att-msg", "human-embed-msg"]);
  const led2 = await readLedger(root, "secretary");
  const pingItem = led2.items.find((i) => i.from.msg_id === "pure-ping");
  assert.equal(pingItem.status, "waiting_human");
  assert.match(pingItem.note, /1회/);

  // 3회차(60분): 첨부·임베드 3회 도달, 순수 멘션 글은 조용함
  const r3 = await watch({ root, config: conf, adapter: { messages: async () => msgs }, now: now + 60 * 60000 });
  assert.deepEqual(r3.wakes.map((w) => w.id), ["human-att-msg", "human-embed-msg"]);
  // pure-ping의 waiting_human 기한(+4h)이 지나면 기한 넘음 알림이 뜬다
  const tPingDue = now + 271 * 60000;
  const rPingOver = await watch({ root, config: conf, adapter: { messages: async () => msgs }, now: tPingDue });
  assert.ok(rPingOver.wakes.some((w) => w.id === pingItem.id && w.reason === "기한 넘음"));
});

test("watch-state discards only corrupt entries, preserves valid cooldowns/counts, and clamps counts to [0, cap] (HIGH #8)", async () => {
  const root = await setup();
  const conf = { roles: [{ ...config.roles[0], channels: ["ch"] }] };
  const kCool = JSON.stringify(["secretary", "human-cool", "장부에 없는 사람 글"]);
  const kHuge = JSON.stringify(["secretary", "human-huge", "장부에 없는 사람 글"]);
  const kNeg = JSON.stringify(["secretary", "human-neg", "장부에 없는 사람 글"]);
  const kBadSent = JSON.stringify(["secretary", "human-bad-sent", "장부에 없는 사람 글"]);
  const kBadCnt = JSON.stringify(["secretary", "human-bad-cnt", "장부에 없는 사람 글"]);
  await writeFile(
    path.join(root, ".agents/work/ledger/watch-state.json"),
    JSON.stringify({
      version: 1,
      sent: {
        [kCool]: now - 5 * 60000,
        [kHuge]: now - 35 * 60000,
        [kNeg]: now - 5 * 60000,
        [kBadSent]: "not-a-timestamp",
        [kBadCnt]: now - 5 * 60000,
      },
      wake_counts: {
        [kCool]: 2,
        [kHuge]: 999,
        [kNeg]: -10,
        [kBadCnt]: "broken-count",
      },
      wake_mention_only: {
        brokenKey: "not-boolean",
      },
    }),
  );
  const msgs = [
    { id: "cool", author_id: "human", body: "<@bot> 쿨다운 유지", mentions: ["bot"], created_at: new Date(now - 60000).toISOString() },
    { id: "huge", author_id: "human", body: "<@bot> 과다 횟수", mentions: ["bot"], created_at: new Date(now - 40 * 60000).toISOString() },
  ];
  const res = await watch({ root, config: conf, adapter: { messages: async () => msgs }, now });
  // 전체 상태가 초기화되지 않아 errors 0, cool은 30분 쿨다운 유지로 재깨움 없음, huge는 상한(3) 도달로 waiting_human 전환
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.wakes, []);
  const led = await readLedger(root, "secretary");
  assert.equal(led.items.find((i) => i.from.msg_id === "huge")?.status, "waiting_human");
  const saved = JSON.parse(await readFile(path.join(root, ".agents/work/ledger/watch-state.json"), "utf8"));
  assert.equal(saved.sent[kCool], now - 5 * 60000);
  assert.equal(saved.wake_counts[kCool], 2);
  assert.equal(saved.wake_counts[kNeg], 0);
  assert.equal(saved.sent[kBadSent], undefined);
  assert.equal(saved.wake_counts[kBadCnt], undefined);
  assert.equal(saved.wake_mention_only.brokenKey, undefined);
});

test("unrecorded human posts exiting 24h since window register waiting_human before dropping", async () => {
  // 1. adapter가 24시간 지난 미등록 글을 그대로 돌려준 경우
  const rootDirect = await setup();
  const conf = { roles: [{ ...config.roles[0], channels: ["ch"] }] };
  const msgsDirect = [
    { id: "expired-unrecorded", author_id: "human", body: "<@bot> 창 밖 미등록", mentions: ["bot"], created_at: new Date(now - 25 * 3600000).toISOString() },
    { id: "expired-replied", author_id: "human", body: "<@bot> 이미 답한 옛 글", mentions: ["bot"], created_at: new Date(now - 25 * 3600000).toISOString() },
    { id: "bot-rep-old", author_id: "bot", reply_to_id: "expired-replied", created_at: new Date(now - 24.5 * 3600000).toISOString() },
    { id: "source", author_id: "human", body: "<@bot> 이미 장부 등록됨", mentions: ["bot"], created_at: new Date(now - 25 * 3600000).toISOString() },
  ];
  const rDirect = await watch({ root: rootDirect, config: conf, adapter: { messages: async () => msgsDirect }, now });
  assert.deepEqual(rDirect.wakes, []);
  const ledDirect = await readLedger(rootDirect, "secretary");
  assert.equal(ledDirect.items.find((i) => i.from.msg_id === "expired-unrecorded")?.status, "waiting_human");
  assert.equal(ledDirect.items.find((i) => i.from.msg_id === "expired-replied")?.status, "waiting_human");

  // 2. Discord처럼 since(24h) 이전 글을 API 응답에서 제외하는 어댑터에서도 wake_meta를 통해 waiting_human으로 보존
  const rootPaged = await setup();
  const allPosts = [
    { id: "will-expire", author_id: "human", body: "<@bot> 곧 24시간 경과", mentions: ["bot"], created_at: new Date(now - 23.5 * 3600000).toISOString() },
  ];
  const sinceAdapter = {
    async messages(_ch, sinceMs) {
      return allPosts.filter((m) => Date.parse(m.created_at) >= sinceMs);
    },
  };
  const rFirst = await watch({ root: rootPaged, config: conf, adapter: sinceAdapter, now });
  assert.deepEqual(rFirst.wakes.map((w) => w.id), ["human-will-expire"]);
  const rAfter24h = await watch({ root: rootPaged, config: conf, adapter: sinceAdapter, now: now + 3600000 });
  assert.deepEqual(rAfter24h.wakes, []);
  const ledPaged = await readLedger(rootPaged, "secretary");
  const expiredItem = ledPaged.items.find((i) => i.from.msg_id === "will-expire");
  assert.equal(expiredItem?.status, "waiting_human");
  assert.match(expiredItem?.note, /24시간/);
});

test("max_human_wakes validation warns once to stderr and user_ids never inherits defaults/top-level while other defaults inherit", async () => {
  // 1. invalid max_human_wakes -> stderr 1줄 경고 + 기본값 3 적용
  const rootWarn = await setup();
  await edit(rootWarn, (l) => {
    l.items[0].status = "done";
  });
  const warnCfg = {
    roles: [{ ...config.roles[0], channels: ["ch"], max_human_wakes: 0 }],
  };
  const warnAdapter = {
    messages: async () => [
      { id: "m1", author_id: "human", body: "<@bot> 테스트", mentions: ["bot"], created_at: new Date(now - 60000).toISOString() },
    ],
  };
  const origWarn = console.warn;
  const stderrLines = [];
  console.warn = (...args) => stderrLines.push(args.join(" "));
  try {
    const resWarn = await watch({ root: rootWarn, config: warnCfg, adapter: warnAdapter, now });
    assert.equal(stderrLines.length, 1);
    assert.match(stderrLines[0], /max_human_wakes/);
    assert.equal(resWarn.warnings.filter((w) => w.includes("max_human_wakes")).length, 1);
    assert.deepEqual(resWarn.wakes.map((w) => w.id), ["human-m1"]);
    assert.deepEqual((await watch({ root: rootWarn, config: warnCfg, adapter: warnAdapter, now: now + 30 * 60000 })).wakes.map((w) => w.id), ["human-m1"]);
    assert.deepEqual((await watch({ root: rootWarn, config: warnCfg, adapter: warnAdapter, now: now + 60 * 60000 })).wakes.map((w) => w.id), ["human-m1"]);
    assert.deepEqual((await watch({ root: rootWarn, config: warnCfg, adapter: warnAdapter, now: now + 90 * 60000 })).wakes, []);
    assert.equal((await readLedger(rootWarn, "secretary")).items.find((i) => i.from.msg_id === "m1")?.status, "waiting_human");
  } finally {
    console.warn = origWarn;
  }

  // 2. user_ids는 defaults·최상위에서 물려받지 않음 (오류 차단 및 role_ids만 있을 때도 default-bot 정체성 미상속)
  const rootNoInherit = await setup();
  const resNoUser = await watch({
    root: rootNoInherit,
    config: {
      user_ids: ["top-bot"],
      defaults: { user_ids: ["default-bot"] },
      channels: ["ch"],
      human_ids: ["human"],
      roles: [{ role: "secretary" }],
    },
    adapter: { messages: async () => [] },
    now,
  });
  assert.deepEqual(resNoUser.errors, ["messenger:secretary"]);
  assert.equal(resNoUser.wakes[0].reason, "감시 실패");

  const rootRoleOnly = await setup();
  const resRoleOnly = await watch({
    root: rootRoleOnly,
    config: {
      user_ids: ["top-bot"],
      defaults: { user_ids: ["default-bot"] },
      channels: ["ch"],
      human_ids: ["human"],
      roles: [{ role: "secretary", role_ids: ["r-sec"] }],
    },
    adapter: {
      messages: async () => [
        { id: "m-top", author_id: "human", body: "<@top-bot> 최상위 봇", mentions: ["top-bot"], created_at: new Date(now - 60000).toISOString() },
        { id: "m-def", author_id: "human", body: "<@default-bot> 기본 봇", mentions: ["default-bot"], created_at: new Date(now - 50000).toISOString() },
        { id: "m-role", author_id: "human", body: "<@&r-sec> 역할 호출", mention_roles: ["r-sec"], created_at: new Date(now - 40000).toISOString() },
        { id: "def-rep", author_id: "default-bot", reply_to_id: "m-role", body: "상속됐으면 답으로 착각할 뻔", created_at: new Date(now - 10000).toISOString() },
      ],
    },
    now,
  });
  assert.deepEqual(resRoleOnly.wakes.map((w) => w.id), ["human-m-role"]);

  // 3. 나머지 공통 기본값(channels, human_ids, answered_elsewhere_file, max_human_wakes 등)은 정상 상속
  const rootInherit = await setup();
  await writeFile(
    path.join(rootInherit, "shared-elsewhere.txt"),
    `skip-me ${new Date(now - 60000).toISOString()} handled\n`,
  );
  const confInherit = {
    channels: ["ch-shared"],
    human_ids: ["human"],
    answered_elsewhere_file: "shared-elsewhere.txt",
    defaults: { max_human_wakes: 2 },
    roles: [{ role: "secretary", user_ids: ["bot"] }],
  };
  const posts = [
    { id: "skip-me", author_id: "human", body: "<@bot> 건1", mentions: ["bot"], created_at: new Date(now - 60000).toISOString() },
    { id: "cap-two", author_id: "human", body: "<@bot> 두 번만", mentions: ["bot"], created_at: new Date(now - 60000).toISOString() },
  ];
  assert.deepEqual(
    (await watch({ root: rootInherit, config: confInherit, adapter: { messages: async () => posts }, now })).wakes.map((w) => w.id),
    ["human-cap-two"],
  );
  assert.deepEqual(
    (await watch({ root: rootInherit, config: confInherit, adapter: { messages: async () => posts }, now: now + 30 * 60000 })).wakes.map((w) => w.id),
    ["human-cap-two"],
  );
  await watch({ root: rootInherit, config: confInherit, adapter: { messages: async () => posts }, now: now + 60 * 60000 });
  const ledInherit = await readLedger(rootInherit, "secretary");
  assert.equal(ledInherit.items.find((i) => i.from.msg_id === "cap-two")?.status, "waiting_human");
});

test("human instruction cards cap drop and due deferrals at 2 and escalate on 3rd attempt", async () => {
  const root = await setup();
  // 1) 같은 사람 지시(msg_id=msg-deepseek)를 drop 뒤 새 카드로 재생성하는 회피도 합산하여 3회째 drop에서 거절·사람에게 올림 전환
  for (const round of [1, 2]) {
    await main(
      [
        "add",
        "--root",
        root,
        "--role",
        "secretary",
        "--id",
        `ds-${round}`,
        "--title",
        `딥시크 점검 ${round}`,
        "--due",
        "2026-11-08T13:00:00Z",
        "--channel",
        "ch-infra",
        "--msg-id",
        "msg-deepseek",
      ],
      { now },
    );
    await main(
      [
        "drop",
        `ds-${round}`,
        "--root",
        root,
        "--role",
        "secretary",
        "--reason",
        `재생성 ${round}`,
      ],
      { now },
    );
  }
  await main(
    [
      "add",
      "--root",
      root,
      "--role",
      "secretary",
      "--id",
      "ds-3",
      "--title",
      "딥시크 점검 3",
      "--due",
      "2026-11-08T13:00:00Z",
      "--channel",
      "ch-infra",
      "--msg-id",
      "msg-deepseek",
    ],
    { now },
  );
  await assert.rejects(
    main(
      [
        "drop",
        "ds-3",
        "--root",
        root,
        "--role",
        "secretary",
        "--reason",
        "또 미룸",
      ],
      { now },
    ),
    /사람에게 올림/,
  );
  const afterDrop3 = await readLedger(root, "secretary");
  const ds3 = afterDrop3.items.find((i) => i.id === "ds-3");
  assert.equal(ds3.status, "escalated_human");
  assert.match(ds3.note, /사람에게 올림 \(drop 3회 거절\)/);

  // 사람에게 올림 상태인 동안 같은 msg_id로 새 카드 재생성 차단
  await assert.rejects(
    main(
      [
        "add",
        "--root",
        root,
        "--role",
        "secretary",
        "--id",
        "ds-4",
        "--title",
        "우회 재생성",
        "--due",
        "2026-11-08T14:00:00Z",
        "--channel",
        "ch-infra",
        "--msg-id",
        "msg-deepseek",
      ],
      { now },
    ),
    /사람에게 올림/,
  );

  // 감시가 사람에게 올림 항목을 깨움함에 알림
  const watchRes = await watch({ root, config, now });
  assert.deepEqual(
    watchRes.wakes.map((w) => ({ id: w.id, reason: w.reason })),
    [{ id: "ds-3", reason: "사람에게 올림" }],
  );

  // 사람 확인 답글 번호(--human-msg-id) 없거나 원 지시와 같은 msg_id로 done 시도하면 거절됨
  await assert.rejects(
    main(["done", "ds-3", "--root", root, "--role", "secretary", "--reason", "근거 없이 닫기 시도"], { now }),
    /--human-msg-id/,
  );
  await assert.rejects(
    main(["done", "ds-3", "--root", root, "--role", "secretary", "--human-msg-id", "msg-deepseek", "--reason", "원 지시 번호 재사용 시도"], { now }),
    /--human-msg-id/,
  );
  await assert.rejects(
    main(["done", "ds-3", "--root", root, "--role", "secretary", "--human-msg-id", "-", "--reason", "빈 번호 시도"], { now }),
    /--human-msg-id/,
  );

  // 사람 확인 답글 번호와 함께 완료(done) 처리하면 더 이상 깨우지 않지만, 같은 msg_id(공백 변형 포함) 재생성은 계속 차단됨
  await main(
    ["done", "ds-3", "--root", root, "--role", "secretary", "--human-msg-id", "msg-ceo-ack-1", "--reason", "대표님 보고 후 완료"],
    { now },
  );
  const closedDs3 = (await readLedger(root, "secretary")).items.find((i) => i.id === "ds-3");
  assert.equal(closedDs3?.status, "done");
  assert.equal(closedDs3?.human_msg_id, "msg-ceo-ack-1");
  assert.deepEqual((await watch({ root, config, now: now + 31 * 60000 })).wakes, []);

  for (const bypassedId of ["msg-deepseek", "  msg-deepseek  "]) {
    await assert.rejects(
      main(
        [
          "add",
          "--root",
          root,
          "--role",
          "secretary",
          "--id",
          "ds-after-done",
          "--title",
          "done 뒤 우회 재생성",
          "--due",
          "2026-11-08T15:00:00Z",
          "--channel",
          "ch-infra",
          "--msg-id",
          bypassedId,
        ],
        { now },
      ),
      /새 카드로 재생성할 수 없습니다/,
    );
  }

  // 공백 섞인 msg_id로 add 뒤 drop해도 같은 msg_id로 정규화·합산되어 3회째 drop에서 차단됨
  await main(
    [
      "add",
      "--root",
      root,
      "--role",
      "secretary",
      "--id",
      "trim-1",
      "--title",
      "공백 정규화 1",
      "--due",
      "2026-11-08T13:00:00Z",
      "--channel",
      "ch-infra",
      "--msg-id",
      "  msg-trim-check  ",
    ],
    { now },
  );
  await main(["drop", "trim-1", "--root", root, "--role", "secretary", "--reason", "1차"], { now });
  await main(
    [
      "add",
      "--root",
      root,
      "--role",
      "secretary",
      "--id",
      "trim-2",
      "--title",
      "공백 정규화 2",
      "--due",
      "2026-11-08T13:00:00Z",
      "--channel",
      "ch-infra",
      "--msg-id",
      "msg-trim-check",
    ],
    { now },
  );
  await main(["drop", "trim-2", "--root", root, "--role", "secretary", "--reason", "2차"], { now });
  await main(
    [
      "add",
      "--root",
      root,
      "--role",
      "secretary",
      "--id",
      "trim-3",
      "--title",
      "공백 정규화 3",
      "--due",
      "2026-11-08T13:00:00Z",
      "--channel",
      "ch-infra",
      "--msg-id",
      "\tmsg-trim-check\t",
    ],
    { now },
  );
  await assert.rejects(
    main(["drop", "trim-3", "--root", root, "--role", "secretary", "--reason", "3차"], { now }),
    /사람에게 올림/,
  );

  // 2) 기한 미룸(due)도 2회까지 허용하고 3회째에 거절·사람에게 올림 전환
  await main(
    [
      "add",
      "--root",
      root,
      "--role",
      "secretary",
      "--id",
      "defer-card",
      "--title",
      "기한 연기 시험",
      "--due",
      "2026-11-08T13:00:00Z",
      "--channel",
      "ch-infra",
      "--msg-id",
      "msg-defer",
    ],
    { now },
  );
  await main(["due", "defer-card", "--root", root, "--role", "secretary", "--due", "2026-11-08T14:00:00Z", "--reason", "1차 연기"], { now });
  await main(["due", "defer-card", "--root", root, "--role", "secretary", "--due", "2026-11-08T15:00:00Z", "--reason", "2차 연기"], { now });
  await assert.rejects(
    main(["due", "defer-card", "--root", root, "--role", "secretary", "--due", "2026-11-08T16:00:00Z", "--reason", "3차 연기"], { now }),
    /사람에게 올림/,
  );
  const deferItem = (await readLedger(root, "secretary")).items.find((i) => i.id === "defer-card");
  assert.equal(deferItem.status, "escalated_human");
  assert.equal(deferItem.due, "2026-11-08T15:00:00Z");
  assert.match(deferItem.note, /기한 미룸 3회 거절/);

  // 3) 사람 메시지 ID가 없는 자체 카드(--msg-id -)는 상한 적용 제외
  for (const round of [1, 2, 3]) {
    await main(
      [
        "add",
        "--root",
        root,
        "--role",
        "secretary",
        "--id",
        `self-${round}`,
        "--title",
        `자체 점검 ${round}`,
        "--due",
        "2026-11-08T13:00:00Z",
        "--channel",
        "internal",
        "--msg-id",
        "-",
      ],
      { now },
    );
    await main(["drop", `self-${round}`, "--root", root, "--role", "secretary", "--reason", "자체 정리"], { now });
  }
  assert.equal((await readLedger(root, "secretary")).items.find((i) => i.id === "self-3")?.status, "dropped");
});

test("plan/schedule recording rows require --next <open work item id> on done, exit 2 on refusal, keep drop with --reason, and leave normal rows unchanged", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-ledger-plan-gate-"));
  createdRoots.push(root);
  const ledgerScript = fileURLToPath(new URL("./ledger.mjs", import.meta.url));
  const addItem = (role, id, title, msgId = `msg-${id}`) =>
    main(
      [
        "add",
        "--root",
        root,
        "--role",
        role,
        "--id",
        id,
        "--title",
        title,
        "--due",
        "2026-11-08T13:00:00Z",
        "--channel",
        "ch-marketing",
        "--msg-id",
        msgId,
      ],
      { now },
    );

  // 1) PLAN_ROW_KEYWORDS 상수 및 5d6611a8 형태 포함 판정
  for (const kw of ["일정 적기", "일정에 넣기", "계획 잡기", "장부에 적기", "일정 등록"]) {
    assert.ok(PLAN_ROW_KEYWORDS.includes(kw), `missing keyword: ${kw}`);
    assert.equal(isPlanRowTitle(kw), true);
  }
  assert.equal(
    isPlanRowTitle("대시보드 글 내보내기 2단계 구현 일정을 나이아 정리 문서에 넣고 #마켓팅에 알림"),
    true,
  );
  assert.equal(
    isPlanRowTitle("계획 리뷰 읽기 전용 검사에서 관문 감사 기록 덧붙임 제외"),
    false,
  );

  // 2) 계획 줄 단독 done 거절 (CLI 종료 코드 2 + 한국어 한 줄 안내 + open 유지)
  await addItem("secretary", "plan-1", "웹툰 배포 일정 적기", "msg-plan-1");
  await assert.rejects(
    main(["done", "plan-1", "--root", root, "--role", "secretary"], { now }),
    (err) =>
      err.exitCode === 2 &&
      !String(err.message).includes("\n") &&
      /본 일 줄을 add 한 뒤 --next/.test(err.message),
  );
  const cliNoNext = spawnSync(
    process.execPath,
    [ledgerScript, "done", "plan-1", "--root", root, "--role", "secretary"],
    { encoding: "utf8" },
  );
  assert.equal(cliNoNext.status, 2);
  assert.equal(cliNoNext.stderr.trim().split(/\r?\n/).length, 1);
  assert.match(cliNoNext.stderr, /본 일 줄을 add 한 뒤 --next/);
  assert.equal(
    (await readLedger(root, "secretary")).items.find((i) => i.id === "plan-1")?.status,
    "open",
  );

  // 5d6611a8 실사례 제목 형태도 단독 done 거절
  await addItem(
    "secretary",
    "plan-real-shape",
    "대시보드 글 내보내기 2단계 구현 일정을 나이아 정리 문서에 넣고 #마켓팅에 알림",
    "msg-real",
  );
  await assert.rejects(
    main(["done", "plan-real-shape", "--root", root, "--role", "secretary"], { now }),
    (err) => err.exitCode === 2 && /--next/.test(err.message),
  );

  // 3) --next 없는 id / 자기 자신 / open 아님(done·dropped) 거절 (종료 코드 2)
  await assert.rejects(
    main(["done", "plan-1", "--root", root, "--role", "secretary", "--next", "does-not-exist"], { now }),
    (err) => err.exitCode === 2 && /같은 장부에 없습니다/.test(err.message),
  );
  const cliMissingId = spawnSync(
    process.execPath,
    [ledgerScript, "done", "plan-1", "--root", root, "--role", "secretary", "--next", "does-not-exist"],
    { encoding: "utf8" },
  );
  assert.equal(cliMissingId.status, 2);

  await assert.rejects(
    main(["done", "plan-1", "--root", root, "--role", "secretary", "--next", "plan-1"], { now }),
    (err) => err.exitCode === 2 && /자기 자신/.test(err.message),
  );

  await addItem("secretary", "already-done", "이미 끝난 일반 일", "msg-done");
  await main(["done", "already-done", "--root", root, "--role", "secretary"], { now });
  await assert.rejects(
    main(["done", "plan-1", "--root", root, "--role", "secretary", "--next", "already-done"], { now }),
    (err) => err.exitCode === 2 && /open 상태가 아닙니다/.test(err.message),
  );

  // 4) 일반 줄 done 은 --next 없이 그대로 통과 (false positive 방지 포함)
  await addItem("secretary", "normal-audit", "계획 리뷰 읽기 전용 검사에서 관문 감사 기록 덧붙임 제외", "msg-normal");
  await main(["done", "normal-audit", "--root", root, "--role", "secretary"], { now });
  const normalSaved = (await readLedger(root, "secretary")).items.find((i) => i.id === "normal-audit");
  assert.equal(normalSaved?.status, "done");
  assert.equal(normalSaved?.next, undefined);

  // 5) 같은 역할 장부의 open 본 일 줄을 --next 로 가리키면 통과 및 next 기록
  await addItem("secretary", "work-same-role", "웹툰·포스팅 배포 기능 구현", "msg-plan-1");
  await main(
    ["done", "plan-1", "--root", root, "--role", "secretary", "--next", "work-same-role"],
    { now },
  );
  const closedPlan1 = (await readLedger(root, "secretary")).items.find((i) => i.id === "plan-1");
  assert.equal(closedPlan1?.status, "done");
  assert.equal(closedPlan1?.next, "work-same-role");

  // 6) 같은 장부 폴더의 다른 역할(역할 무관) open 본 일 줄도 --next 허용, waiting_human 은 거절
  await addItem("worker-b", "work-other-role", "대시보드 2단계 구현", "msg-real");
  await addItem("worker-b", "wait-other-role", "사람 답 대기 중 일감", "msg-wait-other");
  await changeLedger(root, "worker-b", (l) => {
    l.items.find((i) => i.id === "wait-other-role").status = "waiting_human";
  });
  await assert.rejects(
    main(["done", "plan-real-shape", "--root", root, "--role", "secretary", "--next", "wait-other-role"], { now }),
    (err) => err.exitCode === 2 && /open 상태가 아닙니다/.test(err.message),
  );
  await main(
    ["done", "plan-real-shape", "--root", root, "--role", "secretary", "--next", "work-other-role"],
    { now },
  );
  const closedReal = (await readLedger(root, "secretary")).items.find((i) => i.id === "plan-real-shape");
  assert.equal(closedReal?.status, "done");
  assert.equal(closedReal?.next, "work-other-role");

  // 7) 계획 줄 drop 은 막지 않되 --reason 은 그대로 요구
  await addItem("secretary", "plan-drop", "일정 등록", "msg-drop");
  await assert.rejects(
    main(["drop", "plan-drop", "--root", root, "--role", "secretary"], { now }),
    /drop requires --reason/,
  );
  await main(
    ["drop", "plan-drop", "--root", root, "--role", "secretary", "--reason", "요청 취소"],
    { now },
  );
  assert.equal(
    (await readLedger(root, "secretary")).items.find((i) => i.id === "plan-drop")?.status,
    "dropped",
  );

  // 8) validateLedger 는 잘못된 next 또는 자기 참조 next 를 거절
  const badLedger = await readLedger(root, "secretary");
  badLedger.items[0].next = badLedger.items[0].id;
  assert.throws(() => validateLedger(badLedger, "secretary"), /Invalid ledger item/);
  badLedger.items[0].next = "bad/id";
  assert.throws(() => validateLedger(badLedger, "secretary"), /Invalid role or item id/);
});
