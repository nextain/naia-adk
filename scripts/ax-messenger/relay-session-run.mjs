#!/usr/bin/env node
// 봇의 AX_AI_RELAY_WAKE_CMD 로 걸어 질문마다 따로 떼어 낸 작업 칸에서
// 역할 세션을 한 번에 하나씩 깨우는 연결 대본.
// 모델을 직접 부르지 않으며 무엇을 부를지는 AX_RELAY_SESSION_CMD 설정으로만 받는다.
// 질문 본문과 비밀 열쇠, 공유 폴더·역할 폴더 경로는 세션 인자·환경·기록 줄에 넣지 않는다.
import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { constants as fsConstants, readFileSync } from "node:fs"
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { StringDecoder } from "node:string_decoder"
import { setTimeout as delay } from "node:timers/promises"
import { pathToFileURL } from "node:url"

const FIXED_CONFIG_ERROR = "역할 세션 실행 설정이나 인자를 확인해 주세요."
const FIXED_INSTRUCTION =
  "이 폴더의 AGENTS.md 와 question.json 을 읽고 answer.md 에 답 문안만 써라, 다 쓰면 끝내라"
const SESSION_TIMEOUT_DEFAULT_MS = 600_000
const SESSION_TIMEOUT_MIN_MS = 1_000
const SESSION_TIMEOUT_MAX_MS = 86_400_000
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
export const AX_BOOT_ID_UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// 리눅스 커널 fs/proc/array.c task_state_array 및 proc_pid_stat(5) 기준 정상 상태 글자 집합:
// - 살아 있음(alive): R(실행), S(대기), D(디스크 대기), T(신호 멈춤), t(추적 멈춤), P(parked), I(커널 유휴, 4.14+)
// - 죽음 확인(dead): Z(좀비), X(사망)
// - 제외: W 는 리눅스 2.6.0 이전에는 paging 이었고 2.6.33~3.13 에서는 waking 으로 쓰이다 3.14 에서 제거되었으며,
//   x(dead)·K(wakekill) 도 2.6.33~3.13 에서만 쓰이다 3.14 에서 제거되었다.
//   "죽음 확인"을 Z·X 로만 좁히기 위해 위 글자들과 집합 밖 글자는 모두 망가진 줄("모름")로 본다.
export const AX_PROC_STAT_ALIVE_STATES = ["R", "S", "D", "T", "t", "P", "I"]
export const AX_PROC_STAT_DEAD_STATES = ["Z", "X"]
const PROC_STAT_ALIVE_STATE_SET = new Set(AX_PROC_STAT_ALIVE_STATES)
const PROC_STAT_DEAD_STATE_SET = new Set(AX_PROC_STAT_DEAD_STATES)
const RETAIN_DEFAULT_MS = 604_800_000
const RETAIN_MIN_MS = 1_000
const RETAIN_MAX_MS = 7_776_000_000
const ANSWER_MAX_BYTES_DEFAULT = 1_048_576
const ANSWER_MAX_BYTES_MIN = 1
const ANSWER_MAX_BYTES_MAX = 16_777_216
const MINIMAL_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "TZ"]
const STREAM_BUFFER_SOFT_LIMIT = 8_192
const STREAM_OVERLAP_TAIL = 512

function failConfig() {
  process.stderr.write(`${FIXED_CONFIG_ERROR}\n`)
  process.exit(2)
}

function parseIntSetting(raw, fallback, min, max) {
  if (raw === undefined) return fallback
  const trimmed = String(raw).trim()
  const value = Number(trimmed)
  if (!trimmed || !Number.isInteger(value) || value < min || value > max) failConfig()
  return value
}

function redactSecrets(text) {
  return String(text ?? "")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/syt_[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]+/gi, "[REDACTED]")
    .replace(
      /(password|passwd|access_token|registration_token|secret|token)\s*["'=:]\s*["']?[^\s"',}]+/gi,
      "$1=[REDACTED]",
    )
}

