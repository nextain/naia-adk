import { createHash, randomBytes } from "node:crypto"
import { spawn } from "node:child_process"
import { constants as fsConstants, readFileSync } from "node:fs"
import { appendFile, chmod, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { AX_AI_FALLBACK_MESSAGE, AX_AI_INPUT_TOO_LONG_MESSAGE, AX_AI_RATE_LIMIT_MESSAGE, countInputChars } from "./ai.js"
import type { AxAiLimits } from "./ai.js"
import type { AxAiLedger } from "./ai-ledger.js"
import type { AxAiFileStore } from "./ai-store.js"
import { AxMessengerError, sanitizeForLog } from "./errors.js"

export const AX_AI_RELAY_RETAIN_MS_DEFAULT = 604_800_000
export const AX_AI_RELAY_RETAIN_MIN_MS = 1_000
export const AX_AI_RELAY_RETAIN_MAX_MS = 7_776_000_000
// 단조 시계(/proc/uptime)를 읽지 못하는 길이나 프로세스 식별이 "모름"인 길에서 적용하는 벽시계 heartbeat 상한:
// 세션 최대 기한(86,400,000ms = 24시간) + 여유(3,600,000ms = 1시간) = 90,000,000ms(25시간).
export const AX_RELAY_LOCK_WALL_CLOCK_MAX_MS = 90_000_000
export const AX_RELAY_LOCK_WALL_CLOCK_RECLAIM_REASON = "단조 값 없음 → 벽시계 상한 회수"
export const AX_RELAY_LOCK_IDENTITY_UNKNOWN_RECLAIM_REASON =
  "식별 모름(identity-unknown) → 벽시계 상한 회수"
export const AX_RELAY_LOCK_BOOT_UNKNOWN_RECLAIM_REASON =
  "부팅 식별 모름(boot-unknown) → 벽시계 상한 회수"
export const AX_RELAY_LOCK_UNREADABLE_RECLAIM_REASON =
  "잠금 파일 읽기·해석 불가(lock-unreadable) → 벽시계 상한 회수"
export const AX_RELAY_LOCK_UNREADABLE_DEFER_REASON =
  "잠금 파일 읽기·해석 불가(lock-unreadable) → 보류"
export const AX_RELAY_LOCK_PGID_UNKNOWN_DEFER_REASON =
  "프로세스 그룹 종료 미확인(pgid-unknown) → 회수·복원 보류"
export const AX_RELAY_REPLIES_SNAPSHOT_UNREADABLE_REASON = "replies-snapshot-unreadable"
export const AX_RELAY_RESTORE_RECORD_UNREADABLE_REASON = "restore-record-unreadable"
export const AX_RELAY_STATE_UNREADABLE_REASON = "state-unreadable"
export const AX_RELAY_LOCK_RM_FAILED_REASON = "lock-rm-failed"
export const AX_RELAY_SESSION_LOG_WRITE_FAILED_REASON = "session-log-write-failed"
export const AX_RELAY_AUDIT_JSONL_CORRUPT_REASON = "audit-jsonl-corrupt"
export const AX_BOOT_ID_UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// 리눅스 커널 fs/proc/array.c task_state_array 및 proc_pid_stat(5) 기준:
// 살아 있음(alive): R(running), S(sleeping), D(disk sleep), T(stopped), t(tracing stop), P(parked), I(idle)
// 죽음 확인(dead): Z(zombie), X(dead)
// 옛 상태 글자 W(리눅스 2.6.0 이전 paging, 2.6.33~3.13 waking)와 x·K(2.6.33~3.13, 3.14 제거) 및 그 밖의 알 수 없는 글자는 망가진 줄(unknown)로 다룬다.
export const AX_PROC_STAT_ALIVE_STATES = ["R", "S", "D", "T", "t", "P", "I"] as const
export const AX_PROC_STAT_DEAD_STATES = ["Z", "X"] as const
const PROC_STAT_ALIVE_STATE_SET = new Set<string>(AX_PROC_STAT_ALIVE_STATES)
const PROC_STAT_DEAD_STATE_SET = new Set<string>(AX_PROC_STAT_DEAD_STATES)

const MINIMAL_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "TZ"] as const

export function buildRelayWakeEnv(
  sourceEnv: NodeJS.ProcessEnv,
  dataDir: string,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of MINIMAL_ENV_KEYS) {
    const value = sourceEnv[key]
    if (typeof value === "string") out[key] = value
  }
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (key.startsWith("AX_RELAY_SESSION_") && typeof value === "string") {
      out[key] = value
    }
  }
  out.AX_MESSENGER_DATA_DIR =
    typeof sourceEnv.AX_MESSENGER_DATA_DIR === "string" && sourceEnv.AX_MESSENGER_DATA_DIR.trim()
      ? sourceEnv.AX_MESSENGER_DATA_DIR
      : path.resolve(dataDir)
  return out
}

// 질문이 staging에 영속화되어 재시도되는 오류다. 호출부가 별도 대체 답을
// 보내면 복구된 답과 겹치므로 이 오류는 보내지 않고 넘긴다.
export class AxRelayPendingError extends Error {
  constructor() { super("릴레이 질문이 복구 대기 중입니다."); this.name = "AxRelayPendingError" }
}
export type RelayConfig = { timeoutMs: number; stableMs: number; retainMs?: number; modelLabel: string; wakeCommand?: string[] }
function secretLike(text: string): boolean { return sanitizeForLog(text, Number.MAX_SAFE_INTEGER) !== text || /\bsk-[A-Za-z0-9_-]+/i.test(text) }
export function loadRelayConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  function number(key: string, fallback: number, min: number, max: number): number {
    const raw = env[key]
    if (raw === undefined) return fallback
    const n = Number(raw)
    if (!raw.trim() || !Number.isInteger(n) || n < min || n > max) throw new Error(`잘못된 릴레이 설정: ${key}`)
    return n
  }
  let wakeCommand: string[] | undefined
  if (env.AX_AI_RELAY_WAKE_CMD !== undefined) {
    try {
      const parsed: unknown = JSON.parse(env.AX_AI_RELAY_WAKE_CMD)
      if (!Array.isArray(parsed) || !parsed.length || !parsed.every((v) => typeof v === "string" && v.length > 0) || !path.isAbsolute(parsed[0])) throw new Error()
      wakeCommand = parsed as string[]
    } catch { throw new Error("잘못된 릴레이 설정: AX_AI_RELAY_WAKE_CMD") }
  }
  const modelLabel = (env.AX_AI_RELAY_MODEL_LABEL ?? "subscription-session").trim()
  if (!modelLabel || secretLike(modelLabel)) throw new Error("잘못된 릴레이 설정: AX_AI_RELAY_MODEL_LABEL")
  return {
    timeoutMs: number("AX_AI_RELAY_TIMEOUT_MS", 900_000, 1_000, 86_400_000),
    stableMs: number("AX_AI_RELAY_STABLE_MS", 8_000, 0, 60_000),
    retainMs: number("AX_AI_RELAY_RETAIN_MS", AX_AI_RELAY_RETAIN_MS_DEFAULT, AX_AI_RELAY_RETAIN_MIN_MS, AX_AI_RELAY_RETAIN_MAX_MS),
    modelLabel,
    wakeCommand,
  }
}
export function relayName(eventId: string): string { return createHash("sha256").update(eventId, "utf8").digest("hex") }
type Row = {
  orgId: string
  roomId: string
  eventId: string
  sender: string
  callId: string
  at: number
  inputSize: number
  state: "pending" | "sent" | "no-answer" | "timeout" | "rejected"
  forwardedLogged?: boolean
  lateLogged?: boolean
  audited?: boolean
  outputSize?: number
  finishedAt?: number
}
type Input = { roomId: string; eventId: string; sender: string; timestamp: number; body: string }
export type AxProcessIdentityStatus = "alive" | "dead" | "unknown"
export type AxBootIdStatus = "same" | "different" | "unknown"

