import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { WorkBoard } from "./WorkBoard.tsx"
import { isSafeVisibleText } from "../docs/kinds.ts"
import type { LedgerPayload } from "./work-ledger-view.ts"

const sampleLedger: LedgerPayload = {
  configured: true,
  available: true,
  view: "board",
  observedAt: "2026-11-18T06:00:00Z",
  todayDate: "2026-11-18",
  timezone: "Asia/Seoul",
  roles: ["jina", "minho"],
  summary: {
    total: 3,
    todoCount: 2,
    open: 1,
    waiting_human: 1,
    escalated_human: 0,
    done: 1,
    dropped: 0,
    overdue: 1,
  },
  filteredSummary: {
    total: 3,
    todoCount: 2,
    open: 1,
    waiting_human: 1,
    escalated_human: 0,
    done: 1,
    dropped: 0,
    overdue: 1,
  },
  warnings: [],
  items: [
    {
      id: "card-overdue",
      role: "minho",
      title: "장부 보드 연동",
      status: "open",
      due: "2026-11-17T06:00:00Z",
      dueDate: "2026-11-17",
      overdue: true,
      isTodo: true,
      createdAt: null,
      checkedAt: null,
      note: "기한 넘긴 작업",
      channel: "100",
      msgId: "200",
      quote: "",
      sourceUrl: "https://discord.com/channels/999/100/200",
      resultLinks: [
        {
          kind: "doc",
          label: "result.md",
          displayPath: "guides/result.md",
          href: "/docs?tab=developer&source=adk&path=guides%2Fresult.md",
          source: "adk",
          path: "guides/result.md",
        },
      ],
      workerName: null,
      hasDrive: false,
    },
    {
      id: "card-wait",
      role: "jina",
      title: "일정 화면 연결",
      status: "waiting_human",
      due: "2026-11-19T06:00:00Z",
      dueDate: "2026-11-19",
      overdue: false,
      isTodo: true,
      createdAt: null,
      checkedAt: null,
      note: "",
      channel: "300",
      msgId: "400",
      quote: "",
      sourceUrl: "https://discord.com/channels/999/300/400",
      resultLinks: [],
      workerName: null,
      hasDrive: false,
    },
    {
      id: "card-done",
      role: "jina",
      title: "검수 통과",
      status: "done",
      due: "2026-11-16T06:00:00Z",
      dueDate: "2026-11-16",
      overdue: false,
      isTodo: false,
      createdAt: null,
      checkedAt: "2026-11-16T07:00:00Z",
      note: "",
      channel: "300",
      msgId: "401",
      quote: "",
      sourceUrl: null,
      resultLinks: [],
      workerName: null,
      hasDrive: false,
    },
  ],
}

