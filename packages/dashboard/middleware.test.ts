import test, { describe, it } from "node:test"
import assert from "node:assert/strict"
import * as M from "./middleware.ts"
import * as NS from "next/server"
import { FRAME_ANCESTORS_CSP } from "./frame-policy.mjs"

const NextRequest = NS.NextRequest ?? (NS as any).default?.NextRequest
const middleware = M.middleware ?? (M as any).default?.middleware

describe("middleware 단위 시험", () => {
  it("(아) middleware()의 CSP가 FRAME_ANCESTORS_CSP이고 x-frame-options는 null이다", () => {
    const req = new NextRequest("http://localhost:3142/docs", {
      headers: { host: "localhost:3142" },
    })
    const res = middleware(req)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get("content-security-policy"), FRAME_ANCESTORS_CSP)
    assert.equal(res.headers.get("x-frame-options"), null)
  })

  it("(자) Host evil.example이면 421이고 Host 검사가 그대로다", () => {
    const req = new NextRequest("http://evil.example/docs", {
      headers: { host: "evil.example" },
    })
    const res = middleware(req)
    assert.equal(res.status, 421)
    assert.equal(res.headers.get("content-security-policy"), FRAME_ANCESTORS_CSP)
    assert.equal(res.headers.get("x-frame-options"), null)
  })
})
