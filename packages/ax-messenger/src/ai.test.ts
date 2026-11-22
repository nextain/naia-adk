import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import {
  AX_AI_FALLBACK_MESSAGE,
  AX_AI_GREETING,
  AX_AI_INPUT_TOO_LONG_MESSAGE,
  AX_AI_RATE_LIMIT_MESSAGE,
  countInputChars,
  createAiService,
  createFakeAiProvider,
  loadAxAiConfig,
} from "./ai.js"
import { createUsageCollector } from "./admin.js"
import { openAiLedger } from "./ai-ledger.js"
import { AxMessengerError } from "./errors.js"

const LIMITS = {
  rateLimitMaxCalls: 2,
  rateLimitWindowMs: 60_000,
  maxInputSize: 50,
  maxOutputTokens: 200,
}

function serviceWithFake(overrides?: Partial<typeof LIMITS>, now?: () => number) {
  const fake = createFakeAiProvider()
  const service = createAiService({ ...LIMITS, ...overrides }, { provider: fake, now })
  return { fake, service }
}

test("첫 인사와 거부 안내 문구를 유지한다", () => {
  assert.equal(
    AX_AI_GREETING,
    "안녕하세요, 넥스테인 AI입니다. 이 방에서 기관 AX 서버 처음 설정을 함께 진행합니다. 궁금한 점은 이 방에 편하게 남겨 주세요.",
  )
  assert.equal(AX_AI_RATE_LIMIT_MESSAGE, "지금은 요청이 많아 답을 드리기 어렵습니다. 잠시 뒤 다시 남겨 주세요.")
  assert.equal(AX_AI_INPUT_TOO_LONG_MESSAGE, "질문이 길어 한 번에 답을 드리기 어렵습니다. 나누어 남겨 주세요.")
})

// 빈도 합산 거부: 서로 다른 두 계정·방 호출이 합쳐진다.
test("서로 다른 두 계정·방 호출 합이 상한에 닿으면 다음 호출이 거부된다", async () => {
  const { fake, service } = serviceWithFake()
  await service.answer({ orgId: "org-a", userId: "@a:tenant.example.invalid", roomId: "!r1:tenant.example.invalid", input: "첫 질문" })
  await service.answer({ orgId: "org-b", userId: "@b:tenant.example.invalid", roomId: "!r2:tenant.example.invalid", input: "둘째 질문" })
  // 각 호출 수는 상한(2)보다 작지만 합이 상한에 닿은 뒤의 다음 호출은 거부된다.
  const error = await service
    .answer({ orgId: "org-a", userId: "@a:tenant.example.invalid", roomId: "!r1:tenant.example.invalid", input: "셋째 질문" })
    .then(() => { throw new Error("거부되어야 한다") }, (failure: unknown) => failure)
  assert.ok(error instanceof AxMessengerError)
  assert.equal(error.kind, "rate-limited")
  assert.equal(error.userMessage, AX_AI_RATE_LIMIT_MESSAGE)
  assert.equal(fake.requests.length, 2)
  assert.equal(service.providerCalls.length, 2)
  // 거부된 호출은 사용량에 쌓이지 않는다.
  assert.equal(service.usage.entries.length, 2)
})

// 양 초과: 제공자 미호출·호출 기록 0건·사용량 0건.
test("입력 상한 초과는 제공자를 부르지 않고 호출 기록·사용량이 0건이다", async () => {
  const { fake, service } = serviceWithFake()
  const seen: unknown[] = []
  const strict = createAiService(LIMITS, {
    provider: fake,
    onProviderCall: (record) => { seen.push(record) },
  })
  const longInput = "가".repeat(LIMITS.maxInputSize + 1)
  const error = await strict
    .answer({ orgId: "org-a", callId: "tag-overflow-1", input: longInput })
    .then(() => { throw new Error("거부되어야 한다") }, (failure: unknown) => failure)
  assert.ok(error instanceof AxMessengerError)
  assert.equal(error.kind, "too-large")
  assert.equal(error.userMessage, AX_AI_INPUT_TOO_LONG_MESSAGE)
  assert.equal(fake.requests.length, 0)
  assert.equal(strict.providerCalls.length, 0)
  assert.equal(seen.length, 0)
  assert.equal(strict.usage.entries.filter((entry) => entry.kind === "ai-call").length, 0)
  void service
})

