import crypto from "node:crypto"

/**
 * 공개 문서 화면(공개 모드) 앞문.
 *
 * - 클라우드플레어 접근 제어(Cloudflare Access)가 붙여 주는 서명된 신원 토큰
 *   `Cf-Access-Jwt-Assertion` 만 믿는다. 서명 없는 `Cf-Access-Authenticated-User-Email` 은 보지 않는다.
 * - 토큰은 팀 공개 키(https://<팀>/cdn-cgi/access/certs)로 RS256 서명을 검증하고,
 *   발급자(iss)·대상 값(aud)·만료(exp)·시작(nbf)과 메일(email)을 확인한다.
 * - 읽기(GET·HEAD)와 문서 화면에 필요한 경로만 연다. 메신저 등 내부 전용 경로와 나머지는 404.
 */

const MAX_TOKEN_BYTES = 8192
const CLOCK_SKEW_SEC = 60
const KEYS_TTL_MS = 60 * 60 * 1000
const KEYS_REFETCH_MIN_MS = 30 * 1000

function b64urlJson(part) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf-8"))
}

export function normalizeTeamDomain(raw) {
  if (typeof raw !== "string") return null
  const d = raw.trim().toLowerCase().replace(/^https:\/\//, "").replace(/\/+$/, "")
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) return null
  return d
}

export function parseAudiences(raw) {
  if (typeof raw !== "string") return []
  return raw.split(",").map((s) => s.trim()).filter((s) => /^[A-Za-z0-9_-]{8,}$/.test(s))
}

/**
 * 신원 토큰 검증기.
 * - fetchKeys(): 팀 공개 키 JSON({keys:[JWK…]})을 돌려주는 함수(시험에서 바꿔 끼움)
 */
