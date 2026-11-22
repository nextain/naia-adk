import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { main, readLedger, wakeHeader } from "./ledger.mjs";
import { watch, writeLedgerWake } from "./ledger-watch.mjs";
import { deliverIntake, receiveWork } from "./work-intake.mjs";

const now = Date.parse("2026-01-03T12:00:00Z");
const iso = time => new Date(time).toISOString();
function post(id, body, extra = {}) {
  return { id, author_id: "human", channel: "room", body, created_at: iso(now - 3000), ...extra };
}
async function setup(t, configExtra = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "adk-intake-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = {
    intake: { enabled: true, defaultDueMinutes: 45 },
    roles: ["writer", "editor"].map(role => ({
      role, channels: ["room", "second"], user_ids: [role], human_ids: ["human"], relay_ids: ["relay"],
    })), channel_read_interval_ms: 0, ...configExtra,
  };
  const configFile = path.join(root, "config/work-ledger.json");
  await mkdir(path.dirname(configFile), { recursive: true });
  await writeFile(configFile, JSON.stringify(config));
  function run(posts, at = now) {
    return watch({ root, config, now: at, adapter: { messages: async ch => posts.filter(m => m.channel === ch) } });
  }
  const rows = async role => (await readLedger(root, role)).items;
  return { root, config, run, rows };
}

test("first receipt creates one card for each addressee; concurrent watches and a later replay do not duplicate it", async t => {
  const { root, run, rows } = await setup(t);
  const task = post("source", "<@editor> prepare the sample");
  const result = await Promise.all([run([task]), run([task])]);
  assert.deepEqual(result.flatMap(x => x.errors), []);
  const [card] = await rows("editor");
  assert.ok(card);
  assert.deepEqual(result.flatMap(x => x.wakes), [{ role: "editor", id: card.id, reason: "접수한 작업" }]);
  assert.deepEqual(await rows("writer"), []);
  assert.deepEqual([card.from.channel, card.from.msg_id, card.status, card.due_assumed, card.due],
    ["room", "source", "open", true, iso(now + 45 * 60000)]);
  const add = ["add", "--root", root, "--role", "editor", "--channel", "room", "--msg-id", "source",
    "--due", iso(now + 60000), "--title", "again"];
  assert.equal(await main(add, { now }), card.id);
  await assert.rejects(main([...add, "--id", "second-card"], { now }), /already belongs to card/);
  await main(["due", card.id, "--root", root, "--role", "editor", "--due", iso(now + 60000),
    "--reason", "confirmed by the requester"], { now });
  assert.equal((await rows("editor"))[0].due_assumed, undefined);
  await main(["done", card.id, "--root", root, "--role", "editor"], { now });
  await run([task], now + 31 * 60000);
  assert.deepEqual((await rows("editor")).map(c => [c.id, c.status]), [[card.id, "done"]]);
  const both = post("team-task", "<@editor> <@writer> shared review");
  await run([both]);
  assert.equal((await rows("editor")).filter(c => c.from.msg_id === both.id).length, 1);
  assert.equal((await rows("writer")).filter(c => c.from.msg_id === both.id).length, 1);
});

test("replies, edits and a thread follow-up attach to their own source, including on a newest-first page", async t => {
  const { root, config, run, rows } = await setup(t);
  const first = post("original", "<@writer> draft sample", {thread_id: "topic"});
  const reply = post("reply", "add one line", { reply_to_id: "original", created_at: iso(now - 2000) });
  const response = post("answer", "working", { author_id: "writer", reply_to_id: "reply", created_at: iso(now - 1500) });
  const last = post("follow-up", "use that line", { reply_to_id: "answer", created_at: iso(now - 1000) });
  const thread = post("thread-note", "preserve the order", { channel: "topic", created_at: iso(now - 500) });
  const result = await watch({root, config, now, adapter: {
    messages: async channel => channel === "room" ? [last, response, reply, first] : channel === "topic" ? [thread] : [],
    threads: async channel => channel === "room" ? ["topic"] : [],
  }});
  assert.deepEqual(result.errors, []);
  const [card] = await rows("writer");
  assert.equal((await rows("writer")).length, 1);
  assert.equal((await rows("editor")).length, 0);
  assert.deepEqual(card.intake_messages.map(r => r.msg_id), ["original", "reply", "follow-up", "thread-note"]);
  const edited = { ...reply, edited_at: iso(now + 500), body: "use two lines" };
  assert.equal((await run([edited], now + 1000)).wakes.length, 1);
  assert.deepEqual((await run([edited], now + 2000)).wakes, []);
  const changed = (await rows("writer"))[0];
  assert.equal(changed.due, card.due);
  assert.equal(changed.checked_at, card.checked_at);
  assert.equal(changed.intake_messages.length, 4);
  const header = wakeHeader([changed], {channel: "topic", msgId: thread.id}, now);
  assert.ok(header.includes(card.id.slice(0, 8)));
  const files = await readdir(path.join(root, ".agents/work/l4/wake"));
  assert.equal(files.filter(f => f.endsWith("-route-writer.md")).length, 5);
});

