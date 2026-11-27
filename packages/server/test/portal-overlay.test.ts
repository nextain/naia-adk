import { describe, it, expect, beforeAll, afterAll } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import { createServer } from "../src/server.js"

describe("Portal doc overlay (/api/portal/doc + /api/portal/docs)", () => {
  const TEST_SECRET = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
  const READ_HEADERS = {
    host: "localhost:3141",
    "x-naia-proxy-secret": TEST_SECRET,
    "x-naia-peer": "127.0.0.1",
    "x-naia-local": "127.0.0.1",
  }
  const WRITE_HEADERS = {
    ...READ_HEADERS,
    "x-naia-origin-ok": "1",
    "content-type": "application/json",
  }

  let tempRoot: string
  let overlayFile: string
  let app: Awaited<ReturnType<typeof createServer>>
  let prevOverlayEnv: string | undefined

  const ORIGINAL = "# 원본 문서\n원본 내용\n"

  beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adk-overlay-"))
    overlayFile = path.join(tempRoot, "overlay.sqlite")
    fs.mkdirSync(path.join(tempRoot, "docs"), { recursive: true })
    fs.writeFileSync(path.join(tempRoot, "docs", "guide.md"), ORIGINAL, "utf-8")

    prevOverlayEnv = process.env.NAIA_AX_DOC_STORE
    process.env.NAIA_AX_DOC_STORE = overlayFile
    app = await createServer({ root: tempRoot, port: 3141, host: "127.0.0.1" })
    ;(app as any).proxySecret = TEST_SECRET
  })

  afterAll(async () => {
    await app.close()
    if (prevOverlayEnv === undefined) delete process.env.NAIA_AX_DOC_STORE
    else process.env.NAIA_AX_DOC_STORE = prevOverlayEnv
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })

  const putDoc = (content: string, baseHash: string) =>
    app.inject({
      method: "PUT",
      url: "/api/portal/doc?source=adk&path=guide.md",
      headers: WRITE_HEADERS,
      payload: JSON.stringify({ content, baseHash }),
    })

  it("PUT writes git + overlay; GET serves the overlay first", async () => {
    const baseHash = crypto.createHash("sha256").update(ORIGINAL, "utf-8").digest("hex")
    const updated = "# 고친 문서\n고친 내용\n"
    const put = await putDoc(updated, baseHash)
    expect(put.statusCode).toBe(200)

    const get = await app.inject({ method: "GET", url: "/api/portal/doc?source=adk&path=guide.md", headers: READ_HEADERS })
    expect(get.statusCode).toBe(200)
    expect(get.body).toBe(updated)
    expect(get.headers["x-doc-source"]).toBe("overlay")
    expect(typeof get.headers["x-overlay-updated-at"]).toBe("string")
  })

  it("a git reset underneath never loses the AX edit; revisions accumulate", async () => {
    // Simulate `git reset --hard`: the checkout baseline is clobbered.
    fs.writeFileSync(path.join(tempRoot, "docs", "guide.md"), ORIGINAL, "utf-8")

    const get = await app.inject({ method: "GET", url: "/api/portal/doc?source=adk&path=guide.md", headers: READ_HEADERS })
    expect(get.statusCode).toBe(200)
    expect(get.body).toBe("# 고친 문서\n고친 내용\n")
    expect(get.headers["x-doc-source"]).toBe("overlay")

    const second = "# 두 번째 고침\n추가 내용\n"
    const overlayHash = crypto.createHash("sha256").update("# 고친 문서\n고친 내용\n", "utf-8").digest("hex")
    const put = await putDoc(second, overlayHash)
    expect(put.statusCode).toBe(200)

    const list = await app.inject({ method: "GET", url: "/api/portal/docs", headers: READ_HEADERS })
    expect(list.statusCode).toBe(200)
    const json = JSON.parse(list.body)
    expect(json.overlays).toHaveLength(1)
    expect(json.overlays[0]).toMatchObject({ source: "adk", path: "guide.md", revision: 2 })
  })

  it("rejects path traversal and hides overlay/docs/decisions from untrusted callers", async () => {
    const evil = await app.inject({
      method: "PUT",
      url: "/api/portal/doc?source=adk&path=../outside.md",
      headers: WRITE_HEADERS,
      payload: JSON.stringify({ content: "x", baseHash: "y" }),
    })
    expect([400, 403, 404]).toContain(evil.statusCode)

    const publicDocs = await app.inject({ method: "GET", url: "/api/portal/docs", headers: { host: "localhost:3141" } })
    expect(publicDocs.statusCode).toBe(403)

    const publicDecisions = await app.inject({ method: "GET", url: "/api/portal/decisions", headers: { host: "localhost:3141" } })
    expect(publicDecisions.statusCode).toBe(403)
  })
})
