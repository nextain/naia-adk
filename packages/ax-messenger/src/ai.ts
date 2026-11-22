// AI 호출 길. 뒤쪽 서버 전용이며 패키지 공개 출입구가 아니다.
// 화면 묶음은 가져가지 않고, 뒤쪽 서버 코드만 상대 경로(dist/ai.js)로 쓴다.
// FE-ax1-02-09·FE-ax1-04-03·FE-ax1-04-04. RQ-10·RQ-15, QC-07 대조용.
//
// 규칙(D105 66·67번): 서버 전체 안전 한도는 빈도 한도(단위 시간당 호출 수,
// 서버 전체 합산)와 양 한도(입력 양 상한·요청마다 싣는 출력 양 상한) 둘뿐이다.
// 입력이 상한을 넘으면 제공자를 부르지 않고 거부한다. 거부된 호출은 제공자를
// 부르는 지점의 호출 기록에 남지 않는다.
//
// 한도·중복 판단은 데이터 폴더의 공유 원장(ai-ledger.sqlite)만 본다.
// 봇이 몇 개 떠 있든, 몇 번 재시작하든 원장의 한 거래 안에서 확인과 기록을
// 함께 하므로 한도를 넘지 못하고 같은 org·event는 한 번만 부른다.
import { randomBytes } from "node:crypto"
import { AxMessengerError, invalidInput, sanitizeForLog } from "./errors.js"
import { createUsageCollector } from "./admin.js"
import { openAiLedger } from "./ai-ledger.js"
import type { AxAiLedger, AxLedgerCallState } from "./ai-ledger.js"

// 방에 표시할 첫 인사와 거부 안내.
export const AX_AI_GREETING =
  "안녕하세요, 넥스테인 AI입니다. 이 방에서 기관 AX 서버 처음 설정을 함께 진행합니다. 궁금한 점은 이 방에 편하게 남겨 주세요."
export const AX_AI_RATE_LIMIT_MESSAGE =
  "지금은 요청이 많아 답을 드리기 어렵습니다. 잠시 뒤 다시 남겨 주세요."
export const AX_AI_INPUT_TOO_LONG_MESSAGE =
  "질문이 길어 한 번에 답을 드리기 어렵습니다. 나누어 남겨 주세요."
// 내부 오류(제공자 실패·셀 수 없는 입력) 때 방에 보일 문구.
export const AX_AI_FALLBACK_MESSAGE =
  "지금은 답을 드리기 어렵습니다. 잠시 뒤 다시 남겨 주세요."

// 모델 제공자 어댑터 모양. 어느 제공자인지는 [확인 필요]이며,
// 1단계 시험은 가짜 제공자로만 한다. 실제 제공자 호출은 금지다.
export type AxAiProviderRequest = {
  callId: string
  orgId: string
  input: string
  // 요청마다 실어 보내는 출력 양 상한(D105 67번).
  maxOutputTokens: number
}

export type AxAiProviderUsage = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export type AxAiProviderResponse = {
  text: string
  usage: AxAiProviderUsage
}

export type AxAiProvider = {
  readonly id: string
  complete(request: AxAiProviderRequest): Promise<AxAiProviderResponse>
}

// 입력 양을 세는 함수. 토큰으로 셀지 글자 수로 셀지는 02 대로 [확인 필요]이므로
// 갈아 끼울 수 있게 둔다. 기본값은 글자 수(코드 포인트)다.
export type AxInputSizeCounter = (input: string) => number

export function countInputChars(input: string): number {
  return [...input].length
}

export type AxAiLimits = {
  // 단위 시간당 호출 수. 서버 전체 합산(서로 다른 계정·방 호출이 합쳐진다).
  rateLimitMaxCalls: number
  rateLimitWindowMs: number
  // 입력 양 상한. 넘으면 제공자를 부르지 않고 거부한다.
  maxInputSize: number
  // 요청마다 싣는 출력 양 상한.
  maxOutputTokens: number
}

