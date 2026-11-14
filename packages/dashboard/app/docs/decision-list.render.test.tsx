import { describe, it } from "node:test"
import assert from "node:assert/strict"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { DecisionList } from "../decisions/DecisionList"
import { parseDecisionSection } from "../decisions/decisions"

const config = { source: "company:example", path: "plans/결정.md", pendingHeading: "## 2. 대기", doneHeading: "## 2-1. 완료" }
const markdown = `## 2. 대기
| # | 무엇 | 기한 |
|---|---|---|
| 4 | [방식 선택](choice.md) | 내일 |
## 2-1. 완료
| 번호 | 무엇 | 답 |
|---|---|---|
| 5 | 이전 결정 | 승인 |
## 3. 다른 표
| # | 무엇 |
|---|---|
| 9 | 제외 |
`
describe("decision lists", () => {
  it("separates the configured sections and links to the configured document", () => {
    const html = renderToStaticMarkup(<DecisionList config={config} markdown={markdown} />)
    assert.match(html, /지금 정할 것 1/)
    assert.match(html, /끝난 결정 1개/)
    assert.match(html, /방식 선택/)
    assert.match(html, /source=company%3Aexample/)
    assert.match(html, /path=plans%2F%EA%B2%B0%EC%A0%95.md/)
    assert.doesNotMatch(html, /제외/)
  })
  it("rejects missing or ambiguous sections and malformed tables", () => {
    assert.throws(() => parseDecisionSection(markdown, "## 없음"))
    assert.throws(() => parseDecisionSection(`${markdown}\n## 2. 대기`, config.pendingHeading))
    assert.throws(() => parseDecisionSection("## 대기\n| # | 무엇 |\n| 1 | 내용 |", "## 대기"))
  })
  it("supports reordered columns and escaped table separators", () => {
    const rows = parseDecisionSection("## 대기\n| 무엇 | 번호 |\n|---|---|\n| A \\| B | 7 |", "## 대기")
    assert.deepEqual(rows, [{ number: "7", title: "A | B" }])
  })
})