// 양 검사가 빈도 검사보다 먼저다. 상한 초과 입력은 예산을 쓰지 않는다.
test("빈도가 다 찼을 때도 상한 초과 입력은 양 문구로 거부된다", async () => {
  const { service } = serviceWithFake({ rateLimitMaxCalls: 1 })
  await service.answer({ orgId: "org-a", input: "짧은 질문" })
  const error = await service
    .answer({ orgId: "org-a", callId: "tag-overflow-2", input: "나".repeat(LIMITS.maxInputSize + 1) })
    .then(() => { throw new Error("거부되어야 한다") }, (failure: unknown) => failure)
  assert.ok(error instanceof AxMessengerError)
  assert.equal(error.kind, "too-large")
  assert.equal(error.userMessage, AX_AI_INPUT_TOO_LONG_MESSAGE)
})

// 요청마다 출력 양 상한을 실어 보낸다.
test("제공자 요청에 출력 양 상한이 실린다", async () => {
  const { fake, service } = serviceWithFake()
  await service.answer({ orgId: "org-a", input: "짧은 질문" })
  assert.equal(fake.requests.length, 1)
  assert.equal(fake.requests[0]?.maxOutputTokens, LIMITS.maxOutputTokens)
})

// 정상 호출의 응답 출력 사용량은 출력 상한 이하다.
test("가짜 제공자의 출력 사용량은 출력 상한 이하다", async () => {
  const { service } = serviceWithFake()
  const answer = await service.answer({ orgId: "org-a", input: "짧은 질문" })
  assert.ok((answer.usage.outputTokens ?? 0) <= LIMITS.maxOutputTokens)
})

// 한도 값 없음·잘못된 값은 시작 때 분명한 오류다.
test("한도 값 없으면 서비스 시작 때 분명한 오류가 난다", () => {
  assert.throws(
    () => createAiService({}),
    (error: unknown) => {
      assert.ok(error instanceof AxMessengerError)
      assert.match(error.userMessage, /AI 호출 한도 설정/)
      assert.match(error.userMessage, /rateLimitMaxCalls/)
      return true
    },
  )
  assert.throws(
    () => createAiService({ ...LIMITS, maxInputSize: 0 }),
    (error: unknown) => error instanceof AxMessengerError && /잘못된 값/.test(error.userMessage),
  )
  assert.throws(
    () => loadAxAiConfig({}),
    (error: unknown) => {
      assert.ok(error instanceof AxMessengerError)
      assert.match(error.userMessage, /AX_AI_RATE_LIMIT_MAX_CALLS/)
      assert.match(error.userMessage, /AX_AI_MAX_INPUT_SIZE/)
      return true
    },
  )
  assert.throws(
    () => loadAxAiConfig({ AX_AI_PROVIDER: "fake", AX_AI_TEST_MODE: "1", AX_AI_RATE_LIMIT_MAX_CALLS: "많이" }),
    (error: unknown) => error instanceof AxMessengerError && /잘못된 값/.test(error.userMessage),
  )
})

test("환경 변수에서 한도를 읽고 기본값을 지어내지 않는다", () => {
  const config = loadAxAiConfig({
    AX_AI_PROVIDER: "fake",
    AX_AI_TEST_MODE: "1",
    AX_AI_RATE_LIMIT_MAX_CALLS: "10",
    AX_AI_RATE_LIMIT_WINDOW_MS: "60000",
    AX_AI_MAX_INPUT_SIZE: "500",
    AX_AI_MAX_OUTPUT_TOKENS: "300",
  })
  assert.equal(config.provider, "fake")
  assert.equal(config.rateLimitMaxCalls, 10)
  assert.equal(config.maxInputSize, 500)
  assert.equal(config.maxOutputTokens, 300)
  assert.equal(config.testMode, true)
})

