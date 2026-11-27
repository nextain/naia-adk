import http from "node:http"
import { randomUUID } from "node:crypto"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"
import process from "node:process"
import { fileURLToPath } from "node:url"
import next from "next"
import { hostGuard } from "./host-guard.mjs"
import { readGateSecret } from "./gate-secret.mjs"
import { applyMessengerIdentity, isAllowedMessengerOrigin, isMessengerGateVerified, verifyMessengerGate, verifiedMessengerAccount } from "./messenger-gate.mjs"
import { authorizeMessenger, createAxMessengerHandler, readMessengerConfig } from "./ax-messenger-gateway.mjs"
import {
  GATE_ACCOUNT_HEADER,
  getVerifiedPublishActor,
  inspectSingleHeaderOnReq,
  stripUntrustedIdentityHeaders,
} from "./identity-header-guard.mjs"
import {
  createTableReader,
  defaultTableFile,
  isRegistrableDocPath,
  isValidSource,
  registerShortLink,
  resolveShortPath,
} from "./short-links.mjs"
import { classifyPublicPath, createAccessVerifier, isBlockedDecisionsPath, publicConfigFromEnv } from "./public-access.mjs"

const __filename = fileURLToPath(import.meta.url)
const MAX_SHORT_LINK_BODY_BYTES = 4096
const __dirname = path.dirname(__filename)

/**
 * 인자 및 환경 변수 해석 (FE 8장 128행)
 * - NAIA_DASHBOARD_PORT (기본 3142)
 * - NAIA_DASHBOARD_HOST (기본 0.0.0.0)
 * - -p, -H CLI 인자 지원
 */
export function parseArgs(argv = process.argv.slice(2), env = process.env) {
  let port = Number(env.NAIA_DASHBOARD_PORT) || 3142
  let host = env.NAIA_DASHBOARD_HOST || "0.0.0.0"

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-p" && argv[i + 1]) {
      port = Number(argv[i + 1])
      i++
    } else if (argv[i] === "-H" && argv[i + 1]) {
      host = argv[i + 1]
      i++
    }
  }

  return { port, host }
}

/**
 * IP 주소 정규화 (IPv4-mapped IPv6 ::ffff:a.b.c.d 풀기, FE 8장 129행)
 */
export function normalizeIp(ip) {
  if (!ip || typeof ip !== "string") return ""
  const trimmed = ip.trim().toLowerCase()
  if (trimmed.startsWith("::ffff:")) {
    return trimmed.slice(7)
  }
  return trimmed
}

/**
 * 프록시 비밀 파일 폴더 경로 (FE 8장 126행)
 */
