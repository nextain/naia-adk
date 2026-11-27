import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import {
  createAccessVerifier,
  classifyPublicPath,
  isBlockedDecisionsPath,
  isBlockedPublishPath,
  isUnsafePublicPath,
  normalizeBlockedPathname,
  publicConfigFromEnv,
  normalizeTeamDomain,
  parseAudiences,
} from "./public-access.mjs"
import { buildProxyHeaders, createRequestHandler, publicApiPort } from "./server.mjs"

// 공개 모드 앞문: 서명된 신원 토큰 검증, 열 경로, 머리글 정리를 확인한다.

const TEAM = "example-test.cloudflareaccess.com"
const AUD = "aud0123456789abcdef"
const KID = "kid-1"
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" }

function b64(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url")
}

function sign(payload, { header = {}, key = privateKey, alg = "RS256" } = {}) {
  const h = b64({ alg, kid: KID, typ: "JWT", ...header })
  const p = b64(payload)
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${h}.${p}`), key).toString("base64url")
  return `${h}.${p}.${sig}`
}

const nowMs = 1_800_000_000_000
const nowSec = nowMs / 1000
const good = { iss: `https://${TEAM}`, aud: [AUD], email: "Staff@Example.com", exp: nowSec + 600, nbf: nowSec - 10, iat: nowSec - 10 }

function makeVerifier(extra = {}) {
  let calls = 0
  const v = createAccessVerifier({
    teamDomain: TEAM,
    audiences: [AUD],
    fetchKeys: async () => {
      calls += 1
      return { keys: [jwk] }
    },
    now: () => nowMs,
    ...extra,
  })
  return { v, calls: () => calls }
}

describe("신원 토큰 검증기", () => {
  it("맞는 토큰은 소문자 메일을 돌려준다", async () => {
    const { v } = makeVerifier()
    assert.deepEqual(await v.verify(sign(good)), { ok: true, email: "staff@example.com" })
    assert.equal(v.certsUrl, `https://${TEAM}/cdn-cgi/access/certs`)
  })

  it("만료·시작 전·발급자·대상 값·메일 없음은 거부한다", async () => {
    const { v } = makeVerifier()
    assert.equal((await v.verify(sign({ ...good, exp: nowSec - 120 }))).reason, "expired")
    assert.equal((await v.verify(sign({ ...good, nbf: nowSec + 600 }))).reason, "not yet valid")
    assert.equal((await v.verify(sign({ ...good, iss: "https://evil.cloudflareaccess.com" }))).reason, "bad issuer")
    assert.equal((await v.verify(sign({ ...good, aud: ["other-aud-000000"] }))).reason, "bad audience")
    assert.equal((await v.verify(sign({ ...good, email: undefined }))).reason, "no email")
    assert.equal((await v.verify(sign({ ...good, exp: undefined }))).reason, "expired")
  })

  it("다른 키 서명·서명 바꿔치기·alg none·HS256·모르는 키는 거부한다", async () => {
    const { v } = makeVerifier()
    assert.equal((await v.verify(sign(good, { key: other.privateKey }))).reason, "bad signature")
    const t = sign(good)
    const [h, , s] = t.split(".")
    assert.equal((await v.verify(`${h}.${b64({ ...good, email: "boss@example.com" })}.${s}`)).reason, "bad signature")
    assert.equal((await v.verify(`${b64({ alg: "none", kid: KID })}.${b64(good)}.`)).ok, false)
    assert.equal((await v.verify(`${b64({ alg: "none", kid: KID })}.${b64(good)}.AAAA`)).reason, "bad alg")
    assert.equal((await v.verify(sign(good, { header: { alg: "HS256" } }))).reason, "bad alg")
    assert.equal((await v.verify(sign(good, { header: { kid: "kid-unknown" } }))).reason, "unknown key")
    assert.equal((await v.verify("")).reason, "no token")
    assert.equal((await v.verify(undefined)).reason, "no token")
    assert.equal((await v.verify("a.b")).reason, "malformed")
    assert.equal((await v.verify("x".repeat(9000))).reason, "token too large")
  })

  it("공개 키는 기억해 두고, 모르는 키라도 30초 안에는 다시 받지 않는다", async () => {
    const { v, calls } = makeVerifier()
    await v.verify(sign(good))
    await v.verify(sign(good))
    assert.equal(calls(), 1)
    await v.verify(sign(good, { header: { kid: "kid-x" } }))
    await v.verify(sign(good, { header: { kid: "kid-y" } }))
    assert.equal(calls(), 1)
  })

  it("공개 키를 못 받으면 거부한다", async () => {
    const v = createAccessVerifier({ teamDomain: TEAM, audiences: [AUD], fetchKeys: async () => { throw new Error("down") }, now: () => nowMs })
    assert.equal((await v.verify(sign(good))).reason, "unknown key")
  })

  it("설정 값 검사", () => {
    assert.equal(normalizeTeamDomain("https://Example.cloudflareaccess.com/"), "example.cloudflareaccess.com")
    assert.equal(normalizeTeamDomain("evil.com/path"), null)
    assert.deepEqual(parseAudiences(" abcdefgh12 , short, "), ["abcdefgh12"])
    assert.throws(() => createAccessVerifier({ teamDomain: TEAM, audiences: [] }))
    assert.equal(publicConfigFromEnv({}, "127.0.0.1"), null)
    assert.throws(() => publicConfigFromEnv({ NAIA_DASHBOARD_PUBLIC: "1", NAIA_ACCESS_TEAM_DOMAIN: TEAM, NAIA_ACCESS_AUD: AUD }, "0.0.0.0"))
    assert.throws(() => publicConfigFromEnv({ NAIA_DASHBOARD_PUBLIC: "1", NAIA_ACCESS_AUD: AUD }, "127.0.0.1"))
    assert.throws(() => publicConfigFromEnv({ NAIA_DASHBOARD_PUBLIC: "1", NAIA_ACCESS_TEAM_DOMAIN: TEAM }, "127.0.0.1"))
    // 문서 서버 포트가 없거나 내부 문서 서버(3141)면 기동 거부
    assert.throws(() => publicConfigFromEnv({ NAIA_DASHBOARD_PUBLIC: "1", NAIA_ACCESS_TEAM_DOMAIN: TEAM, NAIA_ACCESS_AUD: AUD }, "127.0.0.1"), /NAIA_API_PORT/)
    assert.throws(() => publicConfigFromEnv({ NAIA_DASHBOARD_PUBLIC: "1", NAIA_ACCESS_TEAM_DOMAIN: TEAM, NAIA_ACCESS_AUD: AUD, NAIA_API_PORT: "3141" }, "127.0.0.1"), /3141/)
    assert.deepEqual(
      publicConfigFromEnv({ NAIA_DASHBOARD_PUBLIC: "1", NAIA_ACCESS_TEAM_DOMAIN: TEAM, NAIA_ACCESS_AUD: AUD, NAIA_API_PORT: "3144" }, "127.0.0.1"),
      { teamDomain: TEAM, audiences: [AUD], apiPort: 3144 },
    )
  })

  it("공개 모드 문서 서버 포트는 내부 3141 로 기본값을 잡지 않는다", () => {
    const prev = process.env.NAIA_API_PORT
    try {
      delete process.env.NAIA_API_PORT
      assert.equal(publicApiPort({}), null)
      assert.equal(publicApiPort({ apiPort: 3141 }), null)
      assert.equal(publicApiPort({ apiPort: 3144 }), 3144)
      process.env.NAIA_API_PORT = "3141"
      assert.equal(publicApiPort({}), null)
    } finally {
      if (prev === undefined) delete process.env.NAIA_API_PORT
      else process.env.NAIA_API_PORT = prev
    }
  })

  it("결재 보관함은 공개 허용 목록에 없다", () => {
    assert.equal(classifyPublicPath("/api/portal/decisions"), null)
    assert.equal(classifyPublicPath("/api/portal/decisions/"), null)
    assert.equal(classifyPublicPath("/API/PORTAL/DECISIONS"), null)
    assert.equal(classifyPublicPath("/api/portal/decisions/approval%3Am1/resolve"), null)
  })

  it("게시 공개 API는 공개 허용 목록에 없다", () => {
    for (const p of [
      "/api/portal/publish",
      "/api/portal/publish/",
      "/API/PORTAL/PUBLISH",
      "/api/portal/publish/test-post/status",
      "/api/portal/publish/test-post/preview?review_id=review&revision_id=revision",
      "/api/portal/publish/test-post/approve",
      "/api/portal/publish/review-todos",
      "/api/portal/publish/operations/op-test",
    ]) {
      assert.equal(isBlockedPublishPath(p), true, p)
      assert.equal(classifyPublicPath(p), null, p)
    }
    assert.equal(isBlockedPublishPath("/api/portal/decisions"), false)
    assert.equal(isBlockedPublishPath("/api/portal/doc"), false)
  })

  it("인코딩 별칭도 게시·결재 차단 판정에서 막는다", () => {
    for (const p of [
      "/%61pi/portal/publish/status",
      "/api/portal/%70ublish/export",
      "/api/portal/%70ublish/export-queue",
      "/api/portal/publish%2fstatus",
      "/api/portal/publish%2Fstatus",
      "/api/portal//publish//status",
      "/%41%50%49/portal/publish/status",
      "/api/portal/%64ecisions",
      "/%61pi/portal/decisions",
      "/api/portal/decisions/%61pproval%3Am1/resolve",
    ]) {
      assert.equal(isBlockedPublishPath(p) || isBlockedDecisionsPath(p), true, p)
      assert.equal(classifyPublicPath(p), null, p)
    }
    // 게시 별칭은 결재 판정에, 결재 별칭은 게시 판정에 걸리지 않는다.
    assert.equal(isBlockedDecisionsPath("/api/portal/%70ublish/status"), false)
    assert.equal(isBlockedPublishPath("/api/portal/%64ecisions"), false)
    assert.equal(isBlockedPublishPath("/api/portal/publisher"), false)
    assert.equal(isBlockedDecisionsPath("/api/portal/decisions-note"), false)
    // 풀 수 없는 % 표기는 막힌 것으로 친다(fail closed).
    assert.equal(normalizeBlockedPathname("/api/portal/publish/%zz"), null)
    assert.equal(isBlockedPublishPath("/api/portal/publish/%zz"), true)
    assert.equal(isBlockedDecisionsPath("/api/portal/decisions/%zz"), true)
    assert.equal(isBlockedPublishPath("/docs/%zz"), true)
    assert.equal(classifyPublicPath("/docs/%zz"), null)
  })

  it("열 경로 분류 (메신저 등 내부 경로 차단 포함)", () => {
    assert.equal(classifyPublicPath("/"), "redirect-docs")
    assert.equal(classifyPublicPath("/docs"), "next")
    assert.equal(classifyPublicPath("/_next/static/chunks/a.js"), "next")
    assert.equal(classifyPublicPath("/api/portal/doc"), "api")
    assert.equal(classifyPublicPath("/d/abc123"), "short")
    assert.equal(classifyPublicPath("/api/portal/messenger"), null)
    assert.equal(classifyPublicPath("/api/portal/messenger/channels"), null)
    assert.equal(classifyPublicPath("/messages"), null)
    for (const p of [
      "/_next/static/../board",
      "/_next/static/%2e%2e/board",
      "/_next/static/%2E%2E/%2E%2E/board",
      "/_next/static/..%2fboard",
      "/_next/static/..%5cboard",
      "/_next/static\\..\\board",
      "/_next/static//x.js",
      "/_next/static/./x.js",
      "/_next/static/%zz",
      "/docs/../board",
      "//docs",
      "/d/../board",
      "/d/adk/%2e%2e/x.md",
      "/api/portal/../../board",
    ]) {
      assert.equal(classifyPublicPath(p), null, p)
    }
    assert.equal(isUnsafePublicPath("/docs/"), false)
    assert.equal(isUnsafePublicPath("/d/adk/%EA%B0%80.md"), false)
    for (const p of ["/board", "/board/x", "/settings", "/workspace", "/skills", "/work", "/schedule", "/decisions", "/docsx", "/_next/image", "/api/other", "/d"]) {
      assert.equal(classifyPublicPath(p), null, p)
    }
  })
})

describe("머리글 정리", () => {
  const sock = { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" }
  const req = {
    method: "GET",
    headers: {
      host: "portal.example.com",
      cookie: "CF_Authorization=abc",
      "cf-access-authenticated-user-email": "boss@example.com",
      "Cf-Access-Jwt-Assertion": "token",
      "x-naia-user-email": "boss@example.com",
    },
  }

  it("내부 모드에서도 cf-access-* 와 x-naia-* 는 API 로 넘기지 않는다", () => {
    const h = buildProxyHeaders(req, sock, "s", 3141)
    assert.equal(h["cf-access-authenticated-user-email"], undefined)
    assert.equal(h["Cf-Access-Jwt-Assertion"], undefined)
    assert.equal(h["x-naia-user-email"], undefined)
    assert.equal(h.cookie, "CF_Authorization=abc")
  })

  it("공개 모드는 검증한 메일만 붙이고 쿠키를 뺀다", () => {
    const h = buildProxyHeaders({ ...req, method: "POST", headers: { ...req.headers, origin: "http://portal.example.com" } }, sock, "s", 3144, { email: "staff@example.com" })
    assert.equal(h["x-naia-user-email"], "staff@example.com")
    assert.equal(h.cookie, undefined)
    assert.equal(h["x-naia-origin-ok"], undefined)
  })

  it("내부 모드 쓰기(PUT)는 같은 출처면 예전처럼 origin-ok 를 붙인다", () => {
    const put = { ...req, method: "PUT", headers: { ...req.headers, host: "127.0.0.1:3142", origin: "http://127.0.0.1:3142" } }
    assert.equal(buildProxyHeaders(put, sock, "s", 3141)["x-naia-origin-ok"], "1")
    const cross = { ...put, headers: { ...put.headers, origin: "http://evil.example.com" } }
    assert.equal(buildProxyHeaders(cross, sock, "s", 3141)["x-naia-origin-ok"], undefined)
  })
})

describe("공개 모드 처리기", () => {
  let api
  let apiPort
  let apiCalls = []
  let server
  let port
  let nextCalls = []
  let prevApiPort
  let prevHosts
  let tmpDir

  before(async () => {
    prevApiPort = process.env.NAIA_API_PORT
    prevHosts = process.env.NAIA_DASHBOARD_HOSTS
    process.env.NAIA_DASHBOARD_HOSTS = "portal.example.com"
    api = http.createServer((req, res) => {
      apiCalls.push({ url: req.url, method: req.method, headers: req.headers })
      if (req.url.startsWith("/api/portal/access-check?")) {
        // 흉내: common/ok.md 만 읽을 수 있다
        const u = new URL(req.url, "http://x")
        res.statusCode = u.searchParams.get("source") === "adk" && u.searchParams.get("path") === "common/ok.md" ? 204 : 404
        return res.end()
      }
      res.setHeader("content-type", "application/json")
      res.end("{\"ok\":true}")
    })
    await new Promise((r) => api.listen(0, "127.0.0.1", r))
    apiPort = api.address().port
    process.env.NAIA_API_PORT = String(apiPort)

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "public-handler-test-"))
    const tableFile = path.join(tmpDir, "short-links.json")
    fs.writeFileSync(tableFile, JSON.stringify({ version: 1, links: { abc123: { source: "adk", path: "common/ok.md" }, sec456: { source: "adk", path: "common/alpha/secret.md" } } }))
    const { v } = makeVerifier()
    const handler = createRequestHandler((req, res) => {
      nextCalls.push(req.url)
      // Next 가 스스로 cache-control 을 붙여도 공개 모드 값이 남아야 한다
      res.setHeader("cache-control", "public, max-age=3600")
      res.statusCode = 200
      res.end("next")
    }, { tableFile }, { verifier: v })
    server = http.createServer(handler)
    await new Promise((r) => server.listen(0, "127.0.0.1", r))
    port = server.address().port
  })

  after(async () => {
    await new Promise((r) => server.close(r))
    await new Promise((r) => api.close(r))
    if (prevApiPort === undefined) delete process.env.NAIA_API_PORT
    else process.env.NAIA_API_PORT = prevApiPort
    if (prevHosts === undefined) delete process.env.NAIA_DASHBOARD_HOSTS
    else process.env.NAIA_DASHBOARD_HOSTS = prevHosts
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function request({ method = "GET", path: p, headers = {} }) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: { host: "portal.example.com", ...headers } }, (res) => {
        let data = ""
        res.setEncoding("utf8")
        res.on("data", (c) => (data += c))
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
      })
      req.on("error", reject)
      req.end()
    })
  }

  const auth = () => ({ "cf-access-jwt-assertion": sign(good) })

  it("토큰이 없거나 틀리면 403, 서명 없는 메일 머리글은 소용없다", async () => {
    assert.equal((await request({ path: "/docs" })).status, 403)
    assert.equal((await request({ path: "/docs", headers: { "cf-access-authenticated-user-email": "staff@example.com" } })).status, 403)
    assert.equal((await request({ path: "/api/portal", headers: { "x-naia-user-email": "staff@example.com" } })).status, 403)
    assert.equal((await request({ path: "/docs", headers: { "cf-access-jwt-assertion": sign(good, { key: other.privateKey }) } })).status, 403)
    assert.equal(nextCalls.length, 0)
    assert.equal(apiCalls.length, 0)
  })

  it("결재 보관함은 읽기·쓰기 모두 403이며 백엔드로 넘기지 않는다", async () => {
    const before = apiCalls.length
    for (const p of [
      "/api/portal/decisions",
      "/api/portal/decisions/",
      "/API/PORTAL/DECISIONS",
      "/api/portal/decisions/approval%3Am1/resolve",
      "/api/portal/decisions/note%3A1/resolve",
    ]) {
      assert.equal((await request({ path: p, headers: auth() })).status, 403, `GET ${p}`)
      for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
        assert.equal((await request({ method: m, path: p, headers: auth() })).status, 403, `${m} ${p}`)
      }
      assert.equal((await request({ method: "HEAD", path: p, headers: auth() })).status, 403, `HEAD ${p}`)
    }
    assert.equal(apiCalls.length, before)
  })

  it("게시 공개 API는 읽기·쓰기 모두 403이며 백엔드로 넘기지 않는다", async () => {
    const before = apiCalls.length
    for (const p of [
      "/api/portal/publish",
      "/api/portal/publish/",
      "/API/PORTAL/PUBLISH",
      "/api/portal/publish/test-post/status",
      "/api/portal/publish/test-post/preview?review_id=review&revision_id=revision",
      "/api/portal/publish/test-post/request-review",
      "/api/portal/publish/test-post/approve",
      "/api/portal/publish/review-todos",
      "/api/portal/publish/operations/op-test",
    ]) {
      assert.equal((await request({ path: p, headers: auth() })).status, 403, `GET ${p}`)
      for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
        assert.equal((await request({ method: m, path: p, headers: auth() })).status, 403, `${m} ${p}`)
      }
      assert.equal((await request({ method: "HEAD", path: p, headers: auth() })).status, 403, `HEAD ${p}`)
    }
    for (const call of apiCalls.slice(before)) {
      assert.ok(!call.url.startsWith("/api/portal/publish"), `백엔드로 넘어가면 안 된다: ${call.url}`)
    }
    assert.equal(apiCalls.length, before)
  })

  it("인코딩된 게시·결재 별칭도 403이며 백엔드로 넘기지 않는다", async () => {
    const before = apiCalls.length
    for (const p of [
      "/%61pi/portal/publish/status",
      "/api/portal/%70ublish/export",
      "/api/portal/%70ublish/export-queue",
      "/api/portal/publish%2fstatus",
      "/api/portal/%64ecisions",
      "/%61pi/portal/decisions",
      "/api/portal/decisions/%61pproval%3Am1/resolve",
    ]) {
      assert.equal((await request({ path: p, headers: auth() })).status, 403, `GET ${p}`)
      for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
        assert.equal((await request({ method: m, path: p, headers: auth() })).status, 403, `${m} ${p}`)
      }
      assert.equal((await request({ method: "HEAD", path: p, headers: auth() })).status, 403, `HEAD ${p}`)
    }
    assert.equal(apiCalls.length, before)
  })

  it("보드·설정·메신저 등 다른 길은 404, 쓰기 방법은 405, 낯선 Host 는 421", async () => {
    for (const p of ["/board", "/board/api", "/settings", "/workspace", "/skills", "/work", "/messages", "/api/portal/messenger/channels"]) {
      assert.equal((await request({ path: p, headers: auth() })).status, 404, p)
    }
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.equal((await request({ method: m, path: "/api/portal/doc", headers: auth() })).status, 405, m)
    }
    assert.equal((await request({ method: "POST", path: "/d", headers: auth() })).status, 405)
    assert.equal((await request({ path: "/docs", headers: { ...auth(), host: "evil.example.com" } })).status, 421)
  })

  it("뿌리는 /docs 로 넘기고, 문서 화면은 Next 로 간다", async () => {
    const r = await request({ path: "/", headers: auth() })
    assert.equal(r.status, 302)
    assert.equal(r.headers.location, "/docs")
    const d = await request({ path: "/docs?source=adk", headers: auth() })
    assert.equal(d.status, 200)
    assert.equal(d.headers["cache-control"], "private, no-store")
    assert.equal(nextCalls.at(-1), "/docs?source=adk")
  })

  it("API 로는 검증한 메일만 넘기고 꾸민 머리글·쿠키는 버린다", async () => {
    const r = await request({
      path: "/api/portal/doc?source=adk&path=common%2Fok.md",
      headers: {
        ...auth(),
        cookie: "CF_Authorization=zzz",
        "x-naia-user-email": "boss@example.com",
        "x-naia-proxy-secret": "forged",
        "x-naia-origin-ok": "1",
        "cf-access-authenticated-user-email": "boss@example.com",
      },
    })
    assert.equal(r.status, 200)
    assert.equal(r.headers["cache-control"], "private, no-store")
    const call = apiCalls.at(-1)
    assert.equal(call.url, "/api/portal/doc?source=adk&path=common%2Fok.md")
    assert.equal(call.headers["x-naia-user-email"], "staff@example.com")
    assert.notEqual(call.headers["x-naia-proxy-secret"], "forged")
    assert.equal(call.headers["x-naia-origin-ok"], undefined)
    assert.equal(call.headers.cookie, undefined)
    assert.equal(call.headers["cf-access-authenticated-user-email"], undefined)
    assert.equal(call.headers["cf-access-jwt-assertion"], undefined)
  })

  it("짧은 주소는 토큰이 있을 때만 넘겨 준다", async () => {
    assert.equal((await request({ path: "/d/abc123" })).status, 403)
    const r = await request({ path: "/d/abc123", headers: auth() })
    assert.equal(r.status, 302)
    assert.match(r.headers.location, /^\/docs\?/)
    const call = apiCalls.at(-1)
    assert.match(call.url, /^\/api\/portal\/access-check\?source=adk&path=common%2Fok\.md$/)
    assert.equal(call.headers["x-naia-user-email"], "staff@example.com")
  })

  it("권한 밖 문서의 짧은 주소는 넘길 주소 없이 404, 없는 키와 구별되지 않는다", async () => {
    for (const p of ["/d/sec456", "/d/adk/common/alpha/secret.md", "/d/zzzzzz", "/d/"]) {
      const r = await request({ path: p, headers: auth() })
      assert.equal(r.status, 404, p)
      assert.equal(r.headers.location, undefined, p)
      assert.equal(r.body, "Short link not found", p)
    }
    // 돌아가는 경로는 신원 확인 전에 일반 404
    const bad = await request({ path: "/d/adk/%2e%2e/x.md", headers: auth() })
    assert.equal(bad.status, 404)
    assert.equal(bad.headers.location, undefined)
  })

  it("정적 접두 뒤로 돌아가는 경로는 Next 에 닿지 않는다", async () => {
    const before = nextCalls.length
    for (const p of ["/_next/static/../board", "/_next/static/%2e%2e/board", "/_next/static/..%2fboard", "/_next/static/%5c..%5cboard", "/docs/../settings"]) {
      assert.equal((await request({ path: p, headers: auth() })).status, 404, p)
    }
    assert.equal(nextCalls.length, before)
    const ok = await request({ path: "/_next/static/chunks/app-1a2b.js", headers: auth() })
    assert.equal(ok.status, 200)
    assert.equal(ok.headers["cache-control"], "public, max-age=31536000, immutable")
  })

  it("HEAD 는 받고, Next 가 붙인 cache-control 은 공개 모드 값으로 덮인다", async () => {
    const h = await request({ method: "HEAD", path: "/docs", headers: auth() })
    assert.equal(h.status, 200)
    assert.equal(h.headers["cache-control"], "private, no-store")
  })
})