// 가짜 제공자는 시험 표시 없이 시작할 수 없다.
test("가짜 제공자는 시험 표시가 없으면 시작 오류다", () => {
  const base = {
    AX_AI_PROVIDER: "fake",
    AX_AI_RATE_LIMIT_MAX_CALLS: "10",
    AX_AI_RATE_LIMIT_WINDOW_MS: "60000",
    AX_AI_MAX_INPUT_SIZE: "500",
    AX_AI_MAX_OUTPUT_TOKENS: "300",
  }
  assert.throws(
    () => loadAxAiConfig(base),
    (error: unknown) => error instanceof AxMessengerError && /AX_AI_TEST_MODE/.test(error.userMessage),
  )
  const config = loadAxAiConfig({ ...base, AX_AI_TEST_MODE: "1" })
  assert.equal(config.provider, "fake")
})

// 실제 제공자(OpenAI 호환)는 주소·모델·열쇠가 모두 있어야 한다.
test("실제 제공자는 주소·모델·열쇠가 없으면 시작 오류다", () => {
  const base = {
    AX_AI_PROVIDER: "openai-compatible",
    AX_AI_RATE_LIMIT_MAX_CALLS: "10",
    AX_AI_RATE_LIMIT_WINDOW_MS: "60000",
    AX_AI_MAX_INPUT_SIZE: "500",
    AX_AI_MAX_OUTPUT_TOKENS: "300",
  }
  assert.throws(() => loadAxAiConfig(base), /AX_AI_PROVIDER_URL/)
  assert.throws(
    () => loadAxAiConfig({ ...base, AX_AI_PROVIDER_URL: "https://api.example.com/v1" }),
    /AX_AI_MODEL/,
  )
  assert.throws(
    () => loadAxAiConfig({
      ...base,
      AX_AI_PROVIDER_URL: "https://api.example.com/v1",
      AX_AI_MODEL: "test-model",
    }),
    /AX_AI_API_KEY/,
  )
  const config = loadAxAiConfig({
    ...base,
    AX_AI_PROVIDER_URL: "https://api.example.com/v1",
    AX_AI_MODEL: "test-model",
    AX_AI_API_KEY: "test-key",
    AX_AI_TIMEOUT_MS: "5000",
  })
  assert.equal(config.provider, "openai-compatible")
  assert.equal(config.model, "test-model")
  assert.equal(config.timeoutMs, 5000)
  assert.throws(
    () => loadAxAiConfig({ ...base, AX_AI_PROVIDER: "알 수 없음", AX_AI_TEST_MODE: "1" }),
    /AX_AI_PROVIDER/,
  )
})

// 기관별 사용량 합이 응답 사용량 합과 같다.
test("기관별 기록의 호출 수와 모델 사용량 합이 응답 합과 같다", async () => {
  const usage = createUsageCollector()
  const strict = createAiService({ ...LIMITS, rateLimitMaxCalls: 10 }, { provider: createFakeAiProvider(), usage })
  const answersA = [
    await strict.answer({ orgId: "org-a", input: "첫 질문" }),
    await strict.answer({ orgId: "org-a", input: "둘째 질문" }),
    await strict.answer({ orgId: "org-a", input: "셋째 질문" }),
  ]
  const answersB = [await strict.answer({ orgId: "org-b", input: "다른 기관 질문" })]
  const sum = (values: (number | undefined)[]) => values.reduce<number>((total, value) => total + (value ?? 0), 0)
  for (const [orgId, answers] of [["org-a", answersA], ["org-b", answersB]] as const) {
    const rows = usage.entries.filter((entry) => entry.kind === "ai-call" && entry.orgId === orgId)
    assert.equal(rows.length, answers.length)
    assert.equal(sum(rows.map((row) => row.usage?.inputTokens)), sum(answers.map((answer) => answer.usage.inputTokens)))
    assert.equal(sum(rows.map((row) => row.usage?.outputTokens)), sum(answers.map((answer) => answer.usage.outputTokens)))
  }
})