export function getProxySecretDir() {
  if (process.env.XDG_RUNTIME_DIR) {
    return path.join(process.env.XDG_RUNTIME_DIR, "naia-adk")
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
    return path.join(localAppData, "naia-adk", "run")
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : os.userInfo().username
  return path.join(os.tmpdir(), `naia-adk-${uid}`)
}

export function getProxySecretPath(apiPort) {
  return path.join(getProxySecretDir(), `portal-proxy-secret-${apiPort}`)
}

let cachedSecret = null
let lastSecretReadTime = 0
let cachedSecretPort = null

/**
 * 비밀 파일 읽기 (5초 기억, FE 8장 132행)
 */
export function readProxySecret(apiPort, now = Date.now()) {
  if (cachedSecretPort === apiPort && cachedSecret !== null && now - lastSecretReadTime < 5000) {
    return cachedSecret
  }
  cachedSecretPort = apiPort
  lastSecretReadTime = now
  try {
    const filePath = getProxySecretPath(apiPort)
    if (fs.existsSync(filePath)) {
      const val = fs.readFileSync(filePath, "utf-8").trim()
      cachedSecret = val || null
    } else {
      cachedSecret = null
    }
  } catch {
    cachedSecret = null
  }
  return cachedSecret
}

export function clearProxySecretCache() {
  cachedSecret = null
  lastSecretReadTime = 0
  cachedSecretPort = null
}

/**
 * x-naia-* 머리글을 지우고 다시 붙이는 함수 (FE 8장 136~137행)
 * - 받은 x-naia-*, cf-access-*, x-ax-account-key 제거
 * - 소켓 실제 주소를 x-naia-peer로
 * - 소켓 이 PC 쪽 주소를 x-naia-local로
 * - 비밀 값을 x-naia-proxy-secret으로
 * - 같은 요청의 관문 검사를 통과한 계정만 내부 actor와 검증표시로 새로 생성
 * - 쓰기 메서드(PUT·POST·PATCH·DELETE)이고 Origin이 scheme://Host와 같으면 x-naia-origin-ok: 1
 *   (게이트가 확인한 메신저 요청은 X-Forwarded-Proto 나 NAIA_DASHBOARD_PUBLIC_URL 원점도 받는다)
 * - Host를 127.0.0.1:<포트>로 설정
 */
export function buildProxyHeaders(req, socket, proxySecret, apiPort, envOrIdentity = process.env, customEnv = process.env) {
  const publicIdentity = envOrIdentity && typeof envOrIdentity.email === "string" ? envOrIdentity : null
  const env = publicIdentity ? customEnv : (envOrIdentity || customEnv)
  const sock = socket || req.socket || {}
  const remoteAddr = normalizeIp(sock.remoteAddress || "")
  const localAddr = normalizeIp(sock.localAddress || "")

  const outHeaders = {}
  for (const [key, val] of Object.entries(req.headers || {})) {
    const lower = key.toLowerCase()
    // x-naia-* 는 이 대시보드만 붙인다. cf-access-* 는 서명 없는 신원 머리글이라 API 로 넘기지 않는다.
    if (lower.startsWith("x-naia-") || lower.startsWith("cf-access-") || lower === GATE_ACCOUNT_HEADER) {
      continue
    }
    // 공개 모드: 접근 제어 쿠키(CF_Authorization)는 API 에 필요 없다.
    if (publicIdentity && lower === "cookie") {
      continue
    }
    outHeaders[key] = val
  }

  if (!publicIdentity) {
    applyMessengerIdentity(outHeaders, req, env)
  }

  outHeaders["host"] = `127.0.0.1:${apiPort}`
  if (remoteAddr) {
    outHeaders["x-naia-peer"] = remoteAddr
  }
  if (localAddr) {
    outHeaders["x-naia-local"] = localAddr
  }
  if (proxySecret) {
    outHeaders["x-naia-proxy-secret"] = proxySecret
    if (!publicIdentity) {
      const actor = getVerifiedPublishActor(req, env)
      if (actor) {
        outHeaders["x-naia-actor-id"] = actor
        outHeaders["x-naia-actor-verified"] = "1"
      }
    }
  }
  if (publicIdentity?.email) {
    // 공개 모드: 서명 검증을 마친 메일만 비밀 값과 함께 넘긴다(API 는 비밀이 맞을 때만 읽는다).
    outHeaders["x-naia-user-email"] = publicIdentity.email
  }

  const method = (req.method || "GET").toUpperCase()
  if (!publicIdentity && ["PUT", "POST", "PATCH", "DELETE"].includes(method)) {
    if (isAllowedMessengerOrigin(req, env, { socket: sock, allowProxyOrigin: isMessengerGateVerified(req) })) {
      outHeaders["x-naia-origin-ok"] = "1"
    }
  }

  return outHeaders
}

/**
 * /api/portal* 경로 부분 검증 (FE 8장 138행)
 * - 대소문자 가리지 않고 가로채되, 정확히 소문자 /api/portal 접두어가 아니면 400
 * - 경로 부분에 '..', '.' 조각, %2e, %2f, %5c (대소문자 무관), 역슬래시가 있으면 400
 * - WHATWG URL로 푼 경로가 /api/portal 또는 /api/portal/로 시작해야 함
 */
export function validatePortalPathname(rawPathname) {
  // 1. 소문자 /api/portal 시작 확인
  if (rawPathname !== "/api/portal" && !rawPathname.startsWith("/api/portal/")) {
    return { valid: false }
  }

  // 2. 역슬래시 검사
  if (rawPathname.includes("\\")) {
    return { valid: false }
  }

  // 3. %2e, %2f, %5c 퍼센트 인코딩 검사
  if (/%2e|%2f|%5c/i.test(rawPathname)) {
    return { valid: false }
  }

  // 4. '.' 또는 '..' 경로 조각 검사
  const segments = rawPathname.split("/")
  for (const seg of segments) {
    if (seg === "." || seg === "..") {
      return { valid: false }
    }
  }

  // 5. WHATWG URL 해석 후 재검증
  try {
    const dummy = new URL(rawPathname, "http://127.0.0.1")
    const resolved = dummy.pathname
    if (resolved !== "/api/portal" && !resolved.startsWith("/api/portal/")) {
      return { valid: false }
    }
    return { valid: true, resolvedPathname: resolved }
  } catch {
    return { valid: false }
  }
}

function isPublishPathname(pathname) {
  try {
    // 차단 판정에만 별칭을 푼다. 실제 전달 경로와 경로 탈출 검사는 바꾸지 않는다.
    const decoded = decodeURIComponent(pathname).replace(/\/+/g, "/").replace(/\/$/, "")
    return /^\/api\/portal\/publish(?:\/|$)/.test(decoded)
  } catch {
    return false
  }
}

/**
 * API 프록시 전송 함수 (FE 8장 127행, 140행)
 * - 런타임 NAIA_API_PORT의 127.0.0.1로 직접 전달
 * - 영상 스트림 끊김 방지를 위해 timeout 0
 * - API가 준 머리글은 지우거나 덮지 않음
 * - frame-ancestors 'self'는 두 번째 Content-Security-Policy 머리글로 더함
 * - X-Frame-Options는 없을 때만 SAMEORIGIN 추가
 */
export function proxyToApi(req, res, forwardPath, apiPort, proxySecret, socket = null, envOrIdentity = process.env, customEnv = process.env) {
  const sock = socket || req.socket
  const publicIdentity = envOrIdentity && typeof envOrIdentity.email === "string" ? envOrIdentity : null
  const headers = buildProxyHeaders(req, sock, proxySecret, apiPort, envOrIdentity, customEnv)

  const reqOptions = {
    hostname: "127.0.0.1",
    port: apiPort,
    path: forwardPath,
    method: req.method,
    headers,
    timeout: 0,
  }

  const proxyReq = http.request(reqOptions, (apiRes) => {
    res.statusCode = apiRes.statusCode || 200

    let apiCsp = null
    let apiXfo = null

    for (const [key, val] of Object.entries(apiRes.headers)) {
      const lower = key.toLowerCase()
      if (lower === "content-security-policy") {
        apiCsp = val
      } else if (lower === "x-frame-options") {
        apiXfo = val
        res.setHeader(key, val)
      } else {
        res.setHeader(key, val)
      }
    }

    if (apiCsp) {
      const list = Array.isArray(apiCsp) ? [...apiCsp] : [apiCsp]
      list.push("frame-ancestors 'self'")
      res.setHeader("content-security-policy", list)
    } else {
      res.setHeader("content-security-policy", "frame-ancestors 'self'")
    }

    if (!apiXfo) {
      res.setHeader("x-frame-options", "SAMEORIGIN")
    }

    if (publicIdentity) {
      // 공개 주소 앞단(클라우드플레어)이 사람별 문서를 저장해 두지 않게 한다.
      res.setHeader("cache-control", "private, no-store")
    }

    // If the API side drops mid-response (restart etc.), drop the browser side too so messenger SSE notices and reconnects.
    apiRes.on("aborted", () => res.destroy())
    apiRes.on("error", () => res.destroy())
    apiRes.pipe(res)
  })

  proxyReq.on("error", (err) => {
    if (!res.headersSent) {
      res.statusCode = 502
      res.setHeader("content-type", "application/json; charset=utf-8")
      res.end(JSON.stringify({ error: "Bad Gateway", message: err.message }))
    }
  })

  req.pipe(proxyReq)
  return proxyReq
}

/**
 * 문서 짧은 주소 처리 (/d/<키>, /d/<출처>/<경로>, POST /d 등록)
 * - Host 검사를 통과한 요청만 여기에 온다(기존 대시보드와 같은 접근 범위).
 * - POST /d 는 같은 출처(Origin = scheme://Host)에서 온 JSON {source, path} 만 받는다.
 */
export function handleShortLink(req, res, rawPathname, opts = {}) {
  const tableFile = opts.tableFile || defaultTableFile()
  const readTable = opts.readTable || createTableReader(tableFile)
  const method = (req.method || "GET").toUpperCase()
  const sendJson = (status, body) => {
    res.statusCode = status
    res.setHeader("content-type", "application/json; charset=utf-8")
    res.setHeader("cache-control", "no-store")
    res.end(JSON.stringify(body))
  }

  if (rawPathname === "/d" || rawPathname === "/d/") {
    if (method !== "POST") {
      res.setHeader("allow", "POST")
      return sendJson(405, { error: "Method Not Allowed" })
    }
    const scheme = req.socket?.encrypted ? "https" : "http"
    const host = req.headers?.host
    if (!host || req.headers?.origin !== `${scheme}://${host}`) {
      return sendJson(403, { error: "Cross-origin request" })
    }
    if (!String(req.headers?.["content-type"] || "").toLowerCase().startsWith("application/json")) {
      return sendJson(415, { error: "JSON body required" })
    }
    // 본문 한도는 바이트로 센다(한글은 한 자가 3바이트).
    const chunks = []
    let bytes = 0
    let tooBig = false
    req.on("data", (chunk) => {
      if (tooBig) return
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8")
      bytes += buf.length
      if (bytes > MAX_SHORT_LINK_BODY_BYTES) {
        tooBig = true
        chunks.length = 0
        return
      }
      chunks.push(buf)
    })
    req.on("end", () => {
      if (tooBig) return sendJson(413, { error: "Body too large" })
      let parsed
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      } catch {
        return sendJson(400, { error: "Invalid JSON" })
      }
      const source = parsed?.source
      const docPath = parsed?.path
      // 명령과 같은 규칙: 점 폴더·node_modules·data-private·.md 아닌 경로는 대시보드가 열지 못하므로 받지 않는다.
      if (!isValidSource(source) || !isRegistrableDocPath(docPath)) {
        return sendJson(400, { error: "Invalid source or path" })
      }
      try {
        const key = registerShortLink(source, docPath, tableFile, new Date(), { maxLinks: opts.maxLinks, maxBytes: opts.maxBytes })
        return sendJson(200, { key, path: `/d/${key}` })
      } catch (err) {
        if (err.code === "SHORT_LINK_TABLE_FULL") return sendJson(507, { error: "Short link table is full" })
        // 응답에는 서버 경로·시스템 오류를 싣지 않는다. 자세한 것은 서버 기록에만.
        console.error(`[dashboard] short link not saved: ${err.message}`)
        return sendJson(500, { error: "Could not save short link" })
      }
    })
    return
  }

  if (method !== "GET" && method !== "HEAD") {
    res.setHeader("allow", "GET, HEAD")
    res.statusCode = 405
    res.setHeader("content-type", "text/plain; charset=utf-8")
    res.end("Method Not Allowed")
    return
  }

  const result = resolveShortPath(rawPathname, { table: readTable(), tabFor: opts.tabFor })
  res.setHeader("cache-control", "no-store")
  if (result.status === 302) {
    res.statusCode = 302
    res.setHeader("location", result.location)
    res.end()
    return
  }
  res.statusCode = result.status
  res.setHeader("content-type", "text/plain; charset=utf-8")
  res.end(result.status === 400 ? "Bad short link" : "Short link not found")
}

