import { describe, it, expect, beforeAll, afterAll } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { createServer } from "../src/server.js"
import {
  getFileKind,
  getAssetContentType,
  buildTree,
  findFolderCover,
  filterUntrustedTree,
} from "../src/routes/portal.js"

describe("W1b 지시서 포괄 시험 (vitest)", () => {
  let tempRoot: string
  let proxySecret: string
  const TEST_PORT = 3175

  beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adk-portal-w1b-"))

    // 1. ADK docs
    const docsDir = path.join(tempRoot, "docs")
    fs.mkdirSync(docsDir, { recursive: true })
    fs.writeFileSync(path.join(docsDir, "guide.md"), "# 가이드 문서\n내용입니다.")
    fs.writeFileSync(path.join(docsDir, "sample.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    fs.writeFileSync(path.join(docsDir, "sample.pdf"), Buffer.from("%PDF-1.4\n..."))
    fs.writeFileSync(path.join(docsDir, "index.html"), "<html><body>Hello</body></html>")
    fs.writeFileSync(path.join(docsDir, "data.json"), '{"key":"value"}')
    fs.writeFileSync(path.join(docsDir, "한글이름.md"), "# 한글 파일\n내용입니다.")

    // 100바이트 바이너리 (Range 시험용)
    const rangeBuf = Buffer.alloc(100)
    for (let i = 0; i < 100; i++) rangeBuf[i] = i
    fs.writeFileSync(path.join(docsDir, "range.mp4"), rangeBuf)

    // 1.5MB 텍스트 파일 (/text 1MB 자르기 시험용)
    const bigBuf = Buffer.alloc(1.5 * 1024 * 1024, "A")
    fs.writeFileSync(path.join(docsDir, "large.txt"), bigBuf)
    fs.writeFileSync(path.join(docsDir, "small.txt"), "작은 텍스트")

    // 2. data-company/co-w1b
    const companyDir = path.join(tempRoot, "data-company", "co-w1b")
    fs.mkdirSync(companyDir, { recursive: true })
    fs.writeFileSync(
      path.join(companyDir, "adk-company.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          title: "회사 문서",
          docs: {
            include: ["onboarding", "gallery", "pdf-only", "large-folder"],
          },
        },
        null,
        2,
      ),
    )

    // onboarding
    const onbDir = path.join(companyDir, "onboarding")
    fs.mkdirSync(onbDir, { recursive: true })
    fs.writeFileSync(path.join(onbDir, "welcome.md"), "# 환영합니다")
    fs.writeFileSync(path.join(onbDir, "avatar.avif"), Buffer.from("avif"))
    fs.writeFileSync(path.join(onbDir, "code.js"), 'console.log("script");')

    // gallery (cover 탐색 시험용)
    const galleryDir = path.join(companyDir, "gallery")
    fs.mkdirSync(galleryDir, { recursive: true })
    // depth 1: 폴더만 있음
    const sub1 = path.join(galleryDir, "sub1")
    fs.mkdirSync(sub1, { recursive: true })
    // depth 2: 그림 있음
    fs.writeFileSync(path.join(sub1, "photo.jpg"), Buffer.from([0xff, 0xd8, 0xff]))
    fs.writeFileSync(path.join(sub1, "doc.md"), "# 문서")

    // deep-gallery (depth 4에만 그림 있는 경우 cover 없어야 함)
    const deepDir = path.join(galleryDir, "deep")
    const d1 = path.join(deepDir, "d1")
    const d2 = path.join(d1, "d2")
    const d3 = path.join(d2, "d3")
    fs.mkdirSync(d3, { recursive: true })
    fs.writeFileSync(path.join(d3, "deep.png"), Buffer.from("deep png"))

    // pdf-only (믿지 않는 요청 시 트리에서 폴더 자체가 제외되어야 함)
    const pdfDir = path.join(companyDir, "pdf-only")
    fs.mkdirSync(pdfDir, { recursive: true })
    fs.writeFileSync(path.join(pdfDir, "report.pdf"), Buffer.from("%PDF-1.4\n..."))

    // 숨김 파일 및 폴더
    fs.mkdirSync(path.join(onbDir, ".hidden"), { recursive: true })
    fs.writeFileSync(path.join(onbDir, ".hidden", "secret.png"), Buffer.from("secret"))
    fs.writeFileSync(path.join(onbDir, ".dotfile"), "dotfile")

    // large-folder (505개 파일 생성)
    const largeDir = path.join(companyDir, "large-folder")
    fs.mkdirSync(largeDir, { recursive: true })
    for (let i = 0; i < 505; i++) {
      fs.writeFileSync(path.join(largeDir, `file_${String(i).padStart(3, "0")}.txt`), `txt ${i}`)
    }
  })

  afterAll(() => {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  // 1. 종류 표 (FE 2장)
  it("종류 표: 확장자별 kind 분류 및 실행 가능 형식 other 처리", () => {
    expect(getFileKind("test.md")).toBe("doc")
    expect(getFileKind("TEST.MD")).toBe("doc")
    expect(getFileKind("image.png")).toBe("image")
    expect(getFileKind("image.jpg")).toBe("image")
    expect(getFileKind("image.jpeg")).toBe("image")
    expect(getFileKind("image.gif")).toBe("image")
    expect(getFileKind("image.webp")).toBe("image")
    expect(getFileKind("image.svg")).toBe("image")
    expect(getFileKind("image.avif")).toBe("image")
    expect(getFileKind("video.mp4")).toBe("video")
    expect(getFileKind("video.webm")).toBe("video")
    expect(getFileKind("video.mov")).toBe("video")
    expect(getFileKind("video.m4v")).toBe("video")
    expect(getFileKind("audio.mp3")).toBe("audio")
    expect(getFileKind("audio.wav")).toBe("audio")
    expect(getFileKind("audio.ogg")).toBe("audio")
    expect(getFileKind("audio.m4a")).toBe("audio")
    expect(getFileKind("audio.flac")).toBe("audio")
    expect(getFileKind("doc.pdf")).toBe("pdf")
    expect(getFileKind("data.json")).toBe("text")
    expect(getFileKind("conf.yaml")).toBe("text")
    expect(getFileKind("conf.yml")).toBe("text")
    expect(getFileKind("readme.txt")).toBe("text")
    expect(getFileKind("table.csv")).toBe("text")
    expect(getFileKind("app.log")).toBe("text")
    expect(getFileKind("cargo.toml")).toBe("text")

    // 실행 가능한 형식은 other로 다룸 (FE 3장)
    expect(getFileKind("index.html")).toBe("other")
    expect(getFileKind("page.htm")).toBe("other")
    expect(getFileKind("doc.xhtml")).toBe("other")
    expect(getFileKind("script.js")).toBe("other")
    expect(getFileKind("module.mjs")).toBe("other")
    expect(getFileKind("component.tsx")).toBe("other")
    expect(getFileKind("unknown.bin")).toBe("other")
    expect(getFileKind("no_ext")).toBe("other")
  })

  // 2. 500개 상한과 truncated (FE 2장)
  it("500개 상한: 한 폴더 자식이 500개 초과 시 truncated: true 및 자식 500개 제한", () => {
    const largeDirPath = path.join(tempRoot, "data-company", "co-w1b", "large-folder")
    const nodes = buildTree(largeDirPath, "")
    expect(nodes.length).toBe(505) // 직속 entries 전체 505

    // 상위 폴더 관점에서 children 500개 제한 확인
    const companyDir = path.join(tempRoot, "data-company", "co-w1b")
    const companyNodes = buildTree(companyDir, "")
    const largeNode = companyNodes.find((n) => n.name === "large-folder")
    expect(largeNode).toBeDefined()
    expect(largeNode?.type).toBe("directory")
    expect(largeNode?.truncated).toBe(true)
    expect(largeNode?.children?.length).toBe(500)
  })

  // 3. Range 206·416 및 스트림 (FE 3장)
  it("/asset Range 요청: 206, 416, Accept-Ranges: bytes, Content-Range", async () => {
    const app = await createServer({ root: tempRoot, port: TEST_PORT, host: "127.0.0.1" })
    const secret = "test-secret-123456789012345678901234"
    ;(app as any).proxySecret = secret

    const trustedHeaders = {
      host: `localhost:${TEST_PORT}`,
      "x-naia-proxy-secret": secret,
      "x-naia-peer": "127.0.0.1",
    }

    // 일반 요청 (200)
    const res200 = await app.inject({
      method: "GET",
      url: "/api/portal/asset?source=adk&path=range.mp4",
      headers: trustedHeaders,
    })
    expect(res200.statusCode).toBe(200)
    expect(res200.headers["accept-ranges"]).toBe("bytes")
    expect(res200.headers["content-length"]).toBe("100")
    expect(res200.rawPayload.length).toBe(100)

    // Range 206 (bytes=0-49)
    const res206Part1 = await app.inject({
      method: "GET",
      url: "/api/portal/asset?source=adk&path=range.mp4",
      headers: { ...trustedHeaders, range: "bytes=0-49" },
    })
    expect(res206Part1.statusCode).toBe(206)
    expect(res206Part1.headers["content-range"]).toBe("bytes 0-49/100")
    expect(res206Part1.headers["content-length"]).toBe("50")
    expect(res206Part1.rawPayload.length).toBe(50)
    expect(res206Part1.rawPayload[0]).toBe(0)
    expect(res206Part1.rawPayload[49]).toBe(49)

    // Range 206 (bytes=50-)
    const res206Part2 = await app.inject({
      method: "GET",
      url: "/api/portal/asset?source=adk&path=range.mp4",
      headers: { ...trustedHeaders, range: "bytes=50-" },
    })
    expect(res206Part2.statusCode).toBe(206)
    expect(res206Part2.headers["content-range"]).toBe("bytes 50-99/100")
    expect(res206Part2.headers["content-length"]).toBe("50")
    expect(res206Part2.rawPayload.length).toBe(50)
    expect(res206Part2.rawPayload[0]).toBe(50)
    expect(res206Part2.rawPayload[49]).toBe(99)

    // Range 206 (bytes=-20, suffix)
    const res206Suffix = await app.inject({
      method: "GET",
      url: "/api/portal/asset?source=adk&path=range.mp4",
      headers: { ...trustedHeaders, range: "bytes=-20" },
    })
    expect(res206Suffix.statusCode).toBe(206)
    expect(res206Suffix.headers["content-range"]).toBe("bytes 80-99/100")
    expect(res206Suffix.headers["content-length"]).toBe("20")
    expect(res206Suffix.rawPayload[0]).toBe(80)

    // Range 416 (범위 벗어남)
    const res416Over = await app.inject({
      method: "GET",
      url: "/api/portal/asset?source=adk&path=range.mp4",
      headers: { ...trustedHeaders, range: "bytes=100-200" },
    })
    expect(res416Over.statusCode).toBe(416)
    expect(res416Over.headers["content-range"]).toBe("bytes */100")

    // Range 416 (잘못된 형식: start > end)
    const res416Bad = await app.inject({
      method: "GET",
      url: "/api/portal/asset?source=adk&path=range.mp4",
      headers: { ...trustedHeaders, range: "bytes=50-20" },
    })
    expect(res416Bad.statusCode).toBe(416)
  })

  // 4. 한글 파일 이름 download=1 (FE 3장)
  it("한글 파일 이름 download=1: filename*=UTF-8'' 인코딩 헤더", async () => {
    const app = await createServer({ root: tempRoot, port: TEST_PORT, host: "127.0.0.1" })
    const res = await app.inject({
      method: "GET",
      url: `/api/portal/asset?source=adk&path=${encodeURIComponent("한글이름.md")}&download=1`,
      headers: { host: `localhost:${TEST_PORT}` },
    })
    expect(res.statusCode).toBe(200)
    const disp = res.headers["content-disposition"]
    expect(disp).toBeDefined()
    expect(disp).toContain("attachment")
    const encoded = encodeURIComponent("한글이름.md")
    expect(disp).toContain(`filename*=UTF-8''${encoded}`)
  })

  // 5. 실행 형식이 attachment인지 (FE 3장)
  it("실행 형식(html, js 등)은 other로 다루어 application/octet-stream 및 attachment 반환", async () => {
    const app = await createServer({ root: tempRoot, port: TEST_PORT, host: "127.0.0.1" })
    const secret = "test-secret-123456789012345678901234"
    ;(app as any).proxySecret = secret
    const trustedHeaders = {
      host: `localhost:${TEST_PORT}`,
      "x-naia-proxy-secret": secret,
      "x-naia-peer": "127.0.0.1",
    }

    const resHtml = await app.inject({
      method: "GET",
      url: "/api/portal/asset?source=adk&path=index.html",
      headers: trustedHeaders,
    })
    expect(resHtml.statusCode).toBe(200)
    expect(resHtml.headers["content-type"]).toBe("application/octet-stream")
    expect(resHtml.headers["content-disposition"]).toContain("attachment")
    expect(resHtml.headers["content-disposition"]).toContain("filename*=UTF-8''index.html")

    const resJs = await app.inject({
      method: "GET",
      url: "/api/portal/asset?source=company:co-w1b&path=onboarding/code.js",
      headers: trustedHeaders,
    })
    expect(resJs.statusCode).toBe(200)
    expect(resJs.headers["content-type"]).toBe("application/octet-stream")
    expect(resJs.headers["content-disposition"]).toContain("attachment")
  })

  // 6. 모든 응답 nosniff (FE 3장)
  it("모든 응답에 X-Content-Type-Options: nosniff", async () => {
    const app = await createServer({ root: tempRoot, port: TEST_PORT, host: "127.0.0.1" })

    // /doc
    const resDoc = await app.inject({
      method: "GET",
      url: "/api/portal/doc?source=adk&path=guide.md",
      headers: { host: `localhost:${TEST_PORT}` },
    })
    expect(resDoc.statusCode).toBe(200)
    expect(resDoc.headers["x-content-type-options"]).toBe("nosniff")

    // /asset
    const resAsset = await app.inject({
      method: "GET",
      url: "/api/portal/asset?source=adk&path=sample.png",
      headers: { host: `localhost:${TEST_PORT}` },
    })
    expect(resAsset.statusCode).toBe(200)
    expect(resAsset.headers["x-content-type-options"]).toBe("nosniff")
  })

  // 7. PDF와 비PDF CSP (FE 3장)
  it("CSP 검증: PDF는 브라우저 내장 보기 CSP, 비PDF는 sandbox", async () => {
    const app = await createServer({ root: tempRoot, port: TEST_PORT, host: "127.0.0.1" })
    const secret = "test-secret-123456789012345678901234"
    ;(app as any).proxySecret = secret
    const trustedHeaders = {
      host: `localhost:${TEST_PORT}`,
      "x-naia-proxy-secret": secret,
      "x-naia-peer": "127.0.0.1",
    }

    // PDF 응답
    const resPdf = await app.inject({
      method: "GET",
      url: "/api/portal/asset?source=adk&path=sample.pdf",
      headers: trustedHeaders,
    })
    expect(resPdf.statusCode).toBe(200)
    expect(resPdf.headers["content-security-policy"]).toBe(
      "default-src 'none'; object-src 'self'; plugin-types application/pdf",
    )

    // 비PDF (PNG) 응답
    const resPng = await app.inject({
      method: "GET",
      url: "/api/portal/asset?source=adk&path=sample.png",
      headers: trustedHeaders,
    })
    expect(resPng.statusCode).toBe(200)
    expect(resPng.headers["content-security-policy"]).toBe("sandbox")

    // 비PDF (HTML) 응답
    const resHtml = await app.inject({
      method: "GET",
      url: "/api/portal/asset?source=adk&path=index.html",
      headers: trustedHeaders,
    })
    expect(resHtml.statusCode).toBe(200)
    expect(resHtml.headers["content-security-policy"]).toBe("sandbox")
  })

  // 8. /text 1MB 자르기 (FE 3장)
  it("GET /api/portal/text: 앞 1MB 및 truncated 판정", async () => {
    const app = await createServer({ root: tempRoot, port: TEST_PORT, host: "127.0.0.1" })
    const secret = "test-secret-123456789012345678901234"
    ;(app as any).proxySecret = secret
    const trustedHeaders = {
      host: `localhost:${TEST_PORT}`,
      "x-naia-proxy-secret": secret,
      "x-naia-peer": "127.0.0.1",
    }

    // 1.5MB 파일
    const resLarge = await app.inject({
      method: "GET",
      url: "/api/portal/text?source=adk&path=large.txt",
      headers: trustedHeaders,
    })
    expect(resLarge.statusCode).toBe(200)
    const jsonLarge = JSON.parse(resLarge.payload)
    expect(jsonLarge.truncated).toBe(true)
    expect(Buffer.byteLength(jsonLarge.content, "utf-8")).toBe(1024 * 1024)

    // 작은 파일
    const resSmall = await app.inject({
      method: "GET",
      url: "/api/portal/text?source=adk&path=small.txt",
      headers: trustedHeaders,
    })
    expect(resSmall.statusCode).toBe(200)
    const jsonSmall = JSON.parse(resSmall.payload)
    expect(jsonSmall.truncated).toBe(false)
    expect(jsonSmall.content).toBe("작은 텍스트")
  })

  // 9. /folder 순서·total·cover(깊이 3·2000개 중단)·숨김 제외 (FE 3장)
  it("GET /api/portal/folder: 순서, total, cover(깊이 3), 숨김 제외, 빈 경로 예외", async () => {
    const app = await createServer({ root: tempRoot, port: TEST_PORT, host: "127.0.0.1" })
    const secret = "test-secret-123456789012345678901234"
    ;(app as any).proxySecret = secret
    const trustedHeaders = {
      host: `localhost:${TEST_PORT}`,
      "x-naia-proxy-secret": secret,
      "x-naia-peer": "127.0.0.1",
    }

    // 1) 회사 출처 빈 경로 예외: docs.include 목록 반환
    const resEmptyCompany = await app.inject({
      method: "GET",
      url: "/api/portal/folder?source=company:co-w1b",
      headers: trustedHeaders,
    })
    expect(resEmptyCompany.statusCode).toBe(200)
    const jsonEmpty = JSON.parse(resEmptyCompany.payload)
    expect(jsonEmpty.entries.map((e: any) => e.name)).toEqual([
      "gallery",
      "large-folder",
      "onboarding",
      "pdf-only",
    ])

    // 2) gallery 폴더 cover 탐색 (depth 2의 photo.jpg 발견)
    const resGallery = await app.inject({
      method: "GET",
      url: "/api/portal/folder?source=company:co-w1b&path=gallery",
      headers: trustedHeaders,
    })
    expect(resGallery.statusCode).toBe(200)
    const jsonGallery = JSON.parse(resGallery.payload)
    const sub1Entry = jsonGallery.entries.find((e: any) => e.name === "sub1")
    expect(sub1Entry).toBeDefined()
    expect(sub1Entry.cover).toBe("gallery/sub1/photo.jpg")

    // deep 폴더는 depth 4에만 그림이 있어 cover가 없어야 함
    const deepEntry = jsonGallery.entries.find((e: any) => e.name === "deep")
    expect(deepEntry).toBeDefined()
    expect(deepEntry.cover).toBeUndefined()

    // 3) 숨김 파일/폴더 제외 확인
    const resOnb = await app.inject({
      method: "GET",
      url: "/api/portal/folder?source=company:co-w1b&path=onboarding",
      headers: trustedHeaders,
    })
    expect(resOnb.statusCode).toBe(200)
    const jsonOnb = JSON.parse(resOnb.payload)
    const names = jsonOnb.entries.map((e: any) => e.name)
    expect(names).not.toContain(".hidden")
    expect(names).not.toContain(".dotfile")

    // 순서 확인: 폴더 먼저(없음), 파일 이름 순(ko)
    // avatar.avif, code.js, welcome.md
    expect(names).toEqual(["avatar.avif", "code.js", "welcome.md"])

    // 4) 500개 초과 폴더: total과 truncated
    const resLarge = await app.inject({
      method: "GET",
      url: "/api/portal/folder?source=company:co-w1b&path=large-folder",
      headers: trustedHeaders,
    })
    expect(resLarge.statusCode).toBe(200)
    const jsonLarge = JSON.parse(resLarge.payload)
    expect(jsonLarge.total).toBe(505)
    expect(jsonLarge.truncated).toBe(true)
    expect(jsonLarge.entries.length).toBe(500)

    // 5) cover 2000개 파일 초과 중단 검증
    const manyFilesDir = path.join(tempRoot, "docs", "many-files")
    fs.mkdirSync(manyFilesDir, { recursive: true })
    // 2001개의 텍스트 파일 생성 후 마지막에 png 생성
    for (let i = 0; i < 2005; i++) {
      fs.writeFileSync(path.join(manyFilesDir, `text_${String(i).padStart(4, "0")}.txt`), "x")
    }
    fs.writeFileSync(path.join(manyFilesDir, "zzz_last.png"), Buffer.from("png"))
    const coverResult = findFolderCover(
      { id: "adk", title: "ADK", baseDir: path.join(tempRoot, "docs"), allowedPrefixes: null },
      "many-files",
      manyFilesDir,
    )
    expect(coverResult).toBeUndefined()
  })

  // 10. 믿음 판정별 허용/403 (FE 8장 116행)
  it("새 보기 보호: untrusted 요청 시 새 보기 403, 기존 보기는 200", async () => {
    const app = await createServer({ root: tempRoot, port: TEST_PORT, host: "127.0.0.1" })
    const secret = "test-secret-123456789012345678901234"
    ;(app as any).proxySecret = secret

    // Untrusted 요청 (비밀 없음)
    const untrustedHeaders = { host: `localhost:${TEST_PORT}` }

    // 기존 보기 (/doc, md /asset, png /asset, avif /asset) -> 200
    const resDoc = await app.inject({
      method: "GET",
      url: "/api/portal/doc?source=adk&path=guide.md",
      headers: untrustedHeaders,
    })
    expect(resDoc.statusCode).toBe(200)

    const resMdAsset = await app.inject({
      method: "GET",
      url: "/api/portal/asset?source=adk&path=guide.md",
      headers: untrustedHeaders,
    })
    expect(resMdAsset.statusCode).toBe(200)

    const resPngAsset = await app.inject({
      method: "GET",
      url: "/api/portal/asset?source=adk&path=sample.png",
      headers: untrustedHeaders,
    })
    expect(resPngAsset.statusCode).toBe(200)

    const resAvifAsset = await app.inject({
      method: "GET",
      url: "/api/portal/asset?source=company:co-w1b&path=onboarding/avatar.avif",
      headers: untrustedHeaders,
    })
    expect(resAvifAsset.statusCode).toBe(200)

    // 새 보기 (pdf, html, text, video, /text, /folder) -> 403
    const resPdf = await app.inject({
      method: "GET",
      url: "/api/portal/asset?source=adk&path=sample.pdf",
      headers: untrustedHeaders,
    })
    expect(resPdf.statusCode).toBe(403)

    const resHtml = await app.inject({
      method: "GET",
      url: "/api/portal/asset?source=adk&path=index.html",
      headers: untrustedHeaders,
    })
    expect(resHtml.statusCode).toBe(403)

    const resTextAsset = await app.inject({
      method: "GET",
      url: "/api/portal/asset?source=adk&path=small.txt",
      headers: untrustedHeaders,
    })
    expect(resTextAsset.statusCode).toBe(403)

    const resTextApi = await app.inject({
      method: "GET",
      url: "/api/portal/text?source=adk&path=small.txt",
      headers: untrustedHeaders,
    })
    expect(resTextApi.statusCode).toBe(403)

    const resFolderApi = await app.inject({
      method: "GET",
      url: "/api/portal/folder?source=adk",
      headers: untrustedHeaders,
    })
    expect(resFolderApi.statusCode).toBe(403)

    // Trusted 요청 -> 모두 200
    const trustedHeaders = {
      host: `localhost:${TEST_PORT}`,
      "x-naia-proxy-secret": secret,
      "x-naia-peer": "127.0.0.1",
    }

    const resPdfTrusted = await app.inject({
      method: "GET",
      url: "/api/portal/asset?source=adk&path=sample.pdf",
      headers: trustedHeaders,
    })
    expect(resPdfTrusted.statusCode).toBe(200)

    const resTextApiTrusted = await app.inject({
      method: "GET",
      url: "/api/portal/text?source=adk&path=small.txt",
      headers: trustedHeaders,
    })
    expect(resTextApiTrusted.statusCode).toBe(200)

    const resFolderApiTrusted = await app.inject({
      method: "GET",
      url: "/api/portal/folder?source=adk",
      headers: trustedHeaders,
    })
    expect(resFolderApiTrusted.statusCode).toBe(200)
  })

  // 11. 믿지 않는 트리에 pdf·html이 없고 md·png는 있음 (FE 8장 117행)
  it("GET /api/portal: untrusted 트리에는 pdf·html이 없고 md·png만 있음, 빈 폴더 제거", async () => {
    const app = await createServer({ root: tempRoot, port: TEST_PORT, host: "127.0.0.1" })

    // untrusted 요청
    const res = await app.inject({
      method: "GET",
      url: "/api/portal",
      headers: { host: `localhost:${TEST_PORT}` },
    })
    expect(res.statusCode).toBe(200)
    const json = JSON.parse(res.payload)

    // ADK 출처 트리 검사
    const adkSource = json.sources.find((s: any) => s.id === "adk")
    expect(adkSource).toBeDefined()
    const adkNames = adkSource.tree.map((n: any) => n.name)
    expect(adkNames).toContain("guide.md")
    expect(adkNames).toContain("sample.png")
    expect(adkNames).toContain("한글이름.md")
    expect(adkNames).not.toContain("sample.pdf")
    expect(adkNames).not.toContain("index.html")
    expect(adkNames).not.toContain("data.json")

    // 회사 출처 트리 검사: pdf-only 폴더는 자식이 pdf뿐이라 폴더 자체가 제외되어야 함
    const companySource = json.sources.find((s: any) => s.id === "company:co-w1b")
    expect(companySource).toBeDefined()
    const companyFolders = companySource.tree.map((n: any) => n.name)
    expect(companyFolders).not.toContain("pdf-only")
    expect(companyFolders).toContain("onboarding")
    expect(companyFolders).toContain("gallery")
  })

  // 12. 믿는 트리에는 전부 있음 (FE 8장 117행)
  it("GET /api/portal: trusted 트리에는 pdf, html, text, pdf-only 폴더 전부 포함", async () => {
    const app = await createServer({ root: tempRoot, port: TEST_PORT, host: "127.0.0.1" })
    const secret = "test-secret-123456789012345678901234"
    ;(app as any).proxySecret = secret

    const res = await app.inject({
      method: "GET",
      url: "/api/portal",
      headers: {
        host: `localhost:${TEST_PORT}`,
        "x-naia-proxy-secret": secret,
        "x-naia-peer": "127.0.0.1",
      },
    })
    expect(res.statusCode).toBe(200)
    const json = JSON.parse(res.payload)

    const adkSource = json.sources.find((s: any) => s.id === "adk")
    const adkNames = adkSource.tree.map((n: any) => n.name)
    expect(adkNames).toContain("guide.md")
    expect(adkNames).toContain("sample.png")
    expect(adkNames).toContain("sample.pdf")
    expect(adkNames).toContain("index.html")
    expect(adkNames).toContain("data.json")

    const companySource = json.sources.find((s: any) => s.id === "company:co-w1b")
    const companyFolders = companySource.tree.map((n: any) => n.name)
    expect(companyFolders).toContain("pdf-only")
  })

  // 14. cross-site 403 (FE 8장 9번)
  it("cross-site 403: Sec-Fetch-Site: cross-site 헤더가 있으면 403, 없으면 200 (짝 검증)", async () => {
    const app = await createServer({ root: tempRoot, port: TEST_PORT, host: "127.0.0.1" })
    const secret = "test-secret-123456789012345678901234"
    ;(app as any).proxySecret = secret

    const trustedBase = {
      host: `localhost:${TEST_PORT}`,
      "x-naia-proxy-secret": secret,
      "x-naia-peer": "127.0.0.1",
    }

    // 1) /asset (그림 sample.png)
    const resAssetCross = await app.inject({
      method: "GET",
      url: "/api/portal/asset?source=adk&path=sample.png",
      headers: { ...trustedBase, "sec-fetch-site": "cross-site" },
    })
    expect(resAssetCross.statusCode).toBe(403)

    const resAssetOk = await app.inject({
      method: "GET",
      url: "/api/portal/asset?source=adk&path=sample.png",
      headers: trustedBase,
    })
    expect(resAssetOk.statusCode).toBe(200)

    // 2) /text
    const resTextCross = await app.inject({
      method: "GET",
      url: "/api/portal/text?source=adk&path=small.txt",
      headers: { ...trustedBase, "sec-fetch-site": "cross-site" },
    })
    expect(resTextCross.statusCode).toBe(403)

    const resTextOk = await app.inject({
      method: "GET",
      url: "/api/portal/text?source=adk&path=small.txt",
      headers: trustedBase,
    })
    expect(resTextOk.statusCode).toBe(200)

    // 3) /folder
    const resFolderCross = await app.inject({
      method: "GET",
      url: "/api/portal/folder?source=adk",
      headers: { ...trustedBase, "sec-fetch-site": "cross-site" },
    })
    expect(resFolderCross.statusCode).toBe(403)

    const resFolderOk = await app.inject({
      method: "GET",
      url: "/api/portal/folder?source=adk",
      headers: trustedBase,
    })
    expect(resFolderOk.statusCode).toBe(200)
  })
})