export type AxProcessIdentity = {
  status?: AxProcessIdentityStatus
  alive: boolean | null
  starttime: string
  bootId: string
  state?: string
  stopped?: boolean
}

export type ParsedProcStat = {
  valid: boolean
  status: AxProcessIdentityStatus
  alive: boolean | null
  state: string
  stopped: boolean
  starttime: string
}

export type ReadProcessIdentityOptions = {
  readProcStat?: (pid: number) => string
  kill0?: (pid: number) => void
  readBootId?: () => string
}

export type SessionLockEvaluation = {
  active: boolean
  stale: boolean
  pid: number
  pgid: number
  workDir: string | null
  pidIdentityMatched: boolean
  sameBoot: boolean
  bootStatus: AxBootIdStatus
  bootUnknown: boolean
  procStatus: AxProcessIdentityStatus
  procState: string
  procStopped: boolean
  identityUnknown: boolean
  legacyCompat: boolean
  noMonotonicWallClockReclaim: boolean
  reclaimReason: string | null
}

type Options = {
  dataDir: string; orgId: string; limits: AxAiLimits; ledger: AxAiLedger; store: AxAiFileStore; config: RelayConfig;
  sendText: (roomId: string, body: string, txnId: string, content: Record<string, unknown>) => Promise<void>;
  log?: (line: string) => void; now?: () => number; uptimeMs?: () => number | null;
  procIdentity?: (pid: number) => AxProcessIdentity; readProcStat?: (pid: number) => string;
  kill0?: (pid: number) => void; readBootId?: () => string;
  readLockFile?: (lockPath: string) => Promise<{ body: string; opened: { ino: number; mtimeMs: number } }> | { body: string; opened: { ino: number; mtimeMs: number } };
  lstatLockFile?: (lockPath: string) => Promise<{ ino?: number; mtimeMs: number }> | { ino?: number; mtimeMs: number };
  readRestoreFile?: (restorePath: string) => Promise<{ body: string } | string> | { body: string } | string;
  readStateFile?: (statePath: string) => Promise<{ body: string }> | { body: string };
  env?: NodeJS.ProcessEnv
}

async function hasJsonlRecord(
  filePath: string,
  match: (row: Record<string, unknown>) => boolean,
  onCorrupt?: (filePath: string, error: unknown, line: number) => Promise<void> | void,
): Promise<{ matched: boolean; corrupt: boolean; unterminated: boolean }> {
  let raw = ""
  try {
    raw = await readFile(filePath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return { matched: false, corrupt: false, unterminated: false }
    throw error
  }
  let matched = false
  let corrupt = false
  const lines = raw.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try { parsed = JSON.parse(trimmed) } catch {
      const parseErr = new Error("감사 JSONL 줄 해석 오류") as NodeJS.ErrnoException
      parseErr.code = "EJSONPARSE"
      corrupt = true
      if (onCorrupt) await onCorrupt(filePath, parseErr, i + 1)
      continue
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      const shapeErr = new Error("감사 JSONL 줄 꼴 오류") as NodeJS.ErrnoException
      shapeErr.code = "ESHAPE"
      corrupt = true
      if (onCorrupt) await onCorrupt(filePath, shapeErr, i + 1)
      continue
    }
    if (match(parsed as Record<string, unknown>)) matched = true
  }
  return { matched, corrupt, unterminated: raw.length > 0 && !raw.endsWith("\n") }
}

async function readRegularFileNoFollow(filePath: string) {
  const before = await lstat(filePath)
  if (before.isSymbolicLink() || !before.isFile()) {
    const err = new Error("보통 파일이 아닙니다.") as NodeJS.ErrnoException
    err.code = "ENOTREGULAR"
    throw err
  }
  if (typeof process.getuid === "function" && before.uid !== process.getuid()) {
    const err = new Error("파일 소유자가 다릅니다.") as NodeJS.ErrnoException
    err.code = "EOWNER"
    throw err
  }
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (opened.isSymbolicLink() || !opened.isFile() || opened.ino !== before.ino) {
      const err = new Error("열린 파일이 보통 파일이 아닙니다.") as NodeJS.ErrnoException
      err.code = "ENOTREGULAR"
      throw err
    }
    if (typeof process.getuid === "function" && opened.uid !== process.getuid()) {
      const err = new Error("열린 파일 소유자가 다릅니다.") as NodeJS.ErrnoException
      err.code = "EOWNER"
      throw err
    }
    const body = await handle.readFile({ encoding: "utf8" })
    const after = await handle.stat()
    return { body, before, opened, after }
  } finally {
    await handle.close()
  }
}

async function checkReadyMarkerNoFollow(readyPath: string): Promise<"missing" | "ready" | "invalid"> {
  let st
  try {
    st = await lstat(readyPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"
    throw error
  }
  if (st.isSymbolicLink() || !st.isFile()) return "invalid"
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) return "invalid"
  let handle
  try {
    handle = await open(readyPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const opened = await handle.stat()
    if (opened.isSymbolicLink() || !opened.isFile() || opened.ino !== st.ino) return "invalid"
    if (typeof process.getuid === "function" && opened.uid !== process.getuid()) return "invalid"
    return "ready"
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return "missing"
    if (code === "ELOOP" || code === "EISDIR" || code === "ENOTREGULAR" || code === "EOWNER") return "invalid"
    throw error
  } finally {
    if (handle) await handle.close()
  }
}

export function normalizeBootId(value: unknown): string {
  if (typeof value !== "string") return ""
  const normalized = value.replace(/^[\s\r\n]+|[\s\r\n]+$/g, "").toLowerCase()
  return AX_BOOT_ID_UUID_REGEX.test(normalized) ? normalized : ""
}

export function isValidBootId(value: unknown): boolean {
  return normalizeBootId(value) !== ""
}

export function checkProcessGroupStatus(
  pgid: number,
  kill0?: (pid: number) => void,
): AxProcessIdentityStatus {
  if (!Number.isInteger(pgid) || pgid <= 0) return "dead"
  try {
    if (kill0) kill0(-pgid)
    process.kill(-pgid, 0)
    return "alive"
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === "ESRCH") return "dead"
    if (code === "EPERM") return "alive"
    return "unknown"
  }
}

export function isProcessGroupAlive(
  pgid: number,
  kill0?: (pid: number) => void,
): boolean {
  return checkProcessGroupStatus(pgid, kill0) !== "dead"
}

export function isValidSessionLockShape(parsed: unknown): parsed is Record<string, unknown> {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false
  const obj = parsed as Record<string, unknown>
  if (typeof obj.pid !== "number" || !Number.isInteger(obj.pid) || obj.pid <= 0) return false
  if (typeof obj.at !== "number" || !Number.isFinite(obj.at) || obj.at <= 0) return false
  if (
    obj.heartbeatAt !== undefined &&
    (typeof obj.heartbeatAt !== "number" || !Number.isFinite(obj.heartbeatAt) || obj.heartbeatAt <= 0)
  ) {
    return false
  }
  if (
    obj.pgid !== undefined &&
    (typeof obj.pgid !== "number" || !Number.isInteger(obj.pgid) || obj.pgid < 0)
  ) {
    return false
  }
  if (
    obj.heartbeatUptimeMs !== undefined &&
    obj.heartbeatUptimeMs !== null &&
    (typeof obj.heartbeatUptimeMs !== "number" ||
      !Number.isFinite(obj.heartbeatUptimeMs) ||
      obj.heartbeatUptimeMs < 0)
  ) {
    return false
  }
  return true
}

