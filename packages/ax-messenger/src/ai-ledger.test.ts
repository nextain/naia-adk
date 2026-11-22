import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { createAiFileStore } from "./ai-store.js"
import { createAiService, createFakeAiProvider, isDuplicateAiError } from "./ai.js"
import {
  AX_GREETING_CLAIM_LEASE_RATIO,
  AX_GREETING_SEND_TIMEOUT_MS,
  AX_LEDGER_BUSY_TIMEOUT_MS,
  AX_LEDGER_GREETING_CLAIM_LEASE_MS,
  AX_LEDGER_RESERVE_DEADLINE_MS,
  axLedgerPathFor,
  openAiLedger,
} from "./ai-ledger.js"
import { AxMessengerError } from "./errors.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LEDGER_SRC = path.join(HERE, "ai-ledger.ts")

async function withDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "ax-ledger-test-"))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const LIMITS = { rateLimitMaxCalls: 2, rateLimitWindowMs: 60_000 }

// (가) 재시작 흉내 — 원장을 닫고 다시 열어도 창 안 호출 수가 이어진다.
test("재시작해도 원장 창 안 호출 수가 이어져 한도가 다시 주어지지 않는다", async () => {
  await withDir(async (dir) => {
    const at = 1_000_000
    const first = openAiLedger(dir, LIMITS)
    assert.equal(first.isNew, true)
    assert.equal((await first.reserve({ callId: "r-restart-1", orgId: "org-a", at })).ok, true)
    assert.equal((await first.reserve({ callId: "r-restart-2", orgId: "org-a", at: at + 1 })).ok, true)
    await first.updateResult("r-restart-1", "success", { inputTokens: 5, outputTokens: 8 })
    await first.updateResult("r-restart-2", "success", { inputTokens: 5, outputTokens: 8 })
    first.close()
    // 같은 폴더를 다시 열어도 창 안 2건이 이어진다.
    const second = openAiLedger(dir, LIMITS)
    const blocked = await second.reserve({ callId: "r-restart-3", orgId: "org-a", at: at + 2 })
    assert.equal(blocked.ok, false)
    assert.equal((blocked as { reason?: string }).reason, "rate-limited")
    // 창이 지나면 다시 받는다.
    const afterWindow = await second.reserve({ callId: "r-restart-4", orgId: "org-a", at: at + 61_000 })
    assert.equal(afterWindow.ok, true)
    second.close()
  })
})