/**
 * 대시보드 HTTP 요청 처리기 생성
 * - shortLinkOpts: { tableFile, readTable, tabFor, maxLinks, maxBytes } (시험에서 바꿔 끼운다)
 * - envOrPublicOpts / explicitPublicOpts: 기존 3인자 호출(env 또는 publicOpts)과
 *   4인자 호출(customEnv, publicOpts) 모두 지원한다.
 */
export function createRequestHandler(nextHandler, shortLinkOpts = {}, envOrPublicOpts = process.env, explicitPublicOpts = null) {
  const thirdIsPublic = Boolean(
    envOrPublicOpts &&
    typeof envOrPublicOpts === "object" &&
    typeof envOrPublicOpts.verifier?.verify === "function",
  )
  if (
    explicitPublicOpts !== null &&
    explicitPublicOpts !== undefined &&
    typeof explicitPublicOpts?.verifier?.verify !== "function"
  ) {
    throw new Error("public mode: publicOpts.verifier.verify is required")
  }
  const env = thirdIsPublic ? process.env : (envOrPublicOpts || process.env)
  const publicOpts = explicitPublicOpts || (thirdIsPublic ? envOrPublicOpts : null)
  if (env?.NAIA_DASHBOARD_PUBLIC === "1" && !publicOpts) {
    throw new Error("public mode: publicOpts is required when NAIA_DASHBOARD_PUBLIC=1")
  }
  const shortOpts = {
    ...shortLinkOpts,
    tableFile: shortLinkOpts.tableFile || defaultTableFile(env?.NAIA_SHORT_LINKS_FILE ? env : process.env),
  }
  if (!shortOpts.readTable) shortOpts.readTable = createTableReader(shortOpts.tableFile)
  const axMessengerHandler = createAxMessengerHandler({
    readConfig: () => readMessengerConfig(env),
    env,
    trustProxyOrigin: isMessengerGateVerified,
  })
  const handleRequest = function handleRequest(req, res) {
    // Check the login gate before anything else reads or strips its headers (messenger paths only).
    if (!publicOpts) verifyMessengerGate(req, env)
    stripUntrustedIdentityHeaders(req, env)
    // 0. 프록시 경고 머리글 감지 (FE 8장 145행)
    // 공개 모드는 터널(cloudflared)이 앞에 서는 구성이라 x-forwarded-for 가 늘 붙는다. 경고는 내부 모드에서만.
    if (!publicOpts && (req.headers["x-forwarded-for"] || req.headers["tailscale-user-login"])) {
      console.warn("[WARN] Proxy header detected (x-forwarded-for or tailscale-user-login). Reverse proxy / tailscale serve should not be used in front of dashboard.")
    }

    // 1. Host 검사는 맨 처음 호출 (FE 8장 135행)
    if (!hostGuard(req.headers.host)) {
      res.statusCode = 421
      res.setHeader("content-type", "text/plain; charset=utf-8")
      res.end("Misdirected Request")
      return
    }

    // 2. /api/portal* 가로채기 (대소문자 무관하게 감지)
    const url = req.url || "/"
    const qIdx = url.indexOf("?")
    const rawPathname = qIdx >= 0 ? url.slice(0, qIdx) : url
    const rawQuery = qIdx >= 0 ? url.slice(qIdx) : ""

    if (publicOpts) {
      handlePublicRequest(req, res, rawPathname, rawQuery, nextHandler, shortOpts, publicOpts, env)
      return
    }

    if (rawPathname === "/api/ax-messenger" || rawPathname.startsWith("/api/ax-messenger/")) {
      return axMessengerHandler(req, res, verifiedMessengerAccount(req))
    }
    if (rawPathname === "/ax/messenger" || rawPathname.startsWith("/ax/messenger/")) {
      let config
      try { config = readMessengerConfig(env) } catch { return sendPlain(res, 503, "메신저 설정을 읽지 못했습니다.") }
      if (config?.features?.messenger?.enabled !== true || config?.features?.messenger?.backend !== "matrix") return sendPlain(res, 404, "메신저가 꺼져 있습니다.")
      const account = verifiedMessengerAccount(req)
      if (!account) return sendPlain(res, 401, "로그인이 필요합니다.")
      if (!authorizeMessenger(config, account, "read")) return sendPlain(res, 403, "메신저 접근 권한이 없습니다.")
      res.setHeader("cache-control", "no-store")
    }

    if (rawPathname.toLowerCase().startsWith("/api/portal")) {
      const valResult = validatePortalPathname(rawPathname)
      if (!valResult.valid) {
        res.statusCode = 400
        res.setHeader("content-type", "application/json; charset=utf-8")
        res.end(JSON.stringify({ error: "Invalid path" }))
        return
      }

      const forwardPath = valResult.resolvedPathname + rawQuery
      if (isPublishPathname(valResult.resolvedPathname) && env.PUBLISH_GATEWAY_OVERWRITE_CONFIRMED !== "1") {
        res.statusCode = 403
        res.setHeader("content-type", "application/json; charset=utf-8")
        res.setHeader("cache-control", "no-store")
        res.end(JSON.stringify({
          ok: false,
          code: "publish_gateway_unconfirmed",
          message: "관문의 계정 덮어쓰기 확인이 필요합니다.",
          retryable: false,
          request_id: randomUUID(),
          operation_id: null,
          issues: [],
        }))
        return
      }
      const apiPort = Number(env.NAIA_API_PORT) || 3141
      const secret = readProxySecret(apiPort)
      proxyToApi(req, res, forwardPath, apiPort, secret, null, env)
      return
    }

    // 3. 문서 짧은 주소 (/d, /d/…)
    if (rawPathname === "/d" || rawPathname.startsWith("/d/")) {
      res.setHeader("Content-Security-Policy", "frame-ancestors 'self'")
      res.setHeader("X-Frame-Options", "SAMEORIGIN")
      handleShortLink(req, res, rawPathname, shortOpts)
      return
    }

    // 4. 일반 대시보드 화면 응답 헤더 추가
    res.setHeader("Content-Security-Policy", "frame-ancestors 'self'")
    res.setHeader("X-Frame-Options", "SAMEORIGIN")

    return nextHandler(req, res)
  }
  handleRequest.close = () => axMessengerHandler.close()
  return handleRequest
}