export function parseProcStatLine(statText: string): ParsedProcStat {
  if (typeof statText !== "string") {
    return { valid: false, status: "unknown", alive: null, state: "", stopped: false, starttime: "" }
  }
  const openParen = statText.indexOf("(")
  const closeParen = statText.lastIndexOf(")")
  if (openParen <= 0 || closeParen <= openParen) {
    return { valid: false, status: "unknown", alive: null, state: "", stopped: false, starttime: "" }
  }
  const pidPrefix = statText.slice(0, openParen).trim()
  if (!/^\d+$/.test(pidPrefix) || Number(pidPrefix) <= 0) {
    return { valid: false, status: "unknown", alive: null, state: "", stopped: false, starttime: "" }
  }
  const afterParen = statText.slice(closeParen + 1)
  if (!/^\s+/.test(afterParen)) {
    return { valid: false, status: "unknown", alive: null, state: "", stopped: false, starttime: "" }
  }
  const fields = afterParen.trim().split(/\s+/)
  const stateChar = fields[0] ?? ""
  // /proc/<pid>/stat 의 22번째 칸(starttime): 2번째 칸 (comm) 뒤 fields[0] 이 3번째 칸이므로 fields[19] 가 22번째 칸이다.
  const starttime = fields[19] ?? ""
  const isKnownState =
    PROC_STAT_ALIVE_STATE_SET.has(stateChar) || PROC_STAT_DEAD_STATE_SET.has(stateChar)
  if (!isKnownState || !/^\d+$/.test(starttime)) {
    return {
      valid: false,
      status: "unknown",
      alive: null,
      state: /^[A-Za-z]$/.test(stateChar) ? stateChar : "",
      stopped: false,
      starttime: "",
    }
  }
  if (PROC_STAT_DEAD_STATE_SET.has(stateChar)) {
    return { valid: true, status: "dead", alive: false, state: stateChar, stopped: false, starttime }
  }
  const stopped = stateChar === "T" || stateChar === "t"
  return { valid: true, status: "alive", alive: true, state: stateChar, stopped, starttime }
}

export function readProcessIdentity(
  pid: number,
  options?: ReadProcessIdentityOptions,
): AxProcessIdentity {
  let bootId = ""
  try {
    const rawBoot = String(
      options?.readBootId
        ? options.readBootId()
        : readFileSync("/proc/sys/kernel/random/boot_id", "utf8"),
    )
    bootId = normalizeBootId(rawBoot)
  } catch { /* ignore */ }
  if (!Number.isInteger(pid) || pid <= 0) {
    return { status: "dead", alive: false, starttime: "", bootId, state: "", stopped: false }
  }
  try {
    if (options?.kill0) {
      options.kill0(pid)
    } else {
      process.kill(pid, 0)
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === "ESRCH") {
      return { status: "dead", alive: false, starttime: "", bootId, state: "", stopped: false }
    }
    if (code !== "EPERM") {
      return { status: "unknown", alive: true, starttime: "", bootId, state: "", stopped: false }
    }
  }
  try {
    const statText = options?.readProcStat
      ? options.readProcStat(pid)
      : readFileSync(`/proc/${pid}/stat`, "utf8")
    const parsed = parseProcStatLine(statText)
    if (!parsed.valid || parsed.status === "unknown") {
      return { status: "unknown", alive: true, starttime: "", bootId, state: parsed.state, stopped: false }
    }
    if (parsed.status === "dead" || !parsed.alive) {
      return { status: "dead", alive: false, starttime: parsed.starttime, bootId, state: parsed.state, stopped: false }
    }
    return {
      status: "alive",
      alive: true,
      starttime: parsed.starttime,
      bootId,
      state: parsed.state,
      stopped: parsed.stopped,
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === "ENOENT" || code === "ESRCH") {
      return { status: "dead", alive: false, starttime: "", bootId, state: "", stopped: false }
    }
    return { status: "unknown", alive: true, starttime: "", bootId, state: "", stopped: false }
  }
}

export function readUptimeMs(procUptimePath = "/proc/uptime"): number | null {
  try {
    const raw = readFileSync(procUptimePath, "utf8").trim()
    if (!raw) return null
    const firstField = raw.split(/\s+/)[0] ?? ""
    if (!firstField) return null
    const seconds = Number(firstField)
    if (!Number.isFinite(seconds) || seconds < 0) return null
    return Math.round(seconds * 1000)
  } catch {
    return null
  }
}