export type AxAiConfig = AxAiLimits & {
  // 제공자 이름·주소·모델·열쇠는 환경 변수로 받는다. 어느 제공자인지는
  // [확인 필요](FE-ax1-04-02 "부분, 제공자 결정 대기").
  provider: string
  providerUrl?: string
  model?: string
  // 기록·출력에 남기지 않는다.
  apiKey?: string
  // 제공자 요청 시간 초과. 없으면 호출기가 기본값으로 둔다.
  timeoutMs?: number
  // 가짜 제공자로 돌 때의 시험 표시. 가짜인데 표시가 없으면 시작 오류다.
  testMode?: boolean
}

const ENV_KEYS = {
  provider: "AX_AI_PROVIDER",
  providerUrl: "AX_AI_PROVIDER_URL",
  model: "AX_AI_MODEL",
  apiKey: "AX_AI_API_KEY",
  timeoutMs: "AX_AI_TIMEOUT_MS",
  testMode: "AX_AI_TEST_MODE",
  rateLimitMaxCalls: "AX_AI_RATE_LIMIT_MAX_CALLS",
  rateLimitWindowMs: "AX_AI_RATE_LIMIT_WINDOW_MS",
  maxInputSize: "AX_AI_MAX_INPUT_SIZE",
  maxOutputTokens: "AX_AI_MAX_OUTPUT_TOKENS",
} as const

// 실제 제공자는 아직 정해지지 않았다(열쇠·비용 결정). FE-ax1-04-02는
// "부분, 제공자 결정 대기"다.
export const AX_AI_PROVIDER_FAKE = "fake"
export const AX_AI_PROVIDER_OPENAI_COMPATIBLE = "openai-compatible"
export const AX_AI_PROVIDER_SESSION_RELAY = "session-relay"

function readPositiveInt(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = (env[key] ?? "").trim()
  if (!raw) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw invalidInput(`AI 호출 한도 설정을 확인해 주세요.(잘못된 값: ${key})`)
  }
  return value
}

// 한도 값은 설정으로만 받고 기본값을 지어내지 않는다. 값이 없으면 시작 때 분명한 오류.
export function loadAxAiConfig(env: NodeJS.ProcessEnv = process.env): AxAiConfig {
  const provider = (env[ENV_KEYS.provider] ?? "").trim()
  const missing: string[] = []
  if (!provider) missing.push(ENV_KEYS.provider)
  const rateLimitMaxCalls = readPositiveInt(env, ENV_KEYS.rateLimitMaxCalls)
  const rateLimitWindowMs = readPositiveInt(env, ENV_KEYS.rateLimitWindowMs)
  const maxInputSize = readPositiveInt(env, ENV_KEYS.maxInputSize)
  const maxOutputTokens = readPositiveInt(env, ENV_KEYS.maxOutputTokens)
  if (rateLimitMaxCalls === undefined) missing.push(ENV_KEYS.rateLimitMaxCalls)
  if (rateLimitWindowMs === undefined) missing.push(ENV_KEYS.rateLimitWindowMs)
  if (maxInputSize === undefined) missing.push(ENV_KEYS.maxInputSize)
  if (maxOutputTokens === undefined) missing.push(ENV_KEYS.maxOutputTokens)
  if (missing.length > 0) {
    throw invalidInput(`AI 호출 한도 설정을 확인해 주세요.(없음: ${missing.join(", ")})`)
  }
  const testMode = (env[ENV_KEYS.testMode] ?? "").trim() === "1"
  if (provider !== AX_AI_PROVIDER_FAKE && provider !== AX_AI_PROVIDER_OPENAI_COMPATIBLE && provider !== AX_AI_PROVIDER_SESSION_RELAY) {
    throw invalidInput(
      `AI 제공자 설정을 확인해 주세요.(${ENV_KEYS.provider} — fake, openai-compatible 또는 session-relay만 쓸 수 있습니다)`,
    )
  }
  if (provider === AX_AI_PROVIDER_SESSION_RELAY && (env.AX_AUTH_RELOGIN_WINDOW_MS !== undefined || env.AX_AUTH_RELOGIN_MAX_COUNT !== undefined)) {
    throw invalidInput("session-relay에서는 인증 시험 변수를 쓸 수 없습니다.")
  }
  // 가짜 제공자는 시험 전용이다. 분명한 시험 표시 없이 가짜로 시작하면 오류다.
  if (provider === AX_AI_PROVIDER_FAKE && !testMode) {
    throw invalidInput(
      `AI 제공자 설정을 확인해 주세요.(가짜 제공자는 ${ENV_KEYS.testMode}=1일 때만 쓸 수 있습니다)`,
    )
  }
  const providerUrl = (env[ENV_KEYS.providerUrl] ?? "").trim() || undefined
  const model = (env[ENV_KEYS.model] ?? "").trim() || undefined
  const timeoutRaw = (env[ENV_KEYS.timeoutMs] ?? "").trim()
  let timeoutMs: number | undefined
  if (timeoutRaw) {
    const parsed = Number(timeoutRaw)
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw invalidInput(`AI 호출 한도 설정을 확인해 주세요.(잘못된 값: ${ENV_KEYS.timeoutMs})`)
    }
    timeoutMs = parsed
  }
  if (provider === AX_AI_PROVIDER_OPENAI_COMPATIBLE) {
    const need: string[] = []
    if (!providerUrl) need.push(ENV_KEYS.providerUrl)
    if (!model) need.push(ENV_KEYS.model)
    if (!(env[ENV_KEYS.apiKey] ?? "").trim()) need.push(ENV_KEYS.apiKey)
    if (need.length > 0) {
      throw invalidInput(`AI 제공자 설정을 확인해 주세요.(없음: ${need.join(", ")})`)
    }
  }
  return {
    provider,
    providerUrl,
    model,
    apiKey: (env[ENV_KEYS.apiKey] ?? "").trim() || undefined,
    timeoutMs,
    testMode,
    rateLimitMaxCalls: rateLimitMaxCalls as number,
    rateLimitWindowMs: rateLimitWindowMs as number,
    maxInputSize: maxInputSize as number,
    maxOutputTokens: maxOutputTokens as number,
  }
}

