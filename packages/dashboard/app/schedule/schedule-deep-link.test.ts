import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { buildCalendarCells, DEFAULT_SCHEDULE_LAYERS, placeScheduleOnCalendar } from "./schedule-calendar.ts"
import { findLinkedEvent, readScheduleDeepLink, resolveDeepLink } from "./schedule-deep-link.ts"

const cells = placeScheduleOnCalendar(buildCalendarCells("2026-11-12", "month", "2026-11-12"), {
  layers: { ...DEFAULT_SCHEDULE_LAYERS, queue: true },
  personalItems: [
    { id: "ps-1", title: "Planning", start: "2026-11-12 10:00", end: "2026-11-12 11:00", allDay: false, memo: "" },
    { id: "ps-2", title: "Trip", start: "2026-11-10", end: "2026-11-13", allDay: true, memo: "" },
  ],
  workItems: [
    {
      id: "doc-1",
      title: "Architecture doc",
      issue: "",
      status: "진행",
      kind: "work_document",
      completed: false,
      cancelled: false,
      overdue: false,
      hasDates: true,
      startDate: "2026-11-14",
      endDate: "2026-11-15",
      dueDate: "2026-11-15",
      startSource: "startAt",
      endSource: "dueDate",
      dueSource: "dueDate",
      dateSources: ["startAt", "dueDate"],
      milestoneId: null,
      milestoneName: null,
      parentGroupId: null,
      parentGroupName: null,
    },
    {
      id: "q-1",
      title: "Queued deploy",
      issue: "owner/repo#10",
      status: "queued",
      kind: "queue",
      completed: false,
      cancelled: false,
      overdue: false,
      hasDates: true,
      startDate: "2026-11-15",
      endDate: "2026-11-15",
      dueDate: "2026-11-15",
      startSource: "startAt",
      endSource: "dueDate",
      dueSource: "dueDate",
      dateSources: ["startAt", "dueDate"],
      milestoneId: null,
      milestoneName: null,
      parentGroupId: null,
      parentGroupName: null,
    },
  ],
  milestones: [{ id: "m1", name: "Beta", description: "", order: 1, dueDate: "2026-11-20", daysRemaining: 8, completed: 0, total: 1, overdue: false }],
})

