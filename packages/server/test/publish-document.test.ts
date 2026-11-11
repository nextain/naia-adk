import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { createServer } from "../src/server.js"
import { hashBytes } from "../src/publish-bundle.js"

const secret = "publish-document-test-secret"
const actor = "test-gate:owner"
const headers = { host: "localhost:3175", "x-naia-proxy-secret": secret, "x-naia-peer": "127.0.0.1", "x-naia-local": "1", "x-naia-origin-ok": "1", "x-naia-actor-id": actor, "x-naia-actor-verified": "1" }

describe("문서 출처·경로의 게시 등록 조회", () => {
  let directory: string, root: string, state: string, document: string
  let app: Awaited<ReturnType<typeof createServer>>
  let descriptor: Record<string, any>
  const saveDescriptor = (value = descriptor, slug = value.slug) => fs.writeFileSync(path.join(state, "descriptors", `${slug}.json`), JSON.stringify(value))
  const lookup = (source = "adk", documentPath = "article/draft.md", requestHeaders = headers) => app.inject({ url: `/api/portal/publish/document?${new URLSearchParams({ source, path: documentPath })}`, headers: requestHeaders })

  beforeEach(async () => {
    const allowed = path.resolve(os.tmpdir())
    const relative = path.relative(allowed, fs.realpathSync(os.tmpdir()))
    expect(relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))).toBe(true)
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "publish-document-"))
    root = path.join(directory, "workspace")
    state = path.join(directory, "state")
    fs.mkdirSync(path.join(root, "docs/article"), { recursive: true })
    fs.mkdirSync(path.join(state, "descriptors"), { recursive: true, mode: 0o700 })
    for (const name of ["home", "tmp", "runtime"]) fs.mkdirSync(path.join(directory, name))
    document = path.join(root, "docs/article/draft.md")
    fs.writeFileSync(document, "## 본문\r\n\r\n게시 원고  \r\n")
    descriptor = { source: "adk", path: "article/draft.md", slug: "registered-story", body_selector: { start_heading: "## 본문" }, frontmatter: {}, asset_roots: [], asset_path_map: {}, media_map: {} }
    vi.stubEnv("PUBLISH_STATE_DIR", state)
    vi.stubEnv("PUBLISH_GATEWAY_SCOPE", "test-gate")
    vi.stubEnv("PUBLISH_GATEWAY_OVERWRITE_CONFIRMED", "1")
    vi.stubEnv("PUBLISH_APPROVER_IDS", actor)
    vi.stubEnv("PUBLISH_SIGNING_KEY_FILE", "")
    vi.stubEnv("XDG_RUNTIME_DIR", path.join(directory, "runtime"))
    app = await createServer({ root, port: 3175, host: "127.0.0.1", folderCheckContext: { homeDir: path.join(directory, "home"), tmpDir: path.join(directory, "tmp"), xdgRuntimeDir: path.join(directory, "runtime") } })
    ;(app as any).proxySecret = secret
  })
  afterEach(async () => { vi.restoreAllMocks(); await app?.close(); vi.unstubAllEnvs() })

  it("게시 관련 설정이 하나라도 명시되면 내용 없이 설정 여부만 표시한다", async () => {
    const names = ["PUBLISH_STATE_DIR", "PUBLISH_SIGNING_KEY_FILE", "PUBLISH_SIGNING_KEY_ID", "PUBLISH_PUBLIC_KEYS", "PUBLISH_GATEWAY_SCOPE", "PUBLISH_GATEWAY_OVERWRITE_CONFIRMED", "PUBLISH_APPROVER_IDS"]
    for (const name of names) vi.stubEnv(name, undefined)
    expect((await app.inject({ url: "/api/portal", headers })).json().publish).toEqual({ configured: false })
    for (const name of names) {
      for (const value of ["", "  ", "synthetic-sensitive-value"]) {
        vi.stubEnv(name, value)
        const response = await app.inject({ url: "/api/portal", headers })
        expect(response.json().publish).toEqual({ configured: true })
        expect(response.body).not.toContain("synthetic-sensitive-value")
      }
      vi.stubEnv(name, undefined)
    }
  })

  it("미등록 문서는 파일명이 게시 slug와 같아도 slug:null이며 등록된 다른 경로를 노출하지 않는다", async () => {
    descriptor.path = "article/other.md"
    descriptor.slug = "draft"
    saveDescriptor()
    const original = fs.readFileSync(document)
    const response = await lookup()
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toEqual({ ok: true, slug: null, can_request_review: false })
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(fs.readFileSync(document)).toEqual(original)
  })

  it("앞머리가 미완성인 등록 문서도 정확한 출처·경로로 찾고 요청에서 422를 반환하며 원고를 보존한다", async () => {
    saveDescriptor()
    const original = fs.readFileSync(document)
    const response = await lookup()
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toEqual({ ok: true, slug: "registered-story", can_request_review: true })
    const review = await app.inject({ method: "POST", url: "/api/portal/publish/registered-story/request-review", headers: { ...headers, "idempotency-key": "incomplete-frontmatter" }, payload: { saved_revision: hashBytes(original) } })
    expect(review.statusCode, review.body).toBe(422)
    expect(fs.readFileSync(document)).toEqual(original)
    expect(fs.readdirSync(path.join(state, "reviews"))).toEqual([])
  })

  it("읽기 전용 출처는 등록을 찾되 요청 가능 표시가 false이며 실제 확인 요청도 403이다", async () => {
    const reference = path.join(directory, "home/reference")
    fs.mkdirSync(reference)
    fs.copyFileSync(document, path.join(reference, "draft.md"))
    fs.mkdirSync(path.join(root, ".agents/work"), { recursive: true })
    fs.writeFileSync(path.join(root, ".agents/work/view-folders.json"), JSON.stringify({ schemaVersion: 1, folders: [{ id: "reference", label: "참고", path: reference }] }))
    descriptor.source = "data:reference"; descriptor.path = "draft.md"; saveDescriptor()
    const response = await lookup(descriptor.source, descriptor.path)
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toEqual({ ok: true, slug: "registered-story", can_request_review: false })
    const review = await app.inject({ method: "POST", url: "/api/portal/publish/registered-story/request-review", headers: { ...headers, "idempotency-key": "read-only" }, payload: { saved_revision: hashBytes(fs.readFileSync(document)) } })
    expect(review.statusCode, review.body).toBe(403)
    expect(review.json().code).toBe("DOCUMENT_READ_ONLY")
  })

  it("출처가 다르면 같은 상대 경로의 등록을 돌려주지 않고 허용 폴더에서 철회한 경로는 403이다", async () => {
    const company = path.join(root, "data-company/test-company")
    fs.mkdirSync(path.join(company, "repo/article"), { recursive: true })
    fs.copyFileSync(document, path.join(company, "repo/article/draft.md"))
    const config = { schemaVersion: 1, title: "시험 회사", docs: { include: [] }, repos: [{ id: "publish-source", path: "data-company/test-company/repo", remote: "https://example.test/publish.git", docs: { include: ["article"] } }] }
    fs.writeFileSync(path.join(company, "adk-company.json"), JSON.stringify(config))
    saveDescriptor()
    const otherSource = await lookup("publish-source")
    expect(otherSource.statusCode, otherSource.body).toBe(200)
    expect(otherSource.json()).toEqual({ ok: true, slug: null, can_request_review: false })
    descriptor.source = "publish-source"; saveDescriptor()
    expect((await lookup("publish-source")).json()).toEqual({ ok: true, slug: "registered-story", can_request_review: true })
    config.repos[0].docs.include = ["other"]
    fs.writeFileSync(path.join(company, "adk-company.json"), JSON.stringify(config))
    expect((await lookup("publish-source")).statusCode).toBe(403)
  })

  it("검증된 계정·신뢰된 프록시를 요구하고 관문 미확인 상태의 승인 차단을 유지한다", async () => {
    saveDescriptor()
    expect((await lookup("adk", "article/draft.md", { ...headers, "x-naia-actor-verified": "0" })).statusCode).toBe(401)
    expect((await lookup("adk", "article/draft.md", { ...headers, "x-naia-peer": "203.0.113.9" })).statusCode).toBe(403)
    vi.stubEnv("PUBLISH_GATEWAY_OVERWRITE_CONFIRMED", "0")
    expect((await lookup()).statusCode).toBe(200)
    const approval = await app.inject({ method: "POST", url: "/api/portal/publish/registered-story/approve", headers })
    expect(approval.statusCode, approval.body).toBe(403)
    expect(approval.json().code).toBe("publish_gateway_unconfirmed")
  })

  it.each(["", "source=adk", "path=article%2Fdraft.md", "source=&path=article%2Fdraft.md", "source=adk&path=", "source=adk&source=adk&path=article%2Fdraft.md", "source=adk&path=article%2Fdraft.md&path=article%2Fdraft.md", "source=adk&path=article%2Fdraft.md&slug=guessed"])("누락·중복·추가 query를 400으로 거절한다: %s", async query => {
    const response = await app.inject({ url: `/api/portal/publish/document?${query}`, headers })
    expect(response.statusCode, response.body).toBe(400)
    expect(response.json().code).toBe("REQUEST_INVALID")
  })

  it.each(["../outside.md", "/article/draft.md", "article/../article/draft.md", "article//draft.md", "article\\draft.md", "article/draft.md\0"])("비정규 경로를 400으로 거절한다: %s", async documentPath => {
    expect((await lookup("adk", documentPath)).statusCode).toBe(400)
  })

  it.each([".secret.md", "data-private/secret.md", "article/draft.txt", "article", "missing.md"])("허용되지 않거나 실제 문서가 아닌 경로를 403으로 거절한다: %s", async documentPath => {
    expect((await lookup("adk", documentPath)).statusCode).toBe(403)
  })

  it("없는 출처와 실제 문서를 가리키는 심벌릭 링크·하드링크도 403이다", async () => {
    expect((await lookup("missing-source")).statusCode).toBe(403)
    fs.symlinkSync(document, path.join(root, "docs/article/link.md"))
    expect((await lookup("adk", "article/link.md")).statusCode).toBe(403)
    fs.linkSync(document, path.join(root, "docs/article/hardlink.md"))
    expect((await lookup()).statusCode).toBe(403)
    expect((await lookup("adk", "article/hardlink.md")).statusCode).toBe(403)
  })

  it.each(["{", "null", "[]", '{"slug":"wrong","source":"adk","path":"article/draft.md"}'])("파손된 등록 설정을 안전한 422로 반환한다: %s", async json => {
    fs.writeFileSync(path.join(state, "descriptors/registered-story.json"), json)
    const response = await lookup()
    expect(response.statusCode, response.body).toBe(422)
    expect(response.json()).toMatchObject({ ok: false, code: "DESCRIPTOR_INVALID", retryable: false, issues: [{ field: "descriptor" }] })
    expect(response.body).not.toContain(state)
  })

  it("같은 출처·경로의 중복 등록을 503으로 거절하고 임의 slug를 선택하지 않는다", async () => {
    saveDescriptor()
    saveDescriptor({ ...descriptor, slug: "second-story" })
    const response = await lookup()
    expect(response.statusCode, response.body).toBe(503)
    expect(response.json()).toMatchObject({ ok: false, code: "DESCRIPTOR_AMBIGUOUS", retryable: true })
    expect(response.json()).not.toHaveProperty("slug")
  })

  it("문서 출처 안에 둔 게시 저장소를 503으로 거절하며 문서 바이트를 보존한다", async () => {
    const original = fs.readFileSync(document)
    vi.stubEnv("PUBLISH_STATE_DIR", path.join(root, "docs/private-state"))
    const response = await lookup()
    expect(response.statusCode, response.body).toBe(503)
    expect(response.json().code).toBe("PUBLISH_CONFIG_INVALID")
    expect(fs.readFileSync(document)).toEqual(original)
  })
})
