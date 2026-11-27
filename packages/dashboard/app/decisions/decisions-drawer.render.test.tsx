import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { DecisionsBadge } from "./DecisionsBadge"
import { DecisionsDrawer } from "./DecisionsDrawer"
import type { DecisionsSnapshot } from "./decisions-client"

const snapshot: DecisionsSnapshot = {
  pending: [
    {
      id: "approval:m1",
      decisionId: "PLAN-AAAAAA/STEP-BBBBBB",
      kind: "approval",
      status: "pending",
      title: "새 문서 발행",
      detail: "PLAN-AAAAAA STEP-BBBBBB · 업무-요청",
      source: "messenger:업무-요청",
      path: null,
      url: null,
      actor: "boss",
      method: "approval-code",
      createdAt: "2026-11-27T00:00:00.000Z",
      updatedAt: "2026-11-27T00:00:00.000Z",
    },
    {
      id: "note:20261127-000000-abcdef",
      decisionId: "20261127-000000-abcdef",
      kind: "note",
      status: "pending",
      title: "방향을 확인해 주세요",
      detail: "방향을 확인해 주세요",
      source: "adk",
      path: "plan.md",
      url: null,
      actor: null,
      method: "memo",
      createdAt: "2026-11-27T00:00:00.000Z",
      updatedAt: "2026-11-27T00:00:00.000Z",
    },
    {
      id: "work:helper:w1",
      decisionId: "helper:w1",
      kind: "work",
      status: "pending",
      title: "사람 확인 필요",
      detail: "검토 바람",
      source: null,
      path: null,
      url: null,
      actor: "w1",
      method: "work-wait",
      createdAt: null,
      updatedAt: null,
    },
  ],
  history: [],
  counts: { total: 3, approvals: 1, notes: 1, workWaits: 1, publish: 0 },
  warnings: [],
}

describe("단일 앰버 결재/확인 배지 + 오른쪽 퀵 서랍", () => {
  it("배지가 카운트와 함께 그려지고 닫힘 상태의 서랍은 DOM에 없다", () => {
    const html = renderToStaticMarkup(<DecisionsBadge initialCount={3} />)
    assert.ok(html.includes('data-testid="decisions-badge"'))
    assert.ok(html.includes("결재/확인 3"))
    assert.ok(html.includes("bg-amber-600"))
    assert.ok(!html.includes('data-testid="decisions-drawer"'))
  })

  it("0건이면 은은하게, 알 수 없으면(hidden) 배지가 없다", () => {
    const zero = renderToStaticMarkup(<DecisionsBadge initialCount={0} />)
    assert.ok(zero.includes("결재/확인 0"))
    assert.ok(!zero.includes("bg-amber-600"))

    const hidden = renderToStaticMarkup(<DecisionsBadge />)
    assert.ok(!hidden.includes('data-testid="decisions-badge"'))
  })

  it("서랍이 탭·행·빠른 실행·전체 페이지 링크와 함께 그려진다", () => {
    const html = renderToStaticMarkup(<DecisionsDrawer open={true} onClose={() => {}} initialSnapshot={snapshot} />)
    assert.ok(html.includes('data-testid="decisions-drawer"'))
    assert.ok(html.includes('data-testid="decisions-tab-all"'))
    assert.ok(html.includes('data-testid="decisions-tab-approval"'))
    assert.ok(html.includes('data-testid="decisions-tab-note"'))
    assert.ok(html.includes('data-testid="decisions-tab-work"'))
    assert.ok(html.includes("전체 (3)"))
    assert.ok(html.includes("승인/결재 (1)"))
    assert.ok(html.includes("의견/메모 (1)"))
    assert.ok(html.includes("작업 대기 (1)"))
    assert.ok(html.includes("새 문서 발행"))
    assert.ok(html.includes("방향을 확인해 주세요"))
    assert.ok(html.includes("사람 확인 필요"))
    assert.ok(html.includes('data-testid="decision-approve-approval:m1"'))
    assert.ok(html.includes('data-testid="decision-reject-approval:m1"'))
    assert.ok(html.includes('data-testid="decision-ack-note:20261127-000000-abcdef"'))
    assert.ok(html.includes('data-testid="decision-ack-work:helper:w1"'))
    assert.ok(html.includes('href="/decisions"'))
    assert.ok(html.includes("전체 페이지 열기"))
    // 작업 대기 항목의 "작업 보드에서 보기"는 /work로 가고 /decisions가 아니다.
    assert.ok(html.includes('href="/work"'))
    assert.ok(html.includes("작업 보드에서 보기"))
  })

  it("닫힌 서랍은 그려지지 않는다", () => {
    const html = renderToStaticMarkup(<DecisionsDrawer open={false} onClose={() => {}} initialSnapshot={snapshot} />)
    assert.equal(html, "")
  })

  it("게시 확인 항목은 일반 결재 버튼 없이 문서 딥링크만 보인다", () => {
    const publishSnapshot: DecisionsSnapshot = {
      pending: [
        {
          id: "publish:review_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          decisionId: "review_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          kind: "publish_review",
          status: "pending",
          title: "게시 확인: 시험 원고",
          detail: "대상 site-alpha.example · 판 rev_abc",
          source: "publish",
          path: "source:adk/article/draft.md",
          url: "/docs?tab=common&source=adk&path=article%2Fdraft.md&publishReview=review_abc&publishRevision=rev_abc",
          actor: "writer",
          method: "publish_review",
          createdAt: "2026-11-27T00:00:00.000Z",
          updatedAt: "2026-11-27T00:00:00.000Z",
        },
      ],
      history: [],
      counts: { total: 1, approvals: 0, notes: 0, workWaits: 0, publish: 1 },
      warnings: [],
    }
    const html = renderToStaticMarkup(<DecisionsDrawer open={true} onClose={() => {}} initialSnapshot={publishSnapshot} />)
    // 딥링크는 /docs?publishReview=… 로 그대로 열린다.
    assert.ok(html.includes("publishReview=review_abc"))
    // 일반 결재(승인·거절·확인) 버튼은 절대 없다.
    assert.ok(!html.includes("decision-ack-publish:"))
    assert.ok(!html.includes("decision-approve-publish:"))
    assert.ok(!html.includes("decision-reject-publish:"))
  })
})