test("source identity includes the channel and requires a configured sender and addressed role", async t => {
  const { run, rows } = await setup(t, { intake: { enabled: true, since: iso(now - 4000) } });
  await run([post("m", "<@editor> first"), post("m", "<@editor> second", { channel: "second" }),
    post("unknown", "plain request", { author_id: "other" }), post("hook", "<@editor> note", { author_id: "other", webhook_id: "unlisted" }),
    post("unassigned", "no destination"), post("older", "<@editor> older", { created_at: iso(now - 10000) }),
    post("authorized", "<@writer> from relay", { author_id: "relay" })]);
  assert.deepEqual((await rows("editor")).map(c => c.from.channel).sort(), ["room", "second"]);
  assert.deepEqual((await rows("writer")).map(c => c.from.msg_id), ["authorized"]);
});

test("intake can run without unregistered reminders; a redirect belongs only to the explicitly named role", async t => {
  const { run, rows } = await setup(t, { check_unrecorded_human: false });
  const original = post("start", "<@writer> create a note");
  const redirected = post("redirect", "<@editor> check the wording",
    { reply_to_id: "start", reply_to_author_id: "writer", created_at: original.created_at });
  await run([redirected, original]);
  assert.deepEqual((await rows("writer")).flatMap(c => c.intake_messages).map(e => e.msg_id), ["start"]);
  assert.deepEqual((await rows("editor")).map(c => c.from.msg_id), ["redirect"]);
});

test("a queued notice survives restart without a messenger; already published filenames are not delivered twice", async t => {
  const { root, config, run, rows } = await setup(t);
  await run([]);
  const roleConfig = config.roles[0];
  await receiveWork({root, roleConfig, ledger: await readLedger(root, "writer"), source: {
    channel: "room", msg_id: "pending", quote: "sample",
  }, related: [], revision: now - 100, now, minutes: 15, title: "sample"});
  const box = path.join(root, ".agents/work/l4/wake");
  await assert.rejects(deliverIntake(root, "writer", async notice => {
    await writeLedgerWake(box, notice);
    throw new Error("interrupted after publishing");
  }), /interrupted/);
  assert.equal((await rows("writer"))[0].intake_messages[0].pending.title, "sample");
  assert.deepEqual((await run([], now + 1000)).errors, []);
  const files = (await readdir(box)).filter(f => f.endsWith(".md"));
  assert.equal(files.length, 1);
  assert.ok((await readFile(path.join(box, files[0]), "utf8")).includes((await rows("writer"))[0].id));
  assert.equal((await rows("writer"))[0].intake_messages[0].pending, undefined);
});

test("a failed intake is retried on the same thread page before the scan moves on", async t => {
  const { root, config, rows } = await setup(t, { max_threads: 1, intake: { enabled: true, defaultDueMinutes: 0 } });
  const adapter = {
    messages: async ch => ch === "thread-a" ? [post("thread-task", "<@editor> record this", { channel: ch })] : [],
    threads: async ch => ch === "room" ? ["thread-a", "thread-b"] : [],
  };
  const failed = await watch({ root, config, adapter, now });
  assert.ok(failed.errors.includes("messenger:editor:thread-a:thread-task"));
  assert.deepEqual(await rows("editor"), []);
  config.intake.defaultDueMinutes = 30;
  const next = await watch({ root, config, adapter, now: now + 1000 });
  assert.deepEqual(next.errors, []);
  assert.deepEqual((await rows("editor")).map(c => [c.from.channel, c.from.msg_id]), [["thread-a", "thread-task"]]);
});