// 자식 진입점. 장벽 뒤에 같은 원장에서 예약·인사·차지·표시를 한 번 시도한다.
// argv: [kind, dir, orgId, callId, eventId, maxCalls, windowMs, atMs, leaseMs]
// kind: race|dup = calls 예약, greet = 인사 예약(roomId를 callId 자리에),
//       claim = 인사 재시도 차지(roomId를 callId 자리에, 차지 표를 돌려줌),
//       mark = 차지 표(eventId 자리)로 sent 쓰기(OK·REJECTED).
// atMs·leaseMs가 "-"면 기본값이다.
const CHILD_ENTRY = `import { openAiLedger } from ${JSON.stringify(LEDGER_SRC)}
const [kind, dir, orgId, callId, eventId, maxCallsRaw, windowMsRaw, atRaw, leaseRaw] = process.argv.slice(2)
const limits = { rateLimitMaxCalls: Number(maxCallsRaw), rateLimitWindowMs: Number(windowMsRaw) }
const atOpt = atRaw === undefined || atRaw === "-" ? undefined : Number(atRaw)
const leaseOpt = leaseRaw === undefined || leaseRaw === "-" ? undefined : Number(leaseRaw)
process.stdin.setEncoding("utf8")
let buffered = ""
process.stdout.write("READY\\n")
await new Promise((resolve) => {
  process.stdin.on("data", (chunk) => {
    buffered += chunk
    if (buffered.includes("\\n")) resolve()
  })
})
try {
  // 여러 자식이 동시에 원장을 여는 겹침(BUSY)은 재는 대상이 아니므로
  // 자식 진입점에서만 다시 열어 본다. 단정(정확히 몇 개가 이기는지)은 그대로다.
  let ledger = null
  let openError = null
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      ledger = openAiLedger(dir, limits)
      openError = null
      break
    } catch (error) {
      openError = error
      if (!/busy|locked/i.test(String(error?.message ?? error))) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  if (!ledger) throw openError
  if (kind === "greet" || kind === "claim" || kind === "mark") {
    const roomId = callId
    if (kind === "greet") {
      const outcome = await ledger.reserveGreeting({ orgId, roomId, ...(atOpt === undefined ? {} : { at: atOpt }) })
      ledger.close()
      if (outcome.ok) {
        process.stdout.write("WON\\n")
        process.exit(0)
      }
      process.stdout.write("DUP\\n")
      process.exit(2)
    }
    if (kind === "claim") {
      const token = await ledger.claimGreetingForRetry(orgId, roomId, atOpt, leaseOpt)
      ledger.close()
      if (token) {
        process.stdout.write("WON " + token + "\\n")
        process.exit(0)
      }
      process.stdout.write("DUP\\n")
      process.exit(2)
    }
    const marked = await ledger.markGreetingSent(orgId, roomId, {
      claimToken: eventId === "-" ? "" : eventId,
      ...(atOpt === undefined ? {} : { at: atOpt }),
    })
    ledger.close()
    if (marked) {
      process.stdout.write("OK\\n")
      process.exit(0)
    }
    process.stdout.write("REJECTED\\n")
    process.exit(2)
  }
  const outcome = await ledger.reserve({
    callId,
    orgId,
    eventId: eventId === "-" ? undefined : eventId,
  })
  ledger.close()
  if (outcome.ok) {
    process.stdout.write("WON\\n")
    process.exit(0)
  }
  process.stdout.write(outcome.reason === "duplicate" ? "DUP\\n" : "LIMIT\\n")
  process.exit(2)
} catch (error) {
  process.stdout.write("ERR " + String((error as Error)?.message ?? error) + "\\n")
  process.exit(1)
}
`

async function withChildEntry(run: (entry: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "ax-ledger-child-"))
  const entry = path.join(dir, "ledger-child.mts")
  const { writeFile } = await import("node:fs/promises")
  await writeFile(entry, CHILD_ENTRY, { encoding: "utf8" })
  try {
    await run(entry)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function runChild(entry: string, args: string[]) {
  const child = spawn(process.execPath, ["--import", "tsx", entry, ...args], {
    cwd: HERE,
    stdio: ["pipe", "pipe", "pipe"],
  })
  let output = ""
  child.stdout.on("data", (chunk) => { output += chunk.toString() })
  child.stderr.on("data", (chunk) => { output += chunk.toString() })
  const done = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code))
  })
  return { child, output: () => output, done }
}

