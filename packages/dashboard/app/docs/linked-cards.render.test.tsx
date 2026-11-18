import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { DocsView, type Source } from "./DocsView.tsx"
import { FileView } from "./FileView.tsx"
import { Nav } from "../components/Nav.tsx"
import { HomeTodoSummary } from "../components/HomeTodoSummary.tsx"
import { isSafeVisibleText } from "./kinds.ts"
import { sectionsForTab } from "./tabs.ts"
import type { LedgerCardItem, LedgerPayload } from "../work/work-ledger-view.ts"

const sampleCards: LedgerCardItem[] = [
  {
    id: "card-doc-1",
    role: "minho",
    title: "대시보드 결과 문서 작성",
    status: "open",
    due: "2026-11-17T06:00:00Z",
    dueDate: "2026-11-17",
    overdue: true,
    isTodo: true,
    createdAt: null,
    checkedAt: null,
    note: "",
    channel: "100",
    msgId: "200",
    quote: "",
    sourceUrl: "https://discord.com/channels/999/100/200",
    resultLinks: [
      {
        kind: "doc",
        label: "guide.md",
        displayPath: "developer/guide.md",
        href: "/docs?tab=developer&source=adk&path=developer%2Fguide.md",
        source: "adk",
        path: "developer/guide.md",
      },
    ],
    workerName: null,
    hasDrive: false,
  },
]

const dummySources: Source[] = [
  {
    id: "adk",
    title: "ADK 문서",
    tree: [{ name: "guide.md", path: "developer/guide.md", type: "file", kind: "doc" }],
  },
]

describe("문서↔카드 연결, Nav 할 일 배지, 대시보드 요약 할 일 렌더 시험", () => {
  it("DocsView 및 FileView가 linkedCards가 있을 때만 연결된 업무 카드를 보여 준다", () => {
    const htmlWith = renderToStaticMarkup(
      <DocsView
        activeTab="developer"
        sources={dummySources}
        tabSections={sectionsForTab(dummySources, "developer")}
        currentSource="adk"
        currentPath="developer/guide.md"
        viewMode="doc"
        docContent="# 가이드"
        linkedCards={sampleCards}
      />,
    )
    assert.ok(htmlWith.includes('data-testid="doc-linked-cards"'))
    assert.ok(htmlWith.includes("대시보드 결과 문서 작성"))
    assert.ok(htmlWith.includes('href="/work?role=minho"'))
    assert.ok(htmlWith.includes('href="https://discord.com/channels/999/100/200"'))

    const htmlWithout = renderToStaticMarkup(
      <DocsView
        activeTab="developer"
        sources={dummySources}
        tabSections={sectionsForTab(dummySources, "developer")}
        currentSource="adk"
        currentPath="developer/guide.md"
        viewMode="doc"
        docContent="# 가이드"
        linkedCards={[]}
      />,
    )
    assert.ok(!htmlWithout.includes('data-testid="doc-linked-cards"'))

    const fileHtml = renderToStaticMarkup(
      <FileView
        sourceId="adk"
        sourceTitle="ADK 문서"
        path="assets/report.pdf"
        tab="developer"
        kind="pdf"
        linkedCards={sampleCards}
      />,
    )
    assert.ok(fileHtml.includes('data-testid="doc-linked-cards"'))
  })

  it("Nav 머리줄에 장부 기반 '할 일 N' 배지를 띄우고 hasLedger면 작업 탭을 연다", () => {
    const html = renderToStaticMarkup(
      <Nav initialTheme="dark" initialFontSize="md" hasBoard={false} hasLedger={true} todoBadgeCount={7} />,
    )
    assert.ok(html.includes('data-testid="nav-todo-badge"'))
    assert.ok(html.includes(">할 일 7<"))
    assert.ok(html.includes('href="/work"'))
    const textTokens = html.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean)
    for (const token of textTokens) {
      assert.equal(isSafeVisibleText(token), true, `unsafe token: ${token}`)
    }
  })

  it("첫 화면(HomeTodoSummary)이 open+waiting_human 할 일과 기한 넘음 카드를 보여 준다", () => {
    const ledger: LedgerPayload = {
      configured: true,
      available: true,
      view: "board",
      observedAt: "2026-11-18T06:00:00Z",
      todayDate: "2026-11-18",
      timezone: "Asia/Seoul",
      roles: ["minho"],
      summary: { total: 1, todoCount: 1, open: 1, waiting_human: 0, escalated_human: 0, done: 0, dropped: 0, overdue: 1 },
      filteredSummary: { total: 1, todoCount: 1, open: 1, waiting_human: 0, escalated_human: 0, done: 0, dropped: 0, overdue: 1 },
      items: sampleCards,
      warnings: [],
    }
    const html = renderToStaticMarkup(<HomeTodoSummary initialLedger={ledger} nowMs={Date.parse("2026-11-18T06:00:00Z")} />)
    assert.ok(html.includes('data-testid="home-todo-summary"'))
    assert.ok(html.includes('data-testid="home-todo-count"'))
    assert.ok(html.includes("대시보드 결과 문서 작성"))
    assert.ok(html.includes('href="/docs?tab=developer&amp;source=adk&amp;path=developer%2Fguide.md"'))
  })
})
