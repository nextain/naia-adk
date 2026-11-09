import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { watch } from "./ledger-watch.mjs";
import { createAdapter } from "./messenger.mjs";

const instant = (time) => Date.parse(`2026-11-09T${time}:00Z`);
const conf = () => ({
  provider: { type: "discord", guild_id: "example-guild" },
  channel_read_interval_ms: 0,
  human_wait: { after_min: 15 },
  roles: [{ role: "radio", channels: ["studio"], human_ids: ["owner-a"], user_ids: ["bot-a"] }],
});
const message = (id, author, time, body, extra = {}) => ({
  id, author_id: author, channel: "studio", created_at: new Date(instant(time)).toISOString(), body, ...extra,
});
const incident = () => [
  message("instruction", "owner-a", "00:11", "내부 테스트를 해보도록 해. 방송으로 내보내지 말고."),
  message("question-first", "bot-a", "00:15", "가능하신 시각 알려 주시면 그 시각에 맞춰 시작하겠습니다.", { reply_to_id: "instruction" }),
  message("question-latest", "bot-a", "01:04", "<@owner-a> 지금 바로 시작해도 될까요?", { mentions: ["owner-a"] }),
];
async function rootFor(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "human-wait-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function fake(messages) {
  return { async messages() { return structuredClone(messages); } };
}
async function tick(root, messages, time = "01:19", config = conf()) {
  return watch({ root, config, adapter: fake(messages), now: instant(time), sleep: async () => {} });
}

test("incident: each pending question wakes once, using existing role route", async (t) => {
  const root = await rootFor(t);
  assert.equal((await tick(root, incident(), "01:18")).wakes.length, 1);
  const result = await tick(root, incident());
  assert.deepEqual(result.errors, []);
  assert.equal(result.wakes.length, 1);
  assert.equal(result.wakes[0].role, "radio");
  const files = await readdir(path.join(root, ".agents/work/l4/wake"));
  assert.equal(files.length, 2);
  const latest = files.find((file) => file.includes("question-latest"));
  assert.match(latest, /-route-radio\.md$/);
  const body = await readFile(path.join(root, ".agents/work/l4/wake", latest), "utf8");
  assert.match(body, /studio/);
  assert.match(body, /https:\/\/discord\.com\/channels\/example-guild\/studio\/question-latest/);
  assert.match(body, /지금 바로 시작해도 될까요/);
  assert.match(body, /이미 받은 지시/);
  assert.match(body, /되돌릴 수/);
  assert.match(body, /#업무-요청/);
  assert.equal((await tick(root, incident(), "01:29")).wakes.length, 0);
  // Beyond the generic wake's 30 minute dedup: a question remains one-shot.
  assert.equal((await tick(root, incident(), "02:19")).wakes.length, 0);
});

for (const [name, posts] of [
  ["human response", [message("answer", "owner-a", "01:10", "진행하세요")]],

]) {
  test(`${name} cancels a pending question`, async (t) => {
    const root = await rootFor(t);
    assert.equal((await tick(root, [...incident(), ...posts])).wakes.length, 0);
  });
}
test("an addressed statement is not a question", async (t) => {
  const root = await rootFor(t);
  const posts = [message("statement", "bot-a", "01:04", "<@owner-a> 내부 시험을 시작했습니다.", { mentions: ["owner-a"] })];
  assert.equal((await tick(root, posts)).wakes.length, 0);
});
test("a question replying to a human is detected without a mention", async (t) => {
  const root = await rootFor(t);
  const posts = [incident()[0], message("reply-question", "bot-a", "01:04", "시각을 말씀 주시면 시작하겠습니다.", { reply_to_id: "instruction" })];
  assert.equal((await tick(root, posts)).wakes.length, 1);
});
test("a question without a human addressee is ignored", async (t) => {
  const root = await rootFor(t);
  assert.equal((await tick(root, [message("unaddressed", "bot-a", "01:04", "지금 시작해도 될까요?")])).wakes.length, 0);
});

function limited(seconds = 0.125) {
  return { ok: false, status: 429, headers: { get: () => null }, async text() { return JSON.stringify({ retry_after: seconds }); }, async json() { return { retry_after: seconds }; } };
}
const successful = () => ({ ok: true, async json() { return []; } });
test("Discord 429 waits retry_after exactly once before successful retry", async () => {
  let calls = 0;
  const sleeps = [];
  const adapter = createAdapter({ type: "discord" }, {
    env: { DISCORD_BOT_TOKEN: "fake-test-token" },
    fetchImpl: async () => ++calls === 1 ? limited() : successful(),
    sleep: async (ms) => sleeps.push(ms),
  });
  assert.deepEqual(await adapter.messages("studio", 0), []);
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [125]);
});
test("persistent Discord 429 skips round with warnings and wakes on third consecutive round", async (t) => {
  const root = await rootFor(t);
  let calls = 0;
  const sleeps = [];
  const adapter = createAdapter({ type: "discord" }, {
    env: { DISCORD_BOT_TOKEN: "fake-test-token" },
    fetchImpl: async () => { calls++; return limited(); },
    sleep: async (ms) => sleeps.push(ms),
  });
  for (let round = 1; round <= 3; round++) {
    const result = await watch({ root, config: conf(), adapter, now: instant("01:19") + round * 60000, sleep: async () => {} });
    assert.deepEqual(result.errors, [], "channel failure must keep CLI exit status normal");
    assert.ok(result.warnings.length > 0);
    assert.equal(result.wakes.length, round === 3 ? 1 : 0);
  }
  assert.equal(calls, 6, "one retry per round");
  assert.deepEqual(sleeps, [125, 125, 125]);
});