function sendPlain(res, status, text) {
  res.statusCode = status
  res.setHeader("content-type", "text/plain; charset=utf-8")
  res.setHeader("cache-control", "no-store")
  res.end(text)
}

/**
 * 공개 모드 요청 처리 (읽기 전용 공개 문서 화면)
 * - GET·HEAD 말고는 405
 * - 문서 화면에 필요한 경로(/docs, /_next/static, /api/portal, /d/키, /favicon.ico)만, 나머지 404(/board·메신저 포함)
 * - 서명된 신원 토큰(Cf-Access-Jwt-Assertion)이 맞아야 하고, 아니면 403
 * - API 에는 검증한 메일만 넘기고, 그룹·폴더 권한은 API 가 권한표로 거른다
 */
export function handlePublicRequest(req, res, rawPathname, rawQuery, nextHandler, shortOpts, publicOpts, env = process.env) {
  // 결재/확인 보관함은 읽기·쓰기 가리지 않고 403. 백엔드로 넘기지 않는다.
  if (isBlockedDecisionsPath(rawPathname)) {
    return sendPlain(res, 403, "Forbidden")
  }
  const method = (req.method || "GET").toUpperCase()
  if (method !== "GET" && method !== "HEAD") {
    res.setHeader("allow", "GET, HEAD")
    return sendPlain(res, 405, "Method Not Allowed")
  }

  const kind = classifyPublicPath(rawPathname)
  if (!kind) return sendPlain(res, 404, "Not Found")

  const rawToken = req.headers["cf-access-jwt-assertion"]
  const token = Array.isArray(rawToken) ? rawToken[0] : rawToken
  publicOpts.verifier.verify(token).then(
    (result) => {
      if (!result.ok) {
        console.warn(`[public] 신원 토큰 거부: ${result.reason} ${method} ${rawPathname}`)
        return sendPlain(res, 403, "Forbidden")
      }
      const identity = { email: result.email }
      res.setHeader("Content-Security-Policy", "frame-ancestors 'self'")
      res.setHeader("X-Frame-Options", "SAMEORIGIN")

      if (kind === "redirect-docs") {
        res.statusCode = 302
        res.setHeader("location", "/docs")
        res.setHeader("cache-control", "no-store")
        return res.end()
      }
      if (kind === "api") {
        const valResult = validatePortalPathname(rawPathname)
        if (!valResult.valid) {
          res.statusCode = 400
          res.setHeader("content-type", "application/json; charset=utf-8")
          return res.end(JSON.stringify({ error: "Invalid path" }))
        }
        const apiPort = publicApiPort(publicOpts, env)
        if (!apiPort) return sendPlain(res, 503, "Service Unavailable")
        const secret = readProxySecret(apiPort)
        return proxyToApi(req, res, valResult.resolvedPathname + rawQuery, apiPort, secret, null, identity, env)
      }
      if (kind === "short") {
        return handlePublicShortLink(req, res, rawPathname, shortOpts, publicOpts, identity, env)
      }
      pinCacheControl(res, rawPathname.startsWith("/_next/static/") ? "public, max-age=31536000, immutable" : "private, no-store")
      return nextHandler(req, res)
    },
    (err) => {
      console.warn(`[public] 신원 토큰 검증 오류: ${err?.message}`)
      sendPlain(res, 403, "Forbidden")
    },
  )
}