export function evaluateSessionLockPayload(
  parsed: Record<string, unknown> | null | undefined,
  procInput: AxProcessIdentity,
  options: {
    selfBootId?: string
    nowMs: number
    currentUptimeMs: number | null
    defaultTimeoutMs: number
    wallClockMaxMs?: number
    lockMtimeMs?: number | null
  },
): SessionLockEvaluation {
  const wallClockMaxMs = options.wallClockMaxMs ?? AX_RELAY_LOCK_WALL_CLOCK_MAX_MS
  const validShape = isValidSessionLockShape(parsed)
  const pid =
    typeof parsed?.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0
      ? parsed.pid
      : 0
  const pgid =
    typeof parsed?.pgid === "number" && Number.isInteger(parsed.pgid) && parsed.pgid > 0
      ? parsed.pgid
      : 0
  const workDir = typeof parsed?.workDir === "string" ? parsed.workDir : null
  const lockAt = typeof parsed?.at === "number" ? parsed.at : 0
  const heartbeatAt = typeof parsed?.heartbeatAt === "number" ? parsed.heartbeatAt : lockAt
  const timeoutLimit =
    typeof parsed?.timeoutMs === "number" && Number.isFinite(parsed.timeoutMs) && parsed.timeoutMs > 0
      ? parsed.timeoutMs
      : options.defaultTimeoutMs
  const heartbeatStaleLimit =
    typeof parsed?.heartbeatStaleMs === "number" &&
    Number.isFinite(parsed.heartbeatStaleMs) &&
    parsed.heartbeatStaleMs > 0
      ? parsed.heartbeatStaleMs
      : Math.min(timeoutLimit, 10_000)

  const procState = typeof procInput?.state === "string" ? procInput.state : ""
  let procStatus: AxProcessIdentityStatus
  if (!validShape || pid <= 0) {
    procStatus = "unknown"
  } else if (
    procInput?.status === "dead" ||
    PROC_STAT_DEAD_STATE_SET.has(procState) ||
    procInput?.alive === false
  ) {
    procStatus = "dead"
  } else if (
    procInput?.status === "unknown" ||
    procInput?.alive === null ||
    typeof procInput?.starttime !== "string" ||
    !/^\d+$/.test(procInput.starttime.trim()) ||
    (procState !== "" && !PROC_STAT_ALIVE_STATE_SET.has(procState))
  ) {
    procStatus = "unknown"
  } else {
    procStatus = "alive"
  }
  const procStopped =
    procStatus === "alive" && Boolean(procInput?.stopped || procState === "T" || procState === "t")

  const rawStarttime = parsed?.starttime ?? parsed?.startTime
  const rawBootId = parsed?.boot_id ?? parsed?.bootId
  const rawHeartbeatUptime = parsed?.heartbeatUptimeMs
  const legacyCompat = rawHeartbeatUptime === undefined

  const lockStarttime =
    (typeof rawStarttime === "string" || typeof rawStarttime === "number") &&
    /^\d+$/.test(String(rawStarttime).trim())
      ? String(rawStarttime).trim()
      : ""
  const hasBothBootFields = parsed?.boot_id !== undefined && parsed?.bootId !== undefined
  const normBootField1 = normalizeBootId(parsed?.boot_id)
  const normBootField2 = normalizeBootId(parsed?.bootId)
  const dualBootMismatch =
    hasBothBootFields &&
    (!normBootField1 || !normBootField2 || normBootField1 !== normBootField2)
  const lockBootId = !dualBootMismatch ? normalizeBootId(rawBootId) : ""
  const rawRefBootId = options.selfBootId !== undefined ? options.selfBootId : procInput?.bootId
  const refBootId = normalizeBootId(rawRefBootId)
  const bootStatus: AxBootIdStatus =
    lockBootId && refBootId
      ? lockBootId === refBootId
        ? "same"
        : "different"
      : "unknown"
  const bootUnknown = bootStatus === "unknown"
  const sameBoot = bootStatus !== "different"

  const validMtime =
    typeof options.lockMtimeMs === "number" &&
    Number.isFinite(options.lockMtimeMs) &&
    options.lockMtimeMs > 0
  const mtimeAge = validMtime
    ? options.nowMs >= (options.lockMtimeMs as number)
      ? options.nowMs - (options.lockMtimeMs as number)
      : 0
    : 0

  if (!validShape) {
    const validHeartbeatAt = Number.isFinite(heartbeatAt) && heartbeatAt > 0
    const validLockAt = Number.isFinite(lockAt) && lockAt > 0
    const wallHeartbeatAge = validHeartbeatAt
      ? options.nowMs >= heartbeatAt
        ? options.nowMs - heartbeatAt
        : 0
      : mtimeAge
    const wallLockAge = validLockAt
      ? options.nowMs >= lockAt
        ? options.nowMs - lockAt
        : 0
      : wallHeartbeatAge
    const exceededWallMax =
      wallHeartbeatAge >= wallClockMaxMs ||
      wallLockAge >= wallClockMaxMs ||
      mtimeAge >= wallClockMaxMs
    if (exceededWallMax) {
      return {
        active: false,
        stale: true,
        pid,
        pgid,
        workDir,
        pidIdentityMatched: true,
        sameBoot: true,
        bootStatus: "unknown",
        bootUnknown: true,
        procStatus: "unknown",
        procState,
        procStopped: false,
        identityUnknown: true,
        legacyCompat,
        noMonotonicWallClockReclaim: true,
        reclaimReason: AX_RELAY_LOCK_UNREADABLE_RECLAIM_REASON,
      }
    }
    return {
      active: true,
      stale: false,
      pid,
      pgid,
      workDir,
      pidIdentityMatched: true,
      sameBoot: true,
      bootStatus: "unknown",
      bootUnknown: true,
      procStatus: "unknown",
      procState,
      procStopped: false,
      identityUnknown: true,
      legacyCompat,
      noMonotonicWallClockReclaim: false,
      reclaimReason: null,
    }
  }

  // 1. 죽음 확인(ESRCH, /proc/<pid> ENOENT, 상태 글자 Z·X) 또는
  //    양쪽 boot_id 가 모두 정상 UUID 로 읽혔고(소문자 비교) 서로 다른 경우(이전 부팅의 잠금): 즉시 회수
  if (procStatus === "dead" || bootStatus === "different") {
    return {
      active: false,
      stale: true,
      pid,
      pgid,
      workDir,
      pidIdentityMatched: false,
      sameBoot,
      bootStatus,
      bootUnknown: false,
      procStatus,
      procState,
      procStopped: false,
      identityUnknown: false,
      legacyCompat: rawStarttime === undefined && rawBootId === undefined,
      noMonotonicWallClockReclaim: false,
      reclaimReason: null,
    }
  }

  // 2. 살아 있고 stat 줄이 정상(alive)이며 잠금 starttime 도 정상 숫자인데 서로 다른 경우(PID 재사용): 즉시 회수
  if (procStatus === "alive" && lockStarttime && procInput.starttime.trim() !== lockStarttime) {
    return {
      active: false,
      stale: true,
      pid,
      pgid,
      workDir,
      pidIdentityMatched: false,
      sameBoot,
      bootStatus,
      bootUnknown,
      procStatus,
      procState,
      procStopped,
      identityUnknown: false,
      legacyCompat: false,
      noMonotonicWallClockReclaim: false,
      reclaimReason: null,
    }
  }

  // 3. 프로세스 식별이 "모름"(kill 기타 오류, stat 읽기 실패, 망가진 줄/알 수 없는 상태 글자, 잠금 starttime 없음/깨짐)이거나
  //    boot_id 가 "모름"(지금 boot_id 읽기 실패 또는 잠금 boot_id 없음/UUID 아님)인 경우:
  //    식별 불일치나 이전 부팅으로 보지 않고 25시간 벽시계 상한(wallClockMaxMs) 안에서는 잠금과 replies 0500 을 유지하며,
  //    상한을 넘으면 회수·복원하고 감사 사유에 identity-unknown 또는 boot-unknown 을 구별해 남긴다.
  if (procStatus === "unknown" || bootUnknown || !lockStarttime) {
    const validHeartbeatAt = Number.isFinite(heartbeatAt) && heartbeatAt > 0
    const validLockAt = Number.isFinite(lockAt) && lockAt > 0
    const wallHeartbeatAge = validHeartbeatAt
      ? options.nowMs >= heartbeatAt
        ? options.nowMs - heartbeatAt
        : 0
      : mtimeAge
    const wallLockAge = validLockAt
      ? options.nowMs >= lockAt
        ? options.nowMs - lockAt
        : 0
      : wallHeartbeatAge
    const exceededWallMax =
      wallHeartbeatAge >= wallClockMaxMs ||
      wallLockAge >= wallClockMaxMs ||
      mtimeAge >= wallClockMaxMs
    const reclaimReason =
      bootUnknown && procStatus !== "unknown" && Boolean(lockStarttime)
        ? AX_RELAY_LOCK_BOOT_UNKNOWN_RECLAIM_REASON
        : AX_RELAY_LOCK_IDENTITY_UNKNOWN_RECLAIM_REASON
    if (exceededWallMax) {
      return {
        active: false,
        stale: true,
        pid,
        pgid,
        workDir,
        pidIdentityMatched: true,
        sameBoot: true,
        bootStatus,
        bootUnknown,
        procStatus,
        procState,
        procStopped: false,
        identityUnknown: true,
        legacyCompat,
        noMonotonicWallClockReclaim: true,
        reclaimReason,
      }
    }
    return {
      active: true,
      stale: false,
      pid,
      pgid,
      workDir,
      pidIdentityMatched: true,
      sameBoot: true,
      bootStatus,
      bootUnknown,
      procStatus,
      procState,
      procStopped: false,
      identityUnknown: true,
      legacyCompat,
      noMonotonicWallClockReclaim: false,
      reclaimReason: null,
    }
  }

  // 4. 살아 있음(alive) + 같은 부팅(same) + 같은 starttime 확인된 정상 잠금:
  //    잠금·읽는 쪽 모두 단조 값(heartbeatUptimeMs)이 있으면 18회차 그대로 단조 값 차이로만 오래됨을 판단하고 벽시계는 보지 않는다.
  if (
    typeof rawHeartbeatUptime === "number" &&
    Number.isFinite(rawHeartbeatUptime) &&
    rawHeartbeatUptime >= 0
  ) {
    const currentUptimeMs = options.currentUptimeMs
    if (
      typeof currentUptimeMs === "number" &&
      Number.isFinite(currentUptimeMs) &&
      currentUptimeMs >= 0
    ) {
      const heartbeatAge =
        currentUptimeMs >= rawHeartbeatUptime ? currentUptimeMs - rawHeartbeatUptime : 0
      const stale = heartbeatAge >= heartbeatStaleLimit
      return {
        active: !stale,
        stale,
        pid,
        pgid,
        workDir,
        pidIdentityMatched: true,
        sameBoot: true,
        bootStatus: "same",
        bootUnknown: false,
        procStatus,
        procState,
        procStopped,
        identityUnknown: false,
        legacyCompat: false,
        noMonotonicWallClockReclaim: false,
        reclaimReason: null,
      }
    }
  }

  // 5. 단조 값이 없는 길(잠금에 heartbeatUptimeMs 칸이 없거나 null 이거나 읽는 쪽이 /proc/uptime 을 못 읽는 경우):
  //    칸이 없는 옛 꼴 잠금도 legacyCompat 기록은 남기되 null 과 같게 벽시계 상한(wallClockMaxMs) 규칙으로 판정한다.
  //    T·t 멈춤 상태는 잠깐 멈췄다가 재개될 수 있으므로 멈춤만으로 즉시 회수하지 않고 벽시계 상한과 함께 판단한다.
  const validHeartbeatAt = Number.isFinite(heartbeatAt) && heartbeatAt > 0
  const validLockAt = Number.isFinite(lockAt) && lockAt > 0
  const wallHeartbeatAge = validHeartbeatAt
    ? options.nowMs >= heartbeatAt
      ? options.nowMs - heartbeatAt
      : 0
    : mtimeAge
  const wallLockAge = validLockAt
    ? options.nowMs >= lockAt
      ? options.nowMs - lockAt
      : 0
    : wallHeartbeatAge
  const exceededWallMax =
    wallHeartbeatAge >= wallClockMaxMs ||
    wallLockAge >= wallClockMaxMs ||
    mtimeAge >= wallClockMaxMs
  if (exceededWallMax) {
    return {
      active: false,
      stale: true,
      pid,
      pgid,
      workDir,
      pidIdentityMatched: true,
      sameBoot: true,
      bootStatus: "same",
      bootUnknown: false,
      procStatus,
      procState,
      procStopped,
      identityUnknown: false,
      legacyCompat,
      noMonotonicWallClockReclaim: true,
      reclaimReason: AX_RELAY_LOCK_WALL_CLOCK_RECLAIM_REASON,
    }
  }
  return {
    active: true,
    stale: false,
    pid,
    pgid,
    workDir,
    pidIdentityMatched: true,
    sameBoot: true,
    bootStatus: "same",
    bootUnknown: false,
    procStatus,
    procState,
    procStopped,
    identityUnknown: false,
    legacyCompat,
    noMonotonicWallClockReclaim: false,
    reclaimReason: null,
  }
}