function checkLimits(limits: Partial<AxAiLimits>): AxAiLimits {
  const missing: string[] = []
  for (const key of ["rateLimitMaxCalls", "rateLimitWindowMs", "maxInputSize", "maxOutputTokens"] as const) {
    const value = limits[key]
    if (value === undefined) missing.push(key)
    else if (!Number.isInteger(value) || (value as number) <= 0) {
      throw invalidInput(`AI 호출 한도 설정을 확인해 주세요.(잘못된 값: ${key})`)
    }
  }
  if (missing.length > 0) {
    throw invalidInput(`AI 호출 한도 설정을 확인해 주세요.(없음: ${missing.join(", ")})`)
  }
  return limits as AxAiLimits
}

// 메모리 빈도 제한기는 두지 않는다. 한도 판단은 공유 원장이 대신한다.
// (재시작·여러 프로세스에서도 이어져야 하므로 메모리에 두지 않는다.)

// 가짜 제공자. 시험 전용이며 실제 제공자를 부르지 않는다.
// 봇이 가짜로 시작하려면 AX_AI_TEST_MODE=1이 함께 있어야 한다.
export function createFakeAiProvider(options?: {
  id?: string
  text?: string
  outputTokens?: number
}): AxAiProvider & { requests: AxAiProviderRequest[] } {
  const requests: AxAiProviderRequest[] = []
  const text = options?.text ?? "넥스테인 AI 가짜 답입니다. 시험용이므로 실제 설정 안내가 아닙니다."
  const outputTokens = options?.outputTokens ?? 8
  return {
    id: options?.id ?? "fake",
    requests,
    async complete(request: AxAiProviderRequest): Promise<AxAiProviderResponse> {
      requests.push(request)
      const inputTokens = countInputChars(request.input)
      const capped = Math.min(outputTokens, request.maxOutputTokens)
      return { text, usage: { inputTokens, outputTokens: capped, totalTokens: inputTokens + capped } }
    },
  }
}

