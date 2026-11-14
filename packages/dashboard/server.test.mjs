import test, { describe, it } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { execSync } from "node:child_process"
import {
  buildProxyHeaders,
  validatePortalPathname,
  proxyToApi,
  createRequestHandler,
  parseArgs,
  normalizeIp,
} from "./server.mjs"

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

  function tmpTable() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "short-links-test-"))
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
