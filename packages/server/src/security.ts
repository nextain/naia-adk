import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"

export interface TrustDecision {
  secretValid: boolean
  trusted: boolean
  peerHeader: string | undefined
  peer: string | null
  isLoopback: boolean
  isTailnet: boolean
  localMatchesTailnet: boolean
  originOk: boolean
}

/**
 * Host 검사
 * - Host가 127.0.0.1, localhost, [::1]과 expectedPort가 아니면 false
 * - 포트 없는 Host, :80 등 불일치 포트는 허용하지 않음
 */
export function validateHost(hostHeader: string | undefined, expectedPort: number): boolean {
  if (!hostHeader || typeof hostHeader !== "string") {
    return false
  }
  const trimmed = hostHeader.trim().toLowerCase()
  const match = trimmed.match(/^(?:(\[::1\])|(127\.0\.0\.1)|(localhost)):(\d+)$/)
  if (!match) {
    return false
  }
  const portStr = match[4]
  return portStr === String(expectedPort)
}

/**
 * 경로 탈출 검사
 * - request.raw.url의 경로 부분에 '.', '..' 조각, %2e, %2f, %5c (대소문자 무관), 역슬래시가 있으면 false
 */
export function validatePath(rawUrl: string | undefined): boolean {
  if (!rawUrl || typeof rawUrl !== "string") {
    return false
  }
  const qIndex = rawUrl.indexOf("?")
  const pathname = qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl

  // 1. 역슬래시 검사
  if (pathname.includes("\\")) {
    return false
  }

  // 2. %2e, %2f, %5c (대소문자 무관) 퍼센트 인코딩 검사
  if (/%2e|%2f|%5c/i.test(pathname)) {
    return false
  }

  // 3. '.' 또는 '..' 경로 조각 검사
  const segments = pathname.split("/")
  for (const seg of segments) {
    if (seg === "." || seg === "..") {
      return false
    }
  }

  return true
}

/**
 * 프록시 비밀 값 디렉토리 경로 (FE 8장 126행)
 * - $XDG_RUNTIME_DIR/naia-adk/
 * - 없으면 Windows: %LOCALAPPDATA%\naia-adk\run\
 * - 없으면 Unix: os.tmpdir()/naia-adk-<사용자 id>/
 */
export function getProxySecretDir(): string {
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

export function getProxySecretPath(port: number): string {
  return path.join(getProxySecretDir(), `portal-proxy-secret-${port}`)
}

/**
 * listen 성공 후 32바이트 무작위 비밀 값을 파일(권한 600, 폴더 700)에 기록
 */
export function writeProxySecret(port: number, secret?: string): { secret: string; filePath: string } {
  if (port <= 0) {
    throw new Error(`Cannot write proxy secret for non-positive port: ${port}`)
  }
  const dir = getProxySecretDir()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(dir, 0o700)
  } catch {
    // ignore
  }

  const filePath = getProxySecretPath(port)
  const secretValue = secret ?? crypto.randomBytes(32).toString("hex")
  fs.writeFileSync(filePath, secretValue, { mode: 0o600, encoding: "utf-8" })
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    // ignore
  }

  return { secret: secretValue, filePath }
}

/**
 * 시간 일정한 문자열 비교 (SHA-256 해시를 통한 고정 길이 타이밍 공격 방지)
 */
export function constantTimeCompare(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") {
    return false
  }
  const hashA = crypto.createHash("sha256").update(a, "utf-8").digest()
  const hashB = crypto.createHash("sha256").update(b, "utf-8").digest()
  return crypto.timingSafeEqual(hashA, hashB)
}

/**
 * IP 주소 정규화 (IPv4가 IPv6로 싸인 형태 ::ffff:a.b.c.d를 IPv4로 변환)
 */
export function normalizeIp(ip: string): string {
  const trimmed = ip.trim().toLowerCase()
  if (trimmed.startsWith("::ffff:")) {
    return trimmed.slice(7)
  }
  return trimmed
}

/**
 * Loopback 주소 판정 (127.0.0.0/8, ::1)
 */
export function isLoopbackIp(ip: string): boolean {
  const norm = normalizeIp(ip)
  if (norm === "::1") {
    return true
  }
  const match = norm.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!match) {
    return false
  }
  const [, a, b, c] = match.map(Number)
  return a >= 0 && a <= 255 && b >= 0 && b <= 255 && c >= 0 && c <= 255
}