// 기록에 비밀값·본문 없음.
test("호출 기록·사용량 기록에 열쇠·대화 본문이 남지 않는다", async () => {
  const apiKey = randomUUID()
  const body = "이 문장은 기록에 남으면 안 되는 대화 본문이다"
  const usage = createUsageCollector()
  const strict = createAiService(
    { ...LIMITS, provider: "fake", apiKey },
    { provider: createFakeAiProvider(), usage },
  )
  await strict.answer({ orgId: "org-a", input: body })
  const dumped = JSON.stringify({ calls: strict.providerCalls, entries: usage.entries })
  assert.ok(!dumped.includes(apiKey))
  assert.ok(!dumped.includes(body))
})

// 입력량 계산기를 갈아 끼울 수 있다.
test("입력량 계산기를 갈아 끼우면 그 값으로 상한을 잰다", async () => {
  const { service } = serviceWithFake()
  const tokenCounter = createAiService(LIMITS, {
    provider: createFakeAiProvider(),
    countInputSize: () => LIMITS.maxInputSize + 1,
  })
  await service.answer({ orgId: "org-a", input: "짧다" })
  await assert.rejects(
    tokenCounter.answer({ orgId: "org-a", input: "짧다" }),
    (error: unknown) => error instanceof AxMessengerError && error.kind === "too-large",
  )
  assert.equal(countInputChars("가나다"), 3)
})

// 호출 기록 저장이 실패하면 제공자를 부르지 않고 거부한다.
test("호출 기록 저장 실패 때는 제공자 호출이 0건이다", async () => {
  const fake = createFakeAiProvider()
  const service = createAiService(LIMITS, {
    provider: fake,
    onProviderCall: () => { throw new Error("디스크 쓰기 실패(시험)") },
  })
  const error = await service
    .answer({ orgId: "org-a", callId: "tag-store-fail-1", input: "짧은 질문" })
    .then(() => { throw new Error("거부되어야 한다") }, (failure: unknown) => failure)
  assert.ok(error instanceof AxMessengerError)
  assert.equal(error.kind, "server")
  assert.equal(fake.requests.length, 0)
  assert.equal(service.providerCalls.length, 0)
  assert.equal(service.usage.entries.filter((entry) => entry.kind === "ai-call").length, 0)
})

// 응답 출력이 상한을 넘으면 실패로 처리하되 사용량은 초과 표시와 함께 남긴다.
test("출력 상한 초과는 실패 처리되고 사용량에는 초과 표시가 남는다", async () => {
  const overflowing = {
    id: "stub-overflow",
    async complete() {
      return { text: "넘친 답", usage: { inputTokens: 4, outputTokens: LIMITS.maxOutputTokens + 5 } }
    },
  }
  const seen: unknown[] = []
  const strict = createAiService(LIMITS, {
    provider: overflowing,
    onUsage: (record) => { seen.push(record) },
  })
  const error = await strict
    .answer({ orgId: "org-a", callId: "tag-overflow-3", userId: "@a:tenant.example.invalid", input: "짧은 질문" })
    .then(() => { throw new Error("거부되어야 한다") }, (failure: unknown) => failure)
  assert.ok(error instanceof AxMessengerError)
  assert.equal(error.kind, "server")
  // 내부 대체 문구로 답하며 제공자 답은 내지 않는다.
  assert.equal(error.userMessage, AX_AI_FALLBACK_MESSAGE)
  // 이미 쓴 양이므로 사용량은 그대로 남되 초과 표시가 있다.
  assert.equal(strict.usage.entries.length, 1)
  const entry = strict.usage.entries[0]
  assert.ok(entry)
  assert.equal(entry?.outputOverflow, true)
  assert.equal(entry?.provider, "stub-overflow")
  assert.equal(seen.length, 1)
  assert.equal((seen[0] as { outputOverflow?: boolean }).outputOverflow, true)
})

