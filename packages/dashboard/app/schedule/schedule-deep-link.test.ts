import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { buildCalendarCells, DEFAULT_SCHEDULE_LAYERS, placeScheduleOnCalendar } from "./schedule-calendar.ts"
import { findLinkedEvent, readScheduleDeepLink, resolveDeepLink } from "./schedule-deep-link.ts"

const cells = placeScheduleOnCalendar(buildCalendarCells("2026-11-12", "month", "2026-11-12"), {
  layers: DEFAULT_SCHEDULE_LAYERS,
  personalItems: [
    { id: "ps-1", title: "Planning", start: "2026-11-12 10:00", end: "2026-11-12 11:00", allDay: false, memo: "" },
    { id: "ps-2", title: "Trip", start: "2026-11-10", end: "2026-11-13", allDay: true, memo: "" },
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
})