/**
 * 공개 모드 문서 서버 포트. 기동 때 정한 값(publicOpts.apiPort)을 쓰고, 없으면 환경 변수.
 * 둘 다 없거나 내부 문서 서버(3141)면 null — 권한표 없는 내부 서버로 넘기지 않는다.
 */
export function publicApiPort(publicOpts, env = process.env) {
  const p = Number(publicOpts?.apiPort ?? env?.NAIA_API_PORT)
  if (!Number.isInteger(p) || p < 1 || p > 65535 || p === 3141) return null
  return p
}

/**
 * 응답의 cache-control 을 이 값으로 고정한다(뒤에서 Next 가 다른 값을 붙여도 덮이지 않게).
 */
export function pinCacheControl(res, value) {
  const origSet = res.setHeader.bind(res)
  origSet("cache-control", value)
  res.setHeader = (name, v) => (String(name).toLowerCase() === "cache-control" ? res : origSet(name, v))
  if (typeof res.appendHeader === "function") {
    const origAppend = res.appendHeader.bind(res)
    res.appendHeader = (name, v) => (String(name).toLowerCase() === "cache-control" ? res : origAppend(name, v))
  }
  const origWriteHead = res.writeHead.bind(res)
  res.writeHead = (status, ...rest) => {
    const args = rest.map((a) => {
      if (Array.isArray(a)) {
        // [이름, 값, 이름, 값 …] 꼴
        const out = []
        for (let i = 0; i + 1 < a.length; i += 2) {
          if (String(a[i]).toLowerCase() !== "cache-control") out.push(a[i], a[i + 1])
        }
        return out
      }
      if (a && typeof a === "object") {
        const out = {}
        for (const [k, v] of Object.entries(a)) {
          if (k.toLowerCase() !== "cache-control") out[k] = v
        }
        return out
      }
      return a
    })
    return origWriteHead(status, ...args)
  }
}