// 같은 기관의 서로 다른 두 계정 호출이 한 기관으로 합쳐진다.
test("같은 기관 두 계정의 사용량이 한 기관으로 합쳐진다", async () => {
  const usage = createUsageCollector()
  const strict = createAiService({ ...LIMITS, rateLimitMaxCalls: 10 }, {
    provider: createFakeAiProvider(),
    usage,
  })
  await strict.answer({ orgId: "org-shared", userId: "@a:tenant.example.invalid", roomId: "!r:tenant.example.invalid", input: "첫 질문" })
  await strict.answer({ orgId: "org-shared", userId: "@b:tenant.example.invalid", roomId: "!r:tenant.example.invalid", input: "둘째 질문" })
  const rows = usage.entries.filter((entry) => entry.kind === "ai-call" && entry.orgId === "org-shared")
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((row) => row.userId).sort(), ["@a:tenant.example.invalid", "@b:tenant.example.invalid"])
  assert.ok(rows.every((row) => row.provider === "fake"))
  assert.ok(strict.providerCalls.every((call) => call.provider === "fake"))
})

// 사용량 저장 실패 때도 답을 내지 않고 거부한다.
test("사용량 저장 실패 때는 답을 내지 않는다", async () => {
  const strict = createAiService(LIMITS, {
    provider: createFakeAiProvider(),
    onUsage: () => { throw new Error("디스크 쓰기 실패(시험)") },
  })
  const error = await strict
    .answer({ orgId: "org-a", callId: "tag-usage-fail-1", input: "짧은 질문" })
    .then(() => { throw new Error("거부되어야 한다") }, (failure: unknown) => failure)
  assert.ok(error instanceof AxMessengerError)
  assert.equal(error.kind, "server")
})

// 사용량이 빠지거나 잘못되면 답을 내지 않고 "사용량 누락"으로 실패한다.
test("사용량 누락 응답은 답을 내지 않고 실패로 처리된다", async () => {
  const badUsages = [
    { inputTokens: 4 },
    { inputTokens: 4, outputTokens: -1 },
    { inputTokens: 4, outputTokens: 7.5 },
    { inputTokens: 4, outputTokens: "8" },
    { outputTokens: 8 },
    { inputTokens: -2, outputTokens: 8 },
  ]
  for (const [index, usage] of badUsages.entries()) {
    const stub = {
      id: "stub-missing",
      async complete() {
        return { text: "빠진 답", usage: usage as never }
      },
    }
    const service = createAiService(LIMITS, { provider: stub as never })
    const error = await service
      .answer({ orgId: "org-a", callId: `tag-missing-${index}`, input: "짧은 질문" })
      .then(() => { throw new Error("거부되어야 한다") }, (failure: unknown) => failure)
    assert.ok(error instanceof AxMessengerError)
    assert.equal(error.kind, "server")
    assert.equal(error.userMessage, AX_AI_FALLBACK_MESSAGE)
    // 제공자는 불렸으므로 호출 1건·결과 1건(사용량 누락)이 짝지어진다.
    assert.equal(service.providerCalls.length, 1)
    assert.equal(service.providerResults.length, 1)
    assert.equal(service.providerResults[0]?.status, "usage-missing")
    // 유효한 사용량이 아니므로 사용량 기록에는 쌓이지 않는다.
    assert.equal(service.usage.entries.filter((entry) => entry.kind === "ai-call").length, 0)
  }
})