async function waitFor(check: () => string, needle: string, description: string) {
  const end = Date.now() + 20000
  for (;;) {
    if (check().includes(needle)) return
    if (Date.now() > end) throw new Error(`시간 초과: ${description} (${check().slice(-200)})`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

// (나) 자식 여럿이 장벽으로 동시에 예약 → 성공 수가 정확히 한도와 같다.
test("자식 여럿이 동시에 예약하면 성공 수가 정확히 한도와 같다", async () => {
  await withChildEntry(async (entry) => {
    for (let round = 0; round < 3; round++) {
      await withDir(async (dir) => {
        // 표·색인을 미리 만들어 자식들의 DDL 겹침을 줄인다.
        const ready = openAiLedger(dir, { rateLimitMaxCalls: 3, rateLimitWindowMs: 60_000 })
        ready.close()
        const maxCalls = 3
        const racers = [0, 1, 2, 3, 4].map((index) =>
          runChild(entry, ["race", dir, `org-race-${round}`, `race-${round}-${index}`, "-", String(maxCalls), "60000"]),
        )
        for (const racer of racers) await waitFor(racer.output, "READY", "자식 준비")
        for (const racer of racers) racer.child.stdin.write("go\n")
        const codes = await Promise.all(racers.map((racer) => racer.done))
        const won = codes.filter((code) => code === 0).length
        const limited = codes.filter((code) => code === 2).length
        const detail = `${round}회차: 성공 수가 한도와 같아야 한다(${codes}, ${racers.map((r) => r.output()).join("|")})`
        assert.equal(won, maxCalls, detail)
        assert.equal(limited, racers.length - maxCalls, detail)
      })
    }
  })
})

// (다) 같은 event_id를 자식 둘이 동시에 예약 → 정확히 하나만 성공.
test("같은 event_id를 자식 둘이 동시에 예약하면 정확히 하나만 성공한다", async () => {
  await withChildEntry(async (entry) => {
    for (let round = 0; round < 3; round++) {
      await withDir(async (dir) => {
        const ready = openAiLedger(dir, { rateLimitMaxCalls: 10, rateLimitWindowMs: 60_000 })
        ready.close()
        const eventId = `$evt-dup-${round}`
        const first = runChild(entry, ["dup", dir, "org-dup", `dup-${round}-a`, eventId, "10", "60000"])
        const second = runChild(entry, ["dup", dir, "org-dup", `dup-${round}-b`, eventId, "10", "60000"])
        await waitFor(first.output, "READY", "자식 준비")
        await waitFor(second.output, "READY", "자식 준비")
        first.child.stdin.write("go\n")
        second.child.stdin.write("go\n")
        const [codeA, codeB] = await Promise.all([first.done, second.done])
        const won = [codeA, codeB].filter((code) => code === 0).length
        const dup = [first.output(), second.output()].filter((out) => out.includes("DUP")).length
        assert.equal(won, 1, `${round}회차: 정확히 하나만 성공해야 한다(${codeA},${codeB},${first.output()},${second.output()})`)
        assert.equal(dup, 1)
      })
    }
  })
})

// (다-2) 같은 방 인사를 자식 둘이 동시에 예약 → 정확히 하나만 성공.
// 인사도 원자 예약으로 막는다. calls 표·빈도 합산과 무관하다.
test("자식 둘이 같은 방 인사를 동시에 예약하면 정확히 하나만 성공한다", async () => {
  await withChildEntry(async (entry) => {
    for (let round = 0; round < 3; round++) {
      await withDir(async (dir) => {
        const ready = openAiLedger(dir, { rateLimitMaxCalls: 10, rateLimitWindowMs: 60_000 })
        ready.close()
        const roomId = `!greet-${round}:tenant.example.invalid`
        const first = runChild(entry, ["greet", dir, "org-greet", roomId, "-", "10", "60000"])
        const second = runChild(entry, ["greet", dir, "org-greet", roomId, "-", "10", "60000"])
        await waitFor(first.output, "READY", "자식 준비")
        await waitFor(second.output, "READY", "자식 준비")
        first.child.stdin.write("go\n")
        second.child.stdin.write("go\n")
        const [codeA, codeB] = await Promise.all([first.done, second.done])
        const won = [codeA, codeB].filter((code) => code === 0).length
        assert.equal(won, 1, `${round}회차: 인사 예약은 정확히 하나만 성공해야 한다(${codeA},${codeB},${first.output()},${second.output()})`)
        // 원장에는 인사 1건만 있고 calls 표에는 0건이다.
        const check = openAiLedger(dir, { rateLimitMaxCalls: 10, rateLimitWindowMs: 60_000 })
        try {
          assert.deepEqual(check.summarizeCoverage(), { providerCalls: 0, providerResults: 0, resultMissing: 0 })
          assert.deepEqual(check.summarizeGreetings("org-greet"), { reserved: 1, sent: 0 })
        } finally {
          check.close()
        }
      })
    }
  })
})

// (다-3) 인사 예약은 빈도 한도와 상관없이 된다. 한도가 꽉 차도 인사는 예약된다.
test("호출 한도가 꽉 차도 인사는 예약된다", async () => {
  await withDir(async (dir) => {
    const ledger = openAiLedger(dir, { rateLimitMaxCalls: 1, rateLimitWindowMs: 60_000 })
    try {
      assert.equal((await ledger.reserve({ callId: "fill-1", orgId: "org-a" })).ok, true)
      const blocked = await ledger.reserve({ callId: "fill-2", orgId: "org-a" })
      assert.equal(blocked.ok, false)
      assert.equal((blocked as { reason?: string }).reason, "rate-limited")
      // 한도가 꽉 찼어도 인사는 예약된다.
      assert.equal((await ledger.reserveGreeting({ orgId: "org-a", roomId: "!r1:tenant.example.invalid" })).ok, true)
      // 인사 예약은 빈도 합산·요약에 잡히지 않는다.
      assert.equal(ledger.countInWindow(), 1)
      assert.deepEqual(ledger.summarizeCoverage(), { providerCalls: 1, providerResults: 0, resultMissing: 1 })
      assert.deepEqual(ledger.summarizeGreetings("org-a"), { reserved: 1, sent: 0 })
    } finally {
      ledger.close()
    }
  })
})

// (다-4) reserved로 남긴 인사 → 재시작·동기화 때 다시 보내고 sent로 둔다.
// 두 봇이 동시에 다시 보내려 해도 차지한 하나만 보낸다.
test("reserved 인사는 재시작 때 한 봇만 차지해 다시 보내고 sent가 된다", async () => {
  await withChildEntry(async (entry) => {
    await withDir(async (dir) => {
      const first = openAiLedger(dir, { rateLimitMaxCalls: 10, rateLimitWindowMs: 60_000 })
      assert.equal((await first.reserveGreeting({ orgId: "org-a", roomId: "!retry:tenant.example.invalid" })).ok, true)
      first.close()
      // 재시작: 다시 열어도 reserved로 남는다.
      const second = openAiLedger(dir, { rateLimitMaxCalls: 10, rateLimitWindowMs: 60_000 })
      try {
        assert.deepEqual(second.summarizeGreetings("org-a"), { reserved: 1, sent: 0 })
        // calls 요약에는 인사가 잡히지 않는다.
        assert.deepEqual(second.summarizeCoverage(), { providerCalls: 0, providerResults: 0, resultMissing: 0 })
      } finally {
        second.close()
      }
      // 두 자식이 동시에 재시도 차지 → 정확히 하나만 차지 표를 받는다.
      const ready = openAiLedger(dir, { rateLimitMaxCalls: 10, rateLimitWindowMs: 60_000 })
      ready.close()
      const roomId = "!retry:tenant.example.invalid"
      const a = runChild(entry, ["claim", dir, "org-a", roomId, "-", "10", "60000"])
      const b = runChild(entry, ["claim", dir, "org-a", roomId, "-", "10", "60000"])
      await waitFor(a.output, "READY", "자식 준비")
      await waitFor(b.output, "READY", "자식 준비")
      a.child.stdin.write("go\n")
      b.child.stdin.write("go\n")
      const [codeA, codeB] = await Promise.all([a.done, b.done])
      const won = [codeA, codeB].filter((code) => code === 0).length
      assert.equal(won, 1, `재시도 차지는 정확히 하나만 성공해야 한다(${codeA},${codeB})`)
      // 차지 표를 받은 쪽만 sent를 쓸 수 있다.
      const winnerOutput = codeA === 0 ? a.output() : b.output()
      const winnerToken = winnerOutput.split("WON ")[1]?.trim()
      assert.ok(winnerToken, "승자의 차지 표가 있어야 한다")
      const third = openAiLedger(dir, { rateLimitMaxCalls: 10, rateLimitWindowMs: 60_000 })
      try {
        assert.equal(await third.markGreetingSent("org-a", roomId, { claimToken: winnerToken }), true)
        assert.deepEqual(third.summarizeGreetings("org-a"), { reserved: 0, sent: 1 })
        // 한 번 더 표시해도 그대로다(멱등).
        assert.equal(await third.markGreetingSent("org-a", roomId, { claimToken: winnerToken }), true)
        assert.deepEqual(third.summarizeGreetings("org-a"), { reserved: 0, sent: 1 })
        // 보낸 뒤에는 같은 방 인사를 다시 예약해도 duplicate다.
        const again = await third.reserveGreeting({ orgId: "org-a", roomId })
        assert.equal(again.ok, false)
      } finally {
        third.close()
      }
    })
  })
})

// (다-5) 차지 임대가 지나 둘째가 차지를 가져가면, 첫째의 늦은 sent는
// 차지 표 불일치로 거부되고 reserved로 남는다. 실제 자식 프로세스·실제 원장.
// 시각은 자식에 직접 넣어 임대를 기다리지 않고 재현한다.
test("차지 임대가 지나 둘째가 가져가면 첫째의 늦은 sent는 거부된다", async () => {
  await withChildEntry(async (entry) => {
    await withDir(async (dir) => {
      const leaseMs = 1_000
      const startAt = 5_000_000
      const parent = openAiLedger(dir, { rateLimitMaxCalls: 10, rateLimitWindowMs: 60_000 })
      assert.equal((await parent.reserveGreeting({ orgId: "org-a", roomId: "!takeover:tenant.example.invalid", at: startAt })).ok, true)
      parent.close()
      // 첫째 자식이 차지(표 A)한 뒤, 임대가 지나 둘째 자식이 차지 → 새 표 B를 받는다.
      const first = runChild(entry, ["claim", dir, "org-a", "!takeover:tenant.example.invalid", "-", "10", "60000", String(startAt), String(leaseMs)])
      await waitFor(first.output, "READY", "자식 준비")
      first.child.stdin.write("go\n")
      assert.equal(await first.done, 0, `첫째가 차지해야 한다(${first.output()})`)
      const firstToken = first.output().split("WON ")[1]?.trim()
      assert.ok(firstToken, "첫째의 차지 표가 있어야 한다")
      const second = runChild(entry, ["claim", dir, "org-a", "!takeover:tenant.example.invalid", "-", "10", "60000", String(startAt + leaseMs + 1), String(leaseMs)])
      await waitFor(second.output, "READY", "자식 준비")
      second.child.stdin.write("go\n")
      assert.equal(await second.done, 0, `둘째가 임대가 지난 차지를 가져가야 한다(${second.output()})`)
      const secondToken = second.output().split("WON ")[1]?.trim()
      assert.ok(secondToken, "둘째의 차지 표가 있어야 한다")
      assert.notEqual(secondToken, firstToken, "차지를 가져가면 표가 바뀌어야 한다")
      // 첫째가 늦게 옛 표로 sent를 쓰려 하면 거부된다. 자식 프로세스로 쓴다.
      const late = runChild(entry, ["mark", dir, "org-a", "!takeover:tenant.example.invalid", firstToken, "10", "60000", String(startAt + leaseMs + 2)])
      await waitFor(late.output, "READY", "자식 준비")
      late.child.stdin.write("go\n")
      assert.equal(await late.done, 2, `옛 표의 늦은 sent는 거부되어야 한다(${late.output()})`)
      assert.ok(late.output().includes("REJECTED"))
      // 줄은 reserved로 남는다.
      const check = openAiLedger(dir, { rateLimitMaxCalls: 10, rateLimitWindowMs: 60_000 })
      try {
        assert.deepEqual(check.summarizeGreetings("org-a"), { reserved: 1, sent: 0 })
        assert.equal(check.getGreeting("org-a", "!takeover:tenant.example.invalid")?.claimToken, secondToken)
        // 둘째가 새 표로 쓰면 된다.
        assert.equal(await check.markGreetingSent("org-a", "!takeover:tenant.example.invalid", { claimToken: secondToken }), true)
        assert.deepEqual(check.summarizeGreetings("org-a"), { reserved: 0, sent: 1 })
      } finally {
        check.close()
      }
    })
  })
})

// (다-6) 보내기 기한을 넘기면(결과 모름) sent를 쓰지 않고 차지(claim_token)를
// 풀지도 않으므로 줄은 reserved로 남는다. 봇 길은 기한 넘김 때 원장을
// 건드리지 않는다. 여기서는 예약 뒤 sent 쓰기 없이 임대가 살아 있는 동안
// 둘째의 차지가 막히고 줄이 reserved로 남는지 실제 자식 프로세스로 본다.
// 기한 장치 자체(늦은 서버를 끊음)는 matrix-send.test.ts에서 본다.
test("보내기 기한을 넘기면 reserved로 남고 차지는 풀리지 않는다", async () => {
  await withChildEntry(async (entry) => {
    await withDir(async (dir) => {
      const leaseMs = 60_000
      const startAt = 7_000_000
      const parent = openAiLedger(dir, { rateLimitMaxCalls: 10, rateLimitWindowMs: 60_000 })
      assert.equal((await parent.reserveGreeting({ orgId: "org-a", roomId: "!timeout:tenant.example.invalid", at: startAt })).ok, true)
      parent.close()
      // 첫째 자식이 차지(표 A)한 뒤 보내기가 기한을 넘겨 끊겼다(원장을
      // 건드리지 않음: sent 쓰기 없음, 차지 풀기 없음). 임대 안의 둘째
      // 차지는 막혀야 한다.
      const first = runChild(entry, ["claim", dir, "org-a", "!timeout:tenant.example.invalid", "-", "10", "60000", String(startAt), String(leaseMs)])
      await waitFor(first.output, "READY", "자식 준비")
      first.child.stdin.write("go\n")
      assert.equal(await first.done, 0, `첫째가 차지해야 한다(${first.output()})`)
      const firstToken = first.output().split("WON ")[1]?.trim()
      assert.ok(firstToken, "첫째의 차지 표가 있어야 한다")
      const second = runChild(entry, ["claim", dir, "org-a", "!timeout:tenant.example.invalid", "-", "10", "60000", String(startAt + 10_000), String(leaseMs)])
      await waitFor(second.output, "READY", "자식 준비")
      second.child.stdin.write("go\n")
      assert.equal(await second.done, 2, `임대 안의 둘째 차지는 막혀야 한다(${second.output()})`)
      // 줄은 reserved로 남고 표도 첫째 것이다.
      const check = openAiLedger(dir, { rateLimitMaxCalls: 10, rateLimitWindowMs: 60_000 })
      try {
        assert.deepEqual(check.summarizeGreetings("org-a"), { reserved: 1, sent: 0 })
        assert.equal(check.getGreeting("org-a", "!timeout:tenant.example.invalid")?.claimToken, firstToken)
      } finally {
        check.close()
      }
    })
  })
})

// (다-7) 차지 임대는 보내기 기한보다 충분히 길다(임대 ≥ 기한×6). 시작 때
// 봇이 같은 관계를 단정한다.
test("차지 임대는 보내기 기한의 6배 이상이다", () => {
  assert.equal(AX_GREETING_SEND_TIMEOUT_MS, 10_000)
  assert.equal(AX_LEDGER_GREETING_CLAIM_LEASE_MS, 60_000)
  assert.equal(AX_GREETING_CLAIM_LEASE_RATIO, 6)
  assert.ok(AX_LEDGER_GREETING_CLAIM_LEASE_MS >= AX_GREETING_SEND_TIMEOUT_MS * AX_GREETING_CLAIM_LEASE_RATIO)
})

// (라) 원장 열기·예약 오류 주입 → 제공자에 닿지 않고 닫힘.
test("원장 예약 오류 주입 때는 제공자에 닿지 않고 닫힘으로 들어간다", async () => {
  const fake = createFakeAiProvider()
  const broken = {
    reserve: async () => { throw new Error("원장 고장(시험)") },
    updateResult: async () => undefined,
    close: () => undefined,
    summarizeCoverage: () => ({ providerCalls: 0, providerResults: 0, resultMissing: 0 }),
  }
  const service = createAiService({ rateLimitMaxCalls: 2, rateLimitWindowMs: 60_000, maxInputSize: 50, maxOutputTokens: 200 }, {
    provider: fake,
    ledger: broken as never,
  })
  const first = await service
    .answer({ orgId: "org-a", callId: "tag-ledger-broken-1", input: "짧은 질문" })
    .then(() => { throw new Error("거부되어야 한다") }, (failure: unknown) => failure)
  assert.ok(first instanceof AxMessengerError)
  assert.equal(first.kind, "server")
  assert.equal(fake.requests.length, 0)
  assert.equal(service.providerCalls.length, 0)
  // 닫힘 뒤에도 제공자에 닿지 않는다.
  const second = await service
    .answer({ orgId: "org-a", callId: "tag-ledger-broken-2", input: "짧은 질문" })
    .then(() => { throw new Error("거부되어야 한다") }, (failure: unknown) => failure)
  assert.ok(second instanceof AxMessengerError)
  assert.equal(fake.requests.length, 0)
})

test("원장 열기 오류 주입 때는 시작 오류다", () => {
  assert.throws(
    () => openAiLedger(":memory:", LIMITS, { openDatabase: () => { throw new Error("열기 고장(시험)") } }),
    /열기 고장/,
  )
})

test("원장 예약 뒤 같은 event_id는 서비스에서 중복으로 보고 부르지 않는다", async () => {
  await withDir(async (dir) => {
    const ledger = openAiLedger(dir, { rateLimitMaxCalls: 10, rateLimitWindowMs: 60_000 })
    try {
      const fake = createFakeAiProvider()
      const service = createAiService({ rateLimitMaxCalls: 10, rateLimitWindowMs: 60_000, maxInputSize: 50, maxOutputTokens: 200 }, {
        provider: fake,
        ledger,
      })
      const first = await service.answer({ orgId: "org-a", callId: "tag-dup-1", eventId: "$evt-1", input: "짧은 질문" })
      assert.ok(first.text.length > 0)
      assert.equal(fake.requests.length, 1)
      const dup = await service
        .answer({ orgId: "org-a", callId: "tag-dup-2", eventId: "$evt-1", input: "짧은 질문" })
        .then(() => { throw new Error("거부되어야 한다") }, (failure: unknown) => failure)
      assert.ok(isDuplicateAiError(dup))
      assert.equal(fake.requests.length, 1)
      // 다른 event_id는 통과한다.
      const other = await service.answer({ orgId: "org-a", callId: "tag-dup-3", eventId: "$evt-2", input: "짧은 질문" })
      assert.ok(other.text.length > 0)
      assert.equal(fake.requests.length, 2)
    } finally {
      ledger.close()
    }
  })
})

// (마) 옛 jsonl 창 안 줄 넘기기 → 넘긴 수만큼 한도에서 빠진다.
test("옛 jsonl 창 안 줄을 넘기면 그 수만큼 한도에서 빠진다", async () => {
  await withDir(async (dir) => {
    const store = createAiFileStore(dir)
    const now = 1_000_000
    const windowMs = 60_000
    // 창 안 2건(표지 없는 옛 줄 포함) + 창 밖 1건.
    await store.appendCall({ callId: "tag-old-1", orgId: "org-a", at: now - 10_000, inputSize: 9, maxOutputTokens: 200, provider: "fake" })
    await store.appendCall({ callId: "tag-old-2", orgId: "org-a", at: now - 5_000, inputSize: 9, maxOutputTokens: 200, provider: "fake", eventId: "$old-2" })
    await store.appendCall({ callId: "tag-old-out", orgId: "org-a", at: now - 300_000, inputSize: 9, maxOutputTokens: 200, provider: "fake" })
    const ledger = openAiLedger(dir, { rateLimitMaxCalls: 3, rateLimitWindowMs: windowMs })
    try {
      assert.equal(ledger.isNew, true)
      const listed = await store.listProviderCalls()
      const cutoff = now - windowMs
      const inWindow = listed.filter((row) => row.at > cutoff)
      assert.equal(inWindow.length, 2)
      await ledger.importCalls(inWindow.map((row) => ({ ...row, state: "success" as const })))
      // 2건이 찼으므로 하나는 되고 다음은 막힌다.
      assert.equal((await ledger.reserve({ callId: "tag-new-1", orgId: "org-a", at: now })).ok, true)
      const blocked = await ledger.reserve({ callId: "tag-new-2", orgId: "org-a", at: now + 1 })
      assert.equal(blocked.ok, false)
    } finally {
      ledger.close()
    }
  })
})

test("넘기기 실패 주입 때는 시작 오류다", async () => {
  const failingStore = {
    listProviderCalls: async (): Promise<never> => { throw new Error("읽기 고장(시험)") },
  }
  await assert.rejects(
    (async () => {
      const ledger = openAiLedger(":memory:", LIMITS)
      try {
        await failingStore.listProviderCalls()
      } finally {
        ledger.close()
      }
    })(),
    /읽기 고장/,
  )
})

// (바) 결과 짝 없는 예약 → 재시작 때 result-missing 집계.
test("결과 짝 없는 예약은 재시작 때 result-missing으로 집계된다", async () => {
  await withDir(async (dir) => {
    const first = openAiLedger(dir, LIMITS)
    assert.equal((await first.reserve({ callId: "tag-miss-1", orgId: "org-a" })).ok, true)
    assert.equal((await first.reserve({ callId: "tag-miss-2", orgId: "org-a" })).ok, true)
    await first.updateResult("tag-miss-1", "success", { inputTokens: 5, outputTokens: 8 })
    // tag-miss-2는 reserved로 남는다.
    assert.deepEqual(first.summarizeCoverage(), { providerCalls: 2, providerResults: 1, resultMissing: 1 })
    first.close()
    const second = openAiLedger(dir, LIMITS)
    try {
      assert.deepEqual(second.summarizeCoverage(), { providerCalls: 2, providerResults: 1, resultMissing: 1 })
    } finally {
      second.close()
    }
  })
})

test("원장 파일은 0600이고 busy_timeout을 짧게 건다", async () => {
  await withDir(async (dir) => {
    const ledger = openAiLedger(dir, LIMITS)
    try {
      const mode = (await stat(ledger.path)).mode & 0o777
      assert.equal(mode, 0o600)
      assert.equal(AX_LEDGER_BUSY_TIMEOUT_MS, 50)
      assert.equal(AX_LEDGER_RESERVE_DEADLINE_MS, 5_000)
    } finally {
      ledger.close()
    }
  })
})

// 다른 연결이 쓰기 잠금을 쥔 채 놓지 않으면 예약 한 번은 총 기한(5초) 안에
// 실패하고, 서비스는 제공자에 닿지 않고 닫힘으로 간다. 대기 동안 이벤트 루프는
// 막히지 않아 다른 타이머가 계속 돈다.
test("쓰기 잠금이 풀리지 않으면 총 기한 안에 닫힘으로 간다", async () => {
  await withDir(async (dir) => {
    const ledger = openAiLedger(dir, { rateLimitMaxCalls: 10, rateLimitWindowMs: 60_000 })
    try {
      const fake = createFakeAiProvider()
      const service = createAiService(
        { rateLimitMaxCalls: 10, rateLimitWindowMs: 60_000, maxInputSize: 50, maxOutputTokens: 200 },
        { provider: fake, ledger },
      )
      // 다른 연결이 쓰기 잠금을 쥔 채 놓지 않는다.
      const holder = new DatabaseSync(axLedgerPathFor(dir))
      holder.exec("BEGIN IMMEDIATE;")
      // 대기 동안 이벤트 루프가 도는지 본다.
      let ticks = 0
      const timer = setInterval(() => { ticks += 1 }, 50)
      const started = Date.now()
      const first = await service
        .answer({ orgId: "org-a", callId: "tag-lock-1", input: "짧은 질문" })
        .then(() => { throw new Error("거부되어야 한다") }, (failure: unknown) => failure)
      const elapsed = Date.now() - started
      clearInterval(timer)
      holder.exec("ROLLBACK;")
      holder.close()
      assert.ok(first instanceof AxMessengerError)
      assert.equal(first.kind, "server")
      assert.equal(fake.requests.length, 0)
      // 총 기한(5초) 안에 닫힘으로 가야 한다. 옛 상한(분 단위)이 아니다.
      assert.ok(elapsed >= 3_000, `잠금을 기다렸어야 한다(elapsed=${elapsed}ms)`)
      assert.ok(elapsed < 20_000, `총 기한 안에 실패해야 한다(elapsed=${elapsed}ms)`)
      // Atomics.wait 같은 동기 대기가 아니라 비동기 재시도이므로, 기다리는 동안
      // 이벤트 루프가 돌아 다른 타이머가 계속 돈다.
      assert.ok(ticks >= 10, `대기 동안 타이머가 계속 돌아야 한다(ticks=${ticks} elapsed=${elapsed}ms)`)
      // 닫힘 뒤의 호출은 제공자에 닿지 않고 거부된다.
      const second = await service
        .answer({ orgId: "org-a", callId: "tag-lock-2", input: "짧은 질문" })
        .then(() => { throw new Error("거부되어야 한다") }, (failure: unknown) => failure)
      assert.ok(second instanceof AxMessengerError)
      assert.equal(second.kind, "server")
      assert.equal(fake.requests.length, 0)
    } finally {
      ledger.close()
    }
  })
})