// 제공자를 부르는 지점의 호출 기록. 기관·시각·호출 표지·제공자 표지만 남기고
// 비밀값·대화 본문은 남기지 않는다. 거부된 호출은 여기에 남지 않는다(QC-07 대조용).
// 시험 표시로 돈 호출은 provider가 "fake"로 남아 1단계 판정에서 걸러 낼 수 있다.
// eventId는 Matrix 말풍선 표지(같은 질문 겹침 막기용)다. 본문·열쇠가 아니라 기록한다.
export type AxAiProviderCallRecord = {
  callId: string
  orgId: string
  at: number
  inputSize: number
  maxOutputTokens: number
  provider: string
  eventId?: string
}

// 제공자를 부른 뒤의 결과 기록. 같은 callId로 호출 기록에 덧붙인다.
// 상태는 성공·사용량 누락·출력 초과·사용량 저장 실패·제공자 실패뿐이다.
export type AxAiCallResultStatus =
  | "success"
  | "usage-missing"
  | "output-overflow"
  | "usage-store-failed"
  | "provider-failed"

export type AxAiProviderCallResult = {
  callId: string
  orgId: string
  at: number
  status: AxAiCallResultStatus
  provider: string
  // 받은 사용량 수치(있을 때만). 본문·열쇠는 담지 않는다.
  usage?: AxAiProviderUsage
  eventId?: string
}

// 제공자 응답 뒤의 사용량 기록. 출력이 상한을 넘긴 호출도 이미 쓴 양이므로
// 그대로 남기되 outputOverflow 표시를 단다.
export type AxAiUsageRecord = {
  callId: string
  orgId: string
  userId?: string
  roomId?: string
  at: number
  inputSize: number
  provider: string
  outputOverflow?: boolean
  usage: AxAiProviderUsage
}

export type AxAiUsageCollector = ReturnType<typeof createUsageCollector>

export type AxAiLedgerLike = Pick<AxAiLedger, "reserve" | "updateResult" | "close" | "summarizeCoverage">

export type AxAiServiceDeps = {
  provider?: AxAiProvider
  countInputSize?: AxInputSizeCounter
  usage?: AxAiUsageCollector
  now?: () => number
  // 공유 원장. 없으면 메모리 원장(:memory:)을 쓴다. 파일 원장을 쓰려면
  // 봇이 openAiLedger(사용 폴더)로 열어 넘긴다. 시험은 함수 주입으로
  // 가짜 원장을 넘긴다(환경 변수 우회 손잡이는 두지 않는다).
  ledger?: AxAiLedgerLike
  // 제공자를 부르기 직전에 한 번 불린다. 거부 때는 불리지 않는다.
  // 저장이 실패하면 제공자를 부르지 않고 거부한다(실패 시 닫기).
  onProviderCall?: (record: AxAiProviderCallRecord) => void | Promise<void>
  // 제공자 응답 뒤에 한 번 불린다. 성공과 출력 초과 실패 때 모두 불린다.
  // 저장이 실패하면 답을 내지 않고 거부한다(실패 시 닫기).
  onUsage?: (record: AxAiUsageRecord) => void | Promise<void>
  // 제공자를 부른 뒤 결과를 한 번씩 받는다(성공·누락·초과·저장 실패·제공자 실패).
  // 호출 기록에 같은 callId로 덧붙이는 2단 기록용이다. 저장이 실패하면 예비
  // 갈고리(아래)로 같은 결과 줄을 한 번 더 쓴다.
  onProviderResult?: (record: AxAiProviderCallResult) => void | Promise<void>
  // 결과 줄 저장 실패 때 같은 결과 줄을 한 번 더 쓰는 예비 경로다. 봇은
  // 호출 기록 옆 예비 파일(ai-provider-results-fallback.jsonl)에 잇는다.
  // 예비 쓰기까지 실패하면 그 답은 돌려주지 않고 이후 모든 제공자 호출을
  // 멈춘다(닫힘 상태, 재시작 전까지 호출 거부). 예비 갈고리가 없을 때(순수
  // 메모리 시험) 결과 저장 실패는 옛 대로 경고만 남기고 판정을 유지한다.
  onProviderResultFallback?: (record: AxAiProviderCallResult) => void | Promise<void>
}

