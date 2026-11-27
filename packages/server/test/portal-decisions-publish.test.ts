import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import { createServer } from "../src/server.js"
import { PUBLISH_FIXTURE_TARGETS_JSON, SITE_ALPHA } from "./publish-fixtures.js"

const READ_HEADERS = {
  host: "localhost:3175",
  "x-naia-proxy-secret": "decisions-publish-test-secret",
  "x-naia-peer": "127.0.0.1",
  "x-naia-local": "127.0.0.1",
}

describe("결재/확인 집계의 게시 확인 요청", () => {
  let root = ""
  let app: Awaited<ReturnType<typeof createServer>> | undefined
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "decisions-publish-"))
    fs.mkdirSync(path.join(root, "docs", "article"), { recursive: true })
    fs.writeFileSync(path.join(root, "docs", "article", "draft.md"), "# 원고\n")
  })
  afterEach(async () => {
    await app?.close()
    app = undefined
    vi.unstubAllEnvs()
    if (root) fs.rmSync(root, { recursive: true, force: true })
    root = ""
  })

  const reviewId = `review_${"a".repeat(64)}`
  const revisionId = `rev_${"b".repeat(64)}`

  function seedPublishReview(state: string) {
    fs.mkdirSync(path.join(state, "descriptors"), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(state, "descriptors/test-post.json"), JSON.stringify({
      source: "adk", path: "article/draft.md", slug: "test-post",
      body_selector: { start_heading: "## 본문", end_heading: "## 근거표", separator: "---" },
      frontmatter: { kind: "post", slug: "test-post", title: "시험 게시 제목", targets: [SITE_ALPHA], languages: { [SITE_ALPHA]: ["ko"] } },
      asset_roots: [], asset_path_map: {}, media_map: { ko: { ready: true, body_images: [] } },
    }))
    const commit = {
      slug: "test-post", review_id: reviewId, revision_id: revisionId, saved_revision: "c".repeat(64),
      input_hash: "d".repeat(64), assignees: ["test-gate:owner"], requester_id: "test-gate:writer",
      created_at: "2030-11-04T20:00:00.000Z", operation: { operation_id: "op_review" },
      result: { review_url: `/docs?source=adk&path=article%2Fdraft.md&publishReview=${reviewId}&publishRevision=${revisionId}` },
    }
    fs.mkdirSync(path.join(state, "reviews", reviewId), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(state, "reviews", reviewId, "commit.json"), JSON.stringify(commit))
    fs.mkdirSync(path.join(state, "objects", revisionId.slice(4)), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(state, "objects", revisionId.slice(4), "manifest.json"), JSON.stringify({ slug: "test-post", targets: [SITE_ALPHA] }))
    fs.mkdirSync(path.join(state, "selections", "op_select"), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(state, "selections", "op_select", "commit.json"), JSON.stringify({ slug: "test-post", review_id: reviewId, sequence: 1 }))
  }

  it("대기 중인 게시 확인 요청을 kind publish_review로 집계하고 요청판 링크를 돌려준다", async () => {
    const state = path.join(root, "publish-state")
    seedPublishReview(state)
    vi.stubEnv("PUBLISH_STATE_DIR", state)
    vi.stubEnv("NAIA_PUBLISH_TARGETS_JSON", PUBLISH_FIXTURE_TARGETS_JSON)
    app = await createServer({ root, port: 3175, host: "127.0.0.1" })
    ;(app as any).proxySecret = READ_HEADERS["x-naia-proxy-secret"]
    const response = await app.inject({ url: "/api/portal/decisions", headers: READ_HEADERS })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    const item = body.pending.find((entry: any) => entry.kind === "publish_review")
    expect(item).toMatchObject({
      source: "publish",
      decisionId: reviewId,
      title: expect.stringContaining("시험 게시 제목"),
      path: expect.stringContaining("article/draft.md"),
      url: expect.stringContaining(`publishReview=${reviewId}`),
    })
    expect(item.detail).toContain(SITE_ALPHA)
    expect(item.detail).toContain(revisionId)
    expect(body.counts.publish).toBe(1)
    expect(body.counts.total).toBeGreaterThanOrEqual(1)
  })

  it("게시 저장소가 없으면 게시 확인 항목 없이도 집계한다", async () => {
    vi.stubEnv("PUBLISH_STATE_DIR", "")
    app = await createServer({ root, port: 3175, host: "127.0.0.1" })
    ;(app as any).proxySecret = READ_HEADERS["x-naia-proxy-secret"]
    const response = await app.inject({ url: "/api/portal/decisions", headers: READ_HEADERS })
    expect(response.statusCode).toBe(200)
    expect(response.json().pending.filter((entry: any) => entry.kind === "publish_review")).toEqual([])
    expect(response.json().warnings).toEqual([])
  })

  it("일반 결재(approve/reject/acknowledge)로 게시 확인을 닫을 수 없다", async () => {
    const state = path.join(root, "publish-state")
    seedPublishReview(state)
    vi.stubEnv("PUBLISH_STATE_DIR", state)
    vi.stubEnv("NAIA_PUBLISH_TARGETS_JSON", PUBLISH_FIXTURE_TARGETS_JSON)
    app = await createServer({ root, port: 3175, host: "127.0.0.1" })
    ;(app as any).proxySecret = READ_HEADERS["x-naia-proxy-secret"]
    const write = { ...READ_HEADERS, "x-naia-origin-ok": "1", "content-type": "application/json" }
    for (const action of ["approve", "reject", "acknowledge"]) {
      const resolve = await app.inject({
        method: "POST",
        url: `/api/portal/decisions/publish:${reviewId}/resolve`,
        headers: write,
        payload: JSON.stringify({ action }),
      })
      expect(resolve.statusCode).toBe(409)
      expect(resolve.body).toContain("publish")
    }
    const snapshot = (await app.inject({ url: "/api/portal/decisions", headers: READ_HEADERS })).json()
    expect(snapshot.pending.map((entry: any) => entry.id)).toContain(`publish:${reviewId}`)
    expect(snapshot.history.map((entry: any) => entry.id)).not.toContain(`publish:${reviewId}`)
    expect(snapshot.counts.publish).toBe(1)
  })

  it("게시 흐름의 승인 기록 뒤에는 보관함에서 빠지고 이력은 정확히 한 줄이다", async () => {
    const state = path.join(root, "publish-state")
    seedPublishReview(state)
    vi.stubEnv("PUBLISH_STATE_DIR", state)
    vi.stubEnv("NAIA_PUBLISH_TARGETS_JSON", PUBLISH_FIXTURE_TARGETS_JSON)
    app = await createServer({ root, port: 3175, host: "127.0.0.1" })
    ;(app as any).proxySecret = READ_HEADERS["x-naia-proxy-secret"]
    const before = (await app.inject({ url: "/api/portal/decisions", headers: READ_HEADERS })).json()
    expect(before.pending.map((entry: any) => entry.id)).toContain(`publish:${reviewId}`)
    // 게시 승인 흐름이 기록한 최종 결과(approve commit)를 그대로 둔다.
    const approvalDir = path.join(state, "approvals", "test-post", revisionId)
    fs.mkdirSync(approvalDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(approvalDir, "commit.json"), JSON.stringify({
      slug: "test-post",
      review_id: reviewId,
      revision_id: revisionId,
      approved_at: "2030-11-04T21:00:00.000Z",
      result: { receipt: { targets: [SITE_ALPHA], approver_id: "test-gate:owner" } },
    }))
    const after = (await app.inject({ url: "/api/portal/decisions", headers: READ_HEADERS })).json()
    expect(after.pending.map((entry: any) => entry.id)).not.toContain(`publish:${reviewId}`)
    const rows = after.history.filter((entry: any) => entry.id === `publish:${reviewId}`)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe("approved")
    expect(after.counts.publish).toBe(0)
  })

  it("게시 저장소가 깨져도 다른 보관함은 열리고 경고가 난다", async () => {
    const blocker = path.join(root, "blocker")
    fs.writeFileSync(blocker, "not a directory")
    vi.stubEnv("PUBLISH_STATE_DIR", blocker)
    app = await createServer({ root, port: 3175, host: "127.0.0.1" })
    ;(app as any).proxySecret = READ_HEADERS["x-naia-proxy-secret"]
    const response = await app.inject({ url: "/api/portal/decisions", headers: READ_HEADERS })
    expect(response.statusCode).toBe(200)
    expect(response.json().warnings).toContain("publish")
    expect(response.json().pending.filter((entry: any) => entry.kind === "publish_review")).toEqual([])
  })
})
