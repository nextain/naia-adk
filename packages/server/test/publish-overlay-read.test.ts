import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DocOverlayStore, overlayDbPath } from "../src/doc-overlay-store.js"
import { createServer } from "../src/server.js"
import { PublishService } from "../src/publish-service.js"
import { hashBytes } from "../src/publish-bundle.js"
import { PUBLISH_FIXTURE_TARGETS_JSON, SITE_ALPHA, SITE_BETA } from "./publish-fixtures.js"

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64")

describe("SQLite 오버레이 저장판의 게시 묶음 반영", () => {
  let root = ""
  afterEach(() => {
    vi.unstubAllEnvs()
    if (root) fs.rmSync(root, { recursive: true, force: true })
    root = ""
  })

  it("체크아웃의 낡은 원고 대신 오버레이 최신판으로 미리보기·묶음을 만든다", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "publish-overlay-read-"))
    const state = path.join(root, "publish-state")
    fs.mkdirSync(path.join(root, "docs/article/assets"), { recursive: true })
    fs.mkdirSync(path.join(state, "descriptors"), { recursive: true, mode: 0o700 })
    const stale = Buffer.from("안내\r\n\r\n## 본문\r\n\r\n# 낡은 제목\r\n\r\n본문  \r\n![그림](assets/hero.png)\r\n\r\n---\r\n\r\n## 근거표\r\n비공개\r\n")
    const document = path.join(root, "docs/article/draft.md")
    fs.writeFileSync(document, stale)
    fs.writeFileSync(path.join(root, "docs/article/assets/hero.png"), png)
    const descriptor = {
      source: "adk", path: "article/draft.md", slug: "overlay-post",
      body_selector: { start_heading: "## 본문", end_heading: "## 근거표", separator: "---" },
      frontmatter: { kind: "post", slug: "overlay-post", title: "오버레이 제목", summary: "요약", date: "2030-11-04T20:00+09:00", targets: [SITE_ALPHA, SITE_BETA], languages: { [SITE_ALPHA]: ["ko", "en"], [SITE_BETA]: ["ko", "en"] }, hero: "assets/hero.png", site_beta_category: "beta-a" },
      asset_roots: ["assets"], asset_path_map: {},
      media_map: { ko: { ready: true, hero: "assets/hero.png", body_images: ["assets/hero.png"] }, en: { ready: false } },
    }
    fs.writeFileSync(path.join(state, "descriptors/overlay-post.json"), JSON.stringify(descriptor))
    const overlayContent = stale.toString("utf8").replace("# 낡은 제목", "# 오버레이 제목")
    vi.stubEnv("PUBLISH_STATE_DIR", state)
    vi.stubEnv("NAIA_PUBLISH_TARGETS_JSON", PUBLISH_FIXTURE_TARGETS_JSON)
    vi.stubEnv("NAIA_AX_DOC_STORE", path.join(root, "overlay.sqlite"))
    const store = new DocOverlayStore(overlayDbPath(root))
    try {
      store.put({ source: "adk", path: "article/draft.md", content: overlayContent })
    } finally {
      store.close()
    }
    expect(fs.readFileSync(document)).toEqual(stale)

    const service = new PublishService(root, process.env)
    const bundle = await service.bundle("overlay-post")
    expect(bundle.source_bytes.toString("utf8")).toBe(overlayContent)
    expect(bundle.manifest.source_hash).toBe(hashBytes(Buffer.from(overlayContent)))
    expect(bundle.frontmatter.title).toBe("오버레이 제목")
    expect(bundle.body_bytes.toString("utf8")).toContain("# 오버레이 제목")
    expect(bundle.body_bytes.toString("utf8")).not.toContain("# 낡은 제목")
    expect(bundle.previews[SITE_ALPHA].ko.title).toBe("오버레이 제목")
    const status = await service.status("test-gate:owner", "overlay-post")
    expect(status.saved_revision).toBe(hashBytes(Buffer.from(overlayContent)))
  })
})

