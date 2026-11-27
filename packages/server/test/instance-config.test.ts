import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createServer } from "../src/server.js"
import { getInstanceConfigPath, loadInstanceConfig } from "../src/instance-config.js"

describe("읽기 전용 인스턴스 쓰기 차단", () => {
  it("config/dashboard.json의 docs.readOnly를 읽는다", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "instance-config-"))
    try {
      expect(loadInstanceConfig(root).docsReadOnly).toBe(false)
      fs.mkdirSync(path.join(root, "config"), { recursive: true })
      fs.writeFileSync(getInstanceConfigPath(root), JSON.stringify({ docs: { readOnly: true } }))
      expect(loadInstanceConfig(root).docsReadOnly).toBe(true)
      fs.writeFileSync(getInstanceConfigPath(root), JSON.stringify({ docs: { readOnly: "yes" } }))
      expect(loadInstanceConfig(root).docsReadOnly).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("docsReadOnly가 켜지면 게시·그림·문서 쓰기를 403으로 막고 읽기는 둔다", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "instance-readonly-"))
    try {
      fs.mkdirSync(path.join(root, "docs", "article", "assets"), { recursive: true })
      fs.writeFileSync(path.join(root, "docs", "article", "index.md"), "# 원고\n")
      fs.mkdirSync(path.join(root, "config"), { recursive: true })
      fs.writeFileSync(path.join(root, "config", "dashboard.json"), JSON.stringify({ docs: { readOnly: true } }))
      const app = await createServer({ root, port: 3175, host: "127.0.0.1" })
      try {
        ;(app as any).proxySecret = "readonly-test-secret"
        const headers = { host: "localhost:3175", "x-naia-proxy-secret": "readonly-test-secret", "x-naia-peer": "127.0.0.1", "x-naia-local": "1", "x-naia-origin-ok": "1" }
        expect((await app.inject({ url: "/api/portal/doc?source=adk&path=article/index.md", headers })).statusCode).toBe(200)
        expect((await app.inject({ method: "PUT", url: "/api/portal/doc?source=adk&path=article/index.md", headers, payload: { content: "x", baseHash: "y" } })).statusCode).toBe(403)
        expect((await app.inject({ method: "POST", url: "/api/portal/publish/test-post/request-review", headers, payload: {} })).statusCode).toBe(403)
        expect((await app.inject({ method: "POST", url: "/api/portal/publish/test-post/approve", headers, payload: {} })).statusCode).toBe(403)
        expect((await app.inject({ method: "POST", url: "/api/portal/doc-assets?source=adk&path=article/index.md&name=a.png", headers: { ...headers, "content-type": "application/octet-stream" }, payload: Buffer.alloc(8) })).statusCode).toBe(403)
        expect((await app.inject({ url: "/api/health", headers })).statusCode).toBe(200)
      } finally {
        await app.close()
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