/** 문서 서버에 이 사람이 그 문서를 읽을 수 있는지 묻는다(204 면 참). 오류·시간 초과는 거짓. */
export function checkPublicDocAccess(req, source, docPath, identity, apiPort, secret, env = process.env) {
  return new Promise((resolve) => {
    const headers = buildProxyHeaders({ headers: req.headers, method: "GET" }, req.socket, secret, apiPort, identity, env)
    delete headers["content-length"]
    delete headers["transfer-encoding"]
    const qs = `source=${encodeURIComponent(source)}&path=${encodeURIComponent(docPath)}`
    const r = http.request(
      { hostname: "127.0.0.1", port: apiPort, path: `/api/portal/access-check?${qs}`, method: "GET", headers, timeout: 5000 },
      (apiRes) => {
        apiRes.resume()
        resolve(apiRes.statusCode === 204)
      },
    )
    r.on("timeout", () => {
      r.destroy()
      resolve(false)
    })
    r.on("error", () => resolve(false))
    r.end()
  })
}

/**
 * 공개 모드 짧은 주소: 가리키는 문서를 이 사람이 읽을 수 있을 때만 긴 주소로 넘긴다.
 * 없는 키·잘못된 주소·권한 밖은 모두 같은 404(넘길 주소 없음)라 닫힌 문서가 있는지도 드러나지 않는다.
 */
