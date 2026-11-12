import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"

export const GATE_SECRET_HEADER = "x-naia-gate-secret"
export const GATE_VERIFIED_HEADER = "x-naia-gate-verified"

const GATE_SECRET_CACHE_TTL_MS = 5000
const PROCESS_KEY_SYMBOL = Symbol.for("naia.dashboard.gateVerifyProcessKey")

function getProcessVerifyKey() {
  if (typeof globalThis[PROCESS_KEY_SYMBOL] !== "string" || globalThis[PROCESS_KEY_SYMBOL].length < 64) {
    globalThis[PROCESS_KEY_SYMBOL] = crypto.randomBytes(32).toString("hex")
  }
  return globalThis[PROCESS_KEY_SYMBOL]
}

let gateSecretCache = {
  filePath: null,
  ino: null,
  mtimeMs: -1,
  size: -1,
  mode: -1,
  readAt: 0,
  value: null,
}

export function clearGateSecretCache() {
  gateSecretCache = {
    filePath: null,
    ino: null,
    mtimeMs: -1,
    size: -1,
    mode: -1,
    readAt: 0,
    value: null,
  }
}

/**
 * NAIA_GATE_SECRET_FILE 환경 변수에서 공유 비밀 값을 읽는다.
 * - 설정되지 않았거나, 절대 경로가 아니거나, 파일이 없거나, 권한이 600 이 아니거나,
 *   앞뒤 공백을 뺀 길이가 32자 미만이면 null("비밀 없음" 상태)을 돌려준다.
 * @param {Record<string, string | undefined>} [env]
 * @param {number} [now]
 * @returns {string | null}
 */
export function readGateSecret(env = process.env, now = Date.now()) {
  const rawPath = typeof env?.NAIA_GATE_SECRET_FILE === "string" ? env.NAIA_GATE_SECRET_FILE.trim() : ""
  if (!rawPath || !path.isAbsolute(rawPath)) {
    return null
  }

  let st
  try {
    st = fs.lstatSync(rawPath)
  } catch {
    return null
  }

  if (!st.isFile() || (st.mode & 0o777) !== 0o600) {
    return null
  }

  if (
    gateSecretCache.filePath === rawPath &&
    gateSecretCache.ino === st.ino &&
    gateSecretCache.mtimeMs === st.mtimeMs &&
    gateSecretCache.size === st.size &&
    gateSecretCache.mode === st.mode &&
    now - gateSecretCache.readAt < GATE_SECRET_CACHE_TTL_MS
  ) {
    return gateSecretCache.value
  }

  let val = null
  try {
    const trimmed = fs.readFileSync(rawPath, "utf-8").trim()
    if (trimmed.length >= 32 && !/[\r\n\0]/.test(trimmed)) {
      val = trimmed
    }
  } catch {
    val = null
  }

  gateSecretCache = {
    filePath: rawPath,
    ino: st.ino,
    mtimeMs: st.mtimeMs,
    size: st.size,
    mode: st.mode,
    readAt: now,
    value: val,
  }

  return val
}

/**
 * 상수 시간 비밀 비교 (양쪽 SHA-256 다이제스트를 timingSafeEqual 로 비교해 길이가 달라도 시간이 새지 않게 함)
 */
export function verifyGateSecretValue(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false
  if (!provided || !expected || provided.includes(",") || expected.includes(",")) return false
  const a = crypto.createHash("sha256").update(provided, "utf8").digest()
  const b = crypto.createHash("sha256").update(expected, "utf8").digest()
  return crypto.timingSafeEqual(a, b)
}

/**
 * 이 프로세스 안에서만 유효한 가드 통과 확인 표시 토큰 생성·검증
 */
export function computeGateVerifiedToken(gateSecret) {
  if (typeof gateSecret !== "string" || !gateSecret) return ""
  return crypto
    .createHmac("sha256", getProcessVerifyKey())
    .update(gateSecret, "utf8")
    .digest("hex")
}

