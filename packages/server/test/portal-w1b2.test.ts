import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { createServer } from "../src/server.js"
import { buildTree } from "../src/routes/portal.js"

describe("W1b-2 검수 결함 보완 시험 (vitest)", () => {
  let tempRoot: string
  let proxySecret: string
  const TEST_PORT = 3176

  const trustedHeaders = (port = TEST_PORT, secret = "test-secret-w1b2-1234567890123456") => ({
    host: `localhost:${port}`,
    "x-naia-proxy-secret": secret,
    "x-naia-peer": "127.0.0.1",
  })

  beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adk-portal-w1b2-"))
    proxySecret = "test-secret-w1b2-1234567890123456"

    const docsDir = path.join(tempRoot, "docs")
    fs.mkdirSync(docsDir, { recursive: true })

    // 1. 검색 doc 전용 시험용 파일들 (같은 낱말을 둔 md, txt, json)
    fs.writeFileSync(
      path.join(docsDir, "search-match.md"),
      "# 고유문서\n이 문서는 w1b2_unique_search_token 을 포함합니다.",
    )
    fs.writeFileSync(
      path.join(docsDir, "search-match.txt"),
      "이 텍스트는 w1b2_unique_search_token 을 포함하지만 검색 결과에 나오지 않아야 합니다.",
    )
    fs.writeFileSync(
      path.join(docsDir, "search-match.json"),
      JSON.stringify({ keyword: "w1b2_unique_search_token" }),
    )

    // 2. /folder의 폴더 먼저 정렬 시험용 픽스처
    // 이름 순으로는 파일(a_file.txt)이 폴더(z_folder)보다 앞섬
    const mixedSortDir = path.join(docsDir, "mixed-sort")
    fs.mkdirSync(mixedSortDir, { recursive: true })
    fs.writeFileSync(path.join(mixedSortDir, "a_file.txt"), "텍스트 파일")
    const mixedSubFolder = path.join(mixedSortDir, "z_folder")
    fs.mkdirSync(mixedSubFolder, { recursive: true })
    fs.writeFileSync(path.join(mixedSubFolder, "sub.md"), "# 하위 문서")

    // 3. 1번 링크 시험용 픽스처
    const symlinksDir = path.join(docsDir, "symlinks")
    fs.mkdirSync(symlinksDir, { recursive: true })

    // (1) 실파일 pdf, 링크 md
    const actualPdf1 = path.join(symlinksDir, "actual1.pdf")
    fs.writeFileSync(actualPdf1, Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF"))
    fs.symlinkSync("actual1.pdf", path.join(symlinksDir, "link-to-pdf.md"))

    // (2) 실파일 pdf, 링크 png
    const actualPdf2 = path.join(symlinksDir, "actual2.pdf")
    fs.writeFileSync(actualPdf2, Buffer.from("%PDF-1.4\n2 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF"))
    fs.symlinkSync("actual2.pdf", path.join(symlinksDir, "link-to-pdf.png"))

    // (3) 실파일 html, 링크 pdf
    const actualHtml = path.join(symlinksDir, "actual3.html")
    fs.writeFileSync(actualHtml, "<html><body>Hello Untrusted HTML</body></html>")
    fs.symlinkSync("actual3.html", path.join(symlinksDir, "link-to-html.pdf"))
  })

  afterAll(() => {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  // [시험 1] 검색이 doc만 (픽스처에 같은 낱말이 든 txt·json을 두고 검색 결과에 안 나옴)
  it("검색이 doc만: 픽스처에 같은 낱말이 든 txt·json이 검색 결과에 나오지 않음", async () => {
    const app = await createServer({ root: tempRoot, port: TEST_PORT, host: "127.0.0.1" })
    ;(app as any).proxySecret = proxySecret

    const res = await app.inject({
      method: "GET",
      url: `/api/portal/search?q=${encodeURIComponent("w1b2_unique_search_token")}`,
      headers: { host: `localhost:${TEST_PORT}` },
    })

    expect(res.statusCode).toBe(200)
    const json = JSON.parse(res.payload)
    expect(json.results.length).toBe(1)
    expect(json.results[0].path).toBe("search-match.md")
    expect(json.results.some((r: any) => r.path.endsWith(".txt"))).toBe(false)
    expect(json.results.some((r: any) => r.path.endsWith(".json"))).toBe(false)
  })

  // [시험 2] /folder의 폴더 먼저 정렬 (이름 순으로는 파일이 먼저 오는 폴더·파일 섞인 픽스처)
  it("/folder: 이름 순으로는 파일이 먼저 오는 픽스처에서도 폴더가 파일보다 먼저 정렬됨", async () => {
    const app = await createServer({ root: tempRoot, port: TEST_PORT, host: "127.0.0.1" })
    ;(app as any).proxySecret = proxySecret

    const res = await app.inject({
      method: "GET",
      url: "/api/portal/folder?source=adk&path=mixed-sort",
      headers: trustedHeaders(TEST_PORT, proxySecret),
    })

    expect(res.statusCode).toBe(200)
    const json = JSON.parse(res.payload)
    expect(json.entries.length).toBe(2)
    // z_folder(directory)가 a_file.txt(file)보다 앞서야 함
    expect(json.entries[0].name).toBe("z_folder")
    expect(json.entries[0].type).toBe("directory")
    expect(json.entries[1].name).toBe("a_file.txt")
    expect(json.entries[1].type).toBe("file")
  })

  // [시험 3] 1번의 링크 시험 (app.inject로 라우트 호출)
  describe("1번 링크 판정 우회 방지 시험 (app.inject)", () => {
    it("믿지 않는 md 이름→pdf 실파일은 /doc 404·본문 없음, /asset 403", async () => {
      const app = await createServer({ root: tempRoot, port: TEST_PORT, host: "127.0.0.1" })
      ;(app as any).proxySecret = proxySecret

      // 1) /doc: 404 및 본문 없음
      const resDoc = await app.inject({
        method: "GET",
        url: "/api/portal/doc?source=adk&path=symlinks/link-to-pdf.md",
        headers: { host: `localhost:${TEST_PORT}` }, // untrusted
      })
      expect(resDoc.statusCode).toBe(404)
      expect(resDoc.payload).toBe("")

      // 2) /asset: 403
      const resAsset = await app.inject({
        method: "GET",
        url: "/api/portal/asset?source=adk&path=symlinks/link-to-pdf.md",
        headers: { host: `localhost:${TEST_PORT}` }, // untrusted
      })
      expect(resAsset.statusCode).toBe(403)
    })

    it("믿는 png 이름→pdf 실파일은 PDF Content-Type과 3장 PDF CSP", async () => {
      const app = await createServer({ root: tempRoot, port: TEST_PORT, host: "127.0.0.1" })
      ;(app as any).proxySecret = proxySecret

      const res = await app.inject({
        method: "GET",
        url: "/api/portal/asset?source=adk&path=symlinks/link-to-pdf.png",
        headers: trustedHeaders(TEST_PORT, proxySecret),
      })
      expect(res.statusCode).toBe(200)
      expect(res.headers["content-type"]).toBe("application/pdf")
      expect(res.headers["content-security-policy"]).toBe(
        "default-src 'none'; object-src 'self'; plugin-types application/pdf",
      )
    })

    it("믿는 pdf 이름→html 실파일은 sandbox와 attachment", async () => {
      const app = await createServer({ root: tempRoot, port: TEST_PORT, host: "127.0.0.1" })
      ;(app as any).proxySecret = proxySecret

      const res = await app.inject({
        method: "GET",
        url: "/api/portal/asset?source=adk&path=symlinks/link-to-html.pdf",
        headers: trustedHeaders(TEST_PORT, proxySecret),
      })
      expect(res.statusCode).toBe(200)
      expect(res.headers["content-security-policy"]).toBe("sandbox")
      expect(res.headers["content-type"]).toBe("application/octet-stream")
      expect(res.headers["content-disposition"]).toMatch(/^attachment;\s*filename\*=UTF-8''/)
    })
  })

  // [시험 4] ADK 루트 501개에서 id === "adk" 출처의 truncated === true, tree.length === 500, 첫 항목이 픽스처 직속 이름
  it("ADK 루트 501개: id === 'adk' 출처의 truncated === true, tree.length === 500, 첫 항목이 픽스처 직속 이름", async () => {
    const adk501Root = fs.mkdtempSync(path.join(os.tmpdir(), "adk-501-root-"))
    try {
      const docsDir = path.join(adk501Root, "docs")
      fs.mkdirSync(docsDir, { recursive: true })
      // 501개 md 파일 생성 (000 ~ 500)
      for (let i = 0; i <= 500; i++) {
        fs.writeFileSync(
          path.join(docsDir, `file_${String(i).padStart(3, "0")}.md`),
          `# Document ${i}`,
        )
      }

      const port = 3181
      const app = await createServer({ root: adk501Root, port, host: "127.0.0.1" })
      const res = await app.inject({
        method: "GET",
        url: "/api/portal",
        headers: { host: `localhost:${port}` },
      })
      expect(res.statusCode).toBe(200)
      const json = JSON.parse(res.payload)
      const adkSource = json.sources.find((s: any) => s.id === "adk")
      expect(adkSource).toBeDefined()
      expect(adkSource.truncated).toBe(true)
      expect(adkSource.tree.length).toBe(500)
      // 래퍼 노드 없이 직속 파일 이름이어야 함
      expect(adkSource.tree[0].name).toBe("file_000.md")
      expect(adkSource.tree[0].type).toBe("file")
    } finally {
      fs.rmSync(adk501Root, { recursive: true, force: true })
    }
  })

  // [시험 5] 3번 fs.readdirSync 호출 경로 감시 시험
  describe("3번 fs.readdirSync 감시 시험 (가, 나, 다, 라)", () => {
    // (가) 이름이 앞선 파일 500개 뒤의 폴더가 결과 500개 안에 있다
    it("(가) 이름이 앞선 파일 500개 뒤의 폴더가 결과 500개 안에 있다", () => {
      const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), "adk-3a-test-"))
      try {
        // 파일 500개: a_file_000.txt ~ a_file_499.txt
        for (let i = 0; i < 500; i++) {
          fs.writeFileSync(path.join(dirPath, `a_file_${String(i).padStart(3, "0")}.txt`), `txt ${i}`)
        }
        // 폴더 1개: z_folder (이름이 뒤에 옴)
        const zFolder = path.join(dirPath, "z_folder")
        fs.mkdirSync(zFolder, { recursive: true })
        fs.writeFileSync(path.join(zFolder, "sub.md"), "# 하위")

        // buildTree 호출
        const nodes = buildTree(dirPath, "")
        // 결과 500개로 슬라이스했을 때 z_folder가 반드시 포함되어야 함
        const top500 = nodes.slice(0, 500)
        expect(top500.some((n) => n.name === "z_folder")).toBe(true)
        // 폴더가 파일보다 앞이므로 맨 첫 번째 노드가 z_folder여야 함
        expect(top500[0].name).toBe("z_folder")
        expect(top500[0].type).toBe("directory")
      } finally {
        fs.rmSync(dirPath, { recursive: true, force: true })
      }
    })

    // (나) 비어 있지 않은 폴더 500개 뒤에만 있는 폴더는 buildTree에서 그 경로의 읽기가 0번이다
    it("(나) 비어 있지 않은 폴더 500개 뒤에만 있는 폴더는 buildTree에서 그 경로의 읽기가 0번이다", () => {
      const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), "adk-3b-test-"))
      try {
        // 비어 있지 않은 폴더 500개 생성 (dir_000 ~ dir_499)
        for (let i = 0; i < 500; i++) {
          const sub = path.join(dirPath, `dir_${String(i).padStart(3, "0")}`)
          fs.mkdirSync(sub, { recursive: true })
          fs.writeFileSync(path.join(sub, "item.md"), "# item")
        }
        // 비어 있지 않은 폴더 500개 뒤에 있는 폴더: dir_500
        const dir500 = path.join(dirPath, "dir_500")
        fs.mkdirSync(dir500, { recursive: true })
        fs.writeFileSync(path.join(dir500, "item.md"), "# item")

        const readdirSpy = vi.spyOn(fs, "readdirSync")
        try {
          const nodes = buildTree(dirPath, "")
          // dir_500 경로에 대한 readdirSync 호출 횟수 검사
          const callsToDir500 = readdirSpy.mock.calls.filter((call) => {
            const arg = String(call[0])
            return arg === dir500 || arg.endsWith("/dir_500")
          })
          expect(callsToDir500.length).toBe(0)
          expect(nodes.length).toBe(500)
        } finally {
          readdirSpy.mockRestore()
        }
      } finally {
        fs.rmSync(dirPath, { recursive: true, force: true })
      }
    })

    // (다) /folder에서 정렬 후 501번째 폴더에만 그림을 두고 그 폴더 경로의 읽기가 0번이며, 앞 500개 폴더의 cover는 지금 규칙(너비 우선, 깊이 3, 2000에서 중단)과 같다
    it("(다) /folder에서 정렬 후 501번째 폴더에만 그림을 두고 그 폴더 경로의 읽기가 0번이며 앞 500개 폴더 cover 규칙 유지", async () => {
      const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "adk-3c-test-"))
      try {
        const docsDir = path.join(rootDir, "docs")
        fs.mkdirSync(docsDir, { recursive: true })

        // 폴더 501개 생성: fld_000 ~ fld_500
        for (let i = 0; i < 500; i++) {
          const fld = path.join(docsDir, `fld_${String(i).padStart(3, "0")}`)
          fs.mkdirSync(fld, { recursive: true })
        }
        // 앞 500개 중 fld_005에 깊이 2 그림 배치하여 cover 정상 동작 확인
        const fld005Sub = path.join(docsDir, "fld_005", "sub")
        fs.mkdirSync(fld005Sub, { recursive: true })
        fs.writeFileSync(path.join(fld005Sub, "photo.jpg"), Buffer.from([0xff, 0xd8, 0xff]))

        // 501번째 폴더: fld_500 에만 그림 배치
        const fld500 = path.join(docsDir, "fld_500")
        fs.mkdirSync(fld500, { recursive: true })
        fs.writeFileSync(path.join(fld500, "only_image.png"), Buffer.from("png"))

        const port = 3182
        const secret = "secret-3c-test-1234567890123456"
        const app = await createServer({ root: rootDir, port, host: "127.0.0.1" })
        ;(app as any).proxySecret = secret

        const readdirSpy = vi.spyOn(fs, "readdirSync")
        try {
          const res = await app.inject({
            method: "GET",
            url: "/api/portal/folder?source=adk",
            headers: trustedHeaders(port, secret),
          })
          expect(res.statusCode).toBe(200)
          const json = JSON.parse(res.payload)

          expect(json.total).toBe(501)
          expect(json.truncated).toBe(true)
          expect(json.entries.length).toBe(500)

          // 앞 500개 중 fld_005의 cover 확인
          const entry005 = json.entries.find((e: any) => e.name === "fld_005")
          expect(entry005).toBeDefined()
          expect(entry005.cover).toBe("fld_005/sub/photo.jpg")

          // 501번째 폴더(fld_500) 경로에 대한 readdirSync 호출 횟수는 0번이어야 함
          const callsToFld500 = readdirSpy.mock.calls.filter((call) => {
            const arg = String(call[0])
            return arg === fld500 || arg.endsWith("/fld_500")
          })
          expect(callsToFld500.length).toBe(0)
        } finally {
          readdirSpy.mockRestore()
        }
      } finally {
        fs.rmSync(rootDir, { recursive: true, force: true })
      }
    })

    // (라) 앞 500개가 빈 폴더이고 501번째가 md인 경우 그 md가 트리에 있다
    it("(라) 앞 500개가 빈 폴더이고 501번째가 md인 경우 그 md가 트리에 있다", () => {
      const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), "adk-3d-test-"))
      try {
        // 빈 폴더 500개: empty_000 ~ empty_499
        for (let i = 0; i < 500; i++) {
          fs.mkdirSync(path.join(dirPath, `empty_${String(i).padStart(3, "0")}`), { recursive: true })
        }
        // 501번째 항목: target.md
        fs.writeFileSync(path.join(dirPath, "target.md"), "# Target Markdown")

        const nodes = buildTree(dirPath, "")
        // 빈 폴더들은 자식이 없으므로 트리에 들어가지 않고, target.md만 트리에 있어야 함
        expect(nodes.some((n) => n.name === "target.md")).toBe(true)
        const targetNode = nodes.find((n) => n.name === "target.md")
        expect(targetNode?.kind).toBe("doc")
        expect(nodes.length).toBe(1)
      } finally {
        fs.rmSync(dirPath, { recursive: true, force: true })
      }
    })
  })
})
