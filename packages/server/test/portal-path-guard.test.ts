import { describe, it, expect, beforeAll, afterAll } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { createServer } from "../src/server.js"
import {
  isExcludedName,
  isHiddenPath,
  resolveSourceBase,
  resolveSecureDir,
  resolveSecureFile,
} from "../src/routes/portal.js"

describe("W1a-1: Path Guard & Exclusion Protection", () => {
  describe("Unit: isExcludedName", () => {
    it("숨김(점 시작) 이름을 제외한다", () => {
      expect(isExcludedName(".secret")).toBe(true)
      expect(isExcludedName(".git")).toBe(true)
      expect(isExcludedName(".hidden.md")).toBe(true)
      expect(isExcludedName(".env")).toBe(true)
      expect(isExcludedName("..")).toBe(true)
      expect(isExcludedName(".")).toBe(true)
    })

    it("node_modules 및 대소문자·끝 점·공백 변형을 제외한다", () => {
      expect(isExcludedName("node_modules")).toBe(true)
      expect(isExcludedName("Node_Modules")).toBe(true)
      expect(isExcludedName("NODE_MODULES")).toBe(true)
      expect(isExcludedName("node_modules.")).toBe(true)
      expect(isExcludedName("node_modules. ")).toBe(true)
      expect(isExcludedName("Node_Modules. ")).toBe(true)
      expect(isExcludedName("NODE_MODULES.   ")).toBe(true)
    })

    it("data-private 및 대소문자·끝 점·공백 변형을 제외한다", () => {
      expect(isExcludedName("data-private")).toBe(true)
      expect(isExcludedName("Data-Private")).toBe(true)
      expect(isExcludedName("DATA-PRIVATE")).toBe(true)
      expect(isExcludedName("data-private.")).toBe(true)
      expect(isExcludedName("Data-Private. ")).toBe(true)
      expect(isExcludedName("DATA-PRIVATE.   ")).toBe(true)
    })

    it("빈 문자열 및 점·공백만 있는 이름을 제외한다", () => {
      expect(isExcludedName("")).toBe(true)
      expect(isExcludedName("   ")).toBe(true)
      expect(isExcludedName("...")).toBe(true)
      expect(isExcludedName(" . ")).toBe(true)
    })

    it("일반 파일·폴더 이름은 허용한다", () => {
      expect(isExcludedName("01. 온보딩")).toBe(false)
      expect(isExcludedName("05. 브랜드·마케팅")).toBe(false)
      expect(isExcludedName("intro.md")).toBe(false)
      expect(isExcludedName("logo.png")).toBe(false)
      expect(isExcludedName("data-public")).toBe(false)
      expect(isExcludedName("my_node_modules")).toBe(false)
    })
  })

  describe("Unit: isHiddenPath", () => {
    it("빈 경로는 출처 루트 자체이므로 false를 반환한다", () => {
      expect(isHiddenPath("")).toBe(false)
    })

    it("일반 경로는 false를 반환한다", () => {
      expect(isHiddenPath("docs/intro.md")).toBe(false)
      expect(isHiddenPath("01. 온보딩/sub/a.md")).toBe(false)
      expect(isHiddenPath("a/b/c.png")).toBe(false)
    })

    it("경로 조각 중 숨김·node_modules·data-private 변형이 있으면 true를 반환한다", () => {
      expect(isHiddenPath(".secret/a.md")).toBe(true)
      expect(isHiddenPath("docs/.secret/a.md")).toBe(true)
      expect(isHiddenPath("docs/.hidden.png")).toBe(true)
      expect(isHiddenPath("node_modules/pkg/index.md")).toBe(true)
      expect(isHiddenPath("docs/Node_Modules./a.md")).toBe(true)
      expect(isHiddenPath("data-private/secret.md")).toBe(true)
      expect(isHiddenPath("docs/Data-Private. /a.md")).toBe(true)
      expect(isHiddenPath("01. 온보딩/DATA-PRIVATE./secret.md")).toBe(true)
    })
  })

  describe("Unit: resolveSourceBase", () => {
    let tempRoot: string

    beforeAll(() => {
      tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adk-resolve-base-"))
      fs.mkdirSync(path.join(tempRoot, "docs"), { recursive: true })

      const companyDir = path.join(tempRoot, "data-company", "co-test")
      fs.mkdirSync(companyDir, { recursive: true })
      const companyConfig = {
        schemaVersion: 1,
        title: "테스트 회사",
        docs: { include: ["01. 온보딩"] },
        repos: [
          {
            id: "my-repo",
            path: "projects/my-repo",
            remote: "https://example.com/repo.git",
            docs: { title: "내 저장소", include: ["docs"] },
          },
        ],
      }
      fs.writeFileSync(path.join(companyDir, "adk-company.json"), JSON.stringify(companyConfig))

      fs.mkdirSync(path.join(tempRoot, "projects", "my-repo", "docs"), { recursive: true })
    })

    afterAll(() => {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true })
      } catch {}
    })

    it("adk 소스를 올바르게 푼다", () => {
      const source = resolveSourceBase(tempRoot, "adk")
      expect(source).not.toBeNull()
      expect(source?.id).toBe("adk")
      expect(source?.title).toBe("ADK 문서")
      expect(source?.baseDir).toBe(path.join(tempRoot, "docs"))
      expect(source?.allowedPrefixes).toBeNull()
    })

    it("회사 소스를 올바르게 푼다", () => {
      const source = resolveSourceBase(tempRoot, "company:co-test")
      expect(source).not.toBeNull()
      expect(source?.id).toBe("company:co-test")
      expect(source?.title).toBe("테스트 회사")
      expect(source?.baseDir).toBe(path.join(tempRoot, "data-company", "co-test"))
      expect(source?.allowedPrefixes).toEqual(["01. 온보딩"])
    })

    it("repo 소스를 올바르게 푼다", () => {
      const source = resolveSourceBase(tempRoot, "my-repo")
      expect(source).not.toBeNull()
      expect(source?.id).toBe("my-repo")
      expect(source?.title).toBe("내 저장소")
      expect(source?.baseDir).toBe(path.resolve(tempRoot, "projects/my-repo"))
      expect(source?.allowedPrefixes).toEqual(["docs"])
    })

    it("존재하지 않는 소스는 null을 반환한다", () => {
      expect(resolveSourceBase(tempRoot, "unknown")).toBeNull()
      expect(resolveSourceBase(tempRoot, "")).toBeNull()
    })
  })

  describe("Unit: resolveSecureDir", () => {
    let tempRoot: string
    let outsideDir: string

    beforeAll(() => {
      tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adk-dir-test-"))
      outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "adk-dir-outside-"))

      const docsDir = path.join(tempRoot, "docs")
      fs.mkdirSync(path.join(docsDir, "normal-folder"), { recursive: true })
      fs.mkdirSync(path.join(docsDir, ".secret-folder"), { recursive: true })
      fs.mkdirSync(path.join(docsDir, "data-private"), { recursive: true })
      fs.mkdirSync(path.join(docsDir, "node_modules"), { recursive: true })
      fs.writeFileSync(path.join(docsDir, "file.md"), "# 파일")

      // 허용 폴더 밖 가리키는 심볼릭 링크 디렉터리
      fs.symlinkSync(outsideDir, path.join(docsDir, "link-outside"))

      // 회사 소스 디렉터리
      const companyDir = path.join(tempRoot, "data-company", "co-dir")
      fs.mkdirSync(path.join(companyDir, "01. 온보딩"), { recursive: true })
    })

    afterAll(() => {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true })
        fs.rmSync(outsideDir, { recursive: true, force: true })
      } catch {}
    })

    it("ADK 출처에서 빈 경로(출처 루트)는 200 반환한다", () => {
      const adkSource = {
        id: "adk",
        title: "ADK 문서",
        baseDir: path.join(tempRoot, "docs"),
        allowedPrefixes: null,
      }
      const res = resolveSecureDir(adkSource, "")
      expect("absPath" in res).toBe(true)
      if ("absPath" in res) {
        expect(res.absPath).toBe(fs.realpathSync.native(path.join(tempRoot, "docs")))
      }
    })

    it("회사 출처에서 빈 경로(출처 루트)는 404를 반환한다 (허용 폴더 밖)", () => {
      const companySource = {
        id: "company:co-dir",
        title: "회사 문서",
        baseDir: path.join(tempRoot, "data-company", "co-dir"),
        allowedPrefixes: ["01. 온보딩"],
      }
      const res = resolveSecureDir(companySource, "")
      expect(res).toEqual({ error: "not_found" })
    })

    it("허용 폴더는 정상적으로 푼다", () => {
      const companySource = {
        id: "company:co-dir",
        title: "회사 문서",
        baseDir: path.join(tempRoot, "data-company", "co-dir"),
        allowedPrefixes: ["01. 온보딩"],
      }
      const res = resolveSecureDir(companySource, "01. 온보딩")
      expect("absPath" in res).toBe(true)
    })

    it("숨김 폴더, data-private, node_modules, 탈출 링크는 거절한다", () => {
      const adkSource = {
        id: "adk",
        title: "ADK 문서",
        baseDir: path.join(tempRoot, "docs"),
        allowedPrefixes: null,
      }
      expect(resolveSecureDir(adkSource, ".secret-folder")).toEqual({ error: "not_found" })
      expect(resolveSecureDir(adkSource, "data-private")).toEqual({ error: "not_found" })
      expect(resolveSecureDir(adkSource, "node_modules")).toEqual({ error: "not_found" })
      expect(resolveSecureDir(adkSource, "link-outside")).toEqual({ error: "not_found" })
      // 파일 경로는 폴더가 아니므로 거절
      expect(resolveSecureDir(adkSource, "file.md")).toEqual({ error: "not_found" })
    })
  })

  describe("Integration: /doc, /asset, 트리, 검색 보호 & 심볼릭 링크 검증", () => {
    let tempRoot: string
    let app: Awaited<ReturnType<typeof createServer>>

    beforeAll(async () => {
      tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adk-portal-w1a1-"))
      const docsDir = path.join(tempRoot, "docs")
      fs.mkdirSync(docsDir, { recursive: true })

      // 1. 정상 파일
      fs.writeFileSync(path.join(docsDir, "intro.md"), "# 소개 문서\n일반 내용 및 검색키워드일치")
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      fs.writeFileSync(path.join(docsDir, "normal.png"), pngHeader)

      // 2. 숨김 폴더 및 파일
      const secretDir = path.join(docsDir, ".secret")
      fs.mkdirSync(secretDir, { recursive: true })
      fs.writeFileSync(path.join(secretDir, "a.md"), "# 숨김 폴더 안 문서\n내용 및 검색키워드일치")
      fs.writeFileSync(path.join(secretDir, "a.png"), pngHeader)

      fs.writeFileSync(path.join(docsDir, ".hidden.md"), "# 숨김 파일 문서\n검색키워드일치")
      fs.writeFileSync(path.join(docsDir, ".hidden.png"), pngHeader)

      // 3. node_modules 및 변형
      const nmDir = path.join(docsDir, "node_modules")
      fs.mkdirSync(nmDir, { recursive: true })
      fs.writeFileSync(path.join(nmDir, "pkg.md"), "# 노드모듈 문서\n검색키워드일치")
      fs.writeFileSync(path.join(nmDir, "pkg.png"), pngHeader)

      const nmVariantDir = path.join(docsDir, "Node_Modules. ")
      fs.mkdirSync(nmVariantDir, { recursive: true })
      fs.writeFileSync(path.join(nmVariantDir, "sub.md"), "# 변형 노드모듈 문서\n검색키워드일치")

      // 4. data-private 및 변형
      const dpDir = path.join(docsDir, "data-private")
      fs.mkdirSync(dpDir, { recursive: true })
      fs.writeFileSync(path.join(dpDir, "secret.md"), "# 데이터프라이빗 문서\n검색키워드일치")
      fs.writeFileSync(path.join(dpDir, "secret.png"), pngHeader)

      const dpVariantDir = path.join(docsDir, "Data-Private. ")
      fs.mkdirSync(dpVariantDir, { recursive: true })
      fs.writeFileSync(path.join(dpVariantDir, "secret2.md"), "# 변형 데이터프라이빗 문서\n검색키워드일치")

      // 5. 심볼릭 링크 사례:
      // 링크 이름에는 점·data-private·node_modules가 없고, 대상만 숨김 폴더 안에 있는 파일!
      fs.symlinkSync(path.join(secretDir, "a.md"), path.join(docsDir, "symlink-doc.md"))
      fs.symlinkSync(path.join(secretDir, "a.png"), path.join(docsDir, "symlink-asset.png"))
      // 추가: 대상이 data-private 파일인 심볼릭 링크
      fs.symlinkSync(path.join(dpDir, "secret.md"), path.join(docsDir, "symlink-dp-doc.md"))

      app = await createServer({ root: tempRoot, port: 0, host: "127.0.0.1" })
    })

    afterAll(async () => {
      await app.close()
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true })
      } catch {}
    })

    it("GET /api/portal/doc: 정상 문서는 200", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/portal/doc?source=adk&path=intro.md",
        headers: { host: "localhost:0" },
      })
      expect(res.statusCode).toBe(200)
      expect(res.payload).toContain("# 소개 문서")
    })

    it("GET /api/portal/doc: 숨김 파일·숨김 폴더·data-private·node_modules·변형 이름은 모두 404", async () => {
      const pathsToTest = [
        ".hidden.md",
        ".secret/a.md",
        "node_modules/pkg.md",
        "Node_Modules. /sub.md",
        "data-private/secret.md",
        "Data-Private. /secret2.md",
        "DATA-PRIVATE/secret.md",
      ]

      for (const p of pathsToTest) {
        const res = await app.inject({
          method: "GET",
          url: `/api/portal/doc?source=adk&path=${encodeURIComponent(p)}`,
          headers: { host: "localhost:0" },
        })
        expect(res.statusCode, `Expected 404 for doc path: ${p}`).toBe(404)
      }
    })

    it("GET /api/portal/doc 심볼릭 링크 사례: 링크 이름은 일반 이름이고 대상만 숨김 파일인 경우 404 차단", async () => {
      // 고치기 전에는 200이었으나, 이제 realpath 기준 상대경로 검사로 404 거절됨
      const res = await app.inject({
        method: "GET",
        url: "/api/portal/doc?source=adk&path=symlink-doc.md",
        headers: { host: "localhost:0" },
      })
      expect(res.statusCode).toBe(404)

      const resDp = await app.inject({
        method: "GET",
        url: "/api/portal/doc?source=adk&path=symlink-dp-doc.md",
        headers: { host: "localhost:0" },
      })
      expect(resDp.statusCode).toBe(404)
    })

    it("GET /api/portal/asset: 정상 그림은 200", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/portal/asset?source=adk&path=normal.png",
        headers: { host: "localhost:0" },
      })
      expect(res.statusCode).toBe(200)
      expect(res.headers["content-type"]).toBe("image/png")
    })

    it("GET /api/portal/asset: 숨김 파일·숨김 폴더·data-private·node_modules는 404", async () => {
      const assetPaths = [
        ".hidden.png",
        ".secret/a.png",
        "node_modules/pkg.png",
        "data-private/secret.png",
      ]

      for (const p of assetPaths) {
        const res = await app.inject({
          method: "GET",
          url: `/api/portal/asset?source=adk&path=${encodeURIComponent(p)}`,
          headers: { host: "localhost:0" },
        })
        expect(res.statusCode, `Expected 404 for asset path: ${p}`).toBe(404)
      }
    })

    it("GET /api/portal/asset 심볼릭 링크 사례: 링크 이름은 일반 이름이고 대상만 숨김 파일인 경우 404 차단", async () => {
      // 고치기 전에는 200이었으나, 이제 realpath 기준 상대경로 검사로 404 거절됨
      const res = await app.inject({
        method: "GET",
        url: "/api/portal/asset?source=adk&path=symlink-asset.png",
        headers: { host: "localhost:0" },
      })
      expect(res.statusCode).toBe(404)
    })

    it("GET /api/portal: 트리에서 숨김 폴더·파일·node_modules·data-private 변형이 모두 빠짐", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/portal",
        headers: { host: "localhost:0" },
      })
      expect(res.statusCode).toBe(200)
      const data = JSON.parse(res.payload)
      const adkSource = data.sources.find((s: any) => s.id === "adk")
      expect(adkSource).toBeDefined()

      // 트리에 나타나는 모든 이름 수집
      function collectNames(nodes: any[]): string[] {
        const names: string[] = []
        for (const node of nodes) {
          names.push(node.name)
          if (node.children) names.push(...collectNames(node.children))
        }
        return names
      }

      const allTreeNames = collectNames(adkSource.tree)
      expect(allTreeNames).toContain("intro.md")

      // 제외 대상 이름들이 트리에 없어야 함
      expect(allTreeNames).not.toContain(".secret")
      expect(allTreeNames).not.toContain(".hidden.md")
      expect(allTreeNames).not.toContain("node_modules")
      expect(allTreeNames).not.toContain("Node_Modules. ")
      expect(allTreeNames).not.toContain("data-private")
      expect(allTreeNames).not.toContain("Data-Private. ")
      // 심볼릭 링크 파일은 .secret을 가리키므로 트리에 포함되지 않아야 함 (symlink-doc.md)
      // 파일 자체 이름이 허용 폴더 안에 있어도 realpath 검사 대상
    })

    it("GET /api/portal/search: 검색 대상에서 숨김·제외 파일 및 심볼릭 링크 제외", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/portal/search?q=검색키워드일치",
        headers: { host: "localhost:0" },
      })
      expect(res.statusCode).toBe(200)
      const data = JSON.parse(res.payload)
      const resultPaths = data.results.map((r: any) => r.path)

      // intro.md만 결과에 나와야 하고, 숨김/제외 폴더 내 파일이나 심볼릭 링크는 나오지 않아야 함
      expect(resultPaths).toContain("intro.md")
      expect(resultPaths).not.toContain(".hidden.md")
      expect(resultPaths).not.toContain(".secret/a.md")
      expect(resultPaths).not.toContain("node_modules/pkg.md")
      expect(resultPaths).not.toContain("Node_Modules. /sub.md")
      expect(resultPaths).not.toContain("data-private/secret.md")
      expect(resultPaths).not.toContain("Data-Private. /secret2.md")
      expect(resultPaths).not.toContain("symlink-doc.md")
    })
  })
})