export function verifyGateVerifiedToken(token, gateSecret) {
  if (typeof token !== "string" || !token || token.includes(",")) return false
  const expected = computeGateVerifiedToken(gateSecret)
  if (!expected) return false
  const a = crypto.createHash("sha256").update(token, "utf8").digest()
  const b = crypto.createHash("sha256").update(expected, "utf8").digest()
  return crypto.timingSafeEqual(a, b)
}

/**
 * IP 주소 정규화 (IPv4-mapped IPv6 ::ffff:a.b.c.d 풀기)
 */
export function normalizeRemoteIp(ip) {
  if (!ip || typeof ip !== "string") return ""
  const trimmed = ip.trim().toLowerCase()
  if (trimmed.startsWith("::ffff:")) {
    return trimmed.slice(7)
  }
  return trimmed
}

/**
 * 루프백(127.0.0.0/8 또는 ::1)인지 판정
 */
export function isLoopbackIp(ip) {
  const norm = normalizeRemoteIp(ip)
  if (!norm) return false
  if (norm === "::1" || norm === "0:0:0:0:0:0:0:1") return true
  if (net.isIP(norm) === 4) {
    const parts = norm.split(".")
    return parts[0] === "127"
  }
  return false
}

/**
 * NAIA_IDENTITY_TRUSTED_PROXIES 환경 변수(쉼표로 나눈 IP 목록)를 정규화된 집합으로 반환
 * @param {Record<string, string | undefined>} [env]
 * @returns {Set<string>}
 */
export function parseTrustedProxyIps(env = process.env) {
  const raw = env?.NAIA_IDENTITY_TRUSTED_PROXIES
  if (!raw || typeof raw !== "string") return new Set()
  const out = new Set()
  for (const part of raw.split(",")) {
    const norm = normalizeRemoteIp(part)
    if (norm) out.add(norm)
  }
  return out
}

/**
 * 요청 소켓 원격 주소가 신원 머리글을 믿을 수 있는 출처(루프백 또는 NAIA_IDENTITY_TRUSTED_PROXIES)인지 판정
 * @param {string | undefined | null} remoteAddress
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isTrustedIdentityPeer(remoteAddress, env = process.env) {
  const norm = normalizeRemoteIp(remoteAddress)
  if (!norm) return false
  if (isLoopbackIp(norm)) return true
  const trusted = parseTrustedProxyIps(env)
  return trusted.has(norm)
}

function isWebHeaders(headers) {
  return Boolean(headers && typeof headers.get === "function" && typeof headers.delete === "function")
}

/**
 * 단일 머리글 값을 읽고, 같은 머리글이 여러 번 온 경우(배열·쉼표로 합쳐진 값·중복 키)는 valid: false 로 판정한다.
 */
export function inspectSingleHeaderOnReq(req, targetLower) {
  if (!req || typeof req !== "object" || !targetLower) {
    return { present: false, valid: true, value: null }
  }

  let headerVal
  if (isWebHeaders(req.headers)) {
    const got = req.headers.get(targetLower)
    if (got !== null) {
      headerVal = got
    }
  } else if (req.headers && typeof req.headers === "object") {
    const matchingKeys = Object.keys(req.headers).filter((k) => k.trim().toLowerCase() === targetLower)
    if (matchingKeys.length > 1) {
      return { present: true, valid: false, value: null }
    }
    if (matchingKeys.length === 1) {
      headerVal = req.headers[matchingKeys[0]]
    }
  }

  if (Array.isArray(req.rawHeaders)) {
    let rawCount = 0
    let rawVal
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i]
      if (typeof k === "string" && k.trim().toLowerCase() === targetLower) {
        rawCount++
        rawVal = req.rawHeaders[i + 1]
      }
    }
    if (rawCount > 1) {
      return { present: true, valid: false, value: null }
    }
    if (rawCount === 1) {
      if (typeof rawVal !== "string" || rawVal.includes(",")) {
        return { present: true, valid: false, value: null }
      }
      if (headerVal === undefined) {
        headerVal = rawVal
      } else if (headerVal !== rawVal) {
        return { present: true, valid: false, value: null }
      }
    }
  }

  if (headerVal === undefined) {
    return { present: false, valid: true, value: null }
  }
  if (typeof headerVal !== "string" || headerVal.includes(",")) {
    return { present: true, valid: false, value: null }
  }
  return { present: true, valid: true, value: headerVal }
}

