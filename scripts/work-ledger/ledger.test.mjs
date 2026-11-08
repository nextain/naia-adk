import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  utimes,
  mkdir,
  readdir,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { main, readLedger, ledgerPath, changeLedger } from "./ledger.mjs";
import { watch } from "./ledger-watch.mjs";
import { createAdapter } from "./messenger.mjs";
const now = Date.parse("2026-11-08T12:00:00Z");
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
test("overdue open only, 30 minute dedup and independent reasons", async () => {
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
    l.items[0].status = "waiting_human";
  });
  assert.equal(
    (await watch({ root, config, now: now + 60 * 60000 })).wakes.length,
    0,
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
  assert.equal(r.wakes[0].id, "messenger-error");
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
test("config report applies after add and roles keep independent replies", async () => {
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
        body: "please check",
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
