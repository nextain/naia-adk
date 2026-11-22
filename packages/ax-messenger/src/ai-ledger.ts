// 공유 원장. 봇이 몇 개 떠 있든, 몇 번 재시작하든 한도·중복 방지를
// 데이터 폴더의 원장 파일 하나에서 원자적으로 지킨다.
// node 내장 `node:sqlite`(DatabaseSync, 새 의존성 아님)를 쓴다.
// 일지는 기본 되돌림 일지(journal_mode=DELETE)로 두고 busy_timeout을 짧게 둔다.
// 같은 호스트의 여러 컨테이너가 같은 폴더를 묶어 쓸 때 WAL의 공유 메모리
// 파일이 필요 없게 하려는 것이다.
// 본문·열쇠는 형부터 받지 않아 남길 수 없다.
//
// 동시성 길잡이:
// - `calls` 표는 AI 호출(제공자를 부르는 질문) 전용이다. 인사는 세지 않는다.
// - `greetings` 표는 첫 인사 전용이다. 빈도 합산·providerCalls/providerResults에
//   잡히지 않으며, 빈도 한도와 상관없이 예약된다(한도가 꽉 차도 인사는 나간다).
// - 인사 보내기 한 번은 유한 기한(10초) 안에 끝내거나 끊는다. 기한을 넘기면
//   "결과 모름"으로 다루고 reserved로 둔다. 차지 임대(60초, 기한의 6배
//   이상)는 기한보다 충분히 길어, 첫 전송이 기한 안에 끝나므로 둘째가
//   임대를 가져가 겹쳐 보낼 수 없다. 차지 표(claim_token)로 보내기 직전과
//   sent 기록 때 내 차지가 맞는지 확인한다(바뀐 줄 1이 아니면 중단).
// - 잠금(`BEGIN IMMEDIATE` 경쟁)은 이중 기동을 일찍 막는 보조가 아니라,
//   원자 예약으로 정확성을 지키는 본 길이다. 단일 실행 잠금(소켓)은 이중 기동을
//   일찍 알리는 보조다.
// - 바쁨(BUSY) 대기는 이벤트 루프를 막지 않는다. 연결 busy_timeout은 50ms로
//   짧게 두고, 바쁘면 `await setTimeout` 으로 쉬었다가 다시 시도한다
//   (`Atomics.wait` 금지). 총 기한 5초를 넘기면 오류를 던지고 호출부는 닫힘으로
//   간다. 이미 기록된 거래(성공한 COMMIT·INSERT·UPDATE)는 기한을 넘겼더라도
//   되돌리지 않고 성공으로 둔다.
import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import path from "node:path"

export const AX_LEDGER_FILENAME = "ai-ledger.sqlite"
// 되돌림 일지를 쓰고 WAL을 피한다. 연결 busy_timeout은 50ms로 짧게 둔다.
// 바쁨이면 바깥에서 비동기로 쉬었다가(50ms씩) 총 5초 안에서만 다시 시도한다.
// 총 기한을 넘기면 바로 오류를 던지고 호출부(ai.ts)는 닫힘으로 간다.
// 성공한 기록은 기한을 넘겼더라도 되돌리지 않고 성공으로 둔다.
export const AX_LEDGER_BUSY_TIMEOUT_MS = 50
export const AX_LEDGER_RESERVE_DEADLINE_MS = 5_000
// 인사 보내기 한 번의 유한 기한. 이 기한을 넘기거나 연결이 끊기면 그 보내기는
// "결과 모름"으로 다루고 인사 줄은 reserved로 둔다(sent로 두지 않고,
// 차지도 풀지 않는다). 다음 재시도는 방 표지 확인 뒤에 보낸다.
export const AX_GREETING_SEND_TIMEOUT_MS = 10_000
// 인사 재시도 차지(claimed_at+claim_token)의 임대(회수 가능 시간). 보내기
// 기한보다 충분히 길게(기한의 6배 이상, 60초) 둔다. 첫 전송이 기한 안에
// 끝나거나 끊기므로, 임대가 지나기 전에는 둘째가 차지를 가져갈 수 없어
// 두 프로세스가 겹쳐 보낼 수 없다. 봇 시작 때 임대 ≥ 기한×6을 단정한다.
export const AX_LEDGER_GREETING_CLAIM_LEASE_MS = 60_000
export const AX_GREETING_CLAIM_LEASE_RATIO = 6
// 옛 이름 별칭(8회차 값 30초 → 9회차 60초로 바꿈). 새 코드는 LEASE를 쓴다.
export const AX_LEDGER_GREETING_CLAIM_STALE_MS = AX_LEDGER_GREETING_CLAIM_LEASE_MS
const RETRY_STEP_MS = 50

export type AxLedgerCallState =
  | "reserved"
  | "success"
  | "usage-missing"
  | "output-overflow"
  | "usage-store-failed"
  | "provider-failed"

export type AxLedgerGreetingState = "reserved" | "sent"

