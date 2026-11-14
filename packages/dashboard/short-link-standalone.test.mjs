// 문서 짧은 주소: naia-adk 만 설치한 상태에서 /d/<키> 가 문서를 여는지 끝까지 본다.
// 진짜 포털 API(packages/server)와 대시보드 요청 처리기(server.mjs)를 띄우고,
// 키 발급(POST /d) → /d/<키> 302 → 넘겨 준 출처·경로로 문서 API(/api/portal/doc) 200 을 확인한다.
// 실행: node --import tsx --test short-link-standalone.test.mjs
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

const DOC = "guides/hello.md"
const DOC_BODY = "# Hello short link\n\nopened through /d/\n"

describe("naia-adk 단독 설치: /d/<키> 가 문서를 연다", () => {
  let tmp
  let api
  let dash
  let dashBase
  let tableFile
  const saved = {}

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "short-link-standalone-"))
    const ws = path.join(tmp, "ws")
    fs.mkdirSync(path.join(ws, "docs", "guides"), { recursive: true })
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "# test workspace\n")
    fs.writeFileSync(path.join(ws, "docs", DOC), DOC_BODY)
    tableFile = path.join(tmp, "short-links.json")
    for (const k of ["XDG_RUNTIME_DIR", "NAIA_API_PORT", "NAIA_SHORT_LINKS_FILE"]) saved[k] = process.env[k]
    // 포털 API 와 대시보드가 같은 프록시 비밀 폴더를 보게 한다(이 시험만의 폴더).
    process.env.XDG_RUNTIME_DIR = path.join(tmp, "xdg")
    fs.mkdirSync(process.env.XDG_RUNTIME_DIR, { recursive: true })

    const { createServer } = await import("../server/src/server.ts")
    api = await createServer({ root: ws, port: 0, host: "127.0.0.1" })
    api.log.level = "silent"
    await api.listen({ port: 0, host: "127.0.0.1" })
    process.env.NAIA_API_PORT = String(api.server.address().port)

    const { createRequestHandler, clearProxySecretCache } = await import("./server.mjs")
    clearProxySecretCache()
    const tabs = await import("./app/docs/tabs.ts")
    const tabFor = (source, docPath) => tabs.tabOfDoc(source, docPath).tab
    const handler = createRequestHandler((req, res) => {
      res.statusCode = 200
      res.end("next")
    }, { tableFile, tabFor })
    dash = http.createServer(handler)
    await new Promise((r) => dash.listen(0, "127.0.0.1", r))
    dashBase = `http://127.0.0.1:${dash.address().port}`
  })

  after(async () => {
    await new Promise((r) => dash?.close(r))
    await api?.close()
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("POST /d 로 받은 키를 열면 문서 화면 주소로 넘기고, 그 문서를 문서 API 가 내준다", async () => {
    const reg = await fetch(`${dashBase}/d`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: dashBase },
      body: JSON.stringify({ source: "adk", path: DOC }),
    })
    assert.equal(reg.status, 200)
    const { key, path: shortPath } = await reg.json()
    assert.match(key, /^[0-9a-f]{6,16}$/)
    assert.equal(shortPath, `/d/${key}`)

    const hop = await fetch(`${dashBase}${shortPath}`, { redirect: "manual" })
    assert.equal(hop.status, 302)
    const location = hop.headers.get("location")
    const target = new URL(location, dashBase)
    assert.equal(target.pathname, "/docs")
    assert.equal(target.searchParams.get("source"), "adk")
    assert.equal(target.searchParams.get("path"), DOC)
    assert.ok(target.searchParams.get("tab"), "탭 규칙에서 탭을 붙인다")

    const doc = await fetch(
      `${dashBase}/api/portal/doc?source=${encodeURIComponent("adk")}&path=${encodeURIComponent(DOC)}`,
    )
    assert.equal(doc.status, 200)
    assert.match(await doc.text(), /Hello short link/)
  })

  it("명령(scripts/short-link.mjs --verify)도 이 대시보드에 키를 남기고 문서 API 200 까지 확인한다", async () => {
    const script = new URL("./scripts/short-link.mjs", import.meta.url).pathname
    const out = await new Promise((resolve, reject) =>
      execFile(
        process.execPath,
        [script, `docs/${DOC}`, "--base", dashBase, "--verify"],
        { env: { ...process.env, NAIA_SHORT_LINKS_FILE: path.join(tmp, "unused.json") }, encoding: "utf8" },
        (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve({ stdout, stderr })),
      ),
    )
    assert.match(out.stdout, new RegExp(`^${dashBase}/d/[0-9a-f]{6}\\n$`))
    assert.equal(out.stderr, "")
    assert.equal(fs.existsSync(path.join(tmp, "unused.json")), false)
  })

  it("없는 문서의 키는 넘겨도 문서 API 가 404 라서 --verify 가 실패한다", async () => {
    const script = new URL("./scripts/short-link.mjs", import.meta.url).pathname
    const res = await new Promise((resolve) =>
      execFile(
        process.execPath,
        [script, "docs/guides/missing.md", "--base", dashBase, "--verify"],
        { env: process.env, encoding: "utf8" },
        (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stderr }),
      ),
    )
    assert.equal(res.code, 1)
    assert.match(res.stderr, /document API answered 404/)
  })
})
