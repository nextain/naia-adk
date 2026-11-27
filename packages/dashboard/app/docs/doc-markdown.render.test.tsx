import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import {
  DocMarkdown,
  handleCodeBlockCopy,
  isUnsafeMarkdownHref,
  MermaidBlock,
  slugifyHeading,
} from "./DocMarkdown.tsx"

// DocMarkdown: frontmatter, code blocks, section anchors, mermaid fallback.
describe("DocMarkdown 렌더 (frontmatter·코드·섹션·mermaid)", () => {
  const base = {
    sourceId: "adk",
    path: "developer/guide.md",
    sources: [],
    activeTab: "common" as const,
  }

  it("frontmatter는 본문 위 별도 블록으로 보이고 본문에는 섞이지 않는다", () => {
    const html = renderToStaticMarkup(
      <DocMarkdown {...base} content={"---\ntitle: 안내문\n---\n\n# 안내문\n\n본문입니다."} />,
    )
    assert.ok(html.includes("title: 안내문"))
    assert.ok(html.includes("본문입니다."))
    assert.ok(html.includes('data-testid="doc-markdown"'))
  })

  it("frontmatter가 없으면 meta 블록이 없다", () => {
    const html = renderToStaticMarkup(<DocMarkdown {...base} content={"# 제목\n\n본문"} />)
    assert.ok(!html.includes("bg-neutral-900/60"))
    assert.ok(html.includes("본문"))
  })

  it("제목에 스크롤용 id와 scroll-mt가 붙는다", () => {
    const html = renderToStaticMarkup(<DocMarkdown {...base} content={"# 시작하기\n\n본문"} />)
    const h1 = html.match(/<h1[^>]*>/)
    assert.ok(h1, "h1이 있어야 함")
    assert.ok(h1[0].includes('id="시작하기"') || h1[0].includes("id="))
    assert.ok(h1[0].includes("scroll-mt-20"))
  })

  it("일반 코드 블록은 복사 단추와 함께 그려진다", () => {
    const html = renderToStaticMarkup(
      <DocMarkdown {...base} content={"```js\nconsole.log(1)\n```"} />,
    )
    assert.ok(html.includes("console.log(1)"))
    assert.ok(html.includes("복사"))
    assert.ok(!html.includes("mermaid"))
  })

  it("mermaid 블록은 SSR에서 로딩 박스로 그려지고 절대 깨지지 않는다", () => {
    const html = renderToStaticMarkup(
      <DocMarkdown {...base} content={"```mermaid\ngraph TD\n  A-->B\n```"} />,
    )
    assert.ok(html.includes('data-testid="mermaid-loading"'))
    assert.ok(html.includes("다이어그램"))
  })

  it("MermaidBlock 단독 렌더도 터지지 않는다", () => {
    const html = renderToStaticMarkup(<MermaidBlock code={"graph TD\n  A-->B"} />)
    assert.ok(html.includes('data-testid="mermaid-loading"'))
  })

  it("javascript: 링크는 <a>로 그리지 않고 글자로만 둔다", () => {
    const html = renderToStaticMarkup(
      <DocMarkdown {...base} content={"[눌러](javascript:alert(1))"} />,
    )
    assert.ok(!html.includes("javascript:"))
    assert.ok(html.includes("눌러"))
  })

  it("isUnsafeMarkdownHref가 위험 스킴을 막는다", () => {
    assert.equal(isUnsafeMarkdownHref("javascript:alert(1)"), true)
    assert.equal(isUnsafeMarkdownHref("data:text/html,hi"), true)
    assert.equal(isUnsafeMarkdownHref("vbscript:x"), true)
    assert.equal(isUnsafeMarkdownHref("https://example.com/a"), false)
    assert.equal(isUnsafeMarkdownHref("http://example.com/a"), false)
    assert.equal(isUnsafeMarkdownHref("mailto:a@example.com"), false)
    assert.equal(isUnsafeMarkdownHref("#section"), false)
    assert.equal(isUnsafeMarkdownHref(null), true)
    assert.equal(isUnsafeMarkdownHref(""), true)
  })

  it("slugifyHeading이 공백·기호를 정리한다", () => {
    assert.equal(slugifyHeading("시작하기!"), "시작하기")
    assert.equal(slugifyHeading("Hello World"), "hello-world")
    assert.equal(slugifyHeading("  "), "")
  })

  it("handleCodeBlockCopy가 복사 성공·실패를 그대로 돌려준다", async () => {
    assert.equal(await handleCodeBlockCopy({ innerText: "code\n" }, async () => true), "copied")
    assert.equal(await handleCodeBlockCopy({ innerText: "code\n" }, async () => false), "failed")
    assert.equal(
      await handleCodeBlockCopy({ innerText: "code" }, async () => {
        throw new Error("denied")
      }),
      "failed",
    )
    assert.equal(await handleCodeBlockCopy(null, async () => true), "copied")
  })
})
