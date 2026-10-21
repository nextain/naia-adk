import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { DocsView, type SearchHit, type Source } from "./DocsView.tsx"
import {
  isSafeVisibleText,
  MSG_ARCHIVED_DOC,
  MSG_FORBIDDEN,
  MSG_TRUNCATED_GRID,
  MSG_TRUNCATED_TEXT,
} from "./kinds.ts"
import { sectionsForTab } from "./tabs.ts"

// 텍스트 노드 추출 도우미 (태그 속성 제외하고 보이는 텍스트만 추출)
function extractTextNodes(html: string): string[] {
  // <script> and <style> 제거
  const cleanHtml = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
  // 태그들을 공백으로 분리
  const text = cleanHtml.replace(/<[^>]+>/g, " ")
  return text.split(/\s+/).filter(Boolean)
}

describe("DocsView 화면 전체 렌더 시험 (검수 2회차 반영)", () => {
  const dummySources: Source[] = [
    {
      id: "adk",
      title: "ADK 문서",
      tree: [
        { name: "index.md", path: "index.md", type: "file", kind: "doc" },
        {
          name: "developer",
          path: "developer",
          type: "directory",
          children: [
            { name: "guide.md", path: "developer/guide.md", type: "file", kind: "doc" },
            {
              name: "archive",
              path: "developer/archive",
              type: "directory",
              children: [{ name: "old.md", path: "developer/archive/old.md", type: "file", kind: "doc" }],
            },
          ],
        },
      ],
    },
    {
      id: "data:content",
      title: "콘텐츠 결과물",
      tree: [
        { name: "out.png", path: "out.png", type: "file", kind: "image" },
        { name: "ep01.md", path: "ep01.md", type: "file", kind: "doc" },
      ],
      tab: "brand",
      readOnly: true,
    },
  ]

  const tabSections = sectionsForTab(dummySources, "common")

  // ── 1. 폴더 상태 렌더 ──────────────────────────────────────────────────
  it("폴더 상태: 격자가 있고 편집 단추·파일 보기가 없어야 한다", () => {
    const html = renderToStaticMarkup(
      <DocsView
        activeTab="common"
        sources={dummySources}
        tabSections={tabSections}
        currentSource="adk"
        currentPath="developer"
        viewMode="grid"
        folderData={{
          entries: [
            { name: "guide.md", path: "developer/guide.md", type: "file", kind: "doc", size: 1024 },
            { name: "archive", path: "developer/archive", type: "directory", cover: "developer/archive/cover.png" },
          ],
          total: 2,
          truncated: false,
        }}
      />,
    )

    // 격자가 존재함 (항목 수, 폴더 및 파일 엔트리)
    assert.ok(html.includes("2개 항목"))
    assert.ok(html.includes(">guide<") || html.includes(">guide.md<"))
    assert.ok(html.includes(">archive<"))
    // 대표 그림 속성에 /api/portal/asset 포함
    assert.ok(html.includes('src="/api/portal/asset?source=adk&amp;path=developer%2Farchive%2Fcover.png"'))

    // 편집 단추와 파일 보기는 없어야 함
    assert.ok(!html.includes(">편집<"))
    assert.ok(!html.includes("내려받기"))
  })

  // ── 2. 문서 상태 렌더 ──────────────────────────────────────────────────
  it("문서 상태: [편집]·메모가 있고 격자가 없어야 한다", () => {
    const html = renderToStaticMarkup(
      <DocsView
        activeTab="common"
        sources={dummySources}
        tabSections={tabSections}
        currentSource="adk"
        currentPath="developer/guide.md"
        viewMode="doc"
        docContent="# 개발자 가이드\n\n내용입니다."
        docBaseHash="hash123"
        onStartEdit={() => {}}
        notes={[
          {
            id: "note-1",
            source: "adk",
            path: "developer/guide.md",
            quote: null,
            body: "메모 본문",
            status: "open",
            reply: null,
            createdAt: "2026-09-26T10:00:00Z",
            updatedAt: "2026-09-26T10:00:00Z",
            resolvedAt: null,
          },
        ]}
      />,
    )

    // 편집 단추와 메모가 있음
    assert.ok(html.includes(">편집<"))
    assert.ok(html.includes("메모"))
    assert.ok(html.includes("메모 본문"))
    assert.ok(html.includes("개발자 가이드"))

    // 격자 항목 수나 파일 보기는 없음
    assert.ok(!html.includes("개 항목"))
    assert.ok(!html.includes("내려받기"))
  })

  it("데이터 폴더 및 readOnly 출처의 문서는 [편집] 단추가 없어야 한다", () => {
    const brandSections = sectionsForTab(dummySources, "brand")
    const html = renderToStaticMarkup(
      <DocsView
        activeTab="brand"
        sources={dummySources}
        tabSections={brandSections}
        currentSource="data:content"
        currentPath="ep01.md"
        viewMode="doc"
        docContent="# 1화\n\n대본"
        onStartEdit={() => {}}
      />,
    )

    // data: / readOnly 출처이므로 편집 단추가 없어야 함
    assert.ok(!html.includes(">편집<"))
  })

  // ── 3. 그 밖 파일 상태 렌더 ───────────────────────────────────────────
  it("그 밖 파일 상태: 파일 보기만 있고 격자나 편집 단추가 없어야 한다", () => {
    const html = renderToStaticMarkup(
      <DocsView
        activeTab="common"
        sources={dummySources}
        tabSections={tabSections}
        currentSource="adk"
        currentPath="developer/sample.pdf"
        viewMode="file"
        fileData={{
          kind: "pdf",
          size: 15360,
        }}
      />,
    )

    // 파일 보기 및 내려받기 링크 존재
    assert.ok(html.includes("sample.pdf"))
    assert.ok(html.includes("15 KB"))
    assert.ok(html.includes("내려받기"))
    assert.ok(html.includes('data="/api/portal/asset?source=adk&amp;path=developer%2Fsample.pdf"'))

    // 격자와 편집 단추 없음
    assert.ok(!html.includes("개 항목"))
    assert.ok(!html.includes(">편집<"))
  })

  // ── 4. 조건부 문구의 양방향(있을 때/없을 때) 단언 ──────────────────────
  it("500개까지만 보입니다: truncated===true일 때만 있고 아닐 때는 없다", () => {
    const htmlNoTrunc = renderToStaticMarkup(
      <DocsView
        activeTab="common"
        sources={dummySources}
        tabSections={tabSections}
        currentSource="adk"
        currentPath="developer"
        viewMode="grid"
        folderData={{ entries: [], total: 10, truncated: false }}
      />,
    )
    assert.ok(!htmlNoTrunc.includes(MSG_TRUNCATED_GRID))

    const htmlTrunc = renderToStaticMarkup(
      <DocsView
        activeTab="common"
        sources={dummySources}
        tabSections={tabSections}
        currentSource="adk"
        currentPath="developer"
        viewMode="grid"
        folderData={{ entries: [], total: 550, truncated: true }}
      />,
    )
    assert.ok(htmlTrunc.includes(MSG_TRUNCATED_GRID))
  })

  it("앞 1MB만 보입니다: textTruncated===true일 때만 있고 아닐 때는 없다", () => {
    const htmlNoTrunc = renderToStaticMarkup(
      <DocsView
        activeTab="common"
        sources={dummySources}
        tabSections={tabSections}
        currentSource="adk"
        currentPath="data.json"
        viewMode="file"
        fileData={{ kind: "text", textContent: "{}", textTruncated: false }}
      />,
    )
    assert.ok(!htmlNoTrunc.includes(MSG_TRUNCATED_TEXT))

    const htmlTrunc = renderToStaticMarkup(
      <DocsView
        activeTab="common"
        sources={dummySources}
        tabSections={tabSections}
        currentSource="adk"
        currentPath="data.json"
        viewMode="file"
        fileData={{ kind: "text", textContent: "{}", textTruncated: true }}
      />,
    )
    assert.ok(htmlTrunc.includes(MSG_TRUNCATED_TEXT))
  })

  it("보관 문서입니다: 보관 폴더 안의 문서를 편집할 때만 있고 아닐 때는 없다", () => {
    // 일반 문서 편집
    const htmlNormal = renderToStaticMarkup(
      <DocsView
        activeTab="common"
        sources={dummySources}
        tabSections={tabSections}
        currentSource="adk"
        currentPath="developer/guide.md"
        viewMode="doc"
        docContent="내용"
        isEditing={true}
      />,
    )
    assert.ok(!htmlNormal.includes(MSG_ARCHIVED_DOC))

    // 보관 폴더(archive) 안의 문서 편집
    const htmlArchived = renderToStaticMarkup(
      <DocsView
        activeTab="common"
        sources={dummySources}
        tabSections={tabSections}
        currentSource="adk"
        currentPath="developer/archive/old.md"
        viewMode="doc"
        docContent="옛 내용"
        isEditing={true}
      />,
    )
    assert.ok(htmlArchived.includes(MSG_ARCHIVED_DOC))
  })

  it("SP-06 문장: forbidden===true일 때만 있고 아닐 때는 없다", () => {
    const htmlNormal = renderToStaticMarkup(
      <DocsView
        activeTab="common"
        sources={dummySources}
        tabSections={tabSections}
        currentSource="adk"
        currentPath="developer"
        viewMode="grid"
        forbidden={false}
        folderData={{ entries: [], total: 0, truncated: false }}
      />,
    )
    assert.ok(!htmlNormal.includes(MSG_FORBIDDEN))

    const htmlForbidden = renderToStaticMarkup(
      <DocsView
        activeTab="common"
        sources={dummySources}
        tabSections={tabSections}
        currentSource="adk"
        currentPath="developer"
        viewMode="grid"
        forbidden={true}
        folderData={{ entries: [], total: 0, truncated: false }}
      />,
    )
    assert.ok(htmlForbidden.includes(MSG_FORBIDDEN))
  })

  // ── 5. 검색 결과 렌더 및 보이는 글 검증 ───────────────────────────────
  it("검색 결과 목록: 보이는 글에 파일 이름만 있고 hit.path 전체는 없어야 한다", () => {
    const hits: SearchHit[] = [
      {
        source: "adk",
        path: "developer/deep/nested/guide.md",
        title: "가이드 문서",
        snippet: "문서 본문 일부분...",
        archive: null,
      },
    ]

    const html = renderToStaticMarkup(
      <DocsView
        activeTab="common"
        sources={dummySources}
        tabSections={tabSections}
        currentSource="adk"
        currentPath={null}
        viewMode="grid"
        searching={true}
        queryInput="가이드"
        hits={hits}
      />,
    )

    // 링크 주소에는 전체 경로가 포함될 수 있음
    assert.ok(html.includes('href="/docs?tab=developer&amp;source=adk&amp;path=developer%2Fdeep%2Fnested%2Fguide.md"'))

    // 보이는 글에는 파일 이름(guide.md)만 있고 전체 경로(developer/deep/nested/guide.md)는 없어야 함
    assert.ok(html.includes(">guide.md<"))
    assert.ok(!html.includes(">developer/deep/nested/guide.md<"))

    // 보이는 텍스트에 내부 경로/API/해시 누출 없음
    const textNodes = extractTextNodes(html)
    for (const text of textNodes) {
      assert.ok(isSafeVisibleText(text), `Text node contains leak: "${text}"`)
    }
  })

  // ── 6. 전체 화면의 보이는 글 안전성 종합 검증 ─────────────────────────
  it("문서 화면 전체 렌더 출력의 텍스트 노드에 /api/, 절대 경로, 해시가 없어야 한다", () => {
    const html = renderToStaticMarkup(
      <DocsView
        activeTab="common"
        sources={dummySources}
        tabSections={tabSections}
        currentSource="adk"
        currentPath="developer/guide.md"
        viewMode="doc"
        docContent="# 개발자 가이드\n\n내용입니다."
        notes={[
          {
            id: "note-1",
            source: "adk",
            path: "developer/guide.md",
            quote: null,
            body: "메모",
            status: "open",
            reply: null,
            createdAt: "2026-09-26T10:00:00Z",
            updatedAt: "2026-09-26T10:00:00Z",
            resolvedAt: null,
          },
        ]}
      />,
    )

    const textNodes = extractTextNodes(html)
    for (const text of textNodes) {
      assert.ok(isSafeVisibleText(text), `Text node contains leak: "${text}"`)
    }
  })

  it("포털 loading 상태에서 파일 보기·회사 설정 안내·'문서 없음'이 없고 불러오는 중 표시가 있다", () => {
    const html = renderToStaticMarkup(
      <DocsView
        portalStatus="loading"
        activeTab="brand"
        sources={[]}
        tabSections={[]}
        currentSource="adk"
        currentPath="sub"
        viewMode="file"
        hasCompanySource={false}
      />,
    )

    assert.ok(!html.includes("내려받기"))
    assert.ok(!html.includes("미리 볼 수 없는 파일입니다"))
    assert.ok(!html.includes("회사 설정이 아직 없습니다"))
    assert.ok(!html.includes("문서 없음"))
    assert.ok(html.includes("불러오는 중"))
  })
})
