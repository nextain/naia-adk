import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { createAiFileStore } from "./ai-store.js"

async function withStore(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "ax-ai-store-test-"))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("호출 기록과 사용량이 줄 단위 JSON으로 쌓인다", async () => {
  await withStore(async (dir) => {
    const store = createAiFileStore(dir)
    await store.appendCall({ callId: "tag-1", orgId: "org-a", at: 1000, inputSize: 12, maxOutputTokens: 200 })
    await store.appendUsage({
      callId: "tag-1",
      orgId: "org-a",
      userId: "@a:tenant.example.invalid",
      roomId: "!r:tenant.example.invalid",
      at: 1001,
      inputSize: 12,
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    })
    const callLines = (await readFile(store.callFile, "utf8")).trim().split("\n")
    const usageLines = (await readFile(store.usageFile, "utf8")).trim().split("\n")
    assert.equal(callLines.length, 1)
    assert.equal(usageLines.length, 1)
    assert.deepEqual(JSON.parse(callLines[0] as string), {
      type: "provider-call",
      callId: "tag-1",
      orgId: "org-a",
      at: 1000,
      inputSize: 12,
      maxOutputTokens: 200,
    })
    assert.deepEqual(JSON.parse(usageLines[0] as string), {
      type: "ai-usage",
      callId: "tag-1",
      orgId: "org-a",
      userId: "@a:tenant.example.invalid",
      roomId: "!r:tenant.example.invalid",
      at: 1001,
      inputSize: 12,
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    })
  })
})

test("저장 줄에 비밀값·대화 본문이 남지 않는다", async () => {
  await withStore(async (dir) => {
    const store = createAiFileStore(dir)
    const apiKey = "canary-SECRET-ax104-store-do-not-log"
    const body = "이 문장은 저장 줄에 남으면 안 되는 대화 본문이다"
    // 호출부가 실수로 여분을 실어도 아는 칸만 골라 담는다.
    await store.appendCall({
      callId: "tag-2",
      orgId: "org-a",
      at: 2000,
      inputSize: 9,
      maxOutputTokens: 200,
      apiKey,
      input: body,
    } as never)
    await store.appendUsage({
      callId: "tag-2",
      orgId: "org-a",
      at: 2001,
      inputSize: 9,
      usage: { inputTokens: 9, outputTokens: 8, totalTokens: 17 },
      text: body,
      token: apiKey,
    } as never)
    const dumped = `${await readFile(store.callFile, "utf8")}\n${await readFile(store.usageFile, "utf8")}`
    assert.doesNotMatch(dumped, /canary-SECRET/)
    assert.ok(!dumped.includes(body))
    // 형부터 본문 칸이 없어 남길 수 없다.
    for (const line of dumped.split("\n").map((part) => part.trim()).filter(Boolean)) {
      const parsed = JSON.parse(line) as Record<string, unknown>
      assert.ok(!("input" in parsed) && !("text" in parsed) && !("body" in parsed) && !("apiKey" in parsed))
    }
  })
})

test("저장 폴더가 없으면 분명한 오류다", () => {
  assert.throws(() => createAiFileStore("  "), /저장 폴더/)
})

