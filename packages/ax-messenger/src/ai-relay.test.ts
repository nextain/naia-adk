import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { appendFile, chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"
import { AX_AI_RELAY_RETAIN_MS_DEFAULT, AxRelayPendingError, createSessionRelay, evaluateSessionLockPayload, loadRelayConfig, parseProcStatLine, readProcessIdentity, readUptimeMs, relayName } from "./ai-relay.js"
import {
  AX_BOOT_ID_UUID_REGEX,
  AX_PROC_STAT_ALIVE_STATES,
  AX_PROC_STAT_DEAD_STATES,
  AX_RELAY_LOCK_BOOT_UNKNOWN_RECLAIM_REASON,
  AX_RELAY_LOCK_IDENTITY_UNKNOWN_RECLAIM_REASON,
  AX_RELAY_LOCK_PGID_UNKNOWN_DEFER_REASON,
  AX_RELAY_LOCK_UNREADABLE_DEFER_REASON,
  AX_RELAY_LOCK_UNREADABLE_RECLAIM_REASON,
  AX_RELAY_LOCK_WALL_CLOCK_MAX_MS,
  AX_RELAY_LOCK_WALL_CLOCK_RECLAIM_REASON,
  checkProcessGroupStatus,
  isProcessGroupAlive,
  isValidBootId,
  isValidSessionLockShape,
  normalizeBootId,
} from "./ai-relay.js"
import {
  AX_RELAY_AUDIT_JSONL_CORRUPT_REASON,
  AX_RELAY_LOCK_RM_FAILED_REASON,
  AX_RELAY_REPLIES_SNAPSHOT_UNREADABLE_REASON,
  AX_RELAY_RESTORE_RECORD_UNREADABLE_REASON,
  AX_RELAY_SESSION_LOG_WRITE_FAILED_REASON,
  AX_RELAY_STATE_UNREADABLE_REASON,
} from "./ai-relay.js"
import { openAiLedger } from "./ai-ledger.js"
import { createAiFileStore } from "./ai-store.js"
import { AX_AI_FALLBACK_MESSAGE, loadAxAiConfig } from "./ai.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const sessionRunScript = path.resolve(here, "../../../scripts/ax-messenger/relay-session-run.mjs")

const limits = { rateLimitMaxCalls: 20, rateLimitWindowMs: 100000, maxInputSize: 100, maxOutputTokens: 20 }
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ax-relay-"))
  const ledger = openAiLedger(path.join(dir, "usage"), limits)
  const store = createAiFileStore(path.join(dir, "usage"))
  const sent: Array<{ room: string; body: string; txn: string; content: Record<string, unknown> }> = []
  let time = Date.now()
  const options = { dataDir: dir, orgId: "org", limits, ledger, store, config: loadRelayConfig({ AX_AI_RELAY_STABLE_MS: "0", AX_AI_RELAY_TIMEOUT_MS: "1000" }), now: () => time, sendText: async (room: string, body: string, txn: string, content: Record<string, unknown>) => { sent.push({ room, body, txn, content }) } }
  const relay = createSessionRelay(options)
  await relay.init()
  const question = (id: string, room = "!room", body = "question") => ({ roomId: room, eventId: id, sender: "@user", timestamp: time, body })
  const reply = (id: string) => path.join(dir, "relay", "replies", `${relayName(id)}.md`)
  const inbox = (id: string) => path.join(dir, "relay", "inbox", `${relayName(id)}.json`)
  const state = (id: string) => path.join(dir, "relay", "state", `${relayName(id)}.json`)
  return { dir, ledger, store, relay, options, sent, question, reply, inbox, state, advance: (ms: number) => { time += ms }, cleanup: async () => { ledger.close(); await rm(dir, { recursive: true, force: true }) } }
}
test("파일 권한과 원장 중복, 기다리는 동안 다른 방도 전달", async () => {
  const f = await fixture()
  try {
    await f.relay.forward(f.question("$a"))
    await assert.rejects(() => f.relay.forward(f.question("$a")), { kind: "duplicate" })
    await f.relay.forward(f.question("$b", "!other"))
    assert.equal((await readdir(path.dirname(f.inbox("$a")))).length, 2)
    assert.equal((await stat(f.inbox("$a"))).mode & 0o777, 0o600)
    assert.equal((await stat(path.dirname(f.inbox("$a")))).mode & 0o777, 0o700)
    assert.equal(JSON.parse(await readFile(f.inbox("$b"), "utf8")).roomId, "!other")
  } finally { await f.cleanup() }
})
test("답글은 원문을 가리키고 한 번만 보낸다. 재시작도 중복 없음", async () => {
  const f = await fixture()
  try {
    await f.relay.forward(f.question("$a"))
    await writeFile(f.reply("$a"), "reply")
    await f.relay.poll()
    await createSessionRelay(f.options).poll()
    assert.equal(f.sent.length, 1)
    assert.equal(f.sent[0]?.body, "reply")
    assert.deepEqual(f.sent[0]?.content, { "m.relates_to": { "m.in_reply_to": { event_id: "$a" } } })
  } finally { await f.cleanup() }
})
test("답 없음, 미전달 답과 열쇠 모양 답은 보내지 않고 거부 기록", async () => {
  const f = await fixture()
  try {
    await f.relay.forward(f.question("$none")); await f.relay.forward(f.question("$secret"))
    await writeFile(f.reply("$none"), "답 없음\nignored")
    await writeFile(f.reply("$secret"), "sk-abcdefghijklmnopqrstuvwxyz")
    await writeFile(f.reply("$unknown"), "unforwarded")
    await f.relay.poll()
    assert.equal(f.sent.length, 0)
    const log = await readFile(f.store.usageFile, "utf8")
    assert.match(log, /"status":"rejected"/)
    assert.match(log, /"status":"no-answer"/)
    assert.doesNotMatch(log, /sk-abcdefghijklmnopqrstuvwxyz|question/)
  } finally { await f.cleanup() }
})
test("답 없음 접두 판정: 답 없음. 및 답 없음 (까닭)도 보내지 않고 no-answer 기록", async () => {
  const f = await fixture()
  try {
    await f.relay.forward(f.question("$dot"))
    await f.relay.forward(f.question("$reason"))
    await writeFile(f.reply("$dot"), "  답 없음. \n추가 설명")
    await writeFile(f.reply("$reason"), "답 없음 (까닭)\n")
    await f.relay.poll()
    assert.equal(f.sent.length, 0)
    const dotState = JSON.parse(await readFile(f.state("$dot"), "utf8"))
    const reasonState = JSON.parse(await readFile(f.state("$reason"), "utf8"))
    assert.equal(dotState.state, "no-answer")
    assert.equal(reasonState.state, "no-answer")
    const usageLines = (await readFile(f.store.usageFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    const noAnswers = usageLines.filter((row) => row.status === "no-answer")
    assert.equal(noAnswers.length, 2)
  } finally { await f.cleanup() }
})
test("기한 후 대체 문구 한 번, 늦은 답은 기록만", async () => {
  const f = await fixture()
  try {
    await f.relay.forward(f.question("$late")); f.advance(1000); await f.relay.poll()
    await writeFile(f.reply("$late"), "late"); await f.relay.poll(); await createSessionRelay(f.options).poll()
    assert.equal(f.sent.length, 1); assert.equal(f.sent[0]?.body, AX_AI_FALLBACK_MESSAGE)
    assert.match(await readFile(f.store.usageFile, "utf8"), /"status":"late"/)
  } finally { await f.cleanup() }
})
test("깨우기 실패는 전달을 지키고 인자에는 파일 경로만 있으며 자식 환경에 봇 토큰·비밀번호·열쇠가 없다", async () => {
  const f = await fixture()
  try {
    const output = path.join(f.dir, "args.json"), program = path.join(f.dir, "wake.mjs")
    await writeFile(program, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(output)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env })); process.exit(1)\n`)
    let failed!: () => void
    const done = new Promise<void>((resolve) => { failed = resolve })
    const customEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: "/tmp/test-home",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      TZ: "Asia/Seoul",
      AX_MESSENGER_DATA_DIR: f.dir,
      AX_RELAY_SESSION_CMD: '["/usr/bin/node"]',
      AX_RELAY_SESSION_DIR: f.dir,
      AX_AI_API_KEY: "sk-secret-provider-key",
      AX_BOT_ACCESS_TOKEN: "syt_secret_bot_token",
      AX_BOT_PASSWORD: "super-secret-password",
      UNRELATED_SECRET: "should-not-leak",
    }
    const relay = createSessionRelay({
      ...f.options,
      env: customEnv,
      config: { ...f.options.config, wakeCommand: [process.execPath, program] },
      log: () => failed(),
    })
    await relay.forward(f.question("$wake", "!room", "질문 본문 비밀 확인"))
    await done
    const recorded = JSON.parse(await readFile(output, "utf8")) as { argv: string[]; env: Record<string, string> }
    assert.deepEqual(recorded.argv, [f.inbox("$wake")])
    assert.ok(!JSON.stringify(recorded.argv).includes("질문 본문"))
    assert.equal(recorded.env.AX_MESSENGER_DATA_DIR, f.dir)
    assert.equal(recorded.env.AX_RELAY_SESSION_CMD, '["/usr/bin/node"]')
    assert.equal(recorded.env.AX_RELAY_SESSION_DIR, f.dir)
    assert.equal(recorded.env.HOME, "/tmp/test-home")
    assert.equal(recorded.env.TZ, "Asia/Seoul")
    assert.equal(recorded.env.AX_AI_API_KEY, undefined)
    assert.equal(recorded.env.AX_BOT_ACCESS_TOKEN, undefined)
    assert.equal(recorded.env.AX_BOT_PASSWORD, undefined)
    assert.equal(recorded.env.UNRELATED_SECRET, undefined)
    for (const key of Object.keys(recorded.env)) {
      assert.ok(
        ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "AX_MESSENGER_DATA_DIR"].includes(key) ||
          key.startsWith("AX_RELAY_SESSION_"),
        `허용되지 않은 환경 변수 전달됨: ${key}`,
      )
    }
    assert.equal(JSON.parse(await readFile(f.inbox("$wake"), "utf8")).body, "질문 본문 비밀 확인")
  } finally { await f.cleanup() }
})
test("빈도 및 입력 한도는 전달 전에 거부", async () => {
  const f = await fixture()
  try {
    const tiny = { ...f.options, limits: { ...limits, maxInputSize: 3 } }
    await assert.rejects(() => createSessionRelay(tiny).forward(f.question("$long")), { kind: "too-large" })
    for (let i = 0; i < 20; i++) await f.relay.forward(f.question(`$${i}`))
    await assert.rejects(() => f.relay.forward(f.question("$over")), { kind: "rate-limited" })
    assert.equal((await readdir(path.dirname(f.inbox("$over")))).length, 20)
  } finally { await f.cleanup() }
})
test("안정 시간과 완성 표식, 출력 상한", async () => {
  const f = await fixture()
  try {
    const relay = createSessionRelay({ ...f.options, config: { ...f.options.config, stableMs: 8000 } })
    await relay.forward(f.question("$ready")); await writeFile(f.reply("$ready"), "123456789012345678901234")
    await relay.poll(); assert.equal(f.sent.length, 0)
    await writeFile(`${f.reply("$ready")}.ready`, ""); await relay.poll()
    assert.equal(f.sent[0]?.body, "12345678901234567890")
  } finally { await f.cleanup() }
})
test("설정 오류 및 session-relay 인증 시험 변수 거부", () => {
  assert.throws(() => loadRelayConfig({ AX_AI_RELAY_WAKE_CMD: '["relative"]' }))
  assert.throws(() => loadRelayConfig({ AX_AI_RELAY_TIMEOUT_MS: "999" }))
  assert.throws(() => loadRelayConfig({ AX_AI_RELAY_TIMEOUT_MS: "86400001" }))
  assert.throws(() => loadRelayConfig({ AX_AI_RELAY_RETAIN_MS: "999" }))
  assert.throws(() => loadRelayConfig({ AX_AI_RELAY_RETAIN_MS: "7776000001" }))
  assert.equal(loadRelayConfig({}).retainMs, AX_AI_RELAY_RETAIN_MS_DEFAULT)
  for (const mode of ["0", "1"]) assert.throws(() => loadAxAiConfig({ AX_AI_PROVIDER: "session-relay", AX_AI_TEST_MODE: mode, AX_AUTH_RELOGIN_WINDOW_MS: "1000", AX_AI_RATE_LIMIT_MAX_CALLS: "1", AX_AI_RATE_LIMIT_WINDOW_MS: "1", AX_AI_MAX_INPUT_SIZE: "1", AX_AI_MAX_OUTPUT_TOKENS: "1" }))
})
test("예약 후 파일 저장 실패와 재시작에서도 질문을 복구하며 forwarded와 감사 줄이 중복되지 않는다", async () => {
  const f = await fixture()
  try {
    let first = true
    const failing = { ...f.store, appendCall: async (...args: Parameters<typeof f.store.appendCall>) => {
      if (first) { first = false; throw new Error("disk") }
      return f.store.appendCall(...args)
    } }
    await assert.rejects(() => createSessionRelay({ ...f.options, store: failing }).forward(f.question("$recover")), AxRelayPendingError)
    assert.equal(f.ledger.countInWindow(), 1)
    await createSessionRelay(f.options).poll()
    assert.equal(JSON.parse(await readFile(f.inbox("$recover"), "utf8")).body, "question")
    await createSessionRelay(f.options).poll()
    assert.equal((await readdir(path.dirname(f.inbox("$recover")))).length, 1)
    assert.equal(f.ledger.countInWindow(), 1)
    assert.equal(f.sent.length, 0)
    await writeFile(f.reply("$recover"), "recovered answer")
    await createSessionRelay(f.options).poll()
    await createSessionRelay(f.options).poll()
    assert.equal(f.sent.length, 1)
    assert.equal(f.sent[0]?.body, "recovered answer")
    const usageRows = (await readFile(f.store.usageFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    assert.equal(usageRows.filter((row) => row.status === "forwarded").length, 1)
    assert.equal(usageRows.filter((row) => row.status === "sent").length, 1)
  } finally { await f.cleanup() }
})
test("forwarded 사용량 기록 뒤 상태 저장 전 중단되어도 복구 시 forwarded가 한 줄만 남는다", async () => {
  const f = await fixture()
  try {
    const q = f.question("$dup-fwd")
    const callId = "0123456789abcdef"
    const row = { orgId: "org", roomId: q.roomId, eventId: q.eventId, sender: q.sender, callId, at: Date.now(), inputSize: 8, state: "pending" as const }
    await f.ledger.reserve({ callId, orgId: "org", eventId: q.eventId, at: row.at, inputSize: row.inputSize, maxOutputTokens: limits.maxOutputTokens, provider: "session-relay" })
    await f.store.appendCall({ callId, orgId: "org", at: row.at, inputSize: row.inputSize, maxOutputTokens: limits.maxOutputTokens, provider: "session-relay", eventId: q.eventId })
    await f.store.appendRelayUsage({ callId, orgId: "org", eventId: q.eventId, at: row.at, inputSize: row.inputSize, outputSize: 0, durationMs: 0, model: "subscription-session", status: "forwarded" })
    // 상태 저장(state 파일)이나 forwardedLogged 표시가 되기 전 중단된 상태를 staging에 재현한다.
    await writeFile(path.join(f.dir, "relay", "staging", `${callId}.json`), `${JSON.stringify({ ...q, row })}\n`, { mode: 0o600 })
    await f.relay.poll()
    await f.relay.poll()
    const usageRows = (await readFile(f.store.usageFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    assert.equal(usageRows.filter((r) => r.callId === callId && r.status === "forwarded").length, 1)
    const callRows = (await readFile(f.store.callFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    assert.equal(callRows.filter((r) => r.callId === callId && r.type === "provider-call").length, 1)
  } finally { await f.cleanup() }
})
test("보낸 뒤 사용량 기록 실패는 재시작에서 기록하고 다시 보내지 않으며 감사 줄도 한 번만 남긴다", async () => {
  const f = await fixture()
  try {
    const failing = { ...f.store, appendRelayUsage: async (...args: Parameters<typeof f.store.appendRelayUsage>) => {
      if (args[0].status === "sent") throw new Error("disk")
      return f.store.appendRelayUsage(...args)
    } }
    const relay = createSessionRelay({ ...f.options, store: failing })
    await relay.forward(f.question("$audit")); await writeFile(f.reply("$audit"), "answer")
    await assert.rejects(() => relay.poll())
    await createSessionRelay(f.options).poll()
    assert.equal(f.sent.length, 1)
    const usageRows = (await readFile(f.store.usageFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    assert.equal(usageRows.filter((r) => r.status === "sent").length, 1)
    const callRows = (await readFile(f.store.callFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    assert.equal(callRows.filter((r) => r.type === "provider-call-result").length, 1)
  } finally { await f.cleanup() }
})
test("완성 표식 없이 8초 미만은 대기하고 8초가 되면 답한다", async () => {
  const f = await fixture()
  try {
    let time = Date.now()
    const relay = createSessionRelay({ ...f.options, now: () => time, config: { ...f.options.config, stableMs: 8000, timeoutMs: 900000 } })
    await relay.forward(f.question("$stable"))
    await writeFile(f.reply("$stable"), "stable answer")
    const modifiedAt = (await stat(f.reply("$stable"))).mtimeMs
    time = modifiedAt + 7999
    await relay.poll()
    assert.equal(f.sent.length, 0)
    time = modifiedAt + 8000
    await relay.poll()
    assert.equal(f.sent.length, 1)
    assert.equal(f.sent[0]?.body, "stable answer")
    await relay.poll()
    assert.equal(f.sent.length, 1)
  } finally { await f.cleanup() }
})
test("staging·state·replies 파일 하나 읽기·해석 실패가 poll 전체를 멈추지 않고 같은 실패는 한 번만 기록한다", async () => {
  const f = await fixture()
  try {
    const logs: string[] = []
    const relay = createSessionRelay({ ...f.options, log: (line) => logs.push(line) })
    // 깨진 staging 파일, 깨진 state 파일, 심볼릭 링크 state 파일을 섞어 둔다.
    const badStage = path.join(f.dir, "relay", "staging", "aaaaaaaaaaaaaaaa.json")
    const badState = path.join(f.dir, "relay", "state", `${"b".repeat(64)}.json`)
    const linkState = path.join(f.dir, "relay", "state", `${"c".repeat(64)}.json`)
    await writeFile(badStage, "{broken-stage-secret-body", { mode: 0o600 })
    await writeFile(badState, "{broken-state-secret-body", { mode: 0o600 })
    await symlink(badState, linkState)

    // 그 와중에도 정상 질문($ok)은 전달되고 답글도 올라가야 한다.
    await relay.forward(f.question("$ok", "!room", "정상 질문 본문 비밀"))
    await writeFile(f.reply("$ok"), "정상 답글")
    await relay.poll()
    assert.equal(f.sent.length, 1)
    assert.equal(f.sent[0]?.body, "정상 답글")

    const errorCountAfterFirst = logs.length
    assert.ok(errorCountAfterFirst >= 3, "깨진 파일마다 격리 기록이 남아야 한다")
    // 다시 poll을 여러 번 돌려도 같은 깨진 파일의 오류 기록이 쏟아지지 않아야 한다.
    await relay.poll()
    await relay.poll()
    assert.equal(logs.length, errorCountAfterFirst, "같은 파일 실패는 반복 기록하지 않아야 한다")

    // 깨진 파일 내용이 바뀌면 그때 한 번만 다시 기록한다.
    await writeFile(badState, "{still-broken-changed", { mode: 0o600 })
    await relay.poll()
    assert.equal(logs.length, errorCountAfterFirst + 1)
    await relay.poll()
    assert.equal(logs.length, errorCountAfterFirst + 1)

    for (const line of logs) {
      assert.ok(!line.includes("broken-stage-secret-body"))
      assert.ok(!line.includes("broken-state-secret-body"))
      assert.ok(!line.includes("정상 질문 본문 비밀"))
    }
  } finally { await f.cleanup() }
})
test("심볼릭 링크 답 파일, 심볼릭 링크 .ready 표시, 보통 파일 아닌 답은 올리지 않고 거부 기록한다", async () => {
  const f = await fixture()
  try {
    const outsideTarget = path.join(f.dir, "outside.txt")
    await writeFile(outsideTarget, "outside secret content", { mode: 0o600 })

    // 1. 실제 파일을 가리키는 심볼릭 링크 답 파일
    await f.relay.forward(f.question("$link-reply"))
    await symlink(outsideTarget, f.reply("$link-reply"))

    // 2. 없는 대상을 가리키는 끊어진 심볼릭 링크 답 파일
    await f.relay.forward(f.question("$dangling-reply"))
    await symlink(path.join(f.dir, "missing.txt"), f.reply("$dangling-reply"))

    // 3. 정상 답 파일이지만 .ready가 심볼릭 링크인 경우
    await f.relay.forward(f.question("$link-ready"))
    await writeFile(f.reply("$link-ready"), "normal reply")
    await symlink(outsideTarget, `${f.reply("$link-ready")}.ready`)

    // 4. 보통 파일이 아닌 폴더가 답 파일 자리에 있는 경우
    await f.relay.forward(f.question("$dir-reply"))
    await mkdir(f.reply("$dir-reply"), { mode: 0o700 })

    await f.relay.poll()
    assert.equal(f.sent.length, 0, "심볼릭 링크나 비정상 파일은 하나도 보내면 안 된다")

    for (const id of ["$link-reply", "$dangling-reply", "$link-ready", "$dir-reply"]) {
      const st = JSON.parse(await readFile(f.state(id), "utf8"))
      assert.equal(st.state, "rejected", `${id} 상태가 rejected여야 한다`)
    }
    const usageRows = (await readFile(f.store.usageFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    assert.equal(usageRows.filter((r) => r.status === "rejected").length, 4)
  } finally { await f.cleanup() }
})
test("보존 기한이 지난 staging.rejected·rejected·끝난 질문 파일을 정리하고 재시작 뒤에도 다시 올리지 않는다", async () => {
  const f = await fixture()
  try {
    const retainMs = AX_AI_RELAY_RETAIN_MS_DEFAULT
    const relay = createSessionRelay({
      ...f.options,
      config: { ...f.options.config, retainMs },
    })
    await relay.forward(f.question("$done"))
    await writeFile(f.reply("$done"), "done reply")
    await writeFile(`${f.reply("$done")}.ready`, "")
    // 미전달 답으로 rejected 표식 생성
    await writeFile(f.reply("$unfwd"), "unforwarded")
    // staging.rejected 생성(중복 예약 거부 재현)
    const dupStage = path.join(f.dir, "relay", "staging", "1111222233334444.json")
    await writeFile(dupStage, `${JSON.stringify({ ...f.question("$done"), row: { orgId: "org", roomId: "!room", eventId: "$done", sender: "@user", callId: "1111222233334444", at: Date.now(), inputSize: 8, state: "pending" } })}\n`, { mode: 0o600 })
    // session-out 로그 파일도 생성
    const sessionOutDir = path.join(f.dir, "relay", "session-out")
    await mkdir(sessionOutDir, { recursive: true, mode: 0o700 })
    const sessionOutFile = path.join(sessionOutDir, `${relayName("$done")}.log`)
    await writeFile(sessionOutFile, "session log\n", { mode: 0o600 })
    const oldDate = new Date(Date.now() - retainMs - 5000)
    await utimes(sessionOutFile, oldDate, oldDate)

    await relay.poll()
    assert.equal(f.sent.length, 1)
    assert.equal((await readdir(path.join(f.dir, "relay", "staging"))).filter((x) => x.endsWith(".rejected")).length, 1)
    assert.equal((await readdir(path.join(f.dir, "relay", "rejected"))).length, 1)

    // 보존 기한 전에는 끝난 질문 파일이 남아 있다.
    f.advance(retainMs - 1000)
    await relay.poll()
    assert.equal((await readdir(path.join(f.dir, "relay", "state"))).length, 1)

    // 보존 기한이 지나면 staging/*.rejected, rejected/*, 끝난 질문의 inbox/replies/state, 오래된 session-out이 모두 지워진다.
    f.advance(2000)
    await relay.poll()
    assert.equal((await readdir(path.join(f.dir, "relay", "staging"))).filter((x) => x.endsWith(".rejected")).length, 0)
    assert.equal((await readdir(path.join(f.dir, "relay", "rejected"))).length, 0)
    assert.equal((await readdir(path.join(f.dir, "relay", "inbox"))).length, 0)
    assert.equal((await readdir(path.join(f.dir, "relay", "replies"))).length, 0)
    assert.equal((await readdir(path.join(f.dir, "relay", "state"))).length, 0)
    assert.equal((await readdir(sessionOutDir)).length, 0)

    // 정리 뒤 봇이 재시작해도 원장 기록이 중복 전달을 막고 다시 올리지 않는다.
    const restarted = createSessionRelay({
      ...f.options,
      config: { ...f.options.config, retainMs },
    })
    await assert.rejects(() => restarted.forward(f.question("$done")), { kind: "duplicate" })
    await restarted.poll()
    assert.equal(f.sent.length, 1)
  } finally { await f.cleanup() }
})

function runSessionScript(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [sessionRunScript, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk.toString() })
    child.stderr.on("data", (chunk) => { stderr += chunk.toString() })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })
}

test("relay-session-run.mjs: 잘못된 인자·설정 및 inbox·replies·relay 폴더 링크·데이터 폴더 밖 실경로 거부", async () => {
  const f = await fixture()
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "ax-relay-outside-"))
  try {
    await f.relay.forward(f.question("$cfg"))
    const validInbox = f.inbox("$cfg")
    const roleDir = path.join(f.dir, "role-dir")
    await mkdir(roleDir, { recursive: true, mode: 0o700 })
    await writeFile(path.join(roleDir, "AGENTS.md"), "# 역할 지시\n", { mode: 0o600 })

    const baseEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      AX_MESSENGER_DATA_DIR: f.dir,
      AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, "-e", "process.exit(0)"]),
      AX_RELAY_SESSION_DIR: roleDir,
    }
    // 1. 인자 없음
    assert.equal((await runSessionScript([], baseEnv)).code, 2)
    // 2. relay/inbox 밖의 경로
    assert.equal((await runSessionScript([path.join(f.dir, `${"a".repeat(64)}.json`)], baseEnv)).code, 2)
    // 3. 64자 16진수가 아닌 파일 이름
    assert.equal((await runSessionScript([path.join(f.dir, "relay", "inbox", "not-hex.json")], baseEnv)).code, 2)
    // 4. 존재하지 않는 inbox 파일
    assert.equal((await runSessionScript([path.join(f.dir, "relay", "inbox", `${"f".repeat(64)}.json`)], baseEnv)).code, 2)
    // 5. 상대 경로 AX_MESSENGER_DATA_DIR
    assert.equal((await runSessionScript([validInbox], { ...baseEnv, AX_MESSENGER_DATA_DIR: "relative/dir" })).code, 2)
    // 6. 상대 경로 AX_RELAY_SESSION_CMD 첫 칸
    assert.equal((await runSessionScript([validInbox], { ...baseEnv, AX_RELAY_SESSION_CMD: '["node"]' })).code, 2)
    // 7. 잘못된 AX_RELAY_SESSION_DIR
    assert.equal((await runSessionScript([validInbox], { ...baseEnv, AX_RELAY_SESSION_DIR: "relative" })).code, 2)
    assert.equal((await runSessionScript([validInbox], { ...baseEnv, AX_RELAY_SESSION_DIR: path.join(f.dir, "nonexistent") })).code, 2)
    // 8. 범위 밖 AX_RELAY_SESSION_TIMEOUT_MS
    assert.equal((await runSessionScript([validInbox], { ...baseEnv, AX_RELAY_SESSION_TIMEOUT_MS: "999" })).code, 2)
    assert.equal((await runSessionScript([validInbox], { ...baseEnv, AX_RELAY_SESSION_TIMEOUT_MS: "86400001" })).code, 2)

    // 9. inbox 파일이 심볼릭 링크인 경우 거부(종료 코드 2)
    const outsideFile = path.join(outsideDir, "outside-question.json")
    await writeFile(outsideFile, await readFile(validInbox, "utf8"), { mode: 0o600 })
    const linkInboxName = `${"d".repeat(64)}.json`
    const linkInboxPath = path.join(f.dir, "relay", "inbox", linkInboxName)
    await symlink(outsideFile, linkInboxPath)
    const resLinkInboxFile = await runSessionScript([linkInboxPath], baseEnv)
    assert.equal(resLinkInboxFile.code, 2)
    assert.match(resLinkInboxFile.stderr, /역할 세션 실행 설정이나 인자를 확인해 주세요\./)
    await rm(linkInboxPath, { force: true })

    // 10. AX_RELAY_SESSION_DIR 또는 AGENTS.md 가 심볼릭 링크인 경우 거부(종료 코드 2)
    const linkRoleDir = path.join(f.dir, "role-dir-link")
    await symlink(outsideDir, linkRoleDir)
    assert.equal((await runSessionScript([validInbox], { ...baseEnv, AX_RELAY_SESSION_DIR: linkRoleDir })).code, 2)
    await rm(path.join(roleDir, "AGENTS.md"), { force: true })
    await symlink(outsideFile, path.join(roleDir, "AGENTS.md"))
    assert.equal((await runSessionScript([validInbox], baseEnv)).code, 2)
    await rm(path.join(roleDir, "AGENTS.md"), { force: true })
    await writeFile(path.join(roleDir, "AGENTS.md"), "# 역할 지시\n", { mode: 0o600 })

    // 11. relay/inbox, relay/replies, relay/state, relay/session-work, relay 폴더가
    // 데이터 폴더 밖 실경로를 가리키는 심볼릭 링크이면 거부(종료 코드 2)
    for (const sub of ["inbox", "replies", "state", "session-work"]) {
      const targetSub = path.join(f.dir, "relay", sub)
      const backupSub = path.join(f.dir, "relay", `${sub}.bak`)
      const outSub = path.join(outsideDir, sub)
      await mkdir(outSub, { recursive: true, mode: 0o700 })
      if (sub === "inbox") {
        await writeFile(path.join(outSub, path.basename(validInbox)), await readFile(validInbox, "utf8"), { mode: 0o600 })
      }
      await rm(backupSub, { recursive: true, force: true })
      await rename(targetSub, backupSub).catch(() => undefined)
      await symlink(outSub, targetSub)
      const subRes = await runSessionScript([validInbox], baseEnv)
      assert.equal(subRes.code, 2, `relay/${sub} 심볼릭 링크는 종료 코드 2로 거부해야 한다`)
      assert.match(subRes.stderr, /역할 세션 실행 설정이나 인자를 확인해 주세요\./)
      await rm(targetSub, { force: true })
      await rename(backupSub, targetSub).catch(() => undefined)
    }

    // relay 폴더 자체가 외부 경로로 가는 심볼릭 링크인 경우 거부
    const relayDir = path.join(f.dir, "relay")
    const relayBak = path.join(f.dir, "relay-bak")
    await rename(relayDir, relayBak)
    await symlink(outsideDir, relayDir)
    assert.equal((await runSessionScript([validInbox], baseEnv)).code, 2)
    await rm(relayDir, { force: true })
    await rename(relayBak, relayDir)
  } finally {
    await rm(outsideDir, { recursive: true, force: true })
    await f.cleanup()
  }
})

test("relay-session-run.mjs: 격리 작업 칸·안내문·최소 환경·죽은 잠금 정리·이어 처리·경계 열쇠 가림", async () => {
  const f = await fixture()
  try {
    const workDir = path.join(f.dir, "role-workspace")
    await mkdir(workDir, { recursive: true, mode: 0o700 })
    const originalAgentsText = "# 기관 역할 지시 원본\n답변 규칙을 지킵니다.\n"
    await writeFile(path.join(workDir, "AGENTS.md"), originalAgentsText, { mode: 0o600 })

    const fakeSession = path.join(f.dir, "fake-session.mjs")
    const inspectOut = path.join(f.dir, "inspect.jsonl")
    await writeFile(
      fakeSession,
      `import { appendFileSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
const cwd = process.cwd();
const files = readdirSync(cwd).sort();
const q = JSON.parse(readFileSync("question.json", "utf8"));
const agents = readFileSync("AGENTS.md", "utf8");
const qMode = statSync("question.json").mode & 0o777;
const aMode = statSync("AGENTS.md").mode & 0o777;
const cwdMode = statSync(cwd).mode & 0o777;
appendFileSync(${JSON.stringify(inspectOut)}, JSON.stringify({
  cwd,
  cwdMode,
  files,
  qKeys: Object.keys(q).sort(),
  qMode,
  aMode,
  agents,
  prompt: process.argv[2] || "",
  argv: process.argv.slice(2),
  envKeys: Object.keys(process.env).sort(),
  body: q.body,
  sender: q.sender,
  timestamp: q.timestamp,
}) + "\\n");
// 청크 경계에 걸친 비밀 열쇠(syt_, sk-, Bearer, token=) 출력 시험
process.stdout.write("chunk1 token=syt_split");
await delay(30);
process.stdout.write("_secret_value_123 and sk-partOne");
await delay(30);
process.stdout.write("PartTwoKey999\\nBearer ");
await delay(30);
process.stdout.write("bearer_split_token_abc\\npassword=");
await delay(30);
process.stderr.write(" split_err syt_err1");
await delay(30);
process.stderr.write("2345_end\\n");
process.stdout.write("my_split_pass_xyz");
writeFileSync("answer.md", "역할답:" + q.body + "\\n", { mode: 0o600 });
`,
      { mode: 0o600 },
    )

    // 죽은 프로세스 번호가 남은 잠금 파일을 미리 둔다.
    const lockPath = path.join(f.dir, "relay", "session.lock")
    await writeFile(lockPath, `${JSON.stringify({ pid: 99999999, pgid: 99999998, at: Date.now(), heartbeatAt: Date.now() })}\n`, { mode: 0o600 })

    // 질문 두 개($q1, $q2)를 전달해 두고 첫 질문 경로로만 대본을 한 번 실행한다.
    const secretBody1 = "첫 질문 본문"
    const secretBody2 = "둘째 질문 본문"
    await f.relay.forward(f.question("$q1", "!room", secretBody1))
    await f.relay.forward(f.question("$q2", "!room", secretBody2))

    const runRes = await runSessionScript([f.inbox("$q1")], {
      PATH: process.env.PATH,
      HOME: "/tmp/role-home",
      AX_MESSENGER_DATA_DIR: f.dir,
      AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, fakeSession]),
      AX_RELAY_SESSION_DIR: workDir,
      AX_AI_API_KEY: "sk-must-not-pass",
      BOT_SECRET_TOKEN: "syt_must_not_pass",
    })
    assert.equal(runRes.code, 0, runRes.stderr)

    // 죽은 잠금을 치우고 실행 뒤 잠금을 해제했어야 한다.
    await assert.rejects(() => lstat(lockPath), { code: "ENOENT" })
    // 끝난 작업 칸은 지워져야 한다.
    assert.equal((await readdir(path.join(f.dir, "relay", "session-work"))).length, 0)

    // 첫 질문 처리 뒤 남은 질문($q2)까지 이어서 처리했어야 한다.
    const inspected = (await readFile(inspectOut, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    assert.equal(inspected.length, 2)
    assert.deepEqual(inspected.map((x) => x.body).sort(), [secretBody1, secretBody2].sort())
    const sessionWorkRoot = path.join(f.dir, "relay", "session-work")
    for (const item of inspected) {
      assert.ok(item.cwd.startsWith(sessionWorkRoot + path.sep), "작업 폴더는 relay/session-work/<id>-<무작위>여야 한다")
      assert.notEqual(item.cwd, workDir)
      assert.equal(item.cwdMode, 0o700)
      assert.deepEqual(item.files, ["AGENTS.md", "question.json"])
      assert.deepEqual(item.qKeys, ["body", "sender", "timestamp"], "question.json에는 방·이벤트 번호가 없어야 한다")
      assert.equal(item.qMode, 0o600)
      assert.equal(item.aMode, 0o600)
      assert.equal(item.agents, originalAgentsText)
      assert.equal(item.argv.length, 1)
      assert.equal(
        item.prompt,
        "이 폴더의 AGENTS.md 와 question.json 을 읽고 answer.md 에 답 문안만 써라, 다 쓰면 끝내라",
      )
      assert.ok(!item.prompt.includes("/"), "안내문에 절대 경로가 없어야 한다")
      assert.ok(!item.prompt.includes(relayName("$q1")) && !item.prompt.includes(relayName("$q2")), "안내문에 질문 해시가 없어야 한다")
      assert.ok(!item.prompt.includes(secretBody1))
      assert.ok(!item.prompt.includes(secretBody2))
      assert.ok(!item.envKeys.includes("AX_AI_API_KEY"))
      assert.ok(!item.envKeys.includes("BOT_SECRET_TOKEN"))
      assert.ok(!item.envKeys.includes("AX_MESSENGER_DATA_DIR"), "공유 데이터 폴더 경로를 세션 환경에 주지 않아야 한다")
      assert.ok(!item.envKeys.includes("AX_RELAY_SESSION_DIR"), "역할 작업 폴더 경로를 세션 환경에 주지 않아야 한다")
      assert.ok(!item.envKeys.includes("AX_RELAY_SESSION_CMD"))
    }
    assert.notEqual(inspected[0].cwd, inspected[1].cwd, "질문마다 서로 다른 작업 칸이어야 한다")

    // 봇이 poll 하면 두 답글이 모두 각자 원글에 올라간다.
    await f.relay.poll()
    assert.equal(f.sent.length, 2)
    const sentBodies = f.sent.map((x) => x.body.trim()).sort()
    assert.deepEqual(sentBodies, [`역할답:${secretBody1}`, `역할답:${secretBody2}`].sort())

    // session-log.jsonl(0600)과 session-out/<id>.log(0600, 폴더 0700) 및 경계에 걸친 열쇠 가림 확인
    const logFile = path.join(f.dir, "relay", "session-log.jsonl")
    assert.equal((await lstat(logFile)).mode & 0o777, 0o600)
    const logContent = await readFile(logFile, "utf8")
    assert.ok(!logContent.includes(secretBody1))
    assert.ok(!logContent.includes(secretBody2))
    const logRows = logContent.trim().split("\n").map((line) => JSON.parse(line))
    assert.equal(logRows.length, 2)
    for (const row of logRows) {
      assert.equal(typeof row.startedAt, "number")
      assert.equal(typeof row.endedAt, "number")
      assert.equal(row.exitCode, 0)
      assert.equal(typeof row.durationMs, "number")
      assert.match(row.file, /^[a-f0-9]{64}\.json$/)
    }
    const outDir = path.join(f.dir, "relay", "session-out")
    assert.equal((await lstat(outDir)).mode & 0o777, 0o700)
    const outLog = path.join(outDir, `${relayName("$q1")}.log`)
    assert.equal((await lstat(outLog)).mode & 0o777, 0o600)
    const outText = await readFile(outLog, "utf8")
    assert.ok(!outText.includes("syt_split_secret_value_123"), "청크 경계에 걸친 syt_ 토큰이 가려져야 한다")
    assert.ok(!outText.includes("sk-partOnePartTwoKey999"), "청크 경계에 걸친 sk- 열쇠가 가려져야 한다")
    assert.ok(!outText.includes("bearer_split_token_abc"), "청크 경계에 걸친 Bearer 토큰이 가려져야 한다")
    assert.ok(!outText.includes("my_split_pass_xyz"), "청크 경계에 걸친 password 값이 가려져야 한다")
    assert.ok(!outText.includes("syt_err12345_end"), "stderr 청크 경계에 걸친 토큰도 가려져야 한다")
    assert.match(outText, /\[REDACTED\]/)
  } finally { await f.cleanup() }
})

test("relay-session-run.mjs: 칸 밖(공유 replies·역할 폴더) 쓰기 시도 차단, 역할 사본만 변경, 링크·비정상 answer.md 버림, 기존 답 보존", async () => {
  const f = await fixture()
  try {
    const roleDir = path.join(f.dir, "role-workspace")
    await mkdir(roleDir, { recursive: true, mode: 0o700 })
    const originalAgents = "# 원본 역할 지시\n절대 바뀌면 안 됨\n"
    await writeFile(path.join(roleDir, "AGENTS.md"), originalAgents, { mode: 0o600 })

    await f.relay.forward(f.question("$victim", "!room2", "피해자 질문"))
    await f.relay.forward(f.question("$attacker", "!room1", "공격자 질문"))
    const victimHash = relayName("$victim")
    const attackerHash = relayName("$attacker")
    const sharedRepliesDir = path.join(f.dir, "relay", "replies")

    // 1. 공격자 세션이 (가) 칸 안 AGENTS.md 사본 덮어쓰기, (나) 공유 replies 폴더에 피해자 질문 이름으로 답 파일 쓰기 시도,
    // (다) 칸 안에 피해자 이름으로 파일 쓰기를 모두 시도해도
    // 원본 AGENTS.md 는 그대로이고 피해자 답 파일은 생기지 않으며 공격자 자신의 답만 올라간다.
    const attackScript = path.join(f.dir, "attack-session.mjs")
    await writeFile(
      attackScript,
      `import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const q = JSON.parse(readFileSync("question.json", "utf8"));
if (q.body === "공격자 질문") {
  // 칸 안 사본 AGENTS.md 변조(세션은 원본 역할 폴더 경로를 받지 않음)
  writeFileSync("AGENTS.md", "# 오염된 지시\\n", { mode: 0o600 });
  // 공유 replies 폴더에 피해자 해시로 직접 답 쓰기 시도(절대 경로 및 상대 경로)
  try { writeFileSync(${JSON.stringify(path.join(sharedRepliesDir, `${victimHash}.md`))}, "가로챈 가짜 답"); } catch {}
  try { writeFileSync(${JSON.stringify(path.join(sharedRepliesDir, `${victimHash}.md.ready`))}, ""); } catch {}
  try { writeFileSync(path.resolve(process.cwd(), "../../replies", ${JSON.stringify(`${victimHash}.md`)}), "상대경로 가짜 답"); } catch {}
  // 칸 안에 피해자 해시 파일 생성
  writeFileSync(${JSON.stringify(`${victimHash}.md`)}, "칸 안 다른 이름 답", { mode: 0o600 });
  writeFileSync("answer.md", "공격자 본인 답", { mode: 0o600 });
} else {
  const currentAgents = readFileSync("AGENTS.md", "utf8");
  writeFileSync("answer.md", "피해자 정상 답:" + (currentAgents.includes("절대 바뀌면 안 됨") ? "원본유지" : "오염됨"), { mode: 0o600 });
}
`,
      { mode: 0o600 },
    )

    const res1 = await runSessionScript([f.inbox("$attacker")], {
      PATH: process.env.PATH,
      AX_MESSENGER_DATA_DIR: f.dir,
      AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, attackScript]),
      AX_RELAY_SESSION_DIR: roleDir,
    })
    assert.equal(res1.code, 0, res1.stderr)
    assert.equal(await readFile(path.join(roleDir, "AGENTS.md"), "utf8"), originalAgents, "원본 역할 폴더의 AGENTS.md는 바뀌지 않아야 한다")
    await assert.rejects(() => lstat(path.join(roleDir, "injected.txt")), { code: "ENOENT" })
    assert.equal((await readFile(f.reply("$attacker"), "utf8")).trim(), "공격자 본인 답")
    assert.equal((await readFile(f.reply("$victim"), "utf8")).trim(), "피해자 정상 답:원본유지")

    await f.relay.poll()
    const victimSent = f.sent.find((s) => (s.content?.["m.relates_to"] as { "m.in_reply_to"?: { event_id?: string } })?.["m.in_reply_to"]?.event_id === "$victim")
    const attackerSent = f.sent.find((s) => (s.content?.["m.relates_to"] as { "m.in_reply_to"?: { event_id?: string } })?.["m.in_reply_to"]?.event_id === "$attacker")
    assert.equal(victimSent?.body, "피해자 정상 답:원본유지")
    assert.equal(attackerSent?.body, "공격자 본인 답")

    // 2. 가짜 세션이 칸 안 answer.md 를 다른 파일로 가는 심볼릭 링크로 만들거나, 폴더로 만들거나, 크기 상한 초과로 만들면 버리고 기록한다.
    const secretTarget = path.join(f.dir, "secret-target.txt")
    await writeFile(secretTarget, "절대 노출되면 안 되는 파일", { mode: 0o600 })
    await f.relay.forward(f.question("$symlink-ans", "!room1", "링크질문"))
    await f.relay.forward(f.question("$dir-ans", "!room1", "폴더질문"))
    await f.relay.forward(f.question("$huge-ans", "!room1", "큰답질문"))

    const badAnswerScript = path.join(f.dir, "bad-answer-session.mjs")
    await writeFile(
      badAnswerScript,
      `import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
const q = JSON.parse(readFileSync("question.json", "utf8"));
if (q.body === "링크질문") {
  symlinkSync(${JSON.stringify(secretTarget)}, "answer.md");
} else if (q.body === "폴더질문") {
  mkdirSync("answer.md", { mode: 0o700 });
} else if (q.body === "큰답질문") {
  writeFileSync("answer.md", "A".repeat(2048), { mode: 0o600 });
}
`,
      { mode: 0o600 },
    )
    const res2 = await runSessionScript([f.inbox("$symlink-ans")], {
      PATH: process.env.PATH,
      AX_MESSENGER_DATA_DIR: f.dir,
      AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, badAnswerScript]),
      AX_RELAY_SESSION_DIR: roleDir,
      AX_RELAY_SESSION_MAX_ANSWER_BYTES: "1024",
    })
    assert.equal(res2.code, 0, res2.stderr)
    await assert.rejects(() => lstat(f.reply("$symlink-ans")), { code: "ENOENT" })
    await assert.rejects(() => lstat(f.reply("$dir-ans")), { code: "ENOENT" })
    await assert.rejects(() => lstat(f.reply("$huge-ans")), { code: "ENOENT" })

    const logRows = (await readFile(path.join(f.dir, "relay", "session-log.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
    for (const id of ["$symlink-ans", "$dir-ans", "$huge-ans"]) {
      const row = logRows.find((r) => r.file === `${relayName(id)}.json`)
      assert.equal(row?.answerRejected, true, `${id}의 비정상 answer.md는 거부로 기록되어야 한다`)
    }

    // 3. 이미 replies/<id>.md 가 있으면(시작 전이든 실행 도중 생겼든) 덮지 않는다.
    await f.relay.forward(f.question("$existing-ans", "!room1", "기존답질문"))
    const overwriteScript = path.join(f.dir, "overwrite-session.mjs")
    const existingReplyPath = f.reply("$existing-ans")
    await writeFile(
      overwriteScript,
      `import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
await delay(250);
writeFileSync("answer.md", "새로 덮어쓴 답", { mode: 0o600 });
`,
      { mode: 0o600 },
    )
    // 세션이 시작된 뒤 외부에서 이미 replies/<id>.md 를 만들어 둔 상황을 재현한다.
    const injectTimer = setTimeout(async () => {
      await chmod(sharedRepliesDir, 0o700).catch(() => undefined)
      await writeFile(existingReplyPath, "원래 있던 답", { mode: 0o600 }).catch(() => undefined)
    }, 100)
    // repliesSnapshot 에 포함되게 시작 전에도 다른 질문($pre-existing)으로 확인하고,
    // 실행 도중 생긴 경우도 promoteValidatedAnswer 가 덮지 않음을 확인한다.
    await f.relay.forward(f.question("$pre-existing", "!room1", "시작전답질문"))
    const preExistingReplyPath = f.reply("$pre-existing")
    await writeFile(preExistingReplyPath, "시작 전부터 있던 답", { mode: 0o600 })
    const res3 = await runSessionScript([f.inbox("$existing-ans")], {
      PATH: process.env.PATH,
      AX_MESSENGER_DATA_DIR: f.dir,
      AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, overwriteScript]),
      AX_RELAY_SESSION_DIR: roleDir,
    })
    clearTimeout(injectTimer)
    assert.equal(res3.code, 0)
    assert.equal(await readFile(existingReplyPath, "utf8"), "원래 있던 답")
    assert.equal(await readFile(preExistingReplyPath, "utf8"), "시작 전부터 있던 답")
  } finally { await f.cleanup() }
})

test("relay-session-run.mjs: 잠금 중 두 번째 실행 즉시 종료(0), 기한 넘김 시 프로세스 그룹 전체 종료, 오래된 잠금의 남은 세션 그룹 종료와 옛 칸 답 미반영", async () => {
  const f = await fixture()
  try {
    const workDir = path.join(f.dir, "role-workspace")
    await mkdir(workDir, { recursive: true, mode: 0o700 })
    await writeFile(path.join(workDir, "AGENTS.md"), "# 역할 지시\n", { mode: 0o600 })

    // 1. 살아 있는 현재 프로세스 번호로 유효한 잠금을 잡은 상태에서 실행하면 즉시 0으로 끝난다.
    const lockPath = path.join(f.dir, "relay", "session.lock")
    await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, pgid: 0, at: Date.now(), heartbeatAt: Date.now() })}\n`, { mode: 0o600 })
    await f.relay.forward(f.question("$locked", "!room", "잠금대기질문"))
    const markerFile = path.join(f.dir, "should-not-run.txt")
    const lockedRes = await runSessionScript([f.inbox("$locked")], {
      PATH: process.env.PATH,
      AX_MESSENGER_DATA_DIR: f.dir,
      AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, "-e", `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(markerFile)}, 'ran')`]),
      AX_RELAY_SESSION_DIR: workDir,
      AX_RELAY_SESSION_TIMEOUT_MS: "5000",
    })
    assert.equal(lockedRes.code, 0)
    await assert.rejects(() => lstat(markerFile), { code: "ENOENT" })
    await rm(lockPath, { force: true })

    // 2. 기한 넘김 때 세션과 세션이 띄운 하위 자식 프로세스(같은 프로세스 그룹) 전체가 끝난다.
    await f.relay.forward(f.question("$slow", "!room", "느린질문"))
    await f.relay.forward(f.question("$fast", "!room", "빠른질문"))
    const slowHash = relayName("$slow")
    const grandchildPidFile = path.join(f.dir, "grandchild.pid")
    const sessionScript = path.join(f.dir, "timeout-then-fast.mjs")
    await writeFile(
      sessionScript,
      `import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const q = JSON.parse(readFileSync("question.json", "utf8"));
if (q.body === "느린질문") {
  // SIGTERM을 무시하는 하위 자식 프로세스를 같은 프로세스 그룹에 띄운다.
  const sub = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], {
    stdio: "ignore",
  });
  writeFileSync(${JSON.stringify(grandchildPidFile)}, String(sub.pid));
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else {
  writeFileSync("answer.md", "빠른 답글:" + q.body, { mode: 0o600 });
}
`,
      { mode: 0o600 },
    )
    const timeoutRes = await runSessionScript([f.inbox("$slow")], {
      PATH: process.env.PATH,
      AX_MESSENGER_DATA_DIR: f.dir,
      AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, sessionScript]),
      AX_RELAY_SESSION_DIR: workDir,
      AX_RELAY_SESSION_TIMEOUT_MS: "1000",
    })
    assert.equal(timeoutRes.code, 0, timeoutRes.stderr)
    const grandchildPid = Number((await readFile(grandchildPidFile, "utf8")).trim())
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0)
    assert.throws(() => process.kill(grandchildPid, 0), { code: "ESRCH" }, "기한 넘김 시 하위 자식 프로세스까지 그룹 전체가 끝나야 한다")

    // 기한 넘긴 질문($slow)에는 대본이 대체 문구를 쓰지 않는다.
    await assert.rejects(() => lstat(f.reply("$slow")), { code: "ENOENT" })
    // 잠금 중에 쌓였던 질문($locked)과 다음 질문($fast)은 모두 이어서 처리되어 답글이 올라간다.
    await f.relay.poll()
    assert.equal(f.sent.length, 2)

    const logRows = (await readFile(path.join(f.dir, "relay", "session-log.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    const slowLog = logRows.find((r) => r.file === `${slowHash}.json`)
    assert.equal(slowLog?.timedOut, true)

    // 3. 오래된 잠금 뒤 남은 세션 그룹을 먼저 끝내고 확인한 뒤 새 잠금을 잡으며, 옛 칸의 answer.md 는 옮겨지지 않는다.
    await f.relay.forward(f.question("$stale-q", "!room", "오래된잠금질문"))
    const staleWorkDir = path.join(f.dir, "relay", "session-work", `${relayName("$stale-q")}-${"0".repeat(16)}`)
    await mkdir(staleWorkDir, { recursive: true, mode: 0o700 })
    await writeFile(path.join(staleWorkDir, "answer.md"), "옛 칸의 답(절대 올라가면 안 됨)", { mode: 0o600 })

    // 새 프로세스 그룹(detached)으로 고아 세션 그룹을 띄우고 종료 시 옛 칸에 다시 answer.md를 쓰려 시도하게 한다.
    const orphanChild = spawn(
      process.execPath,
      [
        "-e",
        `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {
  try { writeFileSync(${JSON.stringify(path.join(staleWorkDir, "answer.md"))}, "종료직전 옛 칸 답"); } catch {}
  process.exit(0);
});
setInterval(() => {}, 1000);`,
      ],
      { detached: true, stdio: "ignore" },
    )
    const orphanPgid = orphanChild.pid!
    assert.ok(orphanPgid > 0)
    // 실행기(pid)는 죽었고 세션 그룹(pgid)은 살아 있는 오래된 잠금 기록
    await writeFile(
      lockPath,
      `${JSON.stringify({
        token: "stale-token",
        pid: 99999997,
        pgid: orphanPgid,
        at: Date.now() - 60_000,
        heartbeatAt: Date.now() - 60_000,
        workDir: staleWorkDir,
      })}\n`,
      { mode: 0o600 },
    )

    const freshSessionScript = path.join(f.dir, "fresh-session.mjs")
    await writeFile(
      freshSessionScript,
      `import { writeFileSync } from "node:fs";
// 새 세션은 answer.md 를 쓰지 않고 끝난다(옛 칸의 answer.md 가 옮겨지지 않는지 확인).
`,
      { mode: 0o600 },
    )
    const staleRecoveryRes = await runSessionScript([f.inbox("$stale-q")], {
      PATH: process.env.PATH,
      AX_MESSENGER_DATA_DIR: f.dir,
      AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, freshSessionScript]),
      AX_RELAY_SESSION_DIR: workDir,
      AX_RELAY_SESSION_TIMEOUT_MS: "2000",
    })
    assert.equal(staleRecoveryRes.code, 0, staleRecoveryRes.stderr)
    assert.throws(() => process.kill(-orphanPgid, 0), { code: "ESRCH" }, "오래된 잠금의 남은 세션 그룹이 끝났어야 한다")
    await assert.rejects(() => lstat(staleWorkDir), { code: "ENOENT" }, "옛 작업 칸은 지워져야 한다")
    await assert.rejects(() => lstat(f.reply("$stale-q")), { code: "ENOENT" }, "옛 칸의 answer.md가 옮겨지면 안 된다")
  } finally { await f.cleanup() }
})

test("relay-session-run.mjs: 운영자 역할 폴더 권한 불변 및 세션 중 원본 AGENTS.md 변경(크기·수정시각·SHA-256) 시 기록·비정상 종료·답 미반영", async () => {
  const f = await fixture()
  try {
    const roleDir = path.join(f.dir, "role-workspace-integrity")
    await mkdir(roleDir, { recursive: true, mode: 0o755 })
    await chmod(roleDir, 0o755)
    const agentsPath = path.join(roleDir, "AGENTS.md")
    const origText = "# 원본 역할 지시\n무결성 검증용 원본입니다.\n"
    await writeFile(agentsPath, origText, { mode: 0o640 })
    await chmod(agentsPath, 0o640)

    // 1. 세션 도중 원본 AGENTS.md 의 내용(SHA-256·크기)이 바뀌면 기록하고 종료 코드 != 0 이며 답을 옮기지 않는다.
    await f.relay.forward(f.question("$tamper-sha", "!room1", "원본변조질문"))
    const tamperShaScript = path.join(f.dir, "tamper-sha-session.mjs")
    await writeFile(
      tamperShaScript,
      `import { statSync, writeFileSync } from "node:fs";
// 세션 실행 중에도 운영자 역할 폴더와 원본 AGENTS.md 권한은 바뀌지 않아야 한다.
const dirMode = statSync(${JSON.stringify(roleDir)}).mode & 0o777;
const fileMode = statSync(${JSON.stringify(agentsPath)}).mode & 0o777;
if (dirMode !== 0o755 || fileMode !== 0o640) process.exit(22);
writeFileSync(${JSON.stringify(agentsPath)}, "# 세션 중 외부 변조됨\\n", { mode: 0o640 });
writeFileSync("answer.md", "변조된 세션의 답(올라가면 안 됨)", { mode: 0o600 });
`,
      { mode: 0o600 },
    )
    const resSha = await runSessionScript([f.inbox("$tamper-sha")], {
      PATH: process.env.PATH,
      AX_MESSENGER_DATA_DIR: f.dir,
      AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, tamperShaScript]),
      AX_RELAY_SESSION_DIR: roleDir,
    })
    assert.notEqual(resSha.code, 0, "원본 AGENTS.md 가 바뀌면 종료 코드가 0 이 아니어야 한다")
    assert.equal(resSha.code, 1)
    assert.match(resSha.stderr, /원본 AGENTS\.md 가 세션 중 변경되어/)
    await assert.rejects(() => lstat(f.reply("$tamper-sha")), { code: "ENOENT" }, "원본이 바뀌었으면 그 질문의 답은 옮기지 않아야 한다")
    assert.equal((await lstat(roleDir)).mode & 0o777, 0o755, "역할 폴더 모드는 그대로여야 한다")
    assert.equal((await lstat(agentsPath)).mode & 0o777, 0o640, "원본 AGENTS.md 모드는 그대로여야 한다")

    // 2. 내용과 크기가 같더라도 수정 시각(mtime)만 바뀐 경우도 감지해 기록·비정상 종료·답 미반영한다.
    await writeFile(agentsPath, origText, { mode: 0o640 })
    await chmod(agentsPath, 0o640)
    await f.relay.forward(f.question("$tamper-mtime", "!room1", "수정시각변조질문"))
    const tamperMtimeScript = path.join(f.dir, "tamper-mtime-session.mjs")
    await writeFile(
      tamperMtimeScript,
      `import { statSync, utimesSync, writeFileSync } from "node:fs";
const st = statSync(${JSON.stringify(agentsPath)});
const bumped = new Date(st.mtimeMs + 5000);
utimesSync(${JSON.stringify(agentsPath)}, bumped, bumped);
writeFileSync("answer.md", "mtime 변조 세션의 답(올라가면 안 됨)", { mode: 0o600 });
`,
      { mode: 0o600 },
    )
    const resMtime = await runSessionScript([f.inbox("$tamper-mtime")], {
      PATH: process.env.PATH,
      AX_MESSENGER_DATA_DIR: f.dir,
      AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, tamperMtimeScript]),
      AX_RELAY_SESSION_DIR: roleDir,
    })
    assert.notEqual(resMtime.code, 0, "수정 시각이 바뀌어도 종료 코드가 0 이 아니어야 한다")
    await assert.rejects(() => lstat(f.reply("$tamper-mtime")), { code: "ENOENT" })

    const logRows = (await readFile(path.join(f.dir, "relay", "session-log.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
    for (const id of ["$tamper-sha", "$tamper-mtime"]) {
      const row = logRows.find((r) => r.file === `${relayName(id)}.json`)
      assert.equal(row?.roleAgentsModified, true, `${id}는 roleAgentsModified: true 로 기록되어야 한다`)
      assert.equal(row?.answerRejected, true, `${id}는 answerRejected: true 로 기록되어야 한다`)
      assert.equal(row?.rejectReason, "ROLE_AGENTS_MODIFIED")
    }
  } finally { await f.cleanup() }
})

test("relay-session-run.mjs 및 ai-relay init: 공유 replies 원래 모드(0750) 복원, SIGKILL 뒤 (a) 대기 질문 없이 실행기 복원, (b) 봇 init 단독 복원(0700), (c) 활성 잠금 중 0500 유지, 역할 폴더 모드 불변", async () => {
  const f = await fixture()
  try {
    const roleDir = path.join(f.dir, "role-workspace-modes")
    await mkdir(roleDir, { recursive: true, mode: 0o755 })
    await chmod(roleDir, 0o755)
    const agentsPath = path.join(roleDir, "AGENTS.md")
    await writeFile(agentsPath, "# 역할 지시\n", { mode: 0o640 })
    await chmod(agentsPath, 0o640)

    const repliesDir = path.join(f.dir, "relay", "replies")
    const restorePath = path.join(f.dir, "relay", "session-restore.json")
    const lockPath = path.join(f.dir, "relay", "session.lock")

    // 1. 원래 모드가 0700 이 아닌 경우(0750)에도 정상 종료 뒤 정확히 0750 으로 돌아오고 session-restore.json 이 지워진다.
    await f.relay.forward(f.question("$mode-normal", "!room1", "모드확인질문"))
    await chmod(repliesDir, 0o750)
    const modeCheckOut = path.join(f.dir, "mode-check.json")
    const normalScript = path.join(f.dir, "normal-mode-session.mjs")
    await writeFile(
      normalScript,
      `import { readFileSync, statSync, writeFileSync } from "node:fs";
const repliesModeDuring = statSync(${JSON.stringify(repliesDir)}).mode & 0o777;
const restoreStat = statSync(${JSON.stringify(restorePath)});
const restoreData = JSON.parse(readFileSync(${JSON.stringify(restorePath)}, "utf8"));
const roleDirModeDuring = statSync(${JSON.stringify(roleDir)}).mode & 0o777;
const agentsModeDuring = statSync(${JSON.stringify(agentsPath)}).mode & 0o777;
writeFileSync(${JSON.stringify(modeCheckOut)}, JSON.stringify({
  repliesModeDuring,
  restoreFileMode: restoreStat.mode & 0o777,
  restoreRepliesMode: restoreData.repliesMode,
  roleDirModeDuring,
  agentsModeDuring,
}));
writeFileSync("answer.md", "정상답", { mode: 0o600 });
`,
      { mode: 0o600 },
    )
    const normalRes = await runSessionScript([f.inbox("$mode-normal")], {
      PATH: process.env.PATH,
      AX_MESSENGER_DATA_DIR: f.dir,
      AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, normalScript]),
      AX_RELAY_SESSION_DIR: roleDir,
    })
    assert.equal(normalRes.code, 0, normalRes.stderr)
    const duringInfo = JSON.parse(await readFile(modeCheckOut, "utf8"))
    assert.equal(duringInfo.repliesModeDuring, 0o500, "세션 중 공유 replies 는 0500 이어야 한다")
    assert.equal(duringInfo.restoreFileMode, 0o600, "session-restore.json 모드는 0600 이어야 한다")
    assert.equal(duringInfo.restoreRepliesMode, 0o750, "session-restore.json 에 원래 모드 0750 이 적혀야 한다")
    assert.equal(duringInfo.roleDirModeDuring, 0o755, "세션 중 역할 폴더 모드는 바뀌지 않아야 한다")
    assert.equal(duringInfo.agentsModeDuring, 0o640, "세션 중 AGENTS.md 모드는 바뀌지 않아야 한다")
    assert.equal((await lstat(repliesDir)).mode & 0o777, 0o750, "정상 종료 뒤 원래 모드 0750 으로 돌아와야 한다")
    await assert.rejects(() => lstat(restorePath), { code: "ENOENT" }, "복원 뒤 session-restore.json 은 지워져야 한다")
    assert.equal((await lstat(roleDir)).mode & 0o777, 0o755)
    assert.equal((await lstat(agentsPath)).mode & 0o777, 0o640)

    // 2. 실행기를 세션 도중 SIGKILL 한 뒤:
    //    (c) 살아 있는 잠금 중에는 봇 init() 이 0500 을 덮지 않음
    //    (a) 대기 질문 없이 실행기를 다시 돌리면 replies 가 원래 모드(0750)로 돌아옴
    await f.relay.forward(f.question("$sigkill-a", "!room1", "강제종료질문A"))
    await chmod(repliesDir, 0o750)
    const startedMarkerA = path.join(f.dir, "started-a.txt")
    const holdScript = path.join(f.dir, "hold-session.mjs")
    await writeFile(
      holdScript,
      `import { writeFileSync } from "node:fs";
const marker = process.env.HOLD_MARKER || "started.txt";
writeFileSync(marker, String(process.pid), { mode: 0o600 });
setInterval(() => {}, 1000);
`,
      { mode: 0o600 },
    )
    const runnerA = spawn(process.execPath, [sessionRunScript, f.inbox("$sigkill-a")], {
      env: {
        PATH: process.env.PATH,
        AX_MESSENGER_DATA_DIR: f.dir,
        AX_RELAY_SESSION_CMD: JSON.stringify(["/usr/bin/env", `HOLD_MARKER=${startedMarkerA}`, process.execPath, holdScript]),
        AX_RELAY_SESSION_DIR: roleDir,
        AX_RELAY_SESSION_TIMEOUT_MS: "30000",
      },
      stdio: "ignore",
    })
    // 세션이 시작되어 잠금과 0500 이 걸릴 때까지 대기
    for (let i = 0; i < 100; i++) {
      try {
        await lstat(startedMarkerA)
        const lockData = JSON.parse(await readFile(lockPath, "utf8"))
        if (lockData.pgid > 0 && ((await lstat(repliesDir)).mode & 0o777) === 0o500) break
      } catch { /* wait */ }
      await new Promise((r) => setTimeout(r, 30))
    }
    assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500)
    const lockDataA = JSON.parse(await readFile(lockPath, "utf8"))
    const sessionPgidA = Number(lockDataA.pgid)
    assert.ok(sessionPgidA > 0)

    // (c) 살아 있는 잠금 중에는 봇 init() 이 0500 을 덮지 않는다.
    await f.relay.init()
    assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500, "살아 있는 잠금 중에는 봇 init() 이 0500 을 덮지 않아야 한다")

    // 실행기를 SIGKILL 로 강제 종료
    const runnerAExited = new Promise<void>((resolve) => runnerA.once("close", () => resolve()))
    runnerA.kill("SIGKILL")
    await runnerAExited
    assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500, "SIGKILL 직후에는 0500 잠금 모드가 남아 있다")
    assert.equal(JSON.parse(await readFile(restorePath, "utf8")).repliesMode, 0o750)

    // 대기 질문이 없는 상태로 만든다(state 를 timeout 으로 변경).
    const stateRowA = JSON.parse(await readFile(f.state("$sigkill-a"), "utf8"))
    stateRowA.state = "timeout"
    stateRowA.audited = true
    await writeFile(f.state("$sigkill-a"), `${JSON.stringify(stateRowA)}\n`, { mode: 0o600 })

    // (a) 대기 질문 없이 실행기를 다시 돌리면 제일 먼저 남은 세션 그룹을 끝내고 replies 를 원래 모드(0750)로 되돌린다.
    const noPendingMarker = path.join(f.dir, "should-not-spawn.txt")
    const recoverResA = await runSessionScript([f.inbox("$sigkill-a")], {
      PATH: process.env.PATH,
      AX_MESSENGER_DATA_DIR: f.dir,
      AX_RELAY_SESSION_CMD: JSON.stringify([
        process.execPath,
        "-e",
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(noPendingMarker)}, "ran");`,
      ]),
      AX_RELAY_SESSION_DIR: roleDir,
      AX_RELAY_SESSION_TIMEOUT_MS: "5000",
    })
    assert.equal(recoverResA.code, 0, recoverResA.stderr)
    await assert.rejects(() => lstat(noPendingMarker), { code: "ENOENT" }, "대기 질문이 없으므로 새 세션은 띄우지 않아야 한다")
    assert.equal((await lstat(repliesDir)).mode & 0o777, 0o750, "대기 질문 없이 실행기를 돌려도 원래 모드 0750 으로 돌아와야 한다")
    await assert.rejects(() => lstat(restorePath), { code: "ENOENT" }, "복원 뒤 session-restore.json 은 지워져야 한다")
    await assert.rejects(() => lstat(lockPath), { code: "ENOENT" }, "잠금 파일도 해제되어야 한다")
    assert.throws(() => process.kill(-sessionPgidA, 0), { code: "ESRCH" }, "SIGKILL 된 실행기가 남긴 세션 그룹도 종료되어야 한다")
    assert.equal((await lstat(roleDir)).mode & 0o777, 0o755, "역할 폴더 모드는 전 과정에서 그대로여야 한다")
    assert.equal((await lstat(agentsPath)).mode & 0o777, 0o640, "AGENTS.md 모드는 전 과정에서 그대로여야 한다")

    // 3. (b) 실행기를 세션 도중 SIGKILL 한 뒤 실행기 없이 봇 init() 만 돌려도 오래된 잠금이면 0700 으로 돌아온다.
    await f.relay.forward(f.question("$sigkill-b", "!room1", "강제종료질문B"))
    await chmod(repliesDir, 0o750)
    const startedMarkerB = path.join(f.dir, "started-b.txt")
    const runnerB = spawn(process.execPath, [sessionRunScript, f.inbox("$sigkill-b")], {
      env: {
        PATH: process.env.PATH,
        AX_MESSENGER_DATA_DIR: f.dir,
        AX_RELAY_SESSION_CMD: JSON.stringify(["/usr/bin/env", `HOLD_MARKER=${startedMarkerB}`, process.execPath, holdScript]),
        AX_RELAY_SESSION_DIR: roleDir,
        AX_RELAY_SESSION_TIMEOUT_MS: "30000",
      },
      stdio: "ignore",
    })
    for (let i = 0; i < 100; i++) {
      try {
        await lstat(startedMarkerB)
        const lockData = JSON.parse(await readFile(lockPath, "utf8"))
        if (lockData.pgid > 0 && ((await lstat(repliesDir)).mode & 0o777) === 0o500) break
      } catch { /* wait */ }
      await new Promise((r) => setTimeout(r, 30))
    }
    const lockDataB = JSON.parse(await readFile(lockPath, "utf8"))
    const sessionPgidB = Number(lockDataB.pgid)
    const runnerBExited = new Promise<void>((resolve) => runnerB.once("close", () => resolve()))
    runnerB.kill("SIGKILL")
    await runnerBExited
    assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500)

    // 실행기 없이 봇 init() 만 호출: session-restore.json(원래 모드 0750)이 남아 있으므로 기본 모드(0700)로 덮지 않고 0500 유지 + 감사 기록
    await f.relay.init()
    assert.equal(
      (await lstat(repliesDir)).mode & 0o777,
      0o500,
      "죽은 잠금이더라도 session-restore.json 이 남아 있으면 봇 init() 이 기본 모드(0700)를 걸지 않고 0500 을 유지해야 한다",
    )

    // 살아 있는 PID 이지만 heartbeat 가 오래된 잠금이어도 session-restore.json 이 남아 있으면 봇 init() 은 0500 을 유지한다.
    await chmod(repliesDir, 0o500)
    await writeFile(
      lockPath,
      `${JSON.stringify({
        token: "stale-hb",
        pid: process.pid,
        pgid: 0,
        at: Date.now() - AX_RELAY_LOCK_WALL_CLOCK_MAX_MS - 10_000,
        heartbeatAt: Date.now() - AX_RELAY_LOCK_WALL_CLOCK_MAX_MS - 10_000,
        heartbeatStaleMs: 1_000,
        timeoutMs: 30_000,
      })}\n`,
      { mode: 0o600 },
    )
    await f.relay.init()
    assert.equal(
      (await lstat(repliesDir)).mode & 0o777,
      0o500,
      "heartbeat 가 오래된 잠금이더라도 session-restore.json 이 남아 있으면 봇 init() 이 0500 을 유지해야 한다",
    )

    // session-restore.json 이 없을 때(ENOENT)에만 죽은/만료 잠금 뒤 봇 init() 이 기본 모드 0700 을 건다.
    await rm(restorePath, { force: true })
    await f.relay.init()
    assert.equal(
      (await lstat(repliesDir)).mode & 0o777,
      0o700,
      "session-restore.json 이 ENOENT 일 때만 봇 init() 이 기본 모드 0700 을 걸어야 한다",
    )

    // 정리: 남은 자식 프로세스 그룹 종료
    try { process.kill(-sessionPgidB, "SIGKILL") } catch { /* ignore */ }
    await rm(lockPath, { force: true })
    await rm(restorePath, { force: true })
    assert.equal((await lstat(roleDir)).mode & 0o777, 0o755, "역할 폴더 모드는 전 과정에서 그대로여야 한다")
    assert.equal((await lstat(agentsPath)).mode & 0o777, 0o640, "AGENTS.md 모드는 전 과정에서 그대로여야 한다")
  } finally { await f.cleanup() }
})

test("relay-session-run.mjs: AX_RELAY_SESSION_CMD 에 claude 사용 시 --restricted 또는 --strict-mcp-config 누락 시작 거부(종료 코드 2), 가짜 세션 명령은 허용", async () => {
  const f = await fixture()
  try {
    await f.relay.forward(f.question("$claude-flag-check", "!room1", "플래그검사질문"))
    const roleDir = path.join(f.dir, "role-claude-flags")
    await mkdir(roleDir, { recursive: true, mode: 0o700 })
    await writeFile(path.join(roleDir, "AGENTS.md"), "# 역할 지시\n", { mode: 0o600 })

    // 실제 claude 명령을 절대 호출하지 않도록 존재하지 않는 경로의 claude 이름을 사용한다(설정 검증에서 먼저 거부됨).
    const fakeClaudeBin = path.join(f.dir, "nonexistent-bin", "claude")
    const baseEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      AX_MESSENGER_DATA_DIR: f.dir,
      AX_RELAY_SESSION_DIR: roleDir,
    }

    // 1. --strict-mcp-config 누락 시 시작 거부(종료 코드 2)
    const missingStrict = await runSessionScript([f.inbox("$claude-flag-check")], {
      ...baseEnv,
      AX_RELAY_SESSION_CMD: JSON.stringify([
        fakeClaudeBin,
        "-p",
        "--restricted",
        "--tools",
        "Read,Write,Edit",
      ]),
    })
    assert.equal(missingStrict.code, 2, "--strict-mcp-config 가 빠진 claude 설정은 종료 코드 2로 거부해야 한다")
    assert.match(missingStrict.stderr, /역할 세션 실행 설정이나 인자를 확인해 주세요\./)

    // 2. --restricted 누락 시 시작 거부(종료 코드 2)
    const missingRestricted = await runSessionScript([f.inbox("$claude-flag-check")], {
      ...baseEnv,
      AX_RELAY_SESSION_CMD: JSON.stringify([
        fakeClaudeBin,
        "-p",
        "--strict-mcp-config",
        "--tools",
        "Read,Write,Edit",
      ]),
    })
    assert.equal(missingRestricted.code, 2, "--restricted 가 빠진 claude 설정은 종료 코드 2로 거부해야 한다")
    assert.match(missingRestricted.stderr, /역할 세션 실행 설정이나 인자를 확인해 주세요\./)

    // 3. /usr/bin/env 경유로 claude 를 지정하면서 --strict-mcp-config 가 빠진 경우도 시작 거부(종료 코드 2)
    const envMissingStrict = await runSessionScript([f.inbox("$claude-flag-check")], {
      ...baseEnv,
      AX_RELAY_SESSION_CMD: JSON.stringify([
        "/usr/bin/env",
        "FOO=1",
        fakeClaudeBin,
        "-p",
        "--restricted",
      ]),
    })
    assert.equal(envMissingStrict.code, 2, "env 경유 claude 설정도 필수 격리 플래그 누락 시 거부해야 한다")

    // 4. 다른 명령(가짜 세션 등)은 막지 않는다.
    const fakeSession = path.join(f.dir, "allowed-fake-session.mjs")
    await writeFile(
      fakeSession,
      `import { writeFileSync } from "node:fs"; writeFileSync("answer.md", "가짜세션허용답", { mode: 0o600 });\n`,
      { mode: 0o600 },
    )
    const allowedRes = await runSessionScript([f.inbox("$claude-flag-check")], {
      ...baseEnv,
      AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, fakeSession]),
    })
    assert.equal(allowedRes.code, 0, allowedRes.stderr)
    assert.equal((await readFile(f.reply("$claude-flag-check"), "utf8")).trim(), "가짜세션허용답")
  } finally { await f.cleanup() }
})

test("relay-session-run.mjs: 고정된 기준 무결성 검사 — 링크로 바꿔치기, 같은 내용으로 파일 교체(inode 바뀜), 폴더 교체(폴더 inode 바뀜), 읽는 도중 크기·mtime 불일치 감지", async () => {
  const f = await fixture()
  try {
    const roleDir = path.join(f.dir, "role-fixed-integrity")
    await mkdir(roleDir, { recursive: true, mode: 0o755 })
    await chmod(roleDir, 0o755)
    const agentsPath = path.join(roleDir, "AGENTS.md")
    const origText = "# 고정 기준 무결성 검증 원본\n바뀌면 안 됩니다.\n"
    await writeFile(agentsPath, origText, { mode: 0o640 })
    await chmod(agentsPath, 0o640)

    // 1. 세션 중 원본 AGENTS.md 를 심볼릭 링크로 바꿔치기 -> 기록·종료 코드 1·답 미반영
    const outsideAgents = path.join(f.dir, "outside-agents.md")
    await writeFile(outsideAgents, origText, { mode: 0o640 })
    await f.relay.forward(f.question("$tamper-link", "!room1", "링크교체질문"))
    const tamperLinkScript = path.join(f.dir, "tamper-link-session.mjs")
    await writeFile(
      tamperLinkScript,
      `import { rmSync, symlinkSync, writeFileSync } from "node:fs";
rmSync(${JSON.stringify(agentsPath)}, { force: true });
symlinkSync(${JSON.stringify(outsideAgents)}, ${JSON.stringify(agentsPath)});
writeFileSync("answer.md", "링크 바꿔치기 답(올라가면 안 됨)", { mode: 0o600 });
`,
      { mode: 0o600 },
    )
    const resLink = await runSessionScript([f.inbox("$tamper-link")], {
      PATH: process.env.PATH,
      AX_MESSENGER_DATA_DIR: f.dir,
      AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, tamperLinkScript]),
      AX_RELAY_SESSION_DIR: roleDir,
    })
    assert.equal(resLink.code, 1, "AGENTS.md 를 링크로 바꿔치기하면 종료 코드 1이어야 한다")
    await assert.rejects(() => lstat(f.reply("$tamper-link")), { code: "ENOENT" }, "링크 바꿔치기 시 답을 옮기면 안 된다")

    // 복구 후 2번 시험 준비
    await rm(agentsPath, { force: true })
    await writeFile(agentsPath, origText, { mode: 0o640 })
    await chmod(agentsPath, 0o640)

    // 2. 같은 내용·같은 크기·같은 mtime 의 새 파일로 교체(rename 으로 inode 바뀜) -> 기록·종료 코드 1·답 미반영
    const beforeFileStat = await lstat(agentsPath)
    await f.relay.forward(f.question("$tamper-inode", "!room1", "파일아이노드교체질문"))
    const tamperInodeScript = path.join(f.dir, "tamper-inode-session.mjs")
    await writeFile(
      tamperInodeScript,
      `import { renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
const origSt = statSync(${JSON.stringify(agentsPath)});
const replacement = ${JSON.stringify(`${agentsPath}.replacement`)};
writeFileSync(replacement, ${JSON.stringify(origText)}, { mode: 0o640 });
// mtime 까지 원래 파일과 똑같이 맞춰도 inode 변경으로 잡아야 한다.
utimesSync(replacement, new Date(origSt.atimeMs), new Date(origSt.mtimeMs));
renameSync(replacement, ${JSON.stringify(agentsPath)});
writeFileSync("answer.md", "같은 내용 파일 교체 답(올라가면 안 됨)", { mode: 0o600 });
`,
      { mode: 0o600 },
    )
    const resInode = await runSessionScript([f.inbox("$tamper-inode")], {
      PATH: process.env.PATH,
      AX_MESSENGER_DATA_DIR: f.dir,
      AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, tamperInodeScript]),
      AX_RELAY_SESSION_DIR: roleDir,
    })
    const afterFileStat = await lstat(agentsPath)
    assert.notEqual(afterFileStat.ino, beforeFileStat.ino, "시험에서 실제로 파일 inode 가 바뀌었어야 한다")
    assert.equal(resInode.code, 1, "같은 내용·같은 mtime 이어도 파일 inode 가 바뀌면 종료 코드 1이어야 한다")
    await assert.rejects(() => lstat(f.reply("$tamper-inode")), { code: "ENOENT" }, "파일 교체 시 답을 옮기면 안 된다")

    // 3. 역할 폴더 자체를 새 폴더(같은 내용·같은 mtime 의 AGENTS.md 포함)로 교체(폴더 dev·inode 바뀜) -> 기록·종료 코드 1·답 미반영
    const beforeDirStat = await lstat(roleDir)
    await f.relay.forward(f.question("$tamper-dir", "!room1", "폴더교체질문"))
    const tamperDirScript = path.join(f.dir, "tamper-dir-session.mjs")
    const backupRoleDir = `${roleDir}-old`
    const replacementRoleDir = `${roleDir}-new`
    await writeFile(
      tamperDirScript,
      `import { mkdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
const origAgentsSt = statSync(${JSON.stringify(agentsPath)});
rmSync(${JSON.stringify(backupRoleDir)}, { recursive: true, force: true });
rmSync(${JSON.stringify(replacementRoleDir)}, { recursive: true, force: true });
mkdirSync(${JSON.stringify(replacementRoleDir)}, { mode: 0o755 });
const newAgents = path.join(${JSON.stringify(replacementRoleDir)}, "AGENTS.md");
writeFileSync(newAgents, ${JSON.stringify(origText)}, { mode: 0o640 });
utimesSync(newAgents, new Date(origAgentsSt.atimeMs), new Date(origAgentsSt.mtimeMs));
renameSync(${JSON.stringify(roleDir)}, ${JSON.stringify(backupRoleDir)});
renameSync(${JSON.stringify(replacementRoleDir)}, ${JSON.stringify(roleDir)});
writeFileSync("answer.md", "폴더 교체 답(올라가면 안 됨)", { mode: 0o600 });
`,
      { mode: 0o600 },
    )
    const resDir = await runSessionScript([f.inbox("$tamper-dir")], {
      PATH: process.env.PATH,
      AX_MESSENGER_DATA_DIR: f.dir,
      AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, tamperDirScript]),
      AX_RELAY_SESSION_DIR: roleDir,
    })
    const afterDirStat = await lstat(roleDir)
    assert.notEqual(afterDirStat.ino, beforeDirStat.ino, "시험에서 실제로 역할 폴더 inode 가 바뀌었어야 한다")
    assert.equal(resDir.code, 1, "역할 폴더가 교체되어 폴더 inode 가 바뀌면 종료 코드 1이어야 한다")
    await assert.rejects(() => lstat(f.reply("$tamper-dir")), { code: "ENOENT" }, "폴더 교체 시 답을 옮기면 안 된다")

    // session-log.jsonl 에 세 경우 모두 roleAgentsModified: true, answerRejected: true, rejectReason: ROLE_AGENTS_MODIFIED 가 기록되었는지 확인
    const logRows = (await readFile(path.join(f.dir, "relay", "session-log.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
    for (const id of ["$tamper-link", "$tamper-inode", "$tamper-dir"]) {
      const row = logRows.find((r) => r.file === `${relayName(id)}.json`)
      assert.equal(row?.roleAgentsModified, true, `${id}는 roleAgentsModified: true 로 기록되어야 한다`)
      assert.equal(row?.answerRejected, true, `${id}는 answerRejected: true 로 기록되어야 한다`)
      assert.equal(row?.rejectReason, "ROLE_AGENTS_MODIFIED", `${id}는 ROLE_AGENTS_MODIFIED 로 기록되어야 한다`)
    }

    // 4. 읽는 도중 크기·mtime 이 바뀌면(읽기 전후 fstat 불일치) 변조(valid: false)로 본다.
    const runnerMod = (await import(pathToFileURL(sessionRunScript).href)) as {
      snapshotRoleIntegrity: (
        dir: string,
        expectedReal: string,
        onDuringRead?: () => Promise<void>,
      ) => Promise<{ valid: boolean }>
    }
    const realRoleDir = await realpath(roleDir)
    const validSnap = await runnerMod.snapshotRoleIntegrity(roleDir, realRoleDir)
    assert.equal(validSnap.valid, true)

    // (a) 읽는 도중 파일 크기가 바뀐 경우
    const sizeChangedDuringRead = await runnerMod.snapshotRoleIntegrity(roleDir, realRoleDir, async () => {
      await appendFile(agentsPath, "\n추가줄")
    })
    assert.equal(sizeChangedDuringRead.valid, false, "읽는 도중 크기가 바뀌면(fstat 불일치) 변조로 보아야 한다")

    // (b) 읽는 도중 파일 수정 시각(mtime)만 바뀐 경우
    const stNow = await lstat(agentsPath)
    const mtimeChangedDuringRead = await runnerMod.snapshotRoleIntegrity(roleDir, realRoleDir, async () => {
      const bumped = new Date(stNow.mtimeMs + 10_000)
      await utimes(agentsPath, bumped, bumped)
    })
    assert.equal(mtimeChangedDuringRead.valid, false, "읽는 도중 mtime 이 바뀌면(fstat 불일치) 변조로 보아야 한다")
  } finally { await f.cleanup() }
})

test("잠금 프로세스 식별자(pid + starttime + boot_id): pid 재사용(starttime 다름)·boot_id 다름은 죽은 잠금으로 처리하고 정상 잠금은 건너뛰며 옛 꼴 잠금 호환 판단을 기록한다", async () => {
  const f = await fixture()
  try {
    const roleDir = path.join(f.dir, "role-proc-identity")
    await mkdir(roleDir, { recursive: true, mode: 0o700 })
    await writeFile(path.join(roleDir, "AGENTS.md"), "# 역할 지시\n", { mode: 0o600 })

    const repliesDir = path.join(f.dir, "relay", "replies")
    const lockPath = path.join(f.dir, "relay", "session.lock")
    const selfProc = readProcessIdentity(process.pid)
    assert.equal(selfProc.alive, true)
    assert.ok(selfProc.starttime.length > 0, "/proc/<pid>/stat 의 22번째 칸 starttime 을 읽어야 한다")
    assert.ok(selfProc.bootId.length > 0, "/proc/sys/kernel/random/boot_id 를 읽어야 한다")

    const fakeSession = path.join(f.dir, "proc-lock-session.mjs")
    const lockCapturedOut = path.join(f.dir, "captured-lock.json")
    await writeFile(
      fakeSession,
      `import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
const q = JSON.parse(readFileSync("question.json", "utf8"));
try { copyFileSync(${JSON.stringify(lockPath)}, ${JSON.stringify(lockCapturedOut)}); } catch {}
writeFileSync("answer.md", "식별자답:" + q.body, { mode: 0o600 });
`,
      { mode: 0o600 },
    )

    // 1. pid 는 살아 있으나 starttime 이 다른 잠금(PID 재사용 흉내, 벽시계가 뒤로 가 미래 시각인 경우까지 포함) ->
    //    봇 init() 과 실행기 모두 죽은 잠금으로 보고 복원·실행한다(재사용된 pid 인 현재 프로세스는 죽이지 않는다).
    await chmod(repliesDir, 0o500)
    await writeFile(
      lockPath,
      `${JSON.stringify({
        token: "reused-pid-lock",
        pid: process.pid,
        starttime: `${selfProc.starttime}999`,
        boot_id: selfProc.bootId,
        pgid: 0,
        at: Date.now() + 60_000,
        heartbeatAt: Date.now() + 60_000,
        heartbeatStaleMs: 60_000,
        timeoutMs: 300_000,
      })}\n`,
      { mode: 0o600 },
    )
    // (가) 봇 init() 이 죽은 잠금으로 보고 0500 을 0700 으로 복원
    await f.relay.init()
    assert.equal(
      (await lstat(repliesDir)).mode & 0o777,
      0o700,
      "pid 가 살아 있어도 starttime 이 다르면 봇 init() 은 죽은 잠금으로 보고 0700 으로 되돌려야 한다",
    )
    // (나) 실행기도 죽은 잠금으로 보고 새 잠금을 잡아 질문을 처리하며, 실제로 쓴 잠금 파일에는 starttime 과 boot_id 가 들어간다.
    await f.relay.forward(f.question("$pid-reused", "!room1", "PID재사용질문"))
    const resReused = await runSessionScript([f.inbox("$pid-reused")], {
      PATH: process.env.PATH,
      AX_MESSENGER_DATA_DIR: f.dir,
      AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, fakeSession]),
      AX_RELAY_SESSION_DIR: roleDir,
    })
    assert.equal(resReused.code, 0, resReused.stderr)
    assert.equal((await readFile(f.reply("$pid-reused"), "utf8")).trim(), "식별자답:PID재사용질문")
    const capturedLock = JSON.parse(await readFile(lockCapturedOut, "utf8"))
    const runnerIdentityCheck = readProcessIdentity(Number(capturedLock.pid))
    assert.equal(typeof capturedLock.starttime, "string")
    assert.ok(capturedLock.starttime.length > 0, "실행기 잠금 파일에 starttime 이 적혀야 한다")
    assert.equal(capturedLock.boot_id, selfProc.bootId, "실행기 잠금 파일에 boot_id 가 적혀야 한다")
    assert.equal(typeof capturedLock.elapsedMonoMs, "number", "실행기 잠금 파일에 단조 시계 경과 시간이 적혀야 한다")
    void runnerIdentityCheck

    // 2. pid 와 starttime 은 일치하나 boot_id 가 다른 잠금 -> 봇과 실행기 모두 죽은 잠금으로 본다.
    await chmod(repliesDir, 0o500)
    await writeFile(
      lockPath,
      `${JSON.stringify({
        token: "diff-boot-lock",
        pid: process.pid,
        starttime: selfProc.starttime,
        boot_id: selfProc.bootId.startsWith("0")
          ? "11111111-2222-4333-8444-555555555555"
          : "00000000-2222-4333-8444-555555555555",
        pgid: 0,
        at: Date.now(),
        heartbeatAt: Date.now(),
        heartbeatStaleMs: 60_000,
        timeoutMs: 300_000,
      })}\n`,
      { mode: 0o600 },
    )
    await f.relay.init()
    assert.equal(
      (await lstat(repliesDir)).mode & 0o777,
      0o700,
      "boot_id 가 다르면 봇 init() 은 죽은 잠금으로 보고 0700 으로 되돌려야 한다",
    )
    await f.relay.forward(f.question("$boot-diff", "!room1", "부트ID다름질문"))
    const resBootDiff = await runSessionScript([f.inbox("$boot-diff")], {
      PATH: process.env.PATH,
      AX_MESSENGER_DATA_DIR: f.dir,
      AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, fakeSession]),
      AX_RELAY_SESSION_DIR: roleDir,
    })
    assert.equal(resBootDiff.code, 0, resBootDiff.stderr)
    assert.equal((await readFile(f.reply("$boot-diff"), "utf8")).trim(), "식별자답:부트ID다름질문")

    // 3. 살아 있는 정상 잠금(pid 생존 + starttime 일치 + boot_id 일치, 시계가 뒤로 가 미래 시각인 경우 포함) ->
    //    봇 init() 은 0500 을 그대로 건너뛰고, 실행기도 새로 돌지 않고 즉시 0 으로 건너뛴다.
    await chmod(repliesDir, 0o500)
    await writeFile(
      lockPath,
      `${JSON.stringify({
        token: "valid-live-lock",
        pid: process.pid,
        starttime: selfProc.starttime,
        boot_id: selfProc.bootId,
        pgid: 0,
        // 시계가 뒤로 이동해 잠금 시각이 현재 벽시계보다 미래가 된 경우에도 오래됨으로 오판하지 않고 starttime·boot_id 대조를 우선한다.
        at: Date.now() + 120_000,
        heartbeatAt: Date.now() + 120_000,
        heartbeatStaleMs: 10_000,
        timeoutMs: 60_000,
      })}\n`,
      { mode: 0o600 },
    )
    await f.relay.init()
    assert.equal(
      (await lstat(repliesDir)).mode & 0o777,
      0o500,
      "살아 있는 정상 잠금(미래 시각 포함)에서는 봇 init() 이 0500 을 덮지 않고 건너뛰어야 한다",
    )
    await f.relay.forward(f.question("$skip-live", "!room1", "정상잠금건너뜀질문"))
    const skipRes = await runSessionScript([f.inbox("$skip-live")], {
      PATH: process.env.PATH,
      AX_MESSENGER_DATA_DIR: f.dir,
      AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, fakeSession]),
      AX_RELAY_SESSION_DIR: roleDir,
    })
    assert.equal(skipRes.code, 0)
    await assert.rejects(
      () => lstat(f.reply("$skip-live")),
      { code: "ENOENT" },
      "살아 있는 정상 잠금이 있으면 두 번째 실행기는 건너뛰어 답을 만들지 않아야 한다",
    )
    await rm(lockPath, { force: true })
    await chmod(repliesDir, 0o700)

    // 4. 옛 꼴 잠금(식별자 없음)은 pid 생존·heartbeat 로 판단하는 호환 길을 두고 그 판단을 기록한다.
    const botLogs: string[] = []
    const relayWithLog = createSessionRelay({ ...f.options, log: (line) => botLogs.push(line) })
    await chmod(repliesDir, 0o500)
    await writeFile(
      lockPath,
      `${JSON.stringify({
        pid: process.pid,
        pgid: 0,
        at: Date.now(),
        heartbeatAt: Date.now(),
        heartbeatStaleMs: 60_000,
        timeoutMs: 60_000,
      })}\n`,
      { mode: 0o600 },
    )
    await relayWithLog.init()
    assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500, "살아 있는 옛 꼴 잠금도 호환 경로로 유지되어야 한다")
    assert.ok(
      botLogs.some((l) => l.includes("legacy-compat") && l.includes("active=true")),
      "봇이 옛 꼴 잠금 호환 판단(active=true)을 기록해야 한다",
    )

    const legacySkipRes = await runSessionScript([f.inbox("$skip-live")], {
      PATH: process.env.PATH,
      AX_MESSENGER_DATA_DIR: f.dir,
      AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, fakeSession]),
      AX_RELAY_SESSION_DIR: roleDir,
    })
    assert.equal(legacySkipRes.code, 0)
    assert.match(legacySkipRes.stderr, /legacy-compat.*active=true/, "실행기도 옛 꼴 잠금 호환 판단을 기록해야 한다")
    await rm(lockPath, { force: true })
    await chmod(repliesDir, 0o700)
  } finally { await f.cleanup() }
})

function runSessionScriptWithHooks(
  args: string[],
  env: NodeJS.ProcessEnv,
  hooksExpr: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const inlineCode = `import { main, readProcessIdentity } from ${JSON.stringify(pathToFileURL(sessionRunScript).href)}; await main(${hooksExpr});`
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", inlineCode, "_", ...args],
      {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk.toString() })
    child.stderr.on("data", (chunk) => { stderr += chunk.toString() })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })
}

test("26회차: 죽은 잠금의 두 회수자 중 늦은 실행기는 새 잠금과 replies 모드를 보존", async () => {
  const f = await fixture()
  const marker = path.join(f.dir, "observed")
  const started = path.join(f.dir, "started")
  const release = path.join(f.dir, "release")
  const lock = path.join(f.dir, "relay", "session.lock")
  const replies = path.join(f.dir, "relay", "replies")
  const role = path.join(f.dir, "role-r26-lock")
  const session = path.join(f.dir, "hold-r26.mjs")
  const waitForFile = async (p: string) => {
    for (let i = 0; i < 200; i++) {
      try { await lstat(p); return } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`marker timeout: ${p}`)
  }
  let first: ReturnType<typeof runSessionScript> | undefined
  try {
    await mkdir(role)
    await writeFile(path.join(role, "AGENTS.md"), "role")
    await writeFile(session, `import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
writeFileSync(${JSON.stringify(started)}, "started");
while (!existsSync(${JSON.stringify(release)})) await delay(20);
`)
    await f.relay.forward(f.question("$r26-race"))
    await chmod(replies, 0o500)
    await writeFile(path.join(f.dir, "relay", "session-restore.json"), JSON.stringify({ repliesMode: 0o750 }))
    await writeFile(lock, JSON.stringify({ token: "dead-token", pid: 99999999, pgid: 0, at: Date.now() - 60000 }))
    const env = { PATH: process.env.PATH, AX_MESSENGER_DATA_DIR: f.dir, AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, session]), AX_RELAY_SESSION_DIR: role, AX_RELAY_SESSION_TIMEOUT_MS: "10000" }
    const second = runSessionScriptWithHooks([f.inbox("$r26-race")], env, `{
      readLockFile: async p => {
        const { readFile, stat, writeFile } = await import("node:fs/promises");
        const { existsSync } = await import("node:fs");
        const { setTimeout: delay } = await import("node:timers/promises");
        const body = await readFile(p, "utf8"); const opened = await stat(p);
        await writeFile(${JSON.stringify(marker)}, "observed");
        while (!existsSync(${JSON.stringify(started)})) await delay(20);
        return { body, opened };
      }
    }`)
    await waitForFile(marker)
    first = runSessionScript([f.inbox("$r26-race")], env)
    await waitForFile(started)
    const before = JSON.parse(await readFile(lock, "utf8"))
    const secondResult = await second
    assert.equal(secondResult.code, 1, secondResult.stderr)
    assert.equal(JSON.parse(await readFile(lock, "utf8")).token, before.token)
    assert.equal((await lstat(replies)).mode & 0o777, 0o500)
    await writeFile(release, "release")
    assert.equal((await first).code, 0)
  } finally {
    await writeFile(release, "release").catch(() => undefined)
    if (first) await first
    await f.cleanup()
  }
})

test("26회차: heartbeat 가 소유권 상실을 감지하면 세션 자식을 종료하고 실패", async () => {
  const f = await fixture()
  const role = path.join(f.dir, "role-r26-loss")
  const started = path.join(f.dir, "loss-started")
  const session = path.join(f.dir, "loss-session.mjs")
  const lock = path.join(f.dir, "relay", "session.lock")
  try {
    await mkdir(role)
    await writeFile(path.join(role, "AGENTS.md"), "role")
    await writeFile(session, `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(started)}, "started");
setInterval(() => {}, 1000);
`)
    await f.relay.forward(f.question("$r26-loss"))
    const env = { PATH: process.env.PATH, AX_MESSENGER_DATA_DIR: f.dir, AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, session]), AX_RELAY_SESSION_DIR: role, AX_RELAY_SESSION_TIMEOUT_MS: "10000" }
    const running = runSessionScript([f.inbox("$r26-loss")], env)
    let seen = false
    for (let i = 0; i < 200; i++) {
      try { await lstat(started); seen = true; break } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.ok(seen, "세션 시작 확인")
    const replacement = `${lock}.replacement`
    await writeFile(replacement, JSON.stringify({ token: "foreign", pid: process.pid, pgid: 0, at: Date.now() }))
    await rename(replacement, lock)
    const result = await running
    assert.equal(result.code, 1, result.stderr)
    assert.match(result.stderr, /lock-lost/)
    assert.equal(JSON.parse(await readFile(lock, "utf8")).token, "foreign")
    await assert.rejects(() => lstat(f.reply("$r26-loss")), { code: "ENOENT" })
  } finally { await f.cleanup() }
})

test("단조 기준 heartbeat(heartbeatUptimeMs): 벽시계 앞뒤 점프(±1일)에도 살아 있는 잠금·replies 0500 유지 및 회수 방지, 단조 heartbeat 만료 시 벽시계 무관 회수·복원, /proc/uptime 불능 안전 쪽 유지, 단조 칸 없는 옛 꼴 잠금 호환 기록", async () => {
  const f = await fixture()
  let liveRunner: ReturnType<typeof spawn> | null = null
  let liveSessionPgid = 0
  try {
    const roleDir = path.join(f.dir, "role-monotonic-hb")
    await mkdir(roleDir, { recursive: true, mode: 0o755 })
    await chmod(roleDir, 0o755)
    await writeFile(path.join(roleDir, "AGENTS.md"), "# 역할 지시\n", { mode: 0o640 })

    const repliesDir = path.join(f.dir, "relay", "replies")
    const restorePath = path.join(f.dir, "relay", "session-restore.json")
    const lockPath = path.join(f.dir, "relay", "session.lock")

    const initialUptime = readUptimeMs()
    assert.ok(typeof initialUptime === "number" && initialUptime > 0, "/proc/uptime 첫 칸 단조 시간을 밀리초로 읽어야 한다")

    // 실제 첫 번째 실행기를 띄워 세션을 돌게 하고 잠금(session.lock)과 replies 0500 잠금(원래 모드 0750)을 잡게 한다.
    await f.relay.forward(f.question("$mono-hold", "!room1", "단조잠금유지질문"))
    await f.relay.forward(f.question("$mono-second", "!room1", "두번째실행기질문"))
    await chmod(repliesDir, 0o750)

    const holdStartedMarker = path.join(f.dir, "mono-hold-started.txt")
    const holdReleaseFile = path.join(f.dir, "mono-hold-release.txt")
    const holdOrAnswerScript = path.join(f.dir, "mono-hold-or-answer.mjs")
    await writeFile(
      holdOrAnswerScript,
      `import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
const q = JSON.parse(readFileSync("question.json", "utf8"));
if (q.body === "단조잠금유지질문") {
  writeFileSync(${JSON.stringify(holdStartedMarker)}, String(process.pid), { mode: 0o600 });
  while (!existsSync(${JSON.stringify(holdReleaseFile)})) {
    await delay(50);
  }
  writeFileSync("answer.md", "첫세션답:" + q.body, { mode: 0o600 });
} else {
  writeFileSync("answer.md", "회수후답:" + q.body, { mode: 0o600 });
}
`,
      { mode: 0o600 },
    )

    liveRunner = spawn(process.execPath, [sessionRunScript, f.inbox("$mono-hold")], {
      env: {
        PATH: process.env.PATH,
        AX_MESSENGER_DATA_DIR: f.dir,
        AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, holdOrAnswerScript]),
        AX_RELAY_SESSION_DIR: roleDir,
        AX_RELAY_SESSION_TIMEOUT_MS: "30000",
      },
      stdio: "ignore",
    })

    for (let i = 0; i < 120; i++) {
      try {
        await lstat(holdStartedMarker)
        const lockObj = JSON.parse(await readFile(lockPath, "utf8"))
        if (lockObj.pgid > 0 && ((await lstat(repliesDir)).mode & 0o777) === 0o500) break
      } catch { /* wait */ }
      await new Promise((r) => setTimeout(r, 30))
    }

    const activeLock = JSON.parse(await readFile(lockPath, "utf8"))
    const liveRunnerPid = Number(activeLock.pid)
    liveSessionPgid = Number(activeLock.pgid)
    assert.equal(liveRunnerPid, liveRunner.pid)
    assert.ok(liveSessionPgid > 0)
    assert.equal(typeof activeLock.heartbeatUptimeMs, "number", "session.lock 에 heartbeatUptimeMs 단조 칸이 적혀야 한다")
    assert.ok(activeLock.heartbeatUptimeMs >= initialUptime, "heartbeatUptimeMs 는 부팅 뒤 경과 시간이어야 한다")
    assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500)

    const ONE_DAY_MS = 86_400_000

    // 1. 벽시계가 앞으로 크게(1일) 뛰어도 식별자(pid·starttime·boot_id)가 맞고 단조 heartbeatUptimeMs 가 새것이면
    //    살아 있는 잠금으로 보고 봇 init() 이 replies 모드(0500)를 바꾸지 않으며, 두 번째 실행기가 세션을 회수하지 않는다.
    const botFuture1d = createSessionRelay({
      ...f.options,
      now: () => Date.now() + ONE_DAY_MS,
    })
    await botFuture1d.init()
    assert.equal(
      (await lstat(repliesDir)).mode & 0o777,
      0o500,
      "벽시계가 앞으로 1일 뛰어도 단조 heartbeat 가 새것이면 봇 init() 이 replies 0500 모드를 바꾸면 안 된다",
    )

    const secondFutureRes = await runSessionScriptWithHooks(
      [f.inbox("$mono-second")],
      {
        PATH: process.env.PATH,
        AX_MESSENGER_DATA_DIR: f.dir,
        AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, holdOrAnswerScript]),
        AX_RELAY_SESSION_DIR: roleDir,
        AX_RELAY_SESSION_TIMEOUT_MS: "5000",
      },
      `{ now: () => Date.now() + ${ONE_DAY_MS} }`,
    )
    assert.equal(secondFutureRes.code, 0, secondFutureRes.stderr)
    assert.equal(readProcessIdentity(liveRunnerPid).alive, true, "벽시계가 앞으로 1일 뛰어도 첫 실행기가 회수되면 안 된다")
    assert.doesNotThrow(() => process.kill(-liveSessionPgid, 0), "벽시계가 앞으로 1일 뛰어도 첫 세션 프로세스 그룹이 살아 있어야 한다")
    assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500, "두 번째 실행기 건너뜀 뒤에도 replies 는 0500 이어야 한다")
    assert.equal(JSON.parse(await readFile(lockPath, "utf8")).pid, liveRunnerPid, "잠금 소유자가 그대로 유지되어야 한다")
    await assert.rejects(() => lstat(f.reply("$mono-second")), { code: "ENOENT" }, "두 번째 실행기가 세션을 돌리면 안 된다")

    // 2. 벽시계가 뒤로 크게(1일) 뛰어도 마찬가지로 살아 있는 잠금으로 보고 replies 모드를 바꾸지 않으며 회수하지 않는다.
    const botPast1d = createSessionRelay({
      ...f.options,
      now: () => Date.now() - ONE_DAY_MS,
    })
    await botPast1d.init()
    assert.equal(
      (await lstat(repliesDir)).mode & 0o777,
      0o500,
      "벽시계가 뒤로 1일 뛰어도 단조 heartbeat 가 새것이면 봇 init() 이 replies 0500 모드를 바꾸면 안 된다",
    )

    const secondPastRes = await runSessionScriptWithHooks(
      [f.inbox("$mono-second")],
      {
        PATH: process.env.PATH,
        AX_MESSENGER_DATA_DIR: f.dir,
        AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, holdOrAnswerScript]),
        AX_RELAY_SESSION_DIR: roleDir,
        AX_RELAY_SESSION_TIMEOUT_MS: "5000",
      },
      `{ now: () => Date.now() - ${ONE_DAY_MS} }`,
    )
    assert.equal(secondPastRes.code, 0, secondPastRes.stderr)
    assert.equal(readProcessIdentity(liveRunnerPid).alive, true, "벽시계가 뒤로 1일 뛰어도 첫 실행기가 회수되면 안 된다")
    assert.doesNotThrow(() => process.kill(-liveSessionPgid, 0), "벽시계가 뒤로 1일 뛰어도 첫 세션 그룹이 살아 있어야 한다")
    assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500)
    await assert.rejects(() => lstat(f.reply("$mono-second")), { code: "ENOENT" })

    // 3. /proc/uptime 을 읽지 못하는 환경(uptimeMs: () => null)에서도 안전 쪽(살아 있는 잠금을 회수하지 않는 쪽)을 택한다.
    const botNoUptime = createSessionRelay({
      ...f.options,
      now: () => Date.now() + ONE_DAY_MS,
      uptimeMs: () => null,
    })
    await botNoUptime.init()
    assert.equal(
      (await lstat(repliesDir)).mode & 0o777,
      0o500,
      "/proc/uptime 을 읽지 못할 때도 살아 있는 잠금의 replies 0500 모드를 덮어쓰면 안 된다",
    )
    const secondNoUptimeRes = await runSessionScriptWithHooks(
      [f.inbox("$mono-second")],
      {
        PATH: process.env.PATH,
        AX_MESSENGER_DATA_DIR: f.dir,
        AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, holdOrAnswerScript]),
        AX_RELAY_SESSION_DIR: roleDir,
        AX_RELAY_SESSION_TIMEOUT_MS: "5000",
      },
      `{ now: () => Date.now() + ${ONE_DAY_MS}, uptimeMs: () => null }`,
    )
    assert.equal(secondNoUptimeRes.code, 0, secondNoUptimeRes.stderr)
    assert.equal(readProcessIdentity(liveRunnerPid).alive, true, "/proc/uptime 읽기 실패 시에도 살아 있는 실행기를 회수하면 안 된다")
    assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500)

    // 4. 단조 heartbeat 가 실제로 오래되면(실행기가 멈춤) 벽시계와 상관없이(벽시계가 과거로 1일 뛰었거나 그대로여도)
    //    죽은 잠금으로 보고 17회차처럼 회수·복원한다.
    //    실제 프로세스에 SIGSTOP 을 보내지 않고 단조 시계(uptimeMs) 주입만으로 stale 기준 너머로 전진시켜 확인한다.
    const stoppedLock = JSON.parse(await readFile(lockPath, "utf8"))
    const staleUptimeMs = Number(stoppedLock.heartbeatUptimeMs) + Number(stoppedLock.heartbeatStaleMs || 10_000) + 60_000

    // (가) 벽시계는 과거(-1일)이지만 단조 heartbeat 가 오래된 상태에서 봇 init() 은 죽은 잠금으로 보되,
    //      session-restore.json(0750)이 남아 있으므로 기본 모드(0700)를 덮어쓰지 않고 0500 을 유지하며 감사 기록을 남긴다.
    const botStaleMono = createSessionRelay({
      ...f.options,
      now: () => Date.now() - ONE_DAY_MS,
      uptimeMs: () => staleUptimeMs,
    })
    await botStaleMono.init()
    assert.equal(
      (await lstat(repliesDir)).mode & 0o777,
      0o500,
      "단조 heartbeat 가 오래되어 잠금이 만료되었더라도 session-restore.json 이 남아 있으면 봇 init() 이 기본 모드(0700)를 걸지 않고 0500 을 유지해야 한다",
    )

    // (나) 다시 0500 잠금 상태로 두고(session-restore.json 에 원래 모드 0750 유지),
    //      벽시계는 과거(-1일)이지만 단조 heartbeat 가 오래된 상태에서 두 번째 실행기를 돌리면
    //      멈춘 첫 실행기와 세션 그룹을 회수·종료하고 replies 를 0750 으로 복원한 뒤 대기 질문을 처리한다.
    await chmod(repliesDir, 0o500)
    // $mono-hold 는 이미 완료 처리해 두고 $mono-second 만 남긴 상태에서 회수·처리 확인
    const holdState = JSON.parse(await readFile(f.state("$mono-hold"), "utf8"))
    holdState.state = "timeout"
    holdState.audited = true
    await writeFile(f.state("$mono-hold"), `${JSON.stringify(holdState)}\n`, { mode: 0o600 })

    const evictMonoRes = await runSessionScriptWithHooks(
      [f.inbox("$mono-second")],
      {
        PATH: process.env.PATH,
        AX_MESSENGER_DATA_DIR: f.dir,
        AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, holdOrAnswerScript]),
        AX_RELAY_SESSION_DIR: roleDir,
        AX_RELAY_SESSION_TIMEOUT_MS: "5000",
      },
      `{ now: () => Date.now() - ${ONE_DAY_MS}, uptimeMs: () => ${staleUptimeMs} }`,
    )
    assert.equal(evictMonoRes.code, 0, evictMonoRes.stderr)
    assert.equal(readProcessIdentity(liveRunnerPid).alive, false, "단조 heartbeat 가 만료된 멈춘 실행기는 회수·종료되어야 한다")
    assert.throws(() => process.kill(-liveSessionPgid, 0), { code: "ESRCH" }, "멈춘 실행기의 세션 프로세스 그룹도 종료되어야 한다")
    liveRunner = null
    liveSessionPgid = 0
    assert.equal((await lstat(repliesDir)).mode & 0o777, 0o750, "회수·실행 종료 뒤 원래 모드(0750)로 복원되어야 한다")
    await assert.rejects(() => lstat(restorePath), { code: "ENOENT" }, "복원 뒤 session-restore.json 은 지워져야 한다")
    await assert.rejects(() => lstat(lockPath), { code: "ENOENT" }, "실행 완료 뒤 session.lock 은 해제되어야 한다")
    assert.equal((await readFile(f.reply("$mono-second"), "utf8")).trim(), "회수후답:두번째실행기질문")

    // 5. 단조 칸(heartbeatUptimeMs)이 없는 옛 꼴 잠금(starttime·boot_id 만 있는 17회차 잠금 포함)은
    //    null 과 같게 25시간 벽시계 상한 규칙으로 판정하되 봇과 실행기 모두 legacy-compat 판단을 기록한다.
    const dummyLegacyRunner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
    const dummyPid = dummyLegacyRunner.pid!
    const dummyProc = readProcessIdentity(dummyPid)
    assert.equal(dummyProc.alive, true)
    const legacyExpiredMs = AX_RELAY_LOCK_WALL_CLOCK_MAX_MS + 60_000
    const compatLogs: string[] = []
    const relayCompat = createSessionRelay({
      ...f.options,
      now: () => Date.now() + legacyExpiredMs,
      log: (line) => compatLogs.push(line),
    })
    await chmod(repliesDir, 0o500)
    await writeFile(
      lockPath,
      `${JSON.stringify({
        token: "r17-legacy-no-uptime",
        pid: dummyPid,
        starttime: dummyProc.starttime,
        boot_id: dummyProc.bootId,
        pgid: 0,
        at: Date.now(),
        heartbeatAt: Date.now(),
        heartbeatStaleMs: 10_000,
        timeoutMs: 60_000,
      })}\n`,
      { mode: 0o600 },
    )
    // 단조 칸이 없고 25시간 벽시계 상한을 넘었으므로 stale(active=false)로 판단하고 legacy-compat 및 벽시계 상한 회수를 기록해야 한다.
    await relayCompat.init()
    assert.equal((await lstat(repliesDir)).mode & 0o777, 0o700, "단조 칸 없는 옛 꼴 잠금이 벽시계 기준 만료면 0700 으로 복원해야 한다")
    assert.ok(
      compatLogs.some((l) => l.includes("legacy-compat") && l.includes("active=false")),
      "단조 칸 없는 옛 꼴 잠금에 대해 봇이 legacy-compat active=false 를 기록해야 한다",
    )

    await f.relay.forward(f.question("$legacy-evict", "!room1", "옛잠금회수질문"))
    const legacyEvictRes = await runSessionScriptWithHooks(
      [f.inbox("$legacy-evict")],
      {
        PATH: process.env.PATH,
        AX_MESSENGER_DATA_DIR: f.dir,
        AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, holdOrAnswerScript]),
        AX_RELAY_SESSION_DIR: roleDir,
        AX_RELAY_SESSION_TIMEOUT_MS: "5000",
      },
      `{ now: () => Date.now() + ${legacyExpiredMs} }`,
    )
    assert.equal(legacyEvictRes.code, 0, legacyEvictRes.stderr)
    assert.match(legacyEvictRes.stderr, /legacy-compat.*active=false/, "실행기도 단조 칸 없는 옛 꼴 잠금 호환 판단(active=false)을 기록해야 한다")
    assert.equal(readProcessIdentity(dummyPid).alive, false, "만료된 옛 꼴 잠금의 실행기 프로세스도 회수·종료되어야 한다")
    assert.equal((await readFile(f.reply("$legacy-evict"), "utf8")).trim(), "회수후답:옛잠금회수질문")
    const logRows = (await readFile(path.join(f.dir, "relay", "session-log.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
    const legacyRow = logRows.find((r) => r.file === `${relayName("$legacy-evict")}.json`)
    assert.equal(legacyRow?.legacyLockCompat, "stale", "session-log.jsonl 에도 legacyLockCompat: stale 이 기록되어야 한다")
  } finally {
    if (liveRunner?.pid) {
      try { process.kill(liveRunner.pid, "SIGKILL") } catch { /* ignore */ }
    }
    if (liveSessionPgid > 0) {
      try { process.kill(-liveSessionPgid, "SIGKILL") } catch { /* ignore */ }
    }
    await f.cleanup()
  }
})

test("단조 값 없음(heartbeatUptimeMs null / /proc/uptime 실패) 벽시계 상한 회수·멈춤(T/t)/좀비(Z) 판정·운영 복구(--reclaim-lock)", async () => {
  const f = await fixture()
  let liveRunner: ReturnType<typeof spawn> | null = null
  let liveSessionPgid = 0
  let liveRunner2: ReturnType<typeof spawn> | null = null
  let liveSessionPgid2 = 0
  try {
    const roleDir = path.join(f.dir, "role-r19-wall-max")
    await mkdir(roleDir, { recursive: true, mode: 0o755 })
    await chmod(roleDir, 0o755)
    await writeFile(path.join(roleDir, "AGENTS.md"), "# 역할 지시\n", { mode: 0o640 })

    const repliesDir = path.join(f.dir, "relay", "replies")
    const restorePath = path.join(f.dir, "relay", "session-restore.json")
    const lockPath = path.join(f.dir, "relay", "session.lock")
    const sessionLogPath = path.join(f.dir, "relay", "session-log.jsonl")

    assert.equal(AX_RELAY_LOCK_WALL_CLOCK_MAX_MS, 90_000_000)
    assert.equal(AX_RELAY_LOCK_WALL_CLOCK_RECLAIM_REASON, "단조 값 없음 → 벽시계 상한 회수")

    await f.relay.forward(f.question("$r19-hold", "!room1", "단조값없는세션유지"))
    await f.relay.forward(f.question("$r19-next", "!room1", "단조값없음상한회수후질문"))
    await chmod(repliesDir, 0o750)

    const holdStartedMarker = path.join(f.dir, "r19-hold-started.txt")
    const holdReleaseFile = path.join(f.dir, "r19-hold-release.txt")
    const holdOrAnswerScript = path.join(f.dir, "r19-hold-or-answer.mjs")
    await writeFile(
      holdOrAnswerScript,
      `import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
const q = JSON.parse(readFileSync("question.json", "utf8"));
if (q.body.startsWith("단조값없는세션유지")) {
  writeFileSync(${JSON.stringify(holdStartedMarker)}, String(process.pid), { mode: 0o600 });
  while (!existsSync(${JSON.stringify(holdReleaseFile)})) {
    await delay(50);
  }
  writeFileSync("answer.md", "유지세션답:" + q.body, { mode: 0o600 });
} else {
  writeFileSync("answer.md", "상한회수답:" + q.body, { mode: 0o600 });
}
`,
      { mode: 0o600 },
    )

    // 첫 실행기를 uptimeMs: () => null 로 띄워 session.lock 에 heartbeatUptimeMs: null 이 기록되게 한다.
    const inlineRunnerCode = `import { main } from ${JSON.stringify(pathToFileURL(sessionRunScript).href)}; await main({ uptimeMs: () => null });`
    liveRunner = spawn(
      process.execPath,
      ["--input-type=module", "-e", inlineRunnerCode, "_", f.inbox("$r19-hold")],
      {
        env: {
          PATH: process.env.PATH,
          AX_MESSENGER_DATA_DIR: f.dir,
          AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, holdOrAnswerScript]),
          AX_RELAY_SESSION_DIR: roleDir,
          AX_RELAY_SESSION_TIMEOUT_MS: "30000",
        },
        stdio: "ignore",
      },
    )

    for (let i = 0; i < 120; i++) {
      try {
        await lstat(holdStartedMarker)
        const lockObj = JSON.parse(await readFile(lockPath, "utf8"))
        if (lockObj.pgid > 0 && ((await lstat(repliesDir)).mode & 0o777) === 0o500) break
      } catch { /* wait */ }
      await new Promise((r) => setTimeout(r, 30))
    }

    const activeLock = JSON.parse(await readFile(lockPath, "utf8"))
    const liveRunnerPid = Number(activeLock.pid)
    liveSessionPgid = Number(activeLock.pgid)
    assert.equal(liveRunnerPid, liveRunner.pid)
    assert.ok(liveSessionPgid > 0)
    assert.equal(activeLock.heartbeatUptimeMs, null, "/proc/uptime 읽기 실패 시 session.lock 에 heartbeatUptimeMs: null 이 적혀야 한다")
    assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500)

    // 1. 단조 값이 없고 실행기가 멈춤(T) 상태로 보여도 벽시계 상한(90,000,000ms = 25시간) 안이면
    //    살아 있는 잠금으로 보고 회수하지 않는다(replies 0500 모드 안 바뀜).
    const withinMaxMs = AX_RELAY_LOCK_WALL_CLOCK_MAX_MS - 3_600_000 // 24시간(상한 안)
    const botWithinLogs: string[] = []
    const botWithinMax = createSessionRelay({
      ...f.options,
      now: () => Date.now() + withinMaxMs,
      uptimeMs: () => null,
      procIdentity: (pid) => {
        const real = readProcessIdentity(pid)
        if (pid === liveRunnerPid && real.alive) return { ...real, state: "T", stopped: true }
        return real
      },
      log: (line) => botWithinLogs.push(line),
    })
    await botWithinMax.init()
    assert.equal(
      (await lstat(repliesDir)).mode & 0o777,
      0o500,
      "단조 값이 없고 실행기가 멈춤(T) 상태로 보여도 벽시계 상한 안이면 봇 init() 이 replies 0500 모드를 바꾸면 안 된다",
    )
    assert.equal(botWithinLogs.length, 0, "상한 안에서는 회수 기록이 남으면 안 된다")

    const runnerWithinHooks = `{
      now: () => Date.now() + ${withinMaxMs},
      uptimeMs: () => null,
      procIdentity: (pid) => {
        const real = readProcessIdentity(pid);
        if (pid === ${liveRunnerPid} && real.alive) return { ...real, state: "T", stopped: true };
        return real;
      }
    }`
    const secondWithinRes = await runSessionScriptWithHooks(
      [f.inbox("$r19-next")],
      {
        PATH: process.env.PATH,
        AX_MESSENGER_DATA_DIR: f.dir,
        AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, holdOrAnswerScript]),
        AX_RELAY_SESSION_DIR: roleDir,
        AX_RELAY_SESSION_TIMEOUT_MS: "5000",
      },
      runnerWithinHooks,
    )
    assert.equal(secondWithinRes.code, 0, secondWithinRes.stderr)
    assert.equal(readProcessIdentity(liveRunnerPid).alive, true, "벽시계 상한 안이면 첫 실행기가 회수되면 안 된다")
    assert.doesNotThrow(() => process.kill(-liveSessionPgid, 0), "벽시계 상한 안이면 첫 세션 프로세스 그룹이 살아 있어야 한다")
    assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500, "벽시계 상한 안이면 replies 0500 모드가 그대로 유지되어야 한다")
    await assert.rejects(() => lstat(f.reply("$r19-next")), { code: "ENOENT" })

    // 2. 단조 값이 없고 실행기가 멈춤(T) 상태로 보이며 벽시계 상한(90,000,000ms)을 넘었으면
    //    죽은 잠금으로 보고 회수·복원하며 감사 기록("단조 값 없음 → 벽시계 상한 회수")이 남는다(봇 init() 과 두 번째 실행기 모두).
    const pastMaxMs = AX_RELAY_LOCK_WALL_CLOCK_MAX_MS + 60_000
    const botExpiredLogs: string[] = []
    const botPastMax = createSessionRelay({
      ...f.options,
      now: () => Date.now() + pastMaxMs,
      uptimeMs: () => null,
      procIdentity: (pid) => {
        const real = readProcessIdentity(pid)
        if (pid === liveRunnerPid && real.alive) return { ...real, state: "T", stopped: true }
        return real
      },
      log: (line) => botExpiredLogs.push(line),
    })
    await botPastMax.init()
    assert.equal(
      (await lstat(repliesDir)).mode & 0o777,
      0o500,
      "단조 값이 없고 벽시계 상한을 넘었더라도 session-restore.json 이 남아 있으면 봇 init() 이 기본 모드(0700)를 걸지 않고 0500 을 유지해야 한다",
    )
    assert.ok(
      botExpiredLogs.some((l) => l.includes(AX_RELAY_LOCK_WALL_CLOCK_RECLAIM_REASON) && l.includes("state=T")),
      "봇 init() 이 '단조 값 없음 → 벽시계 상한 회수' 감사 로그를 남겨야 한다",
    )
    const botLogRowsAfterInit = (await readFile(sessionLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
    assert.ok(
      botLogRowsAfterInit.some(
        (r) =>
          r.event === "lock-reclaim" &&
          r.actor === "bot" &&
          r.pid === liveRunnerPid &&
          r.procState === "T" &&
          r.lockReclaimReason === AX_RELAY_LOCK_WALL_CLOCK_RECLAIM_REASON,
      ),
      "봇 init() 회수 시 session-log.jsonl 에도 '단조 값 없음 → 벽시계 상한 회수' 감사 기록이 남아야 한다",
    )

    // 두 번째 실행기로도 동일한 상황(replies 0500 + 멈춤 T + 벽시계 상한 초과)에서 회수·복원 및 감사 기록 확인
    await chmod(repliesDir, 0o500)
    const holdState = JSON.parse(await readFile(f.state("$r19-hold"), "utf8"))
    holdState.state = "timeout"
    holdState.audited = true
    await writeFile(f.state("$r19-hold"), `${JSON.stringify(holdState)}\n`, { mode: 0o600 })

    const runnerPastHooks = `{
      now: () => Date.now() + ${pastMaxMs},
      uptimeMs: () => null,
      procIdentity: (pid) => {
        const real = readProcessIdentity(pid);
        if (pid === ${liveRunnerPid} && real.alive) return { ...real, state: "T", stopped: true };
        return real;
      }
    }`
    const secondPastMaxRes = await runSessionScriptWithHooks(
      [f.inbox("$r19-next")],
      {
        PATH: process.env.PATH,
        AX_MESSENGER_DATA_DIR: f.dir,
        AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, holdOrAnswerScript]),
        AX_RELAY_SESSION_DIR: roleDir,
        AX_RELAY_SESSION_TIMEOUT_MS: "5000",
      },
      runnerPastHooks,
    )
    assert.equal(secondPastMaxRes.code, 0, secondPastMaxRes.stderr)
    assert.match(
      secondPastMaxRes.stderr,
      new RegExp(AX_RELAY_LOCK_WALL_CLOCK_RECLAIM_REASON),
      "두 번째 실행기 표준 오류에 '단조 값 없음 → 벽시계 상한 회수' 기록이 남아야 한다",
    )
    assert.equal(readProcessIdentity(liveRunnerPid).alive, false, "벽시계 상한을 넘긴 멈춘 실행기는 회수·종료되어야 한다")
    assert.throws(() => process.kill(-liveSessionPgid, 0), { code: "ESRCH" }, "세션 프로세스 그룹도 종료되어야 한다")
    liveRunner = null
    liveSessionPgid = 0
    assert.equal((await lstat(repliesDir)).mode & 0o777, 0o750, "회수·실행 뒤 session-restore.json 의 원래 모드(0750)로 복원되어야 한다")
    await assert.rejects(() => lstat(restorePath), { code: "ENOENT" })
    await assert.rejects(() => lstat(lockPath), { code: "ENOENT" })
    assert.equal((await readFile(f.reply("$r19-next"), "utf8")).trim(), "상한회수답:단조값없음상한회수후질문")

    const logRowsAfterRunner = (await readFile(sessionLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
    assert.ok(
      logRowsAfterRunner.some(
        (r) =>
          r.event === "lock-reclaim" &&
          r.actor === "runner" &&
          r.pid === liveRunnerPid &&
          r.procState === "T" &&
          r.lockReclaimReason === AX_RELAY_LOCK_WALL_CLOCK_RECLAIM_REASON,
      ),
      "두 번째 실행기 회수 시 session-log.jsonl 에 runner lock-reclaim 감사 기록이 남아야 한다",
    )
    const nextQuestionRow = logRowsAfterRunner.find((r) => r.file === `${relayName("$r19-next")}.json`)
    assert.equal(
      nextQuestionRow?.lockReclaimReason,
      AX_RELAY_LOCK_WALL_CLOCK_RECLAIM_REASON,
      "세션 실행 기록 줄에도 lockReclaimReason: '단조 값 없음 → 벽시계 상한 회수' 가 남아야 한다",
    )

    // 3. 운영 복구 선택지(--reclaim-lock):
    //    (가) 살아 있는 정상 실행기면 거부(종료 코드 1, 잠금·replies 0500·실행기 유지, 감사 기록)
    //    (나) 멈춤(T) 상태면 상한 전이라도 회수·복원(종료 코드 0, 감사 기록)
    //    (다) 단조 값 없이 벽시계 상한 넘김이면 회수·복원(종료 코드 0, 감사 기록)
    //    (라) 죽음(또는 좀비 Z)이면 회수·복원(종료 코드 0, 감사 기록)
    await rm(holdStartedMarker, { force: true })
    await f.relay.forward(f.question("$r19-op-hold", "!room1", "단조값없는세션유지2"))
    await chmod(repliesDir, 0o750)

    liveRunner2 = spawn(process.execPath, [sessionRunScript, f.inbox("$r19-op-hold")], {
      env: {
        PATH: process.env.PATH,
        AX_MESSENGER_DATA_DIR: f.dir,
        AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, holdOrAnswerScript]),
        AX_RELAY_SESSION_DIR: roleDir,
        AX_RELAY_SESSION_TIMEOUT_MS: "30000",
      },
      stdio: "ignore",
    })

    for (let i = 0; i < 120; i++) {
      try {
        await lstat(holdStartedMarker)
        const lockObj = JSON.parse(await readFile(lockPath, "utf8"))
        if (lockObj.pgid > 0 && ((await lstat(repliesDir)).mode & 0o777) === 0o500) break
      } catch { /* wait */ }
      await new Promise((r) => setTimeout(r, 30))
    }

    const activeLock2 = JSON.parse(await readFile(lockPath, "utf8"))
    const liveRunnerPid2 = Number(activeLock2.pid)
    liveSessionPgid2 = Number(activeLock2.pgid)
    assert.equal(liveRunnerPid2, liveRunner2.pid)
    assert.ok(liveSessionPgid2 > 0)

    // (가) 살아 있는 정상 실행기에 대해 --reclaim-lock 실행 -> 거부(종료 코드 1)
    const reclaimLiveRes = await runSessionScriptWithHooks(
      ["--reclaim-lock"],
      {
        PATH: process.env.PATH,
        AX_MESSENGER_DATA_DIR: f.dir,
      },
      `{}`,
    )
    assert.equal(reclaimLiveRes.code, 1, "살아 있는 실행기에 대한 --reclaim-lock 은 종료 코드 1로 거부해야 한다")
    assert.match(reclaimLiveRes.stderr, /reclaim rejected.*살아 있는 실행기 잠금 회수 거부/)
    assert.equal(readProcessIdentity(liveRunnerPid2).alive, true, "거부 뒤 살아 있는 실행기는 그대로 돌아야 한다")
    assert.doesNotThrow(() => process.kill(-liveSessionPgid2, 0))
    assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500, "거부 뒤 replies 0500 잠금이 유지되어야 한다")

    // (나) 실행기가 멈춤(T) 상태로 보일 때 --reclaim-lock 실행 -> 상한 전이라도 즉시 회수·복원(종료 코드 0)
    const reclaimStoppedHooks = `{
      procIdentity: (pid) => {
        const real = readProcessIdentity(pid);
        if (pid === ${liveRunnerPid2} && real.alive) return { ...real, state: "T", stopped: true };
        return real;
      }
    }`
    const reclaimStoppedRes = await runSessionScriptWithHooks(
      ["--reclaim-lock"],
      {
        PATH: process.env.PATH,
        AX_MESSENGER_DATA_DIR: f.dir,
      },
      reclaimStoppedHooks,
    )
    assert.equal(reclaimStoppedRes.code, 0, reclaimStoppedRes.stderr)
    assert.match(reclaimStoppedRes.stderr, /멈춘 실행기\(T\/t\) 운영 잠금 회수/)
    assert.equal(readProcessIdentity(liveRunnerPid2).alive, false, "--reclaim-lock 으로 멈춘 실행기가 종료되어야 한다")
    assert.throws(() => process.kill(-liveSessionPgid2, 0), { code: "ESRCH" })
    liveRunner2 = null
    liveSessionPgid2 = 0
    assert.equal((await lstat(repliesDir)).mode & 0o777, 0o750, "--reclaim-lock 뒤 원래 모드(0750)로 복원되어야 한다")
    await assert.rejects(() => lstat(restorePath), { code: "ENOENT" })
    await assert.rejects(() => lstat(lockPath), { code: "ENOENT" })

    // (다) 단조 값 없음 + 벽시계 상한 넘김 잠금에 대해 --reclaim-lock 실행 -> 회수·복원 및 감사 기록
    const selfProc = readProcessIdentity(process.pid)
    await writeFile(
      restorePath,
      `${JSON.stringify({ repliesMode: 0o750, at: Date.now(), pid: 999991 })}\n`,
      { mode: 0o600 },
    )
    await chmod(repliesDir, 0o500)
    await writeFile(
      lockPath,
      `${JSON.stringify({
        token: "wall-max-reclaim-token",
        pid: 999991,
        starttime: selfProc.starttime,
        boot_id: selfProc.bootId,
        pgid: 0,
        at: Date.now(),
        heartbeatAt: Date.now(),
        heartbeatUptimeMs: null,
        heartbeatStaleMs: 10_000,
        timeoutMs: 60_000,
      })}\n`,
      { mode: 0o600 },
    )
    const reclaimWallMaxHooks = `{
      now: () => Date.now() + ${pastMaxMs},
      uptimeMs: () => null,
      procIdentity: (pid) => ({ alive: true, starttime: ${JSON.stringify(selfProc.starttime)}, bootId: ${JSON.stringify(selfProc.bootId)}, state: "S", stopped: false })
    }`
    const reclaimWallMaxRes = await runSessionScriptWithHooks(
      ["--reclaim-lock"],
      {
        PATH: process.env.PATH,
        AX_MESSENGER_DATA_DIR: f.dir,
      },
      reclaimWallMaxHooks,
    )
    assert.equal(reclaimWallMaxRes.code, 0, reclaimWallMaxRes.stderr)
    assert.match(reclaimWallMaxRes.stderr, new RegExp(AX_RELAY_LOCK_WALL_CLOCK_RECLAIM_REASON))
    assert.equal((await lstat(repliesDir)).mode & 0o777, 0o750)
    await assert.rejects(() => lstat(lockPath), { code: "ENOENT" })

    // (라) 죽은(좀비 Z 포함) 실행기 잠금에 대해 --reclaim-lock 실행 -> 회수·복원 및 감사 기록
    await writeFile(
      restorePath,
      `${JSON.stringify({ repliesMode: 0o750, at: Date.now(), pid: 999992 })}\n`,
      { mode: 0o600 },
    )
    await chmod(repliesDir, 0o500)
    await writeFile(
      lockPath,
      `${JSON.stringify({
        token: "dead-reclaim-token",
        pid: 999992,
        starttime: selfProc.starttime,
        boot_id: selfProc.bootId,
        pgid: 0,
        at: Date.now(),
        heartbeatAt: Date.now(),
        heartbeatUptimeMs: 1000,
        heartbeatStaleMs: 10_000,
        timeoutMs: 60_000,
      })}\n`,
      { mode: 0o600 },
    )
    const reclaimZombieHooks = `{
      procIdentity: (pid) => ({ alive: true, starttime: ${JSON.stringify(selfProc.starttime)}, bootId: ${JSON.stringify(selfProc.bootId)}, state: "Z", stopped: false })
    }`
    const reclaimDeadRes = await runSessionScriptWithHooks(
      ["--reclaim-lock"],
      {
        PATH: process.env.PATH,
        AX_MESSENGER_DATA_DIR: f.dir,
      },
      reclaimZombieHooks,
    )
    assert.equal(reclaimDeadRes.code, 0, reclaimDeadRes.stderr)
    assert.match(reclaimDeadRes.stderr, /죽은 실행기 잠금 회수/)
    assert.equal((await lstat(repliesDir)).mode & 0o777, 0o750)
    await assert.rejects(() => lstat(lockPath), { code: "ENOENT" })

    const finalAuditRows = (await readFile(sessionLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
    assert.ok(
      finalAuditRows.some((r) => r.event === "lock-reclaim" && r.actor === "operator" && r.action === "rejected"),
      "운영 복구 거부 감사 기록이 남아야 한다",
    )
    assert.ok(
      finalAuditRows.some(
        (r) =>
          r.event === "lock-reclaim" &&
          r.actor === "operator" &&
          r.action === "reclaimed" &&
          r.lockReclaimReason === "멈춘 실행기(T/t) 운영 잠금 회수",
      ),
      "운영 복구 멈춤 회수 감사 기록이 남아야 한다",
    )
    assert.ok(
      finalAuditRows.some(
        (r) =>
          r.event === "lock-reclaim" &&
          r.actor === "operator" &&
          r.action === "reclaimed" &&
          r.lockReclaimReason === AX_RELAY_LOCK_WALL_CLOCK_RECLAIM_REASON,
      ),
      "운영 복구 벽시계 상한 회수 감사 기록이 남아야 한다",
    )
    assert.ok(
      finalAuditRows.some(
        (r) =>
          r.event === "lock-reclaim" &&
          r.actor === "operator" &&
          r.action === "reclaimed" &&
          r.lockReclaimReason === "죽은 실행기 잠금 회수",
      ),
      "운영 복구 죽은 실행기 회수 감사 기록이 남아야 한다",
    )
  } finally {
    if (liveRunner?.pid) {
      try { process.kill(liveRunner.pid, "SIGKILL") } catch { /* ignore */ }
    }
    if (liveSessionPgid > 0) {
      try { process.kill(-liveSessionPgid, "SIGKILL") } catch { /* ignore */ }
    }
    if (liveRunner2?.pid) {
      try { process.kill(liveRunner2.pid, "SIGKILL") } catch { /* ignore */ }
    }
    if (liveSessionPgid2 > 0) {
      try { process.kill(-liveSessionPgid2, "SIGKILL") } catch { /* ignore */ }
    }
    await f.cleanup()
  }
})

test("단조 칸(heartbeatUptimeMs)이 없는 옛 꼴 잠금: heartbeat 10초 초과~25시간 상한 안에서는 봇 init()과 두 번째 실행기 모두 회수하지 않고 replies 0500 유지 및 legacy-compat 기록, 25시간 상한 초과 시 회수·복원 및 감사 기록·옛 호환 기록", async () => {
  const f = await fixture()
  let legacyRunner: ReturnType<typeof spawn> | null = null
  let legacyGroupChild: ReturnType<typeof spawn> | null = null
  try {
    const roleDir = path.join(f.dir, "role-r20-legacy-no-field")
    await mkdir(roleDir, { recursive: true, mode: 0o755 })
    await chmod(roleDir, 0o755)
    await writeFile(path.join(roleDir, "AGENTS.md"), "# 역할 지시\n", { mode: 0o640 })

    const repliesDir = path.join(f.dir, "relay", "replies")
    const restorePath = path.join(f.dir, "relay", "session-restore.json")
    const lockPath = path.join(f.dir, "relay", "session.lock")
    const sessionLogPath = path.join(f.dir, "relay", "session-log.jsonl")

    const answerScript = path.join(f.dir, "r20-legacy-answer.mjs")
    await writeFile(
      answerScript,
      `import { readFileSync, writeFileSync } from "node:fs";
const q = JSON.parse(readFileSync("question.json", "utf8"));
writeFileSync("answer.md", "옛잠금상한답:" + q.body, { mode: 0o600 });
`,
      { mode: 0o600 },
    )

    // 살아 있는 옛 실행기 프로세스와 세션 프로세스 그룹을 띄운다.
    legacyRunner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
    legacyGroupChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    })
    const legacyPid = legacyRunner.pid!
    const legacyPgid = legacyGroupChild.pid!
    const legacyProc = readProcessIdentity(legacyPid)
    assert.equal(legacyProc.alive, true)

    await f.relay.forward(f.question("$r20-legacy-q", "!room1", "옛잠금25시간상한질문"))
    await writeFile(
      restorePath,
      `${JSON.stringify({ repliesMode: 0o750, at: Date.now(), pid: legacyPid })}\n`,
      { mode: 0o600 },
    )
    await chmod(repliesDir, 0o500)

    // heartbeatUptimeMs 칸 자체가 없는 옛 꼴 잠금을 작성한다(heartbeatStaleMs: 10_000, timeoutMs: 60_000).
    const baseAt = Date.now()
    await writeFile(
      lockPath,
      `${JSON.stringify({
        token: "r20-legacy-missing-field-token",
        pid: legacyPid,
        starttime: legacyProc.starttime,
        boot_id: legacyProc.bootId,
        pgid: legacyPgid,
        at: baseAt,
        heartbeatAt: baseAt,
        heartbeatStaleMs: 10_000,
        timeoutMs: 60_000,
      })}\n`,
      { mode: 0o600 },
    )

    // 1. heartbeat 를 10초 넘게 놓쳤고(예: +30초) 세션 기한(60초)을 넘어 24시간(+86,400,000ms, 멈춤 T 포함)이 지났더라도
    //    25시간 상한(90,000,000ms) 안이면 봇 init() 과 두 번째 실행기 모두 회수하지 않고 replies 0500 모드를 유지하며 legacy-compat active=true 를 기록한다.
    for (const elapsedMs of [30_000, 86_400_000]) {
      const botActiveLogs: string[] = []
      const botWithin = createSessionRelay({
        ...f.options,
        now: () => baseAt + elapsedMs,
        procIdentity: (pid) => {
          const real = readProcessIdentity(pid)
          if (pid === legacyPid && real.alive) return { ...real, state: "T", stopped: true }
          return real
        },
        log: (line) => botActiveLogs.push(line),
      })
      await botWithin.init()
      assert.equal(
        (await lstat(repliesDir)).mode & 0o777,
        0o500,
        `칸 없는 옛 꼴 잠금이 ${elapsedMs}ms 경과(25시간 상한 안)일 때 봇 init() 이 replies 0500 모드를 바꾸면 안 된다`,
      )
      assert.ok(
        botActiveLogs.some((l) => l.includes("legacy-compat") && l.includes("active=true")),
        `칸 없는 옛 꼴 잠금(${elapsedMs}ms)에 대해 봇이 legacy-compat active=true 를 기록해야 한다`,
      )
      assert.ok(
        !botActiveLogs.some((l) => l.includes(AX_RELAY_LOCK_WALL_CLOCK_RECLAIM_REASON)),
        "25시간 상한 안에서는 벽시계 상한 회수 기록이 남으면 안 된다",
      )

      const runnerWithinRes = await runSessionScriptWithHooks(
        [f.inbox("$r20-legacy-q")],
        {
          PATH: process.env.PATH,
          AX_MESSENGER_DATA_DIR: f.dir,
          AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, answerScript]),
          AX_RELAY_SESSION_DIR: roleDir,
          AX_RELAY_SESSION_TIMEOUT_MS: "5000",
        },
        `{
          now: () => ${baseAt + elapsedMs},
          procIdentity: (pid) => {
            const real = readProcessIdentity(pid);
            if (pid === ${legacyPid} && real.alive) return { ...real, state: "T", stopped: true };
            return real;
          }
        }`,
      )
      assert.equal(runnerWithinRes.code, 0, runnerWithinRes.stderr)
      assert.match(
        runnerWithinRes.stderr,
        /legacy-compat.*active=true/,
        `칸 없는 옛 꼴 잠금(${elapsedMs}ms)에 대해 실행기도 legacy-compat active=true 를 기록해야 한다`,
      )
      assert.equal(readProcessIdentity(legacyPid).alive, true, "25시간 상한 안이면 옛 실행기가 회수되면 안 된다")
      assert.doesNotThrow(() => process.kill(-legacyPgid, 0), "25시간 상한 안이면 옛 세션 프로세스 그룹이 살아 있어야 한다")
      assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500, "25시간 상한 안이면 replies 0500 모드가 그대로 유지되어야 한다")
      await assert.rejects(() => lstat(f.reply("$r20-legacy-q")), { code: "ENOENT" })
    }

    // 2. 25시간 벽시계 상한(90,000,000ms)을 넘으면 봇 init() 과 두 번째 실행기 모두 회수·복원하고
    //    벽시계 상한 감사 기록과 옛 호환 기록(legacy-compat active=false / legacyLockCompat: "stale")을 모두 남긴다.
    const pastMaxMs = AX_RELAY_LOCK_WALL_CLOCK_MAX_MS + 60_000
    const botExpiredLogs: string[] = []
    const botPast = createSessionRelay({
      ...f.options,
      now: () => baseAt + pastMaxMs,
      procIdentity: (pid) => {
        const real = readProcessIdentity(pid)
        if (pid === legacyPid && real.alive) return { ...real, state: "T", stopped: true }
        return real
      },
      log: (line) => botExpiredLogs.push(line),
    })
    await botPast.init()
    assert.equal(
      (await lstat(repliesDir)).mode & 0o777,
      0o500,
      "칸 없는 옛 꼴 잠금이 25시간 상한을 넘었더라도 session-restore.json 이 남아 있으면 봇 init() 이 기본 모드(0700)를 걸지 않고 0500 을 유지해야 한다",
    )
    assert.ok(
      botExpiredLogs.some((l) => l.includes("legacy-compat") && l.includes("active=false")),
      "상한 초과 시 봇이 legacy-compat active=false 를 기록해야 한다",
    )
    assert.ok(
      botExpiredLogs.some((l) => l.includes(AX_RELAY_LOCK_WALL_CLOCK_RECLAIM_REASON) && l.includes("state=T")),
      "상한 초과 시 봇이 '단조 값 없음 → 벽시계 상한 회수' 감사 로그를 남겨야 한다",
    )

    // 두 번째 실행기로 회수·원래 모드(0750) 복원·세션 실행·감사 기록 확인
    await chmod(repliesDir, 0o500)
    const runnerPastRes = await runSessionScriptWithHooks(
      [f.inbox("$r20-legacy-q")],
      {
        PATH: process.env.PATH,
        AX_MESSENGER_DATA_DIR: f.dir,
        AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, answerScript]),
        AX_RELAY_SESSION_DIR: roleDir,
        AX_RELAY_SESSION_TIMEOUT_MS: "5000",
      },
      `{
        now: () => ${baseAt + pastMaxMs},
        procIdentity: (pid) => {
          const real = readProcessIdentity(pid);
          if (pid === ${legacyPid} && real.alive) return { ...real, state: "T", stopped: true };
          return real;
        }
      }`,
    )
    assert.equal(runnerPastRes.code, 0, runnerPastRes.stderr)
    assert.match(runnerPastRes.stderr, /legacy-compat.*active=false/, "실행기가 legacy-compat active=false 를 기록해야 한다")
    assert.match(
      runnerPastRes.stderr,
      new RegExp(AX_RELAY_LOCK_WALL_CLOCK_RECLAIM_REASON),
      "실행기가 '단조 값 없음 → 벽시계 상한 회수' 를 기록해야 한다",
    )
    assert.equal(readProcessIdentity(legacyPid).alive, false, "상한을 넘긴 옛 실행기는 회수·종료되어야 한다")
    assert.throws(() => process.kill(-legacyPgid, 0), { code: "ESRCH" }, "옛 세션 프로세스 그룹도 종료되어야 한다")
    legacyRunner = null
    legacyGroupChild = null
    assert.equal((await lstat(repliesDir)).mode & 0o777, 0o750, "회수 뒤 session-restore.json 의 원래 모드(0750)로 복원되어야 한다")
    await assert.rejects(() => lstat(restorePath), { code: "ENOENT" })
    await assert.rejects(() => lstat(lockPath), { code: "ENOENT" })
    assert.equal((await readFile(f.reply("$r20-legacy-q"), "utf8")).trim(), "옛잠금상한답:옛잠금25시간상한질문")

    const auditRows = (await readFile(sessionLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
    assert.ok(
      auditRows.some(
        (r) =>
          r.event === "lock-reclaim" &&
          r.actor === "bot" &&
          r.pid === legacyPid &&
          r.procState === "T" &&
          r.legacyLockCompat === "stale" &&
          r.lockReclaimReason === AX_RELAY_LOCK_WALL_CLOCK_RECLAIM_REASON,
      ),
      "session-log.jsonl 에 봇의 옛 잠금 벽시계 상한 회수 감사 기록(legacyLockCompat 포함)이 남아야 한다",
    )
    assert.ok(
      auditRows.some(
        (r) =>
          r.event === "lock-reclaim" &&
          r.actor === "runner" &&
          r.pid === legacyPid &&
          r.procState === "T" &&
          r.legacyLockCompat === "stale" &&
          r.lockReclaimReason === AX_RELAY_LOCK_WALL_CLOCK_RECLAIM_REASON,
      ),
      "session-log.jsonl 에 실행기의 옛 잠금 벽시계 상한 회수 감사 기록(legacyLockCompat 포함)이 남아야 한다",
    )
    const sessionRow = auditRows.find((r) => r.file === `${relayName("$r20-legacy-q")}.json`)
    assert.equal(sessionRow?.legacyLockCompat, "stale", "세션 실행 기록 줄에 legacyLockCompat: 'stale' 이 남아야 한다")
    assert.equal(
      sessionRow?.lockReclaimReason,
      AX_RELAY_LOCK_WALL_CLOCK_RECLAIM_REASON,
      "세션 실행 기록 줄에 lockReclaimReason: '단조 값 없음 → 벽시계 상한 회수' 가 남아야 한다",
    )
  } finally {
    if (legacyRunner?.pid) {
      try { process.kill(legacyRunner.pid, "SIGKILL") } catch { /* ignore */ }
    }
    if (legacyGroupChild?.pid) {
      try { process.kill(-legacyGroupChild.pid, "SIGKILL") } catch { /* ignore */ }
    }
    await f.cleanup()
  }
})

test("/proc/<pid>/stat 상태 글자·starttime 순수 해석 함수(parseProcStatLine): 공백·괄호 이름, R·S·T·t·Z·X 상태별 판정, 망가진 줄 방어 (봇·실행기 동일 규칙)", async () => {
  const runnerMod = (await import(pathToFileURL(sessionRunScript).href)) as {
    parseProcStatLine: typeof parseProcStatLine
    readProcessIdentity: typeof readProcessIdentity
    evaluateSessionLockPayload: typeof evaluateSessionLockPayload
  }

  function makeStatLine(pid: number | string, comm: string, stateChar: string, starttime: string, totalAfterParen = 30): string {
    const rest: string[] = [stateChar]
    for (let i = 1; i < totalAfterParen; i++) {
      rest.push(i === 19 ? starttime : String(100 + i))
    }
    return `${pid} (${comm}) ${rest.join(" ")}\n`
  }

  // 1. 프로세스 이름(comm)에 공백·중첩 괄호·닫는 괄호가 섞여 있는 경우
  const complexCommLine = makeStatLine(4242, "my (weird) )prog (v2) name", "S", "987654321")
  const botComplex = parseProcStatLine(complexCommLine)
  const runnerComplex = runnerMod.parseProcStatLine(complexCommLine)
  assert.deepEqual(botComplex, {
    valid: true,
    status: "alive",
    alive: true,
    state: "S",
    stopped: false,
    starttime: "987654321",
  })
  assert.deepEqual(runnerComplex, botComplex, "봇과 실행기의 parseProcStatLine 결과가 완전히 같아야 한다")

  // 2. 상태 글자 R·S·T·t·Z·X 각각 검증 및 evaluateSessionLockPayload 연동 확인
  const stateExpectations: Array<{
    state: string
    starttime: string
    status: "alive" | "dead"
    alive: boolean
    stopped: boolean
    activeWithinMax: boolean
  }> = [
    { state: "R", starttime: "555001", status: "alive", alive: true, stopped: false, activeWithinMax: true },
    { state: "S", starttime: "555002", status: "alive", alive: true, stopped: false, activeWithinMax: true },
    { state: "D", starttime: "555007", status: "alive", alive: true, stopped: false, activeWithinMax: true },
    { state: "T", starttime: "555003", status: "alive", alive: true, stopped: true, activeWithinMax: true },
    { state: "t", starttime: "555004", status: "alive", alive: true, stopped: true, activeWithinMax: true },
    { state: "P", starttime: "555008", status: "alive", alive: true, stopped: false, activeWithinMax: true },
    { state: "I", starttime: "555009", status: "alive", alive: true, stopped: false, activeWithinMax: true },
    { state: "Z", starttime: "555005", status: "dead", alive: false, stopped: false, activeWithinMax: false },
    { state: "X", starttime: "555006", status: "dead", alive: false, stopped: false, activeWithinMax: false },
  ]

  for (const exp of stateExpectations) {
    const line = makeStatLine(7777, `worker (${exp.state}) proc`, exp.state, exp.starttime)
    const botParsed = parseProcStatLine(line)
    const runnerParsed = runnerMod.parseProcStatLine(line)
    assert.deepEqual(botParsed, {
      valid: true,
      status: exp.status,
      alive: exp.alive,
      state: exp.state,
      stopped: exp.stopped,
      starttime: exp.starttime,
    })
    assert.deepEqual(runnerParsed, botParsed)

    // 단조 칸 없는 옛 잠금에 이 파서 결과를 넣었을 때:
    // - Z·X 는 상한 전이라도 즉시 active=false, stale=true
    // - R·S·T·t 는 상한 전(예: +60초)에는 active=true, 상한 초과(+25시간+1분)에는 active=false
    const lockPayload = {
      pid: 7777,
      starttime: exp.starttime,
      boot_id: "11111111-2222-4333-8444-555555555555",
      pgid: 7777,
      at: 1_000_000,
      heartbeatAt: 1_000_000,
      heartbeatStaleMs: 10_000,
      timeoutMs: 60_000,
    }
    const procIdentity = {
      status: botParsed.status,
      alive: botParsed.alive,
      starttime: botParsed.starttime,
      bootId: "11111111-2222-4333-8444-555555555555",
      state: botParsed.state,
      stopped: botParsed.stopped,
    }
    const withinEvalBot = evaluateSessionLockPayload(lockPayload, procIdentity, {
      selfBootId: "11111111-2222-4333-8444-555555555555",
      nowMs: 1_000_000 + 60_000,
      currentUptimeMs: 60_000,
      defaultTimeoutMs: 60_000,
    })
    const withinEvalRunner = runnerMod.evaluateSessionLockPayload(lockPayload, procIdentity, {
      selfBootId: "11111111-2222-4333-8444-555555555555",
      nowMs: 1_000_000 + 60_000,
      currentUptimeMs: 60_000,
      defaultTimeoutMs: 60_000,
    })
    assert.deepEqual(withinEvalRunner, withinEvalBot)
    assert.equal(withinEvalBot.active, exp.activeWithinMax, `state=${exp.state} 상한 전 active 판정 불일치`)
    assert.equal(withinEvalBot.stale, !exp.activeWithinMax, `state=${exp.state} 상한 전 stale 판정 불일치`)
    assert.equal(withinEvalBot.procStopped, exp.stopped, `state=${exp.state} procStopped 판정 불일치`)

    if (exp.alive) {
      assert.equal(withinEvalBot.legacyCompat, true, `state=${exp.state} 단조 칸 없는 잠금 legacyCompat=true 여야 한다`)
      const pastEvalBot = evaluateSessionLockPayload(lockPayload, procIdentity, {
        selfBootId: "11111111-2222-4333-8444-555555555555",
        nowMs: 1_000_000 + AX_RELAY_LOCK_WALL_CLOCK_MAX_MS + 1,
        currentUptimeMs: 60_000,
        defaultTimeoutMs: 60_000,
      })
      const pastEvalRunner = runnerMod.evaluateSessionLockPayload(lockPayload, procIdentity, {
        selfBootId: "11111111-2222-4333-8444-555555555555",
        nowMs: 1_000_000 + AX_RELAY_LOCK_WALL_CLOCK_MAX_MS + 1,
        currentUptimeMs: 60_000,
        defaultTimeoutMs: 60_000,
      })
      assert.deepEqual(pastEvalRunner, pastEvalBot)
      assert.equal(pastEvalBot.active, false)
      assert.equal(pastEvalBot.stale, true)
      assert.equal(pastEvalBot.legacyCompat, true)
      assert.equal(pastEvalBot.noMonotonicWallClockReclaim, true)
      assert.equal(pastEvalBot.reclaimReason, AX_RELAY_LOCK_WALL_CLOCK_RECLAIM_REASON)
    }
  }

  // 3. 망가진 줄(빈 문자열·괄호 누락·칸 부족·비숫자 PID/starttime·공백 누락·잘못된 상태 글자)은
  //    "죽음(dead)"이 아니라 "모름(unknown)"으로 판정하고, 상한 안에서는 잠금이 풀리지 않으며 상한 초과 시에만 모름 사유로 회수된다.
  const malformedLines = [
    "",
    "   \n",
    "1234 node S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 99999",
    "1234 (node S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 99999",
    "(node) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 99999",
    "abc (node) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 99999",
    "0 (node) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 99999",
    "1234 (node)S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 99999",
    "1234 (node) S 1 2 3 4 5",
    makeStatLine(1234, "node", "S", "not-a-number"),
    makeStatLine(1234, "node", "??", "123456"),
    makeStatLine(1234, "node", "Q", "123456"),
    makeStatLine(1234, "node", "x", "123456"),
    makeStatLine(1234, "node", "W", "123456"),
    makeStatLine(1234, "node", "K", "123456"),
  ]
  const selfBoot = readProcessIdentity(process.pid).bootId
  for (const bad of malformedLines) {
    const botBad = parseProcStatLine(bad)
    const runnerBad = runnerMod.parseProcStatLine(bad)
    assert.deepEqual(runnerBad, botBad)
    assert.equal(botBad.valid, false, `망가진 줄(${JSON.stringify(bad)})은 valid=false 여야 한다`)
    assert.equal(botBad.status, "unknown", `망가진 줄(${JSON.stringify(bad)})은 status='unknown' 이어야 한다`)
    assert.equal(botBad.alive, null, `망가진 줄(${JSON.stringify(bad)})은 죽음(false)이 아니라 미확정(null)이어야 한다`)
    assert.equal(botBad.stopped, false)
    assert.equal(botBad.starttime, "")

    const botProc = readProcessIdentity(process.pid, { readProcStat: () => bad })
    const runnerProc = runnerMod.readProcessIdentity(process.pid, { readProcStat: () => bad })
    assert.deepEqual(runnerProc, botProc)
    assert.equal(botProc.status, "unknown")
    assert.equal(botProc.alive, true)

    const lockPayload = {
      pid: process.pid,
      starttime: "123456789",
      boot_id: selfBoot,
      pgid: process.pid,
      at: 1_000_000,
      heartbeatAt: 1_000_000,
      heartbeatUptimeMs: 1_000,
      heartbeatStaleMs: 10_000,
      timeoutMs: 60_000,
    }
    const withinBot = evaluateSessionLockPayload(lockPayload, botProc, {
      selfBootId: selfBoot,
      nowMs: 1_000_000 + 86_400_000,
      currentUptimeMs: 90_000_000,
      defaultTimeoutMs: 60_000,
    })
    const withinRunner = runnerMod.evaluateSessionLockPayload(lockPayload, runnerProc, {
      selfBootId: selfBoot,
      nowMs: 1_000_000 + 86_400_000,
      currentUptimeMs: 90_000_000,
      defaultTimeoutMs: 60_000,
    })
    assert.deepEqual(withinRunner, withinBot)
    assert.equal(withinBot.active, true, `망가진 줄(${JSON.stringify(bad)})이 25시간 상한 안이면 잠금이 유지되어야 한다`)
    assert.equal(withinBot.stale, false)
    assert.equal(withinBot.pidIdentityMatched, true)
    assert.equal(withinBot.procStatus, "unknown")
    assert.equal(withinBot.identityUnknown, true)

    const pastBot = evaluateSessionLockPayload(lockPayload, botProc, {
      selfBootId: selfBoot,
      nowMs: 1_000_000 + AX_RELAY_LOCK_WALL_CLOCK_MAX_MS + 1,
      currentUptimeMs: 90_000_000,
      defaultTimeoutMs: 60_000,
    })
    const pastRunner = runnerMod.evaluateSessionLockPayload(lockPayload, runnerProc, {
      selfBootId: selfBoot,
      nowMs: 1_000_000 + AX_RELAY_LOCK_WALL_CLOCK_MAX_MS + 1,
      currentUptimeMs: 90_000_000,
      defaultTimeoutMs: 60_000,
    })
    assert.deepEqual(pastRunner, pastBot)
    assert.equal(pastBot.active, false)
    assert.equal(pastBot.stale, true)
    assert.equal(pastBot.identityUnknown, true)
    assert.equal(pastBot.noMonotonicWallClockReclaim, true)
    assert.equal(pastBot.reclaimReason, AX_RELAY_LOCK_IDENTITY_UNKNOWN_RECLAIM_REASON)
  }
})

test("프로세스 식별 세 갈래 판정(살아 있음 / 죽음 확인 / 모름) 실판정 경로: 망가진 stat 줄·stat 읽기 실패 시 25시간 상한 안 잠금·replies 0500 유지 및 상한 초과 회수·복원·모름 감사 기록, PID 없음·Z·X 즉시 회수, 정상 줄 같은/다른 starttime 판정", async () => {
  const f = await fixture()
  const childrenToKill: Array<ReturnType<typeof spawn>> = []
  const pgidsToKill: number[] = []

  function spawnDummyPair() {
    const runner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
    const group = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    })
    childrenToKill.push(runner, group)
    if (group.pid) pgidsToKill.push(group.pid)
    return { runner, group, pid: runner.pid!, pgid: group.pid! }
  }

  function makeStatLine(pid: number | string, comm: string, stateChar: string, starttime: string, totalAfterParen = 30): string {
    const rest: string[] = [stateChar]
    for (let i = 1; i < totalAfterParen; i++) {
      rest.push(i === 19 ? starttime : String(100 + i))
    }
    return `${pid} (${comm}) ${rest.join(" ")}\n`
  }

  try {
    const roleDir = path.join(f.dir, "role-r21-tri-state")
    await mkdir(roleDir, { recursive: true, mode: 0o755 })
    await chmod(roleDir, 0o755)
    await writeFile(path.join(roleDir, "AGENTS.md"), "# 역할 지시\n", { mode: 0o640 })

    const repliesDir = path.join(f.dir, "relay", "replies")
    const restorePath = path.join(f.dir, "relay", "session-restore.json")
    const lockPath = path.join(f.dir, "relay", "session.lock")
    const sessionLogPath = path.join(f.dir, "relay", "session-log.jsonl")

    const answerScript = path.join(f.dir, "r21-tri-answer.mjs")
    await writeFile(
      answerScript,
      `import { readFileSync, writeFileSync } from "node:fs";
const q = JSON.parse(readFileSync("question.json", "utf8"));
writeFileSync("answer.md", "세갈래답:" + q.body, { mode: 0o600 });
`,
      { mode: 0o600 },
    )

    assert.equal(
      AX_RELAY_LOCK_IDENTITY_UNKNOWN_RECLAIM_REASON,
      "식별 모름(identity-unknown) → 벽시계 상한 회수",
    )

    // =========================================================================
    // 1. 망가진 stat 줄 주입 및 stat 읽기 실패(권한 EACCES·입출력 EIO) 주입:
    //    - 25시간 벽시계 상한 안(+30초, +24시간)에서는 봇 init() 과 두 번째 실행기 모두
    //      잠금을 풀지 않고 replies 0500 모드를 유지한다.
    //    - 25시간 벽시계 상한 초과(+25시간 1분) 시에는 봇 init() 과 두 번째 실행기 모두
    //      회수·복원하고 감사 기록에 "모름"(identity-unknown) 사유를 남긴다.
    // =========================================================================
    const unknownCases: Array<{
      name: string
      qId: string
      qBody: string
      botReadProcStat: (targetPid: number) => (pid: number) => string
      runnerHookReadProcStatExpr: (targetPid: number) => string
    }> = [
      {
        name: "malformed-stat-line",
        qId: "$r21-malformed-q",
        qBody: "망가진줄상한회수질문",
        botReadProcStat: (targetPid) => (pid) => {
          if (pid === targetPid) return `${pid} (corrupted stat line without closing paren and fields\n`
          return makeStatLine(pid, "node", "S", readProcessIdentity(pid).starttime || "100")
        },
        runnerHookReadProcStatExpr: (targetPid) =>
          `(pid) => { if (pid === ${targetPid}) return "${targetPid} (corrupted stat line without closing paren\\n"; throw Object.assign(new Error("unexpected"), { code: "EACCES" }); }`,
      },
      {
        name: "stat-read-error-eacces",
        qId: "$r21-readerr-q",
        qBody: "읽기실패상한회수질문",
        botReadProcStat: (targetPid) => (pid) => {
          if (pid === targetPid) {
            const err = new Error("permission denied reading stat") as NodeJS.ErrnoException
            err.code = "EACCES"
            throw err
          }
          return makeStatLine(pid, "node", "S", readProcessIdentity(pid).starttime || "100")
        },
        runnerHookReadProcStatExpr: (targetPid) =>
          `(pid) => { if (pid === ${targetPid}) { const e = new Error("EIO"); e.code = "EIO"; throw e; } throw new Error("unexpected"); }`,
      },
    ]

    for (const uc of unknownCases) {
      const pair = spawnDummyPair()
      const realProc = readProcessIdentity(pair.pid)
      assert.equal(realProc.status, "alive")
      assert.equal(realProc.alive, true)

      await f.relay.forward(f.question(uc.qId, "!room1", uc.qBody))
      const baseAt = Date.now()
      await writeFile(
        restorePath,
        `${JSON.stringify({ repliesMode: 0o750, at: baseAt, pid: pair.pid })}\n`,
        { mode: 0o600 },
      )
      await chmod(repliesDir, 0o500)
      await writeFile(
        lockPath,
        `${JSON.stringify({
          token: `r21-${uc.name}-token`,
          pid: pair.pid,
          starttime: realProc.starttime,
          boot_id: realProc.bootId,
          pgid: pair.pgid,
          at: baseAt,
          heartbeatAt: baseAt,
          heartbeatUptimeMs: 1_000,
          heartbeatStaleMs: 10_000,
          timeoutMs: 60_000,
        })}\n`,
        { mode: 0o600 },
      )

      // (가) 25시간 상한 안(+30초, +24시간): 봇 init() 과 두 번째 실행기 모두 잠금·replies 0500 유지
      for (const elapsedMs of [30_000, 86_400_000]) {
        const botWithinLogs: string[] = []
        const botWithin = createSessionRelay({
          ...f.options,
          now: () => baseAt + elapsedMs,
          readProcStat: uc.botReadProcStat(pair.pid),
          log: (line) => botWithinLogs.push(line),
        })
        await botWithin.init()
        assert.equal(
          (await lstat(repliesDir)).mode & 0o777,
          0o500,
          `[${uc.name}] ${elapsedMs}ms(25시간 상한 안)일 때 봇 init() 이 replies 0500 모드를 풀면 안 된다`,
        )
        assert.ok(
          !botWithinLogs.some((l) => l.includes("reclaim")),
          `[${uc.name}] 25시간 상한 안에서는 봇 회수 로그가 남으면 안 된다`,
        )

        const runnerWithinRes = await runSessionScriptWithHooks(
          [f.inbox(uc.qId)],
          {
            PATH: process.env.PATH,
            AX_MESSENGER_DATA_DIR: f.dir,
            AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, answerScript]),
            AX_RELAY_SESSION_DIR: roleDir,
            AX_RELAY_SESSION_TIMEOUT_MS: "5000",
          },
          `{
            now: () => ${baseAt + elapsedMs},
            readProcStat: ${uc.runnerHookReadProcStatExpr(pair.pid)}
          }`,
        )
        assert.equal(runnerWithinRes.code, 0, runnerWithinRes.stderr)
        assert.equal(readProcessIdentity(pair.pid).alive, true, `[${uc.name}] 상한 안이면 첫 실행기가 살아 있어야 한다`)
        assert.doesNotThrow(() => process.kill(-pair.pgid, 0), `[${uc.name}] 상한 안이면 첫 세션 그룹이 살아 있어야 한다`)
        assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500, `[${uc.name}] 상한 안이면 replies 0500 모드가 유지되어야 한다`)
        assert.equal(JSON.parse(await readFile(lockPath, "utf8")).pid, pair.pid, `[${uc.name}] 상한 안이면 잠금 소유자가 유지되어야 한다`)
        await assert.rejects(() => lstat(f.reply(uc.qId)), { code: "ENOENT" })
      }

      // (나) 25시간 상한 초과(+25시간 1분): 봇 init() 과 두 번째 실행기 모두 회수·복원 및 "모름" 감사 사유 기록
      const pastMaxMs = AX_RELAY_LOCK_WALL_CLOCK_MAX_MS + 60_000
      const botPastLogs: string[] = []
      const botPast = createSessionRelay({
        ...f.options,
        now: () => baseAt + pastMaxMs,
        readProcStat: uc.botReadProcStat(pair.pid),
        log: (line) => botPastLogs.push(line),
      })
      await botPast.init()
      assert.equal(
        (await lstat(repliesDir)).mode & 0o777,
        0o500,
        `[${uc.name}] 25시간 상한을 넘었더라도 session-restore.json 이 남아 있으면 봇 init() 이 기본 모드(0700)를 걸지 않고 0500 을 유지해야 한다`,
      )
      assert.ok(
        botPastLogs.some((l) => l.includes(AX_RELAY_LOCK_IDENTITY_UNKNOWN_RECLAIM_REASON)),
        `[${uc.name}] 상한 초과 시 봇 로그에 '${AX_RELAY_LOCK_IDENTITY_UNKNOWN_RECLAIM_REASON}' 사유가 남아야 한다`,
      )

      await chmod(repliesDir, 0o500)
      const runnerPastRes = await runSessionScriptWithHooks(
        [f.inbox(uc.qId)],
        {
          PATH: process.env.PATH,
          AX_MESSENGER_DATA_DIR: f.dir,
          AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, answerScript]),
          AX_RELAY_SESSION_DIR: roleDir,
          AX_RELAY_SESSION_TIMEOUT_MS: "5000",
        },
        `{
          now: () => ${baseAt + pastMaxMs},
          readProcStat: ${uc.runnerHookReadProcStatExpr(pair.pid)}
        }`,
      )
      assert.equal(runnerPastRes.code, 0, runnerPastRes.stderr)
      assert.ok(
        runnerPastRes.stderr.includes(AX_RELAY_LOCK_IDENTITY_UNKNOWN_RECLAIM_REASON),
        `[${uc.name}] 상한 초과 시 실행기 표준 오류에 '${AX_RELAY_LOCK_IDENTITY_UNKNOWN_RECLAIM_REASON}' 사유가 남아야 한다`,
      )
      assert.equal(readProcessIdentity(pair.pid).alive, false, `[${uc.name}] 상한 초과 시 옛 실행기가 회수·종료되어야 한다`)
      assert.throws(() => process.kill(-pair.pgid, 0), { code: "ESRCH" }, `[${uc.name}] 상한 초과 시 옛 세션 그룹도 종료되어야 한다`)
      assert.equal((await lstat(repliesDir)).mode & 0o777, 0o750, `[${uc.name}] 회수 뒤 원래 모드(0750)로 복원되어야 한다`)
      await assert.rejects(() => lstat(restorePath), { code: "ENOENT" })
      await assert.rejects(() => lstat(lockPath), { code: "ENOENT" })
      assert.equal((await readFile(f.reply(uc.qId), "utf8")).trim(), `세갈래답:${uc.qBody}`)

      const auditRows = (await readFile(sessionLogPath, "utf8"))
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
      assert.ok(
        auditRows.some(
          (r) =>
            r.event === "lock-reclaim" &&
            r.actor === "bot" &&
            r.pid === pair.pid &&
            r.lockIdentityStatus === "unknown" &&
            r.lockReclaimReason === AX_RELAY_LOCK_IDENTITY_UNKNOWN_RECLAIM_REASON,
        ),
        `[${uc.name}] session-log.jsonl 에 봇의 모름(identity-unknown) 상한 회수 감사 기록이 남아야 한다`,
      )
      assert.ok(
        auditRows.some(
          (r) =>
            r.event === "lock-reclaim" &&
            r.actor === "runner" &&
            r.pid === pair.pid &&
            r.lockIdentityStatus === "unknown" &&
            r.lockReclaimReason === AX_RELAY_LOCK_IDENTITY_UNKNOWN_RECLAIM_REASON,
        ),
        `[${uc.name}] session-log.jsonl 에 실행기의 모름(identity-unknown) 상한 회수 감사 기록이 남아야 한다`,
      )
      const sessionRow = auditRows.find((r) => r.file === `${relayName(uc.qId)}.json`)
      assert.equal(sessionRow?.lockIdentityStatus, "unknown")
      assert.equal(sessionRow?.lockReclaimReason, AX_RELAY_LOCK_IDENTITY_UNKNOWN_RECLAIM_REASON)
    }

    // =========================================================================
    // 2. 죽음 확인(PID 없음 ESRCH, /proc/<pid> ENOENT, 상태 글자 Z, 상태 글자 X):
    //    25시간 상한을 기다리지 않고 즉시 회수·복원한다.
    // =========================================================================
    const deadSubcases: Array<{
      label: string
      qId: string
      qBody: string
      setupTarget: () => Promise<{
        pid: number
        starttime: string
        bootId: string
        pgid: number
        botReadProcStat?: (pid: number) => string
        runnerHooksExpr: string
      }>
    }> = [
      {
        label: "esrch-no-pid",
        qId: "$r21-dead-esrch",
        qBody: "PID없음즉시회수",
        setupTarget: async () => {
          const shortChild = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" })
          const deadPid = shortChild.pid!
          await new Promise<void>((resolve) => shortChild.on("close", () => resolve()))
          const orphanGroup = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            detached: true,
            stdio: "ignore",
          })
          childrenToKill.push(orphanGroup)
          pgidsToKill.push(orphanGroup.pid!)
          const selfProc = readProcessIdentity(process.pid)
          assert.equal(readProcessIdentity(deadPid).status, "dead")
          return {
            pid: deadPid,
            starttime: selfProc.starttime,
            bootId: selfProc.bootId,
            pgid: orphanGroup.pid!,
            runnerHooksExpr: `{}`,
          }
        },
      },
      {
        label: "enoent-missing-proc-dir",
        qId: "$r21-dead-enoent",
        qBody: "proc폴더없음즉시회수",
        setupTarget: async () => {
          const pair = spawnDummyPair()
          const realProc = readProcessIdentity(pair.pid)
          const enoentFn = (pid: number) => {
            if (pid === pair.pid) {
              const err = new Error("ENOENT") as NodeJS.ErrnoException
              err.code = "ENOENT"
              throw err
            }
            return makeStatLine(pid, "node", "S", realProc.starttime)
          }
          assert.equal(readProcessIdentity(pair.pid, { readProcStat: enoentFn }).status, "dead")
          return {
            pid: pair.pid,
            starttime: realProc.starttime,
            bootId: realProc.bootId,
            pgid: pair.pgid,
            botReadProcStat: enoentFn,
            runnerHooksExpr: `{
              readProcStat: (pid) => {
                if (pid === ${pair.pid}) { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; }
                throw new Error("unexpected");
              }
            }`,
          }
        },
      },
      {
        label: "state-Z-zombie",
        qId: "$r21-dead-z",
        qBody: "좀비Z즉시회수",
        setupTarget: async () => {
          const pair = spawnDummyPair()
          const realProc = readProcessIdentity(pair.pid)
          const zLine = makeStatLine(pair.pid, "zombie-runner", "Z", realProc.starttime)
          return {
            pid: pair.pid,
            starttime: realProc.starttime,
            bootId: realProc.bootId,
            pgid: pair.pgid,
            botReadProcStat: (pid) => (pid === pair.pid ? zLine : makeStatLine(pid, "node", "S", realProc.starttime)),
            runnerHooksExpr: `{
              readProcStat: (pid) => ${JSON.stringify(zLine)}
            }`,
          }
        },
      },
      {
        label: "state-X-dead",
        qId: "$r21-dead-x",
        qBody: "사망X즉시회수",
        setupTarget: async () => {
          const pair = spawnDummyPair()
          const realProc = readProcessIdentity(pair.pid)
          const xLine = makeStatLine(pair.pid, "dead-runner", "X", realProc.starttime)
          return {
            pid: pair.pid,
            starttime: realProc.starttime,
            bootId: realProc.bootId,
            pgid: pair.pgid,
            botReadProcStat: (pid) => (pid === pair.pid ? xLine : makeStatLine(pid, "node", "S", realProc.starttime)),
            runnerHooksExpr: `{
              readProcStat: (pid) => ${JSON.stringify(xLine)}
            }`,
          }
        },
      },
    ]

    for (const dc of deadSubcases) {
      const target = await dc.setupTarget()
      await f.relay.forward(f.question(dc.qId, "!room1", dc.qBody))
      const nowAt = Date.now()
      await writeFile(
        restorePath,
        `${JSON.stringify({ repliesMode: 0o750, at: nowAt, pid: target.pid })}\n`,
        { mode: 0o600 },
      )
      await chmod(repliesDir, 0o500)
      await writeFile(
        lockPath,
        `${JSON.stringify({
          token: `r21-${dc.label}-token`,
          pid: target.pid,
          starttime: target.starttime,
          boot_id: target.bootId,
          pgid: target.pgid,
          at: nowAt,
          heartbeatAt: nowAt,
          heartbeatUptimeMs: readUptimeMs() ?? 1000,
          heartbeatStaleMs: 60_000,
          timeoutMs: 300_000,
        })}\n`,
        { mode: 0o600 },
      )

      const botDead = createSessionRelay({
        ...f.options,
        ...(target.botReadProcStat ? { readProcStat: target.botReadProcStat } : {}),
      })
      await botDead.init()
      assert.equal(
        (await lstat(repliesDir)).mode & 0o777,
        0o500,
        `[${dc.label}] 죽음 확인 시에도 session-restore.json 이 남아 있으면 봇 init() 이 기본 모드(0700)를 걸지 않고 0500 을 유지해야 한다`,
      )

      await chmod(repliesDir, 0o500)
      const runnerDeadRes = await runSessionScriptWithHooks(
        [f.inbox(dc.qId)],
        {
          PATH: process.env.PATH,
          AX_MESSENGER_DATA_DIR: f.dir,
          AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, answerScript]),
          AX_RELAY_SESSION_DIR: roleDir,
          AX_RELAY_SESSION_TIMEOUT_MS: "5000",
        },
        target.runnerHooksExpr,
      )
      assert.equal(runnerDeadRes.code, 0, runnerDeadRes.stderr)
      assert.throws(() => process.kill(-target.pgid, 0), { code: "ESRCH" }, `[${dc.label}] 고아 세션 그룹이 즉시 종료되어야 한다`)
      assert.equal((await lstat(repliesDir)).mode & 0o777, 0o750, `[${dc.label}] 즉시 원래 모드(0750)로 복원되어야 한다`)
      await assert.rejects(() => lstat(restorePath), { code: "ENOENT" })
      await assert.rejects(() => lstat(lockPath), { code: "ENOENT" })
      assert.equal((await readFile(f.reply(dc.qId), "utf8")).trim(), `세갈래답:${dc.qBody}`)
    }

    // =========================================================================
    // 3. 정상 줄·같은 starttime -> 살아 있음(잠금·replies 0500 유지)
    //    정상 줄·다른 starttime -> PID 재사용(즉시 오래됨 회수·복원하되 재사용된 PID 와 옛 프로세스 그룹은 죽이지 않음)
    // =========================================================================
    const livePair = spawnDummyPair()
    const liveProc = readProcessIdentity(livePair.pid)
    const matchingStatLine = makeStatLine(livePair.pid, "runner (live)", "S", liveProc.starttime)
    await f.relay.forward(f.question("$r21-live-same-st", "!room1", "정상줄같은시작시각과다른시작시각"))
    const liveAt = Date.now()
    await writeFile(
      restorePath,
      `${JSON.stringify({ repliesMode: 0o750, at: liveAt, pid: livePair.pid })}\n`,
      { mode: 0o600 },
    )
    await chmod(repliesDir, 0o500)
    await writeFile(
      lockPath,
      `${JSON.stringify({
        token: "r21-live-same-starttime-token",
        pid: livePair.pid,
        starttime: liveProc.starttime,
        boot_id: liveProc.bootId,
        pgid: livePair.pgid,
        at: liveAt,
        heartbeatAt: liveAt,
        heartbeatUptimeMs: readUptimeMs() ?? 1000,
        heartbeatStaleMs: 60_000,
        timeoutMs: 300_000,
      })}\n`,
      { mode: 0o600 },
    )

    // (가) 정상 줄·같은 starttime: 봇 init() 과 두 번째 실행기 모두 살아 있음으로 판정해 잠금 유지
    const botSameSt = createSessionRelay({
      ...f.options,
      readProcStat: () => matchingStatLine,
    })
    await botSameSt.init()
    assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500, "정상 줄·같은 starttime 이면 봇 init() 이 replies 0500 을 유지해야 한다")

    const runnerSameStRes = await runSessionScriptWithHooks(
      [f.inbox("$r21-live-same-st")],
      {
        PATH: process.env.PATH,
        AX_MESSENGER_DATA_DIR: f.dir,
        AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, answerScript]),
        AX_RELAY_SESSION_DIR: roleDir,
        AX_RELAY_SESSION_TIMEOUT_MS: "5000",
      },
      `{ readProcStat: () => ${JSON.stringify(matchingStatLine)} }`,
    )
    assert.equal(runnerSameStRes.code, 0, runnerSameStRes.stderr)
    assert.equal(readProcessIdentity(livePair.pid).alive, true)
    assert.doesNotThrow(() => process.kill(-livePair.pgid, 0))
    assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500)
    await assert.rejects(() => lstat(f.reply("$r21-live-same-st")), { code: "ENOENT" })

    // (나) 정상 줄·다른 starttime (PID 재사용 길): 즉시 오래됨으로 회수·복원하되 재사용된 PID 와 옛 프로세스 그룹은 죽이지 않음
    const mismatchedStatLine = makeStatLine(livePair.pid, "reused-other-proc", "S", `${liveProc.starttime}999`)
    const botDiffSt = createSessionRelay({
      ...f.options,
      readProcStat: () => mismatchedStatLine,
    })
    await botDiffSt.init()
    assert.equal(
      (await lstat(repliesDir)).mode & 0o777,
      0o500,
      "정상 줄·다른 starttime(PID 재사용)이더라도 session-restore.json 이 남아 있으면 봇 init() 이 기본 모드(0700)를 걸지 않고 0500 을 유지해야 한다",
    )

    await chmod(repliesDir, 0o500)
    const runnerDiffStRes = await runSessionScriptWithHooks(
      [f.inbox("$r21-live-same-st")],
      {
        PATH: process.env.PATH,
        AX_MESSENGER_DATA_DIR: f.dir,
        AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, answerScript]),
        AX_RELAY_SESSION_DIR: roleDir,
        AX_RELAY_SESSION_TIMEOUT_MS: "5000",
      },
      `{ readProcStat: () => ${JSON.stringify(mismatchedStatLine)} }`,
    )
    assert.equal(runnerDiffStRes.code, 0, runnerDiffStRes.stderr)
    assert.equal(
      readProcessIdentity(livePair.pid).alive,
      true,
      "PID 재사용 판정 시 재사용된 살아 있는 PID 를 죽이면 안 된다",
    )
    assert.doesNotThrow(
      () => process.kill(-livePair.pgid, 0),
      "PID 재사용 판정(isPidAlive && !pidIdentityMatched) 시 옛 프로세스 그룹을 죽이면 안 된다",
    )
    assert.equal((await lstat(repliesDir)).mode & 0o777, 0o750, "PID 재사용 회수 뒤 원래 모드(0750)로 복원되어야 한다")
    await assert.rejects(() => lstat(restorePath), { code: "ENOENT" })
    await assert.rejects(() => lstat(lockPath), { code: "ENOENT" })
    assert.equal(
      (await readFile(f.reply("$r21-live-same-st"), "utf8")).trim(),
      "세갈래답:정상줄같은시작시각과다른시작시각",
    )
  } finally {
    for (const child of childrenToKill) {
      if (child.pid) {
        try { process.kill(child.pid, "SIGKILL") } catch { /* ignore */ }
      }
    }
    for (const pgid of pgidsToKill) {
      if (pgid > 0) {
        try { process.kill(-pgid, "SIGKILL") } catch { /* ignore */ }
      }
    }
    await f.cleanup()
  }
})

test("22회차 회귀: kill(pid, 0) 비-ESRCH/EPERM 오류(EINVAL 등)·boot_id 읽기 실패/잠금 boot_id 없음(boot-unknown)·알 수 없는 한 글자 상태(Q)+다른 starttime 모름 유지·상한 초과 회수·감사 및 --reclaim-lock 상한 안 거부", async () => {
  const f = await fixture()
  const childrenToKill: Array<ReturnType<typeof spawn>> = []
  const pgidsToKill: number[] = []

  function spawnDummyPair() {
    const runner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
    const group = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    })
    childrenToKill.push(runner, group)
    if (group.pid) pgidsToKill.push(group.pid)
    return { runner, group, pid: runner.pid!, pgid: group.pid! }
  }

  function makeStatLine(pid: number | string, comm: string, stateChar: string, starttime: string, totalAfterParen = 30): string {
    const rest: string[] = [stateChar]
    for (let i = 1; i < totalAfterParen; i++) {
      rest.push(i === 19 ? starttime : String(100 + i))
    }
    return `${pid} (${comm}) ${rest.join(" ")}\n`
  }

  try {
    const runnerMod = (await import(pathToFileURL(sessionRunScript).href)) as {
      AX_PROC_STAT_ALIVE_STATES: readonly string[]
      AX_PROC_STAT_DEAD_STATES: readonly string[]
      AX_RELAY_LOCK_BOOT_UNKNOWN_RECLAIM_REASON: string
      isValidBootId: typeof isValidBootId
      parseProcStatLine: typeof parseProcStatLine
      readProcessIdentity: typeof readProcessIdentity
      evaluateSessionLockPayload: typeof evaluateSessionLockPayload
    }

    // 봇과 실행기의 상태 글자 상수 집합 및 boot_id 검증·감사 사유 상수가 완전히 같아야 한다.
    assert.deepEqual([...runnerMod.AX_PROC_STAT_ALIVE_STATES], [...AX_PROC_STAT_ALIVE_STATES])
    assert.deepEqual([...runnerMod.AX_PROC_STAT_DEAD_STATES], [...AX_PROC_STAT_DEAD_STATES])
    assert.deepEqual([...AX_PROC_STAT_ALIVE_STATES], ["R", "S", "D", "T", "t", "P", "I"])
    assert.deepEqual([...AX_PROC_STAT_DEAD_STATES], ["Z", "X"])
    assert.equal(
      AX_RELAY_LOCK_BOOT_UNKNOWN_RECLAIM_REASON,
      "부팅 식별 모름(boot-unknown) → 벽시계 상한 회수",
    )
    assert.equal(runnerMod.AX_RELAY_LOCK_BOOT_UNKNOWN_RECLAIM_REASON, AX_RELAY_LOCK_BOOT_UNKNOWN_RECLAIM_REASON)

    for (const sample of ["", "   ", "???", "a", "boot-test-1", "boot id with space", "bad/boot", 123, null, undefined]) {
      assert.equal(isValidBootId(sample), false)
      assert.equal(runnerMod.isValidBootId(sample), false)
    }
    for (const validSample of ["00000000-1111-2222-3333-444444444444", "a1b2c3d4-e5f6-7890-abcd-ef1234567890"]) {
      assert.equal(isValidBootId(validSample), true)
      assert.equal(runnerMod.isValidBootId(validSample), true)
    }

    // EPERM 은 살아 있음 후보로 보아 /proc/<pid>/stat 판정으로 진행하고, ESRCH 만 죽음 확인이다.
    const selfProc = readProcessIdentity(process.pid)
    const epermKill = () => {
      const err = new Error("EPERM") as NodeJS.ErrnoException
      err.code = "EPERM"
      throw err
    }
    const esrchKill = () => {
      const err = new Error("ESRCH") as NodeJS.ErrnoException
      err.code = "ESRCH"
      throw err
    }
    const einvalKill = () => {
      const err = new Error("EINVAL") as NodeJS.ErrnoException
      err.code = "EINVAL"
      throw err
    }
    assert.equal(readProcessIdentity(process.pid, { kill0: epermKill }).status, "alive")
    assert.equal(runnerMod.readProcessIdentity(process.pid, { kill0: epermKill }).status, "alive")
    assert.equal(readProcessIdentity(process.pid, { kill0: esrchKill }).status, "dead")
    assert.equal(runnerMod.readProcessIdentity(process.pid, { kill0: esrchKill }).status, "dead")
    assert.equal(readProcessIdentity(process.pid, { kill0: einvalKill }).status, "unknown")
    assert.equal(runnerMod.readProcessIdentity(process.pid, { kill0: einvalKill }).status, "unknown")

    const roleDir = path.join(f.dir, "role-r22-regression")
    await mkdir(roleDir, { recursive: true, mode: 0o755 })
    await chmod(roleDir, 0o755)
    await writeFile(path.join(roleDir, "AGENTS.md"), "# 역할 지시\n", { mode: 0o640 })

    const repliesDir = path.join(f.dir, "relay", "replies")
    const restorePath = path.join(f.dir, "relay", "session-restore.json")
    const lockPath = path.join(f.dir, "relay", "session.lock")
    const sessionLogPath = path.join(f.dir, "relay", "session-log.jsonl")

    const answerScript = path.join(f.dir, "r22-answer.mjs")
    await writeFile(
      answerScript,
      `import { readFileSync, writeFileSync } from "node:fs";
const q = JSON.parse(readFileSync("question.json", "utf8"));
writeFileSync("answer.md", "22회차답:" + q.body, { mode: 0o600 });
`,
      { mode: 0o600 },
    )

    // =========================================================================
    // (가) kill(pid, 0) 이 EINVAL 등 ESRCH·EPERM 밖 오류를 낼 때:
    //   - 25시간 상한 안(+30초, +24시간): 봇 init() 과 두 번째 실행기 main() 모두 잠금·replies 0500 유지
    //   - --reclaim-lock 상한 안: 종료 코드 1로 거부하고 잠금·replies 0500 유지 및 거부 감사 기록
    //   - 25시간 상한 밖(+25시간 1분): 봇 init() 과 두 번째 실행기 main() 모두 회수·복원 및 identity-unknown 감사 기록
    // =========================================================================
    {
      const pair = spawnDummyPair()
      const realProc = readProcessIdentity(pair.pid)
      const qId = "$r22-kill-einval"
      const qBody = "kill기타오류모름유지및상한회수"
      await f.relay.forward(f.question(qId, "!room1", qBody))
      const baseAt = Date.now()
      await writeFile(
        restorePath,
        `${JSON.stringify({ repliesMode: 0o750, at: baseAt, pid: pair.pid })}\n`,
        { mode: 0o600 },
      )
      await chmod(repliesDir, 0o500)
      await writeFile(
        lockPath,
        `${JSON.stringify({
          token: "r22-kill-einval-token",
          pid: pair.pid,
          starttime: realProc.starttime,
          boot_id: realProc.bootId,
          pgid: pair.pgid,
          at: baseAt,
          heartbeatAt: baseAt,
          heartbeatUptimeMs: 1_000,
          heartbeatStaleMs: 10_000,
          timeoutMs: 60_000,
        })}\n`,
        { mode: 0o600 },
      )

      const botKill0Hook = (pid: number) => {
        if (pid === pair.pid) {
          const err = new Error("EINVAL") as NodeJS.ErrnoException
          err.code = "EINVAL"
          throw err
        }
      }
      const runnerKill0HookExpr = `(pid) => { if (pid === ${pair.pid}) { const e = new Error("EINVAL"); e.code = "EINVAL"; throw e; } }`

      for (const elapsedMs of [30_000, 86_400_000]) {
        const botWithinLogs: string[] = []
        const botWithin = createSessionRelay({
          ...f.options,
          now: () => baseAt + elapsedMs,
          kill0: botKill0Hook,
          log: (line) => botWithinLogs.push(line),
        })
        await botWithin.init()
        assert.equal(
          (await lstat(repliesDir)).mode & 0o777,
          0o500,
          `[kill-einval] ${elapsedMs}ms(상한 안)에서 봇 init() 이 replies 0500 을 풀면 안 된다`,
        )
        assert.ok(!botWithinLogs.some((l) => l.includes("reclaim")))

        const runnerWithinRes = await runSessionScriptWithHooks(
          [f.inbox(qId)],
          {
            PATH: process.env.PATH,
            AX_MESSENGER_DATA_DIR: f.dir,
            AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, answerScript]),
            AX_RELAY_SESSION_DIR: roleDir,
            AX_RELAY_SESSION_TIMEOUT_MS: "5000",
          },
          `{ now: () => ${baseAt + elapsedMs}, kill0: ${runnerKill0HookExpr} }`,
        )
        assert.equal(runnerWithinRes.code, 0, runnerWithinRes.stderr)
        assert.equal(readProcessIdentity(pair.pid).alive, true)
        assert.doesNotThrow(() => process.kill(-pair.pgid, 0))
        assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500)
        assert.equal(JSON.parse(await readFile(lockPath, "utf8")).pid, pair.pid)
        await assert.rejects(() => lstat(f.reply(qId)), { code: "ENOENT" })
      }

      // (라-1) --reclaim-lock 상한 안 거부
      const reclaimRejectRes = await runSessionScriptWithHooks(
        ["--reclaim-lock"],
        {
          PATH: process.env.PATH,
          AX_MESSENGER_DATA_DIR: f.dir,
        },
        `{ now: () => ${baseAt + 30_000}, kill0: ${runnerKill0HookExpr} }`,
      )
      assert.equal(reclaimRejectRes.code, 1, "[kill-einval] 상한 안 --reclaim-lock 은 종료 코드 1로 거부해야 한다")
      assert.match(reclaimRejectRes.stderr, /reclaim rejected.*살아 있는 실행기 잠금 회수 거부/)
      assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500)
      assert.equal(JSON.parse(await readFile(lockPath, "utf8")).pid, pair.pid)

      // 상한 밖(+25시간 1분) 회수·복원 및 감사 기록
      const pastMaxMs = AX_RELAY_LOCK_WALL_CLOCK_MAX_MS + 60_000
      const botPastLogs: string[] = []
      const botPast = createSessionRelay({
        ...f.options,
        now: () => baseAt + pastMaxMs,
        kill0: botKill0Hook,
        log: (line) => botPastLogs.push(line),
      })
      await botPast.init()
      assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500, "[kill-einval] 상한 초과 시에도 session-restore.json 이 남아 있으면 봇 init() 이 0500 을 유지해야 한다")
      assert.ok(botPastLogs.some((l) => l.includes(AX_RELAY_LOCK_IDENTITY_UNKNOWN_RECLAIM_REASON)))

      await chmod(repliesDir, 0o500)
      const runnerPastRes = await runSessionScriptWithHooks(
        [f.inbox(qId)],
        {
          PATH: process.env.PATH,
          AX_MESSENGER_DATA_DIR: f.dir,
          AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, answerScript]),
          AX_RELAY_SESSION_DIR: roleDir,
          AX_RELAY_SESSION_TIMEOUT_MS: "5000",
        },
        `{ now: () => ${baseAt + pastMaxMs}, kill0: ${runnerKill0HookExpr} }`,
      )
      assert.equal(runnerPastRes.code, 0, runnerPastRes.stderr)
      assert.ok(runnerPastRes.stderr.includes(AX_RELAY_LOCK_IDENTITY_UNKNOWN_RECLAIM_REASON))
      assert.equal(readProcessIdentity(pair.pid).alive, false)
      assert.throws(() => process.kill(-pair.pgid, 0), { code: "ESRCH" })
      assert.equal((await lstat(repliesDir)).mode & 0o777, 0o750)
      await assert.rejects(() => lstat(restorePath), { code: "ENOENT" })
      await assert.rejects(() => lstat(lockPath), { code: "ENOENT" })
      assert.equal((await readFile(f.reply(qId), "utf8")).trim(), `22회차답:${qBody}`)

      const auditRows = (await readFile(sessionLogPath, "utf8"))
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
      assert.ok(
        auditRows.some(
          (r) =>
            r.event === "lock-reclaim" &&
            r.actor === "operator" &&
            r.action === "rejected" &&
            r.pid === pair.pid &&
            r.lockIdentityStatus === "unknown",
        ),
        "[kill-einval] 운영 --reclaim-lock 거부 감사 기록이 남아야 한다",
      )
      assert.ok(
        auditRows.some(
          (r) =>
            r.event === "lock-reclaim" &&
            r.actor === "bot" &&
            r.pid === pair.pid &&
            r.lockIdentityStatus === "unknown" &&
            r.lockReclaimReason === AX_RELAY_LOCK_IDENTITY_UNKNOWN_RECLAIM_REASON,
        ),
        "[kill-einval] 봇 상한 회수 감사 기록이 남아야 한다",
      )
      assert.ok(
        auditRows.some(
          (r) =>
            r.event === "lock-reclaim" &&
            r.actor === "runner" &&
            r.pid === pair.pid &&
            r.lockIdentityStatus === "unknown" &&
            r.lockReclaimReason === AX_RELAY_LOCK_IDENTITY_UNKNOWN_RECLAIM_REASON,
        ),
        "[kill-einval] 실행기 상한 회수 감사 기록이 남아야 한다",
      )
    }

    // =========================================================================
    // (나) boot_id 세 갈래:
    //   1) 지금 boot_id 읽기 실패(예외 또는 빈 값)
    //   2) 잠금에 boot_id 가 없음(또는 꼴이 깨짐)
    //      -> 둘 다 "모름"으로 25시간 상한 안 유지, --reclaim-lock 상한 안 거부, 상한 밖 회수 + boot-unknown 감사
    //   3) 둘 다 정상으로 읽혔고 서로 다른 boot_id -> 상한 전이라도 즉시 회수
    // =========================================================================
    const bootUnknownCases: Array<{
      name: string
      qId: string
      qBody: string
      lockBootField: Record<string, unknown>
      botReadBootId?: () => string
      runnerReadBootIdExpr?: string
    }> = [
      {
        name: "current-boot-read-failed",
        qId: "$r22-boot-read-fail",
        qBody: "현재부트ID읽기실패모름회수",
        lockBootField: { boot_id: selfProc.bootId },
        botReadBootId: () => {
          const err = new Error("EIO reading boot_id") as NodeJS.ErrnoException
          err.code = "EIO"
          throw err
        },
        runnerReadBootIdExpr: `() => { const e = new Error("EIO"); e.code = "EIO"; throw e; }`,
      },
      {
        name: "lock-boot-missing",
        qId: "$r22-lock-boot-missing",
        qBody: "잠금부트ID없음모름회수",
        lockBootField: {},
      },
      {
        name: "lock-boot-malformed",
        qId: "$r22-lock-boot-malformed",
        qBody: "잠금부트ID깨짐모름회수",
        lockBootField: { boot_id: "??invalid boot id??" },
      },
    ]

    for (const bc of bootUnknownCases) {
      const pair = spawnDummyPair()
      const realProc = readProcessIdentity(pair.pid)
      await f.relay.forward(f.question(bc.qId, "!room1", bc.qBody))
      const baseAt = Date.now()
      await writeFile(
        restorePath,
        `${JSON.stringify({ repliesMode: 0o750, at: baseAt, pid: pair.pid })}\n`,
        { mode: 0o600 },
      )
      await chmod(repliesDir, 0o500)
      await writeFile(
        lockPath,
        `${JSON.stringify({
          token: `r22-${bc.name}-token`,
          pid: pair.pid,
          starttime: realProc.starttime,
          ...bc.lockBootField,
          pgid: pair.pgid,
          at: baseAt,
          heartbeatAt: baseAt,
          heartbeatUptimeMs: 1_000,
          heartbeatStaleMs: 10_000,
          timeoutMs: 60_000,
        })}\n`,
        { mode: 0o600 },
      )

      for (const elapsedMs of [30_000, 86_400_000]) {
        const botWithinLogs: string[] = []
        const botWithin = createSessionRelay({
          ...f.options,
          now: () => baseAt + elapsedMs,
          ...(bc.botReadBootId ? { readBootId: bc.botReadBootId } : {}),
          log: (line) => botWithinLogs.push(line),
        })
        await botWithin.init()
        assert.equal(
          (await lstat(repliesDir)).mode & 0o777,
          0o500,
          `[${bc.name}] ${elapsedMs}ms(상한 안)에서 봇 init() 이 replies 0500 을 풀면 안 된다`,
        )
        assert.ok(!botWithinLogs.some((l) => l.includes("reclaim")))

        const runnerWithinHooks = `{
          now: () => ${baseAt + elapsedMs}
          ${bc.runnerReadBootIdExpr ? `, readBootId: ${bc.runnerReadBootIdExpr}` : ""}
        }`
        const runnerWithinRes = await runSessionScriptWithHooks(
          [f.inbox(bc.qId)],
          {
            PATH: process.env.PATH,
            AX_MESSENGER_DATA_DIR: f.dir,
            AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, answerScript]),
            AX_RELAY_SESSION_DIR: roleDir,
            AX_RELAY_SESSION_TIMEOUT_MS: "5000",
          },
          runnerWithinHooks,
        )
        assert.equal(runnerWithinRes.code, 0, runnerWithinRes.stderr)
        assert.equal(readProcessIdentity(pair.pid).alive, true)
        assert.doesNotThrow(() => process.kill(-pair.pgid, 0))
        assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500)
        assert.equal(JSON.parse(await readFile(lockPath, "utf8")).pid, pair.pid)
        await assert.rejects(() => lstat(f.reply(bc.qId)), { code: "ENOENT" })
      }

      // (라-2) --reclaim-lock 상한 안 거부
      const reclaimRejectHooks = `{
        now: () => ${baseAt + 30_000}
        ${bc.runnerReadBootIdExpr ? `, readBootId: ${bc.runnerReadBootIdExpr}` : ""}
      }`
      const reclaimRejectRes = await runSessionScriptWithHooks(
        ["--reclaim-lock"],
        {
          PATH: process.env.PATH,
          AX_MESSENGER_DATA_DIR: f.dir,
        },
        reclaimRejectHooks,
      )
      assert.equal(reclaimRejectRes.code, 1, `[${bc.name}] 상한 안 --reclaim-lock 은 종료 코드 1로 거부해야 한다`)
      assert.match(reclaimRejectRes.stderr, /reclaim rejected.*살아 있는 실행기 잠금 회수 거부/)
      assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500)
      assert.equal(JSON.parse(await readFile(lockPath, "utf8")).pid, pair.pid)

      // 상한 밖(+25시간 1분) 회수·복원 및 boot-unknown 감사 기록
      const pastMaxMs = AX_RELAY_LOCK_WALL_CLOCK_MAX_MS + 60_000
      const botPastLogs: string[] = []
      const botPast = createSessionRelay({
        ...f.options,
        now: () => baseAt + pastMaxMs,
        ...(bc.botReadBootId ? { readBootId: bc.botReadBootId } : {}),
        log: (line) => botPastLogs.push(line),
      })
      await botPast.init()
      assert.equal(
        (await lstat(repliesDir)).mode & 0o777,
        0o500,
        `[${bc.name}] 상한 초과 시에도 session-restore.json 이 남아 있으면 봇 init() 이 0500 을 유지해야 한다`,
      )
      assert.ok(
        botPastLogs.some((l) => l.includes(AX_RELAY_LOCK_BOOT_UNKNOWN_RECLAIM_REASON)),
        `[${bc.name}] 상한 초과 시 봇 로그에 '${AX_RELAY_LOCK_BOOT_UNKNOWN_RECLAIM_REASON}' 사유가 남아야 한다`,
      )

      await chmod(repliesDir, 0o500)
      const runnerPastHooks = `{
        now: () => ${baseAt + pastMaxMs}
        ${bc.runnerReadBootIdExpr ? `, readBootId: ${bc.runnerReadBootIdExpr}` : ""}
      }`
      const runnerPastRes = await runSessionScriptWithHooks(
        [f.inbox(bc.qId)],
        {
          PATH: process.env.PATH,
          AX_MESSENGER_DATA_DIR: f.dir,
          AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, answerScript]),
          AX_RELAY_SESSION_DIR: roleDir,
          AX_RELAY_SESSION_TIMEOUT_MS: "5000",
        },
        runnerPastHooks,
      )
      assert.equal(runnerPastRes.code, 0, runnerPastRes.stderr)
      assert.ok(
        runnerPastRes.stderr.includes(AX_RELAY_LOCK_BOOT_UNKNOWN_RECLAIM_REASON),
        `[${bc.name}] 상한 초과 시 실행기 표준 오류에 '${AX_RELAY_LOCK_BOOT_UNKNOWN_RECLAIM_REASON}' 사유가 남아야 한다`,
      )
      assert.equal(readProcessIdentity(pair.pid).alive, false)
      assert.throws(() => process.kill(-pair.pgid, 0), { code: "ESRCH" })
      assert.equal((await lstat(repliesDir)).mode & 0o777, 0o750)
      await assert.rejects(() => lstat(restorePath), { code: "ENOENT" })
      await assert.rejects(() => lstat(lockPath), { code: "ENOENT" })
      assert.equal((await readFile(f.reply(bc.qId), "utf8")).trim(), `22회차답:${bc.qBody}`)

      const auditRows = (await readFile(sessionLogPath, "utf8"))
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
      assert.ok(
        auditRows.some(
          (r) =>
            r.event === "lock-reclaim" &&
            r.actor === "operator" &&
            r.action === "rejected" &&
            r.pid === pair.pid &&
            r.lockBootStatus === "unknown",
        ),
        `[${bc.name}] 운영 --reclaim-lock 거부 감사 기록에 lockBootStatus: 'unknown' 이 남아야 한다`,
      )
      assert.ok(
        auditRows.some(
          (r) =>
            r.event === "lock-reclaim" &&
            r.actor === "bot" &&
            r.pid === pair.pid &&
            r.lockBootStatus === "unknown" &&
            r.lockReclaimReason === AX_RELAY_LOCK_BOOT_UNKNOWN_RECLAIM_REASON,
        ),
        `[${bc.name}] 봇의 boot-unknown 상한 회수 감사 기록이 남아야 한다`,
      )
      assert.ok(
        auditRows.some(
          (r) =>
            r.event === "lock-reclaim" &&
            r.actor === "runner" &&
            r.pid === pair.pid &&
            r.lockBootStatus === "unknown" &&
            r.lockReclaimReason === AX_RELAY_LOCK_BOOT_UNKNOWN_RECLAIM_REASON,
        ),
        `[${bc.name}] 실행기의 boot-unknown 상한 회수 감사 기록이 남아야 한다`,
      )
      const sessionRow = auditRows.find((r) => r.file === `${relayName(bc.qId)}.json`)
      assert.equal(sessionRow?.lockBootStatus, "unknown")
      assert.equal(sessionRow?.lockReclaimReason, AX_RELAY_LOCK_BOOT_UNKNOWN_RECLAIM_REASON)
    }

    // (나-3) 정상 다른 boot_id 는 상한을 기다리지 않고 즉시 회수·복원
    {
      const pair = spawnDummyPair()
      const realProc = readProcessIdentity(pair.pid)
      const qId = "$r22-boot-diff-immediate"
      const qBody = "정상다른부트ID즉시회수"
      await f.relay.forward(f.question(qId, "!room1", qBody))
      const baseAt = Date.now()
      await writeFile(
        restorePath,
        `${JSON.stringify({ repliesMode: 0o750, at: baseAt, pid: pair.pid })}\n`,
        { mode: 0o600 },
      )
      await chmod(repliesDir, 0o500)
      await writeFile(
        lockPath,
        `${JSON.stringify({
          token: "r22-boot-diff-token",
          pid: pair.pid,
          starttime: realProc.starttime,
          boot_id: realProc.bootId.startsWith("0")
            ? "11111111-2222-4333-8444-555555555555"
            : "00000000-2222-4333-8444-555555555555",
          pgid: pair.pgid,
          at: baseAt,
          heartbeatAt: baseAt,
          heartbeatUptimeMs: readUptimeMs() ?? 1000,
          heartbeatStaleMs: 60_000,
          timeoutMs: 300_000,
        })}\n`,
        { mode: 0o600 },
      )

      const botDiffBoot = createSessionRelay({ ...f.options })
      await botDiffBoot.init()
      assert.equal(
        (await lstat(repliesDir)).mode & 0o777,
        0o500,
        "양쪽 boot_id 가 정상이고 다르더라도 session-restore.json 이 남아 있으면 봇 init() 이 0500 을 유지해야 한다",
      )

      await chmod(repliesDir, 0o500)
      const runnerDiffBootRes = await runSessionScriptWithHooks(
        [f.inbox(qId)],
        {
          PATH: process.env.PATH,
          AX_MESSENGER_DATA_DIR: f.dir,
          AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, answerScript]),
          AX_RELAY_SESSION_DIR: roleDir,
          AX_RELAY_SESSION_TIMEOUT_MS: "5000",
        },
        `{}`,
      )
      assert.equal(runnerDiffBootRes.code, 0, runnerDiffBootRes.stderr)
      assert.equal((await lstat(repliesDir)).mode & 0o777, 0o750)
      assert.equal((await readFile(f.reply(qId), "utf8")).trim(), `22회차답:${qBody}`)
    }

    // =========================================================================
    // (다) 상태 글자 'Q'(한 글자)와 숫자 starttime 이 잠금과 다른 줄:
    //   - PID 재사용(stale)으로 오판하지 않고 "모름"(unknown)으로 보아 25시간 상한 안에서 잠금·replies 0500 유지
    //   - --reclaim-lock 도 상한 안에서는 종료 코드 1로 거부
    //   - 25시간 상한 밖에서는 회수·복원 및 identity-unknown 감사 기록
    // =========================================================================
    {
      const pair = spawnDummyPair()
      const realProc = readProcessIdentity(pair.pid)
      const qId = "$r22-state-q-diff-starttime"
      const qBody = "상태글자Q다른시작시각모름유지"
      await f.relay.forward(f.question(qId, "!room1", qBody))
      const baseAt = Date.now()
      await writeFile(
        restorePath,
        `${JSON.stringify({ repliesMode: 0o750, at: baseAt, pid: pair.pid })}\n`,
        { mode: 0o600 },
      )
      await chmod(repliesDir, 0o500)
      await writeFile(
        lockPath,
        `${JSON.stringify({
          token: "r22-state-q-token",
          pid: pair.pid,
          starttime: realProc.starttime,
          boot_id: realProc.bootId,
          pgid: pair.pgid,
          at: baseAt,
          heartbeatAt: baseAt,
          heartbeatUptimeMs: 1_000,
          heartbeatStaleMs: 10_000,
          timeoutMs: 60_000,
        })}\n`,
        { mode: 0o600 },
      )

      // 상태 글자가 한 글자 'Q' 이고 22번째 칸 starttime 은 잠금과 다른 숫자(`${realProc.starttime}777`)인 줄
      const qStateDiffStarttimeLine = makeStatLine(pair.pid, "weird-state-q", "Q", `${realProc.starttime}777`)
      const botQReadStat = (pid: number) =>
        pid === pair.pid ? qStateDiffStarttimeLine : makeStatLine(pid, "node", "S", realProc.starttime)
      const runnerQReadStatExpr = `(pid) => pid === ${pair.pid} ? ${JSON.stringify(qStateDiffStarttimeLine)} : ${JSON.stringify(makeStatLine(pair.pid, "node", "S", realProc.starttime))}`

      for (const elapsedMs of [30_000, 86_400_000]) {
        const botWithinLogs: string[] = []
        const botWithin = createSessionRelay({
          ...f.options,
          now: () => baseAt + elapsedMs,
          readProcStat: botQReadStat,
          log: (line) => botWithinLogs.push(line),
        })
        await botWithin.init()
        assert.equal(
          (await lstat(repliesDir)).mode & 0o777,
          0o500,
          `[state-Q] ${elapsedMs}ms(상한 안)에서 한 글자 'Q'+다른 starttime 줄을 PID 재사용으로 오판해 풀면 안 된다`,
        )
        assert.ok(!botWithinLogs.some((l) => l.includes("reclaim")))

        const runnerWithinRes = await runSessionScriptWithHooks(
          [f.inbox(qId)],
          {
            PATH: process.env.PATH,
            AX_MESSENGER_DATA_DIR: f.dir,
            AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, answerScript]),
            AX_RELAY_SESSION_DIR: roleDir,
            AX_RELAY_SESSION_TIMEOUT_MS: "5000",
          },
          `{ now: () => ${baseAt + elapsedMs}, readProcStat: ${runnerQReadStatExpr} }`,
        )
        assert.equal(runnerWithinRes.code, 0, runnerWithinRes.stderr)
        assert.equal(readProcessIdentity(pair.pid).alive, true)
        assert.doesNotThrow(() => process.kill(-pair.pgid, 0))
        assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500)
        assert.equal(JSON.parse(await readFile(lockPath, "utf8")).pid, pair.pid)
        await assert.rejects(() => lstat(f.reply(qId)), { code: "ENOENT" })
      }

      // (라-3) 상태 글자 'Q' + 다른 starttime 잠금에 대해 --reclaim-lock 상한 안 거부
      const reclaimQRejectRes = await runSessionScriptWithHooks(
        ["--reclaim-lock"],
        {
          PATH: process.env.PATH,
          AX_MESSENGER_DATA_DIR: f.dir,
        },
        `{ now: () => ${baseAt + 30_000}, readProcStat: ${runnerQReadStatExpr} }`,
      )
      assert.equal(reclaimQRejectRes.code, 1, "[state-Q] 상한 안 --reclaim-lock 은 종료 코드 1로 거부해야 한다")
      assert.match(reclaimQRejectRes.stderr, /reclaim rejected.*살아 있는 실행기 잠금 회수 거부/)
      assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500)
      assert.equal(JSON.parse(await readFile(lockPath, "utf8")).pid, pair.pid)

      // 상한 밖(+25시간 1분)에서는 회수·복원 및 identity-unknown 감사 기록
      const pastMaxMs = AX_RELAY_LOCK_WALL_CLOCK_MAX_MS + 60_000
      const botPastLogs: string[] = []
      const botPast = createSessionRelay({
        ...f.options,
        now: () => baseAt + pastMaxMs,
        readProcStat: botQReadStat,
        log: (line) => botPastLogs.push(line),
      })
      await botPast.init()
      assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500)
      assert.ok(botPastLogs.some((l) => l.includes(AX_RELAY_LOCK_IDENTITY_UNKNOWN_RECLAIM_REASON)))

      await chmod(repliesDir, 0o500)
      const runnerPastRes = await runSessionScriptWithHooks(
        [f.inbox(qId)],
        {
          PATH: process.env.PATH,
          AX_MESSENGER_DATA_DIR: f.dir,
          AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, answerScript]),
          AX_RELAY_SESSION_DIR: roleDir,
          AX_RELAY_SESSION_TIMEOUT_MS: "5000",
        },
        `{ now: () => ${baseAt + pastMaxMs}, readProcStat: ${runnerQReadStatExpr} }`,
      )
      assert.equal(runnerPastRes.code, 0, runnerPastRes.stderr)
      assert.ok(runnerPastRes.stderr.includes(AX_RELAY_LOCK_IDENTITY_UNKNOWN_RECLAIM_REASON))
      assert.equal(readProcessIdentity(pair.pid).alive, false)
      assert.throws(() => process.kill(-pair.pgid, 0), { code: "ESRCH" })
      assert.equal((await lstat(repliesDir)).mode & 0o777, 0o750)
      await assert.rejects(() => lstat(restorePath), { code: "ENOENT" })
      await assert.rejects(() => lstat(lockPath), { code: "ENOENT" })
      assert.equal((await readFile(f.reply(qId), "utf8")).trim(), `22회차답:${qBody}`)
    }
  } finally {
    for (const child of childrenToKill) {
      if (child.pid) {
        try { process.kill(child.pid, "SIGKILL") } catch { /* ignore */ }
      }
    }
    for (const pgid of pgidsToKill) {
      if (pgid > 0) {
        try { process.kill(-pgid, "SIGKILL") } catch { /* ignore */ }
      }
    }
    await f.cleanup()
  }
})

test(
  "23회차: boot_id UUID 정규화·비교, 잠금 꼴 검사, 프로세스 그룹 kill(-pgid,0) 세 갈래 단위 판정",
  async () => {
    const runnerMod = await import(pathToFileURL(sessionRunScript).href)

    // 두 사본의 정규식·상수가 완전히 일치해야 한다.
    assert.equal(String(runnerMod.AX_BOOT_ID_UUID_REGEX), String(AX_BOOT_ID_UUID_REGEX))
    assert.equal(
      String(AX_BOOT_ID_UUID_REGEX),
      "/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/",
    )
    assert.equal(
      runnerMod.AX_RELAY_LOCK_UNREADABLE_RECLAIM_REASON,
      AX_RELAY_LOCK_UNREADABLE_RECLAIM_REASON,
    )
    assert.equal(
      runnerMod.AX_RELAY_LOCK_UNREADABLE_DEFER_REASON,
      AX_RELAY_LOCK_UNREADABLE_DEFER_REASON,
    )
    assert.equal(
      runnerMod.AX_RELAY_LOCK_PGID_UNKNOWN_DEFER_REASON,
      AX_RELAY_LOCK_PGID_UNKNOWN_DEFER_REASON,
    )

    // 1. normalizeBootId / isValidBootId: 앞뒤 공백·줄바꿈만 떼고 소문자로 바꾼 뒤 UUID 정규식 검사
    const rawUpper = "  \n\tA1B2C3D4-E5F6-7890-ABCD-EF1234567890\r\n  "
    assert.equal(normalizeBootId(rawUpper), "a1b2c3d4-e5f6-7890-abcd-ef1234567890")
    assert.equal(runnerMod.normalizeBootId(rawUpper), "a1b2c3d4-e5f6-7890-abcd-ef1234567890")
    assert.equal(isValidBootId(rawUpper), true)
    assert.equal(runnerMod.isValidBootId(rawUpper), true)

    const nonUuidSamples = [
      "abc",
      "boot-test-1",
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890-prev-boot",
      "a1b2c3d4-e5f6-7890-abcd-ef123456789", // 35자
      "a1b2c3d4-e5f6-7890-abcd-ef12345678901", // 37자
      "g1b2c3d4-e5f6-7890-abcd-ef1234567890", // 16진수 밖 글자
      "a1b2c3d4e5f67890abcdef1234567890", // 하이픈 없음
      "a1b2c3d4-e5f6-7890-abcd-ef12 3456789", // 가운데 공백
    ]
    for (const bad of nonUuidSamples) {
      assert.equal(normalizeBootId(bad), "", `UUID 가 아닌 값(${bad})은 빈 문자열로 정규화되어야 한다`)
      assert.equal(runnerMod.normalizeBootId(bad), "")
      assert.equal(isValidBootId(bad), false)
      assert.equal(runnerMod.isValidBootId(bad), false)
    }

    // 2. isValidSessionLockShape: 필수 칸(pid 양의 정수, at 양의 유한수) 검사
    for (const badLock of [
      null,
      undefined,
      "string",
      [],
      {},
      { pid: 0, at: 1000 },
      { pid: -1, at: 1000 },
      { pid: "123", at: 1000 },
      { pid: 123 },
      { pid: 123, at: 0 },
      { pid: 123, at: 1000, heartbeatAt: -5 },
      { pid: 123, at: 1000, pgid: -1 },
      { pid: 123, at: 1000, heartbeatUptimeMs: -1 },
    ]) {
      assert.equal(isValidSessionLockShape(badLock), false)
      assert.equal(runnerMod.isValidSessionLockShape(badLock), false)
    }
    assert.equal(isValidSessionLockShape({ pid: 123, at: 1000 }), true)
    assert.equal(runnerMod.isValidSessionLockShape({ pid: 123, at: 1000 }), true)

    // 3. checkProcessGroupStatus / isProcessGroupAlive: ESRCH 만 dead, 성공·EPERM 은 alive, 그 밖(EINVAL 등)은 unknown
    const esrchHook = () => {
      const e = new Error("ESRCH") as NodeJS.ErrnoException
      e.code = "ESRCH"
      throw e
    }
    const epermHook = () => {
      const e = new Error("EPERM") as NodeJS.ErrnoException
      e.code = "EPERM"
      throw e
    }
    const einvalHook = () => {
      const e = new Error("EINVAL") as NodeJS.ErrnoException
      e.code = "EINVAL"
      throw e
    }
    assert.equal(checkProcessGroupStatus(999999, esrchHook), "dead")
    assert.equal(runnerMod.checkProcessGroupStatus(999999, esrchHook), "dead")
    assert.equal(isProcessGroupAlive(999999, esrchHook), false)
    assert.equal(runnerMod.isProcessGroupAlive(999999, esrchHook), false)

    assert.equal(checkProcessGroupStatus(999999, epermHook), "alive")
    assert.equal(runnerMod.checkProcessGroupStatus(999999, epermHook), "alive")
    assert.equal(isProcessGroupAlive(999999, epermHook), true)
    assert.equal(runnerMod.isProcessGroupAlive(999999, epermHook), true)

    assert.equal(checkProcessGroupStatus(999999, einvalHook), "unknown")
    assert.equal(runnerMod.checkProcessGroupStatus(999999, einvalHook), "unknown")
    assert.equal(isProcessGroupAlive(999999, einvalHook), true)
    assert.equal(runnerMod.isProcessGroupAlive(999999, einvalHook), true)
  },
)

test("26회차 감사 손상 뒤 세 callId 기록과 일치 행 앞뒤 손상 검사 및 재시도 중복 방지", async () => {
  const f = await fixture()
  try {
    // 종료 줄바꿈까지 손상된 경우도 새 JSON이 기존 부분 줄에 붙지 않아야 한다.
    await writeFile(f.store.usageFile, "{broken-usage")
    await writeFile(f.store.callFile, "{broken-call")
    await writeFile(f.store.fallbackFile, "{broken-fallback\n")
    const ids = ["$r26-audit-one", "$r26-audit-two", "$r26-audit-three"]
    const callIds: string[] = []
    for (const id of ids) {
      await f.relay.forward(f.question(id))
      const row = JSON.parse(await readFile(f.state(id), "utf8"))
      callIds.push(row.callId)
      await writeFile(f.reply(id), "응답")
      await f.relay.poll()
    }
    const validRows = async (file: string) => (await readFile(file, "utf8")).split("\n").flatMap((line) => {
      try { return [JSON.parse(line)] } catch { return [] }
    })
    const usage = await validRows(f.store.usageFile)
    const calls = await validRows(f.store.callFile)
    for (const callId of callIds) {
      assert.equal(usage.filter((r) => r.callId === callId && r.type === "ai-usage" && r.status === "sent").length, 1)
      assert.equal(calls.filter((r) => r.callId === callId && r.type === "provider-call").length, 1)
      assert.equal(calls.filter((r) => r.callId === callId && r.type === "provider-call-result").length, 1)
    }
    let logRows = await validRows(path.join(f.dir, "relay", "session-log.jsonl"))
    for (const type of ["ai-usage", "provider-call", "provider-call-result"]) {
      for (const callId of callIds) assert.ok(logRows.some((r) => r.event === "possible-duplicate" && r.type === type && r.callId === callId))
    }
    assert.ok(logRows.some((r) => r.event === "audit-jsonl-corrupt" && r.file === "ai-provider-results-fallback.jsonl"))

    // 일치 행이 손상 줄 앞에 오도록 바꾸고 미완료 감사와 전달 복구를 재시도한다.
    await writeFile(f.store.usageFile, `${usage.map((r) => JSON.stringify(r)).join("\n")}\n{broken-usage-after\n`)
    await writeFile(f.store.callFile, `${calls.map((r) => JSON.stringify(r)).join("\n")}\n{broken-call-after\n`)
    for (const id of ids) {
      const row = JSON.parse(await readFile(f.state(id), "utf8"))
      row.audited = false
      await writeFile(f.state(id), `${JSON.stringify(row)}\n`)
      const input = f.question(id)
      await writeFile(path.join(f.dir, "relay", "staging", `${row.callId}.json`), `${JSON.stringify({ ...input, row })}\n`)
    }
    const beforeUsage = await readFile(f.store.usageFile, "utf8")
    const beforeCalls = await readFile(f.store.callFile, "utf8")
    const logs: string[] = []
    await createSessionRelay({ ...f.options, log: (line) => logs.push(line) }).poll()
    assert.equal(await readFile(f.store.usageFile, "utf8"), beforeUsage)
    assert.equal(await readFile(f.store.callFile, "utf8"), beforeCalls)
    assert.ok(logs.some((line) => line.includes("audit-jsonl file error file=ai-usage.jsonl")))
    assert.ok(logs.some((line) => line.includes("audit-jsonl file error file=ai-provider-calls.jsonl")))
    logRows = await validRows(path.join(f.dir, "relay", "session-log.jsonl"))
    assert.ok(logRows.some((r) => r.event === "audit-jsonl-corrupt" && r.file === "ai-usage.jsonl" && r.line === usage.length + 1))
    assert.ok(logRows.some((r) => r.event === "audit-jsonl-corrupt" && r.file === "ai-provider-calls.jsonl" && r.line === calls.length + 1))
  } finally { await f.cleanup() }
})

test(
  "23회차 회귀: 잠금 파일 읽기·해석 오류(EIO·EACCES·JSON 깨짐·꼴 깨짐), boot_id UUID 대소문자·공백·비UUID·다른UUID, kill(-pgid,0) EINVAL 및 --reclaim-lock 상한 안 거부",
  async () => {
    const f = await fixture()
    const childrenToKill: Array<ReturnType<typeof spawn>> = []
    const pgidsToKill: number[] = []
    try {
      const roleDir = path.join(f.dir, "role-r23")
      await mkdir(roleDir, { recursive: true, mode: 0o755 })
      await writeFile(path.join(roleDir, "AGENTS.md"), "# R23 Role\n", { mode: 0o644 })

      const relayRoot = path.join(f.dir, "relay")
      const repliesDir = path.join(relayRoot, "replies")
      const stagingDir = path.join(relayRoot, "staging")
      const lockPath = path.join(relayRoot, "session.lock")
      const restorePath = path.join(relayRoot, "session-restore.json")
      const sessionLogPath = path.join(relayRoot, "session-log.jsonl")

      const dummyRunnerScript = path.join(f.dir, "dummy-runner-r23.mjs")
      await writeFile(
        dummyRunnerScript,
        `setInterval(() => {}, 1000);\n`,
        { mode: 0o600 },
      )
      const dummyGroupScript = path.join(f.dir, "dummy-group-r23.mjs")
      await writeFile(
        dummyGroupScript,
        `setInterval(() => {}, 1000);\n`,
        { mode: 0o600 },
      )

      const spawnDummyPair = () => {
        const runnerChild = spawn(process.execPath, [dummyRunnerScript], { stdio: "ignore" })
        childrenToKill.push(runnerChild)
        const groupLeader = spawn(process.execPath, [dummyGroupScript], {
          detached: true,
          stdio: "ignore",
        })
        childrenToKill.push(groupLeader)
        if (groupLeader.pid) pgidsToKill.push(groupLeader.pid)
        assert.ok(runnerChild.pid && runnerChild.pid > 0)
        assert.ok(groupLeader.pid && groupLeader.pid > 0)
        return { pid: runnerChild.pid, pgid: groupLeader.pid }
      }

      const answerScript = path.join(f.dir, "answer-r23.mjs")
      await writeFile(
        answerScript,
        `import { readFileSync, writeFileSync } from "node:fs";
const q = JSON.parse(readFileSync("question.json", "utf8"));
writeFileSync("answer.md", "23회차답:" + q.body, { mode: 0o600 });
`,
        { mode: 0o600 },
      )

      // =========================================================================
      // (가) 잠금 파일 읽기 EIO·EACCES 와 JSON 깨짐·꼴 깨짐:
      //   - 25시간 상한 안(+30초, +24시간):
      //     * 잠금 파일 유지, replies 0500 유지
      //     * 봇 init() 감사 기록(lock-unreadable), 봇 forward() 는 질문 전달을 미루고(AxRelayPendingError, staging 유지) 감사 기록
      //     * 두 번째 실행기 main() 은 시작을 거부하고 종료 코드 1, 표준 오류와 session-log.jsonl 에 lock-unreadable 기록
      //     * (라-가) --reclaim-lock 도 상한 안에서는 종료 코드 1로 거부하고 lock-unreadable 기록
      //   - lstat 도 실패하면 25시간 상한 밖(+25시간 1분)이어도 회수하지 않는다.
      //   - mtime 이 25시간 상한을 넘고 lstat 이 성공하면 봇·실행기 모두 회수·복원·감사(lock-unreadable)한다.
      // =========================================================================
      const unreadableCases: Array<{
        name: string
        qId: string
        qBody: string
        prepareLockFile: (lockPath: string, baseAt: number, pair: { pid: number; pgid: number }) => Promise<void>
        cleanupLockPerm?: (lockPath: string) => Promise<void>
        botReadLockFile?: (lockPath: string) => Promise<{ body: string; opened: { ino: number; mtimeMs: number } }>
        runnerReadLockExpr?: string
      }> = [
        {
          name: "read-eio",
          qId: "$r23-lock-eio",
          qBody: "잠금읽기EIO모름유지및상한회수",
          prepareLockFile: async (p, baseAt, pair) => {
            const realProc = readProcessIdentity(pair.pid)
            await writeFile(
              p,
              `${JSON.stringify({
                token: "r23-eio-token",
                pid: pair.pid,
                starttime: realProc.starttime,
                boot_id: realProc.bootId,
                pgid: pair.pgid,
                at: baseAt,
                heartbeatAt: baseAt,
              })}\n`,
              { mode: 0o600 },
            )
          },
          botReadLockFile: async () => {
            const err = new Error("EIO reading session.lock") as NodeJS.ErrnoException
            err.code = "EIO"
            throw err
          },
          runnerReadLockExpr: `async () => { const e = new Error("EIO"); e.code = "EIO"; throw e; }`,
        },
        {
          name: "read-eacces",
          qId: "$r23-lock-eacces",
          qBody: "잠금읽기EACCES모름유지및상한회수",
          prepareLockFile: async (p, baseAt, pair) => {
            const realProc = readProcessIdentity(pair.pid)
            await writeFile(
              p,
              `${JSON.stringify({
                token: "r23-eacces-token",
                pid: pair.pid,
                starttime: realProc.starttime,
                boot_id: realProc.bootId,
                pgid: pair.pgid,
                at: baseAt,
                heartbeatAt: baseAt,
              })}\n`,
              { mode: 0o600 },
            )
            await chmod(p, 0o000)
          },
          cleanupLockPerm: async (p) => {
            await chmod(p, 0o600).catch(() => undefined)
          },
          botReadLockFile: async () => {
            const err = new Error("EACCES permission denied") as NodeJS.ErrnoException
            err.code = "EACCES"
            throw err
          },
          runnerReadLockExpr: `async () => { const e = new Error("EACCES"); e.code = "EACCES"; throw e; }`,
        },
        {
          name: "json-corrupt",
          qId: "$r23-lock-corrupt",
          qBody: "잠금JSON깨짐모름유지및상한회수",
          prepareLockFile: async (p) => {
            await writeFile(p, "{corrupted-json-payload\n", { mode: 0o600 })
          },
        },
        {
          name: "json-empty-object",
          qId: "$r23-lock-empty-obj",
          qBody: "잠금빈객체꼴깨짐모름유지및상한회수",
          prepareLockFile: async (p) => {
            await writeFile(p, "{}\n", { mode: 0o600 })
          },
        },
      ]

      for (const uc of unreadableCases) {
        const pair = spawnDummyPair()
        await f.relay.forward(f.question(uc.qId, "!room1", uc.qBody))
        const baseAt = Date.now()
        await writeFile(
          restorePath,
          `${JSON.stringify({ repliesMode: 0o750, at: baseAt, pid: pair.pid })}\n`,
          { mode: 0o600 },
        )
        await chmod(repliesDir, 0o500)
        await uc.prepareLockFile(lockPath, baseAt, pair)
        const lockSt = await lstat(lockPath)
        const lockMtimeMs = lockSt.mtimeMs

        for (const elapsedMs of [30_000, 86_400_000]) {
          const botLogs: string[] = []
          const botWithin = createSessionRelay({
            ...f.options,
            now: () => lockMtimeMs + elapsedMs,
            ...(uc.botReadLockFile ? { readLockFile: uc.botReadLockFile } : {}),
            log: (line) => botLogs.push(line),
          })
          await botWithin.init()
          assert.equal(
            (await lstat(repliesDir)).mode & 0o777,
            0o500,
            `[${uc.name}] ${elapsedMs}ms(상한 안)에서 봇 init() 이 replies 0500 을 풀면 안 된다`,
          )
          assert.ok(
            botLogs.some((l) => l.includes("reason=lock-unreadable")),
            `[${uc.name}] 봇 로그에 reason=lock-unreadable 감사가 남아야 한다`,
          )

          // 봇 forward() 는 잠금이 unreadable 이면 질문 전달을 미루고(AxRelayPendingError) staging 에 남겨야 한다.
          const deferredQId = `${uc.qId}-deferred-${elapsedMs}`
          await assert.rejects(
            () => botWithin.forward(f.question(deferredQId, "!room1", "보류질문")),
            (err: unknown) => err instanceof AxRelayPendingError,
            `[${uc.name}] 잠금 판정 모름(lock-unreadable)일 때 봇은 질문 전달을 미뤄야 한다`,
          )
          await assert.rejects(
            () => lstat(f.inbox(deferredQId)),
            { code: "ENOENT" },
            `[${uc.name}] 보류된 질문이 inbox 로 넘어가면 안 된다`,
          )
          const stagedFiles = await readdir(stagingDir)
          assert.ok(stagedFiles.length > 0, `[${uc.name}] 보류된 질문은 staging 에 남아 있어야 한다`)
          for (const sf of stagedFiles) {
            await rm(path.join(stagingDir, sf), { force: true })
          }

          // 두 번째 실행기 main(): 상한 안에서는 시작을 거부하고 종료 코드 1, 표준 오류와 session-log.jsonl 에 lock-unreadable 기록
          const runnerHooksExpr = `{
            now: () => ${lockMtimeMs + elapsedMs}
            ${uc.runnerReadLockExpr ? `, readLockFile: ${uc.runnerReadLockExpr}` : ""}
          }`
          const runnerWithinRes = await runSessionScriptWithHooks(
            [f.inbox(uc.qId)],
            {
              PATH: process.env.PATH,
              AX_MESSENGER_DATA_DIR: f.dir,
              AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, answerScript]),
              AX_RELAY_SESSION_DIR: roleDir,
              AX_RELAY_SESSION_TIMEOUT_MS: "5000",
            },
            runnerHooksExpr,
          )
          assert.equal(
            runnerWithinRes.code,
            1,
            `[${uc.name}] ${elapsedMs}ms(상한 안)에서 실행기는 종료 코드 1로 시작을 거부해야 한다: ${runnerWithinRes.stderr}`,
          )
          assert.match(runnerWithinRes.stderr, /lock-unreadable/)
          assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500)
          assert.ok(await lstat(lockPath), `[${uc.name}] 잠금 파일이 지워지면 안 된다`)
          await assert.rejects(() => lstat(f.reply(uc.qId)), { code: "ENOENT" })
        }

        // (라-가) --reclaim-lock 도 상한 안에서는 종료 코드 1로 거부하고 lock-unreadable 기록
        const reclaimRejectHooks = `{
          now: () => ${lockMtimeMs + 30_000}
          ${uc.runnerReadLockExpr ? `, readLockFile: ${uc.runnerReadLockExpr}` : ""}
        }`
        const reclaimRejectRes = await runSessionScriptWithHooks(
          ["--reclaim-lock"],
          {
            PATH: process.env.PATH,
            AX_MESSENGER_DATA_DIR: f.dir,
          },
          reclaimRejectHooks,
        )
        assert.equal(reclaimRejectRes.code, 1, `[${uc.name}] 상한 안 --reclaim-lock 은 종료 코드 1로 거부해야 한다`)
        assert.match(reclaimRejectRes.stderr, /lock-unreadable/)
        assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500)

        // lstat 도 실패하면 25시간 상한 밖(+25시간 1분)이어도 회수하지 않는다.
        const pastMaxMs = AX_RELAY_LOCK_WALL_CLOCK_MAX_MS + 60_000
        const botLstatFail = createSessionRelay({
          ...f.options,
          now: () => lockMtimeMs + pastMaxMs,
          ...(uc.botReadLockFile
            ? { readLockFile: uc.botReadLockFile }
            : {
                readLockFile: async () => {
                  const e = new Error("EIO") as NodeJS.ErrnoException
                  e.code = "EIO"
                  throw e
                },
              }),
          lstatLockFile: async () => {
            const e = new Error("EIO lstat") as NodeJS.ErrnoException
            e.code = "EIO"
            throw e
          },
        })
        await botLstatFail.init()
        assert.equal(
          (await lstat(repliesDir)).mode & 0o777,
          0o500,
          `[${uc.name}] lstat 도 실패하면 상한 밖이어도 봇이 replies 0500 을 풀면 안 된다`,
        )

        const runnerLstatFailRes = await runSessionScriptWithHooks(
          [f.inbox(uc.qId)],
          {
            PATH: process.env.PATH,
            AX_MESSENGER_DATA_DIR: f.dir,
            AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, answerScript]),
            AX_RELAY_SESSION_DIR: roleDir,
            AX_RELAY_SESSION_TIMEOUT_MS: "5000",
          },
          `{
            now: () => ${lockMtimeMs + pastMaxMs},
            readLockFile: async () => { const e = new Error("EIO"); e.code = "EIO"; throw e; },
            lstatLockFile: async () => { const e = new Error("EIO"); e.code = "EIO"; throw e; }
          }`,
        )
        assert.equal(
          runnerLstatFailRes.code,
          1,
          `[${uc.name}] lstat 도 실패하면 상한 밖이어도 실행기가 회수하지 않고 종료 코드 1이어야 한다`,
        )
        assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500)

        // lstat 이 성공하고 mtime 이 25시간 상한을 넘었을 때: 봇·실행기 모두 회수·복원·감사
        const botPastLogs: string[] = []
        const botPast = createSessionRelay({
          ...f.options,
          now: () => lockMtimeMs + pastMaxMs,
          ...(uc.botReadLockFile ? { readLockFile: uc.botReadLockFile } : {}),
          log: (line) => botPastLogs.push(line),
        })
        await botPast.init()
        assert.equal(
          (await lstat(repliesDir)).mode & 0o777,
          0o500,
          `[${uc.name}] mtime 25시간 상한 초과 시에도 session-restore.json 이 남아 있으면 봇 init() 이 0500 을 유지해야 한다`,
        )
        assert.ok(
          botPastLogs.some((l) => l.includes(AX_RELAY_LOCK_UNREADABLE_RECLAIM_REASON)),
          `[${uc.name}] mtime 상한 초과 시 봇 로그에 '${AX_RELAY_LOCK_UNREADABLE_RECLAIM_REASON}' 사유가 남아야 한다`,
        )

        await chmod(repliesDir, 0o500)
        if (uc.cleanupLockPerm) await uc.cleanupLockPerm(lockPath)
        const runnerPastHooks = `{
          now: () => ${lockMtimeMs + pastMaxMs}
          ${uc.runnerReadLockExpr ? `, readLockFile: ${uc.runnerReadLockExpr}` : ""}
        }`
        const runnerPastRes = await runSessionScriptWithHooks(
          [f.inbox(uc.qId)],
          {
            PATH: process.env.PATH,
            AX_MESSENGER_DATA_DIR: f.dir,
            AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, answerScript]),
            AX_RELAY_SESSION_DIR: roleDir,
            AX_RELAY_SESSION_TIMEOUT_MS: "5000",
          },
          runnerPastHooks,
        )
        assert.equal(runnerPastRes.code, 0, runnerPastRes.stderr)
        assert.ok(runnerPastRes.stderr.includes(AX_RELAY_LOCK_UNREADABLE_RECLAIM_REASON))
        assert.equal((await lstat(repliesDir)).mode & 0o777, 0o750)
        await assert.rejects(() => lstat(restorePath), { code: "ENOENT" })
        await assert.rejects(() => lstat(lockPath), { code: "ENOENT" })
        assert.equal((await readFile(f.reply(uc.qId), "utf8")).trim(), `23회차답:${uc.qBody}`)

        const auditRows = (await readFile(sessionLogPath, "utf8"))
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
        assert.ok(
          auditRows.some(
            (r) =>
              r.event === "lock-unreadable" &&
              r.actor === "bot" &&
              r.action === "deferred" &&
              r.reason === "lock-unreadable",
          ),
          `[${uc.name}] 봇 lock-unreadable 보류 감사 기록이 남아야 한다`,
        )
        assert.ok(
          auditRows.some(
            (r) =>
              r.event === "lock-unreadable" &&
              r.actor === "runner" &&
              r.action === "rejected" &&
              r.reason === "lock-unreadable",
          ),
          `[${uc.name}] 실행기 lock-unreadable 시작 거부 감사 기록이 남아야 한다`,
        )
        assert.ok(
          auditRows.some(
            (r) =>
              r.event === "lock-reclaim" &&
              r.actor === "operator" &&
              r.action === "rejected" &&
              r.reason === "lock-unreadable",
          ),
          `[${uc.name}] 운영 --reclaim-lock lock-unreadable 거부 감사 기록이 남아야 한다`,
        )
        assert.ok(
          auditRows.some(
            (r) =>
              r.event === "lock-reclaim" &&
              r.actor === "runner" &&
              r.action === "reclaimed" &&
              r.reason === "lock-unreadable" &&
              r.lockReclaimReason === AX_RELAY_LOCK_UNREADABLE_RECLAIM_REASON,
          ),
          `[${uc.name}] 실행기 mtime 상한 초과 lock-unreadable 회수 감사 기록이 남아야 한다`,
        )
      }

      // =========================================================================
      // (나) boot_id UUID 정규화·비교:
      //   1) 같은 UUID 를 대문자로 쓴 잠금 -> same(유지)
      //   2) 앞뒤 공백·줄바꿈이 붙은 같은 UUID -> same(유지)
      //   3) UUID 가 아닌 값("abc", "{uuid}-prev-boot", 36자 아닌 값) -> 모름(상한 안 유지, --reclaim-lock 거부, 상한 밖 boot-unknown 회수)
      //   4) 서로 다른 정상 UUID 둘 -> 즉시 회수
      // =========================================================================
      {
        const pair = spawnDummyPair()
        const realProc = readProcessIdentity(pair.pid)
        const qId = "$r23-boot-case-ws"
        const qBody = "대문자공백같은UUID잠금유지"
        await f.relay.forward(f.question(qId, "!room1", qBody))
        const baseAt = Date.now()
        await writeFile(
          restorePath,
          `${JSON.stringify({ repliesMode: 0o750, at: baseAt, pid: pair.pid })}\n`,
          { mode: 0o600 },
        )
        await chmod(repliesDir, 0o500)

        for (const variant of [
          realProc.bootId.toUpperCase(),
          `  \n\t${realProc.bootId.toUpperCase()}\r\n  `,
        ]) {
          await writeFile(
            lockPath,
            `${JSON.stringify({
              token: "r23-boot-same-variant",
              pid: pair.pid,
              starttime: realProc.starttime,
              boot_id: variant,
              pgid: pair.pgid,
              at: baseAt,
              heartbeatAt: baseAt,
              heartbeatUptimeMs: readUptimeMs() ?? 1_000,
              heartbeatStaleMs: 60_000,
              timeoutMs: 300_000,
            })}\n`,
            { mode: 0o600 },
          )

          const botLogs: string[] = []
          const botSame = createSessionRelay({
            ...f.options,
            log: (l) => botLogs.push(l),
          })
          await botSame.init()
          assert.equal(
            (await lstat(repliesDir)).mode & 0o777,
            0o500,
            `대문자·공백 UUID(${JSON.stringify(variant)})는 같은 부팅(same)으로 보아 잠금과 replies 0500 을 유지해야 한다`,
          )
          assert.ok(!botLogs.some((l) => l.includes("reclaim")))

          const runnerSameRes = await runSessionScriptWithHooks(
            [f.inbox(qId)],
            {
              PATH: process.env.PATH,
              AX_MESSENGER_DATA_DIR: f.dir,
              AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, answerScript]),
              AX_RELAY_SESSION_DIR: roleDir,
              AX_RELAY_SESSION_TIMEOUT_MS: "5000",
            },
            `{}`,
          )
          assert.equal(runnerSameRes.code, 0, runnerSameRes.stderr)
          assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500)
          assert.equal(JSON.parse(await readFile(lockPath, "utf8")).pid, pair.pid)
          await assert.rejects(() => lstat(f.reply(qId)), { code: "ENOENT" })
        }

        // UUID 가 아닌 값("abc", "{uuid}-prev-boot", 36자 아닌 값) -> 모름(상한 안 유지, --reclaim-lock 거부, 상한 밖 boot-unknown 회수)
        const nonUuidBootValues = [
          { tag: "abc", value: "abc" },
          { tag: "prev-boot-suffix", value: `${realProc.bootId}-prev-boot` },
          { tag: "not-36-chars", value: realProc.bootId.slice(0, 35) },
        ]
        for (const nb of nonUuidBootValues) {
          const nbQId = `$r23-nonuuid-${nb.tag}`
          const nbQBody = `비UUID모름유지:${nb.tag}`
          await f.relay.forward(f.question(nbQId, "!room1", nbQBody))
          await writeFile(
            restorePath,
            `${JSON.stringify({ repliesMode: 0o750, at: baseAt, pid: pair.pid })}\n`,
            { mode: 0o600 },
          )
          await chmod(repliesDir, 0o500)
          await writeFile(
            lockPath,
            `${JSON.stringify({
              token: `r23-nonuuid-${nb.tag}`,
              pid: pair.pid,
              starttime: realProc.starttime,
              boot_id: nb.value,
              pgid: pair.pgid,
              at: baseAt,
              heartbeatAt: baseAt,
              heartbeatUptimeMs: 1_000,
              heartbeatStaleMs: 10_000,
              timeoutMs: 60_000,
            })}\n`,
            { mode: 0o600 },
          )

          for (const elapsedMs of [30_000, 86_400_000]) {
            const botWithin = createSessionRelay({
              ...f.options,
              now: () => baseAt + elapsedMs,
            })
            await botWithin.init()
            assert.equal(
              (await lstat(repliesDir)).mode & 0o777,
              0o500,
              `[${nb.tag}] UUID 아닌 값(${nb.value})은 상한 안(${elapsedMs}ms)에서 유지되어야 한다`,
            )

            const runnerWithinRes = await runSessionScriptWithHooks(
              [f.inbox(nbQId)],
              {
                PATH: process.env.PATH,
                AX_MESSENGER_DATA_DIR: f.dir,
                AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, answerScript]),
                AX_RELAY_SESSION_DIR: roleDir,
                AX_RELAY_SESSION_TIMEOUT_MS: "5000",
              },
              `{ now: () => ${baseAt + elapsedMs} }`,
            )
            assert.equal(runnerWithinRes.code, 0, runnerWithinRes.stderr)
            assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500)
            assert.equal(JSON.parse(await readFile(lockPath, "utf8")).pid, pair.pid)
          }

          // (라-나) --reclaim-lock 상한 안 거부
          const reclaimRejectRes = await runSessionScriptWithHooks(
            ["--reclaim-lock"],
            {
              PATH: process.env.PATH,
              AX_MESSENGER_DATA_DIR: f.dir,
            },
            `{ now: () => ${baseAt + 30_000} }`,
          )
          assert.equal(reclaimRejectRes.code, 1, `[${nb.tag}] 상한 안 --reclaim-lock 은 거부해야 한다`)
          assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500)

          // 상한 밖(+25시간 1분) boot-unknown 회수
          const pastMaxMs = AX_RELAY_LOCK_WALL_CLOCK_MAX_MS + 60_000
          const botPastLogs: string[] = []
          const botPast = createSessionRelay({
            ...f.options,
            now: () => baseAt + pastMaxMs,
            log: (l) => botPastLogs.push(l),
          })
          await botPast.init()
          assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500)
          assert.ok(botPastLogs.some((l) => l.includes(AX_RELAY_LOCK_BOOT_UNKNOWN_RECLAIM_REASON)))
        }

        // 서로 다른 정상 UUID 둘은 상한 전 즉시 회수
        const diffUuid = realProc.bootId.startsWith("0")
          ? "FFFFFFFF-2222-4333-8444-555555555555"
          : "00000000-2222-4333-8444-555555555555"
        await writeFile(
          restorePath,
          `${JSON.stringify({ repliesMode: 0o750, at: baseAt, pid: pair.pid })}\n`,
          { mode: 0o600 },
        )
        await chmod(repliesDir, 0o500)
        await writeFile(
          lockPath,
          `${JSON.stringify({
            token: "r23-diff-valid-uuid",
            pid: pair.pid,
            starttime: realProc.starttime,
            boot_id: diffUuid,
            pgid: pair.pgid,
            at: baseAt,
            heartbeatAt: baseAt,
            heartbeatUptimeMs: readUptimeMs() ?? 1_000,
            heartbeatStaleMs: 60_000,
            timeoutMs: 300_000,
          })}\n`,
          { mode: 0o600 },
        )
        const botDiff = createSessionRelay({ ...f.options })
        await botDiff.init()
        assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500)
        await chmod(repliesDir, 0o500)
        const runnerDiffRes = await runSessionScriptWithHooks(
          [f.inbox(qId)],
          {
            PATH: process.env.PATH,
            AX_MESSENGER_DATA_DIR: f.dir,
            AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, answerScript]),
            AX_RELAY_SESSION_DIR: roleDir,
            AX_RELAY_SESSION_TIMEOUT_MS: "5000",
          },
          `{}`,
        )
        assert.equal(runnerDiffRes.code, 0, runnerDiffRes.stderr)
        assert.equal((await lstat(repliesDir)).mode & 0o777, 0o750)
        assert.equal((await readFile(f.reply(qId), "utf8")).trim(), `23회차답:${qBody}`)
      }

      // =========================================================================
      // (다) kill(-pgid, 0) 이 EINVAL 을 던질 때 종료 확인 경로에서 그룹이 끝났다고 보지 않음:
      //   - 잠금 회수 경로(evictStaleLockAndRestore)에서 옛 실행기(pid)가 죽었더라도
      //     kill(-pgid, 0) 이 EINVAL(모름)이면 그룹이 끝났다고 보지 않고
      //     잠금 파일과 replies 0500 을 그대로 유지하며 감사 기록(process-group-unknown)을 남기고 종료 코드 1로 멈춘다.
      //   - --reclaim-lock 도 같게 회수·복원을 보류하고 종료 코드 1로 멈춘다.
      // =========================================================================
      {
        const pair = spawnDummyPair()
        const realProc = readProcessIdentity(pair.pid)
        // 옛 실행기 본체(pair.pid)는 먼저 종료시켜 procStatus === "dead" 상태로 만들고,
        // 세션 그룹(pair.pgid) 종료 확인 경로에서 kill(-pair.pgid, 0) 이 EINVAL 을 던지게 주입한다.
        try { process.kill(pair.pid, "SIGKILL") } catch { /* ignore */ }
        for (let i = 0; i < 40; i++) {
          if (readProcessIdentity(pair.pid).status === "dead") break
          await new Promise((r) => setTimeout(r, 25))
        }
        assert.equal(readProcessIdentity(pair.pid).status, "dead")

        const qId = "$r23-pgid-einval"
        const qBody = "그룹killEINVAL보류시험"
        await f.relay.forward(f.question(qId, "!room1", qBody))
        const baseAt = Date.now()
        await writeFile(
          restorePath,
          `${JSON.stringify({ repliesMode: 0o750, at: baseAt, pid: pair.pid })}\n`,
          { mode: 0o600 },
        )
        await chmod(repliesDir, 0o500)
        await writeFile(
          lockPath,
          `${JSON.stringify({
            token: "r23-pgid-einval-token",
            pid: pair.pid,
            starttime: realProc.starttime,
            boot_id: realProc.bootId,
            pgid: pair.pgid,
            at: baseAt,
            heartbeatAt: baseAt,
            heartbeatUptimeMs: 1_000,
            heartbeatStaleMs: 10_000,
            timeoutMs: 60_000,
          })}\n`,
          { mode: 0o600 },
        )

        const pgidEinvalHookExpr = `(pid) => { if (pid === -${pair.pgid}) { const e = new Error("EINVAL"); e.code = "EINVAL"; throw e; } }`

        // 두 번째 실행기 main(): 그룹 종료 미확인(unknown)으로 잠금·replies 0500 유지 및 종료 코드 1
        const runnerPgidRes = await runSessionScriptWithHooks(
          [f.inbox(qId)],
          {
            PATH: process.env.PATH,
            AX_MESSENGER_DATA_DIR: f.dir,
            AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, answerScript]),
            AX_RELAY_SESSION_DIR: roleDir,
            AX_RELAY_SESSION_TIMEOUT_MS: "1000",
          },
          `{ kill0: ${pgidEinvalHookExpr} }`,
        )
        assert.equal(
          runnerPgidRes.code,
          1,
          `kill(-pgid,0) EINVAL 시 그룹 종료를 확신하지 못하므로 종료 코드 1이어야 한다: ${runnerPgidRes.stderr}`,
        )
        assert.ok(runnerPgidRes.stderr.includes(AX_RELAY_LOCK_PGID_UNKNOWN_DEFER_REASON))
        assert.equal(
          (await lstat(repliesDir)).mode & 0o777,
          0o500,
          "그룹 종료가 확인되지 않았으면 replies 0500 을 풀면 안 된다",
        )
        assert.equal(
          JSON.parse(await readFile(lockPath, "utf8")).pid,
          pair.pid,
          "그룹 종료가 확인되지 않았으면 session.lock 을 지우면 안 된다",
        )
        await assert.rejects(() => lstat(f.reply(qId)), { code: "ENOENT" })

        // --reclaim-lock 도 같게 보류하고 종료 코드 1
        const reclaimPgidRes = await runSessionScriptWithHooks(
          ["--reclaim-lock"],
          {
            PATH: process.env.PATH,
            AX_MESSENGER_DATA_DIR: f.dir,
            AX_RELAY_SESSION_TIMEOUT_MS: "1000",
          },
          `{ kill0: ${pgidEinvalHookExpr} }`,
        )
        assert.equal(reclaimPgidRes.code, 1)
        assert.ok(reclaimPgidRes.stderr.includes(AX_RELAY_LOCK_PGID_UNKNOWN_DEFER_REASON))
        assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500)
        assert.equal(JSON.parse(await readFile(lockPath, "utf8")).pid, pair.pid)

        const auditRows = (await readFile(sessionLogPath, "utf8"))
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
        assert.ok(
          auditRows.some(
            (r) =>
              r.event === "lock-reclaim" &&
              r.actor === "runner" &&
              r.action === "deferred" &&
              r.pgid === pair.pgid &&
              r.procGroupStatus === "unknown" &&
              r.reason === "process-group-unknown" &&
              r.lockReclaimReason === AX_RELAY_LOCK_PGID_UNKNOWN_DEFER_REASON,
          ),
          "실행기 프로세스 그룹 종료 미확인 보류 감사 기록이 남아야 한다",
        )
        assert.ok(
          auditRows.some(
            (r) =>
              r.event === "lock-reclaim" &&
              r.actor === "operator" &&
              r.action === "deferred" &&
              r.pgid === pair.pgid &&
              r.procGroupStatus === "unknown" &&
              r.reason === "process-group-unknown",
          ),
          "운영 --reclaim-lock 프로세스 그룹 종료 미확인 보류 감사 기록이 남아야 한다",
        )
      }
    } finally {
      for (const child of childrenToKill) {
        if (child.pid) {
          try { process.kill(child.pid, "SIGKILL") } catch { /* ignore */ }
        }
      }
      for (const pgid of pgidsToKill) {
        if (pgid > 0) {
          try { process.kill(-pgid, "SIGKILL") } catch { /* ignore */ }
        }
      }
      await chmod(path.join(f.dir, "relay", "replies"), 0o700).catch(() => undefined)
      await chmod(path.join(f.dir, "relay", "session.lock"), 0o600).catch(() => undefined)
      await f.cleanup()
    }
  },
)

test(
  "24회차 단위: 복원 기록 꼴 검사(isValidRestoreRecordShape)·복원 함수(restoreRepliesModeFromRecord)·다른 질문 답 파일 보호(isProtectedReplyEntry) 및 상수 일치",
  async () => {
    const runnerMod = (await import(pathToFileURL(sessionRunScript).href)) as {
      AX_RELAY_REPLIES_SNAPSHOT_UNREADABLE_REASON: string
      AX_RELAY_RESTORE_RECORD_UNREADABLE_REASON: string
      AX_RELAY_STATE_UNREADABLE_REASON: string
      AX_RELAY_LOCK_RM_FAILED_REASON: string
      AX_RELAY_SESSION_LOG_WRITE_FAILED_REASON: string
      isValidRestoreRecordShape: (parsed: unknown) => boolean
      isProtectedReplyEntry: (name: unknown, currentId?: string) => boolean
      restoreRepliesModeFromRecord: (
        restorePath: string,
        repliesDir: string,
        options?: {
          readRestoreFile?: (p: string) => Promise<{ body: string } | string>
          onError?: (code: string) => Promise<void> | void
        },
      ) => Promise<boolean>
    }

    assert.equal(
      runnerMod.AX_RELAY_REPLIES_SNAPSHOT_UNREADABLE_REASON,
      AX_RELAY_REPLIES_SNAPSHOT_UNREADABLE_REASON,
    )
    assert.equal(
      runnerMod.AX_RELAY_RESTORE_RECORD_UNREADABLE_REASON,
      AX_RELAY_RESTORE_RECORD_UNREADABLE_REASON,
    )
    assert.equal(runnerMod.AX_RELAY_STATE_UNREADABLE_REASON, AX_RELAY_STATE_UNREADABLE_REASON)
    assert.equal(runnerMod.AX_RELAY_LOCK_RM_FAILED_REASON, AX_RELAY_LOCK_RM_FAILED_REASON)
    assert.equal(
      runnerMod.AX_RELAY_SESSION_LOG_WRITE_FAILED_REASON,
      AX_RELAY_SESSION_LOG_WRITE_FAILED_REASON,
    )

    // 1. isValidRestoreRecordShape 검증
    for (const invalid of [
      null,
      undefined,
      "string",
      [],
      {},
      { repliesMode: "0750" },
      { repliesMode: -1 },
      { repliesMode: 0o1000 },
      { repliesMode: 0o500 }, // 소유자 rwx(0700) 비트가 모두 켜져 있지 않은 모드는 거부
      { repliesMode: 0o600 },
    ]) {
      assert.equal(runnerMod.isValidRestoreRecordShape(invalid), false)
    }
    assert.equal(runnerMod.isValidRestoreRecordShape({ repliesMode: 0o700 }), true)
    assert.equal(runnerMod.isValidRestoreRecordShape({ repliesMode: 0o750, at: 123, pid: 1 }), true)

    // 2. isProtectedReplyEntry 검증: 현재 질문뿐 아니라 다른 질문의 64자 hex .md / .md.ready 파일도 보호
    const curId = "a".repeat(64)
    const otherId = "b".repeat(64)
    assert.equal(runnerMod.isProtectedReplyEntry(`${curId}.md`, curId), true)
    assert.equal(runnerMod.isProtectedReplyEntry(`${curId}.md.ready`, curId), true)
    assert.equal(runnerMod.isProtectedReplyEntry(`${otherId}.md`, curId), true)
    assert.equal(runnerMod.isProtectedReplyEntry(`${otherId}.md.ready`, curId), true)
    assert.equal(runnerMod.isProtectedReplyEntry("stray-temp-file.txt", curId), false)

    // 3. restoreRepliesModeFromRecord 직접 검증: ENOENT 만 복원할 것 없음(false, 오류 없음),
    //    EIO·JSON 깨짐·꼴 깨짐·심볼릭 링크는 기록 유지·모드 불변·false 반환·오류 감사 호출
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ax-r24-restore-unit-"))
    try {
      const repliesDir = path.join(tmpDir, "replies")
      const restorePath = path.join(tmpDir, "session-restore.json")
      await mkdir(repliesDir, { mode: 0o500 })
      await chmod(repliesDir, 0o500)

      // (a) ENOENT: false 반환, onError 호출 안 됨, 모드 그대로(0500)
      const errors: string[] = []
      const resEnoent = await runnerMod.restoreRepliesModeFromRecord(restorePath, repliesDir, {
        onError: (code) => {
          errors.push(code)
        },
      })
      assert.equal(resEnoent, false)
      assert.equal(errors.length, 0)
      assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500)

      // (b) EIO 읽기 오류: 기록 안 지움, 0700 기본 모드 적용 안 함(0500 유지), false 반환
      await writeFile(restorePath, `${JSON.stringify({ repliesMode: 0o750 })}\n`, { mode: 0o600 })
      const resEio = await runnerMod.restoreRepliesModeFromRecord(restorePath, repliesDir, {
        readRestoreFile: async () => {
          const e = new Error("EIO") as NodeJS.ErrnoException
          e.code = "EIO"
          throw e
        },
        onError: (code) => {
          errors.push(code)
        },
      })
      assert.equal(resEio, false)
      assert.deepEqual(errors, ["EIO"])
      assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500)
      assert.ok(await lstat(restorePath), "EIO 시 session-restore.json 을 지우면 안 된다")

      // (c) JSON 깨짐: 기록 안 지움, 모드 0500 유지, false 반환
      errors.length = 0
      await writeFile(restorePath, "{corrupt-json\n", { mode: 0o600 })
      const resCorrupt = await runnerMod.restoreRepliesModeFromRecord(restorePath, repliesDir, {
        onError: (code) => {
          errors.push(code)
        },
      })
      assert.equal(resCorrupt, false)
      assert.deepEqual(errors, ["EJSONPARSE"])
      assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500)
      assert.equal(await readFile(restorePath, "utf8"), "{corrupt-json\n")

      // (d) 꼴 깨짐({ repliesMode: 0o500 }): 기록 안 지움, 모드 0500 유지, false 반환
      errors.length = 0
      await writeFile(restorePath, `${JSON.stringify({ repliesMode: 0o500 })}\n`, { mode: 0o600 })
      const resShape = await runnerMod.restoreRepliesModeFromRecord(restorePath, repliesDir, {
        onError: (code) => {
          errors.push(code)
        },
      })
      assert.equal(resShape, false)
      assert.deepEqual(errors, ["ESHAPE"])
      assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500)
      assert.ok(await lstat(restorePath))

      // (e) 비정규 파일(심볼릭 링크): 링크 안 지움, 모드 0500 유지, false 반환
      errors.length = 0
      await rm(restorePath, { force: true })
      const targetFile = path.join(tmpDir, "target.json")
      await writeFile(targetFile, `${JSON.stringify({ repliesMode: 0o750 })}\n`, { mode: 0o600 })
      await symlink(targetFile, restorePath)
      const resSymlink = await runnerMod.restoreRepliesModeFromRecord(restorePath, repliesDir, {
        onError: (code) => {
          errors.push(code)
        },
      })
      assert.equal(resSymlink, false)
      assert.deepEqual(errors, ["ENOTREGULAR"])
      assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500)
      assert.equal((await lstat(restorePath)).isSymbolicLink(), true)
      await rm(restorePath, { force: true })

      // (f) 정상 복원 기록: 원래 모드(0750)로 복원하고 기록 삭제 후 true 반환
      errors.length = 0
      await writeFile(restorePath, `${JSON.stringify({ repliesMode: 0o750 })}\n`, { mode: 0o600 })
      const resOk = await runnerMod.restoreRepliesModeFromRecord(restorePath, repliesDir, {
        onError: (code) => {
          errors.push(code)
        },
      })
      assert.equal(resOk, true)
      assert.equal(errors.length, 0)
      assert.equal((await lstat(repliesDir)).mode & 0o777, 0o750)
      await assert.rejects(() => lstat(restorePath), { code: "ENOENT" })
    } finally {
      await chmod(path.join(tmpDir, "replies"), 0o700).catch(() => undefined)
      await rm(tmpDir, { recursive: true, force: true })
    }
  },
)

test(
  "24회차 회귀: (가) 세션 전 replies readdir EIO, (나) 세션 뒤 replies readdir EIO, (다) 세션 중 다른 질문 답 파일 보호, (라) 복원 기록 EIO·JSON 깨짐, (마) 질문 state EIO·JSON 깨짐, (바) 잠금 rm EIO, (사) session-log 쓰기 실패",
  async () => {
    const f = await fixture()
    try {
      const roleDir = path.join(f.dir, "role-r24")
      await mkdir(roleDir, { recursive: true, mode: 0o755 })
      await writeFile(path.join(roleDir, "AGENTS.md"), "# R24 Role\n", { mode: 0o644 })

      const relayRoot = path.join(f.dir, "relay")
      const repliesDir = path.join(relayRoot, "replies")
      const stateDir = path.join(relayRoot, "state")
      const lockPath = path.join(relayRoot, "session.lock")
      const restorePath = path.join(relayRoot, "session-restore.json")
      const sessionLogPath = path.join(relayRoot, "session-log.jsonl")

      const spawnedMarker = path.join(f.dir, "session-spawned-r24.txt")
      const sessionScript = path.join(f.dir, "session-r24.mjs")
      await writeFile(
        sessionScript,
        `import { readFileSync, writeFileSync } from "node:fs";
const q = JSON.parse(readFileSync("question.json", "utf8"));
writeFileSync(${JSON.stringify(spawnedMarker)}, q.body, { mode: 0o600 });
writeFileSync("answer.md", "24회차답:" + q.body, { mode: 0o600 });
`,
        { mode: 0o600 },
      )

      // =========================================================================
      // (가) 세션 전 replies readdir EIO -> 세션 안 띄움·종료 1·다른 질문 답 파일 그대로
      // =========================================================================
      {
        await f.relay.forward(f.question("$r24-other-existing", "!room1", "기존다른질문"))
        const otherReplyPath = f.reply("$r24-other-existing")
        const otherReadyPath = `${otherReplyPath}.ready`
        await writeFile(otherReplyPath, "절대지워지면안되는기존답", { mode: 0o600 })
        await writeFile(otherReadyPath, "", { mode: 0o600 })

        await f.relay.forward(f.question("$r24-pre-eio", "!room1", "세션전스냅샷실패질문"))
        await rm(spawnedMarker, { force: true })

        const preEioRes = await runSessionScriptWithHooks(
          [f.inbox("$r24-pre-eio")],
          {
            PATH: process.env.PATH,
            AX_MESSENGER_DATA_DIR: f.dir,
            AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, sessionScript]),
            AX_RELAY_SESSION_DIR: roleDir,
            AX_RELAY_SESSION_TIMEOUT_MS: "5000",
          },
          `{
            readdirReplies: async (_dir, phase) => {
              if (phase === "pre-session") {
                const e = new Error("EIO pre-session readdir");
                e.code = "EIO";
                throw e;
              }
              return [];
            }
          }`,
        )
        assert.equal(preEioRes.code, 1, `세션 전 replies readdir 실패 시 종료 코드 1이어야 한다: ${preEioRes.stderr}`)
        assert.match(preEioRes.stderr, /replies-snapshot-unreadable/)
        await assert.rejects(
          () => lstat(spawnedMarker),
          { code: "ENOENT" },
          "세션 전 replies 스냅샷 실패 시 세션을 시작하면 안 된다",
        )
        assert.equal(
          await readFile(otherReplyPath, "utf8"),
          "절대지워지면안되는기존답",
          "다른 질문의 기존 답 파일이 지워지면 안 된다",
        )
        assert.ok(await lstat(otherReadyPath), "다른 질문의 .ready 표식도 그대로 남아야 한다")
        await assert.rejects(() => lstat(lockPath), { code: "ENOENT" }, "잠금은 해제되어야 한다")

        const logRows = (await readFile(sessionLogPath, "utf8"))
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
        assert.ok(
          logRows.some(
            (r) =>
              r.event === "replies-snapshot" &&
              r.phase === "pre-session" &&
              r.action === "aborted" &&
              r.file === `${relayName("$r24-pre-eio")}.json` &&
              r.reason === AX_RELAY_REPLIES_SNAPSHOT_UNREADABLE_REASON &&
              r.errorCode === "EIO",
          ),
          "session-log.jsonl 에 pre-session replies-snapshot-unreadable 감사가 남아야 한다",
        )
      }

      // =========================================================================
      // (나) 세션 전 성공·세션 뒤 readdir 실패 -> 아무것도 안 지움·감사 기록·종료 1
      // =========================================================================
      {
        const strayPath = path.join(repliesDir, "stray-keep-on-post-eio.tmp")
        const postEioSession = path.join(f.dir, "session-post-eio-r24.mjs")
        await writeFile(
          postEioSession,
          `import { writeFileSync } from "node:fs";
writeFileSync("answer.md", "세션뒤EIO답", { mode: 0o600 });
`,
          { mode: 0o600 },
        )

        const postEioRes = await runSessionScriptWithHooks(
          [f.inbox("$r24-pre-eio")],
          {
            PATH: process.env.PATH,
            AX_MESSENGER_DATA_DIR: f.dir,
            AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, postEioSession]),
            AX_RELAY_SESSION_DIR: roleDir,
            AX_RELAY_SESSION_TIMEOUT_MS: "5000",
          },
          `{
            readdirReplies: async (dir, phase) => {
              if (phase === "pre-session") {
                return ["${relayName("$r24-other-existing")}.md", "${relayName("$r24-other-existing")}.md.ready"];
              }
              const { chmod, writeFile } = await import("node:fs/promises");
              await chmod(dir, 0o700);
              await writeFile(${JSON.stringify(strayPath)}, "keep-me", { mode: 0o600 });
              const e = new Error("EIO post-session readdir");
              e.code = "EIO";
              throw e;
            }
          }`,
        )
        assert.equal(postEioRes.code, 1, "세션 뒤 replies readdir 실패 시 종료 코드 1이어야 한다")
        assert.match(postEioRes.stderr, /replies-snapshot-unreadable/)
        assert.equal(
          await readFile(strayPath, "utf8"),
          "keep-me",
          "세션 뒤 readdir 실패 시 어떤 파일도 지우면 안 된다",
        )
        assert.equal(
          await readFile(f.reply("$r24-other-existing"), "utf8"),
          "절대지워지면안되는기존답",
        )
        await rm(strayPath, { force: true })

        const logRows = (await readFile(sessionLogPath, "utf8"))
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
        assert.ok(
          logRows.some(
            (r) =>
              r.event === "replies-snapshot" &&
              r.phase === "post-session" &&
              r.action === "skipped-cleanup" &&
              r.reason === AX_RELAY_REPLIES_SNAPSHOT_UNREADABLE_REASON &&
              r.errorCode === "EIO",
          ),
          "session-log.jsonl 에 post-session replies-snapshot-unreadable 감사가 남아야 한다",
        )
      }

      // =========================================================================
      // (다) 다른 질문 이름의 답 파일이 세션 중 생겨도 지우지 않음(지울 대상은 이번 질문 칸에서 생긴 것만)
      // =========================================================================
      {
        await f.relay.forward(f.question("$r24-other-during", "!room1", "세션중생긴다른질문"))
        await f.relay.forward(f.question("$r24-cur-protect", "!room1", "현재질문"))
        const otherDuringReply = f.reply("$r24-other-during")
        const otherDuringReady = `${otherDuringReply}.ready`
        const strayNonReply = path.join(repliesDir, "stray-non-reply.tmp")
        const otherDuringHash = relayName("$r24-other-during")

        // 이미 끝난 이전 질문($r24-pre-eio)은 완료 상태로 표시
        await writeFile(f.reply("$r24-pre-eio"), "이전답", { mode: 0o600 })
        await writeFile(`${f.reply("$r24-pre-eio")}.ready`, "", { mode: 0o600 })

        const protectSession = path.join(f.dir, "session-protect-r24.mjs")
        await writeFile(
          protectSession,
          `import { readFileSync, writeFileSync } from "node:fs";
const q = JSON.parse(readFileSync("question.json", "utf8"));
// 이번 질문 작업 칸(workDir) 안에 다른 질문 해시 파일과 임시 파일을 만들어도 칸 정리 때 함께 지워진다.
writeFileSync(${JSON.stringify(`${otherDuringHash}.md`)}, "작업칸안파일", { mode: 0o600 });
writeFileSync("work-scratch.txt", "작업칸임시", { mode: 0o600 });
writeFileSync("answer.md", "현재질문답:" + q.body, { mode: 0o600 });
`,
          { mode: 0o600 },
        )

        const protectRes = await runSessionScriptWithHooks(
          [f.inbox("$r24-cur-protect")],
          {
            PATH: process.env.PATH,
            AX_MESSENGER_DATA_DIR: f.dir,
            AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, protectSession]),
            AX_RELAY_SESSION_DIR: roleDir,
            AX_RELAY_SESSION_TIMEOUT_MS: "5000",
          },
          `{
            readdirReplies: async (dir, phase, id) => {
              const { chmod, readdir, writeFile } = await import("node:fs/promises");
              if (phase === "post-session" && id === ${JSON.stringify(relayName("$r24-cur-protect"))}) {
                // 세션 도중 공유 replies 폴더에 다른 질문 답 파일(<otherId>.md, <otherId>.md.ready)과 비답변 쓰레기 파일이 생긴 상황 재현
                await chmod(dir, 0o700);
                await writeFile(${JSON.stringify(otherDuringReply)}, "세션중생긴다른질문답", { mode: 0o600 });
                await writeFile(${JSON.stringify(otherDuringReady)}, "", { mode: 0o600 });
                await writeFile(${JSON.stringify(strayNonReply)}, "지워질비답변파일", { mode: 0o600 });
              }
              return readdir(dir);
            }
          }`,
        )
        assert.equal(protectRes.code, 0, protectRes.stderr)
        assert.equal(
          await readFile(otherDuringReply, "utf8"),
          "세션중생긴다른질문답",
          "세션 중 생긴 다른 질문 이름의 답 파일(<otherId>.md)은 어떤 경우에도 지우면 안 된다",
        )
        assert.ok(
          await lstat(otherDuringReady),
          "세션 중 생긴 다른 질문 이름의 .md.ready 파일도 지우면 안 된다",
        )
        await assert.rejects(
          () => lstat(strayNonReply),
          { code: "ENOENT" },
          "답 파일이 아닌 새로 생긴 임시 파일은 정리되어야 한다",
        )
        assert.equal(
          (await readFile(f.reply("$r24-cur-protect"), "utf8")).trim(),
          "현재질문답:현재질문",
        )
        assert.equal(
          (await readdir(path.join(relayRoot, "session-work"))).length,
          0,
          "이번 질문 작업 칸(relay/session-work/<id>-<무작위>)에서 생긴 파일들은 모두 지워져야 한다",
        )
      }

      // =========================================================================
      // (라) 복원 기록(session-restore.json) EIO·JSON 깨짐·꼴 깨짐 -> 기록 남음·모드 안 바뀜·false·종료 1
      // =========================================================================
      {
        await f.relay.forward(f.question("$r24-restore-err", "!room1", "복원기록오류질문"))
        await chmod(repliesDir, 0o500)
        await writeFile(
          restorePath,
          `${JSON.stringify({ repliesMode: 0o750, at: Date.now(), pid: 999999 })}\n`,
          { mode: 0o600 },
        )

        // 1) 복원 기록 읽기 EIO
        const restoreEioRes = await runSessionScriptWithHooks(
          [f.inbox("$r24-restore-err")],
          {
            PATH: process.env.PATH,
            AX_MESSENGER_DATA_DIR: f.dir,
            AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, sessionScript]),
            AX_RELAY_SESSION_DIR: roleDir,
            AX_RELAY_SESSION_TIMEOUT_MS: "5000",
          },
          `{
            readRestoreFile: async () => {
              const e = new Error("EIO reading session-restore.json");
              e.code = "EIO";
              throw e;
            }
          }`,
        )
        assert.equal(restoreEioRes.code, 1, "복원 기록 EIO 시 종료 코드 1이어야 한다")
        assert.match(restoreEioRes.stderr, /restore-record-unreadable/)
        assert.equal(
          (await lstat(repliesDir)).mode & 0o777,
          0o500,
          "복원 기록 EIO 시 기본 모드(0700)를 적용하지 않고 기존 모드(0500)를 유지해야 한다",
        )
        assert.ok(await lstat(restorePath), "복원 기록 EIO 시 session-restore.json 을 지우면 안 된다")

        // 2) 복원 기록 JSON 깨짐 (일반 실행기 및 --reclaim-lock 모두 검증)
        await writeFile(restorePath, "{corrupted-restore-json\n", { mode: 0o600 })
        const restoreJsonRes = await runSessionScriptWithHooks(
          [f.inbox("$r24-restore-err")],
          {
            PATH: process.env.PATH,
            AX_MESSENGER_DATA_DIR: f.dir,
            AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, sessionScript]),
            AX_RELAY_SESSION_DIR: roleDir,
            AX_RELAY_SESSION_TIMEOUT_MS: "5000",
          },
          `{}`,
        )
        assert.equal(restoreJsonRes.code, 1, "복원 기록 JSON 깨짐 시 종료 코드 1이어야 한다")
        assert.match(restoreJsonRes.stderr, /restore-record-unreadable/)
        assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500)
        assert.equal(await readFile(restorePath, "utf8"), "{corrupted-restore-json\n")

        const reclaimRestoreJsonRes = await runSessionScriptWithHooks(
          ["--reclaim-lock"],
          {
            PATH: process.env.PATH,
            AX_MESSENGER_DATA_DIR: f.dir,
          },
          `{}`,
        )
        assert.equal(reclaimRestoreJsonRes.code, 1, "--reclaim-lock 도 복원 기록 JSON 깨짐 시 종료 코드 1이어야 한다")
        assert.match(reclaimRestoreJsonRes.stderr, /restore-record-unreadable/)
        assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500)
        assert.equal(await readFile(restorePath, "utf8"), "{corrupted-restore-json\n")

        // 복원 기록 정리 및 repliesDir 모드 복구
        await rm(restorePath, { force: true })
        await chmod(repliesDir, 0o750)
      }

      // =========================================================================
      // (마) 질문 state 파일 EIO·JSON 깨짐 -> 질문 이름과 사유 감사 줄·종료 코드 0 아님(1)
      //     (건너뛰더라도 다른 정상 질문은 처리하고 실행기 종료 코드 1로 드러냄, 봇 poll 도 동일 규칙)
      // =========================================================================
      {
        const badEioId = "$r24-state-eio"
        const badJsonId = "$r24-state-json"
        const goodId = "$r24-state-good"
        await f.relay.forward(f.question(badEioId, "!room1", "상태EIO질문"))
        await f.relay.forward(f.question(badJsonId, "!room1", "상태JSON깨짐질문"))
        await f.relay.forward(f.question(goodId, "!room1", "정상처리질문"))

        // 이전 질문($r24-restore-err)은 완료 처리
        await writeFile(f.reply("$r24-restore-err"), "완료", { mode: 0o600 })
        await writeFile(`${f.reply("$r24-restore-err")}.ready`, "", { mode: 0o600 })

        const badEioHash = relayName(badEioId)
        const badJsonHash = relayName(badJsonId)
        await writeFile(path.join(stateDir, `${badJsonHash}.json`), "{broken-state-json\n", {
          mode: 0o600,
        })

        const stateErrRes = await runSessionScriptWithHooks(
          [f.inbox(badEioId)],
          {
            PATH: process.env.PATH,
            AX_MESSENGER_DATA_DIR: f.dir,
            AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, sessionScript]),
            AX_RELAY_SESSION_DIR: roleDir,
            AX_RELAY_SESSION_TIMEOUT_MS: "5000",
          },
          `{
            readStateFile: async (p, id) => {
              if (id === ${JSON.stringify(badEioHash)}) {
                const e = new Error("EIO reading state file");
                e.code = "EIO";
                throw e;
              }
              const { readRegularFileNoFollow } = await import(${JSON.stringify(pathToFileURL(sessionRunScript).href)});
              return readRegularFileNoFollow(p);
            }
          }`,
        )
        assert.equal(
          stateErrRes.code,
          1,
          `질문 state 파일 EIO·JSON 깨짐이 있으면 조용히 0으로 끝내지 않고 종료 코드 1이어야 한다: ${stateErrRes.stderr}`,
        )
        assert.match(stateErrRes.stderr, new RegExp(`file=${badEioHash}\\.json.*reason=state-unreadable`))
        assert.match(stateErrRes.stderr, new RegExp(`file=${badJsonHash}\\.json.*reason=state-unreadable`))
        // 깨진 질문을 건너뛰더라도 다른 정상 질문(goodId)은 처리되어야 한다.
        assert.equal((await readFile(f.reply(goodId), "utf8")).trim(), "24회차답:정상처리질문")
        await assert.rejects(() => lstat(f.reply(badEioId)), { code: "ENOENT" })
        await assert.rejects(() => lstat(f.reply(badJsonId)), { code: "ENOENT" })

        const logRows = (await readFile(sessionLogPath, "utf8"))
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
        assert.ok(
          logRows.some(
            (r) =>
              r.event === "state-unreadable" &&
              r.actor === "runner" &&
              r.file === `${badEioHash}.json` &&
              r.reason === AX_RELAY_STATE_UNREADABLE_REASON &&
              r.errorCode === "EIO",
          ),
          "session-log.jsonl 에 EIO state-unreadable 감사 줄이 질문 파일 이름과 함께 남아야 한다",
        )
        assert.ok(
          logRows.some(
            (r) =>
              r.event === "state-unreadable" &&
              r.actor === "runner" &&
              r.file === `${badJsonHash}.json` &&
              r.reason === AX_RELAY_STATE_UNREADABLE_REASON &&
              r.errorCode === "EJSONPARSE",
          ),
          "session-log.jsonl 에 EJSONPARSE state-unreadable 감사 줄이 질문 파일 이름과 함께 남아야 한다",
        )

        // 봇 poll() 도 깨진 state 파일을 건너뛰면서 로그와 session-log.jsonl 에 state-unreadable 감사를 남기고 정상 답을 전달한다.
        const botLogs: string[] = []
        const botRelay = createSessionRelay({ ...f.options, log: (l) => botLogs.push(l) })
        await botRelay.poll()
        assert.ok(
          botLogs.some((l) => l.includes(`relay state file error file=${badJsonHash}.json`)),
          "봇 poll() 도 깨진 state 파일 이름을 로그에 남겨야 한다",
        )
        const logRowsAfterBot = (await readFile(sessionLogPath, "utf8"))
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
        assert.ok(
          logRowsAfterBot.some(
            (r) =>
              r.event === "state-unreadable" &&
              r.actor === "bot" &&
              r.file === `${badJsonHash}.json` &&
              r.reason === AX_RELAY_STATE_UNREADABLE_REASON,
          ),
          "봇 poll() 도 깨진 state 파일에 대해 session-log.jsonl 에 state-unreadable 감사를 남겨야 한다",
        )

        // 다음 시험을 위해 깨진 질문 정리
        await rm(f.inbox(badEioId), { force: true })
        await rm(f.inbox(badJsonId), { force: true })
        await rm(path.join(stateDir, `${badEioHash}.json`), { force: true })
        await rm(path.join(stateDir, `${badJsonHash}.json`), { force: true })
      }

      // =========================================================================
      // (바) 잠금 rm EIO -> 모드 복원·reclaimed 감사 없음·실패 사유(lock-rm-failed) 감사·종료 1
      // =========================================================================
      {
        const rmFailQId = "$r24-lock-rm-eio"
        await f.relay.forward(f.question(rmFailQId, "!room1", "잠금삭제실패질문"))
        await writeFile(
          restorePath,
          `${JSON.stringify({ repliesMode: 0o750, at: Date.now(), pid: 999998 })}\n`,
          { mode: 0o600 },
        )
        await chmod(repliesDir, 0o500)
        // 죽은 PID(999998)의 오래된 잠금
        await writeFile(
          lockPath,
          `${JSON.stringify({
            token: "r24-dead-lock-rm-eio",
            pid: 999998,
            pgid: 0,
            at: Date.now() - 60_000,
            heartbeatAt: Date.now() - 60_000,
          })}\n`,
          { mode: 0o600 },
        )

        const logCountBefore = (await readFile(sessionLogPath, "utf8")).trim().split("\n").length

        const rmEioHookExpr = `{
          rmLockFile: async () => {
            const e = new Error("EIO removing session.lock");
            e.code = "EIO";
            throw e;
          }
        }`

        const runnerRmFailRes = await runSessionScriptWithHooks(
          [f.inbox(rmFailQId)],
          {
            PATH: process.env.PATH,
            AX_MESSENGER_DATA_DIR: f.dir,
            AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, sessionScript]),
            AX_RELAY_SESSION_DIR: roleDir,
            AX_RELAY_SESSION_TIMEOUT_MS: "5000",
          },
          rmEioHookExpr,
        )
        assert.equal(runnerRmFailRes.code, 1, "잠금 rm EIO 시 종료 코드 1이어야 한다")
        assert.match(runnerRmFailRes.stderr, /lock-rm-failed/)
        assert.equal(
          (await lstat(repliesDir)).mode & 0o777,
          0o500,
          "잠금 rm 이 실패하면 replies 모드를 복원하면 안 된다",
        )
        assert.ok(await lstat(lockPath), "잠금 파일이 그대로 남아 있다")
        assert.ok(await lstat(restorePath), "복원 기록도 그대로 남아 있어야 한다")

        const reclaimRmFailRes = await runSessionScriptWithHooks(
          ["--reclaim-lock"],
          {
            PATH: process.env.PATH,
            AX_MESSENGER_DATA_DIR: f.dir,
          },
          rmEioHookExpr,
        )
        assert.equal(reclaimRmFailRes.code, 1, "--reclaim-lock 도 잠금 rm EIO 시 종료 코드 1이어야 한다")
        assert.match(reclaimRmFailRes.stderr, /lock-rm-failed/)
        assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500)

        const newLogRows = (await readFile(sessionLogPath, "utf8"))
          .trim()
          .split("\n")
          .slice(logCountBefore)
          .map((l) => JSON.parse(l))
        assert.ok(
          !newLogRows.some((r) => r.action === "reclaimed"),
          "잠금 rm 실패 시 reclaimed 감사가 기록되면 안 된다",
        )
        assert.ok(
          newLogRows.some(
            (r) =>
              r.event === "lock-reclaim" &&
              r.actor === "runner" &&
              r.action === "failed" &&
              r.reason === AX_RELAY_LOCK_RM_FAILED_REASON &&
              r.errorCode === "EIO",
          ),
          "실행기 lock-rm-failed 감사 기록이 남아야 한다",
        )
        assert.ok(
          newLogRows.some(
            (r) =>
              r.event === "lock-reclaim" &&
              r.actor === "operator" &&
              r.action === "failed" &&
              r.reason === AX_RELAY_LOCK_RM_FAILED_REASON &&
              r.errorCode === "EIO",
          ),
          "운영 --reclaim-lock lock-rm-failed 감사 기록이 남아야 한다",
        )

        // 정리
        await rm(lockPath, { force: true })
        await rm(restorePath, { force: true })
        await chmod(repliesDir, 0o750)
      }

      // =========================================================================
      // (사) session-log 쓰기 실패 -> 표준 오류에 남고 거부·모름 길 종료 코드(1) 유지,
      //     정상 답 전달은 막지 않으며 비정규 session-log.jsonl 도 지우지 않음
      // =========================================================================
      {
        const logFailHookExpr = `{
          readLockFile: async () => {
            const e = new Error("EIO lock");
            e.code = "EIO";
            throw e;
          },
          appendSessionLogFile: async () => {
            const e = new Error("ENOSPC writing session-log.jsonl");
            e.code = "ENOSPC";
            throw e;
          }
        }`

        await writeFile(
          lockPath,
          `${JSON.stringify({ pid: process.pid, pgid: 0, at: Date.now(), heartbeatAt: Date.now() })}\n`,
          { mode: 0o600 },
        )

        // 1) 거부·모름 길(lock-unreadable)에서 session-log 쓰기가 실패해도 표준 오류에 기록되고 종료 코드 1이 유지된다.
        const rejectLogFailRes = await runSessionScriptWithHooks(
          [f.inbox("$r24-lock-rm-eio")],
          {
            PATH: process.env.PATH,
            AX_MESSENGER_DATA_DIR: f.dir,
            AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, sessionScript]),
            AX_RELAY_SESSION_DIR: roleDir,
            AX_RELAY_SESSION_TIMEOUT_MS: "5000",
          },
          logFailHookExpr,
        )
        assert.equal(
          rejectLogFailRes.code,
          1,
          "거부·모름 길에서 session-log 쓰기가 실패해도 종료 코드는 1이어야 한다",
        )
        assert.match(rejectLogFailRes.stderr, /lock-unreadable/)
        assert.match(
          rejectLogFailRes.stderr,
          new RegExp(`reason=${AX_RELAY_SESSION_LOG_WRITE_FAILED_REASON}`),
          "session-log 쓰기 실패가 표준 오류에 기록되어야 한다",
        )

        // 2) --reclaim-lock 거부 길에서도 session-log 쓰기 실패 시 표준 오류에 남고 종료 코드 1이 유지된다.
        const reclaimLogFailRes = await runSessionScriptWithHooks(
          ["--reclaim-lock"],
          {
            PATH: process.env.PATH,
            AX_MESSENGER_DATA_DIR: f.dir,
          },
          logFailHookExpr,
        )
        assert.equal(reclaimLogFailRes.code, 1)
        assert.match(
          reclaimLogFailRes.stderr,
          new RegExp(`reason=${AX_RELAY_SESSION_LOG_WRITE_FAILED_REASON}`),
        )

        await rm(lockPath, { force: true })

        // 3) 정상 질문 처리에서는 session-log 쓰기가 실패해도 표준 오류에 기록하고 답 전달 자체는 막지 않는다.
        const normalLogFailRes = await runSessionScriptWithHooks(
          [f.inbox("$r24-lock-rm-eio")],
          {
            PATH: process.env.PATH,
            AX_MESSENGER_DATA_DIR: f.dir,
            AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, sessionScript]),
            AX_RELAY_SESSION_DIR: roleDir,
            AX_RELAY_SESSION_TIMEOUT_MS: "5000",
          },
          `{
            appendSessionLogFile: async () => {
              const e = new Error("EIO writing session-log.jsonl");
              e.code = "EIO";
              throw e;
            }
          }`,
        )
        assert.equal(normalLogFailRes.code, 0, normalLogFailRes.stderr)
        assert.match(
          normalLogFailRes.stderr,
          new RegExp(`reason=${AX_RELAY_SESSION_LOG_WRITE_FAILED_REASON}`),
        )
        assert.equal(
          (await readFile(f.reply("$r24-lock-rm-eio"), "utf8")).trim(),
          "24회차답:잠금삭제실패질문",
        )
      }
    } finally {
      await chmod(path.join(f.dir, "relay", "replies"), 0o700).catch(() => undefined)
      await chmod(path.join(f.dir, "relay", "session.lock"), 0o600).catch(() => undefined)
      await f.cleanup()
    }
  },
)

test("26회차 회귀: 죽은 잠금과 복원 기록 ENOENT에서 봇 init은 0700 적용·감사·잠금 보존", async () => {
  const f = await fixture()
  try {
    const relayRoot = path.join(f.dir, "relay")
    const repliesDir = path.join(relayRoot, "replies")
    const lockPath = path.join(relayRoot, "session.lock")
    const restorePath = path.join(relayRoot, "session-restore.json")
    const deadPid = 123456789
    const lockBody = `${JSON.stringify({ token: "r26-dead", pid: deadPid, pgid: 0, at: Date.now(), heartbeatAt: Date.now(), timeoutMs: 30000 })}\n`
    await writeFile(lockPath, lockBody, { mode: 0o600 })
    await assert.rejects(() => lstat(restorePath), { code: "ENOENT" })
    await chmod(repliesDir, 0o500)
    const logs: string[] = []
    const relay = createSessionRelay({
      ...f.options,
      log: (line) => logs.push(line),
      procIdentity: () => ({ status: "dead", alive: false, starttime: "", bootId: "", state: "", stopped: false }),
    })
    await relay.init()
    assert.equal((await lstat(repliesDir)).mode & 0o777, 0o700)
    assert.equal(await readFile(lockPath, "utf8"), lockBody, "봇은 죽은 잠금을 삭제하지 않는다")
    await assert.rejects(() => lstat(restorePath), { code: "ENOENT" })
    assert.ok(logs.some((line) => line.includes(`relay dead lock observed pid=${deadPid}`)), "죽은 잠금 판정이 봇 로그에 남아야 한다")
    assert.ok(!logs.some((line) => line.includes("restore record unreadable")), "ENOENT는 복원 오류가 아니다")
    await assert.rejects(() => lstat(path.join(relayRoot, "session-log.jsonl")), { code: "ENOENT" }, "복원 오류 감사가 없어야 한다")
  } finally { await f.cleanup() }
})

test(
  "25회차 단위: 보호 이름(isProtectedReplyEntry) 대소문자 hex·확장자 변형·.ready·심볼릭 링크 보호 및 상수 일치",
  async () => {
    const runnerMod = await import(pathToFileURL(sessionRunScript).href)

    assert.equal(AX_RELAY_AUDIT_JSONL_CORRUPT_REASON, "audit-jsonl-corrupt")

    const curId = relayName("$r25-unit-cur")
    const otherLower = relayName("$r25-unit-other")
    const otherUpper = otherLower.toUpperCase()
    const otherMixed = otherLower.slice(0, 32).toUpperCase() + otherLower.slice(32)

    // 1. 소문자·대문자·대소문자 혼합 64자 hex 및 확장자 대소문자 변형(.md, .MD, .Md.Ready, .READY, .ready, .tmp) 모두 보호
    for (const candidate of [
      `${curId}.md`,
      `${curId}.MD`,
      `${curId.toUpperCase()}.md.ready`,
      `${otherLower}.md`,
      `${otherUpper}.md`,
      `${otherMixed}.MD`,
      `${otherUpper}.md.ready`,
      `${otherMixed}.Md.Ready`,
      `${otherLower}.ready`,
      `${otherUpper}.READY`,
      `${otherLower}.tmp`,
      "custom-marker.ready",
      "custom-marker.READY",
      "custom-marker.ready.999.tmp",
    ]) {
      assert.equal(
        runnerMod.isProtectedReplyEntry(candidate, curId),
        true,
        `보호 대상 이름(${candidate})은 지우지 않도록 true 여야 한다`,
      )
    }

    assert.equal(runnerMod.isProtectedReplyEntry(`${otherUpper}.md.12345.abcdef.tmp`, curId), false)
    assert.equal(runnerMod.isProtectedReplyEntry(`${curId}.md.12345.abcdef012345.tmp`, curId), false)
    assert.equal(runnerMod.isProtectedReplyEntry(`${otherUpper}.md.12345.abcdef012345.tmp`, curId, { isSymbolicLink: true }), true)

    // 2. 심볼릭 링크 항목(isSymbolicLink: true)은 이름과 무관하게 항상 보호
    assert.equal(
      runnerMod.isProtectedReplyEntry("stray-non-reply.tmp", curId, { isSymbolicLink: true }),
      true,
      "심볼릭 링크 항목은 이름과 무관하게 보호(true)되어야 한다",
    )
    assert.equal(
      runnerMod.isProtectedReplyEntry("arbitrary-symlink-name", curId, { isSymbolicLink: true }),
      true,
    )

    // 3. 64자 hex 도 아니고 .ready 도 아니며 심볼릭 링크도 아닌 일반 쓰레기 파일만 false
    for (const nonProtected of ["stray-non-reply.tmp", "scratch.txt", "abc123.md", ""]) {
      assert.equal(
        runnerMod.isProtectedReplyEntry(nonProtected, curId, { isSymbolicLink: false }),
        false,
        `비보호 임시 이름(${nonProtected})은 false 여야 한다`,
      )
    }
  },
)

test(
  "25회차 회귀: (가) releaseLock() 복원 기록 EIO·JSON 깨짐·예외 시 잠금 유지·0500 유지·종료 1, (나) 잠금 없음+복원 기록 남음/읽기 오류 시 봇 init() 모드 유지·감사, (다) 대문자 hex·확장자·.ready·심볼릭 링크 정리 보호, (라) 획득 직후 복원 오류 시 남의 잠금 보존·자기 잠금 rm 실패 감사, (마) 봇 forward() 같은 질문 state EIO·JSON·ESHAPE 감사, (바) 감사 JSONL 깨진 줄 중복 방지",
  async () => {
    const f = await fixture()
    try {
      const roleDir = path.join(f.dir, "role-r25")
      await mkdir(roleDir, { recursive: true, mode: 0o755 })
      await writeFile(path.join(roleDir, "AGENTS.md"), "# R25 Role\n", { mode: 0o644 })

      const relayRoot = path.join(f.dir, "relay")
      const repliesDir = path.join(relayRoot, "replies")
      const stateDir = path.join(relayRoot, "state")
      const lockPath = path.join(relayRoot, "session.lock")
      const restorePath = path.join(relayRoot, "session-restore.json")
      const sessionLogPath = path.join(relayRoot, "session-log.jsonl")

      const sessionScript = path.join(f.dir, "session-r25.mjs")
      await writeFile(
        sessionScript,
        `import { readFileSync, writeFileSync } from "node:fs";
const q = JSON.parse(readFileSync("question.json", "utf8"));
writeFileSync("answer.md", "25회차답:" + q.body, { mode: 0o600 });
`,
        { mode: 0o600 },
      )

      // =========================================================================
      // (가) 해제(releaseLock()) 때 복원 기록 EIO·JSON 깨짐·외곽 예외 -> 잠금 남음·모드 안 바뀜(0500)·종료 1
      // =========================================================================
      {
        const qRelEio = "$r25-release-eio"
        await f.relay.forward(f.question(qRelEio, "!room1", "해제복원EIO질문"))
        await chmod(repliesDir, 0o750)

        // 1) 세션 종료·잠금 해제 때 readRestoreFile 이 EIO 를 던지는 경우
        const relEioRes = await runSessionScriptWithHooks(
          [f.inbox(qRelEio)],
          {
            PATH: process.env.PATH,
            AX_MESSENGER_DATA_DIR: f.dir,
            AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, sessionScript]),
            AX_RELAY_SESSION_DIR: roleDir,
            AX_RELAY_SESSION_TIMEOUT_MS: "5000",
          },
          `{
            readRestoreFile: async (p, phase) => {
              if (phase === "post-session" || phase === "release-lock") {
                const e = new Error("EIO reading session-restore.json on release");
                e.code = "EIO";
                throw e;
              }
              const { readRegularFileNoFollow } = await import(${JSON.stringify(pathToFileURL(sessionRunScript).href)});
              return readRegularFileNoFollow(p);
            }
          }`,
        )
        assert.equal(relEioRes.code, 1, "해제 때 복원 기록 EIO 면 종료 코드 1이어야 한다")
        assert.match(relEioRes.stderr, /phase=release-lock code=EIO reason=restore-record-unreadable/)
        assert.equal(
          (await lstat(repliesDir)).mode & 0o777,
          0o500,
          "해제 때 복원 기록 EIO 면 replies 모드가 0500 그대로 남아야 한다",
        )
        assert.ok(await lstat(lockPath), "해제 때 복원 기록 EIO 면 session.lock 을 지우지 않고 남겨야 한다")
        assert.ok(await lstat(restorePath), "해제 때 복원 기록 EIO 면 session-restore.json 도 남아 있어야 한다")

        const logRows1 = (await readFile(sessionLogPath, "utf8"))
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
        assert.ok(
          logRows1.some(
            (r) =>
              r.event === "restore-record" &&
              r.actor === "runner" &&
              r.action === "failed" &&
              r.phase === "release-lock" &&
              r.reason === AX_RELAY_RESTORE_RECORD_UNREADABLE_REASON &&
              r.errorCode === "EIO",
          ),
          "session-log.jsonl 에 release-lock 단계의 restore-record EIO 감사 줄이 남아야 한다",
        )

        // 잠금 해제 실패 뒤 봇 init() 이 불려도 기본 모드(0700)로 덮어쓰지 못하고 0500 이 유지된다.
        await f.relay.init()
        assert.equal(
          (await lstat(repliesDir)).mode & 0o777,
          0o500,
          "releaseLock() 실패 뒤 봇 init() 도 기본 모드(0700)를 걸면 안 된다",
        )

        // 정리 후 2) 세션 중 session-restore.json 이 깨진 JSON 으로 바뀌어 해제 때 EJSONPARSE 가 나는 경우
        await rm(lockPath, { force: true })
        await rm(restorePath, { force: true })
        await chmod(repliesDir, 0o750)

        const qRelJson = "$r25-release-json"
        await f.relay.forward(f.question(qRelJson, "!room1", "해제복원JSON깨짐질문"))
        const corruptRestoreSession = path.join(f.dir, "session-corrupt-restore-r25.mjs")
        await writeFile(
          corruptRestoreSession,
          `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(restorePath)}, "{corrupted-during-session\\n", { mode: 0o600 });
writeFileSync("answer.md", "깨진복원기록세션답", { mode: 0o600 });
`,
          { mode: 0o600 },
        )
        const relJsonRes = await runSessionScriptWithHooks(
          [f.inbox(qRelJson)],
          {
            PATH: process.env.PATH,
            AX_MESSENGER_DATA_DIR: f.dir,
            AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, corruptRestoreSession]),
            AX_RELAY_SESSION_DIR: roleDir,
            AX_RELAY_SESSION_TIMEOUT_MS: "5000",
          },
          `{}`,
        )
        assert.equal(relJsonRes.code, 1, "해제 때 복원 기록 JSON 깨짐이면 종료 코드 1이어야 한다")
        assert.match(relJsonRes.stderr, /phase=release-lock code=EJSONPARSE reason=restore-record-unreadable/)
        assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500, "replies 모드가 0500 그대로여야 한다")
        assert.ok(await lstat(lockPath), "해제 때 복원 기록 JSON 깨짐이면 session.lock 이 남아 있어야 한다")
        assert.equal(await readFile(restorePath, "utf8"), "{corrupted-during-session\n")

        const logRows2 = (await readFile(sessionLogPath, "utf8"))
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
        assert.ok(
          logRows2.some(
            (r) =>
              r.event === "restore-record" &&
              r.actor === "runner" &&
              r.action === "failed" &&
              r.phase === "release-lock" &&
              r.reason === AX_RELAY_RESTORE_RECORD_UNREADABLE_REASON &&
              r.errorCode === "EJSONPARSE",
          ),
          "session-log.jsonl 에 release-lock 단계의 restore-record EJSONPARSE 감사 줄이 남아야 한다",
        )

        // 3) releaseLock() 안에서 외곽 예외(예: restoreRepliesModeFromRecord 의 rm/chmod 단계 예외)가 던져져도
        //    빈 catch 로 삼키지 않고 lock-release-failed 를 표준 오류·session-log.jsonl 에 남기며 잠금을 유지하고 종료 코드 1로 끝난다.
        await rm(lockPath, { force: true })
        await rm(restorePath, { force: true })
        await chmod(repliesDir, 0o750)

        const qRelOuter = "$r25-release-outer-err"
        await f.relay.forward(f.question(qRelOuter, "!room1", "해제외곽예외질문"))
        const relOuterRes = await runSessionScriptWithHooks(
          [f.inbox(qRelOuter)],
          {
            PATH: process.env.PATH,
            AX_MESSENGER_DATA_DIR: f.dir,
            AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, sessionScript]),
            AX_RELAY_SESSION_DIR: roleDir,
            AX_RELAY_SESSION_TIMEOUT_MS: "5000",
          },
          `{
            readRestoreFile: async (p, phase) => {
              const { chmod, writeFile } = await import("node:fs/promises");
              if (phase === "release-lock") {
                await writeFile(p, JSON.stringify({ repliesMode: 0o750, at: Date.now(), pid: process.pid }) + "\\n", { mode: 0o600 });
                await chmod(${JSON.stringify(relayRoot)}, 0o500);
                return { body: JSON.stringify({ repliesMode: 0o750, at: Date.now(), pid: process.pid }) };
              }
              const { readRegularFileNoFollow } = await import(${JSON.stringify(pathToFileURL(sessionRunScript).href)});
              return readRegularFileNoFollow(p);
            }
          }`,
        )
        await chmod(relayRoot, 0o700)
        assert.equal(relOuterRes.code, 1, "releaseLock() 외곽 예외 시 종료 코드 1이어야 한다")
        assert.match(relOuterRes.stderr, /phase=release-lock code=EACCES reason=lock-release-failed/)
        assert.ok(await lstat(lockPath), "releaseLock() 외곽 예외 시 session.lock 이 남아 있어야 한다")
        const logRows3 = (await readFile(sessionLogPath, "utf8"))
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
        assert.ok(
          logRows3.some(
            (r) =>
              r.event === "lock-release" &&
              r.actor === "runner" &&
              r.action === "failed" &&
              r.phase === "release-lock" &&
              r.reason === "lock-release-failed" &&
              r.errorCode === "EACCES",
          ),
          "session-log.jsonl 에 lock-release-failed 감사 줄이 남아야 한다",
        )

        // 정리
        await rm(lockPath, { force: true })
        await rm(restorePath, { force: true })
        await chmod(repliesDir, 0o750)
        await writeFile(f.reply(qRelEio), "완료", { mode: 0o600 })
        await writeFile(`${f.reply(qRelEio)}.ready`, "", { mode: 0o600 })
        await writeFile(f.reply(qRelJson), "완료", { mode: 0o600 })
        await writeFile(`${f.reply(qRelJson)}.ready`, "", { mode: 0o600 })
        await writeFile(f.reply(qRelOuter), "완료", { mode: 0o600 })
        await writeFile(`${f.reply(qRelOuter)}.ready`, "", { mode: 0o600 })
      }

      // =========================================================================
      // (나) 잠금 없음 + 복원 기록 남음/읽기 오류 상태에서 봇 init() -> replies/ 모드 그대로·감사 줄
      //      ENOENT 일 때만 기본 모드(0700) 적용
      // =========================================================================
      {
        await rm(lockPath, { force: true })
        await chmod(repliesDir, 0o500)

        // 1) 잠금 없음 + 유효한 session-restore.json(0750)이 남아 있는 상태 (EEXIST)
        await writeFile(
          restorePath,
          `${JSON.stringify({ repliesMode: 0o750, at: Date.now(), pid: 12345 })}\n`,
          { mode: 0o600 },
        )
        const botInitLogs1: string[] = []
        const botInit1 = createSessionRelay({
          ...f.options,
          log: (l) => botInitLogs1.push(l),
        })
        await botInit1.init()
        assert.equal(
          (await lstat(repliesDir)).mode & 0o777,
          0o500,
          "잠금이 없어도 session-restore.json 이 남아 있으면 봇 init() 이 replies 모드를 바꾸면 안 된다",
        )
        assert.ok(
          botInitLogs1.some(
            (l) =>
              l.includes("actor=bot phase=init code=EEXIST") &&
              l.includes(`reason=${AX_RELAY_RESTORE_RECORD_UNREADABLE_REASON}`),
          ),
          "봇 로그에 restore-record-unreadable (code=EEXIST) 사유가 남아야 한다",
        )

        // 2) 잠금 없음 + 깨진 JSON session-restore.json (EJSONPARSE)
        await writeFile(restorePath, "{broken-restore-json\n", { mode: 0o600 })
        const botInitLogs2: string[] = []
        const botInit2 = createSessionRelay({
          ...f.options,
          log: (l) => botInitLogs2.push(l),
        })
        await botInit2.init()
        assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500)
        assert.ok(botInitLogs2.some((l) => l.includes("actor=bot phase=init code=EJSONPARSE")))

        // 3) 잠금 없음 + 꼴 깨짐 session-restore.json (ESHAPE: repliesMode 0500)
        await writeFile(restorePath, `${JSON.stringify({ repliesMode: 0o500 })}\n`, { mode: 0o600 })
        const botInitLogs3: string[] = []
        const botInit3 = createSessionRelay({
          ...f.options,
          log: (l) => botInitLogs3.push(l),
        })
        await botInit3.init()
        assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500)
        assert.ok(botInitLogs3.some((l) => l.includes("actor=bot phase=init code=ESHAPE")))

        // 4) 잠금 없음 + session-restore.json 읽기 오류 (EIO 주입)
        const botInitLogs4: string[] = []
        const botInit4 = createSessionRelay({
          ...f.options,
          readRestoreFile: async () => {
            const err = new Error("EIO reading restore record in bot.init") as NodeJS.ErrnoException
            err.code = "EIO"
            throw err
          },
          log: (l) => botInitLogs4.push(l),
        })
        await botInit4.init()
        assert.equal((await lstat(repliesDir)).mode & 0o777, 0o500)
        assert.ok(botInitLogs4.some((l) => l.includes("actor=bot phase=init code=EIO")))

        const logRows = (await readFile(sessionLogPath, "utf8"))
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
        for (const expectedCode of ["EEXIST", "EJSONPARSE", "ESHAPE", "EIO"]) {
          assert.ok(
            logRows.some(
              (r) =>
                r.event === "restore-record" &&
                r.actor === "bot" &&
                r.action === "deferred" &&
                r.phase === "init" &&
                r.reason === AX_RELAY_RESTORE_RECORD_UNREADABLE_REASON &&
                r.errorCode === expectedCode,
            ),
            `session-log.jsonl 에 봇 init 의 restore-record deferred (${expectedCode}) 감사 줄이 남아야 한다`,
          )
        }

        // 5) session-restore.json 을 지워 ENOENT 가 되면 그때만 봇 init() 이 기본 모드 0700 을 건다.
        await rm(restorePath, { force: true })
        await botInit1.init()
        assert.equal(
          (await lstat(repliesDir)).mode & 0o777,
          0o700,
          "session-restore.json 이 ENOENT 일 때만 봇 init() 이 기본 모드 0700 을 걸어야 한다",
        )
        await chmod(repliesDir, 0o750)
      }

      // =========================================================================
      // (다) 대문자 hex·확장자 변형·.ready·심볼릭 링크 이름이 세션 중 생겨도 지우지 않음
      // =========================================================================
      {
        const curProtectId = "$r25-cur-protect"
        await f.relay.forward(f.question(curProtectId, "!room1", "보호이름세션질문"))

        const upperHexBase = relayName("$r25-other-upper").toUpperCase()
        const mixedHexBase =
          relayName("$r25-other-mixed").slice(0, 32).toUpperCase() +
          relayName("$r25-other-mixed").slice(32)
        const upperHexMd = path.join(repliesDir, `${upperHexBase}.md`)
        const mixedHexUpperExt = path.join(repliesDir, `${mixedHexBase}.MD`)
        const upperReadyExt = path.join(repliesDir, `${upperHexBase}.Md.Ready`)
        const bareReadyFile = path.join(repliesDir, `${mixedHexBase}.ready`)
        const tempHexFile = path.join(repliesDir, `${upperHexBase}.md.777.tmp`)
        const atomicTempHexFile = path.join(repliesDir, `${upperHexBase}.md.12345.abcdef012345.tmp`)
        const symlinkTarget = path.join(f.dir, "r25-symlink-target.txt")
        await writeFile(symlinkTarget, "심볼릭링크대상", { mode: 0o600 })
        const symlinkReplyEntry = path.join(repliesDir, "custom-symlink-entry")
        const strayTrashFile = path.join(repliesDir, "stray-trash-r25.tmp")

        const protectRes = await runSessionScriptWithHooks(
          [f.inbox(curProtectId)],
          {
            PATH: process.env.PATH,
            AX_MESSENGER_DATA_DIR: f.dir,
            AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, sessionScript]),
            AX_RELAY_SESSION_DIR: roleDir,
            AX_RELAY_SESSION_TIMEOUT_MS: "5000",
          },
          `{
            readdirReplies: async (dir, phase, id) => {
              const { chmod, readdir, symlink, writeFile } = await import("node:fs/promises");
              if (phase === "post-session" && id === ${JSON.stringify(relayName(curProtectId))}) {
                await chmod(dir, 0o700);
                await writeFile(${JSON.stringify(upperHexMd)}, "대문자hex답", { mode: 0o600 });
                await writeFile(${JSON.stringify(mixedHexUpperExt)}, "대문자확장자답", { mode: 0o600 });
                await writeFile(${JSON.stringify(upperReadyExt)}, "", { mode: 0o600 });
                await writeFile(${JSON.stringify(bareReadyFile)}, "", { mode: 0o600 });
                await writeFile(${JSON.stringify(tempHexFile)}, "임시답조각", { mode: 0o600 });
                await writeFile(${JSON.stringify(atomicTempHexFile)}, "원자적임시답조각", { mode: 0o600 });
                await symlink(${JSON.stringify(symlinkTarget)}, ${JSON.stringify(symlinkReplyEntry)});
                await writeFile(${JSON.stringify(strayTrashFile)}, "지워질쓰레기", { mode: 0o600 });
              }
              return readdir(dir);
            }
          }`,
        )
        assert.equal(protectRes.code, 0, protectRes.stderr)
        assert.equal(await readFile(upperHexMd, "utf8"), "대문자hex답", "대문자 hex 답 파일이 지워지면 안 된다")
        assert.equal(await readFile(mixedHexUpperExt, "utf8"), "대문자확장자답", "확장자 대소문자 변형 파일이 지워지면 안 된다")
        assert.ok(await lstat(upperReadyExt), ".Md.Ready 변형 파일이 지워지면 안 된다")
        assert.ok(await lstat(bareReadyFile), "<hex>.ready 파일이 지워지면 안 된다")
        assert.equal(await readFile(tempHexFile, "utf8"), "임시답조각", "<hex>.md.*.tmp 파일이 지워지면 안 된다")
        await assert.rejects(() => lstat(atomicTempHexFile), { code: "ENOENT" }, "원자적 답글 쓰기 임시 파일은 세션 뒤 정리해야 한다")
        assert.equal(
          (await lstat(symlinkReplyEntry)).isSymbolicLink(),
          true,
          "심볼릭 링크 항목이 세션 뒤 정리에서 지워지면 안 된다",
        )
        await assert.rejects(
          () => lstat(strayTrashFile),
          { code: "ENOENT" },
          "보호 대상이 아닌 일반 임시 파일은 지워져야 한다",
        )
        assert.equal((await readFile(f.reply(curProtectId), "utf8")).trim(), "25회차답:보호이름세션질문")

        // 정리
        for (const p of [
          upperHexMd,
          mixedHexUpperExt,
          upperReadyExt,
          bareReadyFile,
          tempHexFile,
          symlinkReplyEntry,
        ]) {
          await rm(p, { force: true })
        }
      }

      // =========================================================================
      // (라) 잠금 획득 직후 복원 오류 때:
      //   1) 잠금 경로가 남의 잠금(다른 토큰·PID 또는 다른 inode)으로 바뀌어 있으면 지우지 않음(첫 wx·둘째 wx 모두)
      //   2) 자기 잠금일 때 rm 이 EIO 로 실패하면 표준 오류·session-log.jsonl 에 lock-rm-failed(phase=acquire-lock) 기록
      // =========================================================================
      {
        const qAcq = "$r25-acquire-lock-cleanup"
        await f.relay.forward(f.question(qAcq, "!room1", "획득직후정리질문"))

        // 1-a) 첫 번째 wx 획득 직후 restoreRepliesMode("acquire-lock") 도중 잠금이 남의 잠금으로 바뀐 뒤 복원 오류가 난 경우
        await rm(lockPath, { force: true })
        await rm(restorePath, { force: true })
        const foreignLockPayload = `${JSON.stringify({
          token: "foreign-runner-token-1",
          pid: 999991,
          pgid: 0,
          at: Date.now(),
          heartbeatAt: Date.now(),
        })}\n`
        const acqForeignRes1 = await runSessionScriptWithHooks(
          [f.inbox(qAcq)],
          {
            PATH: process.env.PATH,
            AX_MESSENGER_DATA_DIR: f.dir,
            AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, sessionScript]),
            AX_RELAY_SESSION_DIR: roleDir,
            AX_RELAY_SESSION_TIMEOUT_MS: "5000",
          },
          `{
            readRestoreFile: async (p, phase) => {
              if (phase === "acquire-lock") {
                const { writeFile } = await import("node:fs/promises");
                await writeFile(${JSON.stringify(lockPath)}, ${JSON.stringify(foreignLockPayload)}, { mode: 0o600 });
                const e = new Error("EIO on acquire-lock restore");
                e.code = "EIO";
                throw e;
              }
              const err = new Error("ENOENT");
              err.code = "ENOENT";
              throw err;
            }
          }`,
        )
        assert.equal(acqForeignRes1.code, 1, "획득 직후 복원 오류 시 종료 코드 1이어야 한다")
        assert.equal(
          await readFile(lockPath, "utf8"),
          foreignLockPayload,
          "첫 번째 wx 획득 직후 복원 오류 시 남의 잠금으로 바뀌어 있으면 지우면 안 된다",
        )

        // 1-b) 두 번째 wx 획득(오래된 잠금 EEXIST 회수 뒤 재획득) 직후 남의 잠금(새 inode)으로 바뀐 뒤 복원 오류가 난 경우
        await writeFile(
          lockPath,
          `${JSON.stringify({
            token: "stale-before-second-wx",
            pid: 999992,
            pgid: 0,
            at: Date.now() - 60_000,
            heartbeatAt: Date.now() - 60_000,
          })}\n`,
          { mode: 0o600 },
        )
        const foreignLockPayload2 = `${JSON.stringify({
          token: "foreign-runner-token-2",
          pid: 999993,
          pgid: 0,
          at: Date.now(),
          heartbeatAt: Date.now(),
        })}\n`
        const acqForeignRes2 = await runSessionScriptWithHooks(
          [f.inbox(qAcq)],
          {
            PATH: process.env.PATH,
            AX_MESSENGER_DATA_DIR: f.dir,
            AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, sessionScript]),
            AX_RELAY_SESSION_DIR: roleDir,
            AX_RELAY_SESSION_TIMEOUT_MS: "5000",
          },
          `{
            readRestoreFile: async (p, phase) => {
              if (phase === "acquire-lock") {
                const { rename, writeFile } = await import("node:fs/promises");
                const tmpForeign = ${JSON.stringify(`${lockPath}.foreign.tmp`)};
                await writeFile(tmpForeign, ${JSON.stringify(foreignLockPayload2)}, { mode: 0o600 });
                await rename(tmpForeign, ${JSON.stringify(lockPath)});
                const e = new Error("EIO on second acquire-lock restore");
                e.code = "EIO";
                throw e;
              }
              const err = new Error("ENOENT");
              err.code = "ENOENT";
              throw err;
            }
          }`,
        )
        assert.equal(acqForeignRes2.code, 1)
        assert.equal(
          await readFile(lockPath, "utf8"),
          foreignLockPayload2,
          "두 번째 wx 획득 직후 복원 오류 시 남의 잠금(다른 inode·토큰)으로 바뀌어 있으면 지우면 안 된다",
        )

        // 2) 자기 잠금이 맞는데 획득 직후 정리 rm 이 EIO 로 실패하면 표준 오류와 session-log.jsonl 에 lock-rm-failed 기록
        await rm(lockPath, { force: true })
        const acqRmEioRes = await runSessionScriptWithHooks(
          [f.inbox(qAcq)],
          {
            PATH: process.env.PATH,
            AX_MESSENGER_DATA_DIR: f.dir,
            AX_RELAY_SESSION_CMD: JSON.stringify([process.execPath, sessionScript]),
            AX_RELAY_SESSION_DIR: roleDir,
            AX_RELAY_SESSION_TIMEOUT_MS: "5000",
          },
          `{
            readRestoreFile: async (p, phase) => {
              if (phase === "acquire-lock") {
                const e = new Error("EIO on acquire-lock restore");
                e.code = "EIO";
                throw e;
              }
              const err = new Error("ENOENT");
              err.code = "ENOENT";
              throw err;
            },
            rmLockFile: async () => {
              const e = new Error("EIO removing own lock on acquire-lock failure");
              e.code = "EIO";
              throw e;
            }
          }`,
        )
        assert.equal(acqRmEioRes.code, 1)
        assert.match(acqRmEioRes.stderr, /phase=acquire-lock code=EIO reason=lock-rm-failed/)
        const logRows = (await readFile(sessionLogPath, "utf8"))
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
        assert.ok(
          logRows.some(
            (r) =>
              r.event === "lock-rm" &&
              r.actor === "runner" &&
              r.action === "failed" &&
              r.phase === "acquire-lock" &&
              r.reason === AX_RELAY_LOCK_RM_FAILED_REASON &&
              r.errorCode === "EIO",
          ),
          "획득 직후 자기 잠금 rm 실패 시 session-log.jsonl 에 phase=acquire-lock lock-rm-failed 감사가 남아야 한다",
        )
        await rm(lockPath, { force: true })
        await writeFile(f.reply(qAcq), "완료", { mode: 0o600 })
        await writeFile(`${f.reply(qAcq)}.ready`, "", { mode: 0o600 })
      }

      // =========================================================================
      // (마) 봇 forward()(deliver())가 같은 질문 state EIO·JSON·ESHAPE 를 만나면 reportFileError("state") 기록
      // =========================================================================
      {
        // 1) state 파일 읽기 EIO (readStateFile 훅 주입)
        const fwdEioId = "$r25-fwd-state-eio"
        const fwdEioHash = relayName(fwdEioId)
        const fwdEioLogs: string[] = []
        const botFwdEio = createSessionRelay({
          ...f.options,
          readStateFile: async (p) => {
            if (p.endsWith(`${fwdEioHash}.json`)) {
              const err = new Error("EIO reading state in forward/deliver") as NodeJS.ErrnoException
              err.code = "EIO"
              throw err
            }
            const body = await readFile(p, "utf8")
            return { body }
          },
          log: (l) => fwdEioLogs.push(l),
        })
        await assert.rejects(
          () => botFwdEio.forward(f.question(fwdEioId, "!room1", "전달중상태EIO질문")),
          AxRelayPendingError,
          "deliver() 중 state EIO 가 나면 AxRelayPendingError 로 보류되어야 한다",
        )
        assert.ok(
          fwdEioLogs.some((l) => l.includes(`relay state file error file=${fwdEioHash}.json code=EIO`)),
          "봇 forward() 가 state EIO 를 만나면 reportFileError('state') 로그를 남겨야 한다",
        )

        // 2) 같은 질문의 state 파일이 깨진 JSON 인 경우 (EJSONPARSE)
        const fwdJsonId = "$r25-fwd-state-json"
        const fwdJsonHash = relayName(fwdJsonId)
        await writeFile(path.join(stateDir, `${fwdJsonHash}.json`), "{broken-state-on-forward\n", {
          mode: 0o600,
        })
        const fwdJsonLogs: string[] = []
        const botFwdJson = createSessionRelay({
          ...f.options,
          log: (l) => fwdJsonLogs.push(l),
        })
        await assert.rejects(
          () => botFwdJson.forward(f.question(fwdJsonId, "!room1", "전달중상태JSON깨짐질문")),
          AxRelayPendingError,
        )
        assert.ok(
          fwdJsonLogs.some((l) =>
            l.includes(`relay state file error file=${fwdJsonHash}.json code=EJSONPARSE`),
          ),
          "봇 forward() 가 state JSON 깨짐을 만나면 reportFileError('state') 로그를 남겨야 한다",
        )

        // 3) 같은 질문의 state 파일이 꼴 깨짐(ESHAPE: state 칸 누락)인 경우
        const fwdShapeId = "$r25-fwd-state-shape"
        const fwdShapeHash = relayName(fwdShapeId)
        await writeFile(
          path.join(stateDir, `${fwdShapeHash}.json`),
          `${JSON.stringify({ orgId: "org", eventId: fwdShapeId })}\n`,
          { mode: 0o600 },
        )
        const fwdShapeLogs: string[] = []
        const botFwdShape = createSessionRelay({
          ...f.options,
          log: (l) => fwdShapeLogs.push(l),
        })
        await assert.rejects(
          () => botFwdShape.forward(f.question(fwdShapeId, "!room1", "전달중상태ESHAPE질문")),
          AxRelayPendingError,
        )
        assert.ok(
          fwdShapeLogs.some((l) =>
            l.includes(`relay state file error file=${fwdShapeHash}.json code=ESHAPE`),
          ),
          "봇 forward() 가 state ESHAPE 를 만나면 reportFileError('state') 로그를 남겨야 한다",
        )

        const logRows = (await readFile(sessionLogPath, "utf8"))
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
        for (const [hash, code] of [
          [fwdEioHash, "EIO"],
          [fwdJsonHash, "EJSONPARSE"],
          [fwdShapeHash, "ESHAPE"],
        ] as const) {
          assert.ok(
            logRows.some(
              (r) =>
                r.event === "state-unreadable" &&
                r.actor === "bot" &&
                r.action === "skipped" &&
                r.file === `${hash}.json` &&
                r.reason === AX_RELAY_STATE_UNREADABLE_REASON &&
                r.errorCode === code,
            ),
            `session-log.jsonl 에 forward() 의 state-unreadable (${code}) 감사 줄이 남아야 한다`,
          )
        }

        // 정리 (staging 및 깨진 state 파일 제거)
        await rm(path.join(stateDir, `${fwdJsonHash}.json`), { force: true })
        await rm(path.join(stateDir, `${fwdShapeHash}.json`), { force: true })
        for (const sf of await readdir(path.join(relayRoot, "staging"))) {
          if (sf.endsWith(".json")) {
            await rm(path.join(relayRoot, "staging", sf), { force: true })
          }
        }
      }

      // =========================================================================
      // (바) 감사 JSONL 깨진 줄 -> 손상을 기록하고 새 결과와 사용량 기록
      // =========================================================================
      {
        const qAudit = "$r25-audit-corrupt-jsonl"
        await f.relay.forward(f.question(qAudit, "!room1", "감사JSONL깨진줄질문"))
        const qAuditCallId = JSON.parse(await readFile(f.state(qAudit), "utf8")).callId
        await writeFile(f.reply(qAudit), "감사답글", { mode: 0o600 })
        await writeFile(`${f.reply(qAudit)}.ready`, "", { mode: 0o600 })

        // 보낸 직후 audited 표시가 저장되기 전에 ai-usage.jsonl 과 ai-provider-calls.jsonl 끝에
        // 부분 쓰기로 깨진 JSONL 줄이 들어간 상황을 재현한다.
        await appendFile(f.store.usageFile, "{partial-corrupted-usage-line\n", { mode: 0o600 })
        await appendFile(f.store.callFile, "{partial-corrupted-call-result-line\n", { mode: 0o600 })

        const auditRows = async (file: string) => (await readFile(file, "utf8")).split("\n").flatMap((line) => {
          try { return [JSON.parse(line)] } catch { return [] }
        })
        const usageBefore = (await auditRows(f.store.usageFile)).filter((r) => r.callId === qAuditCallId && r.type === "ai-usage" && r.status === "sent")
        const resultsBefore = (await auditRows(f.store.callFile)).filter((r) => r.callId === qAuditCallId && r.type === "provider-call-result")
        assert.equal(usageBefore.length, 0)
        assert.equal(resultsBefore.length, 0)

        const corruptLogs: string[] = []
        const botAuditCorrupt = createSessionRelay({
          ...f.options,
          log: (l) => corruptLogs.push(l),
        })
        await botAuditCorrupt.poll()
        assert.equal(f.sent.at(-1)?.body, "감사답글")

        const usageAfter = (await auditRows(f.store.usageFile)).filter((r) => r.callId === qAuditCallId && r.type === "ai-usage" && r.status === "sent")
        const callAfter = (await auditRows(f.store.callFile)).filter((r) => r.callId === qAuditCallId && r.type === "provider-call-result")
        assert.equal(
          usageAfter.length,
          1,
          "ai-usage.jsonl 에 깨진 줄이 있어도 새 사용량 줄을 기록한다",
        )
        assert.equal(
          callAfter.length,
          1,
          "ai-provider-calls.jsonl 에 깨진 줄이 있어도 새 결과 줄을 기록한다",
        )
        assert.ok(
          corruptLogs.some((l) => l.includes("relay audit-jsonl file error file=ai-usage.jsonl code=EJSONPARSE")),
          "봇 로그에 ai-usage.jsonl 손상 기록이 남아야 한다",
        )
        assert.ok(
          corruptLogs.some((l) =>
            l.includes("relay audit-jsonl file error file=ai-provider-calls.jsonl code=EJSONPARSE"),
          ),
          "봇 로그에 ai-provider-calls.jsonl 손상 기록이 남아야 한다",
        )

        const logRows = (await readFile(sessionLogPath, "utf8"))
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
        for (const fileName of ["ai-usage.jsonl", "ai-provider-calls.jsonl"]) {
          assert.ok(
            logRows.some(
              (r) =>
                r.event === "audit-jsonl-corrupt" &&
                r.actor === "bot" &&
                r.action === "detected" &&
                r.file === fileName &&
                r.reason === AX_RELAY_AUDIT_JSONL_CORRUPT_REASON &&
                r.errorCode === "EJSONPARSE",
            ),
            `session-log.jsonl 에 ${fileName} 의 audit-jsonl-corrupt 감사 줄이 남아야 한다`,
          )
        }
      }
    } finally {
      await chmod(path.join(f.dir, "relay", "replies"), 0o700).catch(() => undefined)
      await chmod(path.join(f.dir, "relay", "session.lock"), 0o600).catch(() => undefined)
      await f.cleanup()
    }
  },
)