export function handlePublicShortLink(req, res, rawPathname, shortOpts, publicOpts, identity, env = process.env) {
  const notFound = () => sendPlain(res, 404, "Short link not found")
  if (rawPathname === "/d/") return notFound()
  const result = resolveShortPath(rawPathname, { table: shortOpts.readTable(), tabFor: shortOpts.tabFor })
  if (result.status !== 302 || !result.source || !result.path) return notFound()
  const check = publicOpts.accessCheck ||
    ((r, source, docPath, ident) => {
      const apiPort = publicApiPort(publicOpts, env)
      if (!apiPort) return false
      return checkPublicDocAccess(r, source, docPath, ident, apiPort, readProxySecret(apiPort), env)
    })
  Promise.resolve(check(req, result.source, result.path, identity)).then(
    (ok) => {
      if (!ok) return notFound()
      res.statusCode = 302
      res.setHeader("location", result.location)
      res.setHeader("cache-control", "no-store")
      res.end()
    },
    () => notFound(),
  )
}

/**
 * fd of a port inherited through systemd socket activation, or null to listen with -p/-H.
 * sd_listen_fds rules: trust it only when LISTEN_PID is this process; fds start at 3; accept exactly one.
 */
export function inheritedSocketFd(env = process.env, pid = process.pid) {
  if (env.LISTEN_FDS === undefined || env.LISTEN_PID !== String(pid)) return null
  if (env.LISTEN_FDS !== "1") throw new Error(`Expected one inherited socket, got LISTEN_FDS=${env.LISTEN_FDS}`)
  return 3
}

