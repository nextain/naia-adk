import net from "node:net"
import { execFileSync } from "node:child_process"

let cachedTailscaleDns = null
let lastTailscaleCheck = 0

/**
 * 이 PC의 Tailscale 정규 DNS 이름 조회 (FE 8장 135행)
 * - `tailscale status --json`의 Self.DNSName에서 끝 점을 뗌
 * - 60초간 메모리에 기억
 * - tailscale이 없거나 실패하면 빈 목록(null)
 */
export function getTailscaleDnsName(now = Date.now()) {
  if (cachedTailscaleDns !== null && now - lastTailscaleCheck < 60_000) {
    return cachedTailscaleDns
  }
  lastTailscaleCheck = now
  try {
    const stdout = execFileSync("tailscale", ["status", "--json"], {
      timeout: 1500,
      stdio: ["pipe", "pipe", "ignore"],
      encoding: "utf-8",
    })
    const parsed = JSON.parse(stdout)
    const dnsName = parsed?.Self?.DNSName
    if (typeof dnsName === "string" && dnsName.trim().length > 0) {
      cachedTailscaleDns = dnsName.trim().replace(/\.+$/, "").toLowerCase()
    } else {
      cachedTailscaleDns = ""
    }
  } catch {
    cachedTailscaleDns = ""
  }
  return cachedTailscaleDns
}

export function clearTailscaleDnsCache() {
  cachedTailscaleDns = null
  lastTailscaleCheck = 0
}

/**
 * NAIA_DASHBOARD_HOSTS 환경 변수로 추가된 허용 호스트 이름 목록
 */
export function getCustomDashboardHosts() {
  const envVal = process.env.NAIA_DASHBOARD_HOSTS
  if (!envVal || typeof envVal !== "string") return []
  return envVal
    .split(/[,;\s]+/)
    .map((h) => h.trim().replace(/\.+$/, "").toLowerCase())
    .filter(Boolean)
}

/**
 * Host 검사 (FE 8장 135행)
 * - 통과 조건: Host가 IP 주소 그대로(IPv4, [IPv6], 포트 포함)이거나, 이름이 정확히 허용 목록에 있을 때
 * - 이름 허용 목록: localhost, 이 PC 테일넷 전체 이름(끝 점 뗌), NAIA_DASHBOARD_HOSTS
 * - 와일드카드, 짧은 이름, os.hostname() 제외
 * - 그 밖 421
 */
export function hostGuard(hostHeader) {
  if (!hostHeader || typeof hostHeader !== "string") {
    return false
  }

  const trimmed = hostHeader.trim().toLowerCase()
  if (!trimmed) {
    return false
  }

  // 1. 대괄호로 둘러싸인 IPv6 주소: [::1], [::1]:3142 등
  if (trimmed.startsWith("[")) {
    const closeIdx = trimmed.indexOf("]")
    if (closeIdx === -1) return false
    const ip = trimmed.slice(1, closeIdx)
    const rest = trimmed.slice(closeIdx + 1)
    if (rest) {
      if (!rest.startsWith(":")) return false
      const port = rest.slice(1)
      if (!/^\d+$/.test(port)) return false
    }
    return net.isIP(ip) === 6
  }

  // 2. 비대괄호: IPv4:port, IPv4, hostname:port, hostname
  const colonCount = (trimmed.match(/:/g) || []).length
  let hostPart = trimmed
  if (colonCount === 1) {
    const [h, p] = trimmed.split(":")
    if (!/^\d+$/.test(p)) return false
    hostPart = h
  } else if (colonCount > 1) {
    // 포트 없는 원시 IPv6 주소
    return net.isIP(trimmed) === 6
  }

  // IP 주소 확인 (IPv4 또는 IPv6)
  if (net.isIP(hostPart) !== 0) {
    return true
  }

  // 이름 허용 목록 확인
  // 1. localhost
  if (hostPart === "localhost") {
    return true
  }

  // 2. 이 PC 테일넷 전체 이름
  const tailscaleDns = getTailscaleDnsName()
  if (tailscaleDns && hostPart === tailscaleDns) {
    return true
  }

  // 3. NAIA_DASHBOARD_HOSTS
  const customHosts = getCustomDashboardHosts()
  if (customHosts.includes(hostPart)) {
    return true
  }

  return false
}

export const isHostAllowed = hostGuard
export default hostGuard