test("호출 기록과 결과 기록이 같은 callId로 1:1로 쌓인다", async () => {
  await withStore(async (dir) => {
    const store = createAiFileStore(dir)
    const plans = [
      { callId: "tag-ok", status: "success", usage: { inputTokens: 9, outputTokens: 8, totalTokens: 17 } },
      { callId: "tag-missing", status: "usage-missing", usage: { inputTokens: 9 } },
      { callId: "tag-overflow", status: "output-overflow", usage: { inputTokens: 4, outputTokens: 205 } },
      { callId: "tag-store-fail", status: "usage-store-failed", usage: { inputTokens: 9, outputTokens: 8 } },
      { callId: "tag-provider-fail", status: "provider-failed", usage: undefined },
    ] as const
    for (const plan of plans) {
      await store.appendCall({
        callId: plan.callId,
        orgId: "org-a",
        at: 1000,
        inputSize: 9,
        maxOutputTokens: 200,
        provider: "fake",
      })
      await store.appendCallResult({
        callId: plan.callId,
        orgId: "org-a",
        at: 1001,
        status: plan.status,
        provider: "fake",
        usage: plan.usage,
      } as never)
    }
    const lines = (await readFile(store.callFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    const calls = lines.filter((row) => row.type === "provider-call")
    const results = lines.filter((row) => row.type === "provider-call-result")
    // 호출 기록 수 = 결과 기록 수.
    assert.equal(calls.length, plans.length)
    assert.equal(results.length, plans.length)
    for (const plan of plans) {
      const result = results.find((row) => row.callId === plan.callId)
      assert.ok(result)
      assert.equal(result.status, plan.status)
      assert.equal(result.orgId, "org-a")
      assert.equal(result.provider, "fake")
    }
    const dumped = lines.map((row) => JSON.stringify(row)).join("\n")
    assert.ok(!dumped.includes("본문"))
  })
})

test("결과 줄에도 비밀값·대화 본문이 남지 않고 상태 없으면 막힌다", async () => {
  await withStore(async (dir) => {
    const store = createAiFileStore(dir)
    await store.appendCallResult({
      callId: "tag-secret",
      orgId: "org-a",
      at: 1000,
      status: "success",
      provider: "fake",
      usage: { inputTokens: 9, outputTokens: 8 },
      apiKey: "canary-SECRET-ax104-result-do-not-log",
      input: "이 문장은 결과 줄에 남으면 안 되는 대화 본문이다",
    } as never)
    const dumped = await readFile(store.callFile, "utf8")
    assert.doesNotMatch(dumped, /canary-SECRET/)
    assert.ok(!dumped.includes("남으면 안 되는 대화 본문"))
    await assert.rejects(store.appendCallResult({ callId: "tag-x", orgId: "org-a", at: 1, status: " " } as never))
  })
})

test("예비 파일에 같은 결과 줄을 한 번 더 쓰고 비밀값·본문을 남기지 않는다", async () => {
  await withStore(async (dir) => {
    const store = createAiFileStore(dir)
    await store.appendCallResultFallback({
      callId: "tag-fb-1",
      orgId: "org-a",
      at: 1000,
      status: "success",
      provider: "fake",
      usage: { inputTokens: 9, outputTokens: 8 },
      apiKey: "canary-SECRET-ax104-fallback-do-not-log",
      input: "이 문장은 예비 줄에 남으면 안 되는 대화 본문이다",
    } as never)
    const dumped = await readFile(store.fallbackFile, "utf8")
    assert.deepEqual(JSON.parse(dumped.trim()), {
      type: "provider-call-result",
      callId: "tag-fb-1",
      orgId: "org-a",
      at: 1000,
      status: "success",
      provider: "fake",
      usage: { inputTokens: 9, outputTokens: 8 },
    })
    assert.doesNotMatch(dumped, /canary-SECRET/)
    assert.ok(!dumped.includes("예비 줄에 남으면 안 되는 대화 본문"))
    assert.equal((await stat(store.fallbackFile)).mode & 0o777, 0o600)
  })
})

test("재시작 때 호출·결과 기록을 맞춰 결과 짝 없는 호출을 집계한다", async () => {
  await withStore(async (dir) => {
    const store = createAiFileStore(dir)
    // 파일이 아직 없으면 0건이며 시작 오류가 아니다.
    assert.deepEqual(await store.summarizeResultCoverage(), { providerCalls: 0, providerResults: 0, resultMissing: 0 })
    await store.appendCall({ callId: "tag-cov-1", orgId: "org-a", at: 1000, inputSize: 9, maxOutputTokens: 200, provider: "fake" })
    await store.appendCall({ callId: "tag-cov-2", orgId: "org-a", at: 1001, inputSize: 9, maxOutputTokens: 200, provider: "fake" })
    await store.appendCallResult({ callId: "tag-cov-1", orgId: "org-a", at: 1002, status: "success", provider: "fake" })
    // 결과 짝 없는 호출이 있어도 집계 수가 보인다.
    assert.deepEqual(await store.summarizeResultCoverage(), { providerCalls: 2, providerResults: 1, resultMissing: 1 })
    // 짝이 예비 파일에 있어도 맞춰진다.
    await store.appendCallResultFallback({ callId: "tag-cov-2", orgId: "org-a", at: 1003, status: "success", provider: "fake" })
    assert.deepEqual(await store.summarizeResultCoverage(), { providerCalls: 2, providerResults: 2, resultMissing: 0 })
  })
})

test("깨진 줄은 건너뛰고 집계를 막지 않는다", async () => {
  await withStore(async (dir) => {
    const store = createAiFileStore(dir)
    await store.appendCall({ callId: "tag-cov-9", orgId: "org-a", at: 1000, inputSize: 9, maxOutputTokens: 200, provider: "fake" })
    const { appendFile } = await import("node:fs/promises")
    await appendFile(store.callFile, "깨진 줄\n", { encoding: "utf8" })
    assert.deepEqual(await store.summarizeResultCoverage(), { providerCalls: 1, providerResults: 0, resultMissing: 1 })
  })
})

test("호출·사용량 줄에 제공자 표지와 초과 표시가 남는다", async () => {
  await withStore(async (dir) => {
    const store = createAiFileStore(dir)
    await store.appendCall({ callId: "tag-3", orgId: "org-a", at: 3000, inputSize: 9, maxOutputTokens: 200, provider: "fake" })
    await store.appendUsage({
      callId: "tag-3",
      orgId: "org-a",
      at: 3001,
      inputSize: 9,
      usage: { inputTokens: 9, outputTokens: 205, totalTokens: 214 },
      provider: "fake",
      outputOverflow: true,
    })
    const callRow = JSON.parse((await readFile(store.callFile, "utf8")).trim()) as Record<string, unknown>
    const usageRow = JSON.parse((await readFile(store.usageFile, "utf8")).trim()) as Record<string, unknown>
    assert.equal(callRow["provider"], "fake")
    assert.equal(usageRow["provider"], "fake")
    assert.equal(usageRow["outputOverflow"], true)
  })
})

test("호출·결과 줄에 eventId가 남고 비밀값·본문은 남지 않는다", async () => {
  await withStore(async (dir) => {
    const store = createAiFileStore(dir)
    await store.appendCall({
      callId: "tag-ev-secret",
      orgId: "org-a",
      at: 1000,
      inputSize: 9,
      maxOutputTokens: 200,
      provider: "fake",
      eventId: "$event-1",
      apiKey: "canary-SECRET-ax104-ev-do-not-log",
      input: "이 문장은 호출 줄에 남으면 안 되는 대화 본문이다",
    } as never)
    await store.appendCallResult({
      callId: "tag-ev-secret",
      orgId: "org-a",
      at: 1001,
      status: "success",
      provider: "fake",
      eventId: "$event-1",
      input: "이 문장은 결과 줄에 남으면 안 되는 대화 본문이다",
    } as never)
    await store.appendCallResultFallback({
      callId: "tag-ev-fb",
      orgId: "org-a",
      at: 1002,
      status: "success",
      provider: "fake",
      eventId: "$event-2",
    } as never)
    const dumped = `${await readFile(store.callFile, "utf8")}\n${await readFile(store.fallbackFile, "utf8")}`
    assert.ok(dumped.includes("$event-1"))
    assert.ok(dumped.includes("$event-2"))
    assert.doesNotMatch(dumped, /canary-SECRET/)
    assert.ok(!dumped.includes("남으면 안 되는 대화 본문"))
  })
})

test("옛 줄 넘기기용 목록에 호출 줄만 남는다", async () => {
  await withStore(async (dir) => {
    const store = createAiFileStore(dir)
    await store.appendCall({ callId: "tag-list-1", orgId: "org-a", at: 1000, inputSize: 9, maxOutputTokens: 200, provider: "fake", eventId: "$e1" })
    await store.appendCallResult({ callId: "tag-list-1", orgId: "org-a", at: 1001, status: "success", provider: "fake" })
    const listed = await store.listProviderCalls()
    assert.deepEqual(listed, [{ callId: "tag-list-1", orgId: "org-a", at: 1000, eventId: "$e1" }])
  })
})
