import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { acquireAxBotLock, axBotSocketNameFor } from "./bot-lock.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_PATH = path.join(HERE, "bot-lock.ts")

function orgTag(suite: string): string {
  // 시험마다 서로 다른 기관 표지를 써 다른 시험·실행 중인 봇과 겹치지 않게 한다.
  return `r4-lock-${suite}-${randomBytes(6).toString("hex")}`
}

// 자식 프로세스 진입점. 셋이 동시에 획득을 노리거나(race: stdin "go" 한 줄을
// 장벽 삼아 동시에 출발), 잡은 채 죽을(hold: SIGKILL 대상) 때 쓴다.
const CHILD_ENTRY = `import { acquireAxBotLock } from ${JSON.stringify(SRC_PATH)}
const mode = process.argv[2]
const orgId = process.argv[3]
const holdMs = Number(process.argv[4] ?? "800")
if (mode === "hold") {
  const lock = await acquireAxBotLock(orgId)
  process.stdout.write("HELD\\n")
  await new Promise((resolve) => setTimeout(resolve, 60000))
  await lock.release()
  process.exit(0)
}
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
  const lock = await acquireAxBotLock(orgId)
  process.stdout.write("WON\\n")
  await new Promise((resolve) => setTimeout(resolve, holdMs))
  await lock.release()
  process.exit(0)
} catch (error) {
  process.stdout.write("LOST " + String((error as Error)?.message ?? error) + "\\n")
  process.exit(2)
}
`

async function withChildEntry(run: (entry: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "ax-bot-lock-child-"))
  // tsx가 타입 문법을 걷어내게 .mts로 둔다(.mjs는 JS로 보아 실패한다).
  const entry = path.join(dir, "lock-child.mts")
  await writeFile(entry, CHILD_ENTRY, { encoding: "utf8" })
  try {
    await run(entry)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

type ChildResult = { child: ReturnType<typeof spawn>; output: () => string; done: Promise<number | null> }

function runChild(entry: string, args: string[]): ChildResult {
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

async function waitForOutput(check: () => string, needle: string, description: string): Promise<void> {
  const end = Date.now() + 15000
  for (;;) {
    if (check().includes(needle)) return
    if (Date.now() > end) throw new Error(`시간 초과: ${description}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

test("기관 표지는 해시로 정규화되어 추상 이름 한도 안에 든다", () => {
  const weird = "기관/표지: 공백 있음! 매우 긴 표지 ".repeat(20)
  const first = axBotSocketNameFor(weird)
  assert.equal(first, axBotSocketNameFor(weird))
  assert.notEqual(first, axBotSocketNameFor("다른 기관"))
  assert.ok(first.startsWith("\0ax-ai-bot-"))
  assert.equal(Buffer.byteLength(first, "utf8"), 27)
  assert.throws(() => axBotSocketNameFor("  "), /AX_ORG_ID/)
})

test("한 프로세스가 잡은 동안 둘째 획득은 거부된다", async () => {
  const orgId = orgTag("single")
  const first = await acquireAxBotLock(orgId)
  try {
    await assert.rejects(acquireAxBotLock(orgId), /이미 실행 중/)
  } finally {
    await first.release()
  }
})

test("자식 셋이 동시에 노리면 정확히 하나만 성공한다", async () => {
  await withChildEntry(async (entry) => {
    for (let round = 0; round < 3; round++) {
      const orgId = orgTag(`race-${round}`)
      const racers = [0, 1, 2, 3].map(() => runChild(entry, ["race", orgId, "800"]))
      // 넷이 모두 출발선에 설 때까지 기다렸다가 동시에 출발시킨다.
      for (const racer of racers) {
        await waitForOutput(racer.output, "READY", "자식 준비")
      }
      for (const racer of racers) {
        racer.child.stdin.write("go\n")
      }
      const codes = await Promise.all(racers.map((racer) => racer.done))
      const outputs = racers.map((racer) => racer.output())
      const wonIndexes = codes.map((code, index) => (code === 0 ? index : -1)).filter((index) => index >= 0)
      const lostIndexes = codes.map((code, index) => (code === 2 ? index : -1)).filter((index) => index >= 0)
      assert.equal(wonIndexes.length, 1, `${round}회차: 정확히 하나만 성공해야 한다(${JSON.stringify(outputs)})`)
      assert.equal(lostIndexes.length, 3)
      assert.ok(lostIndexes.every((index) => (outputs[index] ?? "").includes("이미 실행 중")))
      assert.ok((outputs[wonIndexes[0] as number] ?? "").includes("WON"))
    }
  })
})

test("잡은 자식을 SIGKILL로 죽여도 새 획득이 성공한다", async () => {
  await withChildEntry(async (entry) => {
    const orgId = orgTag("kill")
    const holder = runChild(entry, ["hold", orgId])
    await waitForOutput(holder.output, "HELD", "자식이 잠금을 잡기")
    // 둘째는 잡혀 있는 동안 거부된다.
    await assert.rejects(acquireAxBotLock(orgId), /이미 실행 중/)
    holder.child.kill("SIGKILL")
    await holder.done
    // 운영체제가 추상 이름을 자동으로 풀었으므로(회수 코드 없음) 바로 잡힌다.
    const next = await acquireAxBotLock(orgId)
    await next.release()
  })
})

test("해제 뒤 재획득이 성공한다", async () => {
  const orgId = orgTag("reacquire")
  const lock = await acquireAxBotLock(orgId)
  await lock.release()
  const again = await acquireAxBotLock(orgId)
  await again.release()
})

test("리눅스가 아니면 시작 오류다", async () => {
  await assert.rejects(acquireAxBotLock(orgTag("platform"), { platform: "darwin" }), /리눅스/)
  await assert.rejects(acquireAxBotLock(orgTag("platform-win"), { platform: "win32" }), /리눅스/)
})
