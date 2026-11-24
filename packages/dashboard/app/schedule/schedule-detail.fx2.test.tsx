// fx2 repair-round failing regression test for Sonnet S3: schedule ledger work
// status labels freeze as Korean inside extractLedgerDueSchedule and render
// Korean inside ScheduleDetailDialog even in "en" mode.
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { I18nProvider } from "../i18n/provider.tsx"
import { ScheduleDetailDialog } from "./ScheduleDetailDialog.tsx"
import { ScheduleView } from "./ScheduleView.tsx"
import { buildCalendarCells, extractLedgerDueSchedule, placeScheduleOnCalendar } from "./schedule-calendar.ts"
import { requestBoardSchedule } from "./schedule-board-state.ts"

const HANGUL = /[\uAC00-\uD7A3]/

const ledgerPayload = {
  configured: true,
  available: true,
  view: "due",
  observedAt: "2026-11-18T06:00:00Z",
  todayDate: "2026-11-18",
  items: [
    {
      id: "task-open",
      role: "coder",
      title: "Fix status localization",
      status: "open",
      dueDate: "2026-11-18",
      overdue: false,
      note: "ASCII note",
      resultLinks: [],
    },
    {
      id: "task-wait",
      role: "reviewer",
      title: "Review PR",
      status: "waiting_human",
      dueDate: "2026-11-18",
      overdue: false,
      note: "",
      resultLinks: [],
    },
  ],
}

function statusTextOf(html: string): string {
  const match = html.match(/data-testid="schedule-detail-status"[^>]*>(.*?)<\/dd>/)
  assert.ok(match, "schedule-detail-status must render")
  return match[1]
}

describe("fx2 finding S3: ledger work status localizes in en mode", () => {
  it("ScheduleDetailDialog renders English status even when projection was created with default ko", () => {
    const koProjection = extractLedgerDueSchedule(ledgerPayload)
    const cells = placeScheduleOnCalendar(buildCalendarCells("2026-11-18", "month", "2026-11-18"), {
      layers: { personal: false, company: false, work: true, milestone: false, queue: false },
      workFilter: "all",
      workItems: koProjection.workItems,
      milestones: [],
      locale: "en",
    })
    const openEvent = cells
      .find((c) => c.date === "2026-11-18")!
      .events.find((e) => e.id === "task-open")!
    const waitEvent = cells
      .find((c) => c.date === "2026-11-18")!
      .events.find((e) => e.id === "task-wait")!

    const openHtml = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <ScheduleDetailDialog event={openEvent} onClose={() => {}} />
      </I18nProvider>,
    )
    assert.equal(statusTextOf(openHtml), "In progress")
    assert.equal(HANGUL.test(openHtml), false, "en ScheduleDetailDialog with open workItem must have 0 Hangul")

    const waitHtml = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <ScheduleDetailDialog event={waitEvent} onClose={() => {}} />
      </I18nProvider>,
    )
    assert.equal(statusTextOf(waitHtml), "Awaiting review")
    assert.equal(HANGUL.test(waitHtml), false, "en ScheduleDetailDialog with waiting workItem must have 0 Hangul")
  })

  it("requestBoardSchedule and ScheduleView in en render workItems with zero Hangul", async () => {
    const result = await (
      requestBoardSchedule as unknown as (f: typeof fetch, locale?: "en" | "ko") => Promise<{ status: string; data?: ReturnType<typeof extractLedgerDueSchedule> }>
    )((async () => Response.json(ledgerPayload)) as typeof fetch, "en")
    assert.equal(result.status, "ready")
    assert.equal(result.data!.workItems[0].status, "In progress")
    assert.equal(result.data!.workItems[1].status, "Awaiting review")

    const viewHtml = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <ScheduleView
          hasBoard={false}
          initialAnchorDate="2026-11-18"
          initialPersonalItems={[]}
          initialCompanyItems={[]}
          initialBoardSchedule={result.data}
        />
      </I18nProvider>,
    )
    assert.ok(viewHtml.includes("Fix status localization"))
    assert.equal(HANGUL.test(viewHtml), false, "en ScheduleView with workItems must render 0 Hangul")
  })
})
