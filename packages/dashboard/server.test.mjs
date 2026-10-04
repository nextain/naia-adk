import test, { describe, it } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import net from "node:net"
import { PassThrough } from "node:stream"
import { execSync } from "node:child_process"
import {
  buildProxyHeaders,
  validatePortalPathname,
  proxyToApi,
  createRequestHandler,
  parseArgs,
  normalizeIp,
} from "./server.mjs"
import { FRAME_ANCESTORS_CSP } from "./frame-policy.mjs"

describe("Server.mjs 단위 시험", () => {
  it("server.mjs 모듈을 import했을 때 listen 소켓을 열지 않는다", async () => {
    // 1. server.mjs 모듈 import
    const serverModule = await import("./server.mjs")
    assert.ok(serverModule, "server.mjs loaded")

    // 2. ss -ltnp로 현재 PID의 수신 소켓 확인
    const ssOut = execSync("ss -ltnp", { encoding: "utf-8" })
    const myPid = process.pid
    const pidPattern = new RegExp(`pid=${myPid},`)
    const hasListenSocket = pidPattern.test(ssOut)

    assert.equal(
      hasListenSocket,
      false,
      `Importing server.mjs opened a listening socket on current process PID ${myPid}!\n${ssOut}`
    )
  })

  it("가짜 소켓(remoteAddress=192.0.2.10, localAddress=192.0.2.1)으로 머리글을 다시 붙여 API로 나가는 x-naia-peer와 x-naia-local이 일치한다", async () => {
    const fakeSocket = {
      remoteAddress: "192.0.2.10",
      localAddress: "192.0.2.1",
    }
    const incomingReq = {
      method: "GET",
      headers: {
        host: "localhost:3142",
        "x-naia-peer": "100.64.0.1",
        "x-naia-local": "100.64.0.2",
        "x-naia-proxy-secret": "wrong",
        "x-naia-origin-ok": "1",
      },
      socket: fakeSocket,
      pipe(dest) {
        dest.end()
        return dest
      },
    }

    // 1. 도우미 함수 직접 검증
    const headers = buildProxyHeaders(incomingReq, fakeSocket, "test-secret-123", 3199)
    assert.equal(headers["x-naia-peer"], "192.0.2.10")
    assert.equal(headers["x-naia-local"], "192.0.2.1")
    assert.equal(headers["x-naia-proxy-secret"], "test-secret-123")
    assert.equal(headers["host"], "127.0.0.1:3199")

    // 2. 실제 HTTP API 수신 서버를 통한 네트워크 전달 헤더 검증
    let receivedHeaders = null
    const dummyApi = http.createServer((apiReq, apiRes) => {
      receivedHeaders = apiReq.headers
      apiRes.statusCode = 200
      apiRes.end("ok")
    })

    await new Promise((resolve) => dummyApi.listen(0, "127.0.0.1", resolve))
    const apiPort = dummyApi.address().port

    try {
      const clientRes = new http.ServerResponse(incomingReq)
      proxyToApi(
        incomingReq,
        clientRes,
        "/api/portal",
        apiPort,
        "test-secret-123",
        fakeSocket
      )

      await new Promise((resolve) => {
        const interval = setInterval(() => {
          if (receivedHeaders) {
            clearInterval(interval)
            resolve()
          }
        }, 10)
      })

      assert.ok(receivedHeaders, "Dummy API must have received request")
      assert.equal(receivedHeaders["x-naia-peer"], "192.0.2.10")
      assert.equal(receivedHeaders["x-naia-local"], "192.0.2.1")
      assert.equal(receivedHeaders["x-naia-proxy-secret"], "test-secret-123")
      assert.equal(receivedHeaders["host"], `127.0.0.1:${apiPort}`)
    } finally {
      await new Promise((resolve) => dummyApi.close(resolve))
    }
  })

  it("경로 탈출 및 대소문자 검사: /api/portal 밖으로의 경로는 400 거절 대상이다", () => {
    // 경로 탈출 시도
    assert.equal(validatePortalPathname("/api/portal/%2e%2e/skills").valid, false)
    assert.equal(validatePortalPathname("/api/portal/%2E%2E/skills").valid, false)
    assert.equal(validatePortalPathname("/api/portal/.%2e/skills").valid, false)
    assert.equal(validatePortalPathname("/api/portal/..%2fworkspace").valid, false)
    assert.equal(validatePortalPathname("/api/portal/../workspace/tree").valid, false)
    assert.equal(validatePortalPathname("/api/portal/./../skills").valid, false)
    assert.equal(validatePortalPathname("/api/portal/..\\skills").valid, false)

    // 대소문자가 다른 접두어 거절
    assert.equal(validatePortalPathname("/API/portal").valid, false)
    assert.equal(validatePortalPathname("/API/portal/doc").valid, false)

    // 정상 경로 통과
    const normal = validatePortalPathname("/api/portal/doc")
    assert.equal(normal.valid, true)
    assert.equal(normal.resolvedPathname, "/api/portal/doc")
  })

  it("쓰기 메서드(POST, PUT, PATCH, DELETE)에서 Origin이 scheme://Host와 일치할 때만 x-naia-origin-ok: 1을 붙인다", () => {
    const fakeSocket = { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" }
    
    // 1. POST + 일치하는 Origin
    const req1 = {
      method: "POST",
      headers: { host: "127.0.0.1:3172", origin: "http://127.0.0.1:3172" },
      socket: fakeSocket,
    }
    const h1 = buildProxyHeaders(req1, fakeSocket, "secret", 3171)
    assert.equal(h1["x-naia-origin-ok"], "1")

    // 2. POST + 불일치하는 Origin (다른 포트)
    const req2 = {
      method: "POST",
      headers: { host: "127.0.0.1:3172", origin: "http://127.0.0.1:3179" },
      socket: fakeSocket,
    }
    const h2 = buildProxyHeaders(req2, fakeSocket, "secret", 3171)
    assert.equal(h2["x-naia-origin-ok"], undefined)

    // 3. GET + 일치하는 Origin (쓰기 메서드만 적용)
    const req3 = {
      method: "GET",
      headers: { host: "127.0.0.1:3172", origin: "http://127.0.0.1:3172" },
      socket: fakeSocket,
    }
    const h3 = buildProxyHeaders(req3, fakeSocket, "secret", 3171)
    assert.equal(h3["x-naia-origin-ok"], undefined)
  })

  it("CLI 인자(-p, -H) 및 환경 변수 우선순위 해석", () => {
    const { port, host } = parseArgs(["-p", "3175", "-H", "127.0.0.1"], {
      NAIA_DASHBOARD_PORT: "3172",
      NAIA_DASHBOARD_HOST: "0.0.0.0",
    })
    assert.equal(port, 3175)
    assert.equal(host, "127.0.0.1")
  })

  it("(라) createRequestHandler(가짜 nextHandler)로 Host localhost:3142 요청을 처리하면 CSP가 FRAME_ANCESTORS_CSP와 같고 x-frame-options가 없다", () => {
    let nextCalled = false
    const fakeNext = (req, res) => {
      nextCalled = true
    }
    const handler = createRequestHandler(fakeNext)
    const headers = new Map()
    const fakeRes = {
      statusCode: 200,
      setHeader(k, v) {
        headers.set(k.toLowerCase(), v)
      },
      getHeader(k) {
        return headers.get(k.toLowerCase())
      },
      end() {},
    }
    const fakeReq = {
      method: "GET",
      url: "/",
      headers: {
        host: "localhost:3142",
      },
    }

    handler(fakeReq, fakeRes)

    assert.equal(nextCalled, true)
    assert.equal(fakeRes.getHeader("content-security-policy"), FRAME_ANCESTORS_CSP)
    assert.equal(fakeRes.getHeader("x-frame-options"), undefined)
  })

  it("(마) proxyToApi: API가 CSP·XFO를 안 주면 응답 CSP는 FRAME_ANCESTORS_CSP 하나, x-frame-options 없음", async () => {
    const dummyApi = http.createServer((apiReq, apiRes) => {
      apiRes.statusCode = 200
      apiRes.end("ok")
    })
    await new Promise((resolve) => dummyApi.listen(0, "127.0.0.1", resolve))
    const apiPort = dummyApi.address().port

    const fakeSocket = { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" }
    const incomingReq = {
      method: "GET",
      headers: { host: "127.0.0.1:3142" },
      socket: fakeSocket,
      pipe(dest) {
        dest.end()
        return dest
      },
    }

    const headers = new Map()
    const clientRes = new PassThrough()
    clientRes.statusCode = 200
    clientRes.setHeader = (k, v) => headers.set(k.toLowerCase(), v)
    clientRes.getHeader = (k) => headers.get(k.toLowerCase())

    try {
      proxyToApi(
        incomingReq,
        clientRes,
        "/api/portal",
        apiPort,
        "test-secret-123",
        fakeSocket
      )

      await new Promise((resolve) => clientRes.on("finish", resolve))

      assert.equal(clientRes.getHeader("content-security-policy"), FRAME_ANCESTORS_CSP)
      assert.equal(clientRes.getHeader("x-frame-options"), undefined)
    } finally {
      await new Promise((resolve) => dummyApi.close(resolve))
    }
  })

  it("(바) proxyToApi: API가 content-security-policy: default-src 'self'를 주면 응답 CSP는 두 값(API 것, FRAME_ANCESTORS_CSP)이 이 순서로 모두 있다", async () => {
    const dummyApi = http.createServer((apiReq, apiRes) => {
      apiRes.setHeader("content-security-policy", "default-src 'self'")
      apiRes.statusCode = 200
      apiRes.end("ok")
    })
    await new Promise((resolve) => dummyApi.listen(0, "127.0.0.1", resolve))
    const apiPort = dummyApi.address().port

    const fakeSocket = { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" }
    const incomingReq = {
      method: "GET",
      headers: { host: "127.0.0.1:3142" },
      socket: fakeSocket,
      pipe(dest) {
        dest.end()
        return dest
      },
    }

    const headers = new Map()
    const clientRes = new PassThrough()
    clientRes.statusCode = 200
    clientRes.setHeader = (k, v) => headers.set(k.toLowerCase(), v)
    clientRes.getHeader = (k) => headers.get(k.toLowerCase())

    try {
      proxyToApi(
        incomingReq,
        clientRes,
        "/api/portal",
        apiPort,
        "test-secret-123",
        fakeSocket
      )

      await new Promise((resolve) => clientRes.on("finish", resolve))

      const csp = clientRes.getHeader("content-security-policy")
      assert.deepEqual(csp, ["default-src 'self'", FRAME_ANCESTORS_CSP])
    } finally {
      await new Promise((resolve) => dummyApi.close(resolve))
    }
  })

  it("(사) proxyToApi: API가 x-frame-options: DENY를 주면 그대로 DENY로 전달된다", async () => {
    const dummyApi = http.createServer((apiReq, apiRes) => {
      apiRes.setHeader("x-frame-options", "DENY")
      apiRes.statusCode = 200
      apiRes.end("ok")
    })
    await new Promise((resolve) => dummyApi.listen(0, "127.0.0.1", resolve))
    const apiPort = dummyApi.address().port

    const fakeSocket = { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" }
    const incomingReq = {
      method: "GET",
      headers: { host: "127.0.0.1:3142" },
      socket: fakeSocket,
      pipe(dest) {
        dest.end()
        return dest
      },
    }

    const headers = new Map()
    const clientRes = new PassThrough()
    clientRes.statusCode = 200
    clientRes.setHeader = (k, v) => headers.set(k.toLowerCase(), v)
    clientRes.getHeader = (k) => headers.get(k.toLowerCase())

    try {
      proxyToApi(
        incomingReq,
        clientRes,
        "/api/portal",
        apiPort,
        "test-secret-123",
        fakeSocket
      )

      await new Promise((resolve) => clientRes.on("finish", resolve))

      assert.equal(clientRes.getHeader("x-frame-options"), "DENY")
    } finally {
      await new Promise((resolve) => dummyApi.close(resolve))
    }
  })

  it("(차) createRequestHandler에 Host evil.example 요청 시 421, CSP는 FRAME_ANCESTORS_CSP, x-frame-options 없음, 가짜 nextHandler 호출 안 됨", () => {
    let nextCalled = false
    const fakeNext = (req, res) => {
      nextCalled = true
    }
    const handler = createRequestHandler(fakeNext)
    const headers = new Map()
    const fakeRes = {
      statusCode: 200,
      setHeader(k, v) {
        headers.set(k.toLowerCase(), v)
      },
      getHeader(k) {
        return headers.get(k.toLowerCase())
      },
      end() {},
    }
    const fakeReq = {
      method: "GET",
      url: "/docs",
      headers: {
        host: "evil.example",
      },
    }

    handler(fakeReq, fakeRes)

    assert.equal(nextCalled, false)
    assert.equal(fakeRes.statusCode, 421)
    assert.equal(fakeRes.getHeader("content-security-policy"), FRAME_ANCESTORS_CSP)
    assert.equal(fakeRes.getHeader("x-frame-options"), undefined)
  })

  it("(카) createRequestHandler: invalid /api/portal 경로 요청 시 400, CSP는 FRAME_ANCESTORS_CSP, x-frame-options 없음", () => {
    const invalidUrl = "/api/portal/../x"
    assert.equal(validatePortalPathname(invalidUrl).valid, false)

    let nextCalled = false
    const fakeNext = (req, res) => {
      nextCalled = true
    }
    const handler = createRequestHandler(fakeNext)
    const headers = new Map()
    const fakeRes = {
      statusCode: 200,
      setHeader(k, v) {
        headers.set(k.toLowerCase(), v)
      },
      getHeader(k) {
        return headers.get(k.toLowerCase())
      },
      end() {},
    }
    const fakeReq = {
      method: "GET",
      url: invalidUrl,
      headers: {
        host: "localhost:3142",
      },
    }

    handler(fakeReq, fakeRes)

    assert.equal(nextCalled, false)
    assert.equal(fakeRes.statusCode, 400)
    assert.equal(fakeRes.getHeader("content-security-policy"), FRAME_ANCESTORS_CSP)
    assert.equal(fakeRes.getHeader("x-frame-options"), undefined)
  })

  it("(타) proxyToApi: 미수신 포트로 연결 실패 시 502, CSP는 FRAME_ANCESTORS_CSP, x-frame-options 없음", async () => {
    const dummyServer = net.createServer()
    let unusedPort
    try {
      await new Promise((resolve, reject) => {
        dummyServer.once("error", reject)
        dummyServer.listen(0, "127.0.0.1", () => {
          unusedPort = dummyServer.address().port
          resolve()
        })
      })
    } finally {
      if (dummyServer.listening) {
        await new Promise((resolve) => dummyServer.close(resolve))
      }
    }

    const fakeSocket = { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" }
    const incomingReq = {
      method: "GET",
      headers: { host: "127.0.0.1:3142" },
      socket: fakeSocket,
      pipe(dest) {
        dest.end()
        return dest
      },
    }

    const headers = new Map()
    const clientRes = new PassThrough()
    clientRes.statusCode = 200
    clientRes.setHeader = (k, v) => headers.set(k.toLowerCase(), v)
    clientRes.getHeader = (k) => headers.get(k.toLowerCase())

    proxyToApi(
      incomingReq,
      clientRes,
      "/api/portal",
      unusedPort,
      "test-secret-123",
      fakeSocket
    )

    await new Promise((resolve) => clientRes.on("finish", resolve))

    assert.equal(clientRes.statusCode, 502)
    assert.equal(clientRes.getHeader("content-security-policy"), FRAME_ANCESTORS_CSP)
    assert.equal(clientRes.getHeader("x-frame-options"), undefined)
  })
})