/**
 * Headers 또는 일반 객체에서 단일 머리글 값을 검사한다.
 */
export function inspectSingleHeaderInBag(headers, targetName) {
  if (!headers || !targetName) {
    return { present: false, valid: true, value: null }
  }
  const targetLower = targetName.trim().toLowerCase()
  if (isWebHeaders(headers)) {
    const val = headers.get(targetLower) ?? headers.get(targetName)
    if (val === null || val === undefined) {
      return { present: false, valid: true, value: null }
    }
    if (typeof val !== "string" || val.includes(",")) {
      return { present: true, valid: false, value: null }
    }
    return { present: true, valid: true, value: val }
  }
  if (typeof headers === "object") {
    const matchingKeys = Object.keys(headers).filter((k) => k.trim().toLowerCase() === targetLower)
    if (matchingKeys.length === 0) {
      return { present: false, valid: true, value: null }
    }
    if (matchingKeys.length > 1) {
      return { present: true, valid: false, value: null }
    }
    const val = headers[matchingKeys[0]]
    if (val === undefined || val === null) {
      return { present: false, valid: true, value: null }
    }
    if (typeof val !== "string" || val.includes(",")) {
      return { present: true, valid: false, value: null }
    }
    return { present: true, valid: true, value: val }
  }
  return { present: false, valid: true, value: null }
}

/**
 * 요청 머리글 묶음이 이 프로세스의 가드 비밀 검증을 거쳤는지 확인한다.
 * @param {Headers | Record<string, string | string[] | undefined> | null | undefined} headers
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isGateVerifiedHeaders(headers, env = process.env) {
  const gateSecret = readGateSecret(env)
  if (!gateSecret) return false
  const verified = inspectSingleHeaderInBag(headers, GATE_VERIFIED_HEADER)
  if (!verified.present || !verified.valid || !verified.value) return false
  return verifyGateVerifiedToken(verified.value, gateSecret)
}

function removeHeadersFromReq(req, targetSet) {
  if (!targetSet || targetSet.size === 0) return

  if (isWebHeaders(req.headers)) {
    for (const target of targetSet) {
      req.headers.delete(target)
    }
  } else if (req.headers && typeof req.headers === "object") {
    for (const key of Object.keys(req.headers)) {
      if (targetSet.has(key.trim().toLowerCase())) {
        delete req.headers[key]
      }
    }
  }

  if (Array.isArray(req.rawHeaders)) {
    const filtered = []
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const rawKey = req.rawHeaders[i]
      const rawVal = req.rawHeaders[i + 1]
      if (typeof rawKey === "string" && targetSet.has(rawKey.trim().toLowerCase())) {
        continue
      }
      filtered.push(rawKey)
      if (i + 1 < req.rawHeaders.length) {
        filtered.push(rawVal)
      }
    }
    req.rawHeaders.splice(0, req.rawHeaders.length, ...filtered)
  }
}

function setHeaderOnReq(req, lowerName, value) {
  if (isWebHeaders(req.headers)) {
    req.headers.set(lowerName, value)
  } else if (req.headers && typeof req.headers === "object") {
    req.headers[lowerName] = value
  }
}

/**
 * 대시보드 입구 머리글 가드:
 * 1) 요청의 x-naia-gate-secret 와 바깥에서 꾸민 x-naia-gate-verified 를 읽은 뒤
 *    req.headers 와 req.rawHeaders 에서 항상 지운다.
 * 2) NAIA_GATE_SECRET_FILE 비밀이 유효하게 설정되어 있으면:
 *    믿는 출처(루프백 · NAIA_IDENTITY_TRUSTED_PROXIES)이면서 단일 x-naia-gate-secret 값이
 *    상수 시간 비교로 일치할 때만 사용자 머리글을 남기고
 *    내부 검증 표시(x-naia-gate-verified)를 붙인다. 아니면 사용자 머리글을 모두 지운다.
 * 3) 비밀이 설정되어 있지 않으면:
 *    메모 작성자 머리글(NAIA_NOTE_USER_HEADER)은 기존 동작(믿는 출처면 유지, 아니면 제거)을 유지하고,
 *    개인 일정 전용 머리글은 제거하며 내부 검증 표시도 붙이지 않는다.
 * @template T
 * @param {T} req
 * @param {Record<string, string | undefined>} [env]
 * @returns {T}
 */
