// fx1 repair-round regression test: verify2 finding 3 (ScheduleView renders
// Korean period titles and calendar labels in "en" because useScheduleView
// drops the locale when calling formatCalendarPeriodTitle /
// placeScheduleOnCalendar).
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { I18nProvider } from "../i18n/provider.tsx"
import { ScheduleView } from "./ScheduleView.tsx"
import type { BoardScheduleProjection } from "./schedule-board-projection"

const HANGUL = /[\uAC00-\uD7A3]/

const board: BoardScheduleProjection = {
  observedAt: null,
  todayDate: "2026-11-18",
  workItems: [],
  undatedItems: [],
  milestones: [
    {
      id: "m1",
      name: "Release",
      description: "",
      order: 1,
      dueDate: "2026-11-18",
      daysRemaining: 0,
      completed: 0,
      total: 1,
      overdue: false,
    },
  ],
}

function periodTitleOf(html: string): string {
  const match = html.match(/data-testid="schedule-period-title"[^>]*>(.*?)<\/h2>/)
  assert.ok(match, "schedule-period-title must render")
  return match[1]
}

describe("fx1 finding 3: ScheduleView follows the active locale", () => {
  it("en renders an ASCII period title and English milestone labels", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <ScheduleView hasBoard={true} initialAnchorDate="2026-11-18" initialBoardSchedule={board} />
      </I18nProvider>,
    )
    assert.equal(periodTitleOf(html), "2026-11")
    assert.equal(HANGUL.test(periodTitleOf(html)), false)
    assert.ok(html.includes("Done 0/1"), "milestone event subtitle must be English in en")
    assert.ok(html.includes("Due 2026-11-18"), "milestone list due label must be English in en")
    assert.equal(HANGUL.test(html), false, "en ScheduleView must not render Korean")
  })

  it("ko renders the Korean period title and Korean milestone labels", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="ko">
        <ScheduleView hasBoard={true} initialAnchorDate="2026-11-18" initialBoardSchedule={board} />
      </I18nProvider>,
    )
    assert.equal(periodTitleOf(html), "2026년 11월")
    assert.ok(html.includes("완료 0/1"), "milestone event subtitle must be Korean in ko")
    assert.ok(html.includes("마감 2026-11-18"), "milestone list due label must be Korean in ko")
  })
})
