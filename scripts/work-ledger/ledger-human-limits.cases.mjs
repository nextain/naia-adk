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

test("human instruction cards cap drop and due deferrals at 2 and escalate on 3rd attempt", async () => {
  const root = await setup();
  await mkdir(path.join(root, "config"), { recursive: true });
  await writeFile(path.join(root, "config/work-ledger.json"), JSON.stringify({
    ...config, provider: { type: "discord", token_env: "FIXTURE_TOKEN", guild_id: "777" },
  }));
  const cancellationMessages = { 601: "ds-1", 602: "ds-2", 603: "ds-3", 611: "trim-1", 612: "trim-2", 613: "trim-3" };
  const drop = (card, message, reason) => main([
    "drop", card, "--root", root, "--role", "secretary", "--reason", reason, "--channel", "111", "--human-msg-id", message,
  ], { now, env: { FIXTURE_TOKEN: "fixture" }, fetchImpl: async url => {
    const id = url.pathname.split("/").at(-1);
    return Response.json({ id, author: { id: "human" }, content: "cancel " + cancellationMessages[id] });
  } });
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
    await drop(`ds-${round}`, `60${round}`, `재생성 ${round}`);
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
    drop("ds-3", "603", "또 미룸"),
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
    ["done", "ds-3", "--root", root, "--role", "secretary", "--channel", "111", "--human-msg-id", "504", "--reason", "대표님 보고 후 완료"],
    { now, env: { FIXTURE_TOKEN: "fixture" }, fetchImpl: async () => Response.json({ id: "504", author: { id: "human" }, content: "ds-3 확인" }) },
  );
  const closedDs3 = (await readLedger(root, "secretary")).items.find((i) => i.id === "ds-3");
  assert.equal(closedDs3?.status, "done");
  assert.equal(closedDs3?.human_msg_id, "504");
  assert.equal(closedDs3?.result, "https://discord.com/channels/777/111/504");
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
  await drop("trim-1", "611", "1차");
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
  await drop("trim-2", "612", "2차");
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
    drop("trim-3", "613", "3차"),
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

test('the owning workspace keeps the role ledger across agent seats and existing installations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ledger-owner-'));
  createdRoots.push(root);
  const agent = path.join(root, 'agent');
  const memory = path.join(agent, 'memory');
  const project = path.join(agent, 'project');
  await mkdir(memory, { recursive: true });
  await mkdir(project);
  await writeFile(path.join(root, 'adk.json'), JSON.stringify({ kind: 'group' }));
  await writeFile(path.join(agent, 'adk.json'), JSON.stringify({ kind: 'agent' }));
  await writeFile(path.join(project, 'adk.json'), JSON.stringify({ kind: 'project' }));
  const add = directory => main(['add', '--root', directory, '--role', 'secretary', '--id', 'job',
    '--title', 'Owner check', '--due', '2026-11-09T00:00:00Z', '--channel', 'channel', '--msg-id', 'source']);
  await writeFile(path.join(memory, 'adk.json'), '{}');
  const alias = path.join(root, 'role-memory');
  await symlink(memory, alias, 'dir');
  const scheduled = { ...config, drive: { enabled: true, worker: { command: [process.execPath] } } };
  for (const directory of [agent, memory, path.join(alias, 'new')]) {
    const denied = /Agent workspaces cannot own a work ledger/;
    await assert.rejects(add(directory), denied);
    await assert.rejects(drive({ root: directory, config: scheduled, now }), denied);
    await assert.rejects(registerWorker({ root: directory, role: 'secretary', id: 'worker', resultFile: 'result' }), denied);
    await assert.rejects(updateWorkerRuntime({ root: directory, role: 'secretary', id: 'worker' }), denied);
    await assert.rejects(watchWorkers({ root: directory }), denied);
    await assert.rejects(watch({ root: directory, config, now }), denied);
    await assert.rejects(startWorkerRun({ root: directory, role: 'secretary', name: 'job' }, []), denied);
    await assert.rejects(dueWake({ root: directory, role: 'secretary', id: 'job', due: '2026-11-08T11:00:00Z', now }), denied);
    await assert.rejects(readdir(path.join(directory, '.agents/work')), { code: 'ENOENT' });
  }
  for (const owner of [root, project]) {
    await add(owner);
    assert.equal((await readLedger(owner, 'secretary')).items[0].id, 'job');
  }
  // A misplaced legacy ledger can still be inspected and moved by its operator.
  await mkdir(path.dirname(ledgerPath(agent, 'secretary')), { recursive: true });
  await writeFile(ledgerPath(agent, 'secretary'), await readFile(ledgerPath(root, 'secretary')));
  assert.equal((await readLedger(agent, 'secretary')).items[0].id, 'job');
  await assert.rejects(changeLedger(agent, 'secretary', () => {}), /Agent workspaces cannot own a work ledger/);
});
