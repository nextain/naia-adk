import { describe, it, expect, beforeAll, afterAll } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { createServer } from "../src/server.js"
import { validateCompanyConfig } from "@naia-adk/core"

describe("Portal Routes (/api/portal)", () => {
  let tempRoot: string
  let outsideDir: string

  beforeAll(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adk-portal-test-"))
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "adk-outside-test-"))

    // 1. ADK docs
    fs.mkdirSync(path.join(tempRoot, "docs"), { recursive: true })
    fs.writeFileSync(path.join(tempRoot, "docs", "intro.md"), "# ADK 소개 문서\n내용입니다.")

    // 2. data-company/co-docs
    const companyDir = path.join(tempRoot, "data-company", "co-docs")
    fs.mkdirSync(companyDir, { recursive: true })

    const companyConfig = {
      schemaVersion: 1,
      title: "우리회사 문서",
      docs: {
        include: ["01. 온보딩", "05. 브랜드·마케팅"],
      },
      repos: [
        {
          id: "hub",
          path: "projects/hub",
          remote: "https://github.com/example/hub.git",
          docs: {
            title: "공동작업 허브",
            include: ["docs"],
          },
        },
      ],
      board: {
        repo: "hub",
        script: "scripts/board-server.mjs",
        port: 8894,
      },
    }
    fs.writeFileSync(
      path.join(companyDir, "adk-company.json"),
      JSON.stringify(companyConfig, null, 2),
    )

    // 01. 온보딩
    const onboardingDir = path.join(companyDir, "01. 온보딩")
    fs.mkdirSync(onboardingDir, { recursive: true })
    fs.writeFileSync(path.join(onboardingDir, "a.md"), "# 온보딩 A 문서")
    fs.writeFileSync(path.join(onboardingDir, "notes.txt"), "텍스트 파일입니다.")
    // 간단한 1x1 PNG 헤더 바이너리
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    fs.writeFileSync(path.join(onboardingDir, "logo.png"), pngHeader)

    // 심볼릭 링크 탈출 파일
    const outsideFile = path.join(outsideDir, "outside.md")
    fs.writeFileSync(outsideFile, "# 밖의 비밀 파일")
    fs.symlinkSync(outsideFile, path.join(onboardingDir, "symlink-outside.md"))

    // 10. 증빙서류 (제외 폴더)
    const secretDir = path.join(companyDir, "10. 증빙서류")
    fs.mkdirSync(secretDir, { recursive: true })
    fs.writeFileSync(path.join(secretDir, "secret.md"), "# 제외된 비밀 문서")
    // 같은 저장소 안의 제외 폴더를 가리키는 링크(보여 주는 폴더 안에 둠)
    fs.symlinkSync(path.join(secretDir, "secret.md"), path.join(onboardingDir, "link-to-secret.md"))
    fs.symlinkSync(secretDir, path.join(onboardingDir, "linked-secret-dir"))
    // 이름에 %가 든 문서
    fs.writeFileSync(path.join(onboardingDir, "100% 완료.md"), "# 퍼센트 문서")

    // 05. 브랜드·마케팅/03. 콘텐츠/세계관.md (한글, 공백, 점 폴더)
    const brandDir = path.join(companyDir, "05. 브랜드·마케팅", "03. 콘텐츠")
    fs.mkdirSync(brandDir, { recursive: true })
    fs.writeFileSync(path.join(brandDir, "세계관.md"), "# 세계관 설정집")

    // 3. projects/hub/docs/x.md
    const hubDocsDir = path.join(tempRoot, "projects", "hub", "docs")
    fs.mkdirSync(hubDocsDir, { recursive: true })
    fs.writeFileSync(path.join(hubDocsDir, "x.md"), "# 허브 문서 X")
  })

  afterAll(() => {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true })
      fs.rmSync(outsideDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it("GET /api/portal: 출처 목록, 트리, board 정보 반환 (제외 폴더 미포함)", async () => {
    const app = await createServer({ root: tempRoot, port: 0, host: "127.0.0.1" })

    const res = await app.inject({
      method: "GET",
      url: "/api/portal",
    })

    expect(res.statusCode).toBe(200)
    const json = JSON.parse(res.payload)

    // sources 확인
    expect(json.sources).toHaveLength(3)
    const adkSource = json.sources.find((s: any) => s.id === "adk")
    const companySource = json.sources.find((s: any) => s.id === "company:co-docs")
    const hubSource = json.sources.find((s: any) => s.id === "hub")

    expect(adkSource).toBeDefined()
    expect(adkSource.title).toBe("ADK 문서")
    expect(adkSource.tree).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "intro.md", type: "file" }),
      ]),
    )

    expect(companySource).toBeDefined()
    expect(companySource.title).toBe("우리회사 문서")

    // 트리에 포함 폴더는 있고 제외 폴더(10. 증빙서류)는 없어야 함
    const companyFolderNames = companySource.tree.map((node: any) => node.name)
    expect(companyFolderNames).toContain("01. 온보딩")
    expect(companyFolderNames).toContain("05. 브랜드·마케팅")
    expect(companyFolderNames).not.toContain("10. 증빙서류")

    // .md 아닌 파일(notes.txt)은 트리에 없어야 함
    const onboardingNode = companySource.tree.find((n: any) => n.name === "01. 온보딩")
    const fileNames = onboardingNode.children.map((c: any) => c.name)
    expect(fileNames).toContain("a.md")
    expect(fileNames).not.toContain("notes.txt")

    // hub 확인
    expect(hubSource).toBeDefined()
    expect(hubSource.title).toBe("공동작업 허브")

    // board 확인
    expect(json.board).toEqual({ port: 8894 })
  })

  it("GET /api/portal/doc: 포함 문서 200, 한글·공백·점 경로 200", async () => {
    const app = await createServer({ root: tempRoot, port: 0, host: "127.0.0.1" })

    // 온보딩 문서
    const res1 = await app.inject({
      method: "GET",
      url: "/api/portal/doc?source=company:co-docs&path=01.%20%EC%98%A8%EB%B3%B4%EB%94%A9/a.md",
    })
    expect(res1.statusCode).toBe(200)
    expect(res1.payload).toBe("# 온보딩 A 문서")

    // 한글·공백·점 경로
    const res2 = await app.inject({
      method: "GET",
      url: `/api/portal/doc?source=company:co-docs&path=${encodeURIComponent("05. 브랜드·마케팅/03. 콘텐츠/세계관.md")}`,
    })
    expect(res2.statusCode).toBe(200)
    expect(res2.payload).toBe("# 세계관 설정집")

    // Repo 문서
    const res3 = await app.inject({
      method: "GET",
      url: "/api/portal/doc?source=hub&path=docs/x.md",
    })
    expect(res3.statusCode).toBe(200)
    expect(res3.payload).toBe("# 허브 문서 X")
  })

  it("GET /api/portal/doc: 제외 폴더 404, .. 404, 심볼릭링크 탈출 404, .md아닌 파일 404", async () => {
    const app = await createServer({ root: tempRoot, port: 0, host: "127.0.0.1" })

    // 제외 폴더
    const res1 = await app.inject({
      method: "GET",
      url: `/api/portal/doc?source=company:co-docs&path=${encodeURIComponent("10. 증빙서류/secret.md")}`,
    })
    expect(res1.statusCode).toBe(404)

    // .. 경로 조작
    const res2 = await app.inject({
      method: "GET",
      url: `/api/portal/doc?source=company:co-docs&path=${encodeURIComponent("01. 온보딩/../10. 증빙서류/secret.md")}`,
    })
    expect(res2.statusCode).toBe(404)

    // 심볼릭 링크 탈출
    const res3 = await app.inject({
      method: "GET",
      url: `/api/portal/doc?source=company:co-docs&path=${encodeURIComponent("01. 온보딩/symlink-outside.md")}`,
    })
    expect(res3.statusCode).toBe(404)

    // 같은 저장소 안 제외 폴더로 가는 링크(파일, 폴더)
    for (const linked of ["01. 온보딩/link-to-secret.md", "01. 온보딩/linked-secret-dir/secret.md"]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/portal/doc?source=company:co-docs&path=${encodeURIComponent(linked)}`,
      })
      expect(res.statusCode).toBe(404)
    }

    // 이름에 %가 든 문서는 서버 오류 없이 열린다
    const resPct = await app.inject({
      method: "GET",
      url: `/api/portal/doc?source=company:co-docs&path=${encodeURIComponent("01. 온보딩/100% 완료.md")}`,
    })
    expect(resPct.statusCode).toBe(200)

    // .md 아닌 파일
    const res4 = await app.inject({
      method: "GET",
      url: `/api/portal/doc?source=company:co-docs&path=${encodeURIComponent("01. 온보딩/notes.txt")}`,
    })
    expect(res4.statusCode).toBe(404)
  })

  it("GET /api/portal/asset: 그림 200과 Content-Type, 허용되지 않은 파일 404", async () => {
    const app = await createServer({ root: tempRoot, port: 0, host: "127.0.0.1" })

    // PNG 그림
    const res = await app.inject({
      method: "GET",
      url: `/api/portal/asset?source=company:co-docs&path=${encodeURIComponent("01. 온보딩/logo.png")}`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers["content-type"]).toBe("image/png")

    // .txt 등 비그림 파일 404
    const resTxt = await app.inject({
      method: "GET",
      url: `/api/portal/asset?source=company:co-docs&path=${encodeURIComponent("01. 온보딩/notes.txt")}`,
    })
    expect(resTxt.statusCode).toBe(404)

    // 제외 폴더 404
    const resSecret = await app.inject({
      method: "GET",
      url: `/api/portal/asset?source=company:co-docs&path=${encodeURIComponent("10. 증빙서류/secret.png")}`,
    })
    expect(resSecret.statusCode).toBe(404)
  })

  it("회사 설정이 없을 때: ADK 문서 하나만 있고 board null", async () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adk-empty-test-"))
    fs.mkdirSync(path.join(emptyRoot, "docs"), { recursive: true })
    fs.writeFileSync(path.join(emptyRoot, "docs", "sample.md"), "# 샘플")

    const app = await createServer({ root: emptyRoot, port: 0, host: "127.0.0.1" })
    const res = await app.inject({
      method: "GET",
      url: "/api/portal",
    })
    expect(res.statusCode).toBe(200)
    const json = JSON.parse(res.payload)
    expect(json.sources).toHaveLength(1)
    expect(json.sources[0].id).toBe("adk")
    expect(json.board).toBeNull()

    fs.rmSync(emptyRoot, { recursive: true, force: true })
  })

  it("목록 파일 형식 오류 거부 (절대경로, .., projects·data-company 밖)", () => {
    // 절대경로 거부
    const absPathResult = validateCompanyConfig({
      schemaVersion: 1,
      title: "회사",
      repos: [{ id: "test", path: "/tmp/outside", remote: "https://example.com/repo.git" }],
    })
    expect(absPathResult.valid).toBe(false)
    expect(absPathResult.error).toContain("must be under projects/ or data-company/")

    // .. 거부
    const dotDotResult = validateCompanyConfig({
      schemaVersion: 1,
      title: "회사",
      repos: [{ id: "test", path: "projects/../escape", remote: "https://example.com/repo.git" }],
    })
    expect(dotDotResult.valid).toBe(false)
    expect(dotDotResult.error).toContain("without '..'")

    // projects/ 또는 data-company/ 밖 거부
    const otherPrefixResult = validateCompanyConfig({
      schemaVersion: 1,
      title: "회사",
      repos: [{ id: "test", path: "packages/server", remote: "https://example.com/repo.git" }],
    })
    expect(otherPrefixResult.valid).toBe(false)
    expect(otherPrefixResult.error).toContain("must be under projects/ or data-company/")

    // schemaVersion 1 아닌 경우
    const badVersionResult = validateCompanyConfig({
      schemaVersion: 2,
      title: "회사",
    })
    expect(badVersionResult.valid).toBe(false)
    expect(badVersionResult.error).toContain("schemaVersion must be 1")

    // board repo가 repos에 없는 경우
    const badBoardResult = validateCompanyConfig({
      schemaVersion: 1,
      title: "회사",
      repos: [{ id: "hub", path: "projects/hub", remote: "https://example.com/hub.git" }],
      board: { repo: "nonexistent", script: "start.js", port: 3000 },
    })
    expect(badBoardResult.valid).toBe(false)
    expect(badBoardResult.error).toContain("board.repo 'nonexistent' not found in repos")
  })
})
