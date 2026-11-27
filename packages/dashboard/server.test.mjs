import test, { describe, it } from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import http from "node:http"
import { execSync } from "node:child_process"
import {
  buildProxyHeaders,
  validatePortalPathname,
  proxyToApi,
  createRequestHandler,
  startServer,
  parseArgs,
  normalizeIp,
  inheritedSocketFd,
} from "./server.mjs"
import { clearGateSecretCache } from "./identity-header-guard.mjs"

describe("물려받은 포트 fd", () => {
  it("LISTEN_PID 가 이 과정이고 LISTEN_FDS 가 1 이면 fd 3 을 쓴다", () => {
    assert.equal(inheritedSocketFd({ LISTEN_FDS: "1", LISTEN_PID: "42" }, 42), 3)
  })
  it("없거나 다른 과정 몫이면 -p/-H 로 listen 한다", () => {
    assert.equal(inheritedSocketFd({}, 42), null)
    assert.equal(inheritedSocketFd({ LISTEN_FDS: "1" }, 42), null)
    assert.equal(inheritedSocketFd({ LISTEN_FDS: "1", LISTEN_PID: "41" }, 42), null)
  })
  it("이 과정 몫인데 하나가 아니면 고르지 않고 멈춘다", () => {
    assert.throws(() => inheritedSocketFd({ LISTEN_FDS: "2", LISTEN_PID: "42" }, 42), /LISTEN_FDS=2/)
    assert.throws(() => inheritedSocketFd({ LISTEN_FDS: "0", LISTEN_PID: "42" }, 42), /LISTEN_FDS=0/)
  })
})

describe("Server.mjs 단위 시험", () => {
  it("일정 화면 요청은 신원 검증 표시를 제거한 뒤 화면으로 넘긴다", () => {
    const req = {
      url: "/schedule",
      headers: { host: "127.0.0.1:3142", "x-naia-gate-verified": "forged", "x-naia-actor-id": "forged" },
      rawHeaders: ["Host", "127.0.0.1:3142", "X-Naia-Gate-Verified", "forged", "X-Naia-Actor-Id", "forged"],
      socket: { remoteAddress: "192.0.2.10" },
    }
    let forwarded = false
    const handler = createRequestHandler((incoming) => {
      forwarded = true
      assert.equal(incoming.headers["x-naia-gate-verified"], undefined)
      assert.equal(incoming.headers["x-naia-actor-id"], undefined)
      assert.deepEqual(incoming.rawHeaders, ["Host", "127.0.0.1:3142"])
    })
    handler(req, { setHeader() {} })
    assert.equal(forwarded, true)
  })

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
      rawHeaders: ["host", "127.0.0.1:3172", "origin", "http://127.0.0.1:3172"],
      socket: fakeSocket,
    }
    const h1 = buildProxyHeaders(req1, fakeSocket, "secret", 3171)
    assert.equal(h1["x-naia-origin-ok"], "1")

    // 2. POST + 불일치하는 Origin (다른 포트)
    const req2 = {
      method: "POST",
      headers: { host: "127.0.0.1:3172", origin: "http://127.0.0.1:3179" },
      rawHeaders: ["host", "127.0.0.1:3172", "origin", "http://127.0.0.1:3179"],
      socket: fakeSocket,
    }
    const h2 = buildProxyHeaders(req2, fakeSocket, "secret", 3171)
    assert.equal(h2["x-naia-origin-ok"], undefined)

    // 3. GET + 일치하는 Origin (쓰기 메서드만 적용)
    const req3 = {
      method: "GET",
      headers: { host: "127.0.0.1:3172", origin: "http://127.0.0.1:3172" },
      rawHeaders: ["host", "127.0.0.1:3172", "origin", "http://127.0.0.1:3172"],
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
})

