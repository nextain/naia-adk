import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { isScheduleLinkTarget, scheduleDetailHref } from "@naia-adk/core/src/schedule-link"
import { Nav, NavTabs } from "../components/Nav"
import { ScheduleDetailDialog } from "./ScheduleDetailDialog"
import { ScheduleView } from "./ScheduleView"
import { requestBoardSchedule } from "./schedule-board-state"
import {
  buildCalendarCells,
  DEFAULT_SCHEDULE_LAYERS,
  extractLedgerDueSchedule,
  isSafeScheduleLocalId,
  MAX_QUEUE_DESCRIPTION_LENGTH,
  placeScheduleOnCalendar,
  sanitizeLedgerDocHref,
} from "./schedule-calendar"
import { findLinkedEvent, readScheduleDeepLink, resolveDeepLink } from "./schedule-deep-link"

describe("업무 장부(work-ledger) → 통합 일정(/schedule) 투영 및 딥링크·네비게이션 연동", () => {
  it("① configured: true, available: true 장부 응답을 workItems·undatedItems로 변환하고 docLink·상태·무기한 닫힘 필터를 지킨다", () => {
    const longNote = "메".repeat(MAX_QUEUE_DESCRIPTION_LENGTH + 40)
    const payload = {
      configured: true,
      available: true,
      view: "due",
      observedAt: "2026-11-18T06:00:00Z",
      todayDate: "2026-11-18",
      timezone: "Asia/Seoul",
      items: [
        {
          id: "card-open-1",
          role: "coder",
          title: "PR 통합 검증",
          status: "open",
          dueDate: "2026-11-17",
          overdue: true,
          note: longNote,
          resultLinks: [
            { kind: "url", href: "https://evil.example.test/leak" },
            { kind: "doc", href: "javascript:alert(1)" },
            { kind: "doc", href: "//evil.example.test/docs?source=adk&path=a.md" },
            { kind: "doc", href: "/docs?tab=developer&source=adk&path=developer%2Freport.md" },
          ],
        },
        {
          id: "card-wait-1",
          role: "planner",
          title: "확인 대기 항목",
          status: "waiting_human",
          dueDate: "2026-11-19",
          overdue: false,
          note: "사람 확인 필요",
          resultLinks: [{ kind: "doc", href: "/d/abc123" }],
        },
        {
          id: "card-esc-1",
          role: "reviewer",
          title: "에스컬레이션 항목",
          status: "escalated_human",
          dueDate: "2026-11-20",
          overdue: false,
          note: "",
          resultLinks: [],
        },
        {
          id: "card-done-1",
          role: "coder",
          title: "완료된 기한 항목",
          status: "done",
          dueDate: "2026-11-16",
          overdue: true,
          note: "",
          resultLinks: [{ kind: "doc", href: "https://evil.example.test/doc" }],
        },
        {
          id: "card-drop-1",
          role: "coder",
          title: "제외된 기한 항목",
          status: "dropped",
          dueDate: "2026-11-15",
          overdue: true,
          note: "",
          resultLinks: [],
        },
        {
          id: "undated-open",
          role: "planner",
          title: "기한 미정 활성 작업",
          status: "open",
          dueDate: null,
          overdue: false,
          note: "기한 없음",
          resultLinks: [],
        },
        {
          id: "undated-bad-date",
          role: "coder",
          title: "유효하지 않은 달력 날짜",
          status: "waiting_human",
          dueDate: "2026-02-30",
          overdue: false,
          note: "",
          resultLinks: [],
        },
        {
          id: "undated-done",
          role: "coder",
          title: "기한 없는 완료 항목(제외 대상)",
          status: "done",
          dueDate: null,
          overdue: false,
          note: "",
          resultLinks: [],
        },
        {
          id: "undated-dropped",
          role: "coder",
          title: "기한 없는 제외 항목(제외 대상)",
          status: "dropped",
          dueDate: null,
          overdue: false,
          note: "",
          resultLinks: [],
        },
      ],
    }

    const projection = extractLedgerDueSchedule(payload)
    assert.equal(projection.observedAt, "2026-11-18T06:00:00Z")
    assert.equal(projection.todayDate, "2026-11-18")
    assert.deepEqual(projection.milestones, [])

    assert.equal(projection.workItems.length, 5)
    const [openItem, waitItem, escItem, doneItem, dropItem] = projection.workItems

    assert.equal(openItem.id, "card-open-1")
    assert.equal(openItem.status, "진행 중")
    assert.equal(openItem.assignee, "coder")
    assert.equal(openItem.overdue, true)
    assert.equal(openItem.completed, false)
    assert.equal(openItem.cancelled, false)
    assert.equal(openItem.startDate, "2026-11-17")
    assert.equal(openItem.endDate, "2026-11-17")
    assert.equal(openItem.dueDate, "2026-11-17")
    assert.equal(openItem.startSource, "ledger.due")
    assert.equal(openItem.endSource, "ledger.due")
    assert.equal(openItem.dueSource, "ledger.due")
    assert.deepEqual(openItem.dateSources, ["ledger.due"])
    assert.equal(openItem.docLink, "/docs?tab=developer&source=adk&path=developer%2Freport.md")
    assert.equal(openItem.description?.length, MAX_QUEUE_DESCRIPTION_LENGTH)

    assert.equal(waitItem.status, "확인 대기")
    assert.equal(waitItem.docLink, "/d/abc123")
    assert.equal(escItem.status, "사람 개입")

    // 완료·제외 항목은 payload.overdue=true 여도 overdue=false
    assert.equal(doneItem.status, "완료")
    assert.equal(doneItem.completed, true)
    assert.equal(doneItem.cancelled, false)
    assert.equal(doneItem.overdue, false)
    assert.equal(doneItem.docLink, null)

    assert.equal(dropItem.status, "제외")
    assert.equal(dropItem.completed, false)
    assert.equal(dropItem.cancelled, true)
    assert.equal(dropItem.overdue, false)

    // 기한 없는 항목은 활성만 포함되고 닫힌(done/dropped) 무기한 항목은 제외
    assert.deepEqual(
      projection.undatedItems.map((i) => i.id),
      ["undated-open", "undated-bad-date"],
    )
    assert.equal(projection.undatedItems[0].hasDates, false)
    assert.equal(projection.undatedItems[0].dueDate, null)
    assert.deepEqual(projection.undatedItems[0].dateSources, [])

    // docLink 보안 검증 직접 확인
    assert.equal(sanitizeLedgerDocHref("javascript:alert(1)"), null)
    assert.equal(sanitizeLedgerDocHref("https://evil.example.test/docs?source=adk&path=a.md"), null)
    assert.equal(sanitizeLedgerDocHref("//evil.example.test/d/abc"), null)
    assert.equal(sanitizeLedgerDocHref("/docs\u0000?source=adk"), null)
    assert.equal(sanitizeLedgerDocHref("/d/../secret"), null)
    assert.equal(sanitizeLedgerDocHref("/docs?source=adk&path=a.md"), "/docs?source=adk&path=a.md")
    assert.equal(sanitizeLedgerDocHref("/d/abc123"), "/d/abc123")
  })

  it("② 변환된 WorkScheduleItem이 work:<id> 딥링크 생성·조회·기본 달력 표시·ScheduleDetailDialog와 1:1 호환된다", () => {
    const projection = extractLedgerDueSchedule({
      configured: true,
      available: true,
      view: "due",
      observedAt: "2026-11-18T06:00:00Z",
      todayDate: "2026-11-18",
      items: [
        {
          id: "ledger-task-1",
          role: "coder",
          title: "일정 딥링크 연동 검증",
          status: "open",
          dueDate: "2026-11-18",
          overdue: false,
          note: "장부 메모 본문",
          resultLinks: [{ kind: "doc", href: "/docs?source=adk&path=common%2Fplan.md" }],
        },
        {
          id: "ledger-done-1",
          role: "planner",
          title: "완료 장부 작업",
          status: "done",
          dueDate: "2026-11-18",
          overdue: false,
          note: "",
          resultLinks: [],
        },
      ],
    })

    const item = projection.workItems[0]
    assert.equal(isSafeScheduleLocalId(item.id), true)
    assert.equal(isScheduleLinkTarget({ layer: "work", id: item.id, date: item.dueDate! }), true)

    const href = scheduleDetailHref({ layer: "work", id: item.id, date: item.dueDate! })
    assert.equal(href, "/schedule?item=work%3Aledger-task-1&date=2026-11-18")

    const parsed = readScheduleDeepLink(href.slice("/schedule".length))
    assert.deepEqual(parsed, { layer: "work", id: "ledger-task-1", date: "2026-11-18" })

    const defaultCells = placeScheduleOnCalendar(
      buildCalendarCells("2026-11-18", "month", "2026-11-18"),
      {
        layers: DEFAULT_SCHEDULE_LAYERS,
        workFilter: "open",
        personalItems: [],
        workItems: projection.workItems,
        milestones: [],
      },
    )

    const found = findLinkedEvent(defaultCells, parsed!)
    assert.ok(found, "기본 work 층에서 work:<id> 딥링크 이벤트를 찾아야 한다")
    assert.equal(found.id, "ledger-task-1")
    assert.equal(found.layer, "work")

    // deep link 효과는 완료 항목 포함을 위해 workFilter를 'all'로 전환할 때까지 대기한다
    assert.equal(
      resolveDeepLink(defaultCells, parsed!, {
        sourceLoaded: true,
        layerShown: true,
        mode: "calendar",
        workFilter: "open",
      }).status,
      "wait",
    )

    // 완료·진행 항목 모두 workFilter="all" 일 때 딥링크로 열린다
    const doneHref = scheduleDetailHref({ layer: "work", id: "ledger-done-1", date: "2026-11-18" })
    const doneTarget = readScheduleDeepLink(doneHref.slice("/schedule".length))!
    const allCells = placeScheduleOnCalendar(
      buildCalendarCells("2026-11-18", "month", "2026-11-18"),
      {
        layers: DEFAULT_SCHEDULE_LAYERS,
        workFilter: "all",
        personalItems: [],
        workItems: projection.workItems,
        milestones: [],
      },
    )
    const openResolved = resolveDeepLink(allCells, parsed!, {
      sourceLoaded: true,
      layerShown: true,
      mode: "calendar",
      workFilter: "all",
    })
    assert.equal(openResolved.status, "found")
    assert.equal(
      resolveDeepLink(allCells, doneTarget, { sourceLoaded: true, layerShown: true, mode: "calendar", workFilter: "all" }).status,
      "found",
    )

    // ScheduleView + ScheduleDetailDialog SSR 호환 검증
    const viewHtml = renderToStaticMarkup(
      React.createElement(ScheduleView, {
        hasBoard: false,
        initialAnchorDate: "2026-11-18",
        initialPersonalItems: [],
        initialCompanyItems: [],
        initialBoardSchedule: projection,
        initialDeepLink: parsed!,
      }),
    )
    assert.ok(viewHtml.includes("일정 딥링크 연동 검증"))

    const dialogHtml = renderToStaticMarkup(
      React.createElement(ScheduleDetailDialog, { event: found, onClose: () => {} }),
    )
    assert.ok(dialogHtml.includes("업무 장부"))
    assert.ok(dialogHtml.includes("장부 메모 본문"))
    assert.ok(dialogHtml.includes("/docs?source=adk&amp;path=common%2Fplan.md"))
    assert.ok(!dialogHtml.includes("등록된 세부 작업이 없습니다"))
  })

  it("③ configured: false 또는 404 응답 시 /board-schedule 폴백이 정상 동작한다", async () => {
    const legacyProjection = {
      observedAt: "2026-11-18T00:00:00Z",
      todayDate: "2026-11-18",
      workItems: [],
      undatedItems: [],
      milestones: [],
    }

    // 1) configured: false -> /board-schedule 503 board_not_configured -> "not-configured"
    const callsUnconfigured: string[] = []
    const resUnconfigured = await requestBoardSchedule((async (input: RequestInfo | URL) => {
      const url = String(input)
      callsUnconfigured.push(url)
      if (url.startsWith("/api/portal/ledger")) {
        return Response.json({ configured: false, available: false, items: [] })
      }
      return Response.json({ error: "board_not_configured" }, { status: 503 })
    }) as typeof fetch)
    assert.deepEqual(callsUnconfigured, ["/api/portal/ledger?view=due", "/board-schedule"])
    assert.equal(resUnconfigured.status, "not-configured")

    // 2) configured: false -> /board-schedule 200 -> "ready"
    const resFallbackReady = await requestBoardSchedule((async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith("/api/portal/ledger")) {
        return Response.json({ configured: false, available: false, items: [] })
      }
      return Response.json(legacyProjection)
    }) as typeof fetch)
    assert.equal(resFallbackReady.status, "ready")

    // 3) 404 (구형 API 서버) -> /board-schedule 폴백 -> "ready"
    const calls404: string[] = []
    const res404 = await requestBoardSchedule((async (input: RequestInfo | URL) => {
      const url = String(input)
      calls404.push(url)
      if (url.startsWith("/api/portal/ledger")) {
        return new Response("Not Found", { status: 404 })
      }
      return Response.json(legacyProjection)
    }) as typeof fetch)
    assert.deepEqual(calls404, ["/api/portal/ledger?view=due", "/board-schedule"])
    assert.equal(res404.status, "ready")
  })

  it("④ configured: true, available: false 및 500/403 응답 시 /board-schedule로 폴백하지 않고 unavailable을 반환한다", async () => {
    for (const mockRes of [
      () => Response.json({ configured: true, available: false, items: [], warnings: ["EACCES"] }),
      () => Response.json({ error: "Internal Server Error" }, { status: 500 }),
      () => Response.json({ error: "Forbidden" }, { status: 403 }),
      () => Response.json({ error: "Unauthorized" }, { status: 401 }),
    ]) {
      const calledUrls: string[] = []
      const result = await requestBoardSchedule((async (input: RequestInfo | URL) => {
        calledUrls.push(String(input))
        if (String(input) === "/board-schedule") {
          assert.fail("fail-closed: /board-schedule fallback must not be called")
        }
        return mockRes()
      }) as typeof fetch)
      assert.equal(result.status, "unavailable")
      assert.deepEqual(calledUrls, ["/api/portal/ledger?view=due"])
    }
  })

  it("⑤ Nav/NavTabs: hasBoard=false, hasLedger=true, todoBadgeCount=4에서 5개 탭과 활성 작업 링크, 할 일 4 배지를 표시한다", () => {
    const html = renderToStaticMarkup(
      React.createElement(Nav, {
        initialTheme: "dark",
        initialFontSize: "md",
        hasBoard: false,
        hasLedger: true,
        hasMessenger: true,
        todoBadgeCount: 4,
      }),
    )

    for (const tabId of ["docs", "schedule", "decisions", "work", "messages"]) {
      assert.ok(html.includes(`data-testid="nav-tab-${tabId}"`), `missing tab ${tabId}`)
    }
    const workTabMatch = html.match(/<a[^>]*data-testid="nav-tab-work"[^>]*>/)
    assert.ok(workTabMatch, "작업 탭은 span이 아니라 활성 <a> 링크여야 한다")
    assert.ok(workTabMatch[0].includes('href="/work"'))

    assert.ok(html.includes('data-testid="nav-todo-badge"'))
    assert.ok(html.includes(">할 일 4<"))

    // hasBoard=false, hasLedger=false 일 때는 작업 탭이 비활성 span 이어야 한다
    const disabledHtml = renderToStaticMarkup(
      React.createElement(NavTabs, {
        pathname: "/schedule",
        hasBoard: false,
        hasLedger: false,
        hasMessenger: true,
      }),
    )
    const disabledWorkMatch = disabledHtml.match(/<span[^>]*data-testid="nav-tab-work"[^>]*>/)
    assert.ok(disabledWorkMatch, "장부도 보드도 없으면 작업 탭은 비활성 span 이어야 한다")
    assert.ok(disabledWorkMatch[0].includes('aria-disabled="true"'))
  })
})
