// AI 사용량 파일 저장. 1단계 범위에서 줄 단위 JSON(.jsonl)으로 남긴다.
// 실제 청구는 하지 않는다. 비밀값·대화 본문은 형(타입)부터 받지 않아 남길 수 없다.
// 이 파일은 사람이 보는 감사 기록이다. 한도·중복 판단은 공유 원장(ai-ledger.sqlite)만 본다.
import { appendFile, mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import type { AxAiProviderCallRecord, AxAiProviderCallResult } from "./ai.js"

export type AxAiStoredUsage = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export type AxAiUsageLogRecord = {
  callId: string
  orgId: string
  userId?: string
  roomId?: string
  at: number
  inputSize: number
  usage: AxAiStoredUsage
  provider?: string
  outputOverflow?: boolean
}

// 호출 뒤 결과 줄의 입력 모양. 상태는 성공·사용량 누락·출력 초과·사용량 저장
// 실패·제공자 실패뿐이며, 받은 사용량 수치(있을 때만)를 함께 남긴다.
export type AxAiCallResultLogRecord = Pick<
  AxAiProviderCallResult,
  "callId" | "orgId" | "at" | "status" | "provider" | "usage" | "eventId"
>

export type AxAiProviderCallRow = {
  callId: string
  orgId: string
  at: number
  eventId?: string
}

function definedNumbers(value: AxAiStoredUsage): AxAiStoredUsage {
  const out: AxAiStoredUsage = {}
  for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    const entry = value[key]
    if (typeof entry === "number" && Number.isFinite(entry) && entry >= 0) out[key] = entry
  }
  return out
}

// 결과 줄에 남길 받은 수치. 무엇이 왔는지(또는 안 왔는지) 보이려고 유한한 수는
// 음수·소수라도 남긴다. 본문·열쇠 자리는 형부터 받지 않는다.
function receivedNumbers(value: AxAiStoredUsage | undefined): AxAiStoredUsage | undefined {
  if (!value || typeof value !== "object") return undefined
  const out: AxAiStoredUsage = {}
  let seen = false
  for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    const entry = value[key]
    if (typeof entry === "number" && Number.isFinite(entry)) {
      out[key] = entry
      seen = true
    }
  }
  return seen ? out : undefined
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function moment(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now()
}

function eventOf(record: { eventId?: unknown }): string {
  return typeof record.eventId === "string" ? record.eventId.trim() : ""
}

export type AxAiResultCoverage = {
  // 호출 기록 줄 수(제공자를 부른 횟수).
  providerCalls: number
  // 결과 기록 줄 수(본 파일+예비 파일 합계).
  providerResults: number
  // 결과 짝이 없는 호출 수. 있어도 시작은 되지만 수가 보여야 한다.
  resultMissing: number
}

