// 짧은 주소 명령 시험: 대시보드가 열 수 없는 경로 거절, --verify.
// 실행: node --test packages/dashboard/scripts/short-link.test.mjs
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { shortKeyFor } from "../short-links.mjs"
import { assertDashboardReadable, findAdkRoot, run, verifyShortLink } from "./short-link.mjs"

const SCRIPT = new URL("./short-link.mjs", import.meta.url).pathname
const BASE = "http://dash.example:3142"

function tmpAdk() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "short-link-adk-"))
  fs.writeFileSync(path.join(root, "AGENTS.md"), "x")
  for (const rel of ["docs/developer/a.md", ".agents/progress/w/r.md", "projects/p/README.md", "FORK.md"]) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), "# x\n")
  }
  return root
}

// 가짜 대시보드: POST /d 는 키 발급, GET /d/<키> 는 302, 문서 API 는 openable 에 든 경로만 200.
function fakeDashboard(openable) {
  const table = {}
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url)
    calls.push(`${init.method || "GET"} ${u.pathname}`)
    if (u.pathname === "/d" && init.method === "POST") {
      const { source, path: p } = JSON.parse(init.body)
      const key = shortKeyFor(source, p)
      table[key] = { source, path: p }
      return new Response(JSON.stringify({ key }), { status: 200, headers: { "content-type": "application/json" } })
    }
    if (u.pathname.startsWith("/d/")) {
      const segs = u.pathname.slice(3).split("/").map(decodeURIComponent)
      const hit = segs.length === 1 ? table[segs[0]] : { source: segs[0], path: segs.slice(1).join("/") }
      if (!hit) return new Response("", { status: 404 })
      const loc = `/docs?source=${encodeURIComponent(hit.source)}&path=${encodeURIComponent(hit.path)}`
      return new Response("", { status: 302, headers: { location: loc } })
    }
    if (u.pathname === "/api/portal/doc") {
      const key = `${u.searchParams.get("source")}:${u.searchParams.get("path")}`
      return openable.has(key) ? new Response("# ok", { status: 200 }) : new Response('{"error":"File not found or not markdown"}', { status: 404 })
    }
    return new Response("", { status: 404 })
  }
  return { fetchImpl, table, calls }
}

const quiet = { write() {} }