export type AxAiAnswerOptions = {
  orgId: string
  userId?: string
  roomId?: string
  callId?: string
  // Matrix 말풍선 표지. 같은 org·event 줄이 원장에 있으면 중복으로 보고
  // 제공자를 부르지 않는다. 없으면 중복 검사를 건너뛰고 한도만 본다.
  eventId?: string
  input: string
}

export type AxAiAnswer = {
  text: string
  usage: AxAiProviderUsage
  callId: string
  inputSize: number
}

function rejectionDetail(kind: string, callId: string, orgId: string, extra: string): string {
  return sanitizeForLog(`ai ${kind} callId=${callId} orgId=${orgId} ${extra}`, 300)
}

// 사용량 수치 판정. 입력·출력 토큰은 0 이상 정수일 때만 유효하다.
// 빠졌거나, 0보다 작거나, 정수가 아니면 사용량 누락으로 처리한다.
function isValidTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

// 대조용으로 받은 수치만 골라 담는다. 본문·열쇠 자리는 형부터 받지 않는다.
// 유한한 수만 남기고, 빠진 칸은 비워 두어 무엇이 왔는지(또는 안 왔는지) 본다.
function receivedUsageNumbers(usage: AxAiProviderUsage | undefined): AxAiProviderUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined
  const out: AxAiProviderUsage = {}
  let seen = false
  for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    const value = usage[key]
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value
      seen = true
    }
  }
  return seen ? out : undefined
}

export function isDuplicateAiError(error: unknown): boolean {
  return error instanceof AxMessengerError && error.kind === "duplicate"
}