describe("메신저 SSE 프록시", () => {
  it("API 쪽이 응답 도중 끊기면 브라우저 쪽 연결도 1초 안에 끊긴다(메신저 SSE 다시 붙기)", async () => {
    const dummyApi = http.createServer((apiReq, apiRes) => {
      apiRes.writeHead(200, { "content-type": "text/event-stream" })
      apiRes.write(": hello\n\n")
      setTimeout(() => apiRes.socket.destroy(), 50)
    })
    await new Promise((resolve) => dummyApi.listen(0, "127.0.0.1", resolve))
    const apiPort = dummyApi.address().port
    const dashServer = http.createServer((req, res) => {
      proxyToApi(req, res, "/api/portal/messenger/stream", apiPort, "test-secret", req.socket)
    })
    await new Promise((resolve) => dashServer.listen(0, "127.0.0.1", resolve))
    const dashPort = dashServer.address().port
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("browser side stayed open")), 1000)
        const clientReq = http.get(`http://127.0.0.1:${dashPort}/api/portal/messenger/stream`, (clientRes) => {
          clientRes.resume()
          clientRes.on("close", () => {
            clearTimeout(timer)
            resolve()
          })
        })
        clientReq.on("error", () => {})
      })
    } finally {
      if (typeof dashServer.closeAllConnections === "function") {
        dashServer.closeAllConnections()
      }
      if (typeof dummyApi.closeAllConnections === "function") {
        dummyApi.closeAllConnections()
      }
      await new Promise((resolve) => dashServer.close(resolve))
      await new Promise((resolve) => dummyApi.close(resolve))
    }
  })

  it("게시 게이트 확인 표시가 꺼지면 문서 발견·상태·미리보기·할 일·요청·승인과 인코딩 별칭을 프록시 전에 403으로 거절한다", (t) => {
    const upstream = t.mock.method(http, "request", () => assert.fail("차단된 승인 요청이 API 프록시를 호출함"))
    const paths = [
      "/api/portal/publish/document?source=adk&path=article.md",
      "/api/portal/publish/test-post/status",
      "/api/portal/publish/test-post/preview?review_id=review&revision_id=revision",
      "/api/portal/publish/review-todos",
      "/api/portal/publish/operations/op-test",
      "/api/portal/publish/test-post/request-review",
      "/api/portal/%70ublish/document?source=adk&path=article.md",
      "/api/portal/publish/test-post/approve",
      "/api/portal/publish/test-post/%61pprove",
      "/api/portal/publish/test-post/appro%76e",
      "/api/portal/publish/test-post/approv%65?ignored=%2f",
      "/api/portal/publish/test-post/%61%70%70%72%6f%76%65",
      "/api/portal/publish/test-post/%61%70%70%72%6F%76%65",
      "/api/portal/%70ublish/test-post/%61pprove",
      "/api/portal/publish/%74est-post/%61pprove",
      "/api/portal/publish/test-post//approve",
      "/api/portal//publish//test-post///%61pprove/",
      "/api/portal/publish/test-post/approve/",
    ]
    const requestIds = new Set()
    for (const flag of [undefined, "", "0", "true"]) {
      const handler = createRequestHandler(() => assert.fail("승인 차단 뒤 화면 처리기로 넘어감"), {}, { PUBLISH_GATEWAY_OVERWRITE_CONFIRMED: flag })
      for (const [index, url] of paths.entries()) {
        const headers = { host: "localhost:3142" }
        const req = { method: index < 5 || index === 6 ? "GET" : "POST", url, headers, rawHeaders: Object.entries(headers).flat(), socket: { remoteAddress: "127.0.0.1" } }
        const res = { statusCode: 0, headers: {}, body: "", setHeader(key, value) { this.headers[key] = value }, end(value) { this.body = value } }
        handler(req, res)
        assert.equal(res.statusCode, 403, `${url}, flag=${flag}`)
        const body = JSON.parse(res.body)
        assert.deepEqual(Object.keys(body).sort(), ["code", "issues", "message", "ok", "operation_id", "request_id", "retryable"])
        assert.equal(body.ok, false)
        assert.equal(body.code, "publish_gateway_unconfirmed")
        assert.equal(body.message, "관문의 계정 덮어쓰기 확인이 필요합니다.")
        assert.equal(body.retryable, false)
        assert.match(body.request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
        assert.equal(requestIds.has(body.request_id), false)
        requestIds.add(body.request_id)
        assert.equal(body.operation_id, null)
        assert.deepEqual(body.issues, [])
        assert.equal(res.headers["content-type"], "application/json; charset=utf-8")
        assert.equal(res.headers["cache-control"], "no-store")
      }
    }
    const handler = createRequestHandler(() => assert.fail("잘못된 경로가 화면 처리기로 넘어감"), {}, {})
    for (const url of [
      "/api/portal/publish/test-post%2fapprove",
      "/api/portal/publish/test-post%2Fapprove",
      "/api/portal/publish/test-post/%2e%2e/approve",
    ]) {
      const req = { method: "POST", url, headers: { host: "localhost:3142" }, rawHeaders: ["host", "localhost:3142"], socket: { remoteAddress: "127.0.0.1" } }
      const res = { statusCode: 0, setHeader() {}, end() {} }
      handler(req, res)
      assert.equal(res.statusCode, 400, url)
    }
    assert.equal(upstream.mock.callCount(), 0)
  })
})