describe("짧은 주소: 대시보드가 못 여는 경로 거절", () => {
  it(".agents 같은 숨김 폴더, node_modules, data-private, .md 아닌 파일은 키를 만들지 않고 docs/ 로 옮기라고 알린다", () => {
    for (const p of [".agents/progress/w/r.md", "developer/.hidden/a.md", "a/node_modules/b.md", "data-private/x.md", "developer/a.txt", "developer/a.md./.x.md"]) {
      assert.throws(() => assertDashboardReadable({ source: "adk", path: p, input: p, root: null }), /docs\//, p)
    }
    assert.doesNotThrow(() => assertDashboardReadable({ source: "adk", path: "developer/a.md", input: "docs/developer/a.md", root: null }))
  })

  it("adk 뿌리를 알면 docs/ 밖 저장소 파일(FORK.md, projects/…)을 거절하고 docs/ 안 파일은 받는다", () => {
    const root = tmpAdk()
    for (const p of ["FORK.md", "projects/p/README.md", "./FORK.md"]) {
      const clean = p.replace(/^\.\//, "")
      assert.throws(() => assertDashboardReadable({ source: "adk", path: clean, input: p, root }), /outside docs\/.*move/, p)
    }
    assert.doesNotThrow(() => assertDashboardReadable({ source: "adk", path: "developer/a.md", input: "docs/developer/a.md", root }))
    assert.doesNotThrow(() => assertDashboardReadable({ source: "adk", path: "developer/a.md", input: "developer/a.md", root }))
    // 다른 출처는 docs/ 규칙을 적용하지 않는다
    assert.doesNotThrow(() => assertDashboardReadable({ source: "company:x", path: "FORK.md", input: "FORK.md", root }))
  })

  it("adk 뿌리 찾기: --root > NAIA_ADK_ROOT > 현재 폴더부터 위로 AGENTS.md+docs/", () => {
    const root = tmpAdk()
    assert.equal(findAdkRoot({ explicit: "/x/y", env: { NAIA_ADK_ROOT: "/z" } }), "/x/y")
    assert.equal(findAdkRoot({ env: { NAIA_ADK_ROOT: "/z" } }), "/z")
    assert.equal(findAdkRoot({ env: {}, cwd: path.join(root, "docs", "developer") }), root)
  })

  it("run: 거절이면 등록 요청(POST /d)을 보내지 않는다", async () => {
    const dash = fakeDashboard(new Set())
    await assert.rejects(
      run([".agents/progress/w/r.md", "--base", BASE], { env: {}, cwd: os.tmpdir(), fetchImpl: dash.fetchImpl, tailscaleDns: "", stderr: quiet }),
      /docs\//,
    )
    await assert.rejects(
      run([`${BASE}/docs?source=adk&path=.agents%2Fprogress%2Fx.md`], { env: {}, cwd: os.tmpdir(), fetchImpl: dash.fetchImpl, tailscaleDns: "", stderr: quiet }),
      /docs\//,
    )
    assert.deepEqual(dash.calls, [])
  })

  it("명령 줄: .agents 경로는 종료 코드 1, 표준 오류에 docs/ 안내, 표 파일을 만들지 않는다", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "short-link-table-"))
    const file = path.join(dir, "short-links.json")
    const env = { ...process.env, NAIA_SHORT_LINKS_FILE: file, NAIA_DASHBOARD_PUBLIC_URL: "http://127.0.0.1:9" }
    let err
    try {
      execFileSync(process.execPath, [SCRIPT, ".agents/progress/w/r.md"], { env, stdio: "pipe", encoding: "utf8" })
    } catch (e) {
      err = e
    }
    assert.ok(err, "should fail")
    assert.equal(err.status, 1)
    assert.match(err.stderr, /move or copy the document under docs\//)
    assert.equal(fs.existsSync(file), false)
  })
})

describe("짧은 주소: --verify", () => {
  it("문서 API 가 200 이면 짧은 주소 한 줄을 낸다", async () => {
    const dash = fakeDashboard(new Set(["adk:developer/a.md"]))
    const out = await run(["docs/developer/a.md", "--base", BASE, "--verify"], { env: {}, cwd: os.tmpdir(), fetchImpl: dash.fetchImpl, tailscaleDns: "", stderr: quiet })
    assert.equal(out, `${BASE}/d/${shortKeyFor("adk", "developer/a.md")}`)
    assert.deepEqual(dash.calls, ["POST /d", `GET /d/${shortKeyFor("adk", "developer/a.md")}`, "GET /api/portal/doc"])
  })

  it("302 는 되지만 문서 API 가 404 면 실패한다 (내용이 안 뜨는 링크)", async () => {
    const dash = fakeDashboard(new Set())
    await assert.rejects(
      run(["docs/developer/missing.md", "--base", BASE, "--verify"], { env: {}, cwd: os.tmpdir(), fetchImpl: dash.fetchImpl, tailscaleDns: "", stderr: quiet }),
      /document API answered 404/,
    )
  })

  it("verifyShortLink: 넘기지 않는 주소, 문서가 아닌 대상은 실패", async () => {
    const dash = fakeDashboard(new Set())
    await assert.rejects(verifyShortLink(`${BASE}/d/ffffff`, { fetchImpl: dash.fetchImpl }), /answered 404, not a redirect/)
    const odd = async () => new Response("", { status: 302, headers: { location: "/elsewhere" } })
    await assert.rejects(verifyShortLink(`${BASE}/d/ffffff`, { fetchImpl: odd }), /does not point at a document/)
  })

  it("--path-form 도 확인한다", async () => {
    const dash = fakeDashboard(new Set(["adk:developer/a.md"]))
    const out = await run(["docs/developer/a.md", "--base", BASE, "--path-form", "--verify"], { env: {}, cwd: os.tmpdir(), fetchImpl: dash.fetchImpl, tailscaleDns: "", stderr: quiet })
    assert.equal(out, `${BASE}/d/adk/developer/a.md`)
  })
})

