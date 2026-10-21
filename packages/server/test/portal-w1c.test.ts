import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import Fastify, { FastifyInstance } from "fastify"
import { portalRoutes, getSourcesAndBoard, resolveSourceBase } from "../src/routes/portal.js"
import {
  evaluateViewFolder,
  readViewFoldersFile,
  writeViewFoldersFile,
  resolveFolderContext,
  expandHomePath,
  type FolderCheckContext,
} from "../src/view-folders.js"
import { writeProxySecret, getProxySecretDir } from "../src/security.js"
import { createServer } from "../src/server.js"
// @ts-ignore
import {
  validateFolder as validateToolFolder,
  resolveContext as resolveToolContext,
  getSecretDir as getToolSecretDir,
  writeConfigFile as writeToolConfigFile,
} from "../../../scripts/view-folders.mjs"

describe("W1c 데이터 폴더 단위 및 통합 시험 (vitest)", () => {
  let testRoot: string
  let fakeHome: string
  let fakeWs: string
  let fakeTmp: string
  let fakeXdg: string
  let fakeSecretDir: string
  let context: FolderCheckContext

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portal-w1c-test-"))
    fakeHome = path.join(testRoot, "home")
    fakeWs = path.join(testRoot, "ws")
    fakeTmp = path.join(testRoot, "tmp")
    fakeXdg = path.join(testRoot, "xdg")
    fakeSecretDir = path.join(fakeXdg, "naia-adk")

    fs.mkdirSync(fakeHome, { recursive: true })
    fs.mkdirSync(fakeWs, { recursive: true })
    fs.mkdirSync(fakeTmp, { recursive: true })
    fs.mkdirSync(fakeXdg, { recursive: true })
    fs.mkdirSync(fakeSecretDir, { recursive: true })

    // WS 내부에 docs 폴더 생성 (adk docs)
    fs.mkdirSync(path.join(fakeWs, "docs"), { recursive: true })
    fs.writeFileSync(path.join(fakeWs, "docs", "adk-doc.md"), "# ADK Index Document")

    context = {
      homeDir: fakeHome,
      workspaceRoot: fakeWs,
      tmpDir: fakeTmp,
      xdgRuntimeDir: fakeXdg,
      secretDir: fakeSecretDir,
    }
  })

  afterEach(() => {
    try {
      fs.rmSync(testRoot, { recursive: true, force: true })
    } catch {}
  })

  it("1. id 형식 및 중복 검사", () => {
    const foldersDir = path.join(fakeWs, ".agents", "work")
    fs.mkdirSync(foldersDir, { recursive: true })

    const sampleContent = {
      schemaVersion: 1,
      folders: [
        { id: "valid-1", label: "Valid 1", path: "~/data1" },
        { id: "INVALID_UPPER", label: "Bad Upper", path: "~/data2" },
        { id: "valid-1", label: "Duplicate", path: "~/data3" },
        { id: "toolong-" + "a".repeat(40), label: "Too Long", path: "~/data4" },
        { id: "valid-2", label: "Valid 2", path: "~/data5", tab: "brand" },
        { id: "bad-tab", label: "Bad Tab", path: "~/data6", tab: "invalid_tab" },
      ],
    }
    fs.writeFileSync(path.join(foldersDir, "view-folders.json"), JSON.stringify(sampleContent))

    const { folders, errors } = readViewFoldersFile(fakeWs)
    expect(folders).toHaveLength(2)
    expect(folders[0].id).toBe("valid-1")
    expect(folders[0].tab).toBe("common")
    expect(folders[1].id).toBe("valid-2")
    expect(folders[1].tab).toBe("brand")
    expect(errors.length).toBeGreaterThanOrEqual(4)
  })

  it("2. ~/ 풀기: fakeHome으로 정상 확장된다", () => {
    const expanded = expandHomePath("~/sample-dir/sub", fakeHome)
    expect(expanded).toBe(path.join(fakeHome, "sample-dir", "sub"))

    const expandedTilde = expandHomePath("~", fakeHome)
    expect(expandedTilde).toBe(fakeHome)
  })

  it("3. 금지 1: 보호 폴더(홈·루트·임시·XDG·비밀폴더) 자신과 그것을 품은 폴더 거절", () => {
    const resolvedCtx = resolveFolderContext(fakeWs, context)

    // 홈 자신 거절
    const rHome = evaluateViewFolder({ id: "t1", label: "L", path: "~" }, resolvedCtx)
    expect(rHome.status).toBe("forbidden")

    // 홈 상위 거절
    const rHomeParent = evaluateViewFolder({ id: "t2", label: "L", path: testRoot }, resolvedCtx)
    expect(rHomeParent.status).toBe("forbidden")

    // 루트 / 거절
    const rRoot = evaluateViewFolder({ id: "t3", label: "L", path: "/" }, resolvedCtx)
    expect(rRoot.status).toBe("forbidden")

    // 작업공간 루트 거절
    const rWs = evaluateViewFolder({ id: "t4", label: "L", path: fakeWs }, resolvedCtx)
    expect(rWs.status).toBe("forbidden")

    // 임시 폴더 자신 거절
    const rTmp = evaluateViewFolder({ id: "t5", label: "L", path: fakeTmp }, resolvedCtx)
    expect(rTmp.status).toBe("forbidden")

    // XDG 런타임 폴더 거절
    const rXdg = evaluateViewFolder({ id: "t6", label: "L", path: fakeXdg }, resolvedCtx)
    expect(rXdg.status).toBe("forbidden")

    // 비밀 폴더 자신 거절
    const rSecret = evaluateViewFolder({ id: "t7", label: "L", path: fakeSecretDir }, resolvedCtx)
    expect(rSecret.status).toBe("forbidden")
  })

  it("4. 금지 2: 표시 파일(.naia-view) 없는 숨김 조각·홈 밖 거절, 표시 파일 있으면 허용", () => {
    const resolvedCtx = resolveFolderContext(fakeWs, context)

    // 4-1. 홈 밖 (fakeTmp 아래)
    const outDir = path.join(fakeTmp, "out-data")
    fs.mkdirSync(outDir, { recursive: true })

    // .naia-view 없음 -> 거절
    const rOutNoView = evaluateViewFolder({ id: "out1", label: "Out", path: outDir }, resolvedCtx)
    expect(rOutNoView.status).toBe("forbidden")

    // .naia-view 있음 -> 허용
    fs.writeFileSync(path.join(outDir, ".naia-view"), "")
    const rOutWithView = evaluateViewFolder({ id: "out2", label: "Out", path: outDir }, resolvedCtx)
    expect(rOutWithView.status).toBe("ok")

    // 4-2. 홈 안 숨김 조각 (fakeHome/.local/share/content)
    const hiddenDir = path.join(fakeHome, ".local", "share", "content")
    fs.mkdirSync(hiddenDir, { recursive: true })

    // .naia-view 없음 -> 거절
    const rHiddenNoView = evaluateViewFolder({ id: "h1", label: "H", path: "~/.local/share/content" }, resolvedCtx)
    expect(rHiddenNoView.status).toBe("forbidden")

    // .naia-view 있음 -> 허용
    fs.writeFileSync(path.join(hiddenDir, ".naia-view"), "")
    const rHiddenWithView = evaluateViewFolder({ id: "h2", label: "H", path: "~/.local/share/content" }, resolvedCtx)
    expect(rHiddenWithView.status).toBe("ok")

    // 4-3. 홈 안 일반 폴더 (fakeHome/documents/my-data)
    const normalDir = path.join(fakeHome, "documents", "my-data")
    fs.mkdirSync(normalDir, { recursive: true })
    const rNormal = evaluateViewFolder({ id: "n1", label: "Normal", path: "~/documents/my-data" }, resolvedCtx)
    expect(rNormal.status).toBe("ok")
  })

  it("5. 금지 3: 조각에 data-private, .git, node_modules가 든 폴더 거절 (.naia-view 있어도 거절)", () => {
    const resolvedCtx = resolveFolderContext(fakeWs, context)

    const p1 = path.join(fakeHome, "projects", "data-private", "my-notes")
    fs.mkdirSync(p1, { recursive: true })
    fs.writeFileSync(path.join(p1, ".naia-view"), "") // .naia-view 있어도 금지 3 적용
    const r1 = evaluateViewFolder({ id: "p1", label: "P", path: "~/projects/data-private/my-notes" }, resolvedCtx)
    expect(r1.status).toBe("forbidden")

    const p2 = path.join(fakeHome, "projects", "node_modules", "pkg")
    fs.mkdirSync(p2, { recursive: true })
    fs.writeFileSync(path.join(p2, ".naia-view"), "")
    const r2 = evaluateViewFolder({ id: "p2", label: "P", path: "~/projects/node_modules/pkg" }, resolvedCtx)
    expect(r2.status).toBe("forbidden")

    const p3 = path.join(fakeHome, "repo", ".git", "hooks")
    fs.mkdirSync(p3, { recursive: true })
    fs.writeFileSync(path.join(p3, ".naia-view"), "")
    const r3 = evaluateViewFolder({ id: "p3", label: "P", path: "~/repo/.git/hooks" }, resolvedCtx)
    expect(r3.status).toBe("forbidden")
  })

  it("6. 링크로 우회: 입력은 보통 경로, 실경로는 금지 경로 -> 거절", () => {
    const resolvedCtx = resolveFolderContext(fakeWs, context)

    const sshDir = path.join(fakeHome, ".ssh")
    fs.mkdirSync(sshDir, { recursive: true })

    const symlinkPath = path.join(fakeHome, "innocent-link")
    fs.symlinkSync(sshDir, symlinkPath, "dir")

    const r = evaluateViewFolder({ id: "bypass", label: "Bypass", path: "~/innocent-link" }, resolvedCtx)
    expect(r.status).toBe("forbidden")
  })

  it("7. 등록 뒤 링크가 금지 경로로 바뀌면 서버가 붙이지 않음", () => {
    const okTarget = path.join(fakeHome, "ok-target")
    fs.mkdirSync(okTarget, { recursive: true })

    const symlinkPath = path.join(fakeHome, "switch-link")
    fs.symlinkSync(okTarget, symlinkPath, "dir")

    // 처음 등록
    writeViewFoldersFile(fakeWs, [
      { id: "switch", label: "Switch", path: "~/switch-link" },
    ])

    // 처음에는 정상 조회됨
    const initial = getSourcesAndBoard(fakeWs, context)
    const initialSource = initial.sources.find((s) => s.id === "data:switch")
    expect(initialSource).toBeDefined()
    expect(initialSource?.missing).toBeUndefined()

    // 심볼릭 링크를 금지 경로(.ssh)로 변경
    fs.unlinkSync(symlinkPath)
    const sshDir = path.join(fakeHome, ".ssh")
    fs.mkdirSync(sshDir, { recursive: true })
    fs.symlinkSync(sshDir, symlinkPath, "dir")

    // 다시 서버에서 조회하면 출처 목록에서 제외됨
    const updated = getSourcesAndBoard(fakeWs, context)
    const updatedSource = updated.sources.find((s) => s.id === "data:switch")
    expect(updatedSource).toBeUndefined()

    // resolveSourceBase에서도 null 반환
    const baseResult = resolveSourceBase(fakeWs, "data:switch", context)
    expect(baseResult).toBeNull()
  })

  it("8. 없는 폴더는 missing: true 빈 출처", () => {
    writeViewFoldersFile(fakeWs, [
      { id: "vanished", label: "Vanished", path: "~/does-not-exist" },
    ])

    const { sources } = getSourcesAndBoard(fakeWs, context)
    const missingSource = sources.find((s) => s.id === "data:vanished")
    expect(missingSource).toBeDefined()
    expect(missingSource?.missing).toBe(true)
    expect(missingSource?.tree).toEqual([])
    expect(missingSource?.readOnly).toBe(true)
    expect(missingSource?.tab).toBe("common")
  })

  it("9. 깨진 파일은 데이터 폴더 없음으로 동작", () => {
    const filePath = path.join(fakeWs, ".agents", "work", "view-folders.json")
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, "{ invalid json content ...")

    const { sources } = getSourcesAndBoard(fakeWs, context)
    const dataSources = sources.filter((s) => s.id.startsWith("data:"))
    expect(dataSources).toHaveLength(0)

    // adk 출처는 정상 존재
    const adkSource = sources.find((s) => s.id === "adk")
    expect(adkSource).toBeDefined()
  })

  it("10. readOnly: true 속성 확인", () => {
    const validDir = path.join(fakeHome, "valid-data")
    fs.mkdirSync(validDir, { recursive: true })
    fs.writeFileSync(path.join(validDir, "doc.md"), "# Document")

    writeViewFoldersFile(fakeWs, [
      { id: "my-data", label: "My Data", path: "~/valid-data", tab: "brand" },
    ])

    const { sources, resolvedSources } = getSourcesAndBoard(fakeWs, context)
    const source = sources.find((s) => s.id === "data:my-data")
    expect(source).toBeDefined()
    expect(source?.readOnly).toBe(true)
    expect(source?.tab).toBe("brand")

    const resolved = resolvedSources.get("data:my-data")
    expect(resolved).toBeDefined()
    expect(resolved?.readOnly).toBe(true)
  })

  it("11. 데이터 폴더 안의 data-private 및 숨김 경로 거절", () => {
    const dataDir = path.join(fakeHome, "safe-data")
    fs.mkdirSync(dataDir, { recursive: true })

    // 정상 파일
    fs.writeFileSync(path.join(dataDir, "regular.md"), "# Regular")
    // 숨김 폴더 및 파일
    const hiddenSub = path.join(dataDir, ".hidden-dir")
    fs.mkdirSync(hiddenSub, { recursive: true })
    fs.writeFileSync(path.join(hiddenSub, "secret.md"), "# Secret")
    // data-private 폴더 및 파일
    const privateSub = path.join(dataDir, "data-private")
    fs.mkdirSync(privateSub, { recursive: true })
    fs.writeFileSync(path.join(privateSub, "private.md"), "# Private")

    writeViewFoldersFile(fakeWs, [
      { id: "safe", label: "Safe", path: "~/safe-data" },
    ])

    const { sources } = getSourcesAndBoard(fakeWs, context)
    const safeSource = sources.find((s) => s.id === "data:safe")
    expect(safeSource).toBeDefined()

    // 트리 검사: regular.md만 있고 .hidden-dir과 data-private는 제외되어야 함
    const treeNames = safeSource?.tree.map((n) => n.name)
    expect(treeNames).toContain("regular.md")
    expect(treeNames).not.toContain(".hidden-dir")
    expect(treeNames).not.toContain("data-private")
  })

  it("12. Fastify 라우트 단위/통합 시험: untrusted 시 data: 403 및 트리/검색 제외, adk는 200 유지", async () => {
    const TEST_PORT = 3177
    const proxySecret = "test-secret-32-bytes-w1c-1234567"

    // 데이터 폴더 설정
    const dataDir = path.join(fakeHome, "portal-data")
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, "page.md"), "# Sample Data Page")
    fs.writeFileSync(path.join(dataDir, "image.png"), "fake png bytes")
    fs.writeFileSync(path.join(dataDir, "note.txt"), "text content")

    writeViewFoldersFile(fakeWs, [
      { id: "testdata", label: "Test Data", path: "~/portal-data", tab: "developer" },
    ])

    // Fastify 앱 생성
    const app = await createServer({
      root: fakeWs,
      port: TEST_PORT,
      host: "127.0.0.1",
      folderCheckContext: context,
    })
    ;(app as any).proxySecret = proxySecret

    const untrustedHeaders = { host: `localhost:${TEST_PORT}` }
    const trustedHeaders = {
      host: `localhost:${TEST_PORT}`,
      "x-naia-proxy-secret": proxySecret,
      "x-naia-peer": "127.0.0.1",
    }

    // A. untrusted: GET /api/portal
    // 200이지만 data: 출처는 빠져야 하고 adk는 남아 있어야 함
    const resPortalUntrusted = await app.inject({
      method: "GET",
      url: "/api/portal",
      headers: untrustedHeaders,
    })
    expect(resPortalUntrusted.statusCode).toBe(200)
    const portalBodyUntrusted = resPortalUntrusted.json()
    const sourceIdsUntrusted = portalBodyUntrusted.sources.map((s: any) => s.id)
    expect(sourceIdsUntrusted).toContain("adk")
    expect(sourceIdsUntrusted).not.toContain("data:testdata")

    // B. untrusted: GET /api/portal/search
    // 200이고 data: 출처 문서는 안 나오고 adk 문서는 나와야 함
    const resSearchUntrusted = await app.inject({
      method: "GET",
      url: "/api/portal/search?q=Document",
      headers: untrustedHeaders,
    })
    expect(resSearchUntrusted.statusCode).toBe(200)
    const searchBodyUntrusted = resSearchUntrusted.json()
    expect(searchBodyUntrusted.results.some((r: any) => r.source === "adk")).toBe(true)
    expect(searchBodyUntrusted.results.some((r: any) => r.source.startsWith("data:"))).toBe(false)

    // C. untrusted: data: 출처의 /doc, /asset, /folder, /text -> 모두 403
    const resDocUntrusted = await app.inject({
      method: "GET",
      url: "/api/portal/doc?source=data:testdata&path=page.md",
      headers: untrustedHeaders,
    })
    expect(resDocUntrusted.statusCode).toBe(403)

    const resAssetUntrusted = await app.inject({
      method: "GET",
      url: "/api/portal/asset?source=data:testdata&path=image.png",
      headers: untrustedHeaders,
    })
    expect(resAssetUntrusted.statusCode).toBe(403)

    const resFolderUntrusted = await app.inject({
      method: "GET",
      url: "/api/portal/folder?source=data:testdata",
      headers: untrustedHeaders,
    })
    expect(resFolderUntrusted.statusCode).toBe(403)

    const resTextUntrusted = await app.inject({
      method: "GET",
      url: "/api/portal/text?source=data:testdata&path=note.txt",
      headers: untrustedHeaders,
    })
    expect(resTextUntrusted.statusCode).toBe(403)

    // D. 같은 untrusted 요청에서 기존 adk 출처 md /doc은 200 유지
    const resAdkDoc = await app.inject({
      method: "GET",
      url: "/api/portal/doc?source=adk&path=adk-doc.md",
      headers: untrustedHeaders,
    })
    expect(resAdkDoc.statusCode).toBe(200)
    expect(resAdkDoc.body).toContain("# ADK Index Document")

    // E. trusted: GET /api/portal -> data: 출처 포함
    const resPortalTrusted = await app.inject({
      method: "GET",
      url: "/api/portal",
      headers: trustedHeaders,
    })
    expect(resPortalTrusted.statusCode).toBe(200)
    const portalBodyTrusted = resPortalTrusted.json()
    const sourceIdsTrusted = portalBodyTrusted.sources.map((s: any) => s.id)
    expect(sourceIdsTrusted).toContain("data:testdata")

    // F. trusted: data: 출처 /doc, /asset, /folder, /text -> 200
    const resDocTrusted = await app.inject({
      method: "GET",
      url: "/api/portal/doc?source=data:testdata&path=page.md",
      headers: trustedHeaders,
    })
    expect(resDocTrusted.statusCode).toBe(200)
    expect(resDocTrusted.body).toContain("# Sample Data Page")

    const resAssetTrusted = await app.inject({
      method: "GET",
      url: "/api/portal/asset?source=data:testdata&path=image.png",
      headers: trustedHeaders,
    })
    expect(resAssetTrusted.statusCode).toBe(200)

    const resFolderTrusted = await app.inject({
      method: "GET",
      url: "/api/portal/folder?source=data:testdata",
      headers: trustedHeaders,
    })
    expect(resFolderTrusted.statusCode).toBe(200)

    const resTextTrusted = await app.inject({
      method: "GET",
      url: "/api/portal/text?source=data:testdata&path=note.txt",
      headers: trustedHeaders,
    })
    expect(resTextTrusted.statusCode).toBe(200)

    await app.close()
  })

  describe("W1c-2 검수 결함 수정 검증 시험", () => {
    it("결함 1: 환경 변수를 바꿔도 인자 없는 문맥 함수는 os.homedir() 고정 및 /etc 거절", () => {
      const origEnv = { ...process.env }
      try {
        process.env.NAIA_TEST_HOME = "/"
        process.env.NAIA_TEST_TMP = "/"
        process.env.NAIA_TEST_SECRET_DIR = "/"

        // 서버 인자 없는 문맥 함수
        const serverCtx = resolveFolderContext(fakeWs)
        expect(serverCtx.homeDir).toBe(os.homedir())
        expect(serverCtx.tmpDir).toBe(os.tmpdir())
        expect(serverCtx.secretDir).toBe(getProxySecretDir())
        expect(serverCtx.xdgRuntimeDir).toBe(process.env.XDG_RUNTIME_DIR)

        // 도구 인자 없는 문맥 함수
        const toolCtx = resolveToolContext(fakeWs)
        expect(toolCtx.homeDir).toBe(os.homedir())
        expect(toolCtx.tmpDir).toBe(os.tmpdir())
        expect(toolCtx.secretDir).toBe(getProxySecretDir())
        expect(toolCtx.xdgRuntimeDir).toBe(process.env.XDG_RUNTIME_DIR)

        // 이 상태에서 /etc 등록은 서버와 도구 둘 다 거절됨
        const rServerEtc = evaluateViewFolder({ id: "etc", label: "Etc", path: "/etc" }, serverCtx)
        expect(rServerEtc.status).toBe("forbidden")

        const rToolEtc = validateToolFolder("/etc", toolCtx)
        expect(rToolEtc.ok).toBe(false)
        expect(rToolEtc.status).toBe("forbidden")
      } finally {
        process.env = origEnv
      }
    })

    it("결함 2: 비밀 폴더·XDG 기본값은 인자를 비운 서버·도구 문맥 함수가 서로 같고 getProxySecretDir()·XDG_RUNTIME_DIR과 같음", () => {
      const serverCtx = resolveFolderContext(fakeWs)
      const toolCtx = resolveToolContext(fakeWs)

      expect(serverCtx.secretDir).toBe(toolCtx.secretDir)
      expect(serverCtx.secretDir).toBe(getProxySecretDir())

      expect(serverCtx.xdgRuntimeDir).toBe(toolCtx.xdgRuntimeDir)
      expect(serverCtx.xdgRuntimeDir).toBe(process.env.XDG_RUNTIME_DIR)

      expect(serverCtx.homeDir).toBe(toolCtx.homeDir)
      expect(serverCtx.homeDir).toBe(os.homedir())

      expect(serverCtx.tmpDir).toBe(toolCtx.tmpDir)
      expect(serverCtx.tmpDir).toBe(os.tmpdir())
    })

    it("결함 2 & 4 & 5-(다): 하나의 사례 표로 서버 evaluateViewFolder와 도구 판정 함수가 FE 기대 상태와 일치함을 교차 검증", () => {
      // 가짜 홈 안에 필요한 실제 폴더, 파일, 심볼릭 링크 생성
      const normalNoView = path.join(fakeHome, "normal-no-view")
      fs.mkdirSync(normalNoView, { recursive: true })

      const normalWithView = path.join(fakeHome, "normal-with-view")
      fs.mkdirSync(normalWithView, { recursive: true })
      fs.writeFileSync(path.join(normalWithView, ".naia-view"), "")

      const outNoView = path.join(fakeTmp, "out-no-view")
      fs.mkdirSync(outNoView, { recursive: true })

      const outWithView = path.join(fakeTmp, "out-with-view")
      fs.mkdirSync(outWithView, { recursive: true })
      fs.writeFileSync(path.join(outWithView, ".naia-view"), "")

      const hiddenNoView = path.join(fakeHome, ".local", "share", "app-no-view")
      fs.mkdirSync(hiddenNoView, { recursive: true })

      const hiddenWithView = path.join(fakeHome, ".local", "share", "app-with-view")
      fs.mkdirSync(hiddenWithView, { recursive: true })
      fs.writeFileSync(path.join(hiddenWithView, ".naia-view"), "")

      const privNoView = path.join(fakeHome, "data-private", "sub-no-view")
      fs.mkdirSync(privNoView, { recursive: true })

      const privWithView = path.join(fakeHome, "data-private", "sub-with-view")
      fs.mkdirSync(privWithView, { recursive: true })
      fs.writeFileSync(path.join(privWithView, ".naia-view"), "")

      const gitDir = path.join(fakeHome, "repo", ".git", "hooks")
      fs.mkdirSync(gitDir, { recursive: true })

      const nodeModulesDir = path.join(fakeHome, "project", "node_modules", "pkg")
      fs.mkdirSync(nodeModulesDir, { recursive: true })

      const sshDir = path.join(fakeHome, ".ssh")
      fs.mkdirSync(sshDir, { recursive: true })
      const linkToSsh = path.join(fakeHome, "symlink-bypass")
      try {
        fs.symlinkSync(sshDir, linkToSsh, "dir")
      } catch {}

      const realFile = path.join(fakeHome, "docs-file.txt")
      fs.writeFileSync(realFile, "I am a file, not a folder")

      const nonExistent = path.join(fakeHome, "does-not-exist-dir-999")

      // 속성 사례 디렉토리
      const leafHidden = path.join(fakeHome, "docs", "leaf-hidden")
      fs.mkdirSync(leafHidden, { recursive: true })

      const leafSystem = path.join(fakeHome, "docs", "leaf-system")
      fs.mkdirSync(leafSystem, { recursive: true })

      const ancestorHidden = path.join(fakeHome, "ancestor-hidden")
      const ancestorChild = path.join(ancestorHidden, "child")
      fs.mkdirSync(ancestorChild, { recursive: true })

      const noBitDir = path.join(fakeHome, "docs", "no-bit-dir")
      fs.mkdirSync(noBitDir, { recursive: true })

      const bitWithViewDir = path.join(fakeHome, "docs", "bit-with-view")
      fs.mkdirSync(bitWithViewDir, { recursive: true })
      fs.writeFileSync(path.join(bitWithViewDir, ".naia-view"), "")

      const pathAttrs: Record<string, any> = {
        [path.resolve(leafHidden)]: { hidden: true },
        [path.resolve(leafSystem)]: { system: true },
        [path.resolve(ancestorHidden)]: { hidden: true },
        [path.resolve(bitWithViewDir)]: { hidden: true, system: true },
      }

      // 서버 및 도구 문맥 준비
      const serverCtx = resolveFolderContext(fakeWs, {
        ...context,
        pathAttributes: pathAttrs,
      })
      const toolCtx = resolveToolContext(fakeWs, {
        homeDir: fakeHome,
        workspaceRoot: fakeWs,
        tmpDir: fakeTmp,
        xdgRuntimeDir: fakeXdg,
        secretDir: fakeSecretDir,
        pathAttributes: pathAttrs,
      })

      // 하나의 사례 표 (FE 기대 상태 정의)
      const caseTable: Array<{
        name: string
        rawPath: string
        expected: "ok" | "forbidden" | "missing"
      }> = [
        // 금지 1 (보호 폴더)
        { name: "금지 1: 홈 자신", rawPath: "~", expected: "forbidden" },
        { name: "금지 1: 홈 상위", rawPath: testRoot, expected: "forbidden" },
        { name: "금지 1: 루트", rawPath: "/", expected: "forbidden" },
        { name: "금지 1: 작업공간 루트", rawPath: fakeWs, expected: "forbidden" },
        { name: "금지 1: 임시 폴더", rawPath: fakeTmp, expected: "forbidden" },
        { name: "금지 1: XDG 런타임 폴더", rawPath: fakeXdg, expected: "forbidden" },
        { name: "금지 1: 비밀 폴더", rawPath: fakeSecretDir, expected: "forbidden" },

        // 금지 2 (보통 폴더 / 홈 밖 / 숨김 조각과 .naia-view 유무)
        { name: "금지 2: 홈 안 보통 폴더 (.naia-view 없음)", rawPath: "~/normal-no-view", expected: "ok" },
        { name: "금지 2: 홈 안 보통 폴더 (.naia-view 있음)", rawPath: "~/normal-with-view", expected: "ok" },
        { name: "금지 2: 홈 밖 폴더 (.naia-view 없음)", rawPath: outNoView, expected: "forbidden" },
        { name: "금지 2: 홈 밖 폴더 (.naia-view 있음)", rawPath: outWithView, expected: "ok" },
        { name: "금지 2: 홈 안 숨김 조각 (.naia-view 없음)", rawPath: "~/.local/share/app-no-view", expected: "forbidden" },
        { name: "금지 2: 홈 안 숨김 조각 (.naia-view 있음)", rawPath: "~/.local/share/app-with-view", expected: "ok" },

        // 금지 3 (금지 세그먼트: 표시 파일 있어도 거절)
        { name: "금지 3: data-private (.naia-view 없음)", rawPath: "~/data-private/sub-no-view", expected: "forbidden" },
        { name: "금지 3: data-private (.naia-view 있음)", rawPath: "~/data-private/sub-with-view", expected: "forbidden" },
        { name: "금지 3: .git", rawPath: "~/repo/.git/hooks", expected: "forbidden" },
        { name: "금지 3: node_modules", rawPath: "~/project/node_modules/pkg", expected: "forbidden" },

        // 링크 우회
        { name: "링크 우회: .ssh를 가리키는 링크", rawPath: "~/symlink-bypass", expected: "forbidden" },

        // 파일 경로 (폴더 아님 -> 서버 forbidden, 도구 forbidden)
        { name: "파일 경로: 폴더가 아닌 실재 파일", rawPath: realFile, expected: "forbidden" },

        // 없는 경로 (서버 missing, 도구 missing & add 거절)
        { name: "없는 경로: 존재하지 않는 디렉토리", rawPath: nonExistent, expected: "missing" },

        // 4번 Windows 숨김·시스템 속성 사례
        { name: "속성 4: 잎만 숨김 (표시 파일 없음)", rawPath: leafHidden, expected: "forbidden" },
        { name: "속성 4: 잎만 시스템 (표시 파일 없음)", rawPath: leafSystem, expected: "forbidden" },
        { name: "속성 4: 조상만 숨김 (표시 파일 없음)", rawPath: ancestorChild, expected: "forbidden" },
        { name: "속성 4: 비트 없음 (표시 파일 없음)", rawPath: noBitDir, expected: "ok" },
        { name: "속성 4: 비트 있음 + 표시 파일 있음", rawPath: bitWithViewDir, expected: "ok" },
      ]

      for (const row of caseTable) {
        // 서버 판정 확인
        const serverResult = evaluateViewFolder(
          { id: "test-row", label: row.name, path: row.rawPath },
          serverCtx,
        )
        expect(
          serverResult.status,
          `[서버] ${row.name} 판정 불일치 (기대: ${row.expected}, 실제: ${serverResult.status})`,
        ).toBe(row.expected)

        // 도구 판정 확인
        const toolResult = validateToolFolder(row.rawPath, toolCtx)
        expect(
          toolResult.status,
          `[도구] ${row.name} 판정 불일치 (기대: ${row.expected}, 실제: ${toolResult.status})`,
        ).toBe(row.expected)

        // 없는 경로 추가 검증: 도구의 ok는 false여야 함 (add는 거절)
        if (row.expected === "missing") {
          expect(toolResult.ok, `[도구] 없는 경로는 add 거절(ok=false)이어야 함`).toBe(false)
        }
      }
    })

    it("결함 5-(가): 믿지 않는 /search에서 data: 출처를 제외하는지 md 본문 낱말로 Fastify inject 호출 검증", async () => {
      const TEST_PORT = 3178
      const proxySecret = "test-secret-32-bytes-w1c2-search"

      // 데이터 폴더 트리에 들어가는 md 본문에만 있는 고유 낱말
      const UNIQUE_SECRET_WORD = "w1c2_unique_untrusted_search_secret_word_xyz789"

      const dataDir = path.join(fakeHome, "data-search-test")
      fs.mkdirSync(dataDir, { recursive: true })
      fs.writeFileSync(
        path.join(dataDir, "exclusive-doc.md"),
        `# Exclusive Data Document\n\nThis body has ${UNIQUE_SECRET_WORD} and nothing else has it.`,
      )

      writeViewFoldersFile(fakeWs, [
        { id: "datasearch", label: "Data Search", path: "~/data-search-test", tab: "brand" },
      ])

      const app = await createServer({
        root: fakeWs,
        port: TEST_PORT,
        host: "127.0.0.1",
        folderCheckContext: context,
      })
      ;(app as any).proxySecret = proxySecret

      const untrustedHeaders = { host: `localhost:${TEST_PORT}` }
      const trustedHeaders = {
        host: `localhost:${TEST_PORT}`,
        "x-naia-proxy-secret": proxySecret,
        "x-naia-peer": "127.0.0.1",
      }

      // (1) 믿지 않는 요청: 0건이어야 함
      const resUntrusted = await app.inject({
        method: "GET",
        url: `/api/portal/search?q=${UNIQUE_SECRET_WORD}`,
        headers: untrustedHeaders,
      })
      expect(resUntrusted.statusCode).toBe(200)
      const bodyUntrusted = resUntrusted.json()
      expect(bodyUntrusted.results).toHaveLength(0)

      // (2) 믿는 요청: 해당 data: 출처 결과가 있어야 함
      const resTrusted = await app.inject({
        method: "GET",
        url: `/api/portal/search?q=${UNIQUE_SECRET_WORD}`,
        headers: trustedHeaders,
      })
      expect(resTrusted.statusCode).toBe(200)
      const bodyTrusted = resTrusted.json()
      expect(bodyTrusted.results.length).toBeGreaterThanOrEqual(1)
      expect(bodyTrusted.results.some((r: any) => r.source === "data:datasearch")).toBe(true)

      await app.close()
    })

    it("결함 5-(나): 서버 writeViewFoldersFile 및 도구 writeConfigFile 원자적 쓰기 순서 및 rename 실패 시 원본 보존", () => {
      // 1) 서버 writeViewFoldersFile 검증
      const initialServerData = [
        { id: "server-orig", label: "Server Original", path: "~/server-orig" },
      ]
      writeViewFoldersFile(fakeWs, initialServerData)

      const serverFilePath = path.join(fakeWs, ".agents", "work", "view-folders.json")
      const serverOrigBytes = fs.readFileSync(serverFilePath)

      let serverWriteCalledFirst = false
      const origWriteFileSync = fs.writeFileSync
      const origRenameSync = fs.renameSync

      try {
        fs.writeFileSync = function (file: any, data: any, options: any) {
          if (typeof file === "string" && file.includes(".tmp.")) {
            serverWriteCalledFirst = true
          }
          return origWriteFileSync.call(fs, file, data, options)
        }

        fs.renameSync = function (oldPath: any, newPath: any) {
          expect(serverWriteCalledFirst).toBe(true)
          throw new Error("Simulated server rename failure")
        }

        expect(() => {
          writeViewFoldersFile(fakeWs, [
            { id: "server-new", label: "Server New", path: "~/server-new" },
          ])
        }).toThrow("Simulated server rename failure")

        expect(serverWriteCalledFirst).toBe(true)
        const serverAfterBytes = fs.readFileSync(serverFilePath)
        expect(serverAfterBytes).toEqual(serverOrigBytes)
      } finally {
        fs.writeFileSync = origWriteFileSync
        fs.renameSync = origRenameSync
      }

      // 2) 도구 writeToolConfigFile 검증
      const initialToolData = {
        schemaVersion: 1,
        folders: [{ id: "tool-orig", label: "Tool Original", path: "~/tool-orig" }],
      }
      writeToolConfigFile(fakeWs, initialToolData)

      const toolFilePath = path.join(fakeWs, ".agents", "work", "view-folders.json")
      const toolOrigBytes = fs.readFileSync(toolFilePath)

      let toolWriteCalledFirst = false

      try {
        fs.writeFileSync = function (file: any, data: any, options: any) {
          if (typeof file === "string" && file.includes(".tmp.")) {
            toolWriteCalledFirst = true
          }
          return origWriteFileSync.call(fs, file, data, options)
        }

        fs.renameSync = function (oldPath: any, newPath: any) {
          expect(toolWriteCalledFirst).toBe(true)
          throw new Error("Simulated tool rename failure")
        }

        expect(() => {
          writeToolConfigFile(fakeWs, {
            schemaVersion: 1,
            folders: [{ id: "tool-new", label: "Tool New", path: "~/tool-new" }],
          })
        }).toThrow("Simulated tool rename failure")

        expect(toolWriteCalledFirst).toBe(true)
        const toolAfterBytes = fs.readFileSync(toolFilePath)
        expect(toolAfterBytes).toEqual(toolOrigBytes)
      } finally {
        fs.writeFileSync = origWriteFileSync
        fs.renameSync = origRenameSync
      }
    })
  })
})
