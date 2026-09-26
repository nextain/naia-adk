import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { saveDocument } from "./DocEditor.tsx"
import { MSG_CONFLICT_DOC, MSG_FORBIDDEN } from "./kinds.ts"

describe("문서 저장 계약 시험 (SP-04, 검수 반영 3번 및 검수 2회차 반영)", () => {
  it("저장 요청 시 PUT 본문에 { content, baseHash }가 있고 If-Match 헤더는 없다", async () => {
    let capturedMethod = ""
    let capturedUrl = ""
    let capturedHeaders: Record<string, string> = {}
    let capturedBody = ""

    const fakeFetch: typeof fetch = async (input, init) => {
      capturedMethod = init?.method ?? ""
      capturedUrl = String(input)
      const headers = init?.headers as Record<string, string>
      capturedHeaders = { ...headers }
      capturedBody = String(init?.body ?? "")

      return new Response(JSON.stringify({ ok: true, sha256: "new-hash-1234" }), {
        status: 200,
        headers: {
          etag: "new-hash-1234",
          "content-type": "application/json",
        },
      })
    }

    const result = await saveDocument({
      source: "adk",
      path: "guide.md",
      content: "# 새 내용",
      baseHash: "old-hash-5678",
      fetchFn: fakeFetch,
    })

    // 메서드 및 URL 확인
    assert.equal(capturedMethod, "PUT")
    assert.equal(capturedUrl, "/api/portal/doc?source=adk&path=guide.md")

    // If-Match 헤더가 절대 없어야 함
    assert.equal(capturedHeaders["If-Match"], undefined)
    assert.equal(capturedHeaders["if-match"], undefined)

    // Content-Type 확인
    assert.equal(capturedHeaders["Content-Type"], "application/json")

    // 본문 검증: content와 baseHash 포함
    const parsedBody = JSON.parse(capturedBody)
    assert.equal(parsedBody.content, "# 새 내용")
    assert.equal(parsedBody.baseHash, "old-hash-5678")

    // 결과 확인: 200 성공 및 새 sha256 반환
    assert.equal(result.ok, true)
    assert.equal(result.status, 200)
    assert.equal(result.sha256, "new-hash-1234")
  })

  it("409 changed 응답 시 conflict: true 및 SP-04 충돌 안내 문구 반환", async () => {
    const fakeFetch: typeof fetch = async () => {
      return new Response(JSON.stringify({ error: "changed" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      })
    }

    const result = await saveDocument({
      source: "adk",
      path: "guide.md",
      content: "# 충돌 시도 내용",
      baseHash: "outdated-hash",
      fetchFn: fakeFetch,
    })

    assert.equal(result.ok, false)
    assert.equal(result.status, 409)
    assert.equal(result.conflict, true)
    assert.equal(result.error, MSG_CONFLICT_DOC)
  })

  it("403 Forbidden 응답 시 forbidden: true 및 SP-06 안내 문구 반환", async () => {
    const fakeFetch: typeof fetch = async () => {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })
    }

    const result = await saveDocument({
      source: "adk",
      path: "guide.md",
      content: "# 접근 불가 내용",
      baseHash: "any-hash",
      fetchFn: fakeFetch,
    })

    assert.equal(result.ok, false)
    assert.equal(result.status, 403)
    assert.equal(result.forbidden, true)
    assert.equal(result.error, MSG_FORBIDDEN)
  })
})
