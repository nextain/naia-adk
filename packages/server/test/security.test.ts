import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import http from "node:http"
import { createServer } from "../src/server.js"
import {
  validateHost,
  validatePath,
  constantTimeCompare,
  normalizeIp,
  isLoopbackIp,
  isTailnetIp,
  evaluateTrust,
  formatTrustLog,
  getProxySecretDir,
  getProxySecretPath,
  writeProxySecret,
} from "../src/security.js"

describe("보안 가드 단위 테스트 (W1a-2)", () => {
  describe("Host 판정 (validateHost)", () => {
    it("127.0.0.1, localhost, [::1]과 자기 포트가 일치할 때만 true", () => {
      expect(validateHost("localhost:3141", 3141)).toBe(true)
      expect(validateHost("127.0.0.1:3141", 3141)).toBe(true)
      expect(validateHost("[::1]:3141", 3141)).toBe(true)
      expect(validateHost("LOCALHOST:3141", 3141)).toBe(true)
      expect(validateHost("localhost:0", 0)).toBe(true)
    })

    it("포트가 없거나 다른 포트(:80 등)는 false", () => {
      expect(validateHost("localhost", 3141)).toBe(false)
      expect(validateHost("127.0.0.1", 3141)).toBe(false)
      expect(validateHost("[::1]", 3141)).toBe(false)
      expect(validateHost("localhost:80", 3141)).toBe(false)
      expect(validateHost("127.0.0.1:80", 3141)).toBe(false)
      expect(validateHost("localhost:3142", 3141)).toBe(false)
    })

    it("허용되지 않은 이름 호스트 및 IP는 false", () => {
      expect(validateHost("attacker.example:3141", 3141)).toBe(false)
      expect(validateHost("evil.ts.net:3141", 3141)).toBe(false)
      expect(validateHost("192.0.2.10:3141", 3141)).toBe(false)
      expect(validateHost("100.64.0.1:3141", 3141)).toBe(false)
      expect(validateHost(undefined, 3141)).toBe(false)
      expect(validateHost("", 3141)).toBe(false)
    })
  })

  describe("경로 탈출 판정 (validatePath)", () => {
    it("정상 경로는 true", () => {
      expect(validatePath("/api/health")).toBe(true)
      expect(validatePath("/api/portal/doc")).toBe(true)
      expect(validatePath("/api/portal/doc.md")).toBe(true)
      // 쿼리 부분의 특수 문자는 검사하지 않음
      expect(validatePath("/api/portal/doc?source=adk&path=..%2Fescape")).toBe(true)
    })

    it("'.' 또는 '..' 세그먼트가 있으면 false", () => {
      expect(validatePath("/api/portal/../workspace/tree")).toBe(false)
      expect(validatePath("/api/portal/./doc")).toBe(false)
      expect(validatePath("/.")).toBe(false)
      expect(validatePath("/..")).toBe(false)
      expect(validatePath("/api/portal/..")).toBe(false)
    })

    it("%2e, %2f, %5c (대소문자 무관) 퍼센트 인코딩이 있으면 false", () => {
      expect(validatePath("/api/portal/%2e%2e/skills")).toBe(false)
      expect(validatePath("/api/portal/%2E%2E/skills")).toBe(false)
      expect(validatePath("/api/portal/.%2e/skills")).toBe(false)
      expect(validatePath("/api/portal/..%2fworkspace")).toBe(false)
      expect(validatePath("/api/portal/..%2Fworkspace")).toBe(false)
      expect(validatePath("/api/portal%5cworkspace")).toBe(false)
      expect(validatePath("/api/portal%5Cworkspace")).toBe(false)
    })

    it("역슬래시가 있으면 false", () => {
      expect(validatePath("/api/portal\\workspace")).toBe(false)
      expect(validatePath("\\api\\portal")).toBe(false)
    })
  })

  describe("비밀 비교 (constantTimeCompare)", () => {
    it("동일한 문자열은 true", () => {
      const secret = "a".repeat(64)
      expect(constantTimeCompare(secret, secret)).toBe(true)
      expect(constantTimeCompare("secret-123", "secret-123")).toBe(true)
    })

    it("다른 문자열은 false", () => {
      expect(constantTimeCompare("secret-123", "secret-124")).toBe(false)
      expect(constantTimeCompare("secret-123", "secret-1234")).toBe(false)
      expect(constantTimeCompare("", "secret")).toBe(false)
      expect(constantTimeCompare("a".repeat(64), "b".repeat(64))).toBe(false)
    })
  })

  describe("주소 정규화 및 대역 판정", () => {
    it("normalizeIp: ::ffff: 접두사를 제거", () => {
      expect(normalizeIp("::ffff:127.0.0.1")).toBe("127.0.0.1")
      expect(normalizeIp("::FFFF:100.64.0.1")).toBe("100.64.0.1")
      expect(normalizeIp("127.0.0.1")).toBe("127.0.0.1")
      expect(normalizeIp("::1")).toBe("::1")
    })

    it("isLoopbackIp: 127.0.0.0/8 및 ::1 판정 (::ffff: 포함)", () => {
      expect(isLoopbackIp("127.0.0.1")).toBe(true)
      expect(isLoopbackIp("127.255.255.254")).toBe(true)
      expect(isLoopbackIp("::1")).toBe(true)
      expect(isLoopbackIp("::ffff:127.0.0.1")).toBe(true)
      expect(isLoopbackIp("100.64.0.1")).toBe(false)
      expect(isLoopbackIp("192.0.2.1")).toBe(false)
    })

    it("isTailnetIp: 100.64.0.0/10 및 fd7a:115c:a1e0::/48 판정 (::ffff: 포함)", () => {
      expect(isTailnetIp("100.64.0.1")).toBe(true)
      expect(isTailnetIp("100.127.255.254")).toBe(true)
      expect(isTailnetIp("::ffff:100.64.0.1")).toBe(true)
      expect(isTailnetIp("100.63.255.255")).toBe(false)
      expect(isTailnetIp("100.128.0.0")).toBe(false)
      expect(isTailnetIp("fd7a:115c:a1e0::1")).toBe(true)
      expect(isTailnetIp("fd7a:115c:a1e0:1234::1")).toBe(true)
      expect(isTailnetIp("fd7a:115c:a1e1::1")).toBe(false)
    })
  })

  describe("믿음 판정 (evaluateTrust)", () => {
    const secret = "test-secret-value-12345"
    const tailscaleIps = ["100.100.1.2", "fd7a:115c:a1e0::2"]
    const mockGetTailscaleIps = () => tailscaleIps

    it("비밀이 일치하지 않으면 헤더 위조와 무관하게 trusted = false", () => {
      const decision = evaluateTrust(
        {
          "x-naia-proxy-secret": "wrong-secret",
          "x-naia-peer": "127.0.0.1",
          "x-naia-local": "100.100.1.2",
          "x-naia-origin-ok": "1",
        },
        secret,
        mockGetTailscaleIps,
      )
      expect(decision.secretValid).toBe(false)
      expect(decision.trusted).toBe(false)
      expect(decision.peer).toBeNull()
      expect(formatTrustLog(decision)).toBe("peer 127.0.0.1·비밀 일치 거짓·믿지 않음")
    })

    it("비밀이 없고 peer만 오면 secretValid = false, trusted = false", () => {
      const decision = evaluateTrust(
        {
          "x-naia-peer": "100.64.0.1",
        },
        secret,
        mockGetTailscaleIps,
      )
      expect(decision.secretValid).toBe(false)
      expect(decision.trusted).toBe(false)
      expect(formatTrustLog(decision)).toBe("peer 100.64.0.1·비밀 일치 거짓·믿지 않음")
    })

    it("비밀이 맞고 loopback peer (IPv4, IPv6, ::ffff:)이면 trusted = true", () => {
      for (const loopbackPeer of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.0.0.5"]) {
        const decision = evaluateTrust(
          {
            "x-naia-proxy-secret": secret,
            "x-naia-peer": loopbackPeer,
          },
          secret,
          mockGetTailscaleIps,
        )
        expect(decision.secretValid).toBe(true)
        expect(decision.trusted).toBe(true)
        expect(decision.isLoopback).toBe(true)
        expect(formatTrustLog(decision)).toBe(`peer ${loopbackPeer}·비밀 일치 참·믿음`)
      }
    })

    it("비밀이 맞고 tailnet peer + local 인터페이스 주소 일치 시 trusted = true", () => {
      const decision = evaluateTrust(
        {
          "x-naia-proxy-secret": secret,
          "x-naia-peer": "100.64.0.1",
          "x-naia-local": "100.100.1.2",
          "x-naia-origin-ok": "1",
        },
        secret,
        mockGetTailscaleIps,
      )
      expect(decision.secretValid).toBe(true)
      expect(decision.trusted).toBe(true)
      expect(decision.isTailnet).toBe(true)
      expect(decision.localMatchesTailnet).toBe(true)
      expect(decision.originOk).toBe(true)
      expect(formatTrustLog(decision)).toBe("peer 100.64.0.1·비밀 일치 참·믿음")
    })

    it("비밀이 맞고 tailnet peer이나 local 인터페이스 주소 불일치 시 trusted = false", () => {
      const decision = evaluateTrust(
        {
          "x-naia-proxy-secret": secret,
          "x-naia-peer": "100.64.0.1",
          "x-naia-local": "192.0.2.5",
        },
        secret,
        mockGetTailscaleIps,
      )
      expect(decision.secretValid).toBe(true)
      expect(decision.trusted).toBe(false)
      expect(decision.isTailnet).toBe(true)
      expect(decision.localMatchesTailnet).toBe(false)
      expect(formatTrustLog(decision)).toBe("peer 100.64.0.1·비밀 일치 참·믿지 않음")
    })

    it("비밀이 맞고 tailnet IPv6 peer + IPv6 local 인터페이스 일치 시 trusted = true", () => {
      const decision = evaluateTrust(
        {
          "x-naia-proxy-secret": secret,
          "x-naia-peer": "fd7a:115c:a1e0::1",
          "x-naia-local": "fd7a:115c:a1e0::2",
        },
        secret,
        mockGetTailscaleIps,
      )
      expect(decision.secretValid).toBe(true)
      expect(decision.trusted).toBe(true)
      expect(decision.isTailnet).toBe(true)
      expect(decision.localMatchesTailnet).toBe(true)
    })
  })

  describe("비밀 파일 생성 및 권한 (writeProxySecret)", () => {
    let tempXdg: string
    // 준비 단계에서 설정된 격리 임시 값 (os.tmpdir() 아래이고 /run/user/로 시작하지 않음)
    const initialIsolatedXdg = process.env.XDG_RUNTIME_DIR

    beforeEach(() => {
      tempXdg = fs.mkdtempSync(path.join(os.tmpdir(), "adk-sec-test-xdg-"))
      process.env.XDG_RUNTIME_DIR = tempXdg
    })

    afterEach(() => {
      // 준비 단계의 임시 값으로 되돌아가게 맞춤
      process.env.XDG_RUNTIME_DIR = initialIsolatedXdg
      try {
        fs.rmSync(tempXdg, { recursive: true, force: true })
      } catch {
        // ignore
      }
    })

    it("폴더 권한 700, 파일 권한 600으로 생성된다", () => {
      const port = 3199
      const { secret, filePath } = writeProxySecret(port)

      expect(secret).toHaveLength(64) // 32바이트 hex
      expect(fs.existsSync(filePath)).toBe(true)
      expect(filePath).toBe(path.join(tempXdg, "naia-adk", `portal-proxy-secret-${port}`))

      const dirStat = fs.statSync(getProxySecretDir())
      const fileStat = fs.statSync(filePath)

      // POSIX 권한 비트 검사 (0o700, 0o600)
      if (process.platform !== "win32") {
        expect(dirStat.mode & 0o777).toBe(0o700)
        expect(fileStat.mode & 0o777).toBe(0o600)
      }
    })

    it("port <= 0 인 경우 에러를 던져 port 0 파일 생성을 방지한다", () => {
      expect(() => writeProxySecret(0)).toThrow()
      expect(() => writeProxySecret(-1)).toThrow()
    })
  })
})

