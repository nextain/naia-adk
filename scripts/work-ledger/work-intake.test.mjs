import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { changeLedger, main, readLedger, wakeHeader } from "./ledger.mjs";
import { watch, writeLedgerWake } from "./ledger-watch.mjs";
import { createAdapter } from "./messenger.mjs";
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
  await writeFile(path.join(root, "review.txt"), "Sample reviewed.\n");
  await main(["done", card.id, "--root", root, "--role", "editor", "--result", "review.txt"], { now });
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

test("a reply to one role on shared work reaches only the role whose answer it addresses", async t => {
  const { run, rows } = await setup(t);
  const shared = post("shared", "<@writer> <@editor> review this together");
  const answer = post("editor-answer", "I have a question", { author_id: "editor", reply_to_id: shared.id });
  const reply = post("answer-to-editor", "Use the short version", { reply_to_id: answer.id, reply_to_author_id: "editor" });
  await run([reply, answer, shared]);
  const messages = async role => (await rows(role)).map(card => card.intake_messages.map(event => event.msg_id));
  assert.deepEqual(await messages("editor"), [["shared", "answer-to-editor"]]);
  assert.deepEqual(await messages("writer"), [["shared"]]);
});

test("a reply to an older agent response recovers the original card after a temporary read error", async t => {
  const { root, config, run, rows } = await setup(t);
  await run([post("old-request", "<@writer> prepare the sample")]);
  const [original] = await rows("writer");
  const later = now + 25 * 60 * 60000;
  const followup = post("next-day", "please include the index", {
    created_at: iso(later), reply_to_id: "old-answer", reply_to_author_id: "writer",
  });
  let status = 503;
  let lookups = 0;
  const provider = createAdapter({ type: "discord" }, { env: { DISCORD_BOT_TOKEN: "fixture" }, fetchImpl: async url => {
    assert.equal(url.pathname, "/api/v10/channels/room/messages/old-answer");
    lookups++;
    return Response.json({ id: "old-answer", message_reference: { channel_id: "room", message_id: "old-request" } }, { status });
  } });
  const adapter = {
    messages: async channel => channel === "room" ? [followup] : [],
    replyReference: (channel, id) => provider.replyReference(channel, id),
  };
  const first = await watch({ root, config, adapter, now: later });
  assert.ok(first.errors.includes("messenger:writer:room:next-day"));
  assert.equal((await rows("writer")).length, 1);
  status = 200;
  assert.deepEqual((await watch({ root, config, adapter, now: later + 1000 })).errors, []);
  assert.deepEqual((await rows("writer")).map(c => [c.id, c.due, c.intake_messages.map(e => e.msg_id)]),
    [[original.id, original.due, ["old-request", "next-day"]]]);
  assert.deepEqual(await rows("editor"), []);
  await watch({ root, config, adapter, now: later + 2000 });
  assert.equal(lookups, 2);
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

test("ordinary completion keeps one actual result across retries and simultaneous close attempts", async t => {
  const { root, run, rows } = await setup(t);
  await run([post("request", "<@writer> prepare a short note")]);
  const [card] = await rows("writer");
  const close = (...opts) => main(["done", card.id, "--root", root, "--role", "writer", ...opts], { now });
  await assert.rejects(close(), /--result/);
  await assert.rejects(close("--result", "missing.txt"), /missing or empty/);
  await writeFile(path.join(root, "empty.txt"), "");
  await assert.rejects(close("--result", "empty.txt"), /missing or empty/);
  assert.equal((await rows("writer"))[0].status, "open");
  await writeFile(path.join(root, "answer.txt"), "Answer for the original request.\n");
  const url = "https://example.org/work/results/2";
  const closes = await Promise.allSettled([close("--result", "answer.txt"), close("--result", url)]);
  assert.equal(closes.filter(c => c.status === "fulfilled").length, 1);
  const [done] = await rows("writer");
  assert.equal(done.status, "done");
  assert.equal(done.checked_at, iso(now));
  assert.equal(done.completed_at, iso(now));
  assert.ok([path.join(root, "answer.txt"), url].includes(done.result));
  assert.equal(await close("--result", done.result), card.id);
  await main(["touch", card.id, "--root", root, "--role", "writer"]);
  assert.equal((await rows("writer"))[0].completed_at, iso(now));
  assert.equal((await rows("writer"))[0].result, done.result);
});

test("previously completed ordinary cards stay readable without inventing missing evidence", async t => {
  const { root, run, rows } = await setup(t);
  await run([post("old-request", "<@writer> prepare the old note")]);
  const [card] = await rows("writer");
  await changeLedger(root, "writer", ledger => { ledger.items[0].status = "done"; });
  const args = ["done", card.id, "--root", root, "--role", "writer"];
  assert.equal(await main(args, { now }), card.id);
  await assert.rejects(main([...args, "--result", "https://example.org/later"], { now }), /already closed/);
  assert.equal((await rows("writer"))[0].result, undefined);
});

test("a stored human completion refers to an actual reply by the configured person for this card", async t => {
  const { root, run, rows } = await setup(t, {
    roles: [{ role: "writer", channels: ["100"], user_ids: ["300"], human_ids: ["500"] }],
    provider: { type: "discord", guild_id: "777", token_env: "FIXTURE_TOKEN" },
  });
  await run([post("600", "<@300> prepare the note", { author_id: "500", channel: "100" })]);
  const [card] = await rows("writer");
  const messages = {
    "700": { author: { id: "500" }, content: "Received", message_reference: { channel_id: "100", message_id: "600" } },
    "701": { author: { id: "999" }, content: card.id },
    "702": { author: { id: "500" }, content: card.id + "-other" },
  };
  let reads = 0;
  const fetchImpl = async url => {
    const id = url.pathname.split("/").at(-1);
    reads++;
    return messages[id] ? Response.json({ ...messages[id], id }) : new Response("", { status: 404 });
  };
  const close = id => main(["done", card.id, "--root", root, "--role", "writer", "--human-msg-id", id], {
    now, fetchImpl, env: { FIXTURE_TOKEN: "fixture" },
  });
  await assert.rejects(close("600"), /--human-msg-id/);
  await assert.rejects(close("701"), /configured human/);
  await assert.rejects(close("702"), /does not name item/);
  await assert.rejects(close("799"), /404/);
  assert.equal((await rows("writer"))[0].status, "open");
  assert.equal(await close("700"), card.id);
  const [done] = await rows("writer");
  assert.deepEqual([done.status, done.human_msg_id, done.result], ["done", "700", "https://discord.com/channels/777/100/700"]);
  const previous = reads;
  assert.equal(await close("700"), card.id);
  assert.equal(reads, previous);
});

test("only an explicit cancellation by a configured human can drop their work card", async t => {
  const { root, run, rows } = await setup(t, {
    roles: [{ role: "writer", channels: ["100"], user_ids: ["300"] }],
    defaults: { human_ids: ["500"] },
    provider: { type: "discord", token_env: "FIXTURE_TOKEN" },
  });
  await run([post("600", "<@300> prepare the note", { author_id: "500", channel: "100" })]);
  await run([post("601", "<@300> add sources", { author_id: "500", channel: "100", reply_to_id: "600" })]);
  const [card] = await rows("writer");
  const ref = { channel_id: "100", message_id: "601" };
  const messages = {
    701: { content: "continue " + card.id },
    702: { content: "yes", message_reference: ref },
    703: { content: "do not cancel " + card.id },
    704: { content: "cancel " + card.id, author: { id: "999" } },
    705: { content: "cancel " + card.id, author: { id: "500", bot: true } },
    706: { content: "cancel " + card.id, webhook_id: "500" },
    707: { content: "cancel " + card.id + "-other", message_reference: ref },
    708: { content: "취소할까요?", message_reference: ref },
    709: { content: "cancel", message_reference: { ...ref, channel_id: "101" } },
    710: { content: "취소해 주세요.", message_reference: ref },
    711: { content: "cancel " + card.id },
    712: { content: "cancel " + card.id, id: "711" },
  };
  let reads = 0;
  const deps = { now, env: { FIXTURE_TOKEN: "fixture" }, fetchImpl: async (url, options) => {
    reads++;
    assert.equal(options.headers.Authorization, "Bot fixture");
    const [, channel, id] = /channels\/(\d+)\/messages\/(\d+)$/.exec(url.pathname);
    if (!messages[id]) return new Response("", { status: 404 });
    return Response.json({ id, channel_id: channel, author: { id: "500" }, ...messages[id] });
  } };
  const drop = (...options) => main(["drop", card.id, "--root", root, "--role", "writer", "--reason", "요청자 중단", ...options], deps);
  await assert.rejects(drop(), /--human-msg-id/);
  await assert.rejects(drop("--human-msg-id", "600"), /--human-msg-id/);
  for (const id of ["701", "702", "703", "704", "705", "706", "707", "708", "709", "712", "799"]) {
    await assert.rejects(drop("--human-msg-id", id), undefined, id);
  }
  assert.deepEqual((await rows("writer"))[0], card);
  const args = ["--channel", "102", "--human-msg-id", "710"];
  assert.deepEqual(await Promise.all([drop(...args), drop(...args)]), [card.id, card.id]);
  const [cancelled] = await rows("writer");
  assert.equal(cancelled.status, "dropped");
  assert.equal(cancelled.drop_count, 1);
  assert.deepEqual(cancelled.drop_confirmation, { channel: "102", msg_id: "710", author: "500", at: iso(now) });
  const beforeRetry = reads;
  assert.equal(await drop(...args, "--reason", "duplicate invocation"), card.id);
  assert.equal(reads, beforeRetry);
  await assert.rejects(drop("--human-msg-id", "710"), /already closed/);
  await assert.rejects(drop("--human-msg-id", "711"), /already closed/);
  await assert.rejects(main(["done", card.id, "--root", root, "--role", "writer", "--result", "https://example.org/result"]), /already closed/);
  assert.deepEqual((await rows("writer"))[0], cancelled);
});

test("a cancellation lookup cannot overwrite a completion committed while the messenger is reading", async t => {
  const { root, rows } = await setup(t, { provider: { type: "discord", token_env: "FIXTURE_TOKEN" } });
  const role = ["--root", root, "--role", "writer"];
  const id = await main(["add", ...role, "--id", "card-a", "--title", "A", "--channel", "100",
    "--msg-id", "600", "--due", iso(now + 1000)], { now });
  const result = "https://example.org/result";
  const fetchImpl = async () => {
    await main(["done", id, ...role, "--result", result], { now });
    return Response.json({ id: "721", author: { id: "human" }, content: "cancel card-a" });
  };
  await assert.rejects(main(["drop", id, ...role, "--reason", "stop", "--human-msg-id", "721"], {
    now, env: { FIXTURE_TOKEN: "fixture" }, fetchImpl,
  }), /already closed/);
  const [card] = await rows("writer");
  assert.deepEqual([card.status, card.result, card.drop_count], ["done", result, undefined]);
});

test("a recreated card needs its own cancellation and a historical self card with human intake requires proof", async t => {
  const { root, rows } = await setup(t, { intake: { enabled: false }, provider: { type: "discord", token_env: "FIXTURE_TOKEN" } });
  const role = ["--root", root, "--role", "writer"];
  const add = (id, source, channel = "100") => main(["add", ...role, "--id", id, "--title", id, "--due", iso(now + 1000),
    "--channel", channel, "--msg-id", source], { now });
  const messages = {
    701: { content: "cancel", message_reference: { message_id: "600" } },
    702: { content: "cancel", message_reference: { message_id: "600" } },
    703: { content: "cancel first" }, 704: { content: "second 취소" },
    705: { content: "취소", message_reference: { message_id: "630" } },
  };
  const drop = (card, ...args) => main(["drop", card, ...role, "--reason", "stop", ...args], {
    now, env: { FIXTURE_TOKEN: "fixture" }, fetchImpl: async url => {
      const [, channel, id] = /channels\/(\d+)\/messages\/(\d+)$/.exec(url.pathname);
      assert.equal(channel, "100");
      return Response.json({ id, author: { id: "human" }, ...messages[id] });
    },
  });
  await add("first", "600");
  await drop("first", "--human-msg-id", "701");
  await add("second", "600");
  await assert.rejects(drop("second", "--human-msg-id", "701"), /already used/);
  await assert.rejects(drop("second", "--human-msg-id", "702"), /unambiguously/);
  await assert.rejects(drop("second", "--human-msg-id", "703"), /does not name/);
  assert.equal((await rows("writer"))[1].status, "open");
  await drop("second", "--human-msg-id", "704");
  await add("mixed", "self", "internal");
  await changeLedger(root, "writer", ledger => {
    ledger.items[2].intake_messages = [{ channel: "100", msg_id: "630", at: iso(now) }];
  });
  await assert.rejects(drop("mixed"), /--human-msg-id/);
  await assert.rejects(drop("mixed", "--human-msg-id", "630"), /--human-msg-id/);
  await drop("mixed", "--human-msg-id", "705");
  assert.deepEqual((await rows("writer")).map(row => row.drop_confirmation.msg_id), ["701", "704", "705"]);

  await add("legacy", "650");
  await changeLedger(root, "writer", ledger => { ledger.items[3].status = "dropped"; });
  assert.match(await main(["list", ...role]), /legacy \[dropped\]/);
  await assert.rejects(drop("legacy", "--human-msg-id", "705"), /already closed/);
  assert.equal((await rows("writer"))[3].drop_confirmation, undefined);
});
