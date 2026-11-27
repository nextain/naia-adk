import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import {
  DocMarkdown,
  handleCodeBlockCopy,
  isUnsafeMarkdownHref,
  isUnsafeSvgHrefValue,
  MermaidBlock,
  sanitizeMermaidSvg,
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

  it("sanitizeMermaidSvg: 루트 <svg>의 onload를 지운다", () => {
    const clean = withShimDom(() =>
      sanitizeMermaidSvg('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="1" height="1"/></svg>'),
    )
    assert.ok(clean, "살균된 SVG가 있어야 함")
    assert.ok(!clean.includes("onload"), "루트 onload가 남아 있으면 안 됨")
    assert.ok(!clean.includes("alert(1)"))
    assert.ok(clean.includes("<svg"))
    assert.ok(clean.includes("<rect"))
  })

  it("sanitizeMermaidSvg: 자손 on*·script·위험 href를 지우고 안전한 href는 둔다", () => {
    const clean = withShimDom(() =>
      sanitizeMermaidSvg(
        '<svg xmlns="http://www.w3.org/2000/svg"><g onclick="x(1)"><a href="javascript:alert(1)"><text>y</text></a>' +
          '<a xlink:href="data:text/html,<h1>x</h1>">z</a><a href="https://example.com/a">ok</a>' +
          "<script>alert(2)</script></g></svg>",
      ),
    )
    assert.ok(clean, "살균된 SVG가 있어야 함")
    assert.ok(!clean.includes("onclick"))
    assert.ok(!clean.includes("javascript:"))
    assert.ok(!clean.includes("data:text/html"))
    assert.ok(!clean.includes("<script"))
    assert.ok(!clean.includes("alert("))
    assert.ok(clean.includes('href="https://example.com/a"'))
  })

  it("sanitizeMermaidSvg: svg가 아니거나 깨진 입력은 null이다", () => {
    assert.equal(sanitizeMermaidSvg("<div>hi</div>"), null)
    assert.equal(sanitizeMermaidSvg(""), null)
    const broken = withShimDom(() => sanitizeMermaidSvg("<svg><g></svg>"))
    assert.equal(broken, null)
  })

  it("isUnsafeSvgHrefValue가 위험 스킴만 가린다", () => {
    assert.equal(isUnsafeSvgHrefValue("javascript:alert(1)"), true)
    assert.equal(isUnsafeSvgHrefValue("  JaVaScRiPt:x"), true)
    assert.equal(isUnsafeSvgHrefValue("data:text/html,<h1>x</h1>"), true)
    assert.equal(isUnsafeSvgHrefValue("vbscript:x"), true)
    assert.equal(isUnsafeSvgHrefValue("https://example.com/a"), false)
    assert.equal(isUnsafeSvgHrefValue("data:image/svg+xml,%3Csvg"), false)
    assert.equal(isUnsafeSvgHrefValue("#section"), false)
    assert.equal(isUnsafeSvgHrefValue(null), false)
    assert.equal(isUnsafeSvgHrefValue(""), false)
  })

  it("isUnsafeSvgHrefValue가 제어 문자로 가린 javascript:를 막는다", () => {
    const tab = String.fromCharCode(9)
    const lf = String.fromCharCode(10)
    const cr = String.fromCharCode(13)
    assert.equal(isUnsafeSvgHrefValue("java" + tab + "script:alert(1)"), true)
    assert.equal(isUnsafeSvgHrefValue("java" + lf + "script:alert(1)"), true)
    assert.equal(isUnsafeSvgHrefValue("java" + cr + "script:alert(1)"), true)
    assert.equal(isUnsafeSvgHrefValue(tab + " vbscript:x"), true)
  })

  it("sanitizeMermaidSvg: 제어 문자로 가린 위험 href를 지운다", () => {
    const tab = String.fromCharCode(9)
    const lf = String.fromCharCode(10)
    const clean = withShimDom(() =>
      sanitizeMermaidSvg(
        '<svg xmlns="http://www.w3.org/2000/svg"><a href="java' +
          tab +
          'script:alert(1)"><text>y</text></a>' +
          '<a href="java' +
          lf +
          'script:alert(1)">z</a></svg>',
      ),
    )
    assert.ok(clean, "살균된 SVG가 있어야 함")
    assert.ok(!clean.includes("alert(1)"), "가려진 javascript: href가 남아 있으면 안 됨")
    assert.ok(!clean.includes("href="), "위험 href 속성이 남아 있으면 안 됨")
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

// sanitizeMermaidSvg는 브라우저 DOMParser/XMLSerializer를 쓴다.
// node --test 환경에는 DOM이 없으므로, 여기서만 쓰는 최소 XML 이중자를
// 깔아 실제 살균 루프(루트 포함·속성 제거·직렬화)를 실행한다.
interface ShimAttr {
  name: string
  value: string
}

class ShimElement {
  tagName: string
  attributes: ShimAttr[] = []
  children: ShimElement[] = []
  parent: ShimElement | null = null

  constructor(tagName: string) {
    this.tagName = tagName
  }

  removeAttribute(name: string): void {
    this.attributes = this.attributes.filter((a) => a.name !== name)
  }

  remove(): void {
    if (this.parent) {
      this.parent.children = this.parent.children.filter((c) => c !== this)
      this.parent = null
    }
  }

  querySelectorAll(sel: string): ShimElement[] {
    const out: ShimElement[] = []
    const walk = (el: ShimElement) => {
      for (const child of el.children) {
        if (sel === "*" || child.tagName.toLowerCase() === sel.toLowerCase()) out.push(child)
        walk(child)
      }
    }
    walk(this)
    return out
  }
}

class ShimDocument {
  children: ShimElement[] = []

  get documentElement(): ShimElement | null {
    return this.children[0] ?? null
  }

  querySelector(sel: string): ShimElement | null {
    const out: ShimElement[] = []
    const walk = (el: ShimElement) => {
      if (el.tagName.toLowerCase() === sel.toLowerCase()) out.push(el)
      for (const child of el.children) walk(child)
    }
    for (const child of this.children) walk(child)
    return out[0] ?? null
  }
}

function parseShimSvg(text: string, doc: ShimDocument): void {
  const stack: ShimElement[] = []
  const tagRe = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']*))?)*)\s*(\/?)>/g
  const attrRe = /([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]*))?/g
  let ok = true
  let m: RegExpExecArray | null
  while (ok && (m = tagRe.exec(text)) !== null) {
    const closing = m[1] === "/"
    const tag = m[2]
    if (closing) {
      const top = stack.pop()
      if (!top || top.tagName !== tag) {
        ok = false
        break
      }
      continue
    }
    const node = new ShimElement(tag)
    attrRe.lastIndex = 0
    let am: RegExpExecArray | null
    while ((am = attrRe.exec(m[3])) !== null) {
      const name = am[1]
      if (!name || name.startsWith("/")) continue
      let value = am[2] ?? ""
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
      else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1)
      node.attributes.push({ name, value })
    }
    if (stack.length > 0) {
      const parent = stack[stack.length - 1]
      node.parent = parent
      parent.children.push(node)
    } else {
      doc.children.push(node)
    }
    if (m[4] !== "/") stack.push(node)
  }
  if (!ok || stack.length !== 0) {
    doc.children = [new ShimElement("parsererror")]
  }
}

function escapeShimAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function serializeShim(el: ShimElement): string {
  const attrs = el.attributes.map((a) => ` ${a.name}="${escapeShimAttr(a.value)}"`).join("")
  if (el.children.length === 0) return `<${el.tagName}${attrs}/>`
  return `<${el.tagName}${attrs}>${el.children.map(serializeShim).join("")}</${el.tagName}>`
}

class ShimDOMParser {
  parseFromString(text: string, _mime: string): ShimDocument {
    const doc = new ShimDocument()
    parseShimSvg(String(text ?? ""), doc)
    return doc
  }
}

class ShimXMLSerializer {
  serializeToString(doc: ShimDocument): string {
    return doc.children.map(serializeShim).join("")
  }
}

function withShimDom<T>(fn: () => T): T {
  const g = globalThis as any
  const prevParser = g.DOMParser
  const prevSerializer = g.XMLSerializer
  g.DOMParser = ShimDOMParser
  g.XMLSerializer = ShimXMLSerializer
  try {
    return fn()
  } finally {
    if (prevParser === undefined) delete g.DOMParser
    else g.DOMParser = prevParser
    if (prevSerializer === undefined) delete g.XMLSerializer
    else g.XMLSerializer = prevSerializer
  }
}