/**
 * 테일넷 대역 판정 (100.64.0.0/10, fd7a:115c:a1e0::/48)
 */
export function isTailnetIp(ip: string): boolean {
  const norm = normalizeIp(ip)
  // IPv4 100.64.0.0/10: 100.64.0.0 ~ 100.127.255.255
  const v4Match = norm.match(/^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4Match) {
    const second = Number(v4Match[1])
    const third = Number(v4Match[2])
    const fourth = Number(v4Match[3])
    if (second >= 64 && second <= 127 && third >= 0 && third <= 255 && fourth >= 0 && fourth <= 255) {
      return true
    }
  }

  // IPv6 fd7a:115c:a1e0::/48
  if (norm.startsWith("fd7a:115c:a1e0:")) {
    return true
  }

  return false
}

/**
 * 로컬 시스템의 Tailscale 인터페이스 IP 목록 조회
 */
export function getTailscaleInterfaceIps(): string[] {
  const ifaces = os.networkInterfaces()
  const ips: string[] = []
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue
    const lowerName = name.toLowerCase()
    if (lowerName.startsWith("tailscale") || lowerName.includes("tailscale")) {
      for (const addr of addrs) {
        if (addr.address) {
          ips.push(normalizeIp(addr.address))
        }
      }
    }
  }
  return ips
}

function getHeaderValue(val: string | string[] | undefined): string | undefined {
  if (Array.isArray(val)) {
    return val[0]
  }
  return val
}

/**
 * 믿음 판정 (FE 8장 4~5번)
 * - proxy-secret이 일치할 때만 x-naia-peer, x-naia-local, x-naia-origin-ok를 신뢰
 * - peer가 loopback이거나, (peer가 테일넷 대역이고 local 주소가 실제 테일넷 인터페이스 주소와 일치)할 때 신뢰
 */
export function evaluateTrust(
  headers: Record<string, string | string[] | undefined>,
  expectedSecret: string | null,
  getTailscaleIps: () => string[] = getTailscaleInterfaceIps,
): TrustDecision {
  const rawSecret = getHeaderValue(headers["x-naia-proxy-secret"])
  const rawPeer = getHeaderValue(headers["x-naia-peer"])
  const rawLocal = getHeaderValue(headers["x-naia-local"])
  const rawOriginOk = getHeaderValue(headers["x-naia-origin-ok"])

  const secretValid = Boolean(
    expectedSecret &&
    rawSecret &&
    constantTimeCompare(rawSecret, expectedSecret)
  )

  if (!secretValid) {
    return {
      secretValid: false,
      trusted: false,
      peerHeader: rawPeer,
      peer: null,
      isLoopback: false,
      isTailnet: false,
      localMatchesTailnet: false,
      originOk: false,
    }
  }

  if (!rawPeer) {
    return {
      secretValid: true,
      trusted: false,
      peerHeader: undefined,
      peer: null,
      isLoopback: false,
      isTailnet: false,
      localMatchesTailnet: false,
      originOk: rawOriginOk === "1",
    }
  }

  const normPeer = normalizeIp(rawPeer)
  const isLoopback = isLoopbackIp(normPeer)
  const isTailnet = isTailnetIp(normPeer)

  let localMatchesTailnet = false
  if (isTailnet && rawLocal) {
    const normLocal = normalizeIp(rawLocal)
    const tailscaleIps = getTailscaleIps()
    localMatchesTailnet = tailscaleIps.includes(normLocal)
  }

  const trusted = isLoopback || (isTailnet && localMatchesTailnet)

  return {
    secretValid: true,
    trusted,
    peerHeader: rawPeer,
    peer: normPeer,
    isLoopback,
    isTailnet,
    localMatchesTailnet,
    originOk: rawOriginOk === "1",
  }
}

/**
 * 판정 로그 문자열 생성
 * 예: peer 100.64.0.1·비밀 일치 거짓·믿지 않음
 */
export function formatTrustLog(decision: TrustDecision): string {
  const peerStr = decision.peerHeader ?? "none"
  const secretStr = decision.secretValid ? "참" : "거짓"
  const trustStr = decision.trusted ? "믿음" : "믿지 않음"
  return `peer ${peerStr}·비밀 일치 ${secretStr}·${trustStr}`
}
