import { describe, expect, it } from "vitest"
import Fastify from "fastify"
import {
  canApprove,
  PublishIdentityError,
  requireApprover,
  requirePublishIdentity,
  type PublishIdentityRequest,
} from "../src/publish-identity.js"

const env = { PUBLISH_GATEWAY_SCOPE: "test-gate", PUBLISH_APPROVER_IDS: "test-gate:owner-one", PUBLISH_GATEWAY_OVERWRITE_CONFIRMED: "1" }
const proxySecret = "isolated-publish-proxy-secret"

function request(headers: Record<string, string | string[] | undefined> = {}): PublishIdentityRequest {
  const all = {
    "x-naia-proxy-secret": proxySecret,
    "x-naia-peer": "127.0.0.1",
    "x-naia-local": "127.0.0.1",
    "x-naia-origin-ok": "1",
    "x-naia-actor-id": "test-gate:owner-one",
    "x-naia-actor-verified": "1",
    ...headers,
  }
  return {
    headers: all,
    server: { proxySecret },
    raw: {
      rawHeaders: Object.entries(all).filter(([, value]) => value !== undefined)
        .flatMap(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value!]),
      socket: { remoteAddress: "127.0.0.1" },
    },
  }
}

function rejects(fn: () => unknown, status: number, code?: string) {
  try {
    fn()
    expect.fail("신원 검사가 실패해야 합니다.")
  } catch (error) {
    expect(error).toBeInstanceOf(PublishIdentityError)
    expect(error).toMatchObject({ status, ...(code ? { code } : {}) })
  }
}

