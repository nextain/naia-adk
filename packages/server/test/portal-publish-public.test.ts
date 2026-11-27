import { describe, it, expect, vi, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createServer } from "../src/server.js"

describe("POST /api/portal/publish public-proxy guard", () => {
  const TEST_SECRET = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
  const BASE_HEADERS = {
    host: "localhost:3141",
    "x-naia-proxy-secret": TEST_SECRET,
    "x-naia-peer": "127.0.0.1",
    "x-naia-local": "127.0.0.1",
  }
  // 대시보드 공개 모드가 붙인 표시(검증한 메일). 내부 모드에서는 지워진다.
  const PUBLIC_HEADERS = {
    ...BASE_HEADERS,
    "x-naia-user-email": "staff@example.com",
  }
  const SERVICE_AUTH = { authorization: "Bearer export-service-token" }

  let tempRoot = ""
  let app: Awaited<ReturnType<typeof createServer>> | undefined
  afterEach(async () => {
    await app?.close()
    app = undefined
    vi.unstubAllEnvs()
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = ""
  })

  async function start() {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adk-publish-public-"))
    fs.mkdirSync(path.join(tempRoot, "docs"), { recursive: true })
    vi.stubEnv("PUBLISH_GATEWAY_OVERWRITE_CONFIRMED", "1")
    vi.stubEnv("PUBLISH_EXPORT_SERVICE_TOKEN", "export-service-token")
    vi.stubEnv("PUBLISH_STATE_DIR", path.join(tempRoot, "publish-state"))
    app = await createServer({ root: tempRoot, port: 3141, host: "127.0.0.1" })
    ;(app as any).proxySecret = TEST_SECRET
  }

  it("rejects public-proxy requests on all publish routes including export queue (403)", async () => {
    await start()
    const queue = await app!.inject({ method: "GET", url: "/api/portal/publish/export-queue", headers: { ...PUBLIC_HEADERS, ...SERVICE_AUTH } })
    expect(queue.statusCode).toBe(403)
    expect(JSON.parse(queue.body).code).toBe("publish_public_forbidden")

    // 서비스 자격 증명이 맞아도 공개 표시가 있으면 내보내기 줄을 건드릴 수 없다.
    const claim = await app!.inject({
      method: "POST",
      url: "/api/portal/publish/export-queue/some-slug/rev_test/site-alpha/ko/claim",
      headers: { ...PUBLIC_HEADERS, ...SERVICE_AUTH, "idempotency-key": "public-claim", "content-type": "application/json" },
      payload: JSON.stringify({}),
    })
    expect(claim.statusCode).toBe(403)
    expect(JSON.parse(claim.body).code).toBe("publish_public_forbidden")

    const status = await app!.inject({ method: "GET", url: "/api/portal/publish/some-slug/status", headers: PUBLIC_HEADERS })
    expect(status.statusCode).toBe(403)
    expect(JSON.parse(status.body).code).toBe("publish_public_forbidden")
  })

  it("leaves non-public requests on the normal service path", async () => {
    await start()
    const queue = await app!.inject({ method: "GET", url: "/api/portal/publish/export-queue", headers: { ...BASE_HEADERS, ...SERVICE_AUTH } })
    expect(queue.statusCode).toBe(200)
    expect(JSON.parse(queue.body)).toMatchObject({ ok: true })

    const missing = await app!.inject({ method: "GET", url: "/api/portal/publish/export-queue", headers: BASE_HEADERS })
    expect(missing.statusCode).toBe(401)
    expect(JSON.parse(missing.body).code).toBe("publish_export_service_required")
  })
})