describe("SQLite 오버레이 저장판의 기본 경로·장애·PUT 반영", () => {
  const actor = "test-gate:owner"
  let root = ""
  afterEach(() => {
    vi.unstubAllEnvs()
    if (root) fs.rmSync(root, { recursive: true, force: true })
    root = ""
  })

  function seedDocument() {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "publish-overlay-default-"))
    const state = path.join(root, "publish-state")
    fs.mkdirSync(path.join(root, "docs/article/assets"), { recursive: true })
    fs.mkdirSync(path.join(state, "descriptors"), { recursive: true, mode: 0o700 })
    const stale = Buffer.from("안내\r\n\r\n## 본문\r\n\r\n# 낡은 제목\r\n\r\n본문  \r\n![그림](assets/hero.png)\r\n\r\n---\r\n\r\n## 근거표\r\n비공개\r\n")
    fs.writeFileSync(path.join(root, "docs/article/draft.md"), stale)
    fs.writeFileSync(path.join(root, "docs/article/assets/hero.png"), png)
    const descriptor = {
      source: "adk", path: "article/draft.md", slug: "overlay-post",
      body_selector: { start_heading: "## 본문", end_heading: "## 근거표", separator: "---" },
      frontmatter: { kind: "post", slug: "overlay-post", title: "오버레이 제목", summary: "요약", date: "2030-11-04T20:00+09:00", targets: [SITE_ALPHA, SITE_BETA], languages: { [SITE_ALPHA]: ["ko", "en"], [SITE_BETA]: ["ko", "en"] }, hero: "assets/hero.png", site_beta_category: "beta-a" },
      asset_roots: ["assets"], asset_path_map: {},
      media_map: { ko: { ready: true, hero: "assets/hero.png", body_images: ["assets/hero.png"] }, en: { ready: false } },
    }
    fs.writeFileSync(path.join(state, "descriptors/overlay-post.json"), JSON.stringify(descriptor))
    vi.stubEnv("PUBLISH_STATE_DIR", state)
    vi.stubEnv("NAIA_PUBLISH_TARGETS_JSON", PUBLISH_FIXTURE_TARGETS_JSON)
    vi.stubEnv("PUBLISH_GATEWAY_SCOPE", "test-gate")
    vi.stubEnv("PUBLISH_GATEWAY_OVERWRITE_CONFIRMED", "1")
    vi.stubEnv("PUBLISH_APPROVER_IDS", actor)
    return { state, stale }
  }

  it("NAIA_AX_DOC_STORE이 비어도 게시 읽기가 기본 SQLite 저장판을 쓴다", async () => {
    const { stale } = seedDocument()
    vi.stubEnv("NAIA_AX_DOC_STORE", "")
    const overlayContent = stale.toString("utf8").replace("# 낡은 제목", "# 기본 저장판 제목")
    const store = new DocOverlayStore(overlayDbPath(root))
    try {
      store.put({ source: "adk", path: "article/draft.md", content: overlayContent })
    } finally {
      store.close()
    }
    const service = new PublishService(root, process.env)
    const bundle = await service.bundle("overlay-post")
    expect(bundle.source_bytes.toString("utf8")).toBe(overlayContent)
    expect(bundle.body_bytes.toString("utf8")).toContain("# 기본 저장판 제목")
    expect(bundle.body_bytes.toString("utf8")).not.toContain("# 낡은 제목")
  })

  it("깨진 SQLite 저장판은 게시 읽기·승인을 503으로 막는다", async () => {
    seedDocument()
    const dbPath = path.join(root, "overlay.sqlite")
    vi.stubEnv("NAIA_AX_DOC_STORE", dbPath)
    fs.writeFileSync(dbPath, "깨진 저장판 바이트")
    // 승인 흐름이 닿기 전에 멈추도록 검토 기록·원본 목록을 미리 둔다.
    const reviewId = `review_${"c".repeat(64)}`
    const revisionId = `rev_${"d".repeat(64)}`
    const state = path.join(root, "publish-state")
    fs.mkdirSync(path.join(state, "reviews", reviewId), { recursive: true, mode: 0o700 })
    fs.mkdirSync(path.join(state, "objects", revisionId.slice(4)), { recursive: true, mode: 0o700 })
    const commit = {
      slug: "overlay-post", review_id: reviewId, revision_id: revisionId,
      saved_revision: "e".repeat(64), input_hash: "f".repeat(64), preview_hash: "a".repeat(64),
      assignees: [actor], requester_id: actor, created_at: "2030-11-04T20:00:00.000Z",
      operation: { operation_id: "op_review" }, result: {},
    }
    fs.writeFileSync(path.join(state, "reviews", reviewId, "commit.json"), JSON.stringify(commit))
    fs.writeFileSync(path.join(state, "objects", revisionId.slice(4), "manifest.json"), JSON.stringify({ slug: "overlay-post", source: "adk", path: "article/draft.md" }))
    const service = new PublishService(root, process.env)
    await expect(service.bundle("overlay-post")).rejects.toMatchObject({ status: 503 })
    await expect(service.approve(actor, "overlay-post", crypto.randomUUID(), {
      review_id: reviewId, revision_id: revisionId, saved_revision: "e".repeat(64), preview_hash: "a".repeat(64),
    })).rejects.toMatchObject({ status: 503 })
    // 체크아웃의 낡은 바이트로는 절대 승인되지 않는다.
    expect(fs.readFileSync(path.join(root, "docs/article/draft.md"), "utf8")).toContain("# 낡은 제목")
  })

  it("PUT /api/portal/doc 저장 뒤 게시 읽기가 오버레이 최신판을 본다", async () => {
    const { stale } = seedDocument()
    const dbPath = path.join(root, "overlay.sqlite")
    vi.stubEnv("NAIA_AX_DOC_STORE", dbPath)
    const app = await createServer({ root, port: 3175, host: "127.0.0.1" })
    try {
      ;(app as any).proxySecret = "overlay-put-secret"
      const headers = {
        host: "localhost:3175",
        "x-naia-proxy-secret": "overlay-put-secret",
        "x-naia-peer": "127.0.0.1",
        "x-naia-local": "127.0.0.1",
        "x-naia-origin-ok": "1",
        "content-type": "application/json",
      }
      const baseHash = hashBytes(stale)
      const updated = stale.toString("utf8").replace("# 낡은 제목", "# PUT 최신판")
      const put = await app.inject({
        method: "PUT",
        url: "/api/portal/doc?source=adk&path=article/draft.md",
        headers,
        payload: JSON.stringify({ content: updated, baseHash }),
      })
      expect(put.statusCode).toBe(200)
      const get = await app.inject({ method: "GET", url: "/api/portal/doc?source=adk&path=article/draft.md", headers })
      expect(get.statusCode).toBe(200)
      expect(get.headers["x-doc-source"]).toBe("overlay")
      const service = new PublishService(root, process.env)
      const bundle = await service.bundle("overlay-post")
      expect(bundle.source_bytes.toString("utf8")).toBe(updated)
      expect(bundle.body_bytes.toString("utf8")).toContain("# PUT 최신판")
    } finally {
      await app.close()
    }
  })
})
