import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ScheduleView } from "./ScheduleView"
import { ScheduleDayListDialog, ScheduleDetailDialog } from "./ScheduleDetailDialog"
import { requestCompanySchedule } from "./schedule-view-model"
import { buildCalendarCells, DEFAULT_SCHEDULE_LAYERS, placeScheduleOnCalendar, type CompanyScheduleItem } from "./schedule-calendar"

const sampleCompanyItems: CompanyScheduleItem[] = [
  {
    id: "company:md:112233445566",
    title: "교육청 양평 AX 강의",
    startDate: "2026-11-18",
    endDate: "2026-11-18",
    startTime: "09:00",
    endTime: "12:00",
    role: "루크·지나",
    status: "오전 확정",
    sourceDocPath: "common/alpha/schedule.md",
    kind: "company",
  },
  {
    id: "company:reg:retro-daily-alpha:2026-11-18",
    title: "매일 회고",
    startDate: "2026-11-18",
    endDate: "2026-11-18",
    startTime: "22:00",
    role: "alpha",
    roleLabel: "알파",
    state: "있음",
    status: "있음",
    sourceDocPath: "common/team/regular-schedule.yaml",
    kind: "regular",
    repeatSummary: "매일",
  },
]

describe("회사·정기 일정 UI 및 딥링크 렌더 검증", () => {
  it("requestCompanySchedule 은 /api/portal/schedule/company 응답과 오류를 안전하게 처리한다", async () => {
    let requestedUrl = ""
    const okFetch = (async (input: RequestInfo | URL) => {
      requestedUrl = String(input)
      return Response.json({ from: "2026-11-01", to: "2026-11-30", items: sampleCompanyItems })
    }) as typeof fetch

    const ok = await requestCompanySchedule("2026-11-01", "2026-11-30", okFetch)
    assert.equal(requestedUrl, "/api/portal/schedule/company?from=2026-11-01&to=2026-11-30")
    assert.equal(ok.status, "ready")
    if (ok.status === "ready") assert.equal(ok.items.length, 2)

    const errRes = await requestCompanySchedule(
      "2026-11-01",
      "2026-11-30",
      (async () => new Response("", { status: 500 })) as typeof fetch,
    )
    assert.deepEqual(errRes, { status: "unavailable" })

    const netErr = await requestCompanySchedule(
      "2026-11-01",
      "2026-11-30",
      (async () => {
        throw new Error("network down")
      }) as typeof fetch,
    )
    assert.deepEqual(netErr, { status: "unavailable" })
  })

  it("ScheduleView 는 회사 일정 계층 토글·정기 반복 토글·달력 막대·목록 보기를 렌더링한다", () => {
    const htmlCal = renderToStaticMarkup(
      React.createElement(ScheduleView, {
        hasBoard: false,
        initialMode: "calendar",
        initialAnchorDate: "2026-11-18",
        initialPersonalItems: [],
        initialCompanyItems: sampleCompanyItems,
        initialShowRegular: false,
      }),
    )

    assert.match(htmlCal, /data-testid="schedule-layer-company"[^>]*aria-pressed="true"/)
    assert.match(htmlCal, /data-testid="schedule-toggle-regular"[^>]*aria-pressed="false"/)
    // 기본값(정기 반복 끔)에서는 schedule.md 일정은 달력에 나오고 매일 회고는 빠진다
    assert.match(htmlCal, /data-testid="calendar-event-company-company:md:112233445566"/)
    assert.doesNotMatch(htmlCal, /data-testid="calendar-event-company-company:reg:retro-daily-alpha:2026-11-18"/)

    // 정기 반복을 켜면 둘 다 달력에 나온다
    const htmlWithReg = renderToStaticMarkup(
      React.createElement(ScheduleView, {
        hasBoard: false,
        initialMode: "calendar",
        initialAnchorDate: "2026-11-18",
        initialPersonalItems: [],
        initialCompanyItems: sampleCompanyItems,
        initialShowRegular: true,
      }),
    )
    assert.match(htmlWithReg, /data-testid="schedule-toggle-regular"[^>]*aria-pressed="true"/)
    assert.match(htmlWithReg, /data-testid="calendar-event-company-company:reg:retro-daily-alpha:2026-11-18"/)

    // 목록 보기에서도 회사 일정이 렌더링된다
    const htmlList = renderToStaticMarkup(
      React.createElement(ScheduleView, {
        hasBoard: false,
        initialMode: "list",
        initialAnchorDate: "2026-11-18",
        initialPersonalItems: [],
        initialCompanyItems: sampleCompanyItems,
        initialShowRegular: true,
      }),
    )
    assert.match(htmlList, /data-testid="schedule-list-company"/)
    assert.match(htmlList, /data-testid="list-company-item-company:md:112233445566"/)
    assert.match(htmlList, /data-testid="list-company-item-company:reg:retro-daily-alpha:2026-11-18"/)
  })

  it("ScheduleDetailDialog 와 ScheduleDayListDialog 는 담당·상태·시각 및 /docs?source=adk&path=... 원본 문서 링크를 표시한다", () => {
    const cells = placeScheduleOnCalendar(buildCalendarCells("2026-11-18", "month", "2026-11-18"), {
      layers: DEFAULT_SCHEDULE_LAYERS,
      includeRegular: true,
      companyItems: sampleCompanyItems,
    })
    const nov18Cell = cells.find((c) => c.date === "2026-11-18")!
    assert.equal(nov18Cell.events.length, 2)

    const mdDetailHtml = renderToStaticMarkup(
      React.createElement(ScheduleDetailDialog, { event: nov18Cell.events[0], onClose: () => {} }),
    )
    assert.match(mdDetailHtml, /회사 일정/)
    assert.match(mdDetailHtml, /2026-11-18 09:00~12:00/)
    assert.match(mdDetailHtml, /루크·지나/)
    assert.match(mdDetailHtml, /오전 확정/)
    assert.match(
      mdDetailHtml,
      /data-testid="schedule-detail-company-doc-link"[^>]*|href="\/docs\?source=adk&amp;path=common%2Falpha%2Fschedule\.md"/,
    )
    assert.match(mdDetailHtml, /href="\/docs\?source=adk&amp;path=common%2Falpha%2Fschedule\.md"/)

    const regDetailHtml = renderToStaticMarkup(
      React.createElement(ScheduleDetailDialog, { event: nov18Cell.events[1], onClose: () => {} }),
    )
    assert.match(regDetailHtml, /정기 반복/)
    assert.match(regDetailHtml, /2026-11-18 22:00/)
    assert.match(regDetailHtml, /알파/)
    assert.match(regDetailHtml, /매일/)
    assert.match(regDetailHtml, /href="\/docs\?source=adk&amp;path=common%2Fteam%2Fregular-schedule\.yaml"/)

    const dayListHtml = renderToStaticMarkup(
      React.createElement(ScheduleDayListDialog, { cell: nov18Cell, onClose: () => {}, onSelectEvent: () => {} }),
    )
    assert.match(dayListHtml, /회사 일정 \(2건\)/)
    assert.match(dayListHtml, /day-list-event-company-company:md:112233445566/)
  })
})