// ── 문서 짧은 주소 (/d/<키>, /d/<출처>/<경로>, POST /d, 명령) ───────────────────────────
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import {
  shortKeyFor,
  registerShortLink,
  resolveShortPath,
  parseDocTarget,
  publicBaseUrl,
  loadTable,
  chooseKey,
  isValidDocPath,
  saveTable,
} from "./short-links.mjs"
import * as shortLinksModule from "./short-links.mjs"

describe("문서 짧은 주소", () => {
  const ARCH = "developer/architecture/ARCHITECTURE.md"
  const tabFor = (source, p) => (source === "adk" && p.startsWith("developer/") ? "developer" : undefined)
  // 명령 시험의 바깥 주소. 아무것도 듣지 않는 이 PC 포트라서 등록 요청이 바로 실패하고 표 파일에 직접 쓴다.
  const OFFLINE_BASE = "http://127.0.0.1:9"
  const createdDirs = []
  test.after(() => {
    for (const dir of createdDirs) fs.rmSync(dir, { recursive: true, force: true })
  })

  function tmpTable() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "short-links-test-"))
    createdDirs.push(dir)
    return path.join(dir, "short-links.json")
  }

  async function withServer(tableFile, fn) {
    const nextCalls = []
    const handler = createRequestHandler((req, res) => {
      nextCalls.push(req.url)
      res.statusCode = 200
      res.end("next")
    }, { tableFile, tabFor })
    const server = http.createServer(handler)
    await new Promise((r) => server.listen(0, "127.0.0.1", r))
    const port = server.address().port
    try {
      await fn({ port, nextCalls })
    } finally {
      await new Promise((r) => server.close(r))
    }
  }

  function request(port, { method = "GET", path: p, headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } },
        (res) => {
          let data = ""
          res.setEncoding("utf8")
          res.on("data", (c) => (data += c))
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
        },
      )
      req.on("error", reject)
      if (body) req.write(body)
      req.end()
    })
  }

  it("키는 출처+경로에서 결정적으로 나오는 16진 6자다", () => {
    const k1 = shortKeyFor("adk", ARCH)
    assert.match(k1, /^[0-9a-f]{6}$/)
    assert.equal(shortKeyFor("adk", ARCH), k1)
    assert.notEqual(shortKeyFor("adk", "developer/other.md"), k1)
  })

  it("앞 6자가 다른 문서와 겹치면 한 자씩 늘린다", () => {
    const key6 = shortKeyFor("adk", ARCH)
    const table = { version: 1, links: { [key6]: { source: "adk", path: "someone/else.md" } } }
    const key = chooseKey(table, "adk", ARCH)
    assert.equal(key, shortKeyFor("adk", ARCH, 7))
  })

  it("등록한 키로 /d/<키> 를 열면 긴 문서 주소로 302 넘겨 준다", async () => {
    const file = tmpTable()
    const key = registerShortLink("adk", ARCH, file)
    assert.equal(loadTable(file).links[key].path, ARCH)
    // 다시 등록해도 같은 키
    assert.equal(registerShortLink("adk", ARCH, file), key)
    await withServer(file, async ({ port, nextCalls }) => {
      const res = await request(port, { path: `/d/${key}` })
      assert.equal(res.status, 302)
      assert.equal(res.headers.location, "/docs?tab=developer&source=adk&path=developer%2Farchitecture%2FARCHITECTURE.md")
      const upper = await request(port, { path: `/d/${key.toUpperCase()}` })
      assert.equal(upper.status, 404)
      assert.equal(nextCalls.length, 0)
    })
  })

  it("표 없이 /d/<출처>/<경로> 형식도 넘겨 준다(한글·빈칸 경로 포함)", async () => {
    const file = tmpTable()
    await withServer(file, async ({ port }) => {
      const res = await request(port, { path: `/d/adk/${ARCH}` })
      assert.equal(res.status, 302)
      assert.equal(res.headers.location, "/docs?tab=developer&source=adk&path=developer%2Farchitecture%2FARCHITECTURE.md")
      const ko = await request(port, { path: `/d/company:example-docs/${encodeURIComponent("01. 온보딩")}/${encodeURIComponent("첫날.md")}` })
      assert.equal(ko.status, 302)
      assert.equal(ko.headers.location, `/docs?source=company%3Aexample-docs&path=${encodeURIComponent("01. 온보딩/첫날.md")}`)
    })
  })

  it("없는 키는 404, 서버를 다시 만들어도 표 파일의 키는 그대로 열린다", async () => {
    const file = tmpTable()
    await withServer(file, async ({ port }) => {
      assert.equal((await request(port, { path: "/d/abcdef" })).status, 404)
      assert.equal((await request(port, { path: "/d/not-a-key" })).status, 404)
      assert.equal((await request(port, { path: "/d/" })).status, 405)
    })
    const key = registerShortLink("adk", ARCH, file)
    await withServer(file, async ({ port }) => {
      assert.equal((await request(port, { path: `/d/${key}` })).status, 302)
    })
  })

  it("경로 밖으로 나가는 시도(.. · 인코딩한 / · 역슬래시)는 400 으로 막는다", async () => {
    const file = tmpTable()
    await withServer(file, async ({ port, nextCalls }) => {
      for (const p of [
        "/d/adk/../secret.md",
        "/d/adk/developer/../../etc/passwd",
        "/d/adk/%2e%2e/secret.md",
        "/d/adk/developer%2f..%2f..%2fsecret.md",
        "/d/adk/developer%5c..%5csecret.md",
        "/d/adk/./x.md",
        "/d/adk//x.md",
        "/d/..%2fadk/x.md",
        "/d/adk/%E0%A4%A",
      ]) {
        const res = await request(port, { path: p })
        assert.equal(res.status, 400, `${p} should be 400, got ${res.status}`)
      }
      assert.equal(nextCalls.length, 0)
    })
    // 표에 나쁜 경로가 들어가 있어도 넘겨 주지 않는다.
    const bad = { version: 1, links: { abcdef: { source: "adk", path: "../secret.md" } } }
    assert.equal(resolveShortPath("/d/abcdef", { table: bad }).status, 404)
    assert.equal(isValidDocPath("/etc/passwd"), false)
    assert.throws(() => registerShortLink("adk", "../x.md", file))
  })

  it("POST /d 는 같은 출처 JSON 만 받아 등록하고 /d/<키> 를 돌려준다", async () => {
    const file = tmpTable()
    await withServer(file, async ({ port }) => {
      const origin = `http://127.0.0.1:${port}`
      const body = JSON.stringify({ source: "adk", path: ARCH })
      const ok = await request(port, {
        method: "POST",
        path: "/d",
        headers: { origin, "content-type": "application/json" },
        body,
      })
      assert.equal(ok.status, 200)
      const parsed = JSON.parse(ok.body)
      assert.equal(parsed.path, `/d/${shortKeyFor("adk", ARCH)}`)
      assert.equal((await request(port, { path: parsed.path })).status, 302)

      const cross = await request(port, {
        method: "POST",
        path: "/d",
        headers: { origin: "http://evil.example", "content-type": "application/json" },
        body,
      })
      assert.equal(cross.status, 403)
      const noOrigin = await request(port, { method: "POST", path: "/d", headers: { "content-type": "application/json" }, body })
      assert.equal(noOrigin.status, 403)
      const traversal = await request(port, {
        method: "POST",
        path: "/d",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ source: "adk", path: "../../etc/passwd" }),
      })
      assert.equal(traversal.status, 400)
      const form = await request(port, {
        method: "POST",
        path: "/d",
        headers: { origin, "content-type": "application/x-www-form-urlencoded" },
        body: "source=adk",
      })
      assert.equal(form.status, 415)
      assert.equal((await request(port, { method: "POST", path: `/d/adk/${ARCH}` })).status, 405)
    })
  })

  it("허용 안 된 Host 로 온 짧은 주소 요청은 421 (기존 접근 범위 그대로)", async () => {
    const file = tmpTable()
    await withServer(file, async ({ port }) => {
      const res = await request(port, { path: `/d/adk/${ARCH}`, headers: { host: "evil.example" } })
      assert.equal(res.status, 421)
    })
  })

  // ── 검수 지적 반례 (axshortrev1) ──
  const postJson = (port, body, extra = {}) =>
    request(port, {
      method: "POST",
      path: "/d",
      headers: { origin: `http://127.0.0.1:${port}`, "content-type": "application/json", ...extra },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })

  async function withLimitedServer(tableFile, limits, fn) {
    const handler = createRequestHandler((req, res) => res.end("next"), { tableFile, tabFor, ...limits })
    const server = http.createServer(handler)
    await new Promise((r) => server.listen(0, "127.0.0.1", r))
    try {
      await fn({ port: server.address().port })
    } finally {
      await new Promise((r) => server.close(r))
    }
  }

  it("표 항목 수에 상한이 있다: 넘으면 507, 같은 경로 재등록은 새 항목을 만들지 않는다", async () => {
    assert.equal(shortLinksModule.MAX_SHORT_LINKS, 10000)
    const file = tmpTable()
    await withLimitedServer(file, { maxLinks: 3 }, async ({ port }) => {
      const keys = []
      for (const p of ["a/1.md", "a/2.md", "a/3.md"]) {
        const res = await postJson(port, { source: "adk", path: p })
        assert.equal(res.status, 200)
        keys.push(JSON.parse(res.body).key)
      }
      const full = await postJson(port, { source: "adk", path: "a/4.md" })
      assert.equal(full.status, 507)
      const again = await postJson(port, { source: "adk", path: "a/1.md" })
      assert.equal(again.status, 200)
      assert.equal(JSON.parse(again.body).key, keys[0])
    })
    assert.equal(Object.keys(loadTable(file).links).length, 3)
  })

  it("표 파일 크기에도 상한이 있다(넘으면 등록 거절)", () => {
    const file = tmpTable()
    registerShortLink("adk", "a/1.md", file)
    assert.throws(() => registerShortLink("adk", "a/2.md", file, new Date(), { maxBytes: 200 }), (e) => e.code === "SHORT_LINK_TABLE_FULL")
    assert.equal(Object.keys(loadTable(file).links).length, 1)
  })

  it("대문자 키는 키 규칙 밖이라 404", async () => {
    const file = tmpTable()
    const key = registerShortLink("adk", ARCH, file)
    await withServer(file, async ({ port }) => {
      assert.equal((await request(port, { path: `/d/${key.toUpperCase()}` })).status, 404)
    })
  })

  it("서버도 점 폴더·node_modules·data-private·.md 아닌 경로는 등록을 거절한다(400)", async () => {
    const file = tmpTable()
    await withServer(file, async ({ port }) => {
      for (const p of [".agents/context/agents-rules.json", ".agents/progress/x.md", "node_modules/x.md", "a/data-private/x.md", "x.txt", "a/.hidden/b.md"]) {
        const res = await postJson(port, { source: "adk", path: p })
        assert.equal(res.status, 400, `${p} should be 400, got ${res.status}`)
      }
    })
    assert.throws(() => registerShortLink("adk", ".agents/x.md", file))
    assert.equal(fs.existsSync(file), false)
  })

  it("본문 한도는 바이트로 센다(한글 1500자 ≈ 4.5 KB 는 413)", async () => {
    const file = tmpTable()
    await withServer(file, async ({ port }) => {
      const res = await postJson(port, { source: "adk", path: "a.md", pad: "가".repeat(1500) })
      assert.equal(res.status, 413)
    })
  })

  it("깨진 표 모양이면 200 을 주지 않고 표도 덮어쓰지 않는다", async () => {
    for (const content of ['{"links":[]}', "{not json", "null", '{"version":1}']) {
      const file = tmpTable()
      fs.writeFileSync(file, content)
      await withServer(file, async ({ port }) => {
        const res = await postJson(port, { source: "adk", path: ARCH })
        assert.equal(res.status, 500, `${content} should be 500, got ${res.status}`)
      })
      assert.equal(fs.readFileSync(file, "utf8"), content)
    }
  })

  it("저장 실패 500 응답에 서버 경로를 싣지 않고 임시 파일을 남기지 않는다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "short-links-test-"))
    createdDirs.push(dir)
    const asDir = path.join(dir, "table.json")
    fs.mkdirSync(asDir)
    await withServer(asDir, async ({ port }) => {
      const res = await postJson(port, { source: "adk", path: ARCH })
      assert.equal(res.status, 500)
      assert.ok(!res.body.includes(dir), res.body)
      assert.ok(!res.body.includes("EISDIR"), res.body)
    })
    assert.throws(() => saveTable({ version: 1, links: {} }, asDir))
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp")), [])
  })

  it("입력 해석: 긴 주소·/d/ 주소·docs/ 로 시작하는 저장소 경로", () => {
    const long = parseDocTarget("http://host.example:3142/docs?tab=developer&source=adk&path=developer%2Farchitecture%2FARCHITECTURE.md")
    assert.deepEqual(long, { source: "adk", path: ARCH, origin: "http://host.example:3142" })
    assert.deepEqual(parseDocTarget(`/d/adk/${ARCH}`), { source: "adk", path: ARCH, origin: null })
    assert.deepEqual(parseDocTarget(`docs/${ARCH}`), { source: "adk", path: ARCH, origin: null })
    assert.deepEqual(parseDocTarget("guide.md", { defaultSource: "notes" }), { source: "notes", path: "guide.md", origin: null })
    assert.throws(() => parseDocTarget("docs/../secret.md"))
  })

  it("바깥 주소는 설정에서 읽는다(기기 이름을 코드에 두지 않음)", () => {
    assert.equal(publicBaseUrl({ explicit: "http://a.example:1/", env: {} }), "http://a.example:1")
    assert.equal(publicBaseUrl({ env: { NAIA_DASHBOARD_PUBLIC_URL: "http://b.example:2" } }), "http://b.example:2")
    assert.equal(publicBaseUrl({ env: { NAIA_DASHBOARD_PORT: "4000" }, tailscaleDns: "pc.tailnet.example" }), "http://pc.tailnet.example:4000")
    assert.equal(publicBaseUrl({ env: {}, tailscaleDns: "" }), "http://localhost:3142")
  })

  it("명령: node scripts/short-link.mjs <경로> 가 짧은 주소 한 줄을 내고 표에 남긴다", () => {
    const file = tmpTable()
    const env = { ...process.env, NAIA_SHORT_LINKS_FILE: file, NAIA_DASHBOARD_PUBLIC_URL: OFFLINE_BASE }
    const script = new URL("./scripts/short-link.mjs", import.meta.url).pathname
    const out = execFileSync(process.execPath, [script, `docs/${ARCH}`], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    const key = shortKeyFor("adk", ARCH)
    assert.equal(out, `${OFFLINE_BASE}/d/${key}\n`)
    assert.equal(loadTable(file).links[key].path, ARCH)
    const fromLong = execFileSync(
      process.execPath,
      [script, `${OFFLINE_BASE}/docs?tab=developer&source=adk&path=developer%2Farchitecture%2FARCHITECTURE.md`],
      { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    )
    assert.equal(fromLong, `${OFFLINE_BASE}/d/${key}\n`)
    const pathForm = execFileSync(process.execPath, [script, `docs/${ARCH}`, "--path-form"], { env, encoding: "utf8" })
    assert.equal(pathForm, `${OFFLINE_BASE}/d/adk/${ARCH}\n`)
    assert.throws(() => execFileSync(process.execPath, [script, "docs/../x.md"], { env, stdio: "pipe" }))
  })

  it("명령: 대시보드가 떠 있으면 키를 그 서버(POST /d)의 표에 남긴다(이 사본의 표가 아니라)", async () => {
    const serverFile = tmpTable()
    const localFile = tmpTable()
    const script = new URL("./scripts/short-link.mjs", import.meta.url).pathname
    const { execFile } = await import("node:child_process")
    await withServer(serverFile, async ({ port }) => {
      const base = `http://127.0.0.1:${port}`
      const out = await new Promise((resolve, reject) =>
        execFile(
          process.execPath,
          [script, `docs/${ARCH}`, "--base", base],
          { env: { ...process.env, NAIA_SHORT_LINKS_FILE: localFile }, encoding: "utf8" },
          (err, stdout, stderr) => (err ? reject(err) : resolve({ stdout, stderr })),
        ),
      )
      const key = shortKeyFor("adk", ARCH)
      assert.equal(out.stdout, `${base}/d/${key}\n`)
      assert.equal(out.stderr, "")
      assert.equal(loadTable(serverFile).links[key].path, ARCH)
      assert.equal(fs.existsSync(localFile), false)
      assert.equal((await request(port, { path: `/d/${key}` })).status, 302)
    })
  })
})