export function stripUntrustedIdentityHeaders(req, env = process.env) {
  if (!req || typeof req !== "object") return req

  const secretInfo = inspectSingleHeaderOnReq(req, GATE_SECRET_HEADER)
  removeHeadersFromReq(req, new Set([
    GATE_SECRET_HEADER,
    GATE_VERIFIED_HEADER,
    "x-naia-actor-id",
    "x-naia-actor-verified",
  ]))

  const rawScheduleHeader =
    typeof env?.NAIA_SCHEDULE_USER_HEADER === "string" ? env.NAIA_SCHEDULE_USER_HEADER.trim().toLowerCase() : ""
  const rawNoteHeader =
    typeof env?.NAIA_NOTE_USER_HEADER === "string" ? env.NAIA_NOTE_USER_HEADER.trim().toLowerCase() : ""

  const scheduleHeader =
    rawScheduleHeader && rawScheduleHeader !== GATE_SECRET_HEADER && rawScheduleHeader !== GATE_VERIFIED_HEADER
      ? rawScheduleHeader
      : ""
  const noteHeader =
    rawNoteHeader && rawNoteHeader !== GATE_SECRET_HEADER && rawNoteHeader !== GATE_VERIFIED_HEADER
      ? rawNoteHeader
      : ""

  const userHeaders = new Set([scheduleHeader, noteHeader].filter(Boolean))
  const allUserHeaders = userHeaders

  const remoteAddress = req.socket?.remoteAddress ?? req.connection?.remoteAddress ?? ""
  const trustedPeer = isTrustedIdentityPeer(remoteAddress, env)
  const gateSecret = readGateSecret(env)

  if (gateSecret !== null) {
    const secretMatched =
      trustedPeer &&
      secretInfo.present &&
      secretInfo.valid &&
      secretInfo.value !== null &&
      verifyGateSecretValue(secretInfo.value, gateSecret)

    let userHeadersSingle = true
    for (const h of userHeaders) {
      if (!inspectSingleHeaderOnReq(req, h).valid) {
        userHeadersSingle = false
        break
      }
    }

    if (secretMatched && userHeadersSingle) {
      setHeaderOnReq(req, GATE_VERIFIED_HEADER, computeGateVerifiedToken(gateSecret))
      return req
    }

    removeHeadersFromReq(req, allUserHeaders)
    return req
  }

  // 비밀이 설정되어 있지 않은 상태
  if (allUserHeaders.size === 0) return req

  if (!trustedPeer) {
    removeHeadersFromReq(req, allUserHeaders)
    return req
  }

  if (scheduleHeader && scheduleHeader !== noteHeader) {
    removeHeadersFromReq(req, new Set([scheduleHeader]))
  }
  if (noteHeader && !inspectSingleHeaderOnReq(req, noteHeader).valid) {
    removeHeadersFromReq(req, new Set([noteHeader]))
  }

  return req
}

export default stripUntrustedIdentityHeaders
