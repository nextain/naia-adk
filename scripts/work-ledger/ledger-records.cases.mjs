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

test("wake header shows an empty ledger and puts a single open item on one line", () => {
  assert.equal(wakeHeader([], {}, now), "[내 장부 먼저]\n열린 업무 없음 — 이 글이 업무면 장부에 올릴 것");
  const item = headerRow("123456789", { title: ` ${"한".repeat(80)}\n끝버림` });
  assert.equal(wakeHeader([item], { msgId: item.id }, now),
    `[내 장부 먼저]\n- 12345678 | open | ${"한".repeat(80)} | ${item.due}`);
  assert.equal(wakeHeader([headerRow("waiting", { status: "waiting_human" })], {}, now),
    "[내 장부 먼저]\n- waiting | waiting_human | waiting | 2026-11-08T10:00:00Z");
});

test("wake header matches the channel and message, or a message ID on its own", () => {
  const sameId = { channel: "other", msg_id: "original" };
  const matched = headerRow("matched", { status: "done", from: { channel: "channel", msg_id: "original" } });
  const recent = headerRow("recent", { due: "2026-11-08T13:00:00Z", from: sameId });
  assert.match(wakeHeader([recent, matched], { channel: "channel", msgId: "original" }, now), /^\[내 장부 먼저\]\n- matched.*\n- recent/);
  assert.match(wakeHeader([matched, recent], { msgId: "original" }, now), /^\[내 장부 먼저\]\n- recent/);
  assert.doesNotMatch(wakeHeader([recent, matched], { channel: "missing", msgId: "original" }, now), /matched/);
  assert.doesNotMatch(wakeHeader([recent, matched], {}, now), /matched/);
});

test("wake header orders and counts unique overdue rows in a mixed 25-item ledger", () => {
  const rows = [
    headerRow("match-01", { status: "waiting_human", checked_at: "2026-11-08T11:00:00Z", from: { channel: "channel", msg_id: "wanted" } }),
    headerRow("latest01", { checked_at: "2026-11-08T11:30:00Z" }),
    headerRow("tie-bbbb", { from: { channel: "", msg_id: "-" }, status: "waiting_human" }),
    headerRow("tie-aaaa", { from: { channel: "", msg_id: "-" } }),
    headerRow("oldest01", { due: "2026-11-08T01:00:00Z", created_at: "2026-11-08T09:00:00Z" }),
    headerRow("old-copy", { due: "2026-11-08T06:00:00Z", from: { channel: "channel", msg_id: "oldest01" } }),
    headerRow("lt-copy1", { due: "2026-11-08T07:00:00Z", from: { channel: "channel", msg_id: "latest01" } }),
    headerRow("mt-copy1", { due: "2026-11-08T08:00:00Z", from: { channel: "channel", msg_id: "wanted" } }),
    headerRow("later001", { due: "2026-11-08T11:00:00Z" }),
    headerRow("next001", { due: "2026-11-08T11:01:00Z" }),
    headerRow("due-now", { status: "waiting_human", due: "2026-11-08T12:00:00Z" }),
    ...Array.from({ length: 14 }, (_, index) =>
      headerRow(`closed-${index}`, { status: ["done", "dropped", "escalated_human"][index % 3] })),
  ];
  const snapshot = structuredClone(rows);
  const summary = wakeHeader(rows, { channel: "channel", msgId: "wanted" }, now);
  assert.deepEqual(summary.split("\n").slice(1).map(line => line.startsWith("- ") ? line.slice(2, 10) : line),
    ["match-01", "latest01", "oldest01", "tie-aaaa", "tie-bbbb", "외 2건"]);
  assert.equal(wakeHeader(rows.toReversed(), { msgId: "wanted" }, now), summary);
  assert.deepEqual(rows, snapshot);
  rows[8].updated_at = "2026-11-08T11:59:00Z";
  assert.match(wakeHeader(rows, {}, now), /^\[내 장부 먼저\]\n- later001/);
});