export type AxLedgerLimits = {
  rateLimitMaxCalls: number
  rateLimitWindowMs: number
}

export type AxLedgerReserveInput = {
  callId: string
  orgId: string
  eventId?: string
  at?: number
  inputSize?: number
  maxOutputTokens?: number
  provider?: string
}

export type AxLedgerReserveOutcome = { ok: true } | { ok: false; reason: "duplicate" | "rate-limited" }

export type AxLedgerUsage = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export type AxLedgerCoverage = {
  providerCalls: number
  providerResults: number
  resultMissing: number
}

export type AxLedgerGreetingCoverage = {
  reserved: number
  sent: number
}

export type AxLedgerGreetingRow = {
  orgId: string
  roomId: string
  state: AxLedgerGreetingState
  reservedAt: number
  sentAt: number | null
  claimedAt: number | null
  // 차지 표(무작위 값). 차지할 때마다 새로 찍히며, 보내기 직전과 sent
  // 기록 때 이 값이 내 차지와 같은지 확인한다. 다르면 다른 프로세스가
  // 임대가 지난 뒤 차지를 가져간 것이므로 보내지도 sent로 두지도 않는다.
  claimToken: string | null
}

export type AxLedgerGreetingMarkInput = {
  claimToken?: string
  at?: number
}

function newClaimToken(): string {
  return randomBytes(16).toString("hex")
}

export type AxLedgerOpenDeps = {
  now?: () => number
  // 시험에서 원장 열기 실패를 가장할 때 쓴다. 기본값은 node:sqlite다.
  openDatabase?: (filePath: string) => {
    exec(sql: string): void
    prepare(sql: string): {
      get(...params: unknown[]): unknown
      run(...params: unknown[]): { changes?: unknown }
      all(...params: unknown[]): unknown[]
    }
    close(): void
  }
  busyTimeoutMs?: number
}

function checkLimits(limits: AxLedgerLimits): void {
  for (const key of ["rateLimitMaxCalls", "rateLimitWindowMs"] as const) {
    const value = limits[key]
    if (!Number.isInteger(value) || (value as number) <= 0) {
      throw new Error(`AI 호출 한도 설정을 확인해 주세요.(잘못된 값: ${key})`)
    }
  }
}

