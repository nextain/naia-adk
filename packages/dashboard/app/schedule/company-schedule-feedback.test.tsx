// 회사 일정 댓글·직접 수정/삭제 UI 검증 (node:test + 정적 렌더).
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { I18nProvider } from "../i18n/provider.tsx"
import {
  CompanyScheduleFeedbackSection,
  ScheduleDetailDialog,
} from "./ScheduleDetailDialog.tsx"
import { en } from "../i18n/en.ts"
import { ko } from "../i18n/ko.ts"
import type { CalendarCellEvent } from "./schedule-calendar-cells.ts"

function companyEvent(): CalendarCellEvent {
  return {
    key: "company:md:abc123-2026-11-18",
    id: "company:md:abc123",
    layer: "company",
    title: "웹GPU 시연",
    startDate: "2026-11-18",
    endDate: "2026-11-18",
    spanPosition: "single",
    allDay: true,
    timeLabel: "하루 종일",
    subtitle: "회사 · 알파",
    overdue: false,
    completed: false,
    companyItem: {
      id: "company:md:abc123",
      title: "웹GPU 시연",
      startDate: "2026-11-18",
      endDate: "2026-11-18",
      role: "알파",
      status: "확정",
      sourceDocPath: "common/alpha/schedule.md",
      kind: "company",
    },
  }
}

const sampleComments = [
  {
    schemaVersion: 1 as const,
    id: "20261124-100000-aaaaaa",
    scheduleId: "company:md:abc123",
    scheduleTitle: "웹GPU 시연",
    targetRole: "alpha",
    sourceDocPath: "common/alpha/schedule.md",
    author: "portal",
    action: "comment" as const,
    body: "날짜를 다시 확인해 주세요",
    createdAt: "2026-11-24T10:00:00.000Z",
  },
]

describe("회사 일정 모달: 댓글 섹션·수정/삭제 버튼", () => {
  it("ko: 댓글 영역과 수정·삭제 버튼이 렌더된다", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="ko">
        <ScheduleDetailDialog event={companyEvent()} onClose={() => {}} />
      </I18nProvider>,
    )
    assert.ok(html.includes('data-testid="company-schedule-comments"'), "comments section")
    assert.ok(html.includes('data-testid="company-schedule-edit-btn"'), "edit button")
    assert.ok(html.includes('data-testid="company-schedule-delete-btn"'), "delete button")
  })

  it("en: 댓글 영역과 수정·삭제 버튼이 렌더된다", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <ScheduleDetailDialog event={companyEvent()} onClose={() => {}} />
      </I18nProvider>,
    )
    assert.ok(html.includes('data-testid="company-schedule-comments"'), "comments section")
    assert.ok(html.includes('data-testid="company-schedule-edit-btn"'), "edit button")
    assert.ok(html.includes('data-testid="company-schedule-delete-btn"'), "delete button")
  })

  it("작업 일정 모달에는 회사 댓글 UI가 없다", () => {
    const workEvent = { ...companyEvent(), layer: "work" as const, companyItem: undefined }
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="ko">
        <ScheduleDetailDialog event={workEvent} onClose={() => {}} />
      </I18nProvider>,
    )
    assert.ok(!html.includes('data-testid="company-schedule-comments"'))
  })
})

describe("CompanyScheduleFeedbackSection: 댓글 목록", () => {
  it("담당 AI 표시와 댓글 본문·삭제 버튼을 보여준다", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="ko">
        <CompanyScheduleFeedbackSection
          scheduleId="company:md:abc123"
          scheduleTitle="웹GPU 시연"
          targetRole="alpha"
          sourceDocPath="common/alpha/schedule.md"
          initialComments={sampleComments}
        />
      </I18nProvider>,
    )
    assert.ok(html.includes("날짜를 다시 확인해 주세요"), "comment body")
    assert.ok(html.includes("alpha"), "target role shown")
    assert.ok(html.includes("data-testid=\"company-schedule-comment-20261124-100000-aaaaaa\""), "comment row")
  })
})

describe("i18n: 회사 일정 댓글·수정·삭제 키 패리티", () => {
  const keys = ["sched.companyComments", "sched.companyEditSchedule", "sched.companyDeleteSchedule"] as const
  for (const key of keys) {
    it(`${key}가 ko/en에 모두 있고 en에는 한글이 없다`, () => {
      assert.ok(typeof (ko as Record<string, string>)[key] === "string" && (ko as Record<string, string>)[key].length > 0, `ko ${key}`)
      assert.ok(typeof (en as Record<string, string>)[key] === "string" && (en as Record<string, string>)[key].length > 0, `en ${key}`)
      assert.ok(!/[\uAC00-\uD7A3]/.test((en as Record<string, string>)[key]), `en ${key} purity`)
    })
  }
})