test("custom question patterns and wait duration are honored", async (t) => {
  const root = await rootFor(t);
  const config = conf();
  config.human_wait = { after_min: 20, question_patterns: ["승인 대기 중"] };
  const posts = [message("custom", "bot-a", "01:04", "<@owner-a> 승인 대기 중", { mentions: ["owner-a"] })];
  assert.equal((await tick(root, posts, "01:19", config)).wakes.length, 0);
  assert.equal((await tick(root, posts, "01:24", config)).wakes.length, 1);
});
test("another channel's human or bot post does not cancel the question", async (t) => {
  const root = await rootFor(t);
  const posts = [...incident(),
    message("elsewhere-owner", "owner-a", "01:10", "확인", { channel: "elsewhere" }),
    message("elsewhere-bot", "bot-a", "01:11", "확인", { channel: "elsewhere" })];
  assert.equal((await tick(root, posts)).wakes.length, 2);
});
test("successful round resets consecutive channel rate limit failures", async (t) => {
  const root = await rootFor(t);
  let failing = true;
  const adapter = { async messages() {
    if (failing) throw Object.assign(new Error("HTTP 429"), { status: 429, retry_after: 0 });
    return [];
  } };
  const run = (round) => watch({ root, config: conf(), adapter, now: instant("01:19") + round * 60000, sleep: async () => {} });
  assert.equal((await run(1)).wakes.length, 0);
  assert.equal((await run(2)).wakes.length, 0);
  failing = false;
  assert.deepEqual((await run(3)).errors, []);
  failing = true;
  assert.equal((await run(4)).wakes.length, 0);
  assert.equal((await run(5)).wakes.length, 0);
  assert.equal((await run(6)).wakes.length, 1);
});
test("channel reads have the configured interval", async (t) => {
  const root = await rootFor(t);
  const config = conf();
  config.roles[0].channels = ["studio", "other-studio"];
  config.channel_read_interval_ms = 37;
  const sleeps = [];
  const result = await watch({ root, config, adapter: fake([]), now: instant("01:19"), sleep: async (ms) => sleeps.push(ms) });
  assert.deepEqual(result.errors, []);
  assert.ok(sleeps.includes(37));
});


test("CLI persistent 429 reports warnings, exits zero, and wakes on round three", async (t) => {
  const root = await rootFor(t);
  const configFile = path.join(root, "config.json");
  const preloadFile = path.join(root, "fake-fetch.mjs");
  await writeFile(configFile, JSON.stringify(conf()));
  await writeFile(preloadFile, `globalThis.fetch = async () => ({ok:false,status:429,headers:{get:()=>null},text:async()=>JSON.stringify({retry_after:0})});`);
  const cli = new URL("./ledger-watch.mjs", import.meta.url);
  for (let round = 1; round <= 3; round++) {
    const child = spawnSync(process.execPath, ["--import", preloadFile, cli.pathname, "--root", root, "--config", configFile], {
      encoding: "utf8",
      env: { ...process.env, DISCORD_BOT_TOKEN: "fake-test-token" },
      timeout: 10000,
    });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    const output = JSON.parse(child.stdout.trim());
    assert.deepEqual(output.errors, []);
    assert.ok(output.warnings.length > 0);
    assert.equal(output.wakes.length, round === 3 ? 1 : 0);
  }
  assert.equal((await readdir(path.join(root, ".agents/work/l4/wake"))).length, 1);
});

test("exhausted adapter retry exposes structured 429 without a third fetch", async () => {
  let calls = 0;
  const sleeps = [];
  const adapter = createAdapter({ type: "discord" }, {
    env: { DISCORD_BOT_TOKEN: "fake-test-token" },
    fetchImpl: async () => { calls++; return limited(0.25); },
    sleep: async (ms) => sleeps.push(ms),
  });
  await assert.rejects(adapter.messages("studio", 0), (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.retry_after, 0.25);
    assert.equal(error.retry_exhausted, true);
    return true;
  });
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [250]);
});

