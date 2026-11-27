import { afterEach, describe, expect, it, vi } from "vitest"
import Fastify from "fastify"
import { portalPublishRoutes } from "../src/routes/portal-publish.js"

const paths = [
  "/api/portal/publish/test-post/approve",
  "/api/portal/publish/test-post/%61pprove",
  "/api/portal/publish/test-post/appro%76e",
  "/api/portal/publish/test-post/approv%65?ignored=%2f",
  "/api/portal/publish/test-post/%61%70%70%72%6f%76%65",
  "/api/portal/publish/test-post/%61%70%70%72%6F%76%65",
  "/api/portal/%70ublish/test-post/%61pprove",
  "/api/portal/publish/%74est-post/%61pprove",
]
const actorHeaders = {
  "x-naia-proxy-secret": "route-path-test-secret",
  "x-naia-peer": "127.0.0.1",
  "x-naia-local": "1",
  "x-naia-origin-ok": "1",
  "x-naia-actor-id": "test-gate:writer",
  "x-naia-actor-verified": "1",
}

describe("게시 승인 경로 해석과 권한 검사", () => {
  afterEach(() => vi.unstubAllEnvs())

  const boot = async (normalizeSlashes = false) => {
    vi.stubEnv("PUBLISH_GATEWAY_SCOPE", "test-gate")
    vi.stubEnv("PUBLISH_APPROVER_IDS", "test-gate:owner")
    const app = Fastify({ routerOptions: { ignoreDuplicateSlashes: normalizeSlashes, ignoreTrailingSlash: normalizeSlashes } })
    app.decorate("proxySecret", "route-path-test-secret")
    await app.register(portalPublishRoutes, { prefix: "/api/portal/publish" })
    return app
  }

  it.each([undefined, "", "0", "true"])("확인 표시 %s에서 실제 Fastify가 선택한 모든 승인 별칭은 신원 검사 전에 403이다", async (flag) => {
    vi.stubEnv("PUBLISH_GATEWAY_OVERWRITE_CONFIRMED", flag)
    const app = await boot()
    try {
      for (const url of paths) {
        // 신원·서명키·원고 없이도 승인 처리기에 들어간 즉시 같은 403이어야 한다.
        const response = await app.inject({ method: "POST", url })
        expect(response.statusCode, url).toBe(403)
        expect(response.json().code, url).toBe("publish_gateway_unconfirmed")
        expect(response.headers["cache-control"]).toBe("no-store")
      }
      const status = await app.inject({ url: "/api/portal/publish/test-post/status" })
      expect(status.statusCode).toBe(401)
      expect(status.json().code).toBe("publish_identity_required")
    } finally { await app.close() }
  })

  it("확인 표시가 켜져도 실제 승인 별칭에는 신원과 승인 담당자 검사가 모두 적용된다", async () => {
    vi.stubEnv("PUBLISH_GATEWAY_OVERWRITE_CONFIRMED", "1")
    const app = await boot()
    try {
      for (const url of paths) {
        const anonymous = await app.inject({ method: "POST", url })
        expect(anonymous.statusCode, url).toBe(401)
        expect(anonymous.json().code, url).toBe("publish_identity_required")
        const writer = await app.inject({ method: "POST", url, headers: actorHeaders })
        expect(writer.statusCode, url).toBe(403)
        expect(writer.json().code, url).toBe("publish_approver_required")
      }
    } finally { await app.close() }
  })

  it("라우터가 중복·끝 슬래시를 허용해도 선택된 승인 처리기는 확인 표시를 검사한다", async () => {
    vi.stubEnv("PUBLISH_GATEWAY_OVERWRITE_CONFIRMED", "0")
    const app = await boot(true)
    try {
      for (const url of [
        "/api/portal/publish/test-post//approve",
        "/api/portal//publish//test-post///%61pprove/",
        "/api/portal/publish/test-post/approve/",
      ]) {
        const response = await app.inject({ method: "POST", url })
        expect(response.statusCode, url).toBe(403)
        expect(response.json().code).toBe("publish_gateway_unconfirmed")
      }
    } finally { await app.close() }
  })

  it("기본 라우터는 이중 인코딩과 구분자 인코딩·중복 슬래시를 새 승인 별칭으로 허용하지 않는다", async () => {
    vi.stubEnv("PUBLISH_GATEWAY_OVERWRITE_CONFIRMED", "0")
    const app = await boot()
    try {
      for (const url of [
        "/api/portal/publish/test-post/%2561pprove",
        "/api/portal/publish/test-post%2fapprove",
        "/api/portal/publish/test-post%2Fapprove",
        "/api/portal/publish/test-post//approve",
        "/api/portal/publish/test-post/approve/",
      ]) {
        const response = await app.inject({ method: "POST", url })
        expect(response.statusCode, url).toBe(404)
      }
    } finally { await app.close() }
  })
})