test("overdue open and waiting_human preserve one semantic wake until facts change", async () => {
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
    0,
  );
  await edit(root, (l) => {
    l.items[0].status = "done";
  });
  assert.equal(
    (await watch({ root, config, now: now + 60 * 60000 })).wakes.length,
    0,
  );
  // An unchanged human-wait deadline stays unchanged after its one notice.
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
    "2026-11-08T11:00:00Z",
  );
  assert.equal(
    (await watch({ root, config, now: tWait + 23 * 3600000 })).wakes.length,
    0,
  );
  assert.deepEqual(
    (await watch({ root, config, now: tWait + 24 * 3600000 + 1 })).wakes.map(
      (w) => w.reason,
    ),
    [],
  );
});
test("unread worker results acknowledge touch but do not wake done or dropped cards", async () => {
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
    0,
  );
  await edit(root, (l) => { l.items[0].status = "dropped"; });
  assert.equal((await watch({ root, config, now: now + 33 * 60000 })).wakes.length, 0);
});

test("closing a worker card preserves pending events; reopening publishes changed result once", async () => {
  const root = await setup();
  await edit(root, (l) => {
    l.items[0].due = "2030-01-01T00:00:00Z";
    l.items[0].worker = { name: "worker", result: "result.md", done_file: "worker.done" };
  });
  await writeFile(path.join(root, "result.md"), "first result");
  await writeFile(path.join(root, "worker.done"), "done");
  await utimes(path.join(root, "worker.done"), new Date(now - 1000), new Date(now - 1000));
  const inbox = path.join(root, ".agents/work/l4/wake");
  const pending = async () => Object.fromEntries(await Promise.all((await readdir(inbox)).filter(name => name.endsWith(".md"))
    .map(async name => [name, await readFile(path.join(inbox, name), "utf8")])));
  const first = await watch({ root, config, now });
  assert.equal(first.wakes.filter(w => w.reason === "일꾼 끝, 결과 안 읽음").length, 1);
  const original = await pending();
  await edit(root, (l) => { l.items[0].status = "done"; });
  await writeFile(path.join(root, "result.md"), "later result");
  await utimes(path.join(root, "worker.done"), new Date(now + 1000), new Date(now + 1000));
  for (const [status, minutes] of [["done", 31], ["dropped", 62]]) {
    await edit(root, (l) => { l.items[0].status = status; });
    assert.equal((await watch({ root, config, now: now + minutes * 60000 })).wakes.length, 0);
    assert.deepEqual(await pending(), original);
  }
  await edit(root, (l) => { l.items[0].status = "open"; });
  assert.equal((await watch({ root, config, now: now + 63 * 60000 })).wakes.filter(w => w.reason === "일꾼 끝, 결과 안 읽음").length, 1);
  const updated = await pending();
  assert.equal(Object.keys(updated).length, 2);
  for (const [name, body] of Object.entries(original)) assert.equal(updated[name], body);
  assert.equal((await watch({ root, config, now: now + 94 * 60000 })).wakes.length, 0);
});

for (const status of ["waiting_human", "escalated_human"]) {
  test(`a worker result remains observable while its card is ${status}`, async () => {
    const root = await setup();
    await edit(root, (l) => {
      l.items[0].status = status;
      l.items[0].worker = { name: "worker", result: "result.md", done_file: "worker.done" };
    });
    await writeFile(path.join(root, "worker.done"), "done");
    await utimes(path.join(root, "worker.done"), new Date(now - 1000), new Date(now - 1000));
    assert.equal((await watch({ root, config, now })).wakes.filter(w => w.reason === "일꾼 끝, 결과 안 읽음").length, 1);
    assert.equal((await watch({ root, config, now: now + 31 * 60000 })).wakes.filter(w => w.reason === "일꾼 끝, 결과 안 읽음").length, 0);
  });
}
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
test("concurrent CLI adds preserve both and a reason alone cannot drop a human card", async () => {
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
  await assert.rejects(main([
    "drop",
    "task",
    "--root",
    root,
    "--role",
    "secretary",
    "--reason",
    "중복",
  ]), /--human-msg-id/);
  assert.equal(
    (await readLedger(root, "secretary")).items[0].status,
    "open",
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