describe("짧은 주소: 대시보드가 응답하지 않을 때만 표에 직접 쓴다", () => {
  const answering = (status, body) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  const tableIn = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "short-link-fb-")), "other-copy.json")

  it("대시보드가 507·500·400 으로 답하면 그 코드와 이유로 실패하고 다른 사본의 표에 쓰지 않는다", async () => {
    for (const [status, error] of [[507, "Short link table is full"], [500, "Could not save short link"], [400, "Invalid source or path"]]) {
      const file = tableIn()
      const errs = []
      await assert.rejects(
        run(["docs/developer/a.md", "--base", BASE], { env: { NAIA_SHORT_LINKS_FILE: file }, cwd: os.tmpdir(), fetchImpl: answering(status, { error }), tailscaleDns: "", stderr: { write: (x) => errs.push(x) } }),
        (err) => err.message.includes(`answered ${status}`) && err.message.includes(error),
        String(status),
      )
      assert.equal(fs.existsSync(file), false, `${status}: table written`)
      assert.equal(errs.join("").includes("directly"), false, `${status}: ${errs.join("")}`)
    }
  })

  it("200 인데 키가 없으면 실패하고 직접 쓰지 않는다", async () => {
    const file = tableIn()
    await assert.rejects(
      run(["docs/developer/a.md", "--base", BASE], { env: { NAIA_SHORT_LINKS_FILE: file }, cwd: os.tmpdir(), fetchImpl: answering(200, {}), tailscaleDns: "", stderr: quiet }),
      /without a key/,
    )
    assert.equal(fs.existsSync(file), false)
  })

  it("연결 실패·시간 초과(응답 없음)이면 표에 직접 쓰고 표준 오류에 알린다", async () => {
    const refused = async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }) }
    const timeout = async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError") }
    for (const fetchImpl of [refused, timeout]) {
      const file = tableIn()
      const errs = []
      const out = await run(["docs/developer/a.md", "--base", BASE], { env: { NAIA_SHORT_LINKS_FILE: file }, cwd: os.tmpdir(), fetchImpl, tailscaleDns: "", stderr: { write: (x) => errs.push(x) } })
      assert.equal(out, `${BASE}/d/${shortKeyFor("adk", "developer/a.md")}`)
      assert.ok(JSON.parse(fs.readFileSync(file, "utf8")).links[shortKeyFor("adk", "developer/a.md")])
      assert.match(errs.join(""), /directly/)
    }
  })

  it("명령 줄: 507 이면 종료 코드 1, 표준 출력 비움", async () => {
    const http = await import("node:http")
    const server = http.createServer((req, res) => { res.statusCode = 507; res.setHeader("content-type", "application/json"); res.end('{"error":"Short link table is full"}') })
    await new Promise((r) => server.listen(0, "127.0.0.1", r))
    const file = tableIn()
    try {
      const { spawn } = await import("node:child_process")
      const child = spawn(process.execPath, [SCRIPT, "docs/developer/a.md", "--base", `http://127.0.0.1:${server.address().port}`], { env: { ...process.env, NAIA_SHORT_LINKS_FILE: file }, cwd: os.tmpdir() })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (c) => (stdout += c))
      child.stderr.on("data", (c) => (stderr += c))
      const code = await new Promise((r) => child.on("close", r))
      assert.equal(code, 1)
      assert.equal(stdout, "")
      assert.match(stderr, /answered 507.*Short link table is full/)
      assert.equal(fs.existsSync(file), false)
    } finally {
      server.close()
    }
  })
})
