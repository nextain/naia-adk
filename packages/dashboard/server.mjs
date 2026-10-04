import http from "node:http"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"
import process from "node:process"
import { fileURLToPath } from "node:url"
import next from "next"
import { hostGuard } from "./host-guard.mjs"
import { FRAME_ANCESTORS_CSP } from "./frame-policy.mjs"

const __filename = fileURLToPath(import.meta.url)
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
 * - 받은 x-naia-peer, x-naia-local, x-naia-proxy-secret, x-naia-origin-ok 제거
 * - 소켓 실제 주소를 x-naia-peer로
 * - 소켓 이 PC 쪽 주소를 x-naia-local로
 * - 비밀 값을 x-naia-proxy-secret으로
 * - 쓰기 메서드(PUT·POST·PATCH·DELETE)이고 Origin이 scheme://Host와 같으면 x-naia-origin-ok: 1
 * - Host를 127.0.0.1:<포트>로 설정
 */
export function buildProxyHeaders(req, socket, proxySecret, apiPort) {
  const sock = socket || req.socket || {}
  const remoteAddr = normalizeIp(sock.remoteAddress || "")
  const localAddr = normalizeIp(sock.localAddress || "")

  const outHeaders = {}
  for (const [key, val] of Object.entries(req.headers || {})) {
    if (key.toLowerCase().startsWith("x-naia-")) {
      continue
    }
    outHeaders[key] = val
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
  }

  const method = (req.method || "GET").toUpperCase()
  if (["PUT", "POST", "PATCH", "DELETE"].includes(method)) {
    const isEncrypted = Boolean(sock.encrypted)
    const scheme = isEncrypted ? "https" : "http"
    const hostHeader = req.headers?.host
    if (hostHeader) {
      const expectedOrigin = `${scheme}://${hostHeader}`
      const incomingOrigin = req.headers?.origin
      if (incomingOrigin && incomingOrigin === expectedOrigin) {
        outHeaders["x-naia-origin-ok"] = "1"
      }
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

/**
 * API 프록시 전송 함수 (FE 8장 127행, 140행)
 * - 런타임 NAIA_API_PORT의 127.0.0.1로 직접 전달
 * - 영상 스트림 끊김 방지를 위해 timeout 0
 * - API가 준 머리글은 지우거나 덮지 않음
 * - FRAME_ANCESTORS_CSP는 Content-Security-Policy 머리글로 더함(API가 준 값이 있으면 목록 끝에 추가, 없으면 단독)
 * - API가 준 X-Frame-Options는 그대로 전달하고 없어도 새로 추가하지 않음
 */
export function proxyToApi(req, res, forwardPath, apiPort, proxySecret, socket = null) {
  const sock = socket || req.socket
  const headers = buildProxyHeaders(req, sock, proxySecret, apiPort)

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
      list.push(FRAME_ANCESTORS_CSP)
      res.setHeader("content-security-policy", list)
    } else {
      res.setHeader("content-security-policy", FRAME_ANCESTORS_CSP)
    }

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
 * 대시보드 HTTP 요청 처리기 생성
 */
export function createRequestHandler(nextHandler) {
  return function handleRequest(req, res) {
    // 0. 프록시 경고 머리글 감지 (FE 8장 145행)
    if (req.headers["x-forwarded-for"] || req.headers["tailscale-user-login"]) {
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

    if (rawPathname.toLowerCase().startsWith("/api/portal")) {
      const valResult = validatePortalPathname(rawPathname)
      if (!valResult.valid) {
        res.statusCode = 400
        res.setHeader("content-type", "application/json; charset=utf-8")
        res.end(JSON.stringify({ error: "Invalid path" }))
        return
      }

      const forwardPath = valResult.resolvedPathname + rawQuery
      const apiPort = Number(process.env.NAIA_API_PORT) || 3141
      const secret = readProxySecret(apiPort)
      proxyToApi(req, res, forwardPath, apiPort, secret)
      return
    }

    // 3. 일반 대시보드 화면 응답 헤더 추가
    res.setHeader("Content-Security-Policy", FRAME_ANCESTORS_CSP)

    return nextHandler(req, res)
  }
}

/**
 * 대시보드 서버 기동
 */
export async function startServer(customArgv = process.argv.slice(2), customEnv = process.env) {
  const { port, host } = parseArgs(customArgv, customEnv)
  const dev = customEnv.NODE_ENV === "development" || (
    customEnv.NODE_ENV !== "production" && !fs.existsSync(path.join(__dirname, ".next", "BUILD_ID"))
  )

  const nextApp = next({ dev, hostname: host, port, dir: __dirname })
  await nextApp.prepare()
  const nextHandler = nextApp.getRequestHandler()

  const requestHandler = createRequestHandler(nextHandler)
  const server = http.createServer(requestHandler)

  return new Promise((resolve, reject) => {
    server.on("error", reject)
    server.listen(port, host, () => {
      console.log(`> Dashboard ready on http://${host}:${port}`)
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