describe("일정 상세 링크", () => {
  it("주소의 item·date 를 읽고 모양이 틀리면 버린다", () => {
    assert.deepEqual(readScheduleDeepLink("?item=personal%3Aps-1&date=2026-11-12"), { layer: "personal", id: "ps-1", date: "2026-11-12" })
    assert.equal(readScheduleDeepLink("?item=personal%3Aps-1"), null)
    assert.equal(readScheduleDeepLink(""), null)
  })

  it("링크가 가리키는 일정·마일스톤을 달력 칸에서 찾는다", () => {
    assert.equal(findLinkedEvent(cells, { layer: "personal", id: "ps-1", date: "2026-11-12" })?.title, "Planning")
    const trip = findLinkedEvent(cells, { layer: "personal", id: "ps-2", date: "2026-11-12" })
    assert.equal(trip?.id, "ps-2")
    assert.equal(findLinkedEvent(cells, { layer: "milestone", id: "m1", date: "2026-11-20" })?.layer, "milestone")
    // 날짜가 틀려도 같은 화면 안에 있으면 찾는다. 겹이나 id 가 다르면 없다.
    assert.equal(findLinkedEvent(cells, { layer: "personal", id: "ps-1", date: "2026-11-01" })?.id, "ps-1")
    assert.equal(findLinkedEvent(cells, { layer: "milestone", id: "ps-1", date: "2026-11-12" }), null)
    assert.equal(findLinkedEvent(cells, { layer: "personal", id: "gone", date: "2026-11-12" }), null)
  })

  it("데이터가 다 오기 전에는 기다리고, 온 뒤에는 한 번에 찾음·없음을 정한다", () => {
    const ready = { sourceLoaded: true, layerShown: true }
    const target = { layer: "personal" as const, id: "ps-1", date: "2026-11-12" }
    assert.deepEqual(resolveDeepLink(cells, target, { ...ready, sourceLoaded: false }), { status: "wait" })
    assert.deepEqual(resolveDeepLink(cells, target, { ...ready, layerShown: false }), { status: "wait" })
    // 격자가 아직 링크 날짜로 옮겨 가지 않았으면 기다린다.
    assert.deepEqual(resolveDeepLink(cells, { ...target, date: "2027-03-01" }, ready), { status: "wait" })
    const found = resolveDeepLink(cells, target, ready)
    assert.equal(found.status === "found" && found.event.title, "Planning")
    // 지워진 일정은 없음으로 끝난다. 쓰는 쪽은 이때 링크를 비워서 나중에 엉뚱하게 열리지 않게 한다.
    assert.deepEqual(resolveDeepLink(cells, { ...target, id: "gone" }, ready), { status: "missing" })
  })

  it("완료·취소 작업 링크는 전체 필터와 달력 보기가 준비될 때까지 기다린다", () => {
    const work = findLinkedEvent(cells, { layer: "work", id: "doc-1", date: "2026-11-15" })!.workItem!
    const queue = findLinkedEvent(cells, { layer: "queue", id: "q-1", date: "2026-11-15" })!.workItem!
    const items = [{ ...work, completed: true }, { ...queue, cancelled: true }]
    const grid = (workFilter: "open" | "all") => placeScheduleOnCalendar(buildCalendarCells("2026-11-15", "month", "2026-11-12"), {
      layers: { ...DEFAULT_SCHEDULE_LAYERS, queue: true }, workFilter, personalItems: [], workItems: items, milestones: [],
    })
    for (const target of [
      { layer: "work" as const, id: "doc-1", date: "2026-11-15" },
      { layer: "queue" as const, id: "q-1", date: "2026-11-15" },
    ]) {
      const ready = { sourceLoaded: true, layerShown: true }
      assert.deepEqual(resolveDeepLink(grid("open"), target, { ...ready, mode: "calendar", workFilter: "open" }), { status: "wait" })
      assert.deepEqual(resolveDeepLink(grid("all"), target, { ...ready, mode: "list", workFilter: "all" }), { status: "wait" })
      const result = resolveDeepLink(grid("all"), target, { ...ready, mode: "calendar", workFilter: "all" })
      assert.equal(result.status, "found")
    }
  })

  it("실행 대기열(queue) 링크는 layer='work' · workItem.kind='queue' 로 생성된 달력 이벤트를 찾고 작업 문서(work)와 섞이지 않는다", () => {
    const queueTarget = readScheduleDeepLink("?item=queue%3Aq-1&date=2026-11-15")
    assert.deepEqual(queueTarget, { layer: "queue", id: "q-1", date: "2026-11-15" })

    const foundQueue = findLinkedEvent(cells, queueTarget!)
    assert.equal(foundQueue?.id, "q-1")
    assert.equal(foundQueue?.layer, "work")
    assert.equal(foundQueue?.workItem?.kind, "queue")

    const resolvedQueue = resolveDeepLink(cells, queueTarget!, { sourceLoaded: true, layerShown: true })
    assert.equal(resolvedQueue.status === "found" && resolvedQueue.event.title, "Queued deploy")

    // work 링크는 작업 문서만 찾고 큐 항목은 찾지 않으며, queue 링크도 작업 문서를 찾지 않는다.
    assert.equal(findLinkedEvent(cells, { layer: "work", id: "doc-1", date: "2026-11-15" })?.workItem?.kind, "work_document")
    assert.equal(findLinkedEvent(cells, { layer: "work", id: "q-1", date: "2026-11-15" }), null)
    assert.equal(findLinkedEvent(cells, { layer: "queue", id: "doc-1", date: "2026-11-15" }), null)
  })
})