export function createSessionRelay(options: Options) {
  const { dataDir, orgId, limits, ledger, store, config, sendText } = options
  const retainMs = config.retainMs ?? AX_AI_RELAY_RETAIN_MS_DEFAULT
  const root = path.join(dataDir, "relay"), inbox = path.join(root, "inbox"), replies = path.join(root, "replies"), states = path.join(root, "state"), rejected = path.join(root, "rejected"), staging = path.join(root, "staging"), sessionOut = path.join(root, "session-out"), sessionWork = path.join(root, "session-work")
  const procIdentityOpts =
    options.readProcStat || options.kill0 || options.readBootId
      ? {
          ...(options.readProcStat ? { readProcStat: options.readProcStat } : {}),
          ...(options.kill0 ? { kill0: options.kill0 } : {}),
          ...(options.readBootId ? { readBootId: options.readBootId } : {}),
        }
      : undefined
  const now = options.now ?? Date.now,
    getUptimeMs = options.uptimeMs ?? (() => readUptimeMs()),
    getProcIdentity =
      options.procIdentity ??
      ((pid: number) => readProcessIdentity(pid, procIdentityOpts)),
    readLockFn = options.readLockFile ?? ((p: string) => readRegularFileNoFollow(p)),
    lstatLockFn = options.lstatLockFile ?? ((p: string) => lstat(p)),
    readRestoreFn = options.readRestoreFile ?? ((p: string) => readRegularFileNoFollow(p)),
    readStateFn = options.readStateFile ?? ((p: string) => readRegularFileNoFollow(p)),
    log = options.log ?? (() => {}),
    env = options.env ?? process.env
  let polling = false
  let lastWallClockReclaimSig = ""
  let lastDeadLockSig = ""
  let lastLockUnreadableSig = ""
  let lastRestoreDeferredSig = ""
  const inFlight = new Set<string>()
  const fileErrors = new Map<string, string>()

  async function reportFileError(scope: string, filePath: string, error: unknown, line?: number) {
    let statSig = "nostat"
    try {
      const st = await lstat(filePath)
      statSig = `${st.mode}:${st.size}:${st.mtimeMs}:${st.ino}`
    } catch { /* ignore */ }
    const rawCode = (error as NodeJS.ErrnoException | null)?.code
    const code =
      rawCode ??
      (error instanceof SyntaxError
        ? "EJSONPARSE"
        : error instanceof Error
          ? error.name
          : "Error")
    const sig = `${scope}:${code}:${statSig}`
    const errorKey = line === undefined ? filePath : `${filePath}:${line}`
    if (fileErrors.get(errorKey) === sig) return
    fileErrors.set(errorKey, sig)
    const safeCode = sanitizeForLog(String(code), 40)
    log(`nextain-ai: relay ${scope} file error file=${path.basename(filePath)} code=${safeCode}`)
    if (scope === "state") {
      await writeBotSessionLogEntry({
        event: "state-unreadable",
        actor: "bot",
        action: "skipped",
        file: path.basename(filePath),
        reason: AX_RELAY_STATE_UNREADABLE_REASON,
        errorCode: safeCode,
        at: now(),
      })
    } else if (scope === "audit-jsonl") {
      await writeBotSessionLogEntry({
        event: "audit-jsonl-corrupt",
        actor: "bot",
        action: "detected",
        file: path.basename(filePath),
        line,
        reason: AX_RELAY_AUDIT_JSONL_CORRUPT_REASON,
        errorCode: safeCode,
        at: now(),
      })
    }
  }

  async function writeBotSessionLogEntry(entry: Record<string, unknown>) {
    const sessionLogPath = path.join(root, "session-log.jsonl")
    try {
      await mkdir(root, { recursive: true, mode: 0o700 })
      try {
        const st = await lstat(sessionLogPath)
        if (st.isSymbolicLink() || !st.isFile()) {
          const err = new Error("session-log.jsonl 이 보통 파일이 아닙니다.") as NodeJS.ErrnoException
          err.code = "ENOTREGULAR"
          throw err
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error
      }
      await appendFile(sessionLogPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 })
      await chmod(sessionLogPath, 0o600)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code ?? "EWRITE"
      log(
        `nextain-ai: relay session-log write failed code=${sanitizeForLog(String(code), 40)} reason=${AX_RELAY_SESSION_LOG_WRITE_FAILED_REASON}`,
      )
    }
  }

  async function appendBotLockReclaimAudit(evalResult: SessionLockEvaluation, lockSig: string) {
    if (lastWallClockReclaimSig === lockSig) return
    lastWallClockReclaimSig = lockSig
    const reason = evalResult.reclaimReason ?? AX_RELAY_LOCK_WALL_CLOCK_RECLAIM_REASON
    log(`nextain-ai: relay lock reclaim pid=${evalResult.pid} state=${evalResult.procState || "unknown"} reason=${reason}`)
    await writeBotSessionLogEntry({
      event: "lock-reclaim",
      actor: "bot",
      action: "reclaimed",
      pid: evalResult.pid,
      procState: evalResult.procState,
      lockReclaimReason: reason,
      ...(evalResult.reclaimReason === AX_RELAY_LOCK_UNREADABLE_RECLAIM_REASON
        ? { reason: "lock-unreadable" }
        : {}),
      ...(evalResult.identityUnknown ? { lockIdentityStatus: "unknown" } : {}),
      ...(evalResult.bootUnknown ? { lockBootStatus: "unknown" } : {}),
      ...(evalResult.legacyCompat ? { legacyLockCompat: "stale" } : {}),
      at: now(),
    })
  }

  async function appendBotLockUnreadableAudit(errorCode: string, lockSig: string) {
    if (lastLockUnreadableSig === lockSig) return
    lastLockUnreadableSig = lockSig
    log(
      `nextain-ai: relay lock unreadable reason=lock-unreadable code=${sanitizeForLog(errorCode, 40)}`,
    )
    await writeBotSessionLogEntry({
      event: "lock-unreadable",
      actor: "bot",
      action: "deferred",
      reason: "lock-unreadable",
      errorCode: sanitizeForLog(errorCode, 40),
      lockIdentityStatus: "unknown",
      lockReclaimReason: AX_RELAY_LOCK_UNREADABLE_DEFER_REASON,
      at: now(),
    })
  }

  async function inspectSessionLock(): Promise<{ active: boolean; unreadableDeferred: boolean }> {
    const lockPath = path.join(root, "session.lock")
    let body = ""
    let opened: { ino: number; mtimeMs: number } | null = null
    let readErr: unknown = null
    try {
      const res = await readLockFn(lockPath)
      body = res.body
      opened = res.opened
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
        return { active: false, unreadableDeferred: false }
      }
      readErr = error
    }

    let parsed: unknown = null
    let parseErr: unknown = null
    if (!readErr) {
      try {
        parsed = JSON.parse(body)
      } catch (error) {
        parseErr = error
      }
    }

    if (readErr || parseErr || !isValidSessionLockShape(parsed)) {
      let mtimeMs: number | null = opened ? opened.mtimeMs : null
      let ino = opened ? opened.ino : 0
      if (mtimeMs === null) {
        try {
          const st = await lstatLockFn(lockPath)
          if (typeof st?.mtimeMs === "number" && Number.isFinite(st.mtimeMs) && st.mtimeMs > 0) {
            mtimeMs = st.mtimeMs
          }
          if (typeof st?.ino === "number") ino = st.ino
        } catch (lstatError) {
          if ((lstatError as NodeJS.ErrnoException | null)?.code === "ENOENT") {
            return { active: false, unreadableDeferred: false }
          }
          mtimeMs = null
        }
      }
      const errObj = readErr ?? parseErr
      const errorCode = readErr
        ? String((errObj as NodeJS.ErrnoException | null)?.code ?? "EREAD")
        : parseErr
          ? "EJSONPARSE"
          : "ESHAPE"
      const currentNow = now()
      const exceededWallMax =
        mtimeMs !== null &&
        currentNow >= mtimeMs &&
        currentNow - mtimeMs >= AX_RELAY_LOCK_WALL_CLOCK_MAX_MS
      if (exceededWallMax) {
        const evalResult: SessionLockEvaluation = {
          active: false,
          stale: true,
          pid: 0,
          pgid: 0,
          workDir: null,
          pidIdentityMatched: true,
          sameBoot: true,
          bootStatus: "unknown",
          bootUnknown: true,
          procStatus: "unknown",
          procState: "",
          procStopped: false,
          identityUnknown: true,
          legacyCompat: false,
          noMonotonicWallClockReclaim: true,
          reclaimReason: AX_RELAY_LOCK_UNREADABLE_RECLAIM_REASON,
        }
        const lockSig = `unreadable:${ino}:${mtimeMs}:${errorCode}:reclaim`
        await appendBotLockReclaimAudit(evalResult, lockSig)
        return { active: false, unreadableDeferred: false }
      }
      const lockSig = `unreadable:${ino}:${mtimeMs ?? "nostat"}:${errorCode}:defer`
      await appendBotLockUnreadableAudit(errorCode, lockSig)
      return { active: true, unreadableDeferred: true }
    }

    const pid = parsed.pid as number
    const proc = getProcIdentity(pid)
    const evalResult = evaluateSessionLockPayload(parsed, proc, {
      nowMs: now(),
      currentUptimeMs: getUptimeMs(),
      defaultTimeoutMs: config.timeoutMs,
      lockMtimeMs: opened?.mtimeMs ?? null,
    })
    if (evalResult.legacyCompat) {
      log(`nextain-ai: relay lock legacy-compat pid=${pid} active=${evalResult.active}`)
    }
    if (evalResult.noMonotonicWallClockReclaim) {
      const lockSig = `${opened?.ino ?? 0}:${opened?.mtimeMs ?? 0}:${pid}:${evalResult.procState}:${evalResult.reclaimReason ?? ""}`
      await appendBotLockReclaimAudit(evalResult, lockSig)
    } else if (evalResult.stale && evalResult.procStatus === "dead") {
      const lockSig = `${opened?.ino ?? 0}:${opened?.mtimeMs ?? 0}:${pid}:${evalResult.procState}`
      if (lastDeadLockSig !== lockSig) {
        lastDeadLockSig = lockSig
        log(`nextain-ai: relay dead lock observed pid=${pid} state=${evalResult.procState || "dead"}`)
      }
    }
    return { active: evalResult.active, unreadableDeferred: false }
  }

  async function hasActiveSessionLock(): Promise<boolean> {
    const res = await inspectSessionLock()
    return res.active
  }

  async function canApplyDefaultRepliesMode(): Promise<boolean> {
    const restorePath = path.join(root, "session-restore.json")
    let raw = ""
    let errorCode = ""
    try {
      const loaded = await readRestoreFn(restorePath)
      raw = typeof loaded === "string" ? loaded : loaded.body
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown> | null
        if (
          !parsed ||
          typeof parsed !== "object" ||
          Array.isArray(parsed) ||
          typeof parsed.repliesMode !== "number" ||
          !Number.isInteger(parsed.repliesMode) ||
          parsed.repliesMode < 0 ||
          parsed.repliesMode > 0o777 ||
          (parsed.repliesMode & 0o700) !== 0o700
        ) {
          errorCode = "ESHAPE"
        } else {
          errorCode = "EEXIST"
        }
      } catch {
        errorCode = "EJSONPARSE"
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === "ENOENT") {
        lastRestoreDeferredSig = ""
        return true
      }
      errorCode = String(code ?? "EREAD")
    }
    let statSig = "nostat"
    try {
      const st = await lstat(restorePath)
      statSig = `${st.mode}:${st.size}:${st.mtimeMs}:${st.ino}`
    } catch { /* ignore */ }
    const safeCode = sanitizeForLog(errorCode, 40)
    const sig = `restore-record:${safeCode}:${statSig}`
    if (!polling || lastRestoreDeferredSig !== sig) {
      lastRestoreDeferredSig = sig
      const line = `nextain-ai: relay restore record unreadable actor=bot phase=init code=${safeCode} reason=${AX_RELAY_RESTORE_RECORD_UNREADABLE_REASON}`
      log(line)
      process.stderr.write(`${line}\n`)
      await writeBotSessionLogEntry({
        event: "restore-record",
        actor: "bot",
        action: "deferred",
        phase: "init",
        reason: AX_RELAY_RESTORE_RECORD_UNREADABLE_REASON,
        errorCode: safeCode,
        at: now(),
      })
    }
    return false
  }

  async function init() {
    const locked = await hasActiveSessionLock()
    for (const dir of [root, inbox, replies, states, rejected, staging]) {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      if (dir === replies) {
        if (locked) continue
        if (!(await canApplyDefaultRepliesMode())) continue
      }
      await chmod(dir, 0o700)
    }
  }
  async function atomic(file: string, content: string) {
    const tmp = `${file}.${randomBytes(8).toString("hex")}.tmp`
    await writeFile(tmp, content, { encoding: "utf8", mode: 0o600, flag: "wx" })
    await rename(tmp, file)
  }
  async function save(row: Row) { await atomic(path.join(states, `${relayName(row.eventId)}.json`), `${JSON.stringify(row)}\n`) }
  async function checkAuditJsonl(filePath: string, match: (row: Record<string, unknown>) => boolean) {
    return hasJsonlRecord(filePath, match, (fp, err, line) => reportFileError("audit-jsonl", fp, err, line))
  }
  async function prepareAuditAppend(filePath: string, check: { corrupt: boolean; unterminated: boolean }, row: Row, type: string) {
    if (check.corrupt) await writeBotSessionLogEntry({ event: "possible-duplicate", actor: "bot", action: "append", file: path.basename(filePath), type, callId: row.callId, at: now() })
    if (check.unterminated) await appendFile(filePath, "\n", { encoding: "utf8", mode: 0o600 })
  }
  async function usage(row: Row, status: string, outputSize = 0) {
    const check = await checkAuditJsonl(store.usageFile, (r) => r.type === "ai-usage" && r.callId === row.callId && r.status === status)
    if (check.matched) return
    await prepareAuditAppend(store.usageFile, check, row, "ai-usage")
    await store.appendRelayUsage({ callId: row.callId, orgId, eventId: row.eventId, at: now(), inputSize: row.inputSize, outputSize, durationMs: Math.max(0, now() - row.at), model: config.modelLabel, status })
  }
  async function forward(input: Input): Promise<void> {
    const inputSize = countInputChars(input.body), at = now(), callId = randomBytes(8).toString("hex")
    const row: Row = { orgId, roomId: input.roomId, eventId: input.eventId, sender: input.sender, callId, at, inputSize, state: "pending" }
    if (inputSize > limits.maxInputSize) {
      await usage(row, "rejected-input")
      throw new AxMessengerError({ kind: "too-large", userMessage: AX_AI_INPUT_TOO_LONG_MESSAGE, detail: "relay input limit" })
    }
    await init()
    const stage = path.join(staging, `${callId}.json`)
    inFlight.add(callId)
    try {
      await atomic(stage, `${JSON.stringify({ ...input, row })}\n`)
      try { await deliver(stage, row, input) } catch (error) {
        if (error instanceof AxMessengerError) throw error
        throw new AxRelayPendingError()
      }
    } finally { inFlight.delete(callId) }
  }
  async function deliver(stage: string, row: Row, _input: Input) {
    const lockState = await inspectSessionLock()
    if (lockState.unreadableDeferred) {
      throw new Error("relay session.lock unreadable; deferring delivery in staging")
    }
    if (!ledger.hasReservation(row.callId, orgId, row.eventId)) {
      // 복구 때 예약이 아직 없으면 현재 시각의 빈도 창을 적용한다.
      row.at = now()
      const result = await ledger.reserve({ callId: row.callId, orgId, eventId: row.eventId, at: row.at, inputSize: row.inputSize, maxOutputTokens: limits.maxOutputTokens, provider: "session-relay" })
      if (!result.ok) {
        await usage(row, result.reason === "duplicate" ? "rejected-duplicate" : "rejected-rate")
        // 거부된 질문의 본문은 보관하지 않는다.
        await atomic(stage, `${JSON.stringify({ at: now() })}\n`)
        await rename(stage, `${stage}.rejected`)
        throw new AxMessengerError({ kind: result.reason === "duplicate" ? "duplicate" : "rate-limited", userMessage: result.reason === "duplicate" ? AX_AI_FALLBACK_MESSAGE : AX_AI_RATE_LIMIT_MESSAGE, detail: "relay reservation rejected" })
      }
    }
    const statePath = path.join(states, `${relayName(row.eventId)}.json`)
    let existingRow: Row | null = null
    try {
      const { body } = await readStateFn(statePath)
      const parsed = JSON.parse(body) as Row
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        typeof parsed.state !== "string"
      ) {
        const shapeErr = new Error("릴레이 상태 기록 꼴 오류") as NodeJS.ErrnoException
        shapeErr.code = "ESHAPE"
        throw shapeErr
      }
      existingRow = parsed
      fileErrors.delete(statePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        await reportFileError("state", statePath, error)
        throw error
      }
    }
    if (!existingRow) {
      await save(row)
    } else {
      row.forwardedLogged = existingRow.forwardedLogged
    }
    const hasCall = await checkAuditJsonl(
      store.callFile,
      (r) => r.type === "provider-call" && r.callId === row.callId,
    )
    if (!hasCall.matched) {
      await prepareAuditAppend(store.callFile, hasCall, row, "provider-call")
      await store.appendCall({ callId: row.callId, orgId, at: row.at, inputSize: row.inputSize, maxOutputTokens: limits.maxOutputTokens, provider: "session-relay", eventId: row.eventId })
    }
    if (!row.forwardedLogged) {
      await usage(row, "forwarded")
      row.forwardedLogged = true
      await save(row)
    }
    const inboxPath = path.join(inbox, `${relayName(row.eventId)}.json`)
    // stage 파일은 필수 질문 필드와 복구용 메타데이터를 함께 담는다.
    await rename(stage, inboxPath)
    if (config.wakeCommand) {
      try {
        const child = spawn(config.wakeCommand[0]!, [...config.wakeCommand.slice(1), inboxPath], {
          shell: false,
          stdio: "ignore",
          env: buildRelayWakeEnv(env, dataDir),
        })
        child.on("error", () => log("nextain-ai: relay wake failed"))
        child.on("exit", (code) => { if (code !== 0) log("nextain-ai: relay wake failed") })
      } catch { log("nextain-ai: relay wake failed") }
    }
  }
  async function finish(row: Row, status: Row["state"], body?: string, observedOutputSize = body === undefined ? 0 : countInputChars(body)) {
    if (body !== undefined) {
      const txnId = `axrelay-${createHash("sha256").update(`${orgId}\n${row.eventId}`).digest("hex")}`
      await sendText(row.roomId, body, txnId, { "m.relates_to": { "m.in_reply_to": { event_id: row.eventId } } })
    }
    row.state = status
    row.outputSize = observedOutputSize
    row.finishedAt = now()
    await save(row)
    await audit(row)
  }
  // 완료 표시는 전송 직후 영속화하고, 감사 기록이 실패하면 다음 점검에서 재시도한다.
  async function audit(row: Row) {
    if (row.audited) return
    await ledger.updateResult(row.callId, "success")
    const callCheck = await checkAuditJsonl(store.callFile, (r) => r.type === "provider-call-result" && r.callId === row.callId)
    const fallbackCheck = await checkAuditJsonl(store.fallbackFile, (r) => r.type === "provider-call-result" && r.callId === row.callId)
    if (!callCheck.matched && !fallbackCheck.matched) {
      const result = { callId: row.callId, orgId, at: now(), status: "success" as const, provider: "session-relay", eventId: row.eventId }
      try {
        await prepareAuditAppend(store.callFile, { ...callCheck, corrupt: callCheck.corrupt || fallbackCheck.corrupt }, row, "provider-call-result")
        await store.appendCallResult(result)
      } catch {
        await prepareAuditAppend(store.fallbackFile, { ...fallbackCheck, corrupt: callCheck.corrupt || fallbackCheck.corrupt }, row, "provider-call-result")
        await store.appendCallResultFallback(result)
      }
    }
    await usage(row, row.state, row.outputSize ?? 0)
    row.audited = true
    await save(row)
  }

  async function markerAgeMs(filePath: string): Promise<number> {
    const st = await lstat(filePath)
    let stamp = st.mtimeMs
    if (st.isFile() && !st.isSymbolicLink()) {
      try {
        const parsed = JSON.parse(await readFile(filePath, "utf8")) as { at?: unknown }
        if (typeof parsed?.at === "number" && Number.isFinite(parsed.at)) stamp = parsed.at
      } catch { /* mtimeMs fallback */ }
    }
    return now() - stamp
  }

  async function pruneExpired() {
    for (const file of await readdir(staging)) {
      if (!file.endsWith(".rejected")) continue
      const fullPath = path.join(staging, file)
      try {
        if ((await markerAgeMs(fullPath)) >= retainMs) {
          await rm(fullPath, { force: true })
          fileErrors.delete(fullPath)
        }
      } catch { /* 다음 점검에서 다시 시도 */ }
    }
    for (const file of await readdir(rejected)) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue
      const fullPath = path.join(rejected, file)
      const name = file.slice(0, -5)
      try {
        if ((await markerAgeMs(fullPath)) >= retainMs) {
          await rm(path.join(replies, `${name}.md.ready`), { force: true })
          await rm(path.join(replies, `${name}.md`), { force: true })
          await rm(fullPath, { force: true })
          fileErrors.delete(fullPath)
        }
      } catch { /* 다음 점검에서 다시 시도 */ }
    }
    for (const file of await readdir(states)) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue
      const statePath = path.join(states, file)
      const name = file.slice(0, -5)
      try {
        const { body } = await readRegularFileNoFollow(statePath)
        const row = JSON.parse(body) as Row
        if (row.orgId !== orgId || row.state === "pending" || !row.audited) continue
        const finishedAt = typeof row.finishedAt === "number" && Number.isFinite(row.finishedAt) ? row.finishedAt : row.at
        if (now() - finishedAt >= retainMs) {
          await rm(path.join(inbox, `${name}.json`), { force: true })
          await rm(path.join(replies, `${name}.md.ready`), { force: true })
          await rm(path.join(replies, `${name}.md`), { force: true })
          await rm(statePath, { force: true })
          fileErrors.delete(statePath)
        }
      } catch { /* 다음 점검에서 다시 시도 */ }
    }
    try {
      for (const file of await readdir(sessionOut)) {
        if (!/^[a-f0-9]{64}\.log$/.test(file)) continue
        const fullPath = path.join(sessionOut, file)
        try {
          const st = await lstat(fullPath)
          if (now() - st.mtimeMs >= retainMs) await rm(fullPath, { force: true })
        } catch { /* ignore */ }
      }
    } catch { /* session-out 폴더가 아직 없으면 넘어간다 */ }
    if (!(await hasActiveSessionLock())) {
      try {
        for (const entry of await readdir(sessionWork)) {
          if (!/^[a-f0-9]{64}-[a-f0-9]{16}$/.test(entry)) continue
          const fullPath = path.join(sessionWork, entry)
          try {
            const st = await lstat(fullPath)
            if (now() - st.mtimeMs >= retainMs) await rm(fullPath, { recursive: true, force: true })
          } catch { /* ignore */ }
        }
      } catch { /* session-work 폴더가 아직 없으면 넘어간다 */ }
    }
  }

  async function poll() {
    if (polling) return
    polling = true
    try {
      await init()
      for (const file of await readdir(staging)) {
        if (!/^[a-f0-9]{16}\.json$/.test(file) || inFlight.has(file.slice(0, -5))) continue
        const stage = path.join(staging, file)
        let input: Input & { row: Row }
        try {
          const { body } = await readRegularFileNoFollow(stage)
          input = JSON.parse(body) as Input & { row: Row }
          if (
            !input ||
            typeof input !== "object" ||
            !input.row ||
            typeof input.row !== "object" ||
            input.row.orgId !== orgId ||
            input.row.callId !== file.slice(0, -5) ||
            typeof input.eventId !== "string" ||
            input.row.eventId !== input.eventId ||
            typeof input.body !== "string"
          ) {
            throw new Error("릴레이 복구 기록 오류")
          }
          fileErrors.delete(stage)
        } catch (error) {
          await reportFileError("staging", stage, error)
          continue
        }
        try {
          await deliver(stage, input.row, input)
        } catch (error) {
          if (!(error instanceof AxMessengerError)) {
            await reportFileError("staging", stage, error)
          }
        }
      }
      for (const file of await readdir(replies)) {
        if (!/^[a-f0-9]{64}\.md$/.test(file)) continue
        const name = file.slice(0, -3)
        const replyFile = path.join(replies, file)
        try {
          try { await lstat(path.join(states, `${name}.json`)); fileErrors.delete(replyFile); continue } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
          try { await lstat(path.join(rejected, `${name}.json`)); fileErrors.delete(replyFile); continue } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
          const row: Row = { orgId, roomId: "", eventId: "", sender: "", callId: name, at: now(), inputSize: 0, state: "rejected" }
          await usage(row, "rejected-unforwarded")
          await atomic(path.join(rejected, `${name}.json`), `${JSON.stringify({ at: now() })}\n`)
          fileErrors.delete(replyFile)
          log("nextain-ai: relay rejected unforwarded")
        } catch (error) {
          await reportFileError("replies", replyFile, error)
        }
      }
      for (const file of await readdir(states)) {
        if (!/^[a-f0-9]{64}\.json$/.test(file)) continue
        const statePath = path.join(states, file)
        let row: Row
        try {
          const { body } = await readRegularFileNoFollow(statePath)
          row = JSON.parse(body) as Row
          if (
            !row ||
            typeof row !== "object" ||
            typeof row.eventId !== "string" ||
            typeof row.callId !== "string" ||
            typeof row.at !== "number" ||
            typeof row.state !== "string" ||
            row.orgId !== orgId ||
            relayName(row.eventId) !== file.slice(0, -5)
          ) {
            const shapeErr = new Error("릴레이 상태 기록 오류") as NodeJS.ErrnoException
            shapeErr.code = "ESHAPE"
            throw shapeErr
          }
          fileErrors.delete(statePath)
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue
          await reportFileError("state", statePath, error)
          continue
        }
        const reply = path.join(replies, `${file.slice(0, -5)}.md`)
        let info
        try {
          info = await lstat(reply)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            await reportFileError("replies", reply, error)
            continue
          }
        }
        if (row.state !== "pending") {
          await audit(row)
          if (row.state === "timeout" && info && !row.lateLogged) {
            await usage(row, "late")
            row.lateLogged = true
            await save(row)
          }
          continue
        }
        let readyStatus: "missing" | "ready" | "invalid"
        try {
          readyStatus = await checkReadyMarkerNoFollow(`${reply}.ready`)
        } catch (error) {
          await reportFileError("replies", `${reply}.ready`, error)
          continue
        }
        if (readyStatus === "invalid") {
          await finish(row, "rejected", undefined, 0)
          log("nextain-ai: relay rejected invalid-ready")
          continue
        }
        if (info && (info.isSymbolicLink() || !info.isFile() || (typeof process.getuid === "function" && info.uid !== process.getuid()))) {
          await finish(row, "rejected", undefined, 0)
          log("nextain-ai: relay rejected invalid-reply")
          continue
        }
        if (now() - row.at >= config.timeoutMs) { await finish(row, "timeout", AX_AI_FALLBACK_MESSAGE); continue }
        if (!info) continue
        const ready = readyStatus === "ready"
        if (!ready && config.stableMs > 0 && now() - info.mtimeMs < config.stableMs) continue
        let loaded
        try {
          loaded = await readRegularFileNoFollow(reply)
          fileErrors.delete(reply)
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code === "ELOOP" || code === "EISDIR" || code === "ENOTREGULAR" || code === "EOWNER") {
            await finish(row, "rejected", undefined, 0)
            log("nextain-ai: relay rejected invalid-reply")
            continue
          }
          if (code === "ENOENT") continue
          await reportFileError("replies", reply, error)
          continue
        }
        if (
          info.size !== loaded.opened.size ||
          info.mtimeMs !== loaded.opened.mtimeMs ||
          info.ino !== loaded.opened.ino ||
          loaded.opened.size !== loaded.after.size ||
          loaded.opened.mtimeMs !== loaded.after.mtimeMs
        ) {
          continue
        }
        const body = loaded.body
        const firstLine = body.split(/\r?\n/, 1)[0]?.trim() ?? ""
        if (firstLine.startsWith("답 없음")) { await finish(row, "no-answer", undefined, countInputChars(body)); continue }
        if (!body.trim() || secretLike(body)) { await finish(row, "rejected", undefined, countInputChars(body)); log("nextain-ai: relay rejected secret-or-empty"); continue }
        const capped = [...body].slice(0, limits.maxOutputTokens).join("")
        await finish(row, "sent", capped)
      }
      await pruneExpired()
    } finally { polling = false }
  }
  return { init, forward, poll }
}
