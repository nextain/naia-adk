import { describe, it, expect, beforeAll, afterAll } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import { createServer } from "../src/server.js"

describe("W1d Hardlink Guard: nlink > 1 정규 파일 완전 차단", () => {
  let tempRoot: string
  let outsideDir: string
  let app: Awaited<ReturnType<typeof createServer>>
  let docsDir: string

  const outsideMdContent = "# 바깥 비밀 문서 내용 EXCRET_MD_BODY"
  const outsidePngContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x99, 0x88, 0x77])
  const normalMdContent = "# 정상 문서 내용 NORMAL_MD_BODY"

  const TEST_SECRET = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
  const TRUSTED_HEADERS = {
    host: "localhost:3141",
    "x-naia-proxy-secret": TEST_SECRET,
    "x-naia-peer": "127.0.0.1",
    "x-naia-local": "127.0.0.1",
    "x-naia-origin-ok": "1",
  }

  beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adk-hl-root-"))
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "adk-hl-outside-"))

    docsDir = path.join(tempRoot, "docs")
    fs.mkdirSync(docsDir, { recursive: true })

    // 바깥 폐기용 파일 생성
    const extMdPath = path.join(outsideDir, "ext-secret.md")
    const extPngPath = path.join(outsideDir, "ext-secret.png")
    fs.writeFileSync(extMdPath, outsideMdContent, "utf-8")
    fs.writeFileSync(extPngPath, outsidePngContent)

    // 안쪽 정상 문서 생성 (nlink === 1)
    fs.writeFileSync(path.join(docsDir, "normal.md"), normalMdContent, "utf-8")

    // 안쪽 하드 링크 파일 생성 (md, png)
    fs.linkSync(extMdPath, path.join(docsDir, "hardlink.md"))
    fs.linkSync(extPngPath, path.join(docsDir, "hardlink.png"))

    // 하드 링크를 가리키는 안쪽 심볼릭 링크 생성 (md, png)
    fs.symlinkSync(path.join(docsDir, "hardlink.md"), path.join(docsDir, "sym-hardlink.md"))
    fs.symlinkSync(path.join(docsDir, "hardlink.png"), path.join(docsDir, "sym-hardlink.png"))

    app = await createServer({
      root: tempRoot,
      port: 3141,
      host: "127.0.0.1",
    })
    ;(app as any).proxySecret = TEST_SECRET
  })

  afterAll(async () => {
    try {
      // 링크 해제 (unlink만 사용)
      try { fs.unlinkSync(path.join(docsDir, "sym-hardlink.md")) } catch {}
      try { fs.unlinkSync(path.join(docsDir, "sym-hardlink.png")) } catch {}
      try { fs.unlinkSync(path.join(docsDir, "hardlink.md")) } catch {}
      try { fs.unlinkSync(path.join(docsDir, "hardlink.png")) } catch {}
      try { fs.unlinkSync(path.join(docsDir, "normal.md")) } catch {}
      try { fs.unlinkSync(path.join(outsideDir, "ext-secret.md")) } catch {}
      try { fs.unlinkSync(path.join(outsideDir, "ext-secret.png")) } catch {}

      fs.rmSync(tempRoot, { recursive: true, force: true })
      fs.rmSync(outsideDir, { recursive: true, force: true })
    } catch {}
    await app.close()
  })

  it("GET /doc: 하드 링크 문서는 404이고 바깥 내용이 응답에 없다", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/portal/doc?source=adk&path=hardlink.md",
      headers: TRUSTED_HEADERS,
    })
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain("EXCRET_MD_BODY")
  })

  it("GET /text: 하드 링크 파일은 404이고 바깥 내용이 응답에 없다", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/portal/text?source=adk&path=hardlink.md",
      headers: TRUSTED_HEADERS,
    })
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain("EXCRET_MD_BODY")
  })

  it("GET /asset: 하드 링크 이미지는 404이고 바깥 바이트가 응답에 없다", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/portal/asset?source=adk&path=hardlink.png",
      headers: TRUSTED_HEADERS,
    })
    expect(res.statusCode).toBe(404)
    expect(res.rawPayload.includes(outsidePngContent)).toBe(false)
  })

  it("하드 링크를 가리키는 심볼릭 링크도 /doc, /asset에서 404이고 바깥 내용이 없다", async () => {
    const docRes = await app.inject({
      method: "GET",
      url: "/api/portal/doc?source=adk&path=sym-hardlink.md",
      headers: TRUSTED_HEADERS,
    })
    expect(docRes.statusCode).toBe(404)
    expect(docRes.body).not.toContain("EXCRET_MD_BODY")

    const assetRes = await app.inject({
      method: "GET",
      url: "/api/portal/asset?source=adk&path=sym-hardlink.png",
      headers: TRUSTED_HEADERS,
    })
    expect(assetRes.statusCode).toBe(404)
    expect(assetRes.rawPayload.includes(outsidePngContent)).toBe(false)
  })

  it("트리 (GET /api/portal)에서 하드 링크 및 그 심볼릭 링크가 모두 빠진다", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/portal",
      headers: TRUSTED_HEADERS,
    })
    expect(res.statusCode).toBe(200)
    const json = JSON.parse(res.body)
    const adkSource = json.sources.find((s: any) => s.id === "adk")
    expect(adkSource).toBeDefined()

    const names = adkSource.tree.map((n: any) => n.name)
    expect(names).toContain("normal.md")
    expect(names).not.toContain("hardlink.md")
    expect(names).not.toContain("hardlink.png")
    expect(names).not.toContain("sym-hardlink.md")
    expect(names).not.toContain("sym-hardlink.png")
  })

  it("GET /folder: 폴더 목록 및 cover에서 하드 링크가 빠진다", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/portal/folder?source=adk&path=",
      headers: TRUSTED_HEADERS,
    })
    expect(res.statusCode).toBe(200)
    const json = JSON.parse(res.body)
    const names = json.entries.map((e: any) => e.name)
    expect(names).toContain("normal.md")
    expect(names).not.toContain("hardlink.md")
    expect(names).not.toContain("hardlink.png")
    expect(names).not.toContain("sym-hardlink.md")
    expect(names).not.toContain("sym-hardlink.png")
  })

  it("검색 (GET /search): 하드 링크 문서 내용으로 검색되지 않는다", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/portal/search?q=EXCRET_MD_BODY",
      headers: TRUSTED_HEADERS,
    })
    expect(res.statusCode).toBe(200)
    const json = JSON.parse(res.body)
    expect(json.results.length).toBe(0)
  })

  it("PUT /doc: 하드 링크 대상 PUT은 404이고 바깥 파일 바이트가 그대로 유지된다", async () => {
    const extMdPath = path.join(outsideDir, "ext-secret.md")
    const beforeOutsideBytes = fs.readFileSync(extMdPath, "utf-8")
    const beforeHash = crypto.createHash("sha256").update(beforeOutsideBytes).digest("hex")

    const res = await app.inject({
      method: "PUT",
      url: "/api/portal/doc?source=adk&path=hardlink.md",
      headers: {
        ...TRUSTED_HEADERS,
        "content-type": "application/json",
      },
      payload: {
        baseHash: beforeHash,
        content: "# 변조 시도 내용",
      },
    })

    expect(res.statusCode).toBe(404)
    const afterOutsideBytes = fs.readFileSync(extMdPath, "utf-8")
    expect(afterOutsideBytes).toBe(beforeOutsideBytes)
  })

  it("옆의 nlink === 1 정상 문서는 200 반환한다", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/portal/doc?source=adk&path=normal.md",
      headers: TRUSTED_HEADERS,
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe(normalMdContent)
  })
})