describe("게시 계정과 승인자 경계", () => {
  it("검증된 scope:key만 읽고 쓰기는 같은 출처 확인도 요구한다", () => {
    expect(requirePublishIdentity(request(), env, true)).toBe("test-gate:owner-one")
    const noOrigin = request({ "x-naia-origin-ok": undefined })
    expect(requirePublishIdentity(noOrigin, env)).toBe("test-gate:owner-one")
    rejects(() => requirePublishIdentity(noOrigin, env, true), 403, "publish_origin_forbidden")
  })

  it("직접 3141 접근에서 위조 actor·표시명·계정 본문은 프록시 증명이 되지 않는다", () => {
    for (const secret of [undefined, "forged-proxy-secret"]) {
      const direct = request({
        host: "127.0.0.1:3141",
        "x-naia-proxy-secret": secret,
        "x-ax-user": encodeURIComponent("대표님"),
        "x-ax-account-key": "owner-one",
      })
      Object.assign(direct, { body: { approver_id: "test-gate:owner-one", role: "admin" }, trust: { trusted: true, secretValid: true, originOk: true } })
      rejects(() => requirePublishIdentity(direct, env, true), 401)
    }
  })

  it("실제 소켓과 전달된 peer가 모두 신뢰 출처여야 한다", () => {
    const external = request()
    external.raw!.socket!.remoteAddress = "203.0.113.10"
    rejects(() => requirePublishIdentity(external, env), 403)
    rejects(() => requirePublishIdentity(request({ "x-naia-peer": "203.0.113.10" }), env), 403)
    const missingSocket = request()
    missingSocket.raw!.socket = undefined
    rejects(() => requirePublishIdentity(missingSocket, env), 403)
  })

  it("신원·관문 범위·프록시 설정이 없으면 승인 기능을 열지 않는다", () => {
    for (const headers of [
      { "x-naia-actor-id": undefined },
      { "x-naia-actor-verified": undefined },
      { "x-naia-actor-verified": "true" },
      { "x-naia-actor-id": "test-gate:대표님" },
      { "x-naia-actor-id": "other-gate:owner-one" },
      { "x-naia-actor-id": "test-gate:Owner-one" },
      { "x-naia-actor-id": "test-gate:owner-one " },
    ]) rejects(() => requirePublishIdentity(request(headers), env), 401)
    for (const scope of [undefined, "", "test:gate", " test-gate", "대표님"]) {
      rejects(() => requirePublishIdentity(request(), { ...env, PUBLISH_GATEWAY_SCOPE: scope }), 503)
    }
    const unconfigured = request()
    unconfigured.server = { proxySecret: null }
    rejects(() => requirePublishIdentity(unconfigured, env), 503)
  })

  it("모든 내부 보안 머리글의 배열·합친 값·중복 원본·키·파싱 불일치를 거절한다", () => {
    for (const name of ["x-naia-proxy-secret", "x-naia-peer", "x-naia-local", "x-naia-origin-ok", "x-naia-actor-id", "x-naia-actor-verified"]) {
      const original = request().headers[name] as string
      for (const value of [[original], `${original}, ${original}`]) {
        rejects(() => requirePublishIdentity(request({ [name]: value }), env, true), 401)
      }
      const duplicateRaw = request()
      duplicateRaw.raw!.rawHeaders = [...duplicateRaw.raw!.rawHeaders!, name.toUpperCase(), original]
      rejects(() => requirePublishIdentity(duplicateRaw, env, true), 401)
      const duplicateKey = request({ [name.toUpperCase()]: original })
      rejects(() => requirePublishIdentity(duplicateKey, env, true), 401)
      const mismatch = request()
      mismatch.headers[name] = "different"
      rejects(() => requirePublishIdentity(mismatch, env, true), 401)
    }
  })

  it("미리보기 성공 뒤 해제된 기기는 다음 승인 요청에서 신원을 다시 요구한다", () => {
    expect(requirePublishIdentity(request(), env)).toBe("test-gate:owner-one")
    const revoked = request({ "x-naia-actor-id": undefined, "x-naia-actor-verified": undefined })
    rejects(() => requirePublishIdentity(revoked, env, true), 401, "publish_identity_required")
  })

  it("승인자는 정확한 계정 집합만 인정하고 표시명·접두·부분 일치를 허용하지 않는다", () => {
    for (const flag of [undefined, "", "0", "true"]) {
      const unconfirmed = { ...env, PUBLISH_GATEWAY_OVERWRITE_CONFIRMED: flag }
      expect(canApprove("test-gate:owner-one", unconfirmed)).toBe(false)
      rejects(() => requireApprover("test-gate:owner-one", unconfirmed), 403, "publish_gateway_unconfirmed")
    }
    expect(canApprove("test-gate:owner-one", env)).toBe(true)
    expect(requireApprover("test-gate:owner-one", env)).toBeUndefined()
    for (const actor of ["owner-one", "대표님", "test-gate:owner", "test-gate:owner-one-more", "test-gate:writer-one", "other-gate:owner-one"]) {
      expect(canApprove(actor, env)).toBe(false)
      rejects(() => requireApprover(actor, env), 403)
    }
    const multiple = { ...env, PUBLISH_APPROVER_IDS: " test-gate:owner-one, test-gate:owner-two " }
    expect(canApprove("test-gate:owner-two", multiple)).toBe(true)
    for (const raw of [undefined, "", "대표님", "test-gate:owner-one,", "test-gate:owner-one,other-gate:owner-two"]) {
      const config = { ...env, PUBLISH_APPROVER_IDS: raw }
      expect(canApprove("test-gate:owner-one", config)).toBe(false)
      rejects(() => requireApprover("test-gate:owner-one", config), 503)
    }
  })

  it("Fastify 요청에서도 원본 중복을 거절하고 정상 쓰기만 통과한다", async () => {
    const app = Fastify()
    app.decorate("proxySecret", proxySecret)
    app.post("/approve", async (req, reply) => {
      try {
        const actor = requirePublishIdentity(req, env, true)
        requireApprover(actor, env)
        return { actor }
      } catch (error) {
        const identityError = error as PublishIdentityError
        return reply.code(identityError.status).send({ code: identityError.code })
      }
    })
    try {
      const valid = await app.inject({ method: "POST", url: "/approve", headers: request().headers })
      expect(valid.statusCode).toBe(200)
      expect(valid.json()).toEqual({ actor: "test-gate:owner-one" })
      const forged = await app.inject({ method: "POST", url: "/approve", headers: { "x-naia-actor-id": "test-gate:owner-one", "x-naia-actor-verified": "1" } })
      expect(forged.statusCode).toBe(401)
      const duplicate = await app.inject({ method: "POST", url: "/approve", headers: { ...request().headers, "x-naia-actor-id": ["test-gate:owner-one", "test-gate:owner-one"] } })
      expect(duplicate.statusCode).toBe(401)
    } finally {
      await app.close()
    }
  })
})
