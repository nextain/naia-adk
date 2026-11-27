import { describe, it, expect, vi, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createServer } from "../src/server.js"

describe("POST /api/portal/doc/create confinement", () => {
  const TEST_SECRET = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
  const WRITE_HEADERS = {
    host: "localhost:3141",
    "x-naia-proxy-secret": TEST_SECRET,
    "x-naia-peer": "127.0.0.1",
    "x-naia-local": "127.0.0.1",
    "x-naia-origin-ok": "1",
    "content-type": "application/json",
  }

  let tempRoot = ""
  let app: Awaited<ReturnType<typeof createServer>> | undefined
  afterEach(async () => {
    await app?.close()
    app = undefined
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = ""
  })

  async function start() {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adk-doc-create-"))
    fs.mkdirSync(path.join(tempRoot, "docs"), { recursive: true })
    app = await createServer({ root: tempRoot, port: 3141, host: "127.0.0.1" })
    ;(app as any).proxySecret = TEST_SECRET
  }

  const create = (docPath: string, content = "# 새 문서\n") =>
    app!.inject({
      method: "POST",
      url: `/api/portal/doc/create?source=adk&path=${encodeURIComponent(docPath)}`,
      headers: WRITE_HEADERS,
      payload: JSON.stringify({ content }),
    })

  it("creates index.md inside the docs root (201) and refuses duplicates (409)", async () => {
    await start()
    fs.mkdirSync(path.join(tempRoot, "docs", "memo"), { recursive: true })
    const res = await create("memo/index.md")
    expect(res.statusCode).toBe(201)
    expect(fs.readFileSync(path.join(tempRoot, "docs", "memo", "index.md"), "utf-8")).toBe("# 새 문서\n")
    // 같은 자리에 다시 만들면 409.
    expect((await create("memo/index.md")).statusCode).toBe(409)
  })

  it("rejects escapes, hidden parents, and non-index leaves without leaving files", async () => {
    await start()
    for (const docPath of ["../evil/index.md", "a/../../evil/index.md", ".hidden/index.md", "memo/.hidden/index.md", "memo/note.md", "memo/"]) {
      const res = await create(docPath)
      expect([400, 403, 404]).toContain(res.statusCode)
    }
    expect(fs.existsSync(path.join(tempRoot, "docs", "memo"))).toBe(false)
    expect(fs.existsSync(path.join(tempRoot, "evil"))).toBe(false)
    expect(fs.existsSync(path.join(os.tmpdir(), "evil"))).toBe(false)
  })

  it("rejects non-adk sources", async () => {
    await start()
    fs.mkdirSync(path.join(tempRoot, "docs", "memo"), { recursive: true })
    const res = await create("memo/index.md")
    expect(res.statusCode).toBe(201)
    const other = await app!.inject({
      method: "POST",
      url: `/api/portal/doc/create?source=other&path=${encodeURIComponent("memo/index.md")}`,
      headers: WRITE_HEADERS,
      payload: JSON.stringify({ content: "# x\n" }),
    })
    expect(other.statusCode).toBe(403)
  })

  it("rejects when the opened parent fd resolves outside the docs root (post-open verification)", async () => {
    await start()
    fs.mkdirSync(path.join(tempRoot, "docs", "memo"), { recursive: true })
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "adk-doc-create-outside-"))
    try {
      // 열린 폴더 설명자의 실경로 조회가 허용 뿌리 밖을 가리키는 경우를 흉내 낸다.
      // 경로 이름 조회는 그대로 두고 fd 경로(`/proc/self/fd`, `/dev/fd`)만 바꾼다.
      const native = fs.realpathSync.native
      const spy = vi.spyOn(fs.realpathSync, "native").mockImplementation(((target: any, ...rest: any[]) => {
        if (String(target).includes("/proc/self/fd/") || String(target).includes("/dev/fd/")) return outside
        return (native as any)(target, ...rest)
      }) as any)
      try {
        const res = await create("memo/index.md")
        expect(res.statusCode).toBe(403)
      } finally {
        spy.mockRestore()
      }
      expect(fs.existsSync(path.join(tempRoot, "docs", "memo", "index.md"))).toBe(false)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it("docsReadOnly rejects creation with 403 and writes nothing", async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adk-doc-create-ro-"))
    fs.mkdirSync(path.join(tempRoot, "docs"), { recursive: true })
    fs.mkdirSync(path.join(tempRoot, "config"), { recursive: true })
    fs.writeFileSync(path.join(tempRoot, "config", "dashboard.json"), JSON.stringify({ docs: { readOnly: true } }))
    app = await createServer({ root: tempRoot, port: 3141, host: "127.0.0.1" })
    ;(app as any).proxySecret = TEST_SECRET
    const res = await create("memo/index.md")
    expect(res.statusCode).toBe(403)
    expect(fs.existsSync(path.join(tempRoot, "docs", "memo"))).toBe(false)
  })
})