/**
 * 대시보드 서버 기동
 */
export async function startServer(customArgv = process.argv.slice(2), customEnv = process.env, deps = {}) {
  if (!process.env.NAIA_PERSONAL_SCHEDULE_DIR) {
    process.env.NAIA_PERSONAL_SCHEDULE_DIR = path.join(__dirname, "data", "schedule", "personal")
  }
  const { port, host } = parseArgs(customArgv, customEnv)
  // 공개 모드는 값이 모자라면 기동하지 않는다(열린 채로 뜨지 않게).
  const publicConfig = publicConfigFromEnv(customEnv, host)
  const publicOpts = publicConfig ? { verifier: createAccessVerifier(publicConfig), apiPort: publicConfig.apiPort } : null
  if (publicOpts) console.log(`> Public read-only mode: Access team ${publicConfig.teamDomain}, ${publicConfig.audiences.length} audience(s)`)
  const dev = customEnv.NODE_ENV === "development" || (
    customEnv.NODE_ENV !== "production" && !fs.existsSync(path.join(__dirname, ".next", "BUILD_ID"))
  )

  const createNextApp = deps.createNextApp || next
  const nextApp = createNextApp({ dev, hostname: host, port, dir: __dirname })
  await nextApp.prepare()
  const nextHandler = nextApp.getRequestHandler()

  if (!publicOpts && !readGateSecret(customEnv)) {
    console.warn("[WARN] Login gate secret unavailable (NAIA_GATE_SECRET_FILE): people get 401 on the messenger")
  }

  // 짧은 주소가 넘겨 줄 때 문서 탭을 붙이려고 대시보드 탭 규칙을 읽는다. 못 읽으면 탭 없이 넘긴다(화면이 탭을 고른다).
  let tabFor
  try {
    const tabs = await import("./app/docs/tabs.ts")
    tabFor = (source, docPath) => (source.startsWith("data:") ? undefined : tabs.tabOfDoc(source, docPath).tab)
  } catch (err) {
    console.warn("[WARN] short links: tab rules unavailable, redirecting without tab:", err?.message)
  }

  const requestHandler = createRequestHandler(nextHandler, { tabFor }, customEnv, publicOpts)
  const server = http.createServer(requestHandler)
  server.on("close", requestHandler.close)
  const fd = inheritedSocketFd(customEnv)

  return new Promise((resolve, reject) => {
    server.on("error", reject)
    server.listen(fd === null ? { port, host } : { fd }, () => {
      if (deps.handleSignals && !customEnv.NEXT_MANUAL_SIG_HANDLE) {
        let stopping = false
        const shutdown = () => {
          if (stopping) return
          stopping = true
          server.close(async error => {
            if (error) console.error(error)
            try { await nextApp.close() } catch (error) { console.error(error) }
            process.exit(0)
          })
        }
        process.on("SIGTERM", shutdown)
        process.on("SIGINT", shutdown)
      }
      console.log(fd === null ? `> Dashboard ready on http://${host}:${port}` : `> Dashboard ready on inherited socket fd ${fd}`)
      resolve(server)
    })
  })
}

// 프로세스 진입점일 때만 listen 실행
const isMain = process.argv[1] && (
  path.resolve(process.argv[1]) === __filename ||
  (fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename))
)

if (isMain) {
  startServer().catch((err) => {
    console.error("Failed to start dashboard server:", err)
    process.exit(1)
  })
}
