import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ShortLinkButton, shortPathFallback } from "./ShortLinkButton.tsx"

describe("짧은 주소 단추", () => {
  it("문서 머리에 [짧은 주소] 단추를 그린다", () => {
    const html = renderToStaticMarkup(<ShortLinkButton source="adk" path="developer/architecture/ARCHITECTURE.md" />)
    assert.match(html, /data-testid="short-link-button"/)
    assert.match(html, /aria-label="짧은 주소 복사"/)
    assert.match(html, /짧은 주소/)
  })

  it("등록 실패 때 쓰는 경로 형식은 조각마다 인코딩한다", () => {
    assert.equal(shortPathFallback("adk", "developer/a b.md"), "/d/adk/developer/a%20b.md")
    assert.equal(shortPathFallback("company:example-docs", "01. 온보딩/x.md"), `/d/company%3Aexample-docs/${encodeURIComponent("01. 온보딩")}/x.md`)
  })
})