describe("startServer 공개 모드 publicOpts 전달 회귀 시험", () => {
  const TEAM = "example-test.cloudflareaccess.com"
  const AUD = "aud0123456789abcdef"
  const KID = "kid-start-1"
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" }

  function signAccessJwt(email = "Staff@Example.com") {
    const nowSec = Math.floor(Date.now() / 1000)
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: KID, typ: "JWT" })).toString("base64url")
    const payload = Buffer.from(
      JSON.stringify({ iss: `https://${TEAM}`, aud: [AUD], email, exp: nowSec + 600, nbf: nowSec - 10, iat: nowSec - 10 }),
    ).toString("base64url")
    const sig = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url")
    return `${header}.${payload}.${sig}`
  }

  function httpCall(port, { method = "GET", path: reqPath = "/", headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, method, path: reqPath, headers: { host: `127.0.0.1:${port}`, ...headers } },
        (res) => {
          let data = ""
          res.setEncoding("utf8")
          res.on("data", (c) => (data += c))
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
        },
      )
      req.on("error", reject)
      if (body) req.write(body)
      req.end()
    })
  }

  async function closeServer(srv) {
    if (!srv) return
    srv.closeAllConnections?.()
    await new Promise((resolve) => srv.close(resolve))
  }

  it("NAIA_DASHBOARD_PUBLIC=1 로 startServer 를 띄우면 토큰 없는 요청이 내부 모드로 통과하지 않고 공개 모드 403/404/405 로 차단된다", async (t) => {
    const apiCalls = []
    const api = http.createServer((req, res) => {
      apiCalls.push({ method: req.method, url: req.url, headers: { ...req.headers } })
      res.statusCode = 200
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ ok: true }))
    })
    await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve))
    const apiPort = api.address().port

    t.mock.method(globalThis, "fetch", async (url) => {
      assert.equal(String(url), `https://${TEAM}/cdn-cgi/access/certs`)
      return { ok: true, status: 200, json: async () => ({ keys: [jwk] }) }
    })

    const nextCalls = []
    let dashServer
    try {
      dashServer = await startServer(
        ["-H", "127.0.0.1", "-p", "0"],
        {
          NODE_ENV: "production",
          NAIA_DASHBOARD_PUBLIC: "1",
          NAIA_ACCESS_TEAM_DOMAIN: TEAM,
          NAIA_ACCESS_AUD: AUD,
          NAIA_API_PORT: String(apiPort),
        },
        {
          createNextApp: () => ({
            prepare: async () => {},
            getRequestHandler: () => (req, res) => {
              nextCalls.push(req.url)
              res.statusCode = 200
              res.end("next-ok")
            },
          }),
        },
      )
      const dashPort = dashServer.address().port

      // 1. 토큰 없는 /docs, /api/portal/doc 요청은 내부 모드로 통과하지 않고 403 이어야 한다.
      const unauthDocs = await httpCall(dashPort, { path: "/docs" })
      assert.equal(unauthDocs.status, 403)
      assert.equal(nextCalls.length, 0)

      const unauthApi = await httpCall(dashPort, { path: "/api/portal/doc?source=adk&path=common%2Fok.md" })
      assert.equal(unauthApi.status, 403)
      assert.equal(apiCalls.length, 0)

      const unauthShort = await httpCall(dashPort, { path: "/d/abcdef" })
      assert.equal(unauthShort.status, 403)

      // 2. 공개 모드 비허용 경로(/board)는 404, 게시 공개 API(읽기·쓰기 모두)는
      // 백엔드로 넘기기 전에 403 으로 거절된다. 쓰기 메서드 일반 경로의 405 와 다르다.
      const boardRes = await httpCall(dashPort, { path: "/board" })
      assert.equal(boardRes.status, 404)
      assert.equal(nextCalls.length, 0)

      const postPublish = await httpCall(dashPort, { method: "POST", path: "/api/portal/publish/test-post/approve" })
      assert.equal(postPublish.status, 403)
      assert.equal(apiCalls.length, 0)

      const getPublish = await httpCall(dashPort, { path: "/api/portal/publish/test-post/status" })
      assert.equal(getPublish.status, 403)
      assert.equal(apiCalls.length, 0)

      // 2b. 퍼센트 인코딩 별칭도 백엔드로 넘기기 전에 403 으로 거절된다.
      for (const p of ["/%61pi/portal/publish/status", "/api/portal/%70ublish/export", "/api/portal/%64ecisions"]) {
        const enc = await httpCall(dashPort, { path: p })
        assert.equal(enc.status, 403, p)
      }
      assert.equal(apiCalls.length, 0)

      // 3. 서명된 Access JWT 가 있으면 공개 경로(/docs, /api/portal)만 검증된 메일과 함께 통과한다.
      const jwt = signAccessJwt("Staff@Example.com")
      const authDocs = await httpCall(dashPort, { path: "/docs", headers: { "cf-access-jwt-assertion": jwt } })
      assert.equal(authDocs.status, 200)
      assert.equal(authDocs.headers["cache-control"], "private, no-store")
      assert.deepEqual(nextCalls, ["/docs"])

      const authBoard = await httpCall(dashPort, { path: "/board", headers: { "cf-access-jwt-assertion": jwt } })
      assert.equal(authBoard.status, 404)
      assert.deepEqual(nextCalls, ["/docs"])

      const authApi = await httpCall(dashPort, {
        path: "/api/portal/doc?source=adk&path=common%2Fok.md",
        headers: {
          "cf-access-jwt-assertion": jwt,
          cookie: "CF_Authorization=secret",
          "x-naia-user-email": "boss@example.com",
        },
      })
      assert.equal(authApi.status, 200)
      assert.equal(apiCalls.length, 1)
      assert.equal(apiCalls[0].headers["x-naia-user-email"], "staff@example.com")
      assert.equal(apiCalls[0].headers.cookie, undefined)
      assert.equal(apiCalls[0].headers["cf-access-jwt-assertion"], undefined)
    } finally {
      await closeServer(dashServer)
      await closeServer(api)
    }
  })

  it("공개 모드 startServer 에서도 customEnv 의 신원 머리 가드 설정(NAIA_GATE_SECRET_FILE·NAIA_NOTE_USER_HEADER)을 함께 적용한다", async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "start-public-env-"))
    const gateSecret = "gate-secret-" + crypto.randomBytes(24).toString("hex")
    const gateFile = path.join(tmpDir, "gate.key")
    fs.writeFileSync(gateFile, gateSecret, { mode: 0o600 })
    clearGateSecretCache()

    t.mock.method(globalThis, "fetch", async () => ({
      ok: true,
      status: 200,
      json: async () => ({ keys: [jwk] }),
    }))

    const capturedHeaders = []
    let dashServer
    try {
      dashServer = await startServer(
        ["-H", "127.0.0.1", "-p", "0"],
        {
          NODE_ENV: "production",
          NAIA_DASHBOARD_PUBLIC: "1",
          NAIA_ACCESS_TEAM_DOMAIN: TEAM,
          NAIA_ACCESS_AUD: AUD,
          NAIA_API_PORT: "3144",
          NAIA_GATE_SECRET_FILE: gateFile,
          NAIA_NOTE_USER_HEADER: "x-note-user",
        },
        {
          createNextApp: () => ({
            prepare: async () => {},
            getRequestHandler: () => (req, res) => {
              capturedHeaders.push({ ...req.headers })
              res.statusCode = 200
              res.end("ok")
            },
          }),
        },
      )
      const dashPort = dashServer.address().port
      const jwt = signAccessJwt("staff@example.com")

      const noJwtRes = await httpCall(dashPort, { path: "/docs" })
      assert.equal(noJwtRes.status, 403)
      assert.equal(capturedHeaders.length, 0)

      const forgedRes = await httpCall(dashPort, {
        path: "/docs",
        headers: {
          "cf-access-jwt-assertion": jwt,
          "x-note-user": "boss",
        },
      })
      assert.equal(forgedRes.status, 200)
      assert.equal(capturedHeaders.at(-1)["x-note-user"], undefined)

      const verifiedRes = await httpCall(dashPort, {
        path: "/docs",
        headers: {
          "cf-access-jwt-assertion": jwt,
          "x-naia-gate-secret": gateSecret,
          "x-note-user": "staff",
        },
      })
      assert.equal(verifiedRes.status, 200)
      assert.equal(capturedHeaders.at(-1)["x-note-user"], "staff")
      assert.equal(capturedHeaders.at(-1)["x-naia-gate-secret"], undefined)
    } finally {
      clearGateSecretCache()
      await closeServer(dashServer)
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("내부 모드 startServer 는 기존처럼 customEnv 를 유지해 게시 확인 미설정 차단과 일반 화면을 처리한다", async () => {
    const nextCalls = []
    let dashServer
    try {
      dashServer = await startServer(
        ["-H", "127.0.0.1", "-p", "0"],
        {
          NODE_ENV: "production",
          PUBLISH_GATEWAY_OVERWRITE_CONFIRMED: "0",
        },
        {
          createNextApp: () => ({
            prepare: async () => {},
            getRequestHandler: () => (req, res) => {
              nextCalls.push(req.url)
              res.statusCode = 200
              res.end("internal-ok")
            },
          }),
        },
      )
      const dashPort = dashServer.address().port

      const docsRes = await httpCall(dashPort, { path: "/docs" })
      assert.equal(docsRes.status, 200)
      assert.deepEqual(nextCalls, ["/docs"])

      const publishRes = await httpCall(dashPort, { method: "POST", path: "/api/portal/publish/test-post/approve" })
      assert.equal(publishRes.status, 403)
      assert.equal(JSON.parse(publishRes.body).code, "publish_gateway_unconfirmed")
    } finally {
      await closeServer(dashServer)
    }
  })

  it("createRequestHandler 는 NAIA_DASHBOARD_PUBLIC=1 에서 publicOpts 가 없거나 잘못되면 열리지 않고 예외를 던진다", () => {
    const noop = () => {}
    assert.throws(
      () => createRequestHandler(noop, {}, { NAIA_DASHBOARD_PUBLIC: "1" }),
      /publicOpts is required/,
    )
    assert.throws(
      () => createRequestHandler(noop, {}, {}, {}),
      /verifier\.verify is required/,
    )
  })
})

import "./identity-header-guard.test.mjs"