export function createAiFileStore(dir: string) {
  const root = (dir ?? "").trim()
  if (!root) throw new Error("AI 사용량 저장 폴더를 확인해 주세요.")
  const callFile = path.join(root, "ai-provider-calls.jsonl")
  const usageFile = path.join(root, "ai-usage.jsonl")
  // 결과 줄 저장 실패 때 같은 결과 줄을 한 번 더 쓰는 예비 파일(0600).
  const fallbackFile = path.join(root, "ai-provider-results-fallback.jsonl")

  async function appendLine(file: string, line: Record<string, unknown>): Promise<void> {
    await mkdir(root, { recursive: true })
    await appendFile(file, `${JSON.stringify(line)}\n`, { encoding: "utf8", mode: 0o600 })
  }

  async function appendResultLine(file: string, record: AxAiCallResultLogRecord): Promise<void> {
    const status = text(record.status).trim()
    if (!status) throw new Error("AI 호출 결과 상태를 확인해 주세요.")
    const line: Record<string, unknown> = {
      type: "provider-call-result",
      callId: text(record.callId),
      orgId: text(record.orgId),
      at: moment(record.at),
      status,
    }
    if (record.provider) line["provider"] = text(record.provider)
    const eventId = eventOf(record)
    if (eventId) line["eventId"] = eventId
    const received = receivedNumbers(record.usage)
    if (received) line["usage"] = received
    await appendLine(file, line)
  }

  async function readRowsOf(file: string): Promise<Record<string, unknown>[]> {
    let raw = ""
    try {
      raw = await readFile(file, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return []
      throw error
    }
    const rows: Record<string, unknown>[] = []
    for (const line of raw.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed: unknown = JSON.parse(trimmed)
        if (parsed && typeof parsed === "object") rows.push(parsed as Record<string, unknown>)
      } catch {
        continue
      }
    }
    return rows
  }

  return {
    dir: root,
    callFile,
    usageFile,
    fallbackFile,
    // 제공자를 부르는 지점의 호출 기록(기관·시각·호출 표지). 거부된 호출은
    // 서비스가 부르지 않으므로 여기에 남지 않는다. 사람이 보는 감사 기록이다.
    async appendCall(record: AxAiProviderCallRecord): Promise<void> {
      const line: Record<string, unknown> = {
        type: "provider-call",
        callId: text(record.callId),
        orgId: text(record.orgId),
        at: moment(record.at),
        inputSize: moment(record.inputSize),
        maxOutputTokens: moment(record.maxOutputTokens),
      }
      if (record.provider) line["provider"] = text(record.provider)
      const eventId = eventOf(record)
      if (eventId) line["eventId"] = eventId
      await appendLine(callFile, line)
    },
    // 제공자를 부른 뒤의 결과 줄. 같은 callId로 호출 기록 파일에 덧붙인다.
    // "호출 기록 수 = 결과 기록 수"로 이미 일어난 호출을 빠짐없이 대조한다.
    async appendCallResult(record: AxAiCallResultLogRecord): Promise<void> {
      await appendResultLine(callFile, record)
    },
    // 본 파일 쓰기가 실패했을 때 같은 결과 줄을 한 번 더 쓰는 예비 경로.
    // 줄 모양은 본 파일과 같다.
    async appendCallResultFallback(record: AxAiCallResultLogRecord): Promise<void> {
      await appendResultLine(fallbackFile, record)
    },
    // 옛 jsonl 넘기기용. 호출 파일에서 provider-call 줄만 골라 돌려준다.
    // 표지 없는 옛 줄도 포함한다. 깨진 줄은 건너뛴다.
    async listProviderCalls(): Promise<AxAiProviderCallRow[]> {
      const rows = await readRowsOf(callFile)
      const out: AxAiProviderCallRow[] = []
      for (const row of rows) {
        if (row["type"] !== "provider-call") continue
        const callId = typeof row["callId"] === "string" ? row["callId"].trim() : ""
        const orgId = typeof row["orgId"] === "string" ? row["orgId"].trim() : ""
        const at = row["at"]
        if (!callId || !orgId) continue
        if (typeof at !== "number" || !Number.isFinite(at)) continue
        const eventId = typeof row["eventId"] === "string" ? row["eventId"].trim() : ""
        out.push(eventId ? { callId, orgId, at, eventId } : { callId, orgId, at })
      }
      return out
    },
    // 시작 때 호출 기록과 결과 기록(본 파일+예비 파일)을 맞춰 결과 짝이 없는
    // 호출 수를 집계한다. 본문·열쇠는 세지 않고 줄 수만 센다. 결과 짝이 없어도
    // 시작은 되지만 집계 수가 보여야 한다. 깨진 줄은 건너뛴다(증거는 파일에 둠).
    // 사람이 보는 감사 기록용이며, 한도·중복 판단은 원장을 본다.
    async summarizeResultCoverage(): Promise<AxAiResultCoverage> {
      const callRows = await readRowsOf(callFile)
      const fallbackRows = await readRowsOf(fallbackFile)
      const calls = callRows.filter((row) => row["type"] === "provider-call")
      const resultRows = [...callRows, ...fallbackRows].filter((row) => row["type"] === "provider-call-result")
      const resulted = new Set(
        resultRows.filter((row) => typeof row["callId"] === "string").map((row) => row["callId"] as string),
      )
      const missing = calls.filter((row) => typeof row["callId"] === "string" && !resulted.has(row["callId"] as string)).length
      return { providerCalls: calls.length, providerResults: resultRows.length, resultMissing: missing }
    },
    async appendRelayUsage(record: { callId: string; orgId: string; eventId: string; at: number; inputSize: number; outputSize: number; durationMs: number; model: string; status: string }): Promise<void> {
      await appendLine(usageFile, { type: "ai-usage", provider: "session-relay", ...record, usage: {} })
    },
    // 기관별 AI 호출 사용량(호출 수와 모델 사용량).
    async appendUsage(record: AxAiUsageLogRecord): Promise<void> {
      const line: Record<string, unknown> = {
        type: "ai-usage",
        callId: text(record.callId),
        orgId: text(record.orgId),
        at: moment(record.at),
        inputSize: moment(record.inputSize),
        usage: definedNumbers(record.usage ?? {}),
      }
      if (record.userId) line["userId"] = text(record.userId)
      if (record.roomId) line["roomId"] = text(record.roomId)
      if (record.provider) line["provider"] = text(record.provider)
      if (record.outputOverflow === true) line["outputOverflow"] = true
      await appendLine(usageFile, line)
    },
  }
}

export type AxAiFileStore = ReturnType<typeof createAiFileStore>