// 0은 유효한 사용량이다.
test("사용량이 0이면 정상 답으로 돌려준다", async () => {
  const stub = {
    id: "stub-zero",
    async complete() {
      return { text: "빈 듯 답", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
    },
  }
  const service = createAiService(LIMITS, { provider: stub as never })
  const answer = await service.answer({ orgId: "org-a", callId: "tag-zero", input: "짧은 질문" })
  assert.equal(answer.text, "빈 듯 답")
  assert.deepEqual(answer.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 })
  assert.equal(service.providerResults[0]?.status, "success")
})

// 제공자 실패·사용량 저장 실패도 결과 기록에 남고 호출과 1:1로 짝지어진다.
test("호출 기록 수와 결과 기록 수가 1:1로 짝지어진다", async () => {
  const failing = {
    id: "stub-fail",
    async complete(): Promise<never> {
      throw new Error("제공자 고장(시험)")
    },
  }
  const broken = createAiService(LIMITS, { provider: failing as never })
  await assert.rejects(broken.answer({ orgId: "org-a", callId: "tag-fail", input: "짧은 질문" }))
  assert.equal(broken.providerCalls.length, 1)
  assert.deepEqual(broken.providerResults.map((result) => result.status), ["provider-failed"])

  const results: string[] = []
  const strict = createAiService(LIMITS, {
    provider: createFakeAiProvider(),
    onUsage: () => { throw new Error("디스크 쓰기 실패(시험)") },
    onProviderResult: (record) => { results.push(`${record.callId}:${record.status}`) },
  })
  await assert.rejects(strict.answer({ orgId: "org-a", callId: "tag-store", input: "짧은 질문" }))
  assert.equal(strict.providerCalls.length, 1)
  assert.deepEqual(strict.providerResults.map((result) => result.status), ["usage-store-failed"])
  assert.deepEqual(results, ["tag-store:usage-store-failed"])

  // 결과 기록 저장이 실패해도 원래 판정은 바꾸지 않는다.
  const lenient = createAiService(LIMITS, {
    provider: createFakeAiProvider(),
    onProviderResult: () => { throw new Error("대조 기록 실패(시험)") },
  })
  const answer = await lenient.answer({ orgId: "org-a", callId: "tag-lenient", input: "짧은 질문" })
  assert.ok(answer.text.length > 0)
  assert.equal(lenient.providerCalls.length, 1)
  assert.equal(lenient.providerResults.length, 1)
  assert.equal(lenient.providerResults[0]?.status, "success")
})

// 결과 줄 저장 실패 때는 예비 경로에 같은 결과 줄을 한 번 더 쓴다.
test("결과 줄 저장 실패 때는 예비 경로에 한 번 더 쓴다", async () => {
  const fake = createFakeAiProvider()
  const fallbacks: unknown[] = []
  const service = createAiService(LIMITS, {
    provider: fake,
    onProviderResult: () => { throw new Error("본 파일 쓰기 실패(시험)") },
    onProviderResultFallback: (record) => { fallbacks.push(record) },
  })
  const answer = await service.answer({ orgId: "org-a", callId: "tag-fallback-1", input: "짧은 질문" })
  // 예비 기록이 살아 있으므로 답은 그대로 돌려준다.
  assert.ok(answer.text.length > 0)
  assert.equal(fake.requests.length, 1)
  assert.equal(service.providerCalls.length, 1)
  assert.equal(service.providerResults.length, 1)
  assert.equal(service.providerResults[0]?.status, "success")
  assert.equal(fallbacks.length, 1)
  assert.equal((fallbacks[0] as { callId?: string }).callId, "tag-fallback-1")
  assert.equal((fallbacks[0] as { status?: string }).status, "success")
})

