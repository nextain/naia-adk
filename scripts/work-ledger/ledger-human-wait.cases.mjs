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

test("waiting_human handles cap transition, semantic deadline and edit/same-thread resets", async () => {
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

  // The initial four-hour deadline produces one semantic overdue notice.
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

  // A real follow-up changes the due once; elapsed days do not change it.
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
    [],
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