export function createAccessVerifier({ teamDomain, audiences, fetchKeys, now = () => Date.now() }) {
  const team = normalizeTeamDomain(teamDomain)
  const auds = Array.isArray(audiences) ? audiences.filter(Boolean) : []
  if (!team) throw new Error("public mode: invalid team domain")
  if (auds.length === 0) throw new Error("public mode: no Access audience (AUD) configured")
  const issuer = `https://${team}`
  const certsUrl = `${issuer}/cdn-cgi/access/certs`
  const doFetch = fetchKeys || (async () => {
    const res = await fetch(certsUrl, { redirect: "error", signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`certs ${res.status}`)
    return res.json()
  })

  let keys = new Map()
  let fetchedAt = -Infinity
  let inflight = null

  async function refreshKeys(force) {
    const t = now()
    if (!force && t - fetchedAt < KEYS_TTL_MS && keys.size > 0) return
    if (force && t - fetchedAt < KEYS_REFETCH_MIN_MS) return
    if (!inflight) {
      inflight = (async () => {
        try {
          const body = await doFetch()
          const next = new Map()
          for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
            if (jwk?.kty !== "RSA" || typeof jwk.kid !== "string") continue
            try {
              next.set(jwk.kid, crypto.createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" }))
            } catch {
              // 못 읽는 키는 건너뛴다
            }
          }
          if (next.size > 0) keys = next
          fetchedAt = now()
        } finally {
          inflight = null
        }
      })()
    }
    await inflight
  }

  async function verify(token) {
    if (typeof token !== "string" || token.length === 0) return { ok: false, reason: "no token" }
    if (token.length > MAX_TOKEN_BYTES) return { ok: false, reason: "token too large" }
    const parts = token.split(".")
    if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return { ok: false, reason: "malformed" }
    let header
    let payload
    try {
      header = b64urlJson(parts[0])
      payload = b64urlJson(parts[1])
    } catch {
      return { ok: false, reason: "malformed" }
    }
    if (header?.alg !== "RS256" || typeof header.kid !== "string") return { ok: false, reason: "bad alg" }

    try {
      await refreshKeys(false)
    } catch {
      // 아래에서 키가 없으면 거부
    }
    let key = keys.get(header.kid)
    if (!key) {
      try {
        await refreshKeys(true)
      } catch {
        // 무시
      }
      key = keys.get(header.kid)
    }
    if (!key) return { ok: false, reason: "unknown key" }

    const sig = Buffer.from(parts[2], "base64url")
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`)
    let valid = false
    try {
      valid = crypto.verify("RSA-SHA256", signed, key, sig)
    } catch {
      valid = false
    }
    if (!valid) return { ok: false, reason: "bad signature" }

    const nowSec = Math.floor(now() / 1000)
    if (payload?.iss !== issuer) return { ok: false, reason: "bad issuer" }
    const tokenAud = Array.isArray(payload?.aud) ? payload.aud : [payload?.aud]
    if (!tokenAud.some((a) => typeof a === "string" && auds.includes(a))) return { ok: false, reason: "bad audience" }
    if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_SEC < nowSec) return { ok: false, reason: "expired" }
    if (typeof payload.nbf === "number" && payload.nbf - CLOCK_SKEW_SEC > nowSec) return { ok: false, reason: "not yet valid" }
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : ""
    if (!/^[^\s@,;<>"]{1,128}@[a-z0-9.-]{1,253}$/.test(email)) return { ok: false, reason: "no email" }
    return { ok: true, email }
  }

  return { verify, issuer, certsUrl }
}

/**
 * 경로가 돌아가는 모양인지: 역슬래시, 빈 조각(//), . 이나 .. 조각이 날 것 그대로나 풀어 읽은 뒤에 있으면 참.
 * 풀어 읽을 수 없는 % 표기도 참. /_next/static/../board 처럼 허용 접두 뒤로 다른 화면에 닿는 것을 막는다.
 */
export function isUnsafePublicPath(rawPathname) {
  if (typeof rawPathname !== "string" || !rawPathname.startsWith("/")) return true
  let decoded
  try {
    decoded = decodeURIComponent(rawPathname)
  } catch {
    return true
  }
  for (const p of [rawPathname, decoded]) {
    if (p.includes("\\") || p.includes("\0")) return true
    const segs = p.slice(1).split("/")
    // 끝의 빈 조각(/docs/) 하나만 허용한다.
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]
      if (seg === "" && i !== segs.length - 1) return true
      if (seg === "." || seg === "..") return true
    }
  }
  return false
}

// 정적 묶음 파일 이름: 영문·숫자·_-.~ 와 / 만. % 표기는 받지 않는다.
const NEXT_STATIC_RE = /^\/_next\/static\/[A-Za-z0-9_.~\-/]+$/

/**
 * 공개 모드에서 열 경로인지.
 * 돌려주는 값: "redirect-docs" | "next" | "api" | "short" | null(404)
 */
export function classifyPublicPath(rawPathname) {
  if (isUnsafePublicPath(rawPathname)) return null
  if (rawPathname === "/") return "redirect-docs"
  if (rawPathname === "/docs" || rawPathname === "/docs/") return "next"
  if (rawPathname.startsWith("/_next/static/")) return NEXT_STATIC_RE.test(rawPathname) ? "next" : null
  if (rawPathname === "/favicon.ico") return "next"
  const lower = rawPathname.toLowerCase()
  if (lower === "/api/portal/messenger" || lower.startsWith("/api/portal/messenger/")) return null
  if (lower === "/api/portal" || lower.startsWith("/api/portal/")) return "api"
  if (rawPathname.startsWith("/d/")) return "short"
  return null
}

/** 공개 모드 설정을 환경 변수에서 읽는다. 켜져 있는데 값이 모자라면 예외(기동 거부). */
export function publicConfigFromEnv(env = process.env, host = "") {
  if (env.NAIA_DASHBOARD_PUBLIC !== "1") return null
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error("public mode: dashboard must listen on loopback only (-H 127.0.0.1)")
  }
  const teamDomain = normalizeTeamDomain(env.NAIA_ACCESS_TEAM_DOMAIN || "")
  const audiences = parseAudiences(env.NAIA_ACCESS_AUD || "")
  if (!teamDomain) throw new Error("public mode: NAIA_ACCESS_TEAM_DOMAIN missing or invalid")
  if (audiences.length === 0) throw new Error("public mode: NAIA_ACCESS_AUD missing or invalid")
  // 문서 서버 포트는 꼭 적는다. 비었을 때 내부 문서 서버(3141, 권한표 없음)로 가지 않게.
  const apiPort = Number(env.NAIA_API_PORT)
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
    throw new Error("public mode: NAIA_API_PORT missing or invalid (public API port, e.g. 3144)")
  }
  if (apiPort === 3141) throw new Error("public mode: NAIA_API_PORT must not be the internal API port 3141")
  return { teamDomain, audiences, apiPort }
}
