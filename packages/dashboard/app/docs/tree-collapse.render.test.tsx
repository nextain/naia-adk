import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { DocsView, type Source } from "./DocsView.tsx"
import { sectionsForTab } from "./tabs.ts"
import { parseStoredBoolean, type StorageLike } from "./panel-size.ts"

// Left document tree collapse toggle (ported from the pre-11/24 UX and adapted
// to the generic i18n labels). The toggle persists via localStorage
// (`docs.treeCollapsed`) and the tree pane scrolls independently of the doc.
describe("문서 트리 접기·펴기 렌더 및 상태 (docs.treeCollapsed)", () => {
  const dummySources: Source[] = [
    {
      id: "adk",
      title: "ADK 문서",
      tree: [
        {
          name: "developer",
          path: "developer",
          type: "directory",
          children: [{ name: "guide.md", path: "developer/guide.md", type: "file", kind: "doc" }],
        },
      ],
    },
  ]
  const tabSections = sectionsForTab(dummySources, "common")

  const renderGrid = (props: Partial<React.ComponentProps<typeof DocsView>> = {}) =>
    renderToStaticMarkup(
      <DocsView
        activeTab="common"
        sources={dummySources}
        tabSections={tabSections}
        currentSource="adk"
        currentPath="developer"
        viewMode="grid"
        folderData={{ entries: [], total: 0, truncated: false }}
        {...props}
      />,
    )

  it("접힌 상태: 펼치기 띠 단추(aria-expanded=false)가 있고 aside는 md에서 숨는다", () => {
    const html = renderGrid({ initialTreeCollapsed: true })

    assert.ok(html.includes('data-testid="tree-collapse-toggle"'))
    assert.ok(html.includes('aria-expanded="false"'))
    assert.ok(html.includes('aria-label="폴더 목록 펼치기"'))

    const asideMatch = html.match(/<aside[^>]+class="([^"]+)"/)
    assert.ok(asideMatch, "aside가 존재해야 함")
    assert.ok(asideMatch[1].includes("md:hidden"))
    assert.ok(!asideMatch[1].includes("md:block"))
  })

  it("편 상태: 접기 단추(aria-expanded=true)가 있고 aside가 보이며 너비 변수를 쓴다", () => {
    const html = renderGrid({ initialTreeCollapsed: false })

    assert.ok(html.includes('data-testid="tree-collapse-toggle"'))
    assert.ok(html.includes('aria-expanded="true"'))
    assert.ok(html.includes('aria-label="폴더 목록 접기"'))

    assert.ok(html.includes("<aside"))
    assert.ok(html.includes("--tree-width"))
    assert.ok(html.includes("hidden md:block"))
  })

  it("접힘 값 저장과 복원: 가짜 저장소의 1/0에 따라 접힘 상태가 복원된다", () => {
    const store = new Map<string, string>()
    const fakeStorage: StorageLike = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, val: string) => {
        store.set(key, val)
      },
    }

    fakeStorage.setItem("docs.treeCollapsed", "1")
    const htmlCollapsed = renderGrid({ storage: fakeStorage })
    assert.ok(htmlCollapsed.includes('aria-expanded="false"'))

    fakeStorage.setItem("docs.treeCollapsed", "0")
    const htmlExpanded = renderGrid({ storage: fakeStorage })
    assert.ok(htmlExpanded.includes('aria-expanded="true"'))
  })

  it("parseStoredBoolean 순수 함수 검증", () => {
    assert.equal(parseStoredBoolean("1"), true)
    assert.equal(parseStoredBoolean("true"), true)
    assert.equal(parseStoredBoolean("0"), false)
    assert.equal(parseStoredBoolean("false"), false)
    assert.equal(parseStoredBoolean(null, false), false)
    assert.equal(parseStoredBoolean(null, true), true)
    assert.equal(parseStoredBoolean("unknown", false), false)
  })

  it("접힌 상태 + 모바일 열림: 넓은 화면용 클래스는 md:hidden이고 !block이 없다", () => {
    const html = renderGrid({ initialTreeCollapsed: true, mobileTreeOpen: true })

    const asideMatch = html.match(/<aside[^>]+class="([^"]+)"/)
    assert.ok(asideMatch, "aside가 존재해야 함")
    const asideClasses = asideMatch[1]

    assert.ok(!asideClasses.includes("!block"))
    assert.ok(asideClasses.includes("md:hidden"))
    assert.ok(!asideClasses.includes("md:block"))
    assert.ok(asideClasses.includes("block md:hidden"))
  })

  it("접힌 상태와 편 상태의 펼치기 띠·단추 상세", () => {
    const htmlCollapsed = renderGrid({ initialTreeCollapsed: true })

    // aria-expanded="false"인 펼치기 띠 단추는 정확히 1개이며 글자는 ▶뿐이다
    const falseToggles = [
      ...htmlCollapsed.matchAll(/<button\b[^>]*data-testid="tree-collapse-toggle"[^>]*aria-expanded="false"[^>]*>[\s\S]*?<\/button>/g),
    ]
    assert.equal(falseToggles.length, 1)

    const toggleBtn = falseToggles[0][0]
    const classMatch = toggleBtn.match(/class="([^"]*)"/)
    assert.ok(classMatch)
    assert.ok(classMatch[1].split(/\s+/).includes("w-8"))
    assert.ok(classMatch[1].includes("self-stretch"))

    const textOnly = toggleBtn.replace(/<[^>]+>/g, "").trim()
    assert.equal(textOnly, "▶")

    assert.ok(toggleBtn.includes('aria-label="폴더 목록 펼치기"'))
    assert.ok(toggleBtn.includes('title="폴더 목록 펼치기"'))

    // 접힌 aside가 여전히 그려지고 tree-resizer는 그려지지 않는다
    const asideMatch = htmlCollapsed.match(/<aside\b[^>]*class="([^"]*)"/)
    assert.ok(asideMatch)
    assert.ok(asideMatch[1].includes("md:hidden"))
    assert.ok(!htmlCollapsed.includes('data-testid="tree-resizer"'))

    // 편 상태: 펼치기 띠는 없고 접기 단추 1개, resizer가 있다
    const htmlExpanded = renderGrid({ initialTreeCollapsed: false })
    const allTogglesExpanded = [
      ...htmlExpanded.matchAll(/<button\b[^>]*data-testid="tree-collapse-toggle"[^>]*>[\s\S]*?<\/button>/g),
    ]
    assert.equal(allTogglesExpanded.length, 1)
    assert.ok(allTogglesExpanded[0][0].includes('aria-expanded="true"'))
    assert.ok(!htmlExpanded.includes('aria-expanded="false"'))
    assert.ok(htmlExpanded.includes('data-testid="tree-resizer"'))
  })

  it("메모 패널이 독립 스크롤(sticky) 구조로 그려진다", () => {
    const html = renderToStaticMarkup(
      <DocsView
        activeTab="common"
        sources={dummySources}
        tabSections={tabSections}
        currentSource="adk"
        currentPath="developer/guide.md"
        viewMode="doc"
        docContent="# 안내문\n\n본문입니다."
        notes={[]}
      />,
    )
    assert.ok(html.includes('data-testid="notes-panel"'))
    assert.ok(html.includes("lg:sticky"))
    assert.ok(html.includes("lg:overflow-y-auto"))
    assert.ok(html.includes('data-testid="doc-body-shell"'))
    assert.ok(html.includes('data-testid="notes-resizer"'))
  })
})