describe("Fastify 서버 통합 보호 검사 (W1a-2)", () => {
  let tempRoot: string

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adk-server-test-"))
  })

  afterEach(() => {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it("Host 검사: 올바른 Host는 200, 다른 Host 및 포트 불일치는 421", async () => {
    const app = await createServer({ root: tempRoot, port: 3175, host: "127.0.0.1" })

    // 올바른 Host
    const resOk = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: "127.0.0.1:3175" },
    })
    expect(resOk.statusCode).toBe(200)

    const resLocalhost = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: "localhost:3175" },
    })
    expect(resLocalhost.statusCode).toBe(200)

    const resIpv6 = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: "[::1]:3175" },
    })
    expect(resIpv6.statusCode).toBe(200)

    // 이름 Host (공격자 도메인) -> 421
    const resAttacker = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: "attacker.example:3175" },
    })
    expect(resAttacker.statusCode).toBe(421)

    // 포트 불일치 (:80) -> 421
    const resPort80 = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: "127.0.0.1:80" },
    })
    expect(resPort80.statusCode).toBe(421)

    const resLocal80 = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: "localhost:80" },
    })
    expect(resLocal80.statusCode).toBe(421)

    // 포트 누락 -> 421
    const resNoPort = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: "localhost" },
    })
    expect(resNoPort.statusCode).toBe(421)
  })

  function assertSafeSecretDirBeforeListen() {
    const secretDir = path.resolve(getProxySecretDir())
    const tmpDir = path.resolve(os.tmpdir())
    const isUnderTmp = secretDir.startsWith(tmpDir + path.sep) || secretDir === tmpDir
    const startsWithRunUser = secretDir.startsWith("/run/user/")

    if (!isUnderTmp || startsWithRunUser) {
      throw new Error(
        `격리 실패: getProxySecretDir() 경로(${secretDir})가 os.tmpdir() 아래가 아니거나 /run/user/로 시작합니다. listen을 중단합니다.`
      )
    }
  }

  it("경로 탈출 검사: 실제 HTTP 요청에서 .. 조각, %2e, %2f, %5c, 역슬래시가 있으면 400", async () => {
    assertSafeSecretDirBeforeListen()
    const app = await createServer({ root: tempRoot, port: 0, host: "127.0.0.1" })
    await app.listen({ port: 0, host: "127.0.0.1" })
    const actualPort = (app.server.address() as any).port

    const httpGet = (rawPath: string) => {
      return new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: actualPort,
            path: rawPath,
            method: "GET",
            headers: {
              host: `127.0.0.1:${actualPort}`,
            },
          },
          (res) => {
            res.resume()
            resolve(res.statusCode ?? 0)
          },
        )
        req.on("error", reject)
        req.end()
      })
    }

    const testCases = [
      "/api/portal/../workspace/tree",
      "/api/portal/%2e%2e/skills",
      "/api/portal/.%2e/skills",
      "/api/portal/..%2fworkspace",
      "/api/portal\\workspace",
      "/api/portal%5cworkspace",
    ]

    try {
      for (const testPath of testCases) {
        const status = await httpGet(testPath)
        expect(status, `Expected 400 for path: ${testPath}`).toBe(400)
      }
    } finally {
      await app.close()
    }
  })

  it("app.listen 시 생성되는 프록시 비밀 파일의 실제 경로가 os.tmpdir() 아래이고 /run/user/로 시작하지 않는다", async () => {
    assertSafeSecretDirBeforeListen()
    const app = await createServer({ root: tempRoot, port: 0, host: "127.0.0.1" })
    try {
      await app.listen({ port: 0, host: "127.0.0.1" })
      const actualPort = (app.server.address() as any).port
      const secretPath = path.resolve(getProxySecretPath(actualPort))

      // 비밀 파일 존재 확인
      expect(fs.existsSync(secretPath)).toBe(true)

      // 비밀 파일의 실제 경로가 os.tmpdir() 아래이고 /run/user/로 시작하지 않는다고 단언 (경로만 보고 내용은 읽지 않음)
      const tmpDir = path.resolve(os.tmpdir())
      const isUnderTmp = secretPath.startsWith(tmpDir + path.sep) || secretPath === tmpDir
      expect(isUnderTmp).toBe(true)
      expect(secretPath.startsWith("/run/user/")).toBe(false)
    } finally {
      await app.close()
    }
  })

  it("/api/files 라우트 등록 제거 확인 -> 404", async () => {
    const app = await createServer({ root: tempRoot, port: 3175, host: "127.0.0.1" })

    const res = await app.inject({
      method: "GET",
      url: "/api/files",
      headers: { host: "127.0.0.1:3175" },
    })
    expect(res.statusCode).toBe(404)
  })

  it("CORS 비활성화: Origin 헤더가 있어도 Access-Control-Allow-Origin이 없음", async () => {
    const app = await createServer({ root: tempRoot, port: 3175, host: "127.0.0.1" })

    const res = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: {
        host: "127.0.0.1:3175",
        origin: "http://127.0.0.1:3176",
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers["access-control-allow-origin"]).toBeUndefined()
  })
})
