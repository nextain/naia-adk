import { describe, it, expect, beforeAll, afterAll } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { createServer } from "../src/server.js"

describe("GET /api/portal/search", () => {
  let root: string
  let outside: string

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "adk-search-test-"))
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "adk-search-outside-"))
    const docs = path.join(root, "docs")
    fs.mkdirSync(path.join(docs, "developer", "product"), { recursive: true })
    fs.mkdirSync(path.join(docs, "common"), { recursive: true })
    fs.mkdirSync(path.join(docs, ".hidden"), { recursive: true })
    fs.writeFileSync(
      path.join(docs, "developer", "product", "naia-studio-index.md"),
      "# Naia Studio 통합 색인\n\n나이아 스튜디오는 비주얼 에이전트 제작 서비스입니다.\n",
    )
    fs.writeFileSync(path.join(docs, "common", "guide.md"), "# 문서 작성 가이드\n\n표준 용어 사전을 따릅니다.\n")
    fs.writeFileSync(path.join(docs, ".hidden", "secret.md"), "# 숨은 문서\n\n스튜디오 비밀\n")
    // 분해형(NFD) 한글 파일 이름
    fs.writeFileSync(path.join(docs, "common", "회의록.md".normalize("NFD")), "# 회의 기록\n\n스튜디오 회의\n")
    // 보여 주기 폴더 안의 심볼릭 링크(밖 파일을 가리킴)
    fs.writeFileSync(path.join(outside, "leak.md"), "# 밖 파일\n\n스튜디오 유출\n")
    fs.symlinkSync(path.join(outside, "leak.md"), path.join(docs, "common", "link.md"))
    // 너무 큰 파일은 읽지 않는다
    fs.writeFileSync(path.join(docs, "common", "big.md"), `# 큰 문서\n\n스튜디오\n${"x".repeat(1024 * 1024 + 10)}`)
    // 보관 문서: 첫 줄 표시가 있는 옛 판, 표시 없이 보관 폴더에만 있는 부산물, 회사 문서식 "지난 기록" 폴더
    fs.mkdirSync(path.join(docs, "developer", "archive", "2026-09-25"), { recursive: true })
    fs.mkdirSync(path.join(docs, "developer", "Archive", "harness-2026-09"), { recursive: true })
    fs.mkdirSync(path.join(docs, "common", "지난 기록".normalize("NFD")), { recursive: true })
    fs.writeFileSync(
      path.join(docs, "developer", "archive", "2026-09-25", "naia-studio-old.md"),
      "> 대체됨 2026-09-25 · 이유: 새 색인으로 합침 · 현행: [색인](../../product/naia-studio-index.md)\n\n# Naia Studio 옛 색인\n\n스튜디오 STUDIO studio 옛 판\n",
    )
    fs.writeFileSync(path.join(docs, "developer", "Archive", "harness-2026-09", "run.md"), "# 하네스 실행 기록\n\n스튜디오 부산물\n")
    fs.writeFileSync(path.join(docs, "common", "지난 기록".normalize("NFD"), "brochure.md"), "# 옛 소개서\n\n스튜디오 소개\n")
    // 보관 폴더 밖이지만 앞머리 뒤 첫 줄에 보관 표시가 있는 기록
    fs.writeFileSync(
      path.join(docs, "developer", "report-2026-09-20.md"),
      "---\ntitle: 기록\n---\n> 보관 2026-09-20 · 이유: 당시 기록 · 현행: 없음\n\n# 9월 기록\n\n스튜디오 기록\n",
    )
    // 이름에 archive가 들어가도 폴더가 아니면 현행, 표시가 첫 줄이 아니어도 현행
    fs.writeFileSync(path.join(docs, "common", "archive-guide.md"), "# 보관 안내\n\n스튜디오 옛 판을 옮기는 법\n")
    fs.writeFileSync(path.join(docs, "common", "quote.md"), "# 인용\n\n스튜디오\n\n> 대체됨 2026-09-01 · 인용 예시\n")
    // 보여 주지 않는 폴더(docs 밖)
    fs.writeFileSync(path.join(root, "outside-docs.md"), "# docs 밖\n\n스튜디오\n")
  })

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  type Hit = {
    source: string
    path: string
    title: string
    snippet: string
    archive: { kind: string | null; date: string | null } | null
  }

  async function searchFull(q: string) {
    const app = await createServer({ root, port: 0, host: "127.0.0.1" })
    const res = await app.inject({
      method: "GET",
      url: `/api/portal/search?${q}`,
      headers: { host: "localhost:0" },
    })
    expect(res.statusCode).toBe(200)
    return JSON.parse(res.payload) as { results: Hit[]; archivedHidden: number }
  }

  async function search(q: string) {
    return (await searchFull(q)).results
  }

  it("한글 부분일치로 본문을 찾고, 제목과 구절을 돌려준다", async () => {
    const r = await search(`q=${encodeURIComponent("스튜디오")}`)
    const hit = r.find((x) => x.path === "developer/product/naia-studio-index.md")
    expect(hit).toBeDefined()
    expect(hit?.source).toBe("adk")
    expect(hit?.title).toBe("Naia Studio 통합 색인")
    expect(hit?.snippet).toContain("스튜디오")
  })

  it("영어는 대소문자를 가리지 않고, 제목 일치가 앞선다", async () => {
    const r = await search("q=STUDIO")
    expect(r[0].path).toBe("developer/product/naia-studio-index.md")
  })

  it("여러 낱말은 모두 들어간 문서만 찾는다", async () => {
    expect((await search(`q=${encodeURIComponent("용어 사전")}`)).map((x) => x.path)).toEqual(["common/guide.md"])
    expect(await search(`q=${encodeURIComponent("용어 스튜디오")}`)).toEqual([])
  })

  it("점 폴더, 심볼릭 링크, 너무 큰 파일, docs 밖 파일은 결과에 없다", async () => {
    const paths = (await search(`q=${encodeURIComponent("스튜디오")}`)).map((x) => x.path)
    expect(paths.some((p) => p.includes(".hidden"))).toBe(false)
    expect(paths).not.toContain("common/link.md")
    expect(paths).not.toContain("common/big.md")
    expect(paths.some((p) => p.includes("outside-docs"))).toBe(false)
  })

  it("분해형 한글 파일 이름도 찾고, 경로는 디스크의 원래 이름으로 돌려준다", async () => {
    const r = await search(`q=${encodeURIComponent("회의록".normalize("NFC"))}`)
    expect(r).toHaveLength(1)
    const onDisk = fs.readdirSync(path.join(root, "docs", "common")).find((n) => n.normalize("NFC") === "회의록.md")
    expect(r[0].path).toBe(`common/${onDisk}`)
    const app = await createServer({ root, port: 0, host: "127.0.0.1" })
    const doc = await app.inject({
      method: "GET",
      url: `/api/portal/doc?source=adk&path=${encodeURIComponent(r[0].path)}`,
      headers: { host: "localhost:0" },
    })
    expect(doc.statusCode).toBe(200)
  })

  it("빈 검색어와 두 번 온 검색어는 빈 결과", async () => {
    expect(await search("q=")).toEqual([])
    expect(await search("")).toEqual([])
    expect(await search("q=a&q=b")).toEqual([])
  })

  describe("보관 문서", () => {
    const ARCHIVED = [
      "developer/archive/2026-09-25/naia-studio-old.md",
      "developer/Archive/harness-2026-09/run.md",
      "developer/report-2026-09-20.md",
    ]

    it("기본 검색은 현행 문서만 돌려주고, 숨긴 보관 문서 수를 알린다", async () => {
      const r = await searchFull(`q=${encodeURIComponent("스튜디오")}`)
      const paths = r.results.map((x) => x.path)
      for (const p of ARCHIVED) expect(paths).not.toContain(p)
      expect(paths.some((p) => p.normalize("NFC").includes("지난 기록"))).toBe(false)
      expect(r.results.every((x) => x.archive === null)).toBe(true)
      expect(r.archivedHidden).toBe(4)
    })

    it("폴더가 아닌 이름의 archive, 첫 줄이 아닌 표시는 현행으로 본다", async () => {
      const paths = (await search(`q=${encodeURIComponent("스튜디오")}`)).map((x) => x.path)
      expect(paths).toContain("common/archive-guide.md")
      expect(paths).toContain("common/quote.md")
    })

    it("archived=1이면 보관 문서도 넣되 현행 문서보다 아래에 두고 표시를 붙인다", async () => {
      const r = await searchFull(`q=STUDIO&archived=1`)
      expect(r.archivedHidden).toBe(0)
      const paths = r.results.map((x) => x.path)
      expect(paths).toContain("developer/archive/2026-09-25/naia-studio-old.md")
      // 제목 점수가 같아도 현행 색인이 먼저다.
      expect(paths[0]).toBe("developer/product/naia-studio-index.md")
      const firstArchived = r.results.findIndex((x) => x.archive !== null)
      expect(r.results.slice(firstArchived).every((x) => x.archive !== null)).toBe(true)
      const old = r.results.find((x) => x.path === "developer/archive/2026-09-25/naia-studio-old.md")
      expect(old?.archive).toEqual({ kind: "대체됨", date: "2026-09-25" })
    })

    it("표시 없는 보관 폴더 문서와 앞머리 뒤 보관 표시를 읽는다", async () => {
      const r = await search(`q=${encodeURIComponent("스튜디오")}&archived=1`)
      expect(r.find((x) => x.path === "developer/Archive/harness-2026-09/run.md")?.archive).toEqual({ kind: null, date: null })
      expect(r.find((x) => x.path === "developer/report-2026-09-20.md")?.archive).toEqual({ kind: "보관", date: "2026-09-20" })
      expect(r.some((x) => x.path.normalize("NFC") === "common/지난 기록/brochure.md" && x.archive !== null)).toBe(true)
      const firstArchived = r.findIndex((x) => x.archive !== null)
      expect(firstArchived).toBeGreaterThan(0)
      expect(r.slice(firstArchived).every((x) => x.archive !== null)).toBe(true)
    })

    it("archived는 1·true만 켠 것으로 본다", async () => {
      for (const v of ["0", "false", "yes", ""]) {
        const r = await searchFull(`q=${encodeURIComponent("스튜디오")}&archived=${v}`)
        expect(r.results.every((x) => x.archive === null)).toBe(true)
      }
      const twice = await searchFull(`q=${encodeURIComponent("스튜디오")}&archived=1&archived=1`)
      expect(twice.results.every((x) => x.archive === null)).toBe(true)
    })
  })
})
