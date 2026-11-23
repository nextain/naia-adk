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