export function createAiService(config: Partial<AxAiConfig>, deps?: AxAiServiceDeps) {
  const limits = checkLimits(config)
  const provider = deps?.provider ?? createFakeAiProvider()
  const counter = deps?.countInputSize ?? countInputChars
  const usage: AxAiUsageCollector = deps?.usage ?? createUsageCollector()
  const now = deps?.now ?? Date.now
  // 공유 원장. 없으면 메모리 원장을 쓴다. 파일 원장은 봇이 열어 넘긴다.
  let ledger: AxAiLedgerLike | undefined = deps?.ledger
  let ledgerOpenError: unknown = null
  if (!ledger) {
    try {
      ledger = openAiLedger(":memory:", {
        rateLimitMaxCalls: limits.rateLimitMaxCalls,
        rateLimitWindowMs: limits.rateLimitWindowMs,
      }, { now })
    } catch (error) {
      ledgerOpenError = error
      ledger = undefined
    }
  }
  const providerCalls: AxAiProviderCallRecord[] = []
  // 제공자를 부른 뒤의 결과(성공·누락·초과·저장 실패·제공자 실패). 호출 기록과
  // 1:1로 짝지어 "호출 기록 수 = 결과 기록 수"를 대조한다.
  const providerResults: AxAiProviderCallResult[] = []
  // 닫힘 상태. 원장을 열거나 예약·갱신하다 오류가 나면 선다. 본 파일 쓰기와
  // 예비 쓰기가 둘 다 실패해도 선다. 선 뒤에는 재시작 전까지 어떤 제공자
  // 호출도 하지 않고 거부한다.
  let closed = false

  function closedError(callId: string, orgId: string): AxMessengerError {
    return new AxMessengerError({
      kind: "server",
      userMessage: AX_AI_FALLBACK_MESSAGE,
      detail: rejectionDetail("provider-result-store-closed", callId, orgId, "result-store-lost"),
    })
  }

  function duplicateError(callId: string, orgId: string, eventId: string): AxMessengerError {
    return new AxMessengerError({
      kind: "duplicate",
      userMessage: AX_AI_FALLBACK_MESSAGE,
      detail: rejectionDetail("duplicate-skipped", callId, orgId, `eventId=${eventId.slice(0, 80)}`),
    })
  }

  function ledgerStateOf(status: AxAiCallResultStatus): AxLedgerCallState {
    return status
  }

  // 원장 갱신 + 감사 기록. 원장이 한도·중복·사용량의 정본이므로 원장 갱신이
  // 실패하면 감사 기록(jsonl 본 파일·예비 파일)이 살아 있어도 성공으로 치지
  // 않는다. 이번 답은 돌려주지 않고(호출부는 닫힘 오류를 던진다) 봇은 닫힘으로
  // 들어가 다음 호출부터 제공자에 닿기 전에 거부한다.
  async function noteResult(result: AxAiProviderCallResult): Promise<"stored" | "lost"> {
    providerResults.push(result)
    try {
      if (!ledger) throw new Error("원장이 없습니다.")
      await ledger.updateResult(result.callId, ledgerStateOf(result.status), result.usage)
    } catch (error) {
      const reason = error instanceof Error ? error.message : "알 수 없는 오류"
      console.warn(rejectionDetail("provider-ledger-update-failed", result.callId, result.orgId, sanitizeForLog(reason, 120)))
      // 감사 기록은 사람이 보는 용도로 남기되(최선 노력), 원장에 없는 결과는
      // 성공으로 치지 않는다. 이번 답은 돌려주지 않고 닫힘으로 들어간다.
      try {
        await deps?.onProviderResult?.(result)
      } catch {
        try {
          await deps?.onProviderResultFallback?.(result)
        } catch {
          // 감사 기록까지 실패해도 닫힘 판정은 같다.
        }
      }
      closed = true
      return "lost"
    }
    try {
      await deps?.onProviderResult?.(result)
      return "stored"
    } catch (error) {
      const reason = error instanceof Error ? error.message : "알 수 없는 오류"
      console.warn(rejectionDetail("provider-result-store-failed", result.callId, result.orgId, sanitizeForLog(reason, 120)))
    }
    if (!deps?.onProviderResultFallback) {
      // 예비 갈고리가 없으면 감사 기록 실패만으로 닫지 않는다. 메모리 시험의
      // 관대함과 같다. 원장에는 결과가 남아 result-missing에 잡히지 않는다.
      return "stored"
    }
    try {
      await deps.onProviderResultFallback(result)
      console.warn(rejectionDetail("provider-result-store-fallback", result.callId, result.orgId, "fallback-used"))
      return "stored"
    } catch (fallbackError) {
      const reason = fallbackError instanceof Error ? fallbackError.message : "알 수 없는 오류"
      console.warn(rejectionDetail("provider-result-store-lost", result.callId, result.orgId, sanitizeForLog(reason, 120)))
      closed = true
      return "lost"
    }
  }

  async function answer(options: AxAiAnswerOptions): Promise<AxAiAnswer> {
    const orgId = (options.orgId ?? "").trim()
    if (!orgId) throw invalidInput("기관을 확인해 주세요.")
    // 닫힘 상태에서는 어떤 제공자 호출도 하지 않고 거부한다. 사용자 답에는
    // 내부 사정을 남기지 않고 짧은 대체 문구만 둔다.
    if (closed) throw closedError((options.callId ?? "").trim() || "unknown", orgId)
    if (ledgerOpenError && !ledger) {
      closed = true
      throw closedError((options.callId ?? "").trim() || "unknown", orgId)
    }
    const input = options.input ?? ""
    if (!input.trim()) throw invalidInput("질문을 입력해 주세요.")
    const callId = (options.callId ?? "").trim() || randomBytes(8).toString("hex")
    const eventId = (options.eventId ?? "").trim() || undefined
    const inputSize = counter(input)
    if (!Number.isFinite(inputSize) || inputSize < 0) {
      throw new AxMessengerError({
        kind: "server",
        userMessage: AX_AI_FALLBACK_MESSAGE,
        detail: rejectionDetail("counter", callId, orgId, "count-failed"),
      })
    }
    // 양 검사를 빈도 검사보다 먼저 한다. 상한을 넘긴 입력은 예산을 쓰지 않고,
    // 빈도가 다 찼을 때도 양 초과는 양 문구로 답한다.
    if (inputSize > limits.maxInputSize) {
      throw new AxMessengerError({
        kind: "too-large",
        userMessage: AX_AI_INPUT_TOO_LONG_MESSAGE,
        detail: rejectionDetail("input-too-long", callId, orgId, `inputSize=${inputSize} limit=${limits.maxInputSize}`),
      })
    }
    // 원자 예약: BEGIN IMMEDIATE 안에서 (가) 같은 org·event 중복 확인
    // (나) 빈도 창 안 같은 org 줄 수가 한도 이상이면 거부 (다) 아니면 예약.
    // 확인과 기록이 한 거래라 여러 프로세스가 동시에 와도 한도를 넘지 못한다.
    const at = now()
    if (!ledger) {
      closed = true
      throw closedError(callId, orgId)
    }
    let outcome: { ok: true } | { ok: false; reason: "duplicate" | "rate-limited" }
    try {
      outcome = await ledger.reserve({
        callId,
        orgId,
        eventId,
        at,
        inputSize,
        maxOutputTokens: limits.maxOutputTokens,
        provider: provider.id,
      })
    } catch (error) {
      // 원장 열기·예약 오류는 제공자에 닿지 않고 닫힘으로 들어간다.
      closed = true
      const reason = error instanceof Error ? error.message : "알 수 없는 오류"
      console.warn(rejectionDetail("provider-ledger-reserve-failed", callId, orgId, sanitizeForLog(reason, 120)))
      throw closedError(callId, orgId)
    }
    if (!outcome.ok && outcome.reason === "duplicate") {
      throw duplicateError(callId, orgId, eventId ?? "")
    }
    if (!outcome.ok) {
      throw new AxMessengerError({
        kind: "rate-limited",
        userMessage: AX_AI_RATE_LIMIT_MESSAGE,
        detail: rejectionDetail("rate-limited", callId, orgId, `max=${limits.rateLimitMaxCalls} windowMs=${limits.rateLimitWindowMs}`),
      })
    }
    // 호출 기록(사람이 보는 감사 기록)은 원장 예약 뒤에 남긴다. 저장이
    // 실패하면 제공자를 부르지 않고 거부한다. 원장 예약은 남아 한도에
    // 잡히므로(보수적), 되돌리지 않는다.
    const record: AxAiProviderCallRecord = {
      callId,
      orgId,
      at,
      inputSize,
      maxOutputTokens: limits.maxOutputTokens,
      provider: provider.id,
      ...(eventId ? { eventId } : {}),
    }
    try {
      await deps?.onProviderCall?.(record)
    } catch (error) {
      const reason = error instanceof Error ? error.message : "알 수 없는 오류"
      throw new AxMessengerError({
        kind: "server",
        userMessage: AX_AI_FALLBACK_MESSAGE,
        detail: rejectionDetail("provider-call-store-failed", callId, orgId, sanitizeForLog(reason, 120)),
      })
    }
    providerCalls.push(record)
    let response: AxAiProviderResponse
    try {
      response = await provider.complete({
        callId,
        orgId,
        input,
        maxOutputTokens: limits.maxOutputTokens,
      })
    } catch (error) {
      if ((await noteResult({ callId, orgId, at: now(), status: "provider-failed", provider: provider.id, ...(eventId ? { eventId } : {}) })) === "lost") {
        throw closedError(callId, orgId)
      }
      const reason = error instanceof Error ? error.message : "알 수 없는 오류"
      throw new AxMessengerError({
        kind: "server",
        userMessage: AX_AI_FALLBACK_MESSAGE,
        detail: rejectionDetail("provider-failed", callId, orgId, sanitizeForLog(reason, 120)),
      })
    }
    if (typeof response?.text !== "string" || !response.text.trim()) {
      if ((await noteResult({
        callId,
        orgId,
        at: now(),
        status: "provider-failed",
        provider: provider.id,
        usage: receivedUsageNumbers(response?.usage),
        ...(eventId ? { eventId } : {}),
      })) === "lost") {
        throw closedError(callId, orgId)
      }
      throw new AxMessengerError({
        kind: "server",
        userMessage: AX_AI_FALLBACK_MESSAGE,
        detail: rejectionDetail("provider-empty", callId, orgId, "empty-text"),
      })
    }
    const inputTokens = response.usage?.inputTokens
    const outputTokens = response.usage?.outputTokens
    // 사용량이 빠지거나 잘못되면 답을 내지 않고 실패로 처리한다. 입력 사용량도
    // 같은 기준(0 이상 정수)이다. 결과 기록에 "사용량 누락" 상태를 남긴다.
    if (!isValidTokenCount(inputTokens) || !isValidTokenCount(outputTokens)) {
      if ((await noteResult({
        callId,
        orgId,
        at: now(),
        status: "usage-missing",
        provider: provider.id,
        usage: receivedUsageNumbers(response.usage),
        ...(eventId ? { eventId } : {}),
      })) === "lost") {
        throw closedError(callId, orgId)
      }
      throw new AxMessengerError({
        kind: "server",
        userMessage: AX_AI_FALLBACK_MESSAGE,
        detail: rejectionDetail("usage-missing", callId, orgId, "invalid-usage"),
      })
    }
    const storedUsage: AxAiProviderUsage = { inputTokens, outputTokens }
    if (isValidTokenCount(response.usage?.totalTokens)) storedUsage.totalTokens = response.usage?.totalTokens
    // 응답 사용량의 출력 값이 상한을 넘으면 실패로 처리한다. 이미 쓴 양이므로
    // 사용량은 그대로 기록하되 초과 표시를 달고, 그 답은 방에 올리지 않는다.
    const outputOverflow = outputTokens > limits.maxOutputTokens
    const usageRecord: AxAiUsageRecord = {
      callId,
      orgId,
      userId: options.userId,
      roomId: options.roomId,
      at: now(),
      inputSize,
      provider: provider.id,
      usage: storedUsage,
    }
    if (outputOverflow) usageRecord.outputOverflow = true
    usage.record({
      kind: "ai-call",
      orgId,
      callId,
      userId: options.userId,
      roomId: options.roomId,
      inputSize,
      provider: provider.id,
      outputOverflow: outputOverflow || undefined,
      usage: usageRecord.usage,
    })
    try {
      await deps?.onUsage?.(usageRecord)
    } catch (error) {
      if ((await noteResult({
        callId,
        orgId,
        at: now(),
        status: "usage-store-failed",
        provider: provider.id,
        usage: { ...storedUsage },
        ...(eventId ? { eventId } : {}),
      })) === "lost") {
        throw closedError(callId, orgId)
      }
      const reason = error instanceof Error ? error.message : "알 수 없는 오류"
      throw new AxMessengerError({
        kind: "server",
        userMessage: AX_AI_FALLBACK_MESSAGE,
        detail: rejectionDetail("usage-store-failed", callId, orgId, sanitizeForLog(reason, 120)),
      })
    }
    if (outputOverflow) {
      if ((await noteResult({
        callId,
        orgId,
        at: now(),
        status: "output-overflow",
        provider: provider.id,
        usage: { ...storedUsage },
        ...(eventId ? { eventId } : {}),
      })) === "lost") {
        throw closedError(callId, orgId)
      }
      console.warn(
        rejectionDetail("output-overflow", callId, orgId, `outputTokens=${outputTokens} limit=${limits.maxOutputTokens}`),
      )
      throw new AxMessengerError({
        kind: "server",
        userMessage: AX_AI_FALLBACK_MESSAGE,
        detail: rejectionDetail(
          "output-overflow",
          callId,
          orgId,
          `outputTokens=${outputTokens} limit=${limits.maxOutputTokens}`,
        ),
      })
    }
    if ((await noteResult({
      callId,
      orgId,
      at: now(),
      status: "success",
      provider: provider.id,
      usage: { ...storedUsage },
      ...(eventId ? { eventId } : {}),
    })) === "lost") {
      // 결과 기록을 어디에도 남기지 못했으므로 그 답은 돌려주지 않는다.
      throw closedError(callId, orgId)
    }
    return { text: response.text, usage: { ...storedUsage }, callId, inputSize }
  }

  return { limits, providerCalls, providerResults, usage, answer, ledger }
}
