import test, { describe, it } from "node:test"
import assert from "node:assert/strict"
import { SHELL_FRAME_ORIGINS, FRAME_ANCESTORS_CSP } from "./frame-policy.mjs"

describe("frame-policy 단위 시험", () => {
  it("(가) SHELL_FRAME_ORIGINS가 정확히 세 개이고 순서·값이 같으며 얼어 있다", () => {
    assert.equal(Array.isArray(SHELL_FRAME_ORIGINS), true)
    assert.equal(SHELL_FRAME_ORIGINS.length, 3)
    assert.equal(SHELL_FRAME_ORIGINS[0], "http://tauri.localhost")
    assert.equal(SHELL_FRAME_ORIGINS[1], "https://tauri.localhost")
    assert.equal(SHELL_FRAME_ORIGINS[2], "tauri://localhost")
    assert.deepEqual(SHELL_FRAME_ORIGINS, [
      "http://tauri.localhost",
      "https://tauri.localhost",
      "tauri://localhost",
    ])
    assert.equal(Object.isFrozen(SHELL_FRAME_ORIGINS), true)
  })

  it("(나) FRAME_ANCESTORS_CSP가 글자 그대로 정해진 문자열이다", () => {
    const expected =
      "frame-ancestors 'self' http://tauri.localhost https://tauri.localhost tauri://localhost"
    assert.equal(FRAME_ANCESTORS_CSP, expected)
  })

  it("(다) 값에 *이 없고, 'self'와 세 출처 외의 원천이 없다", () => {
    assert.equal(FRAME_ANCESTORS_CSP.includes("*"), false)

    const tokens = FRAME_ANCESTORS_CSP.split(/\s+/).filter(Boolean)
    assert.equal(tokens[0], "frame-ancestors")

    const sources = tokens.slice(1)
    const allowedSources = new Set(["'self'", ...SHELL_FRAME_ORIGINS])

    for (const src of sources) {
      assert.equal(
        allowedSources.has(src),
        true,
        `Unexpected source token found in CSP: ${src}`
      )
    }

    assert.equal(sources.length, allowedSources.size)
  })
})
