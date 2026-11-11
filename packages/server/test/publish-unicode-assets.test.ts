import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createServer } from "../src/server.js"
import { hashBytes, type PublishDescriptor } from "../src/publish-bundle.js"
import { verifyApprovalReceipt } from "../src/publish-service.js"

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64")
const actor = "test-gate:owner"
const secret = "publish-unicode-assets-test-secret"
const headers = { host: "localhost:3175", "x-naia-proxy-secret": secret, "x-naia-peer": "127.0.0.1", "x-naia-local": "1", "x-naia-origin-ok": "1", "x-naia-actor-id": actor, "x-naia-actor-verified": "1" }

describe("한글 그림 업로드부터 게시 승인까지", () => {
  let app: Awaited<ReturnType<typeof createServer>> | undefined
  afterEach(async () => {
    await app?.close()
    app = undefined
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it.each([true, false])("기존 assets/그림.png를 본문 참조 %s일 때 그대로 승인한다", async referenced => {
    const allowed = path.resolve(os.tmpdir())
    const relative = path.relative(allowed, fs.realpathSync(os.tmpdir()))
    expect(relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))).toBe(true)
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "publish-unicode-assets-"))
    const root = path.join(directory, "workspace")
    const state = path.join(directory, "state")
    const document = path.join(root, "docs/article/draft.md")
    fs.mkdirSync(path.dirname(document), { recursive: true })
    fs.mkdirSync(path.join(state, "descriptors"), { recursive: true, mode: 0o700 })
    const body = `\r\n# 게시 제목\r\n\r\n본문 공백  \r\n${referenced ? "![한글 그림](assets/그림.png)\r\n" : ""}\r\n`
    const source = Buffer.from(`## 본문\r\n${body}---\r\n\r\n## 근거표\r\n비공개 근거\r\n`)
    fs.writeFileSync(document, source)
    const keys = crypto.generateKeyPairSync("ed25519")
    const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString()
    const keyFile = path.join(directory, "signing.pem")
    fs.writeFileSync(keyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 })
    vi.stubEnv("PUBLISH_STATE_DIR", state)
    vi.stubEnv("XDG_RUNTIME_DIR", path.join(directory, "runtime"))
    vi.stubEnv("PUBLISH_GATEWAY_SCOPE", "test-gate")
    vi.stubEnv("PUBLISH_GATEWAY_OVERWRITE_CONFIRMED", "1")
    vi.stubEnv("PUBLISH_APPROVER_IDS", actor)
    vi.stubEnv("PUBLISH_SIGNING_KEY_FILE", keyFile)
    vi.stubEnv("PUBLISH_SIGNING_KEY_ID", "test-key")
    vi.stubEnv("PUBLISH_PUBLIC_KEYS", JSON.stringify({ "test-key": publicKey }))
    app = await createServer({ root, port: 3175, host: "127.0.0.1" })
    ;(app as any).proxySecret = secret

    const assetPath = "assets/그림.png"
    fs.mkdirSync(path.join(path.dirname(document), "assets"), { recursive: true })
    fs.writeFileSync(path.join(path.dirname(document), assetPath), png)
    const descriptor: PublishDescriptor = {
      source: "adk", path: "article/draft.md", slug: "unicode-post",
      body_selector: { start_heading: "## 본문", end_heading: "## 근거표", separator: "---" },
      frontmatter: { kind: "post", slug: "unicode-post", title: "한글 그림 시험", summary: "시험용 요약", date: "2030-11-04T20:00+09:00", targets: ["site-a"], languages: { "site-a": ["ko"] }, hero: assetPath },
      asset_roots: ["assets"], asset_path_map: {},
      media_map: { ko: { ready: true, hero: assetPath, body_images: referenced ? [assetPath] : [] } },
    }
    fs.writeFileSync(path.join(state, "descriptors/unicode-post.json"), JSON.stringify(descriptor))
    const reviewed = await app.inject({ method: "POST", url: "/api/portal/publish/unicode-post/request-review", headers: { ...headers, "idempotency-key": "review-unicode" }, payload: { saved_revision: hashBytes(source) } })
    expect(reviewed.statusCode, reviewed.body).toBe(201)
    const review = reviewed.json()
    const selected = new URLSearchParams({ review_id: review.review_id, revision_id: review.revision_id })
    const previewed = await app.inject({ url: `/api/portal/publish/unicode-post/preview?${selected}`, headers })
    expect(previewed.statusCode, previewed.body).toBe(200)
    const view = previewed.json()
    expect(view.previews["site-a"].ko.body).toBe(body)
    const approved = await app.inject({ method: "POST", url: "/api/portal/publish/unicode-post/approve", headers: { ...headers, "idempotency-key": "approve-unicode" }, payload: { review_id: review.review_id, revision_id: review.revision_id, saved_revision: view.saved_revision, preview_hash: view.preview_hash } })
    expect(approved.statusCode, approved.body).toBe(201)
    const result = approved.json()
    expect(result).toMatchObject({ state: "approved_waiting_export", approved_hash: view.preview_hash })
    expect(result.receipt).toMatchObject({ slug: "unicode-post", revision_id: review.revision_id, approved_hash: view.preview_hash, approver_id: actor })
    expect(verifyApprovalReceipt(result.receipt, { "test-key": publicKey })).toBe(true)
    const object = path.join(state, "objects", view.preview_hash)
    expect(fs.readFileSync(path.join(object, assetPath))).toEqual(png)
    expect(JSON.parse(fs.readFileSync(path.join(object, "manifest.json"), "utf8")).asset_hashes).toEqual([{ path: assetPath, format: "png", size: png.length, sha256: hashBytes(png) }])
    expect(JSON.parse(fs.readFileSync(path.join(object, "media-map.json"), "utf8")).ko.body_images).toEqual(referenced ? [{ path: assetPath, sha256: hashBytes(png) }] : [])
    expect(JSON.parse(fs.readFileSync(path.join(object, "previews/site-a/ko.json"), "utf8")).body).toBe(body)
    expect(JSON.parse(fs.readFileSync(path.join(object, "manifest.json"), "utf8")).body_hash).toBe(hashBytes(Buffer.from(body)))
    expect(fs.readFileSync(path.join(object, "source.bin"))).toEqual(source)
    expect(fs.readFileSync(document)).toEqual(source)
    expect(fs.readFileSync(path.join(path.dirname(document), assetPath))).toEqual(png)
  })
})
