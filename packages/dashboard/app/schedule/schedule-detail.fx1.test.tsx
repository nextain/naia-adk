// fx1 repair-round regression test: verify2 finding 4 (ScheduleDetailDialog
// open-ended period shows "~~" in ko and a missing space in en).
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { I18nProvider } from "../i18n/provider.tsx"
import { ScheduleDetailDialog } from "./ScheduleDetailDialog.tsx"

function periodOf(html: string): string {
  const match = html.match(/data-testid="schedule-detail-period"[^>]*>(.*?)<\/dd>/)
  assert.ok(match, "schedule-detail-period must render")
  return match[1]
}

function openEndedEvent() {
  return {
    key: "w:1",
    id: "1",
    layer: "work",
    title: "Task A",
    startDate: "2026-11-18",
    endDate: "2026-11-18",
    spanPosition: "single",
    allDay: true,
    timeLabel: "Due",
    subtitle: "",
    overdue: true,
    completed: false,
    workItem: {
      id: "1",
      kind: "work_document",
      title: "Task A",
      startDate: "2026-11-18",
      endDate: "2026-11-18",
      openEnded: true,
      overdue: true,
      completed: false,
      cancelled: false,
      status: "open",
    },
  } as unknown as Parameters<typeof ScheduleDetailDialog>[0]["event"]
}

describe("fx1 finding 4: open-ended schedule period label", () => {
  it("ko shows a single tilde with spaces", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="ko">
        <ScheduleDetailDialog event={openEndedEvent()} onClose={() => {}} />
      </I18nProvider>,
    )
    assert.equal(periodOf(html), "2026-11-18 ~ 진행 중(오늘까지)")
  })

  it("en shows a spaced tilde before the ongoing label", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <ScheduleDetailDialog event={openEndedEvent()} onClose={() => {}} />
      </I18nProvider>,
    )
    assert.equal(periodOf(html), "2026-11-18 ~ ongoing (through today)")
  })
})