function endsWithPartialSecretPrefix(text) {
  return /(?:Bearer\s*|(?:password|passwd|access_token|registration_token|secret|token)\s*["'=:]?\s*["']?|syt_[A-Za-z0-9_-]*|\bsk-[A-Za-z0-9_-]*|s|sy|syt|sk)$/i.test(
    text,
  )
}

function createStreamRedactor(enqueueWrite) {
  const decoder = new StringDecoder("utf8")
  let pending = ""

  function flushUpToNewline() {
    const lastNewline = pending.lastIndexOf("\n")
    if (lastNewline !== -1) {
      const head = pending.slice(0, lastNewline + 1)
      const tail = pending.slice(lastNewline + 1)
      if (!endsWithPartialSecretPrefix(head.replace(/\r?\n$/, ""))) {
        pending = tail
        enqueueWrite(redactSecrets(head))
        return
      }
    }
    if (pending.length > STREAM_BUFFER_SOFT_LIMIT) {
      const redacted = redactSecrets(pending)
      const cutoff = Math.max(0, redacted.length - STREAM_OVERLAP_TAIL)
      let splitAt = redacted.lastIndexOf(" ", cutoff)
      if (splitAt <= 0) splitAt = cutoff
      if (splitAt > 0) {
        const emitPart = redacted.slice(0, splitAt)
        pending = redacted.slice(splitAt)
        enqueueWrite(emitPart)
      }
    }
  }

  return {
    push(chunk) {
      pending += typeof chunk === "string" ? chunk : decoder.write(chunk)
      flushUpToNewline()
    },
    end() {
      pending += decoder.end()
      if (pending.length > 0) {
        const finalText = redactSecrets(pending)
        pending = ""
        enqueueWrite(finalText)
      }
    },
  }
}

// 역할 작업 폴더(AX_RELAY_SESSION_DIR)와 공유 relay 폴더(AX_MESSENGER_DATA_DIR)는
// 세션 환경에 주지 않는다.
function buildSessionEnv(sourceEnv) {
  const out = {}
  for (const key of MINIMAL_ENV_KEYS) {
    if (typeof sourceEnv[key] === "string") out[key] = sourceEnv[key]
  }
  return out
}

export function normalizeBootId(value) {
  if (typeof value !== "string") return ""
  const normalized = value.replace(/^[\s\r\n]+|[\s\r\n]+$/g, "").toLowerCase()
  return AX_BOOT_ID_UUID_REGEX.test(normalized) ? normalized : ""
}

export function isValidBootId(value) {
  return normalizeBootId(value) !== ""
}

export function checkProcessGroupStatus(pgid, kill0) {
  if (!Number.isInteger(pgid) || pgid <= 0) return "dead"
  try {
    if (typeof kill0 === "function") kill0(-pgid)
    process.kill(-pgid, 0)
    return "alive"
  } catch (error) {
    const code = error?.code
    if (code === "ESRCH") return "dead"
    if (code === "EPERM") return "alive"
    return "unknown"
  }
}

export function isProcessGroupAlive(pgid, kill0) {
  return checkProcessGroupStatus(pgid, kill0) !== "dead"
}

export function isValidSessionLockShape(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false
  if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return false
  if (typeof parsed.at !== "number" || !Number.isFinite(parsed.at) || parsed.at <= 0) return false
  if (
    parsed.heartbeatAt !== undefined &&
    (typeof parsed.heartbeatAt !== "number" ||
      !Number.isFinite(parsed.heartbeatAt) ||
      parsed.heartbeatAt <= 0)
  ) {
    return false
  }
  if (
    parsed.pgid !== undefined &&
    (typeof parsed.pgid !== "number" || !Number.isInteger(parsed.pgid) || parsed.pgid < 0)
  ) {
    return false
  }
  if (
    parsed.heartbeatUptimeMs !== undefined &&
    parsed.heartbeatUptimeMs !== null &&
    (typeof parsed.heartbeatUptimeMs !== "number" ||
      !Number.isFinite(parsed.heartbeatUptimeMs) ||
      parsed.heartbeatUptimeMs < 0)
  ) {
    return false
  }
  return true
}

export function isValidRestoreRecordShape(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false
  if (
    typeof parsed.repliesMode !== "number" ||
    !Number.isInteger(parsed.repliesMode) ||
    parsed.repliesMode < 0 ||
    parsed.repliesMode > 0o777 ||
    (parsed.repliesMode & 0o700) !== 0o700
  ) {
    return false
  }
  return true
}

export function isProtectedReplyEntry(name, currentId = "", options = {}) {
  if (options?.isSymbolicLink === true) return true
  if (typeof name !== "string" || !name) return false
  // 원자적 답글 쓰기의 PID·hex 임시 파일만 정리한다. 심볼릭 링크와 .ready는 위/아래에서 보호한다.
  if (/^[a-f0-9]{64}\.md\.\d+\.(?:[a-f0-9]{6}|[a-f0-9]{12})\.tmp$/i.test(name)) return false
  if (currentId) {
    const lowerName = name.toLowerCase()
    const lowerId = String(currentId).toLowerCase()
    if (lowerName === lowerId || lowerName.startsWith(`${lowerId}.`)) {
      return true
    }
  }
  // 질문 이름 해시는 SHA-256 64자 hex(relayName)로 만들어진다.
  // 정식 답 파일과 .ready 표식, 모호한 이름은 보존한다. 알려진 원자적 .md 임시 파일만 위에서 제외한다.
  if (/^[a-f0-9]{64}(?:\..+)?$/i.test(name)) {
    return true
  }
  if (/\.ready(?:\..+)?$/i.test(name)) {
    return true
  }
  return false
}

export function parseProcStatLine(statText) {
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

export function readProcessIdentity(pid, options) {
  let bootId = ""
  try {
    const rawBoot = String(
      typeof options?.readBootId === "function"
        ? options.readBootId()
        : readFileSync("/proc/sys/kernel/random/boot_id", "utf8"),
    )
    bootId = normalizeBootId(rawBoot)
  } catch { /* ignore */ }
  if (!Number.isInteger(pid) || pid <= 0) {
    return { status: "dead", alive: false, starttime: "", bootId, state: "", stopped: false }
  }
  try {
    if (typeof options?.kill0 === "function") {
      options.kill0(pid)
    } else {
      process.kill(pid, 0)
    }
  } catch (error) {
    const code = error?.code
    if (code === "ESRCH") {
      return { status: "dead", alive: false, starttime: "", bootId, state: "", stopped: false }
    }
    if (code !== "EPERM") {
      return { status: "unknown", alive: true, starttime: "", bootId, state: "", stopped: false }
    }
  }
  try {
    const statText =
      typeof options?.readProcStat === "function"
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
    const code = error?.code
    if (code === "ENOENT" || code === "ESRCH") {
      return { status: "dead", alive: false, starttime: "", bootId, state: "", stopped: false }
    }
    return { status: "unknown", alive: true, starttime: "", bootId, state: "", stopped: false }
  }
}

export function readUptimeMs(procUptimePath = "/proc/uptime") {
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

export function evaluateSessionLockPayload(parsed, procInput, options) {
  const wallClockMaxMs = options?.wallClockMaxMs ?? AX_RELAY_LOCK_WALL_CLOCK_MAX_MS
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
  let procStatus
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
  const rawRefBootId = options?.selfBootId !== undefined ? options.selfBootId : procInput?.bootId
  const refBootId = normalizeBootId(rawRefBootId)
  const bootStatus =
    lockBootId && refBootId
      ? lockBootId === refBootId
        ? "same"
        : "different"
      : "unknown"
  const bootUnknown = bootStatus === "unknown"
  const sameBoot = bootStatus !== "different"

  const validMtime =
    typeof options?.lockMtimeMs === "number" &&
    Number.isFinite(options.lockMtimeMs) &&
    options.lockMtimeMs > 0
  const mtimeAge = validMtime
    ? options.nowMs >= options.lockMtimeMs
      ? options.nowMs - options.lockMtimeMs
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

function isPidAlive(pid) {
  return readProcessIdentity(pid).status !== "dead"
}

async function terminateProcessGroup(pgid, graceMs, kill0) {
  if (!Number.isInteger(pgid) || pgid <= 0) return true
  if (!isProcessGroupAlive(pgid, kill0) && !isPidAlive(pgid)) return true
  try {
    process.kill(-pgid, "SIGTERM")
  } catch { /* ignore */ }
  try {
    process.kill(pgid, "SIGTERM")
  } catch { /* ignore */ }
  const termDeadline = performance.now() + graceMs
  while (performance.now() < termDeadline) {
    if (!isProcessGroupAlive(pgid, kill0) && !isPidAlive(pgid)) return true
    await delay(25)
  }
  try {
    process.kill(-pgid, "SIGKILL")
  } catch { /* ignore */ }
  try {
    process.kill(pgid, "SIGKILL")
  } catch { /* ignore */ }
  const killDeadline = performance.now() + Math.max(1_000, graceMs)
  while (performance.now() < killDeadline) {
    if (!isProcessGroupAlive(pgid, kill0) && !isPidAlive(pgid)) return true
    await delay(25)
  }
  return !isProcessGroupAlive(pgid, kill0) && !isPidAlive(pgid)
}

async function terminatePid(pid, graceMs) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return true
  if (!isPidAlive(pid)) return true
  try {
    process.kill(pid, "SIGTERM")
  } catch { /* ignore */ }
  const termDeadline = performance.now() + graceMs
  while (performance.now() < termDeadline) {
    if (!isPidAlive(pid)) return true
    await delay(25)
  }
  try {
    process.kill(pid, "SIGKILL")
  } catch { /* ignore */ }
  const killDeadline = performance.now() + Math.max(1_000, graceMs)
  while (performance.now() < killDeadline) {
    if (!isPidAlive(pid)) return true
    await delay(25)
  }
  return !isPidAlive(pid)
}

async function existsNoFollow(filePath) {
  try {
    await lstat(filePath)
    return true
  } catch (error) {
    if (error?.code === "ENOENT") return false
    throw error
  }
}

export async function readRegularFileNoFollow(filePath, maxBytes = Number.MAX_SAFE_INTEGER) {
  const before = await lstat(filePath)
  if (before.isSymbolicLink() || !before.isFile()) {
    const err = new Error("보통 파일이 아닙니다.")
    err.code = "ENOTREGULAR"
    throw err
  }
  if (typeof process.getuid === "function" && before.uid !== process.getuid()) {
    const err = new Error("파일 소유자가 다릅니다.")
    err.code = "EOWNER"
    throw err
  }
  if (before.size > maxBytes) {
    const err = new Error("파일 크기 상한을 넘었습니다.")
    err.code = "ETOOLARGE"
    throw err
  }
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (
      opened.isSymbolicLink() ||
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeMs !== before.mtimeMs
    ) {
      const err = new Error("열린 파일이 보통 파일이 아니거나 열리는 동안 바뀌었습니다.")
      err.code = "ENOTREGULAR"
      throw err
    }
    if (typeof process.getuid === "function" && opened.uid !== process.getuid()) {
      const err = new Error("열린 파일 소유자가 다릅니다.")
      err.code = "EOWNER"
      throw err
    }
    if (opened.size > maxBytes) {
      const err = new Error("열린 파일 크기 상한을 넘었습니다.")
      err.code = "ETOOLARGE"
      throw err
    }
    const buf = await handle.readFile()
    const after = await handle.stat()
    if (
      after.size > maxBytes ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      buf.byteLength !== opened.size
    ) {
      const err = new Error("파일을 읽는 동안 상태가 바뀌었거나 크기 상한을 넘었습니다.")
      err.code = after.size > maxBytes ? "ETOOLARGE" : "ENOTREGULAR"
      throw err
    }
    return { body: buf.toString("utf8"), before, opened, after }
  } finally {
    await handle.close()
  }
}

async function writeAtomic0600(filePath, content) {
  const tmp = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  await writeFile(tmp, content, { encoding: "utf8", mode: 0o600, flag: "wx" })
  try {
    await chmod(tmp, 0o600)
    await rename(tmp, filePath)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function restoreRepliesModeFromRecord(restorePath, repliesDir, options = {}) {
  const readRestoreFile =
    typeof options?.readRestoreFile === "function"
      ? options.readRestoreFile
      : (p) => readRegularFileNoFollow(p)
  const onError = typeof options?.onError === "function" ? options.onError : null

  let raw
  try {
    const loaded = await readRestoreFile(restorePath)
    raw = typeof loaded === "string" ? loaded : loaded?.body
    if (typeof raw !== "string") {
      const err = new Error("복원 기록 본문을 읽을 수 없습니다.")
      err.code = "EREAD"
      throw err
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false
    }
    const code = String(error?.code || "EREAD")
    if (onError) {
      await onError(code)
    }
    return false
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    if (onError) {
      await onError("EJSONPARSE")
    }
    return false
  }

  if (!isValidRestoreRecordShape(parsed)) {
    if (onError) {
      await onError("ESHAPE")
    }
    return false
  }

  await chmod(repliesDir, parsed.repliesMode)
  await rm(restorePath, { force: true })
  return true
}

// 역할 폴더를 열어 폴더의 dev·inode 를 고정 확인하고,
// AGENTS.md 는 O_NOFOLLOW 핸들 하나로 열어 읽기 전후 fstat(dev·inode·크기·mtime) 일치와
// 그 핸들로 읽은 내용의 SHA-256 을 얻는다.
export async function snapshotRoleIntegrity(sessionDir, expectedRealSessionDir, onDuringRead) {
  let dirHandle
  let fileHandle
  try {
    const dirBefore = await lstat(sessionDir)
    if (dirBefore.isSymbolicLink() || !dirBefore.isDirectory()) {
      return { valid: false }
    }
    if (typeof process.getuid === "function" && dirBefore.uid !== process.getuid()) {
      return { valid: false }
    }
    const openDirFlags =
      fsConstants.O_RDONLY |
      fsConstants.O_NOFOLLOW |
      (typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0)
    dirHandle = await open(sessionDir, openDirFlags)
    const dirOpened = await dirHandle.stat()
    if (
      dirOpened.isSymbolicLink() ||
      !dirOpened.isDirectory() ||
      dirOpened.dev !== dirBefore.dev ||
      dirOpened.ino !== dirBefore.ino
    ) {
      return { valid: false }
    }
    if (typeof process.getuid === "function" && dirOpened.uid !== process.getuid()) {
      return { valid: false }
    }
    if ((await realpath(sessionDir)) !== expectedRealSessionDir) {
      return { valid: false }
    }

    const agentsPath = path.join(sessionDir, "AGENTS.md")
    const fileBefore = await lstat(agentsPath)
    if (fileBefore.isSymbolicLink() || !fileBefore.isFile()) {
      return { valid: false }
    }
    if (typeof process.getuid === "function" && fileBefore.uid !== process.getuid()) {
      return { valid: false }
    }

    fileHandle = await open(agentsPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const fileOpened = await fileHandle.stat()
    if (
      fileOpened.isSymbolicLink() ||
      !fileOpened.isFile() ||
      fileOpened.dev !== fileBefore.dev ||
      fileOpened.ino !== fileBefore.ino ||
      fileOpened.size !== fileBefore.size ||
      fileOpened.mtimeMs !== fileBefore.mtimeMs
    ) {
      return { valid: false }
    }
    if (typeof process.getuid === "function" && fileOpened.uid !== process.getuid()) {
      return { valid: false }
    }

    const buf = await fileHandle.readFile()
    if (typeof onDuringRead === "function") {
      await onDuringRead()
    }
    const fileAfter = await fileHandle.stat()
    if (
      fileAfter.isSymbolicLink() ||
      !fileAfter.isFile() ||
      fileAfter.dev !== fileOpened.dev ||
      fileAfter.ino !== fileOpened.ino ||
      fileAfter.size !== fileOpened.size ||
      fileAfter.mtimeMs !== fileOpened.mtimeMs ||
      buf.byteLength !== fileOpened.size
    ) {
      return { valid: false }
    }

    const fileAfterPath = await lstat(agentsPath)
    if (
      fileAfterPath.isSymbolicLink() ||
      !fileAfterPath.isFile() ||
      fileAfterPath.dev !== fileOpened.dev ||
      fileAfterPath.ino !== fileOpened.ino ||
      fileAfterPath.size !== fileOpened.size ||
      fileAfterPath.mtimeMs !== fileOpened.mtimeMs
    ) {
      return { valid: false }
    }

    const dirAfter = await dirHandle.stat()
    const dirAfterPath = await lstat(sessionDir)
    if (
      dirAfter.dev !== dirOpened.dev ||
      dirAfter.ino !== dirOpened.ino ||
      dirAfterPath.isSymbolicLink() ||
      !dirAfterPath.isDirectory() ||
      dirAfterPath.dev !== dirOpened.dev ||
      dirAfterPath.ino !== dirOpened.ino ||
      (await realpath(sessionDir)) !== expectedRealSessionDir
    ) {
      return { valid: false }
    }

    const body = buf.toString("utf8")
    const sha256 = createHash("sha256").update(buf).digest("hex")
    return {
      valid: true,
      dirDev: dirOpened.dev,
      dirIno: dirOpened.ino,
      fileDev: fileOpened.dev,
      fileIno: fileOpened.ino,
      size: fileOpened.size,
      mtimeMs: fileOpened.mtimeMs,
      sha256,
      body,
    }
  } catch {
    return { valid: false }
  } finally {
    if (fileHandle) await fileHandle.close().catch(() => undefined)
    if (dirHandle) await dirHandle.close().catch(() => undefined)
  }
}

export function isSameIntegritySnapshot(before, after) {
  if (!before?.valid || !after?.valid) return false
  return (
    before.dirDev === after.dirDev &&
    before.dirIno === after.dirIno &&
    before.fileDev === after.fileDev &&
    before.fileIno === after.fileIno &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.sha256 === after.sha256
  )
}

export function validateSessionCommandSafety(sessionCmd) {
  if (!Array.isArray(sessionCmd) || sessionCmd.length === 0) return false
  let cmdIndex = 0
  if (path.basename(sessionCmd[0]) === "env") {
    cmdIndex = 1
    while (cmdIndex < sessionCmd.length) {
      const token = sessionCmd[cmdIndex]
      if (token === "--") {
        cmdIndex++
        break
      }
      if (
        token === "-u" ||
        token === "--unset" ||
        token === "-C" ||
        token === "--chdir" ||
        token === "-S" ||
        token === "--split-string"
      ) {
        cmdIndex += 2
        continue
      }
      if (token.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
        cmdIndex++
        continue
      }
      break
    }
  }
  if (cmdIndex >= sessionCmd.length) return false
  const executable = sessionCmd[cmdIndex]
  if (typeof executable !== "string" || !executable) return false
  // AX_RELAY_SESSION_CMD 에 claude 를 쓰면서 --restricted 또는 --strict-mcp-config 가 빠진 설정은 시작 때 거부한다.
  if (path.basename(executable) === "claude") {
    const claudeArgs = sessionCmd.slice(cmdIndex + 1)
    if (!claudeArgs.includes("--restricted") || !claudeArgs.includes("--strict-mcp-config")) {
      return false
    }
  }
  return true
}

export async function main(hooks = {}) {
  const wallNow = typeof hooks?.now === "function" ? hooks.now : Date.now
  const getUptimeMs = typeof hooks?.uptimeMs === "function" ? hooks.uptimeMs : () => readUptimeMs()
  const readProcStatHook = typeof hooks?.readProcStat === "function" ? hooks.readProcStat : undefined
  const kill0Hook = typeof hooks?.kill0 === "function" ? hooks.kill0 : undefined
  const readBootIdHook = typeof hooks?.readBootId === "function" ? hooks.readBootId : undefined
  const readLockFileHook = typeof hooks?.readLockFile === "function" ? hooks.readLockFile : undefined
  const lstatLockFileHook = typeof hooks?.lstatLockFile === "function" ? hooks.lstatLockFile : undefined
  const readdirRepliesHook = typeof hooks?.readdirReplies === "function" ? hooks.readdirReplies : undefined
  const readRestoreFileHook = typeof hooks?.readRestoreFile === "function" ? hooks.readRestoreFile : undefined
  const readStateFileHook = typeof hooks?.readStateFile === "function" ? hooks.readStateFile : undefined
  const rmLockFileHook = typeof hooks?.rmLockFile === "function" ? hooks.rmLockFile : undefined
  const appendSessionLogFileHook =
    typeof hooks?.appendSessionLogFile === "function" ? hooks.appendSessionLogFile : undefined
  const hasIdentityHooks = Boolean(readProcStatHook || kill0Hook || readBootIdHook)
  const getProcIdentity =
    typeof hooks?.procIdentity === "function"
      ? hooks.procIdentity
      : (pid) =>
          readProcessIdentity(
            pid,
            hasIdentityHooks
              ? {
                  readProcStat: readProcStatHook,
                  kill0: kill0Hook,
                  readBootId: readBootIdHook,
                }
              : undefined,
          )
  const args = Array.isArray(hooks?.argv) ? hooks.argv : process.argv.slice(2)
  const isReclaimLockMode = args.length === 1 && args[0] === "--reclaim-lock"

  const rawDataDir = process.env.AX_MESSENGER_DATA_DIR
  if (typeof rawDataDir !== "string" || !rawDataDir.trim() || !path.isAbsolute(rawDataDir)) {
    failConfig()
  }
  const resolvedDataDir = path.resolve(rawDataDir)

  let realDataDir
  try {
    const dataSt = await lstat(resolvedDataDir)
    if (dataSt.isSymbolicLink() || !dataSt.isDirectory()) failConfig()
    realDataDir = await realpath(resolvedDataDir)
  } catch {
    failConfig()
  }

  const relayRoot = path.join(resolvedDataDir, "relay")
  const inboxDir = path.join(relayRoot, "inbox")
  const repliesDir = path.join(relayRoot, "replies")
  const stateDir = path.join(relayRoot, "state")
  const sessionWorkRoot = path.join(relayRoot, "session-work")
  const sessionOutDir = path.join(relayRoot, "session-out")
  const lockPath = path.join(relayRoot, "session.lock")
  const reclaimGuardPath = path.join(sessionWorkRoot, ".session-reclaim.lock")
  const restorePath = path.join(relayRoot, "session-restore.json")
  const sessionLogPath = path.join(relayRoot, "session-log.jsonl")

  const realRelayRootExpected = path.join(realDataDir, "relay")
  const realInboxExpected = path.join(realRelayRootExpected, "inbox")
  const realRepliesExpected = path.join(realRelayRootExpected, "replies")
  const realStateExpected = path.join(realRelayRootExpected, "state")
  const realSessionWorkExpected = path.join(realRelayRootExpected, "session-work")
  const realSessionOutExpected = path.join(realRelayRootExpected, "session-out")

  async function verifyOrCreateDir(dirPath, expectedRealPath, createIfMissing = true) {
    let st
    try {
      st = await lstat(dirPath)
    } catch (error) {
      if (error?.code === "ENOENT" && createIfMissing) {
        await mkdir(dirPath, { recursive: false, mode: 0o700 })
        await chmod(dirPath, 0o700)
        st = await lstat(dirPath)
      } else {
        failConfig()
      }
    }
    if (!st || st.isSymbolicLink() || !st.isDirectory()) {
      failConfig()
    }
    let actualReal
    try {
      actualReal = await realpath(dirPath)
    } catch {
      failConfig()
    }
    if (
      actualReal !== expectedRealPath ||
      (actualReal !== realDataDir && !actualReal.startsWith(realDataDir + path.sep))
    ) {
      failConfig()
    }
    return actualReal
  }

  await verifyOrCreateDir(relayRoot, realRelayRootExpected, true)
  await verifyOrCreateDir(inboxDir, realInboxExpected, true)
  await verifyOrCreateDir(repliesDir, realRepliesExpected, true)
  await verifyOrCreateDir(stateDir, realStateExpected, true)
  await verifyOrCreateDir(sessionWorkRoot, realSessionWorkExpected, true)
  await verifyOrCreateDir(sessionOutDir, realSessionOutExpected, true)

  let sessionCmd = null
  if (!isReclaimLockMode || process.env.AX_RELAY_SESSION_CMD !== undefined) {
    try {
      const parsed = JSON.parse(process.env.AX_RELAY_SESSION_CMD ?? "")
      if (
        !Array.isArray(parsed) ||
        parsed.length === 0 ||
        !parsed.every((item) => typeof item === "string" && item.length > 0) ||
        !path.isAbsolute(parsed[0]) ||
        !validateSessionCommandSafety(parsed)
      ) {
        failConfig()
      }
      sessionCmd = parsed
    } catch {
      failConfig()
    }
  }

  let sessionDir = null
  let realSessionDir = null
  if (!isReclaimLockMode || process.env.AX_RELAY_SESSION_DIR !== undefined) {
    const rawSessionDir = process.env.AX_RELAY_SESSION_DIR
    if (typeof rawSessionDir !== "string" || !rawSessionDir.trim() || !path.isAbsolute(rawSessionDir)) {
      failConfig()
    }
    sessionDir = path.resolve(rawSessionDir)
    try {
      const dirInfo = await lstat(sessionDir)
      if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) failConfig()
      realSessionDir = await realpath(sessionDir)
      const initialRoleSnapshot = await snapshotRoleIntegrity(sessionDir, realSessionDir)
      if (!initialRoleSnapshot.valid) failConfig()
    } catch {
      failConfig()
    }
  }

  const timeoutMs = parseIntSetting(
    process.env.AX_RELAY_SESSION_TIMEOUT_MS,
    SESSION_TIMEOUT_DEFAULT_MS,
    SESSION_TIMEOUT_MIN_MS,
    SESSION_TIMEOUT_MAX_MS,
  )
  const retainMs = parseIntSetting(
    process.env.AX_AI_RELAY_RETAIN_MS,
    RETAIN_DEFAULT_MS,
    RETAIN_MIN_MS,
    RETAIN_MAX_MS,
  )
  const maxAnswerBytes = parseIntSetting(
    process.env.AX_RELAY_SESSION_MAX_ANSWER_BYTES,
    ANSWER_MAX_BYTES_DEFAULT,
    ANSWER_MAX_BYTES_MIN,
    ANSWER_MAX_BYTES_MAX,
  )
  const killGraceMs = Math.min(2_000, Math.max(200, Math.floor(timeoutMs / 4)))
  const heartbeatIntervalMs = Math.min(500, Math.max(100, Math.floor(timeoutMs / 10)))
  const heartbeatStaleMs = Math.min(timeoutMs, Math.max(1_000, heartbeatIntervalMs * 6))

  const selfIdentity = readProcessIdentity(
    process.pid,
    readBootIdHook ? { readBootId: readBootIdHook } : undefined,
  )
  const lockToken = randomBytes(12).toString("hex")
  let currentPgid = 0
  let currentWorkDir = null
  let currentStartedAt = wallNow()
  let currentStartedMono = performance.now()
  let legacyLockCompatDecision = null
  let reclaimedWallClockReason = null
  let reclaimedIdentityUnknown = false
  let reclaimedBootUnknown = false
  let wallClockReclaimStderrLogged = false
  let wallClockReclaimAuditLogged = false
  let fatalRunnerError = false
  let restoreRecordUnreadableCode = null
  let currentLockStat = null
  let lockReleaseAborted = false
  const reportedQuestionErrors = new Set()

  function noteLegacyLockCompat(oldPid, active) {
    const decision = active ? "active" : "stale"
    if (legacyLockCompatDecision === decision) return
    legacyLockCompatDecision = decision
    process.stderr.write(`nextain-ai: relay lock legacy-compat pid=${oldPid} active=${active}\n`)
  }

  function noteWallClockMaxReclaim(oldPid, procState, reason, identityUnknown, bootUnknown) {
    const resolvedReason = reason || AX_RELAY_LOCK_WALL_CLOCK_RECLAIM_REASON
    reclaimedWallClockReason = resolvedReason
    if (identityUnknown) reclaimedIdentityUnknown = true
    if (bootUnknown) reclaimedBootUnknown = true
    if (wallClockReclaimStderrLogged) return
    wallClockReclaimStderrLogged = true
    process.stderr.write(
      `nextain-ai: relay lock reclaim pid=${oldPid} state=${procState || "unknown"} reason=${resolvedReason}\n`,
    )
  }

  async function appendSessionLog(entry) {
    try {
      if (appendSessionLogFileHook) {
        await appendSessionLogFileHook(sessionLogPath, entry)
        return true
      }
      try {
        const st = await lstat(sessionLogPath)
        if (st.isSymbolicLink() || !st.isFile()) {
          const err = new Error("session-log.jsonl 이 보통 파일이 아닙니다.")
          err.code = "ENOTREGULAR"
          throw err
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error
      }
      await appendFile(sessionLogPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 })
      await chmod(sessionLogPath, 0o600)
      return true
    } catch (error) {
      const code = String(error?.code || "EWRITE")
      const eventName = String(entry?.event || entry?.file || "session")
      process.stderr.write(
        `nextain-ai: relay session-log write failed event=${eventName} code=${code} reason=${AX_RELAY_SESSION_LOG_WRITE_FAILED_REASON}\n`,
      )
      return false
    }
  }

  function buildLockPayload() {
    const now = wallNow()
    const currentUptimeMs = getUptimeMs()
    const elapsedMonoMs = Math.max(0, Math.round(performance.now() - currentStartedMono))
    return `${JSON.stringify({
      token: lockToken,
      pid: process.pid,
      starttime: selfIdentity.starttime,
      boot_id: selfIdentity.bootId,
      pgid: currentPgid,
      at: currentStartedAt,
      heartbeatAt: now,
      heartbeatUptimeMs: currentUptimeMs,
      elapsedMonoMs,
      heartbeatStaleMs,
      timeoutMs,
      workDir: currentWorkDir,
    })}\n`
  }

  async function ownsLock(expectedStat = currentLockStat) {
    try {
      const st = await lstat(lockPath)
      if (st.isSymbolicLink() || !st.isFile()) return false
      if (
        expectedStat &&
        ((typeof expectedStat.dev === "number" &&
          typeof st.dev === "number" &&
          st.dev !== expectedStat.dev) ||
          (typeof expectedStat.ino === "number" &&
            typeof st.ino === "number" &&
            st.ino !== expectedStat.ino))
      ) {
        return false
      }
      const parsed = JSON.parse(await readFile(lockPath, "utf8"))
      if (parsed?.pid !== process.pid) return false
      if (typeof parsed?.token !== "string" || parsed.token !== lockToken) return false
      const lockStarttime = parsed?.starttime ?? parsed?.startTime
      if (selfIdentity.starttime && lockStarttime !== undefined && String(lockStarttime).trim() !== selfIdentity.starttime) {
        return false
      }
      const lockBootId = parsed?.boot_id ?? parsed?.bootId
      if (selfIdentity.bootId && lockBootId !== undefined && normalizeBootId(lockBootId) !== selfIdentity.bootId) {
        return false
      }
      return true
    } catch {
      return false
    }
  }

  async function cleanupOwnLockOnAcquireFailure(expectedStat) {
    if (!(await ownsLock(expectedStat))) {
      return false
    }
    try {
      await (rmLockFileHook ? rmLockFileHook(lockPath) : rm(lockPath))
      currentLockStat = null
      return true
    } catch (error) {
      if (error?.code !== "ENOENT") {
        const code = String(error?.code || "ERM")
        process.stderr.write(
          `nextain-ai: relay lock rm failed actor=runner phase=acquire-lock code=${code} reason=${AX_RELAY_LOCK_RM_FAILED_REASON}\n`,
        )
        await appendSessionLog({
          event: "lock-rm",
          actor: "runner",
          action: "failed",
          phase: "acquire-lock",
          pid: process.pid,
          reason: AX_RELAY_LOCK_RM_FAILED_REASON,
          errorCode: code,
          at: wallNow(),
        })
      }
      return false
    }
  }

  async function cleanupStaleWorkDir(workDirCandidate) {
    if (typeof workDirCandidate !== "string" || !workDirCandidate) return true
    try {
      const resolved = path.resolve(workDirCandidate)
      if (!resolved.startsWith(realSessionWorkExpected + path.sep) && !resolved.startsWith(sessionWorkRoot + path.sep)) {
        return true
      }
      await rm(resolved, { recursive: true, force: true })
      return !(await existsNoFollow(resolved))
    } catch {
      return false
    }
  }

  async function recordRestoreRecordUnreadable(code, phase) {
    restoreRecordUnreadableCode = code
    const actor = isReclaimLockMode ? "operator" : "runner"
    process.stderr.write(
      `nextain-ai: relay restore record unreadable actor=${actor} phase=${phase} code=${code} reason=${AX_RELAY_RESTORE_RECORD_UNREADABLE_REASON}\n`,
    )
    await appendSessionLog({
      event: "restore-record",
      actor,
      action: "failed",
      phase,
      reason: AX_RELAY_RESTORE_RECORD_UNREADABLE_REASON,
      errorCode: code,
      at: wallNow(),
    })
  }

  async function restoreRepliesMode(phase = "startup") {
    restoreRecordUnreadableCode = null
    return restoreRepliesModeFromRecord(restorePath, repliesDir, {
      readRestoreFile: readRestoreFileHook ? (p) => readRestoreFileHook(p, phase) : undefined,
      onError: async (code) => {
        await recordRestoreRecordUnreadable(code, phase)
      },
    })
  }

  async function lockRepliesDir() {
    await restoreRepliesMode("pre-lock-replies")
    if (restoreRecordUnreadableCode) {
      const err = new Error("복원 기록을 읽거나 해석할 수 없습니다.")
      err.code = "ERESTORERECORD"
      throw err
    }
    const st = await lstat(repliesDir)
    const rawMode = st.mode & 0o777
    const originalMode = (rawMode & 0o700) === 0o700 ? rawMode : 0o700
    await writeAtomic0600(
      restorePath,
      `${JSON.stringify({ repliesMode: originalMode, at: wallNow(), pid: process.pid })}\n`,
    )
    await chmod(repliesDir, 0o500)
    return originalMode
  }

  async function inspectExistingLock() {
    let exists = false
    let stale = false
    let oldPid = 0
    let oldPgid = 0
    let oldWorkDir = null
    let pidIdentityMatched = false
    let sameBoot = false
    let bootStatus = "unknown"
    let bootUnknown = false
    let procStatus = "unknown"
    let procState = ""
    let procStopped = false
    let identityUnknown = false
    let legacyCompat = false
    let noMonotonicWallClockReclaim = false
    let reclaimReason = null
    let lockUnreadable = false
    let lockUnreadableCode = ""
    // Capture an identity independently of the optional diagnostic read hook.
    // A payload that cannot actually be read cannot authorize removal.
    let observedLock = null
    try {
      const observed = await readRegularFileNoFollow(lockPath)
      let token = null
      try { token = JSON.parse(observed.body)?.token ?? null } catch { /* malformed */ }
      observedLock = { stat: observed.opened, token, body: observed.body }
    } catch {
      try { observedLock = { stat: await lstat(lockPath), token: null, body: null } } catch { /* unavailable */ }
    }

    let loaded = null
    let readErr = null
    try {
      loaded = readLockFileHook
        ? await readLockFileHook(lockPath)
        : await readRegularFileNoFollow(lockPath)
      exists = true
      if (!observedLock || observedLock.body !== loaded.body ||
          (typeof loaded.opened?.dev === "number" && observedLock.stat.dev !== loaded.opened.dev) ||
          (typeof loaded.opened?.ino === "number" && observedLock.stat.ino !== loaded.opened.ino)) {
        observedLock = null
      }
    } catch (error) {
      if (error?.code === "ENOENT") {
        exists = false
      } else {
        exists = true
        readErr = error
        try {
          const st = await lstat(lockPath)
          if (!observedLock || st.dev !== observedLock.stat.dev || st.ino !== observedLock.stat.ino ||
              st.mtimeMs !== observedLock.stat.mtimeMs || st.ctimeMs !== observedLock.stat.ctimeMs) observedLock = null
        } catch { observedLock = null }
      }
    }

    if (!exists) {
      return {
        exists,
        stale,
        oldPid,
        oldPgid,
        oldWorkDir,
        pidIdentityMatched,
        sameBoot,
        bootStatus,
        bootUnknown,
        procStatus,
        procState,
        procStopped,
        identityUnknown,
        legacyCompat,
        noMonotonicWallClockReclaim,
        reclaimReason,
        lockUnreadable,
        lockUnreadableCode,
        observedLock,
      }
    }

    let parsed = null
    let parseErr = null
    if (!readErr) {
      try {
        parsed = JSON.parse(loaded.body)
      } catch (error) {
        parseErr = error
      }
    }

    if (readErr || parseErr || !isValidSessionLockShape(parsed)) {
      lockUnreadable = true
      lockUnreadableCode = readErr
        ? String(readErr?.code || "EREAD")
        : parseErr
          ? "EJSONPARSE"
          : "ESHAPE"
      procStatus = "unknown"
      identityUnknown = true
      bootStatus = "unknown"
      bootUnknown = true
      pidIdentityMatched = true
      sameBoot = true

      let mtimeMs =
        typeof loaded?.opened?.mtimeMs === "number" &&
        Number.isFinite(loaded.opened.mtimeMs) &&
        loaded.opened.mtimeMs > 0
          ? loaded.opened.mtimeMs
          : null
      if (mtimeMs === null) {
        try {
          const st = lstatLockFileHook ? await lstatLockFileHook(lockPath) : await lstat(lockPath)
          if (typeof st?.mtimeMs === "number" && Number.isFinite(st.mtimeMs) && st.mtimeMs > 0) {
            mtimeMs = st.mtimeMs
          }
        } catch (lstatError) {
          if (lstatError?.code === "ENOENT") {
            exists = false
            lockUnreadable = false
            return {
              exists,
              stale,
              oldPid,
              oldPgid,
              oldWorkDir,
              pidIdentityMatched,
              sameBoot,
              bootStatus,
              bootUnknown,
              procStatus,
              procState,
              procStopped,
              identityUnknown,
              legacyCompat,
              noMonotonicWallClockReclaim,
              reclaimReason,
              lockUnreadable,
              lockUnreadableCode,
            }
          }
          mtimeMs = null
        }
      }

      const now = wallNow()
      const exceededWallMax =
        mtimeMs !== null && now >= mtimeMs && now - mtimeMs >= AX_RELAY_LOCK_WALL_CLOCK_MAX_MS
      if (exceededWallMax) {
        stale = true
        noMonotonicWallClockReclaim = true
        reclaimReason = AX_RELAY_LOCK_UNREADABLE_RECLAIM_REASON
        noteWallClockMaxReclaim(0, "", reclaimReason, true, true)
      } else {
        stale = false
        reclaimReason = AX_RELAY_LOCK_UNREADABLE_DEFER_REASON
      }
      return {
        exists,
        stale,
        oldPid,
        oldPgid,
        oldWorkDir,
        pidIdentityMatched,
        sameBoot,
        bootStatus,
        bootUnknown,
        procStatus,
        procState,
        procStopped,
        identityUnknown,
        legacyCompat,
        noMonotonicWallClockReclaim,
        reclaimReason,
        lockUnreadable,
        lockUnreadableCode,
        observedLock,
      }
    }

    oldPid = parsed.pid
    const proc = getProcIdentity(oldPid)
    const evalResult = evaluateSessionLockPayload(parsed, proc, {
      nowMs: wallNow(),
      currentUptimeMs: getUptimeMs(),
      defaultTimeoutMs: timeoutMs,
      lockMtimeMs: loaded?.opened?.mtimeMs ?? null,
    })
    stale = evalResult.stale
    oldPid = evalResult.pid
    oldPgid = evalResult.pgid
    oldWorkDir = evalResult.workDir
    pidIdentityMatched = evalResult.pidIdentityMatched
    sameBoot = evalResult.sameBoot
    bootStatus = evalResult.bootStatus
    bootUnknown = evalResult.bootUnknown
    procStatus = evalResult.procStatus
    procState = evalResult.procState
    procStopped = evalResult.procStopped
    identityUnknown = evalResult.identityUnknown
    legacyCompat = evalResult.legacyCompat
    noMonotonicWallClockReclaim = evalResult.noMonotonicWallClockReclaim
    reclaimReason = evalResult.reclaimReason
    if (legacyCompat) {
      noteLegacyLockCompat(oldPid, evalResult.active)
    }
    if (noMonotonicWallClockReclaim) {
      noteWallClockMaxReclaim(oldPid, procState, reclaimReason, identityUnknown, bootUnknown)
    }
    return {
      exists,
      stale,
      oldPid,
      oldPgid,
      oldWorkDir,
      pidIdentityMatched,
      sameBoot,
      bootStatus,
      bootUnknown,
      procStatus,
      procState,
      procStopped,
      identityUnknown,
      legacyCompat,
      noMonotonicWallClockReclaim,
      reclaimReason,
      lockUnreadable,
      lockUnreadableCode,
      observedLock,
    }
  }

  async function recordLockUnreadableRejection(lockInfo, actor) {
    const code = lockInfo.lockUnreadableCode || "unknown"
    const reason =
      actor === "operator"
        ? `잠금 파일 읽기·해석 불가(lock-unreadable:${code}) → 회수 거부`
        : AX_RELAY_LOCK_UNREADABLE_DEFER_REASON
    process.stderr.write(
      `nextain-ai: relay lock reclaim rejected pid=${lockInfo.oldPid} state=unknown code=${code} reason=lock-unreadable (${reason})\n`,
    )
    await appendSessionLog({
      event: actor === "operator" ? "lock-reclaim" : "lock-unreadable",
      actor,
      action: "rejected",
      pid: lockInfo.oldPid,
      procState: "",
      reason: "lock-unreadable",
      errorCode: code,
      lockIdentityStatus: "unknown",
      lockReclaimReason: reason,
      at: wallNow(),
    })
  }

  async function recordEvictionDeferred(info, deferKind) {
    const pgStatus = info.oldPgid > 0 ? checkProcessGroupStatus(info.oldPgid, kill0Hook) : "unknown"
    const reason =
      deferKind === "process-group-unknown" || pgStatus === "unknown"
        ? AX_RELAY_LOCK_PGID_UNKNOWN_DEFER_REASON
        : "프로세스 종료 미확인 → 회수·복원 보류"
    process.stderr.write(
      `nextain-ai: relay lock reclaim deferred pid=${info.oldPid} pgid=${info.oldPgid} state=${info.procState || "unknown"} reason=${reason}\n`,
    )
    await appendSessionLog({
      event: "lock-reclaim",
      actor: isReclaimLockMode ? "operator" : "runner",
      action: "deferred",
      pid: info.oldPid,
      pgid: info.oldPgid,
      procState: info.procState || "",
      procGroupStatus: pgStatus,
      reason:
        deferKind === "process-group-unknown" || pgStatus === "unknown"
          ? "process-group-unknown"
          : "pid-termination-unconfirmed",
      lockReclaimReason: reason,
      at: wallNow(),
    })
  }

  async function withReclaimGuard(action) {
    let guard
    try {
      guard = await open(reclaimGuardPath, "wx", 0o600)
    } catch (error) {
      if (error?.code === "EEXIST") return false
      throw error
    }
    try {
      return await action()
    } finally {
      await guard.close()
      await rm(reclaimGuardPath)
    }
  }

  async function evictStaleLockAndRestore(info) {
    return withReclaimGuard(() => evictStaleLockUnderGuard(info))
  }

  async function sameObservedLock(info) {
    const old = info.observedLock
    if (!old?.stat || old.body === null || old.stat.isSymbolicLink() || !old.stat.isFile()) return false
    try {
      const current = await readRegularFileNoFollow(lockPath)
      let token = null
      try { token = JSON.parse(current.body)?.token ?? null } catch { /* malformed */ }
      return current.opened.dev === old.stat.dev && current.opened.ino === old.stat.ino &&
        token === old.token && current.body === old.body
    } catch {
      return false
    }
  }

  async function evictStaleLockUnderGuard(info) {
    // 옛 실행기와 세션 프로세스 그룹이 모두 끝났음을 먼저 확인한 뒤에야
    // 잠금 파일을 지우고 복원 기록으로 replies 원래 모드를 되돌린다.
    // 종료 확인이 실패하거나 프로세스 그룹 상태가 "모름"(kill(-pgid,0) EINVAL 등)이면
    // 잠금 파일과 replies 0500 을 그대로 유지하고 감사 기록을 남긴다.
    if (!(await sameObservedLock(info))) return false
    const pidReused =
      info.oldPid > 0 &&
      info.procStatus !== "dead" &&
      isPidAlive(info.oldPid) &&
      !info.pidIdentityMatched
    if (info.oldPgid > 0 && info.sameBoot && !pidReused) {
      try {
        process.kill(-info.oldPgid, "SIGTERM")
      } catch { /* ignore */ }
    }
    if (
      info.oldPid > 0 &&
      info.oldPid !== process.pid &&
      info.procStatus !== "dead" &&
      info.pidIdentityMatched &&
      isPidAlive(info.oldPid)
    ) {
      const pidDead = await terminatePid(info.oldPid, killGraceMs)
      if (!pidDead) {
        await recordEvictionDeferred(info, "pid-termination-unconfirmed")
        return false
      }
    }
    if (info.oldPgid > 0 && info.sameBoot && !pidReused) {
      const groupDead = await terminateProcessGroup(info.oldPgid, killGraceMs, kill0Hook)
      if (!groupDead) {
        await recordEvictionDeferred(info, "process-group-unknown")
        return false
      }
    }
    if (!(await sameObservedLock(info))) return false
    try {
      await (rmLockFileHook ? rmLockFileHook(lockPath) : rm(lockPath))
    } catch (error) {
      if (error?.code !== "ENOENT") {
        const code = String(error?.code || "ERM")
        const actor = isReclaimLockMode ? "operator" : "runner"
        process.stderr.write(
          `nextain-ai: relay lock reclaim failed pid=${info.oldPid} state=${info.procState || "unknown"} code=${code} reason=${AX_RELAY_LOCK_RM_FAILED_REASON}\n`,
        )
        await appendSessionLog({
          event: "lock-reclaim",
          actor,
          action: "failed",
          pid: info.oldPid,
          pgid: info.oldPgid,
          procState: info.procState || "",
          reason: AX_RELAY_LOCK_RM_FAILED_REASON,
          errorCode: code,
          at: wallNow(),
        })
        return false
      }
    }
    // 남은 세션이 종료 신호 처리 중에 옛 칸에 answer.md 를 썼더라도 옮겨지지 않게 지운다.
    await cleanupStaleWorkDir(info.oldWorkDir)
    const restored = await restoreRepliesMode("evict-stale-lock")
    if (restoreRecordUnreadableCode) {
      return false
    }
    if (!restored) {
      try {
        const st = await lstat(repliesDir)
        if ((st.mode & 0o700) !== 0o700) await chmod(repliesDir, 0o700)
      } catch { /* ignore */ }
    }
    if (info.noMonotonicWallClockReclaim && !wallClockReclaimAuditLogged) {
      wallClockReclaimAuditLogged = true
      await appendSessionLog({
        event: "lock-reclaim",
        actor: "runner",
        action: "reclaimed",
        pid: info.oldPid,
        procState: info.procState || "",
        ...(info.lockUnreadable
          ? { reason: "lock-unreadable", errorCode: info.lockUnreadableCode || "unknown" }
          : {}),
        lockReclaimReason: info.reclaimReason || AX_RELAY_LOCK_WALL_CLOCK_RECLAIM_REASON,
        ...(info.identityUnknown ? { lockIdentityStatus: "unknown" } : {}),
        ...(info.bootUnknown ? { lockBootStatus: "unknown" } : {}),
        ...(info.legacyCompat ? { legacyLockCompat: "stale" } : {}),
        at: wallNow(),
      })
    }
    return true
  }

  if (isReclaimLockMode) {
    const lockInfo = await inspectExistingLock()
    if (!lockInfo.exists) {
      const guarded = await withReclaimGuard(async () => {
        if ((await inspectExistingLock()).exists) return false
        const restored = await restoreRepliesMode("reclaim-no-lock")
        if (!restored && !restoreRecordUnreadableCode) {
          try {
            const st = await lstat(repliesDir)
            if ((st.mode & 0o700) !== 0o700) await chmod(repliesDir, 0o700)
          } catch { /* ignore */ }
        }
        return true
      })
      if (!guarded) process.exit(1)
      if (restoreRecordUnreadableCode) {
        process.exit(1)
      }
      const reason = "잠금 파일 없음 → 복원 기록 회수"
      process.stderr.write(`nextain-ai: relay lock reclaim pid=0 state=none reason=${reason}\n`)
      await appendSessionLog({
        event: "lock-reclaim",
        actor: "operator",
        action: "reclaimed",
        pid: 0,
        procState: "",
        lockReclaimReason: reason,
        at: wallNow(),
      })
      return
    }
    if (lockInfo.lockUnreadable && !lockInfo.stale) {
      await recordLockUnreadableRejection(lockInfo, "operator")
      process.exit(1)
    }
    if (!lockInfo.stale && (!lockInfo.procStopped || lockInfo.identityUnknown)) {
      const reason = "살아 있는 실행기 잠금 회수 거부"
      process.stderr.write(
        `nextain-ai: relay lock reclaim rejected pid=${lockInfo.oldPid} state=${lockInfo.procState || "unknown"} reason=${reason}\n`,
      )
      await appendSessionLog({
        event: "lock-reclaim",
        actor: "operator",
        action: "rejected",
        pid: lockInfo.oldPid,
        procState: lockInfo.procState || "",
        lockReclaimReason: reason,
        ...(lockInfo.identityUnknown ? { lockIdentityStatus: "unknown" } : {}),
        ...(lockInfo.bootUnknown ? { lockBootStatus: "unknown" } : {}),
        at: wallNow(),
      })
      process.exit(1)
    }
    const reclaimReason = lockInfo.noMonotonicWallClockReclaim
      ? lockInfo.reclaimReason || AX_RELAY_LOCK_WALL_CLOCK_RECLAIM_REASON
      : !lockInfo.pidIdentityMatched
        ? "죽은 실행기 잠금 회수"
        : lockInfo.procStopped
          ? "멈춘 실행기(T/t) 운영 잠금 회수"
          : "기한·heartbeat 만료 잠금 회수"
    wallClockReclaimAuditLogged = true
    const evicted = await evictStaleLockAndRestore(lockInfo)
    if (!evicted) {
      process.exit(1)
    }
    process.stderr.write(
      `nextain-ai: relay lock reclaim pid=${lockInfo.oldPid} state=${lockInfo.procState || "unknown"} reason=${reclaimReason}\n`,
    )
    await appendSessionLog({
      event: "lock-reclaim",
      actor: "operator",
      action: "reclaimed",
      pid: lockInfo.oldPid,
      procState: lockInfo.procState || "",
      ...(lockInfo.lockUnreadable
        ? { reason: "lock-unreadable", errorCode: lockInfo.lockUnreadableCode || "unknown" }
        : {}),
      lockReclaimReason: reclaimReason,
      ...(lockInfo.identityUnknown ? { lockIdentityStatus: "unknown" } : {}),
      ...(lockInfo.bootUnknown ? { lockBootStatus: "unknown" } : {}),
      ...(lockInfo.legacyCompat ? { legacyLockCompat: "stale" } : {}),
      at: wallNow(),
    })
    return
  }

  // 실행기가 시작할 때마다 대기 질문이 있든 없든 제일 먼저:
  // 살아 있는 잠금이 없고 복원 기록이 남아 있으면 원래 모드로 되돌리며,
  // 오래된 잠금이 있으면 남은 세션 그룹을 끝낸 뒤 같은 복원을 한다.
  // 잠금 파일 읽기·해석 오류(lock-unreadable)로 상한 안이면 시작을 거부하고 종료 코드 1로 끝낸다.
  let recoveredAtStartup = false
  let startupLockUnreadable = null
  let startupRestoreUnreadable = false
  {
    const lockInfo = await inspectExistingLock()
    if (!lockInfo.exists) {
      const guarded = await withReclaimGuard(async () => {
        if ((await inspectExistingLock()).exists) return false
        if (await restoreRepliesMode("startup")) recoveredAtStartup = true
        return true
      })
      if (!guarded) process.exit(1)
      if (restoreRecordUnreadableCode) {
        startupRestoreUnreadable = true
      }
    } else if (lockInfo.lockUnreadable && !lockInfo.stale) {
      startupLockUnreadable = lockInfo
    } else if (lockInfo.stale) {
      const evicted = await evictStaleLockAndRestore(lockInfo)
      if (!evicted) {
        process.exit(1)
      }
      recoveredAtStartup = true
    }
  }

  if (args.length !== 1 || typeof args[0] !== "string" || !path.isAbsolute(args[0])) {
    failConfig()
  }
  const inboxArg = args[0]
  const baseName = path.basename(inboxArg)
  const expectedInboxPath = path.join(inboxDir, baseName)
  if (
    !/^[a-f0-9]{64}\.json$/.test(baseName) ||
    path.resolve(inboxArg) !== expectedInboxPath ||
    path.normalize(inboxArg) !== expectedInboxPath
  ) {
    failConfig()
  }

  if (startupRestoreUnreadable) {
    process.exit(1)
  }

  if (startupLockUnreadable) {
    await recordLockUnreadableRejection(startupLockUnreadable, "runner")
    process.exit(1)
  }

  // inbox 파일 자체가 심볼릭 링크가 아닌 실제 보통 파일이며 실경로가 데이터 폴더 아래인지 확인.
  // 단, 시작 시 오래된 잠금/복원 기록을 복구한 실행에서 대기 질문이 이미 정리되어
  // 해당 inbox 파일이 사라진 경우(ENOENT)에는 복원 완료 후 정상 종료할 수 있게 허용한다.
  let initialInboxExists = false
  try {
    await readRegularFileNoFollow(inboxArg)
    const realInboxFile = await realpath(inboxArg)
    if (realInboxFile !== path.join(realInboxExpected, baseName)) failConfig()
    initialInboxExists = true
  } catch (error) {
    if (error?.code === "ENOENT" && recoveredAtStartup) {
      initialInboxExists = false
    } else {
      failConfig()
    }
  }

  async function tryAcquireLock() {
    return withReclaimGuard(tryAcquireLockUnderGuard)
  }

  async function tryAcquireLockUnderGuard() {
    lockReleaseAborted = false
    currentStartedAt = wallNow()
    currentStartedMono = performance.now()
    const payload = buildLockPayload()
    try {
      await writeFile(lockPath, payload, { encoding: "utf8", mode: 0o600, flag: "wx" })
      await chmod(lockPath, 0o600)
      const acquiredStat = await lstat(lockPath)
      currentLockStat = acquiredStat
      await restoreRepliesMode("acquire-lock")
      if (restoreRecordUnreadableCode) {
        await cleanupOwnLockOnAcquireFailure(acquiredStat)
        fatalRunnerError = true
        return false
      }
      return true
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
    }
    const lockInfo = await inspectExistingLock()
    if (lockInfo.exists && lockInfo.lockUnreadable && !lockInfo.stale) {
      await recordLockUnreadableRejection(lockInfo, "runner")
      fatalRunnerError = true
      return false
    }
    if (lockInfo.exists && !lockInfo.stale) return false
    if (lockInfo.exists && lockInfo.stale) {
      const evicted = await evictStaleLockUnderGuard(lockInfo)
      if (!evicted) {
        fatalRunnerError = true
        return false
      }
    } else {
      await restoreRepliesMode("acquire-lock")
      if (restoreRecordUnreadableCode) {
        fatalRunnerError = true
        return false
      }
    }

    currentStartedAt = wallNow()
    currentStartedMono = performance.now()
    try {
      await writeFile(lockPath, buildLockPayload(), { encoding: "utf8", mode: 0o600, flag: "wx" })
      await chmod(lockPath, 0o600)
      const acquiredStat = await lstat(lockPath)
      currentLockStat = acquiredStat
      await restoreRepliesMode("acquire-lock")
      if (restoreRecordUnreadableCode) {
        await cleanupOwnLockOnAcquireFailure(acquiredStat)
        fatalRunnerError = true
        return false
      }
      return true
    } catch (error) {
      if (error?.code === "EEXIST") return false
      throw error
    }
  }

  async function refreshLock() {
    let ran = false
    const refreshed = await withReclaimGuard(async () => {
      ran = true
      if (!(await ownsLock())) return false
      await writeAtomic0600(lockPath, buildLockPayload())
      currentLockStat = await lstat(lockPath)
      return true
    })
    // Another runner may hold the guard briefly while inspecting our live lock.
    // No write occurs on this tick; confirm ownership and retry on the next tick.
    return ran ? refreshed : await ownsLock()
  }

  async function releaseLock() {
    if (lockReleaseAborted) return
    const released = await withReclaimGuard(releaseLockUnderGuard)
    if (!released) {
      process.stderr.write("nextain-ai: relay lock release deferred reason=reclaim-guard-busy\n")
      fatalRunnerError = true
      lockReleaseAborted = true
    }
  }

  async function releaseLockUnderGuard() {
    try {
      if (await ownsLock()) {
        const priorRestoreErr = restoreRecordUnreadableCode
        if (priorRestoreErr) {
          await recordRestoreRecordUnreadable(priorRestoreErr, "release-lock")
          fatalRunnerError = true
          lockReleaseAborted = true
          return
        }
        await restoreRepliesMode("release-lock")
        if (restoreRecordUnreadableCode) {
          fatalRunnerError = true
          lockReleaseAborted = true
          return
        }
        try {
          await (rmLockFileHook ? rmLockFileHook(lockPath) : rm(lockPath))
          currentLockStat = null
        } catch (error) {
          if (error?.code !== "ENOENT") {
            const code = String(error?.code || "ERM")
            process.stderr.write(
              `nextain-ai: relay lock rm failed actor=runner phase=release-lock code=${code} reason=${AX_RELAY_LOCK_RM_FAILED_REASON}\n`,
            )
            await appendSessionLog({
              event: "lock-rm",
              actor: "runner",
              action: "failed",
              phase: "release-lock",
              pid: process.pid,
              reason: AX_RELAY_LOCK_RM_FAILED_REASON,
              errorCode: code,
              at: wallNow(),
            })
            fatalRunnerError = true
            lockReleaseAborted = true
          }
        }
      }
    } catch (error) {
      const code = String(error?.code || "ERELEASE")
      process.stderr.write(
        `nextain-ai: relay lock release failed actor=runner phase=release-lock code=${code} reason=lock-release-failed\n`,
      )
      await appendSessionLog({
        event: "lock-release",
        actor: "runner",
        action: "failed",
        phase: "release-lock",
        pid: process.pid,
        reason: "lock-release-failed",
        errorCode: code,
        at: wallNow(),
      })
      fatalRunnerError = true
      lockReleaseAborted = true
    }
    return true
  }

  async function reverifyRelayDirs() {
    await verifyOrCreateDir(relayRoot, realRelayRootExpected, false)
    await verifyOrCreateDir(inboxDir, realInboxExpected, false)
    await verifyOrCreateDir(repliesDir, realRepliesExpected, false)
    await verifyOrCreateDir(stateDir, realStateExpected, false)
    await verifyOrCreateDir(sessionWorkRoot, realSessionWorkExpected, false)
    await verifyOrCreateDir(sessionOutDir, realSessionOutExpected, false)
  }

  const attempted = new Set()

  async function recordQuestionStateUnreadable(id, errorCode) {
    fatalRunnerError = true
    attempted.add(id)
    const questionFile = `${id}.json`
    const sig = `state:${questionFile}:${errorCode}`
    if (reportedQuestionErrors.has(sig)) return
    reportedQuestionErrors.add(sig)
    process.stderr.write(
      `nextain-ai: relay question state unreadable file=${questionFile} code=${errorCode} reason=${AX_RELAY_STATE_UNREADABLE_REASON}\n`,
    )
    await appendSessionLog({
      event: "state-unreadable",
      actor: "runner",
      action: "skipped",
      file: questionFile,
      reason: AX_RELAY_STATE_UNREADABLE_REASON,
      errorCode,
      at: wallNow(),
    })
  }

  async function recordQuestionInboxUnreadable(id, errorCode) {
    fatalRunnerError = true
    attempted.add(id)
    const questionFile = `${id}.json`
    const sig = `inbox:${questionFile}:${errorCode}`
    if (reportedQuestionErrors.has(sig)) return
    reportedQuestionErrors.add(sig)
    process.stderr.write(
      `nextain-ai: relay question inbox unreadable file=${questionFile} code=${errorCode} reason=inbox-unreadable\n`,
    )
    await appendSessionLog({
      event: "inbox-unreadable",
      actor: "runner",
      action: "skipped",
      file: questionFile,
      reason: "inbox-unreadable",
      errorCode,
      at: wallNow(),
    })
  }

  async function isQuestionPending(id, allowMissingState = true) {
    const qPath = path.join(inboxDir, `${id}.json`)
    try {
      const qSt = await lstat(qPath)
      if (qSt.isSymbolicLink() || !qSt.isFile()) {
        await recordQuestionInboxUnreadable(id, "ENOTREGULAR")
        return false
      }
    } catch (error) {
      if (error?.code === "ENOENT") return false
      await recordQuestionInboxUnreadable(id, String(error?.code || "EREAD"))
      return false
    }
    if (await existsNoFollow(path.join(repliesDir, `${id}.md`))) return false
    if (await existsNoFollow(path.join(repliesDir, `${id}.md.ready`))) return false
    const statePath = path.join(stateDir, `${id}.json`)
    let body
    try {
      const loaded = readStateFileHook
        ? await readStateFileHook(statePath, id)
        : await readRegularFileNoFollow(statePath)
      body = typeof loaded === "string" ? loaded : loaded?.body
      if (typeof body !== "string") {
        const err = new Error("state 본문을 읽을 수 없습니다.")
        err.code = "EREAD"
        throw err
      }
    } catch (error) {
      if (error?.code === "ENOENT") return allowMissingState
      await recordQuestionStateUnreadable(id, String(error?.code || "EREAD"))
      return false
    }
    let state
    try {
      state = JSON.parse(body)
    } catch {
      await recordQuestionStateUnreadable(id, "EJSONPARSE")
      return false
    }
    if (!state || typeof state !== "object" || Array.isArray(state) || typeof state.state !== "string") {
      await recordQuestionStateUnreadable(id, "ESHAPE")
      return false
    }
    return state.state === "pending"
  }

  async function listPendingIds() {
    let names
    try {
      names = await readdir(inboxDir)
    } catch (error) {
      if (error?.code === "ENOENT") return []
      throw error
    }
    const out = []
    for (const name of names.sort()) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      const id = name.slice(0, -5)
      if (attempted.has(id)) continue
      if (await isQuestionPending(id, true)) out.push(id)
    }
    return out
  }

  async function promoteValidatedAnswer(id, workDir, expectedRoleSnapshot) {
    const answerPath = path.join(workDir, "answer.md")
    let loaded
    try {
      loaded = await readRegularFileNoFollow(answerPath, maxAnswerBytes)
    } catch (error) {
      if (error?.code === "ENOENT") return { status: "missing" }
      return { status: "rejected", reason: String(error?.code || "INVALID") }
    }
    const finalReplyPath = path.join(repliesDir, `${id}.md`)
    const finalReadyPath = path.join(repliesDir, `${id}.md.ready`)
    if ((await existsNoFollow(finalReplyPath)) || (await existsNoFollow(finalReadyPath))) {
      return { status: "skipped-existing" }
    }
    if (!(await ownsLock())) {
      return { status: "aborted-stale-lock" }
    }
    // 답 옮기기는 역할 폴더·원본 AGENTS.md 무결성 검사가 통과한 상태에서 쓰기 직전까지 유지될 때만 한다.
    const preWriteRoleSnapshot = await snapshotRoleIntegrity(sessionDir, realSessionDir)
    if (!isSameIntegritySnapshot(expectedRoleSnapshot, preWriteRoleSnapshot)) {
      return { status: "rejected", reason: "ROLE_AGENTS_MODIFIED" }
    }
    await writeAtomic0600(finalReplyPath, loaded.body)
    await writeAtomic0600(finalReadyPath, "")
    return { status: "promoted" }
  }

  async function runOneSession(id) {
    await reverifyRelayDirs()
    if (!(await ownsLock())) return { roleAgentsTampered: false, fatalError: true }

    const questionFile = `${id}.json`
    const questionPath = path.join(inboxDir, questionFile)
    const outLogPath = path.join(sessionOutDir, `${id}.log`)

    // inbox 파일에서 방·이벤트 번호를 뺀 본문·보낸 사람·시각만 추출
    let rawQuestion
    try {
      const { body } = await readRegularFileNoFollow(questionPath)
      try {
        rawQuestion = JSON.parse(body)
      } catch {
        const parseErr = new Error("inbox JSON 해석 실패")
        parseErr.code = "EJSONPARSE"
        throw parseErr
      }
      if (!rawQuestion || typeof rawQuestion !== "object" || Array.isArray(rawQuestion)) {
        const shapeErr = new Error("inbox 기록 꼴 오류")
        shapeErr.code = "ESHAPE"
        throw shapeErr
      }
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { roleAgentsTampered: false, fatalError: false }
      }
      await recordQuestionInboxUnreadable(id, String(error?.code || "EREAD"))
      return { roleAgentsTampered: false, fatalError: true }
    }
    const sanitizedQuestion = {
      sender: typeof rawQuestion?.sender === "string" ? rawQuestion.sender : "",
      timestamp: typeof rawQuestion?.timestamp === "number" ? rawQuestion.timestamp : 0,
      body: typeof rawQuestion?.body === "string" ? rawQuestion.body : "",
    }

    // 운영자 역할 폴더 권한은 바꾸지 않으며, 세션 전 역할 폴더(dev·inode)와
    // 원본 AGENTS.md(dev·inode·크기·mtime·SHA-256)의 고정된 무결성 기준을 얻는다.
    const beforeAgentsSnapshot = await snapshotRoleIntegrity(sessionDir, realSessionDir)
    if (!beforeAgentsSnapshot.valid) failConfig()
    const currentAgentsMd = beforeAgentsSnapshot.body

    const workDirName = `${id}-${randomBytes(8).toString("hex")}`
    const workDir = path.join(sessionWorkRoot, workDirName)
    await mkdir(workDir, { recursive: false, mode: 0o700 })
    await chmod(workDir, 0o700)

    const workQuestionPath = path.join(workDir, "question.json")
    const workAgentsPath = path.join(workDir, "AGENTS.md")
    await writeFile(workQuestionPath, `${JSON.stringify(sanitizedQuestion)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    })
    await chmod(workQuestionPath, 0o600)
    await writeFile(workAgentsPath, currentAgentsMd, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    })
    await chmod(workAgentsPath, 0o600)

    currentStartedAt = wallNow()
    currentStartedMono = performance.now()
    currentWorkDir = workDir
    currentPgid = 0
    if (!(await refreshLock())) {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
      return { roleAgentsTampered: false, fatalError: true }
    }

    const startedAt = currentStartedAt
    const startedMono = currentStartedMono
    await writeFile(outLogPath, "", { encoding: "utf8", mode: 0o600 })
    await chmod(outLogPath, 0o600)

    const childEnv = buildSessionEnv(process.env)
    let repliesSnapshot = null
    let repliesSnapshotConfirmed = false
    try {
      const entries = readdirRepliesHook
        ? await readdirRepliesHook(repliesDir, "pre-session", id)
        : await readdir(repliesDir)
      if (!Array.isArray(entries)) {
        const err = new Error("replies 목록이 배열이 아닙니다.")
        err.code = "EREAD"
        throw err
      }
      repliesSnapshot = new Set(entries)
      repliesSnapshotConfirmed = true
    } catch (error) {
      if (error?.code === "ENOENT") {
        repliesSnapshot = new Set()
        repliesSnapshotConfirmed = true
      } else {
        const code = String(error?.code || "EREAD")
        currentPgid = 0
        currentWorkDir = null
        await refreshLock().catch(() => undefined)
        await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
        process.stderr.write(
          `nextain-ai: relay replies snapshot unreadable phase=pre-session file=${questionFile} code=${code} reason=${AX_RELAY_REPLIES_SNAPSHOT_UNREADABLE_REASON}\n`,
        )
        await appendSessionLog({
          event: "replies-snapshot",
          actor: "runner",
          action: "aborted",
          phase: "pre-session",
          file: questionFile,
          reason: AX_RELAY_REPLIES_SNAPSHOT_UNREADABLE_REASON,
          errorCode: code,
          at: wallNow(),
        })
        fatalRunnerError = true
        return { roleAgentsTampered: false, fatalError: true }
      }
    }

    // 공유 replies 폴더를 잠그기 전에 원래 모드를 relay/session-restore.json(0600, 원자 rename)에 적는다.
    // 운영자 역할 폴더와 AGENTS.md 권한은 절대 바꾸지 않는다.
    let originalRepliesMode
    try {
      originalRepliesMode = await lockRepliesDir()
    } catch (error) {
      currentPgid = 0
      currentWorkDir = null
      await refreshLock().catch(() => undefined)
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
      fatalRunnerError = true
      return { roleAgentsTampered: false, fatalError: true }
    }

    let result
    let answerOutcome = { status: "missing" }
    let cleanupFailed = false
    let groupTerminated = true
    let sessionFatalError = false
    let activeChild = null
    let heartbeatRunning = null
    let lockLost = false
    const checkHeartbeat = () => {
      if (heartbeatRunning || lockLost) return
      heartbeatRunning = (async () => {
        try {
          if (await refreshLock()) return
        } catch { /* A failed refresh cannot establish ownership. */ }
        lockLost = true
        sessionFatalError = true
        fatalRunnerError = true
        process.stderr.write("nextain-ai: relay session lock lost reason=lock-lost\n")
        await appendSessionLog({ event: "lock-lost", actor: "runner", action: "aborted", pid: process.pid, at: wallNow() })
        if (currentPgid > 0) {
          await terminateProcessGroup(currentPgid, killGraceMs, kill0Hook)
        } else if (activeChild) {
          try { activeChild.kill("SIGTERM") } catch { /* child already exited */ }
        }
      })().finally(() => { heartbeatRunning = null })
    }
    const heartbeatTimer = setInterval(checkHeartbeat, heartbeatIntervalMs)

    try {
      result = await new Promise((resolve) => {
        let timedOut = false
        let settled = false
        let writeChain = Promise.resolve()

        const enqueueWrite = (text) => {
          if (!text) return
          writeChain = writeChain
            .then(() => appendFile(outLogPath, text, { encoding: "utf8", mode: 0o600 }))
            .catch(() => undefined)
        }

        const stdoutRedactor = createStreamRedactor(enqueueWrite)
        const stderrRedactor = createStreamRedactor(enqueueWrite)

        let child
        try {
          child = spawn(sessionCmd[0], [...sessionCmd.slice(1), FIXED_INSTRUCTION], {
            cwd: workDir,
            env: childEnv,
            shell: false,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
          })
          activeChild = child
        } catch {
          resolve({ exitCode: 1, timedOut: false })
          return
        }

        if (typeof child.pid === "number" && child.pid > 0) {
          currentPgid = child.pid
          checkHeartbeat()
        }

        const timeoutTimer = setTimeout(() => {
          timedOut = true
          if (currentPgid > 0) {
            void terminateProcessGroup(currentPgid, killGraceMs, kill0Hook)
          } else {
            try { child.kill("SIGTERM") } catch { /* ignore */ }
          }
        }, timeoutMs)

        child.stdout.on("data", (chunk) => stdoutRedactor.push(chunk))
        child.stderr.on("data", (chunk) => stderrRedactor.push(chunk))

        child.on("exit", () => {
          // 세션 본체가 끝났을 때 같은 그룹에 남은 하위 프로세스도 함께 정리한다.
          if (currentPgid > 0 && isProcessGroupAlive(currentPgid, kill0Hook)) {
            void terminateProcessGroup(currentPgid, killGraceMs, kill0Hook)
          }
        })

        const finish = (code) => {
          if (settled) return
          settled = true
          clearTimeout(timeoutTimer)
          stdoutRedactor.end()
          stderrRedactor.end()
          void (async () => {
            if (currentPgid > 0) {
              groupTerminated = await terminateProcessGroup(currentPgid, killGraceMs, kill0Hook)
            }
            await writeChain
            resolve({
              exitCode: typeof code === "number" ? code : timedOut ? -1 : 1,
              timedOut,
            })
          })()
        }

        child.on("error", () => finish(1))
        child.on("close", (code) => finish(code))
      })
    } finally {
      clearInterval(heartbeatTimer)
      if (heartbeatRunning) await heartbeatRunning
      if (!(await ownsLock())) {
        process.stderr.write("nextain-ai: relay session lock lost reason=lock-lost-post-session\n")
        sessionFatalError = true
        fatalRunnerError = true
      }
      if (!groupTerminated) {
        const pgStatus =
          currentPgid > 0 ? checkProcessGroupStatus(currentPgid, kill0Hook) : "unknown"
        process.stderr.write(
          `nextain-ai: relay session group cleanup deferred pgid=${currentPgid} status=${pgStatus} reason=${AX_RELAY_LOCK_PGID_UNKNOWN_DEFER_REASON}\n`,
        )
        await appendSessionLog({
          event: "lock-reclaim",
          actor: "runner",
          action: "deferred",
          pid: process.pid,
          pgid: currentPgid,
          procGroupStatus: pgStatus,
          reason: "process-group-unknown",
          lockReclaimReason: AX_RELAY_LOCK_PGID_UNKNOWN_DEFER_REASON,
          at: wallNow(),
        })
        process.exit(1)
      }
      if (await ownsLock()) {
        const restored = await restoreRepliesMode("post-session")
        if (restoreRecordUnreadableCode) {
          fatalRunnerError = true
          sessionFatalError = true
        } else if (!restored) {
          await chmod(repliesDir, originalRepliesMode).catch(() => undefined)
        }
        // 정리 단계에서 "세션 뒤 새로 생긴 파일"을 지우는 것은 세션 전 스냅샷이 확실할 때만 하며,
        // 다른 질문 이름의 답 파일(<otherId>.md, <otherId>.md.ready 등)은 어떤 경우에도 지우지 않는다.
        if (repliesSnapshotConfirmed && repliesSnapshot) {
          try {
            const postEntries = readdirRepliesHook
              ? await readdirRepliesHook(repliesDir, "post-session", id)
              : await readdir(repliesDir)
            if (!Array.isArray(postEntries)) {
              const err = new Error("세션 뒤 replies 목록이 배열이 아닙니다.")
              err.code = "EREAD"
              throw err
            }
            for (const name of postEntries) {
              if (!repliesSnapshot.has(name)) {
                const entryPath = path.join(repliesDir, name)
                let isSymlink = false
                try {
                  const st = await lstat(entryPath)
                  isSymlink = st.isSymbolicLink()
                } catch {
                  continue
                }
                if (!isProtectedReplyEntry(name, id, { isSymbolicLink: isSymlink })) {
                  await rm(entryPath, { recursive: true, force: true }).catch(() => undefined)
                }
              }
            }
          } catch (error) {
            const code = String(error?.code || "EREAD")
            process.stderr.write(
              `nextain-ai: relay replies snapshot unreadable phase=post-session file=${questionFile} code=${code} reason=${AX_RELAY_REPLIES_SNAPSHOT_UNREADABLE_REASON}\n`,
            )
            await appendSessionLog({
              event: "replies-snapshot",
              actor: "runner",
              action: "skipped-cleanup",
              phase: "post-session",
              file: questionFile,
              reason: AX_RELAY_REPLIES_SNAPSHOT_UNREADABLE_REASON,
              errorCode: code,
              at: wallNow(),
            })
            fatalRunnerError = true
            sessionFatalError = true
          }
        }
      }
    }

    // 세션 뒤에 역할 폴더(dev·inode)와 원본 AGENTS.md(dev·inode·크기·mtime·SHA-256)를
    // 같은 방식으로 다시 얻어 하나라도 다르면 기록하고 종료 코드를 0이 아니게 하며 답을 옮기지 않는다.
    const afterAgentsSnapshot = await snapshotRoleIntegrity(sessionDir, realSessionDir)
    let roleAgentsTampered = !isSameIntegritySnapshot(beforeAgentsSnapshot, afterAgentsSnapshot)

    if (roleAgentsTampered) {
      answerOutcome = { status: "rejected", reason: "ROLE_AGENTS_MODIFIED" }
    } else if (sessionFatalError) {
      answerOutcome = { status: "aborted-session-error" }
    } else if (await ownsLock()) {
      answerOutcome = await promoteValidatedAnswer(id, workDir, beforeAgentsSnapshot)
      if (answerOutcome.status === "rejected" && answerOutcome.reason === "ROLE_AGENTS_MODIFIED") {
        roleAgentsTampered = true
      }
    } else {
      answerOutcome = { status: "aborted-stale-lock" }
    }

    currentPgid = 0
    currentWorkDir = null
    await refreshLock().catch(() => undefined)

    try {
      await rm(workDir, { recursive: true, force: true })
      if (await existsNoFollow(workDir)) cleanupFailed = true
    } catch {
      cleanupFailed = true
    }

    const endedAt = wallNow()
    const durationMs = Math.max(0, Math.round(performance.now() - startedMono))
    const logRecord = {
      file: questionFile,
      startedAt,
      endedAt,
      exitCode: result.exitCode,
      durationMs,
      ...(result.timedOut ? { timedOut: true } : {}),
      ...(roleAgentsTampered ? { roleAgentsModified: true } : {}),
      ...(answerOutcome.status === "rejected"
        ? { answerRejected: true, rejectReason: answerOutcome.reason }
        : {}),
      ...(cleanupFailed ? { cleanupFailed: true } : {}),
      ...(legacyLockCompatDecision ? { legacyLockCompat: legacyLockCompatDecision } : {}),
      ...(reclaimedIdentityUnknown ? { lockIdentityStatus: "unknown" } : {}),
      ...(reclaimedBootUnknown ? { lockBootStatus: "unknown" } : {}),
      ...(reclaimedWallClockReason ? { lockReclaimReason: reclaimedWallClockReason } : {}),
    }
    await appendSessionLog(logRecord)
    if (roleAgentsTampered) {
      process.stderr.write("원본 AGENTS.md 가 세션 중 변경되어 답을 반영하지 않고 중단합니다.\n")
      return { roleAgentsTampered: true, fatalError: true }
    }
    return { roleAgentsTampered: false, fatalError: sessionFatalError }
  }

  async function pruneSessionArtifacts() {
    const now = wallNow()
    try {
      const files = await readdir(sessionOutDir)
      for (const file of files) {
        if (!/^[a-f0-9]{64}\.log$/.test(file)) continue
        const fullPath = path.join(sessionOutDir, file)
        try {
          const st = await lstat(fullPath)
          if (now - st.mtimeMs >= retainMs) {
            await rm(fullPath, { force: true })
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    try {
      const entries = await readdir(sessionWorkRoot)
      for (const entry of entries) {
        if (!/^[a-f0-9]{64}-[a-f0-9]{16}$/.test(entry)) continue
        const fullPath = path.join(sessionWorkRoot, entry)
        if (fullPath === currentWorkDir) continue
        try {
          const st = await lstat(fullPath)
          if (now - st.mtimeMs >= retainMs) {
            await rm(fullPath, { recursive: true, force: true })
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  if (!(await tryAcquireLock())) {
    process.exit(fatalRunnerError ? 1 : 0)
  }

  // repliesDir 는 원래 모드를 보존해야 하므로 여기서 0700 으로 덮어쓰지 않는다.
  for (const dir of [relayRoot, inboxDir, stateDir, sessionWorkRoot, sessionOutDir]) {
    await chmod(dir, 0o700)
  }

  const initialId = baseName.slice(0, -5)
  let fatalRoleTampered = false

  try {
    for (;;) {
      try {
        if (
          initialInboxExists &&
          !attempted.has(initialId) &&
          (await isQuestionPending(initialId, true))
        ) {
          attempted.add(initialId)
          const outcome = await runOneSession(initialId)
          if (outcome?.roleAgentsTampered) {
            fatalRoleTampered = true
            break
          }
          if (outcome?.fatalError) {
            fatalRunnerError = true
            break
          }
        } else if (initialInboxExists && !attempted.has(initialId)) {
          attempted.add(initialId)
        }
        for (;;) {
          if (!(await ownsLock())) break
          const pending = (await listPendingIds()).filter((id) => !attempted.has(id))
          if (pending.length === 0) break
          const nextId = pending[0]
          attempted.add(nextId)
          const outcome = await runOneSession(nextId)
          if (outcome?.roleAgentsTampered) {
            fatalRoleTampered = true
            break
          }
          if (outcome?.fatalError) {
            fatalRunnerError = true
            break
          }
        }
        if (fatalRoleTampered || fatalRunnerError) break
        if (await ownsLock()) {
          await pruneSessionArtifacts()
        }
      } finally {
        await releaseLock()
      }
      if (fatalRoleTampered || fatalRunnerError) break
      const afterRelease = (await listPendingIds()).filter((id) => !attempted.has(id))
      if (afterRelease.length === 0) break
      if (!(await tryAcquireLock())) break
    }
  } finally {
    await releaseLock()
  }

  if (fatalRoleTampered || fatalRunnerError) {
    process.exit(1)
  }
}

const isMainModule =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMainModule) {
  await main()
}