describe("WorkBoard render", () => {
  it("falls back to legacy /board/index.html iframe when work-ledger is unconfigured", () => {
    const html = renderToStaticMarkup(
      <WorkBoard
        status="ready"
        ledger={{ ...sampleLedger, configured: false, available: false, items: [] }}
        hasBoard={true}
      />,
    )
    assert.ok(html.includes('data-testid="legacy-board-iframe"'))
    assert.ok(html.includes('src="/board/index.html"'))
  })

  it("renders summary view with role filters, overdue indicator, discord link, and result doc link", () => {
    const html = renderToStaticMarkup(
      <WorkBoard
        status="ready"
        ledger={sampleLedger}
        hasBoard={true}
        nowMs={Date.parse("2026-11-18T06:00:00Z")}
      />,
    )
    assert.ok(html.includes('data-testid="work-tab-summary"'))
    assert.ok(html.includes('data-testid="work-tab-detail"'))
    assert.ok(html.includes('data-testid="work-tab-archive"'))
    assert.ok(html.includes(">보관(옛 대기열)<"))
    assert.ok(html.includes('data-testid="role-filter-minho"'))
    assert.ok(html.includes('data-testid="role-filter-jina"'))
    assert.ok(html.includes('data-testid="ledger-overdue-card-overdue"'))
    assert.ok(html.includes('href="https://discord.com/channels/999/100/200"'))
    assert.ok(html.includes('href="/docs?tab=developer&amp;source=adk&amp;path=guides%2Fresult.md"'))

    const visibleText = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    assert.equal(isSafeVisibleText(visibleText), true)
  })

  it("renders detail view filtered by role and archive tab with legacy iframe", () => {
    const detailHtml = renderToStaticMarkup(
      <WorkBoard
        status="ready"
        ledger={sampleLedger}
        hasBoard={true}
        initialTab="detail"
        initialRole="jina"
        initialDetailStatus="all"
      />,
    )
    assert.ok(detailHtml.includes('data-testid="work-detail-view"'))
    assert.ok(detailHtml.includes('data-testid="detail-row-card-wait"'))
    assert.ok(detailHtml.includes('data-testid="detail-row-card-done"'))
    assert.ok(!detailHtml.includes('data-testid="detail-row-card-overdue"'))

    const archiveHtml = renderToStaticMarkup(
      <WorkBoard status="ready" ledger={sampleLedger} hasBoard={true} initialTab="archive" />,
    )
    assert.ok(archiveHtml.includes('data-testid="archive-board-iframe"'))
    assert.ok(archiveHtml.includes('src="/board/index.html"'))
  })

  it("renders processing KPI (N / M) and a dedicated processing section", () => {
    const processingLedger: LedgerPayload = {
      ...sampleLedger,
      maxSubagents: 3,
      summary: { ...sampleLedger.summary, processing: 2 },
      filteredSummary: { ...sampleLedger.filteredSummary, processing: 2 },
      items: [
        {
          ...sampleLedger.items[0],
          id: "card-run-1",
          title: "구동 중인 카드",
          status: "open",
          note: "현재 단계",
          workerName: "w1",
        },
        {
          ...sampleLedger.items[1],
          id: "card-run-2",
          title: "또 구동 중",
          status: "open",
          note: "",
          workerName: "w2",
        },
        sampleLedger.items[2],
      ],
    }
    const html = renderToStaticMarkup(
      <WorkBoard
        status="ready"
        ledger={processingLedger}
        hasBoard={true}
        nowMs={Date.parse("2026-11-18T06:00:00Z")}
      />,
    )
    assert.ok(html.includes('data-testid="work-kpi-processing"'))
    assert.ok(html.includes("2 / 3"))
    assert.ok(html.includes('data-testid="work-processing-section"'))
    assert.ok(html.includes("w1"))
    assert.ok(html.includes("현재 단계"))
    assert.ok(html.includes('data-testid="ledger-card-card-run-1"'))
    assert.ok(html.includes('href="/docs?tab=developer&amp;source=adk&amp;path=guides%2Fresult.md"'))
  })

  it("shows an empty processing notice and filters the detail tab by processing", () => {
    const html = renderToStaticMarkup(
      <WorkBoard status="ready" ledger={sampleLedger} hasBoard={true} />,
    )
    assert.ok(html.includes('data-testid="work-processing-section"'))
    assert.ok(html.includes("가동 중인 에이전트가 없습니다."))

    const processingLedger: LedgerPayload = {
      ...sampleLedger,
      summary: { ...sampleLedger.summary, processing: 1 },
      filteredSummary: { ...sampleLedger.filteredSummary, processing: 1 },
      items: [
        { ...sampleLedger.items[0], id: "card-run-1", status: "open", workerName: "w1" },
        sampleLedger.items[1],
      ],
    }
    const detailHtml = renderToStaticMarkup(
      <WorkBoard
        status="ready"
        ledger={processingLedger}
        hasBoard={true}
        initialTab="detail"
        initialDetailStatus="processing"
      />,
    )
    assert.ok(detailHtml.includes('data-testid="detail-status-processing"'))
    assert.ok(detailHtml.includes('data-testid="detail-row-card-run-1"'))
    assert.ok(!detailHtml.includes('data-testid="detail-row-card-wait"'))
  })
})