function cleanId(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function cleanEventId(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function validTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

export function axLedgerPathFor(dir: string): string {
  const root = (dir ?? "").trim()
  if (!root) throw new Error("AI 사용량 저장 폴더를 확인해 주세요.")
  return path.join(root, AX_LEDGER_FILENAME)
}

type DbLike = {
  exec(sql: string): void
  prepare(sql: string): {
    get(...p: unknown[]): unknown
    run(...p: unknown[]): { changes?: unknown }
    all(...p: unknown[]): unknown[]
  }
  close(): void
}

export type AxAiLedger = {
  readonly path: string
  readonly isNew: boolean
  // AI 호출 예약. BEGIN IMMEDIATE 안에서 중복 확인→빈도 확인→예약 INSERT를
  // 한 거래로 한다. 바쁘면 비동기로 쉬었다가 총 기한 안에서 다시 시도한다.
  reserve(input: AxLedgerReserveInput): Promise<AxLedgerReserveOutcome>
  updateResult(callId: string, state: AxLedgerCallState, usage?: AxLedgerUsage): Promise<void>
  hasReservation(callId: string, orgId: string, eventId: string): boolean
  // 옛 jsonl 호출 줄 넘기기. 한 거래로 넣으며, 같은 call_id·같은
  // org_id·event_id는 무시한다(INSERT OR IGNORE). 실패하면 던진다.
  importCalls(
    rows: {
      callId: string
      orgId: string
      eventId?: string
      at: number
      state?: AxLedgerCallState
      inputSize?: number
      maxOutputTokens?: number
      provider?: string
    }[],
  ): Promise<void>
  countInWindow(at?: number): number
  // calls 표만 셈한다. greetings 표는 세지 않는다.
  summarizeCoverage(): AxLedgerCoverage
  // 첫 인사 예약. calls 표·빈도 합산과 무관하게 greetings 표에만 INSERT한다.
  // 이미 같은 (org_id, room_id) 줄이 있으면 duplicate(인사 안 함)이다.
  // 새 예약은 차지 없음(claimed_at·claim_token NULL)으로 둔다. 예약한 봇이
  // 바로 뒤에 claimGreetingForRetry로 차지 표를 받아 보내기 기한 안에
  // 보내고, 그 동안은 임대(60초)가 살아 있어 다른 봇이 차지를 가져가지
  // 못한다. 예약·차지 사이 틈에 다른 봇이 먼저 차지하면 그 봇이 보내고
  // 이 봇은 차지 실패로 물러나므로, 어느 쪽이든 정확히 한 번이다.
  reserveGreeting(input: { orgId: string; roomId: string; at?: number }): Promise<AxLedgerReserveOutcome>
  // 인사 줄 읽기. 없으면 null이다.
  getGreeting(orgId: string, roomId: string): AxLedgerGreetingRow | null
  // 아직 보내지 않은 인사(예약 상태) 목록. 봇 시작·동기화 때 재시도용이다.
  listPendingGreetings(orgId: string): AxLedgerGreetingRow[]
  // 재시도 차지. reserved 상태이고 차지(claimed_at)가 없거나 임대
  // (leaseMs, 기본 60초)가 지난 줄만 claimed_at과 새 claim_token으로
  // 갱신한다. 바뀐 줄이 1일 때만 새 차지 표를 돌려준다(보내도 됨).
  // 차지하지 못하면 null이다. 두 봇이 동시에 다시 보내지 않게
  // 원자적으로 차지한다.
  claimGreetingForRetry(orgId: string, roomId: string, at?: number, leaseMs?: number): Promise<string | null>
  // 보낸 뒤 표시. reserved→sent. 차지 표가 내 차지와 같을 때만 쓴다.
  // 표가 다르면(임대가 지나 다른 봇이 가져감) false로 거부하고 reserved로
  // 둔다. 이미 sent면 true로 둔다(멱등·수렴).
  markGreetingSent(orgId: string, roomId: string, input?: AxLedgerGreetingMarkInput): Promise<boolean>
  summarizeGreetings(orgId?: string): AxLedgerGreetingCoverage
  close(): void
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function openAiLedger(dir: string, limits: AxLedgerLimits, deps?: AxLedgerOpenDeps): AxAiLedger {
  checkLimits(limits)
  const root = (dir ?? "").trim()
  if (!root) throw new Error("AI 사용량 저장 폴더를 확인해 주세요.")
  const isMemory = root === ":memory:"
  const filePath = isMemory ? ":memory:" : axLedgerPathFor(root)
  const busyTimeoutMs = deps?.busyTimeoutMs ?? AX_LEDGER_BUSY_TIMEOUT_MS
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs <= 0) {
    throw new Error("AI 호출 한도 설정을 확인해 주세요.(잘못된 값: busyTimeoutMs)")
  }
  if (!isMemory) mkdirSync(root, { recursive: true })
  const isNew = isMemory ? true : !existsSync(filePath)
  const open = deps?.openDatabase ?? ((target: string) => new DatabaseSync(target) as unknown as DbLike)
  let db: DbLike
  try {
    db = open(filePath)
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error ?? "원장을 열지 못했습니다."))
  }
  function isBusyMessage(error: unknown): boolean {
    const code = (error as { code?: unknown } | null)?.code
    if (typeof code === "string" && code.includes("BUSY")) return true
    const message = error instanceof Error ? error.message : String(error ?? "")
    return /busy|database is locked/i.test(message)
  }

  // 열기 DDL은 한 번만 시도한다. busy_timeout(50ms) 안 SQLite 대기를 포함해
  // 겹치면 빨리 실패하고 봇은 시작 오류로 끝난다. 예약·갱신·넘기기·인사는
  // 아래 비동기 재시도로 총 5초 안에서 다시 시도한다. Atomics.wait는 쓰지 않는다
  // (이벤트 루프를 막지 않으려는 것이다).
  try {
    // 새 파일은 0600이 아닐 수 있어 바로 좁힌다.
    if (!isMemory) {
      try {
        chmodSync(filePath, 0o600)
      } catch {
        // 권한을 좁히지 못하면 원장을 쓰지 않는다.
        throw new Error("AI 원장 파일 권한을 확인해 주세요.")
      }
    }
    db.exec(`PRAGMA journal_mode = DELETE;`)
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`)
    db.exec(
      `CREATE TABLE IF NOT EXISTS calls (` +
        `call_id TEXT PRIMARY KEY, ` +
        `org_id TEXT NOT NULL, ` +
        `event_id TEXT, ` +
        `reserved_at INTEGER NOT NULL, ` +
        `state TEXT NOT NULL, ` +
        `input_size INTEGER, ` +
        `max_output_tokens INTEGER, ` +
        `provider TEXT, ` +
        `usage_input_tokens INTEGER, ` +
        `usage_output_tokens INTEGER, ` +
        `usage_total_tokens INTEGER, ` +
        `updated_at INTEGER NOT NULL, ` +
        `UNIQUE(org_id, event_id)` +
        `);`,
    )
    db.exec(`CREATE INDEX IF NOT EXISTS idx_calls_reserved_at ON calls(reserved_at);`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_calls_org_time ON calls(org_id, reserved_at);`)
    // 첫 인사 전용 표. calls 표·빈도 합산과 완전히 따로 논다. 본문 칸 없음.
    // state는 reserved→sent 두 가지다. claimed_at은 재시도 차지 시각,
    // claim_token은 그 차지의 무작위 표다(차지할 때마다 새로 찍는다).
    db.exec(
      `CREATE TABLE IF NOT EXISTS greetings (` +
        `org_id TEXT NOT NULL, ` +
        `room_id TEXT NOT NULL, ` +
        `state TEXT NOT NULL, ` +
        `reserved_at INTEGER NOT NULL, ` +
        `sent_at INTEGER, ` +
        `claimed_at INTEGER, ` +
        `claim_token TEXT, ` +
        `PRIMARY KEY(org_id, room_id)` +
        `);`,
    )
    // 8회차 원장에는 claim_token 칸이 없다. 없을 때만 더한다.
    const greetingColumns = db.prepare(`PRAGMA table_info(greetings);`).all() as Record<string, unknown>[]
    if (!greetingColumns.some((column) => column["name"] === "claim_token")) {
      db.exec(`ALTER TABLE greetings ADD COLUMN claim_token TEXT;`)
    }
  } catch (error) {
    try {
      db.close()
    } catch {
      // 닫기 실패는 원래 오류를 가리지 않는다.
    }
    throw error instanceof Error ? error : new Error(String(error ?? "원장을 열지 못했습니다."))
  }

  const now = deps?.now ?? Date.now

  function isConstraintError(error: unknown): boolean {
    const code = (error as { code?: unknown } | null)?.code
    if (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT")) return true
    const message = error instanceof Error ? error.message : String(error ?? "")
    return /constraint|unique|primary/i.test(message)
  }

  function isBusyError(error: unknown): boolean {
    const code = (error as { code?: unknown } | null)?.code
    if (typeof code === "string" && code.includes("BUSY")) return true
    const message = error instanceof Error ? error.message : String(error ?? "")
    return /busy|database is locked/i.test(message)
  }

  // 총 기한(벽시계) 도우미. 바쁨이면 50ms씩 비동기로 쉬었다가 다시 시도한다.
  // 기한이 지나면 오류를 던진다. 성공한 기록은 기한을 넘겼더라도 되돌리지 않고
  // 성공으로 둔다(성공 반환 직전에 기한을 재지 않는다).
  function deadlineExceeded(start: number, totalMs: number): boolean {
    return Date.now() - start >= totalMs
  }

  return {
    path: filePath,
    isNew,
    hasReservation(callId, orgId, eventId) {
      return !!db.prepare("SELECT 1 AS found FROM calls WHERE call_id = ? AND org_id = ? AND event_id = ? LIMIT 1;").get(callId, orgId, eventId)
    },
    async reserve(input: AxLedgerReserveInput): Promise<AxLedgerReserveOutcome> {
      const callId = cleanId(input.callId)
      const orgId = cleanId(input.orgId)
      if (!callId) throw new Error("호출 표지를 확인해 주세요.")
      if (!orgId) throw new Error("기관을 확인해 주세요.")
      const eventId = cleanEventId(input.eventId)
      const at = typeof input.at === "number" && Number.isFinite(input.at) ? input.at : now()
      const cutoff = at - limits.rateLimitWindowMs
      const eventKey: string | null = eventId ? eventId : null
      // 여러 프로세스가 동시에 BEGIN IMMEDIATE를 노리면 BUSY가 난다.
      // busy_timeout(50ms) 안 대기를 포함해 예약 한 번의 총 기한(5초) 안에서만
      // 비동기로 쉬었다가 다시 시도한다. 기한이 지나면 바로 오류를 던진다.
      // 성공한 예약은 기한을 넘겼더라도 되돌리지 않고 성공으로 둔다.
      const start = Date.now()
      for (;;) {
        try {
          db.exec("BEGIN IMMEDIATE;")
        } catch (error) {
          if (isBusyError(error) && !deadlineExceeded(start, AX_LEDGER_RESERVE_DEADLINE_MS)) {
            await sleepMs(Math.min(RETRY_STEP_MS, Math.max(0, AX_LEDGER_RESERVE_DEADLINE_MS - (Date.now() - start))))
            continue
          }
          throw error instanceof Error ? error : new Error(String(error ?? "원장 예약에 실패했습니다."))
        }
        try {
          if (eventKey) {
            const dup = db
              .prepare("SELECT call_id FROM calls WHERE org_id = ? AND event_id = ? LIMIT 1;")
              .get(orgId, eventKey) as Record<string, unknown> | undefined
            if (dup && typeof dup["call_id"] === "string") {
              db.exec("ROLLBACK;")
              return { ok: false, reason: "duplicate" }
            }
          }
          // 서버 전체 합산(RQ-15). 한 기관만 쓰는 1단계 배포에서는 같은
          // 기관 줄 수와 같다. 서로 다른 방·계정의 호출이 합쳐진다.
          // greetings 표는 세지 않는다(인사는 빈도를 쓰지 않는다).
          const counted = db
            .prepare("SELECT COUNT(*) AS n FROM calls WHERE reserved_at > ?;")
            .get(cutoff) as Record<string, unknown> | undefined
          const total = typeof counted?.["n"] === "number" ? (counted["n"] as number) : 0
          if (total >= limits.rateLimitMaxCalls) {
            db.exec("ROLLBACK;")
            return { ok: false, reason: "rate-limited" }
          }
          try {
            db.prepare(
              "INSERT INTO calls(call_id, org_id, event_id, reserved_at, state, input_size, max_output_tokens, provider, updated_at) " +
                "VALUES(?, ?, ?, ?, 'reserved', ?, ?, ?, ?);",
            ).run(
              callId,
              orgId,
              eventKey,
              at,
              typeof input.inputSize === "number" && Number.isFinite(input.inputSize) ? input.inputSize : null,
              typeof input.maxOutputTokens === "number" && Number.isFinite(input.maxOutputTokens)
                ? input.maxOutputTokens
                : null,
              typeof input.provider === "string" && input.provider.trim() ? input.provider.trim() : null,
              at,
            )
          } catch (error) {
            try {
              db.exec("ROLLBACK;")
            } catch {
              // 되돌리기 실패는 아래에서 던진다.
            }
            // 같은 call_id·같은 org·event 겹침은 중복으로 보고 부르지 않는다.
            if (isConstraintError(error)) return { ok: false, reason: "duplicate" }
            if (isBusyError(error) && !deadlineExceeded(start, AX_LEDGER_RESERVE_DEADLINE_MS)) {
              await sleepMs(Math.min(RETRY_STEP_MS, Math.max(0, AX_LEDGER_RESERVE_DEADLINE_MS - (Date.now() - start))))
              continue
            }
            throw error
          }
          try {
            db.exec("COMMIT;")
          } catch (error) {
            try {
              db.exec("ROLLBACK;")
            } catch {
              // 되돌리기 실패는 원래 오류를 가리지 않는다.
            }
            if (isBusyError(error) && !deadlineExceeded(start, AX_LEDGER_RESERVE_DEADLINE_MS)) {
              await sleepMs(Math.min(RETRY_STEP_MS, Math.max(0, AX_LEDGER_RESERVE_DEADLINE_MS - (Date.now() - start))))
              continue
            }
            throw error
          }
          return { ok: true }
        } catch (error) {
          try {
            db.exec("ROLLBACK;")
          } catch {
            // 되돌리기 실패는 원래 오류를 가리지 않는다.
          }
          const outcome = error as { ok?: unknown }
          if (outcome && typeof outcome === "object" && "ok" in outcome) throw error
          if (isBusyError(error) && !deadlineExceeded(start, AX_LEDGER_RESERVE_DEADLINE_MS)) {
            await sleepMs(Math.min(RETRY_STEP_MS, Math.max(0, AX_LEDGER_RESERVE_DEADLINE_MS - (Date.now() - start))))
            continue
          }
          // 중복·한도 판정이 아닌 원장 오류는 호출부가 닫힘으로 바꾼다.
          throw error instanceof Error ? error : new Error(String(error ?? "원장 예약에 실패했습니다."))
        }
      }
    },
    async updateResult(callId: string, state: AxLedgerCallState, usage?: AxLedgerUsage): Promise<void> {
      const id = cleanId(callId)
      if (!id) throw new Error("호출 표지를 확인해 주세요.")
      if (
        state !== "reserved" &&
        state !== "success" &&
        state !== "usage-missing" &&
        state !== "output-overflow" &&
        state !== "usage-store-failed" &&
        state !== "provider-failed"
      ) {
        throw new Error("AI 호출 결과 상태를 확인해 주세요.")
      }
      const at = now()
      const inputTokens = validTokenCount(usage?.inputTokens) ? (usage?.inputTokens as number) : null
      const outputTokens = validTokenCount(usage?.outputTokens) ? (usage?.outputTokens as number) : null
      const totalTokens = validTokenCount(usage?.totalTokens) ? (usage?.totalTokens as number) : null
      // 갱신도 총 기한 안에서만 기다린다. 기한이 지나면 바로 오류를 던지고
      // 호출부는 이번 답을 내주지 않고 닫힘으로 간다. 성공한 갱신은 기한을
      // 넘겼더라도 되돌리지 않고 성공으로 둔다.
      const start = Date.now()
      for (;;) {
        try {
          const done = db
            .prepare(
              "UPDATE calls SET state = ?, usage_input_tokens = ?, usage_output_tokens = ?, usage_total_tokens = ?, updated_at = ? WHERE call_id = ?;",
            )
            .run(state, inputTokens, outputTokens, totalTokens, at, id) as { changes?: unknown }
          const changed = typeof done?.changes === "number" ? done.changes : 0
          if (changed < 1) throw new Error("AI 원장에서 호출을 찾지 못했습니다.")
          return
        } catch (error) {
          if (isBusyError(error) && !deadlineExceeded(start, AX_LEDGER_RESERVE_DEADLINE_MS)) {
            await sleepMs(Math.min(RETRY_STEP_MS, Math.max(0, AX_LEDGER_RESERVE_DEADLINE_MS - (Date.now() - start))))
            continue
          }
          throw error
        }
      }
    },
    async importCalls(rows): Promise<void> {
      // 넘기기도 총 기한 안에서만 비동기로 기다린다.
      const start = Date.now()
      for (;;) {
        try {
          db.exec("BEGIN IMMEDIATE;")
        } catch (error) {
          if (isBusyError(error) && !deadlineExceeded(start, AX_LEDGER_RESERVE_DEADLINE_MS)) {
            await sleepMs(Math.min(RETRY_STEP_MS, Math.max(0, AX_LEDGER_RESERVE_DEADLINE_MS - (Date.now() - start))))
            continue
          }
          throw error instanceof Error ? error : new Error(String(error ?? "원장 넘기기에 실패했습니다."))
        }
        try {
          const stmt = db.prepare(
            "INSERT OR IGNORE INTO calls(call_id, org_id, event_id, reserved_at, state, input_size, max_output_tokens, provider, updated_at) " +
              "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?);",
          )
          for (const row of rows) {
            const rowCallId = cleanId(row.callId)
            const rowOrgId = cleanId(row.orgId)
            if (!rowCallId || !rowOrgId) continue
            if (typeof row.at !== "number" || !Number.isFinite(row.at)) continue
            const rowEvent = cleanEventId(row.eventId)
            const state: AxLedgerCallState =
              row.state === "success" ||
              row.state === "usage-missing" ||
              row.state === "output-overflow" ||
              row.state === "usage-store-failed" ||
              row.state === "provider-failed"
                ? row.state
                : "reserved"
            stmt.run(
              rowCallId,
              rowOrgId,
              rowEvent ? rowEvent : null,
              row.at,
              state,
              typeof row.inputSize === "number" && Number.isFinite(row.inputSize) ? row.inputSize : null,
              typeof row.maxOutputTokens === "number" && Number.isFinite(row.maxOutputTokens)
                ? row.maxOutputTokens
                : null,
              typeof row.provider === "string" && row.provider.trim() ? row.provider.trim() : null,
              row.at,
            )
          }
          db.exec("COMMIT;")
          return
        } catch (error) {
          try {
            db.exec("ROLLBACK;")
          } catch {
            // 되돌리기 실패는 원래 오류를 가리지 않는다.
          }
          if (isBusyError(error) && !deadlineExceeded(start, AX_LEDGER_RESERVE_DEADLINE_MS)) {
            await sleepMs(Math.min(RETRY_STEP_MS, Math.max(0, AX_LEDGER_RESERVE_DEADLINE_MS - (Date.now() - start))))
            continue
          }
          throw error instanceof Error ? error : new Error(String(error ?? "원장 넘기기에 실패했습니다."))
        }
      }
    },
    countInWindow(atValue?: number): number {
      const at = typeof atValue === "number" && Number.isFinite(atValue) ? atValue : now()
      const cutoff = at - limits.rateLimitWindowMs
      const row = db.prepare("SELECT COUNT(*) AS n FROM calls WHERE reserved_at > ?;").get(cutoff) as
        | Record<string, unknown>
        | undefined
      return typeof row?.["n"] === "number" ? (row["n"] as number) : 0
    },
    summarizeCoverage(): AxLedgerCoverage {
      const total = db.prepare("SELECT COUNT(*) AS n FROM calls;").get() as Record<string, unknown> | undefined
      const done = db
        .prepare("SELECT COUNT(*) AS n FROM calls WHERE state != 'reserved';")
        .get() as Record<string, unknown> | undefined
      const missing = db.prepare("SELECT COUNT(*) AS n FROM calls WHERE state = 'reserved';").get() as
        | Record<string, unknown>
        | undefined
      const providerCalls = typeof total?.["n"] === "number" ? (total["n"] as number) : 0
      const providerResults = typeof done?.["n"] === "number" ? (done["n"] as number) : 0
      const resultMissing = typeof missing?.["n"] === "number" ? (missing["n"] as number) : 0
      return { providerCalls, providerResults, resultMissing }
    },
    async reserveGreeting(input: { orgId: string; roomId: string; at?: number }): Promise<AxLedgerReserveOutcome> {
      const orgId = cleanId(input.orgId)
      const roomId = cleanId(input.roomId)
      if (!orgId) throw new Error("기관을 확인해 주세요.")
      if (!roomId) throw new Error("방을 확인해 주세요.")
      const at = typeof input.at === "number" && Number.isFinite(input.at) ? input.at : now()
      // 인사 예약은 빈도 한도와 상관없이 greetings 표에만 INSERT한다.
      // 같은 (org_id, room_id)가 이미 있으면 duplicate(인사 안 함)이다.
      // 새 예약은 차지 없음(NULL)으로 둔다. 먼저 예약한 봇이 바로 뒤에
      // 차지해 보내고, 재시작 뒤 reserved 줄도 차지 표가 없으면 바로 차지할
      // 수 있어 60초 임대를 기다리지 않는다. 예약·차지 사이 틈에 다른 봇이
      // 먼저 차지하면 그 봇이 보내므로 어느 쪽이든 정확히 한 번이다.
      const start = Date.now()
      for (;;) {
        try {
          db.exec("BEGIN IMMEDIATE;")
        } catch (error) {
          if (isBusyError(error) && !deadlineExceeded(start, AX_LEDGER_RESERVE_DEADLINE_MS)) {
            await sleepMs(Math.min(RETRY_STEP_MS, Math.max(0, AX_LEDGER_RESERVE_DEADLINE_MS - (Date.now() - start))))
            continue
          }
          throw error instanceof Error ? error : new Error(String(error ?? "인사 예약에 실패했습니다."))
        }
        try {
          try {
            db.prepare(
              "INSERT INTO greetings(org_id, room_id, state, reserved_at, sent_at, claimed_at, claim_token) " +
                "VALUES(?, ?, 'reserved', ?, NULL, NULL, NULL);",
            ).run(orgId, roomId, at)
          } catch (error) {
            try {
              db.exec("ROLLBACK;")
            } catch {
              // 되돌리기 실패는 아래에서 던진다.
            }
            if (isConstraintError(error)) return { ok: false, reason: "duplicate" }
            if (isBusyError(error) && !deadlineExceeded(start, AX_LEDGER_RESERVE_DEADLINE_MS)) {
              await sleepMs(Math.min(RETRY_STEP_MS, Math.max(0, AX_LEDGER_RESERVE_DEADLINE_MS - (Date.now() - start))))
              continue
            }
            throw error
          }
          try {
            db.exec("COMMIT;")
          } catch (error) {
            try {
              db.exec("ROLLBACK;")
            } catch {
              // 되돌리기 실패는 원래 오류를 가리지 않는다.
            }
            if (isBusyError(error) && !deadlineExceeded(start, AX_LEDGER_RESERVE_DEADLINE_MS)) {
              await sleepMs(Math.min(RETRY_STEP_MS, Math.max(0, AX_LEDGER_RESERVE_DEADLINE_MS - (Date.now() - start))))
              continue
            }
            throw error
          }
          return { ok: true }
        } catch (error) {
          try {
            db.exec("ROLLBACK;")
          } catch {
            // 되돌리기 실패는 원래 오류를 가리지 않는다.
          }
          const outcome = error as { ok?: unknown }
          if (outcome && typeof outcome === "object" && "ok" in outcome) throw error
          if (isBusyError(error) && !deadlineExceeded(start, AX_LEDGER_RESERVE_DEADLINE_MS)) {
            await sleepMs(Math.min(RETRY_STEP_MS, Math.max(0, AX_LEDGER_RESERVE_DEADLINE_MS - (Date.now() - start))))
            continue
          }
          throw error instanceof Error ? error : new Error(String(error ?? "인사 예약에 실패했습니다."))
        }
      }
    },
    getGreeting(orgId: string, roomId: string): AxLedgerGreetingRow | null {
      const org = cleanId(orgId)
      const room = cleanId(roomId)
      if (!org || !room) return null
      const row = db
        .prepare("SELECT org_id, room_id, state, reserved_at, sent_at, claimed_at, claim_token FROM greetings WHERE org_id = ? AND room_id = ? LIMIT 1;")
        .get(org, room) as Record<string, unknown> | undefined
      if (!row || typeof row["room_id"] !== "string") return null
      const state = row["state"] === "sent" ? "sent" : "reserved"
      return {
        orgId: String(row["org_id"] ?? org),
        roomId: String(row["room_id"] ?? room),
        state,
        reservedAt: typeof row["reserved_at"] === "number" ? (row["reserved_at"] as number) : 0,
        sentAt: typeof row["sent_at"] === "number" ? (row["sent_at"] as number) : null,
        claimedAt: typeof row["claimed_at"] === "number" ? (row["claimed_at"] as number) : null,
        claimToken: typeof row["claim_token"] === "string" && row["claim_token"] ? (row["claim_token"] as string) : null,
      }
    },
    listPendingGreetings(orgId: string): AxLedgerGreetingRow[] {
      const org = cleanId(orgId)
      if (!org) return []
      const rows = db
        .prepare("SELECT org_id, room_id, state, reserved_at, sent_at, claimed_at, claim_token FROM greetings WHERE org_id = ? AND state = 'reserved';")
        .all(org) as Record<string, unknown>[]
      return (rows ?? []).map((row) => ({
        orgId: String(row["org_id"] ?? org),
        roomId: String(row["room_id"] ?? ""),
        state: "reserved" as const,
        reservedAt: typeof row["reserved_at"] === "number" ? (row["reserved_at"] as number) : 0,
        sentAt: typeof row["sent_at"] === "number" ? (row["sent_at"] as number) : null,
        claimedAt: typeof row["claimed_at"] === "number" ? (row["claimed_at"] as number) : null,
        claimToken: typeof row["claim_token"] === "string" && row["claim_token"] ? (row["claim_token"] as string) : null,
      }))
    },
    async claimGreetingForRetry(orgId: string, roomId: string, at?: number, leaseMs?: number): Promise<string | null> {
      const org = cleanId(orgId)
      const room = cleanId(roomId)
      if (!org || !room) throw new Error("기관·방을 확인해 주세요.")
      const stamp = typeof at === "number" && Number.isFinite(at) ? at : now()
      const lease = typeof leaseMs === "number" && Number.isFinite(leaseMs) && leaseMs > 0
        ? leaseMs
        : AX_LEDGER_GREETING_CLAIM_LEASE_MS
      // 차지할 때마다 새 표를 찍는다. 이전 표를 가진 봇의 늦은 sent는
      // 표가 달라 거부된다.
      const token = newClaimToken()
      const start = Date.now()
      for (;;) {
        try {
          const done = db
            .prepare(
              "UPDATE greetings SET claimed_at = ?, claim_token = ? WHERE org_id = ? AND room_id = ? AND state = 'reserved' AND (claimed_at IS NULL OR claimed_at <= ?);",
            )
            .run(stamp, token, org, room, stamp - lease) as { changes?: unknown }
          // 성공한 차지는 기한을 넘겼더라도 되돌리지 않고 성공으로 둔다.
          // 바뀐 줄이 1이 아니면(다른 봇이 임대를 쥐고 있음) null이다.
          return typeof done?.changes === "number" && done.changes >= 1 ? token : null
        } catch (error) {
          if (isBusyError(error) && !deadlineExceeded(start, AX_LEDGER_RESERVE_DEADLINE_MS)) {
            await sleepMs(Math.min(RETRY_STEP_MS, Math.max(0, AX_LEDGER_RESERVE_DEADLINE_MS - (Date.now() - start))))
            continue
          }
          throw error
        }
      }
    },
    async markGreetingSent(orgId: string, roomId: string, input?: AxLedgerGreetingMarkInput): Promise<boolean> {
      const org = cleanId(orgId)
      const room = cleanId(roomId)
      if (!org || !room) throw new Error("기관·방을 확인해 주세요.")
      const stamp = input && typeof input.at === "number" && Number.isFinite(input.at) ? input.at : now()
      const token = input && typeof input.claimToken === "string" ? input.claimToken : ""
      const start = Date.now()
      for (;;) {
        try {
          // 이미 sent면 true로 둔다(멱등·수렴). reserved인데 표가 다르면
          // 0건 갱신으로 false다(임대가 지나 다른 봇이 가져간 뒤의 늦은 쓰기).
          const current = db
            .prepare("SELECT state FROM greetings WHERE org_id = ? AND room_id = ? LIMIT 1;")
            .get(org, room) as Record<string, unknown> | undefined
          if (current && current["state"] === "sent") return true
          const done = db.prepare(
            "UPDATE greetings SET state = 'sent', sent_at = ? WHERE org_id = ? AND room_id = ? AND state = 'reserved' AND claim_token = ?;",
          ).run(stamp, org, room, token) as { changes?: unknown }
          // 성공은 기한을 넘겼더라도 성공이다.
          return typeof done?.changes === "number" && done.changes >= 1
        } catch (error) {
          if (isBusyError(error) && !deadlineExceeded(start, AX_LEDGER_RESERVE_DEADLINE_MS)) {
            await sleepMs(Math.min(RETRY_STEP_MS, Math.max(0, AX_LEDGER_RESERVE_DEADLINE_MS - (Date.now() - start))))
            continue
          }
          throw error
        }
      }
    },
    summarizeGreetings(orgId?: string): AxLedgerGreetingCoverage {
      const org = cleanId(orgId)
      const reservedCount = ((): number => {
        if (org) {
          const row = db
            .prepare("SELECT COUNT(*) AS n FROM greetings WHERE org_id = ? AND state = 'reserved';")
            .get(org) as Record<string, unknown> | undefined
          return typeof row?.["n"] === "number" ? (row["n"] as number) : 0
        }
        const row = db
          .prepare("SELECT COUNT(*) AS n FROM greetings WHERE state = 'reserved';")
          .get() as Record<string, unknown> | undefined
        return typeof row?.["n"] === "number" ? (row["n"] as number) : 0
      })()
      const sentCount = ((): number => {
        if (org) {
          const row = db
            .prepare("SELECT COUNT(*) AS n FROM greetings WHERE org_id = ? AND state = 'sent';")
            .get(org) as Record<string, unknown> | undefined
          return typeof row?.["n"] === "number" ? (row["n"] as number) : 0
        }
        const row = db
          .prepare("SELECT COUNT(*) AS n FROM greetings WHERE state = 'sent';")
          .get() as Record<string, unknown> | undefined
        return typeof row?.["n"] === "number" ? (row["n"] as number) : 0
      })()
      return { reserved: reservedCount, sent: sentCount }
    },
    close(): void {
      ;(db as DbLike).close()
    },
  }
}
