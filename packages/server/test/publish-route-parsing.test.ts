import { afterEach, describe, expect, it, vi } from "vitest"
import Fastify, { type LightMyRequestResponse } from "fastify"
import { createServer } from "../src/server.js"
import { portalPublishRoutes } from "../src/routes/portal-publish.js"

const prefix = "/api/portal/publish/test-post"
const aliases = [`${prefix}/approve`, `${prefix}/%61pprove`, `${prefix}/approv%65?ignored=1`]
const invalidBodies = [
  { headers: { "content-type": "application/json" }, payload: "{", status: 400 },
  { headers: { "content-type": "application/json" }, payload: "", status: 400 },
  { headers: { "content-type": "text/xml" }, payload: "<request/>", status: 415 },
  { headers: { "content-type": "application/json" }, payload: JSON.stringify({ content: "x".repeat(1_048_576) }), status: 413 },
]

describe.each(["전체 서버", "게시 라우터"] as const)("%s의 게시 본문 파싱", mode => {
  afterEach(() => vi.unstubAllEnvs())
  const boot = async () => {
    if (mode === "전체 서버") return createServer({ root: process.env.TMPDIR || process.cwd(), port: 3175, host: "127.0.0.1" })
    const app = Fastify({ routerOptions: { ignoreDuplicateSlashes: true, ignoreTrailingSlash: true } })
    await app.register(portalPublishRoutes, { prefix: "/api/portal/publish" })
    return app
  }
  const assertError = (response: LightMyRequestResponse, status: number, code: string) => {
    expect(response.statusCode, response.body).toBe(status)
    expect(response.headers["cache-control"]).toBe("no-store")
    const body = response.json()
    expect(body).toEqual({ ok: false, code, message: expect.any(String), retryable: false, request_id: expect.any(String), operation_id: null, issues: [] })
    expect(body.message.length).toBeGreaterThan(0)
    expect(body.request_id.length).toBeGreaterThan(0)
    return body.request_id
  }

  it.each([undefined, "0"])("확인 표시 %s에서는 깨진 본문·매체형식·크기 오류보다 승인 403 차단을 먼저 적용한다", async flag => {
    vi.stubEnv("PUBLISH_GATEWAY_OVERWRITE_CONFIRMED", flag)
    const app = await boot()
    const requests = new Set<string>()
    try {
      const paths = mode === "게시 라우터" ? [...aliases, "/api/portal//publish//test-post///%61pprove/"] : aliases
      for (const url of paths) for (const { headers, payload } of invalidBodies) {
        const response = await app.inject({ method: "POST", url, headers: { host: "localhost:3175", ...headers }, payload })
        const requestId = assertError(response, 403, "publish_gateway_unconfirmed")
        expect(requests.has(requestId)).toBe(false)
        requests.add(requestId)
      }
    } finally { await app.close() }
  })

  it("확인 표시가 켜지면 승인·확인 요청의 파서 오류도 공통 오류 필드와 캐시 금지를 반환한다", async () => {
    vi.stubEnv("PUBLISH_GATEWAY_OVERWRITE_CONFIRMED", "1")
    const app = await boot()
    const requests = new Set<string>()
    try {
      for (const url of [...aliases, `${prefix}/request-review`]) for (const { headers, payload, status } of invalidBodies) {
        const response = await app.inject({ method: "POST", url, headers: { host: "localhost:3175", ...headers }, payload })
        const requestId = assertError(response, status, "REQUEST_INVALID")
        expect(response.json().message).toBe("요청 본문을 확인해 주세요")
        expect(requests.has(requestId)).toBe(false)
        requests.add(requestId)
      }
    } finally { await app.close() }
  })
})