for (const wording of ["시각을 알려 주시면 시작합니다.", "시각을 말씀 주시면 시작합니다.", "하나 골라 주시면 시작합니다.", "시작할 수 있나요?\n내부 시험입니다.", "승인을 기다리겠습니다."]) {
  test(`default pattern detects ${JSON.stringify(wording)} without final question mark`, async (t) => {
    const root = await rootFor(t);
    const posts = [message("pattern-question", "bot-a", "01:04", `<@owner-a> ${wording}`, { mentions: ["owner-a"] })];
    assert.equal((await tick(root, posts)).wakes.length, 1);
  });
}
test("JSON example question regexes compile and match whitespace", async () => {
  const example = JSON.parse(await readFile(new URL("../../config/work-ledger.example.json", import.meta.url), "utf8"));
  const matchers = example.human_wait.question_patterns.map((pattern) => new RegExp(pattern, "u"));
  for (const body of ["시각을 알려 주시면 시작합니다.", "시간을 말씀 주시면 시작합니다.", "승인을 기다리겠습니다.", "하나 골라 주시면 시작합니다.", "시안 고르시면 시작합니다.", "시작하나요?\n안내입니다."]) {
    assert.ok(matchers.some((matcher) => matcher.test(body)), body);
  }
});
test("shared channel failures count once per round with multiple roles", async (t) => {
  const root = await rootFor(t);
  const config = conf();
  config.roles.push({ ...config.roles[0], role: "assistant", user_ids: ["bot-b"] });
  const adapter = { async messages() { throw Object.assign(new Error("HTTP 429"), { status: 429, retry_after: 0 }); } };
  for (let round = 1; round <= 3; round++) {
    const result = await watch({ root, config, adapter, now: instant("01:19") + round * 60000, sleep: async () => {} });
    assert.deepEqual(result.errors, []);
    assert.equal(result.wakes.length, round === 3 ? 2 : 0);
  }
});

test("question wake uses guild learned from channel metadata without configured guild", async (t) => {
  const root = await rootFor(t);
  const config = conf();
  delete config.provider.guild_id;
  const requests = [];
  const adapter = createAdapter(config.provider, {
    env: { DISCORD_BOT_TOKEN: "fake-test-token" },
    sleep: async () => {},
    fetchImpl: async (url) => {
      const endpoint = new URL(url).pathname;
      requests.push(endpoint);
      if (endpoint === "/api/v10/channels/studio/messages") return { ok: true, async json() { return [{
        id: "metadata-question", author: { id: "bot-a" }, timestamp: new Date(instant("01:04")).toISOString(),
        content: "<@owner-a> 지금 시작해도 될까요?", mentions: [{ id: "owner-a" }],
      }]; } };
      if (endpoint === "/api/v10/channels/studio") return { ok: true, async json() { return { guild_id: "guild-learned" }; } };
      if (endpoint === "/api/v10/guilds/guild-learned/threads/active") return { ok: true, async json() { return { threads: [] }; } };
      throw new Error(`Unexpected fake endpoint: ${endpoint}`);
    },
  });
  const result = await watch({ root, config, adapter, now: instant("01:19"), sleep: async () => {} });
  assert.deepEqual(result.errors, []);
  assert.equal(result.wakes.length, 1);
  assert.ok(requests.includes("/api/v10/channels/studio"));
  const [file] = await readdir(path.join(root, ".agents/work/l4/wake"));
  const body = await readFile(path.join(root, ".agents/work/l4/wake", file), "utf8");
  assert.match(body, /https:\/\/discord\.com\/channels\/guild-learned\/studio\/metadata-question/);
});

test("a non-429 failure interrupts the consecutive rate limit streak", async (t) => {
  const root = await rootFor(t);
  let status = 429;
  const adapter = { async messages() {
    throw Object.assign(new Error(`HTTP ${status}`), { status, retry_after: 0 });
  } };
  const run = (round) => watch({ root, config: conf(), adapter, now: instant("01:19") + round * 60000, sleep: async () => {} });
  const first = await run(1);
  assert.deepEqual(first.errors, []);
  assert.equal(first.wakes.length, 0);
  status = 403;
  const forbidden = await run(2);
  assert.ok(forbidden.errors.length > 0);
  assert.equal(forbidden.wakes.length, 1);
  status = 429;
  const third = await run(3);
  assert.deepEqual(third.errors, []);
  assert.ok(third.warnings.length > 0);
  const state = JSON.parse(await readFile(path.join(root, ".agents/work/ledger/watch-state.json"), "utf8"));
  assert.equal(state.channel_failures.studio, 1, "intervening ordinary failure resets the 429 streak independently of wake dedup");
});