// 원장 결과 갱신 실패 때는 감사 기록이 살아 있어도 이번 답을 내주지 않고 닫힘으로 간다.
// 원장이 정본이므로 원장에 없는 결과는 성공으로 치지 않는다.
test("원장 결과 갱신 실패 때는 이번 답을 내주지 않고 이후 호출을 멈춘다", async () => {
  const fake = createFakeAiProvider()
  const real = openAiLedger(":memory:", { rateLimitMaxCalls: 10, rateLimitWindowMs: 60_000 })
  try {
    const broken = {
      ...real,
      updateResult: () => { throw new Error("원장 갱신 고장(시험)") },
    }
    const results: unknown[] = []
    const service = createAiService(LIMITS, {
      provider: fake,
      ledger: broken,
      onProviderResult: (record) => { results.push(record) },
    })
    const first = await service
      .answer({ orgId: "org-a", callId: "tag-ledger-result-1", input: "짧은 질문" })
      .then(() => { throw new Error("거부되어야 한다") }, (failure: unknown) => failure)
    assert.ok(first instanceof AxMessengerError)
    assert.equal(first.kind, "server")
    // 사용자 답에는 내부 사정 없이 짧은 대체 문구만 둔다.
    assert.equal(first.userMessage, AX_AI_FALLBACK_MESSAGE)
    // 제공자는 첫 호출에 한 번 닿았지만 이번 답은 내주지 않았다.
    assert.equal(fake.requests.length, 1)
    // 감사 기록에는 남기되(최선 노력), 닫힘 뒤의 호출은 제공자에 닿지 않는다.
    assert.equal(results.length, 1)
    const second = await service
      .answer({ orgId: "org-a", callId: "tag-ledger-result-2", input: "짧은 질문" })
      .then(() => { throw new Error("거부되어야 한다") }, (failure: unknown) => failure)
    assert.ok(second instanceof AxMessengerError)
    assert.equal(second.kind, "server")
    assert.equal(second.userMessage, AX_AI_FALLBACK_MESSAGE)
    assert.equal(fake.requests.length, 1)
  } finally {
    real.close()
  }
})

// 예비 쓰기까지 실패하면 그 답은 돌려주지 않고 이후 모든 제공자 호출을 멈춘다.
test("예비 쓰기까지 실패하면 답을 내지 않고 이후 호출을 멈춘다", async () => {
  const fake = createFakeAiProvider()
  const service = createAiService(LIMITS, {
    provider: fake,
    onProviderResult: () => { throw new Error("본 파일 쓰기 실패(시험)") },
    onProviderResultFallback: () => { throw new Error("예비 파일 쓰기 실패(시험)") },
  })
  const first = await service
    .answer({ orgId: "org-a", callId: "tag-closed-1", input: "짧은 질문" })
    .then(() => { throw new Error("거부되어야 한다") }, (failure: unknown) => failure)
  assert.ok(first instanceof AxMessengerError)
  assert.equal(first.kind, "server")
  // 사용자 답에는 내부 사정 없이 짧은 대체 문구만 둔다.
  assert.equal(first.userMessage, AX_AI_FALLBACK_MESSAGE)
  // 제공자는 첫 호출에 한 번 닿았다.
  assert.equal(fake.requests.length, 1)
  // 닫힘 뒤의 호출은 제공자에 닿지 않고 거부된다.
  const second = await service
    .answer({ orgId: "org-a", callId: "tag-closed-2", input: "짧은 질문" })
    .then(() => { throw new Error("거부되어야 한다") }, (failure: unknown) => failure)
  assert.ok(second instanceof AxMessengerError)
  assert.equal(second.kind, "server")
  assert.equal(second.userMessage, AX_AI_FALLBACK_MESSAGE)
  assert.equal(fake.requests.length, 1)
  assert.equal(service.providerCalls.length, 1)
})

// ai-call 기록은 기관 표지가 필수다.
test("ai-call 기록에 기관이 없으면 막힌다", () => {
  const usage = createUsageCollector()
  assert.throws(
    () => usage.record({ kind: "ai-call", inputSize: 3 }),
    (error: unknown) => error instanceof AxMessengerError && error.kind === "invalid-input",
  )
  const entry = usage.record({ kind: "ai-call", orgId: "org-a", inputSize: 3, usage: { outputTokens: 8 } })
  assert.equal(entry.orgId, "org-a")
})
