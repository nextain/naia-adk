// Login gate helpers the messenger needs: the shared gate secret, trusted peers and single-header reads.
// A fork that runs a login gate in front of the dashboard sets NAIA_GATE_SECRET_FILE (mode 600, 32+ chars);
// without it people get 401 on the messenger and only agents with tokens can post.
import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"

export const GATE_SECRET_HEADER = "x-naia-gate-secret"
export const GATE_ACCOUNT_HEADER = "x-ax-account-key"


const GATE_SECRET_CACHE_TTL_MS = 5000
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
