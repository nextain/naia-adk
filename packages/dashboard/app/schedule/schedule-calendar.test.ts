import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  buildCalendarCells,
  buildShortDocLink,
  DEFAULT_SCHEDULE_LAYERS,
  extractBoardSchedule,
  extractWorkDocumentTasks,
  formatCalendarPeriodTitle,
  isTaskDoneStatus,
  layoutCalendarWeeks,
  localDateOnly,
  placeScheduleOnCalendar,
  readStoredCalendarUnit,
  readStoredDisplayMode,
  readStoredScheduleLayers,
  readStoredWorkFilter,
  SCHEDULE_LAYERS_STORAGE_KEY,
  shiftCalendarAnchor,
  taskStatusBadge,
  writeStoredCalendarUnit,
  writeStoredDisplayMode,
  writeStoredScheduleLayers,
  writeStoredWorkFilter,
} from "./schedule-calendar.ts"
import type { PersonalScheduleItem } from "@naia-adk/core/src/personal-schedule"

function memoryStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v)
    },
  }
}

describe("현지 날짜", () => {
  it("시간대가 포함된 시각은 실행 환경의 날짜로 변환하고 시간대 없는 날짜는 보존한다", () => {
    const previous = process.env.TZ
    try {
      for (const [zone, expected] of [["UTC", "2026-11-11"], ["Asia/Seoul", "2026-11-12"], ["America/Los_Angeles", "2026-11-11"]]) {
        process.env.TZ = zone
        assert.equal(localDateOnly("2026-11-11T16:00:00Z"), expected)
        assert.equal(localDateOnly(new Date("2026-11-11T16:00:00Z")), expected)
        assert.equal(localDateOnly("2026-11-11"), "2026-11-11")
        assert.equal(localDateOnly("2026-11-11 23:30"), "2026-11-11")
        assert.equal(localDateOnly("2026-11-12T01:00:00+09:00"), expected)
      }
      assert.equal(localDateOnly("invalid"), null)
    } finally {
      if (previous === undefined) delete process.env.TZ
      else process.env.TZ = previous
    }
  })
})

describe("달력 칸 배치 (월 경계 · 종일 · 여러 날 걸침 · 주 단위)", () => {
  it("2026년 10월 월간 달력은 9월 말(월 경계)부터 10월 말까지 35칸(5주)을 정확히 만든다", () => {
    const cells = buildCalendarCells("2026-10-22", "month", "2026-10-22")
    assert.equal(cells.length, 35)
    // 2026-10-01 은 목요일이므로 첫 칸은 일요일인 2026-09-27 (이전 달 경계)
    assert.equal(cells[0].date, "2026-09-27")
    assert.equal(cells[0].inCurrentMonth, false)
    assert.equal(cells[4].date, "2026-10-01")
    assert.equal(cells[4].inCurrentMonth, true)
    // 마지막 칸은 토요일인 2026-10-31
    assert.equal(cells[34].date, "2026-10-31")
    assert.equal(cells[34].inCurrentMonth, true)
    // 오늘 표시 확인
    const todayCell = cells.find((c) => c.date === "2026-10-22")
    assert.ok(todayCell?.isToday)
  })

  it("주간 달력은 기준 날짜가 속한 주의 일요일~토요일 7칸을 만들고 월 경계 주간도 처리한다", () => {
    const weekCells = buildCalendarCells("2026-10-22", "week", "2026-10-22")
    assert.equal(weekCells.length, 7)
    assert.equal(weekCells[0].date, "2026-10-18")
    assert.equal(weekCells[6].date, "2026-10-24")
    assert.equal(formatCalendarPeriodTitle("2026-10-22", "week"), "2026년 10월 18일 ~ 24일")

    // 월 경계를 넘는 주간 (2026-10-01 목요일 -> 9/27 ~ 10/3)
    const boundaryWeek = buildCalendarCells("2026-10-01", "week", "2026-10-22")
    assert.equal(boundaryWeek[0].date, "2026-09-27")
    assert.equal(boundaryWeek[0].inCurrentMonth, false)
    assert.equal(boundaryWeek[6].date, "2026-10-03")
    assert.equal(boundaryWeek[6].inCurrentMonth, true)
    assert.equal(formatCalendarPeriodTitle("2026-10-01", "week"), "2026년 9월 27일 ~ 10월 3일")
  })

  it("종일 일정·시각 지정 일정·여러 날 걸침·월 경계 걸침 일정이 각 날짜 칸에 올바른 spanPosition 으로 배치된다", () => {
    const octCells = buildCalendarCells("2026-10-22", "month", "2026-10-22")
    const personalItems: PersonalScheduleItem[] = [
      {
        id: "p-boundary",
        title: "9월말~10월초 연속 일정",
        start: "2026-09-29",
        end: "2026-10-02",
        allDay: true,
        memo: "월 경계 걸침",
      },
      {
        id: "p-timed",
        title: "오후 미팅",
        start: "2026-10-22 14:00",
        end: "2026-10-22 15:30",
        allDay: false,
        memo: "",
      },
      {
        id: "p-allday-single",
        title: "하루 종일 일정",
        start: "2026-10-22",
        end: "2026-10-22",
        allDay: true,
        memo: "",
      },
    ]

    const placed = placeScheduleOnCalendar(octCells, {
      layers: { personal: true, work: true, milestone: true },
      personalItems,
    })

    const byDate = new Map(placed.map((c) => [c.date, c]))

    // 월 경계를 넘는 4일 연속 일정 (9/29, 9/30, 10/1, 10/2)
    assert.equal(byDate.get("2026-09-29")?.events[0]?.spanPosition, "start")
    assert.equal(byDate.get("2026-09-30")?.events[0]?.spanPosition, "middle")
    assert.equal(byDate.get("2026-10-01")?.events[0]?.spanPosition, "middle")
    assert.equal(byDate.get("2026-10-02")?.events[0]?.spanPosition, "end")
    assert.equal(byDate.get("2026-10-03")?.events.length, 0)

    // 10/22 칸에는 종일 일정이 먼저, 시각 지정 일정이 그 다음에 배치된다
    const oct22Events = byDate.get("2026-10-22")?.events ?? []
    assert.equal(oct22Events.length, 2)
    assert.equal(oct22Events[0].title, "하루 종일 일정")
    assert.equal(oct22Events[0].allDay, true)
    assert.equal(oct22Events[0].timeLabel, "종일")
    assert.equal(oct22Events[0].spanPosition, "single")

    assert.equal(oct22Events[1].title, "오후 미팅")
    assert.equal(oct22Events[1].allDay, false)
    assert.equal(oct22Events[1].timeLabel, "14:00~15:30")
    assert.equal(oct22Events[1].spanPosition, "single")
  })
})

describe("세 겹(개인 일정 · 그룹 작업 일정 · 마일스톤) 켜고 끄기 및 저장소 기억", () => {
  const baseCells = buildCalendarCells("2026-10-22", "month", "2026-10-22")
  const samplePersonal: PersonalScheduleItem[] = [
    { id: "p1", title: "개인 일정", start: "2026-10-21", end: "2026-10-22", allDay: true, memo: "" },
  ]
  const sampleSnapshot = {
    observedAt: "2026-10-22T03:00:00.000Z",
    items: [
      {
        item: { id: "w1", title: "대시보드 달력 작업", issue: "example/project#105" },
        status: "active",
        schedule: {
          startAt: "2026-10-20",
          endAt: "2026-10-22",
          dueDate: "2026-10-22",
          hasDates: true,
          completed: false,
        },
      },
      {
        item: { id: "w-undated", title: "날짜 없는 작업", issue: "example/project#999" },
        status: "pending",
        schedule: { hasDates: false },
      },
    ],
    workDocuments: [
      // 같은 이슈(#105) 문서는 중복 제거되어야 함
      {
        id: "doc-dup",
        title: "중복 문서",
        issue: "example/project#105",
        schedule: { startAt: "2026-10-20", endAt: "2026-10-22", hasDates: true },
      },
    ],
    milestones: [
      {
        id: "ms-1021",
        nameKo: "ADK 2.0 회의",
        dueDate: "2026-10-21",
        completed: 2,
        total: 5,
      },
    ],
  }

  it("작업보드 스냅숏에서 중복을 빼고 날짜 있는 작업·날짜 없는 작업·마일스톤을 추출한다", () => {
    const extracted = extractBoardSchedule(sampleSnapshot, "2026-10-22")
    assert.equal(extracted.workItems.length, 1)
    assert.equal(extracted.workItems[0].id, "w1")
    assert.equal(extracted.undatedItems.length, 1)
    assert.equal(extracted.undatedItems[0].id, "w-undated")
    assert.equal(extracted.milestones.length, 1)
    assert.equal(extracted.milestones[0].name, "ADK 2.0 회의")
    assert.equal(extracted.milestones[0].overdue, true)
  })

  it("네 겹(개인 · 그룹 작업 문서 · 마일스톤 · 실행 대기열)을 각각 켜고 끌 때 선택된 겹만 달력 칸에 나타난다", () => {
    const extracted = extractBoardSchedule(sampleSnapshot, "2026-10-22")

    // 0) 기본 층(queue: false)에서는 큐 항목(w1)이 달력에 배치되지 않는다
    const defaultPlaced = placeScheduleOnCalendar(baseCells, {
      layers: DEFAULT_SCHEDULE_LAYERS,
      personalItems: samplePersonal,
      workItems: extracted.workItems,
      milestones: extracted.milestones,
    })
    const oct21Default = defaultPlaced.find((c) => c.date === "2026-10-21")!.events
    assert.deepEqual(
      oct21Default.map((e) => e.layer),
      ["milestone", "personal"],
    )

    // 1) 큐까지 모두 켠 상태: 10/21 칸에 마일스톤 + 개인 + 큐 작업 3개가 모두 들어간다
    const allOn = placeScheduleOnCalendar(baseCells, {
      layers: { personal: true, work: true, milestone: true, queue: true },
      personalItems: samplePersonal,
      workItems: extracted.workItems,
      milestones: extracted.milestones,
    })
    const oct21All = allOn.find((c) => c.date === "2026-10-21")!.events
    assert.deepEqual(
      oct21All.map((e) => e.layer),
      ["milestone", "personal", "work"],
    )

    // 2) 개인만 켠 상태: 마일스톤과 작업은 숨겨지고 개인 일정만 남는다
    const personalOnly = placeScheduleOnCalendar(baseCells, {
      layers: { personal: true, work: false, milestone: false, queue: false },
      personalItems: samplePersonal,
      workItems: extracted.workItems,
      milestones: extracted.milestones,
    })
    const oct21Personal = personalOnly.find((c) => c.date === "2026-10-21")!.events
    assert.deepEqual(
      oct21Personal.map((e) => e.layer),
      ["personal"],
    )

    // 3) 마일스톤만 켠 상태
    const milestoneOnly = placeScheduleOnCalendar(baseCells, {
      layers: { personal: false, work: false, milestone: true, queue: false },
      personalItems: samplePersonal,
      workItems: extracted.workItems,
      milestones: extracted.milestones,
    })
    const oct21Milestone = milestoneOnly.find((c) => c.date === "2026-10-21")!.events
    assert.deepEqual(
      oct21Milestone.map((e) => e.layer),
      ["milestone"],
    )
  })

  it("고른 보기(달력/목록), 단위(월/주), 겹 상태(예전 저장값 호환 · 기본 queue 끔 · 예외 안전), 작업 필터를 브라우저 저장소에 저장하고 읽는다", () => {
    const store = memoryStorage()
    writeStoredDisplayMode("list", store)
    assert.equal(readStoredDisplayMode(store), "list")

    writeStoredCalendarUnit("week", store)
    assert.equal(readStoredCalendarUnit(store), "week")

    // 저장값이 비어 있으면 queue 기본값은 false
    assert.deepEqual(readStoredScheduleLayers(store), {
      personal: true,
      work: true,
      milestone: true,
      queue: false,
    })

    // 예전 저장값(queue 키 없음)을 읽으면 queue: false 로 시작한다
    store.setItem(SCHEDULE_LAYERS_STORAGE_KEY, JSON.stringify({ personal: true, work: false, milestone: true }))
    assert.deepEqual(readStoredScheduleLayers(store), {
      personal: true,
      work: false,
      milestone: true,
      queue: false,
    })

    // queue: true 저장 후 읽기
    writeStoredScheduleLayers({ personal: true, work: false, milestone: true, queue: true }, store)
    assert.deepEqual(readStoredScheduleLayers(store), {
      personal: true,
      work: false,
      milestone: true,
      queue: true,
    })

    // 저장소 읽기·쓰기가 실패해도 예외 없이 기본값으로 동작한다
    const throwingStore = {
      getItem: () => {
        throw new Error("storage disabled")
      },
      setItem: () => {
        throw new Error("storage disabled")
      },
    }
    assert.doesNotThrow(() => writeStoredScheduleLayers({ personal: false, work: false, milestone: false, queue: true }, throwingStore))
    assert.deepEqual(readStoredScheduleLayers(throwingStore), {
      personal: true,
      work: true,
      milestone: true,
      queue: false,
    })

    writeStoredWorkFilter("all", store)
    assert.equal(readStoredWorkFilter(store), "all")

    assert.equal(shiftCalendarAnchor("2026-10-22", "month", -1), "2026-09-01")
    assert.equal(shiftCalendarAnchor("2026-10-22", "month", 1), "2026-11-01")
    assert.equal(shiftCalendarAnchor("2026-10-22", "week", 1), "2026-10-29")
  })

  it("여러 날 작업 항목(14일 초과 포함)은 시작 날부터 끝 날(dueDate ?? endDate)까지 모든 날짜 칸과 주 줄 막대로 이어진다", () => {
    const longSnapshot = {
      observedAt: "2026-10-22T03:00:00.000Z",
      items: [
        {
          item: { id: "w-long-end-only", title: "장기 큐 작업 (endDate만 있음)", issue: "example/project#201" },
          status: "active",
          schedule: {
            startAt: "2026-10-01",
            endAt: "2026-10-22",
            dueDate: null,
            endSource: "projection.today",
            hasDates: true,
            completed: false,
          },
        },
        {
          item: { id: "w-long-with-due", title: "장기 큐 작업 (dueDate 있음)", issue: "example/project#202" },
          status: "active",
          schedule: {
            startAt: "2026-10-01",
            endAt: "2026-10-22",
            dueDate: "2026-10-25",
            endSource: "projection.today",
            hasDates: true,
            completed: false,
          },
        },
      ],
    }

    const extracted = extractBoardSchedule(longSnapshot, "2026-10-22")
    const placed = placeScheduleOnCalendar(baseCells, {
      layers: { personal: false, work: true, milestone: false, queue: true },
      workItems: extracted.workItems,
    })

    const byDate = new Map(placed.map((c) => [c.date, c]))

    // 10/01 에는 두 작업 모두 "시작"으로 표시됨
    const oct01Events = byDate.get("2026-10-01")?.events ?? []
    assert.equal(oct01Events.length, 2)
    assert.ok(oct01Events.some((e) => e.id === "w-long-end-only" && e.spanPosition === "start"))
    assert.ok(oct01Events.some((e) => e.id === "w-long-with-due" && e.spanPosition === "start"))

    // 중간 날짜(10/10)에도 두 작업 모두 연속으로 들어간다
    const oct10Events = byDate.get("2026-10-10")?.events ?? []
    assert.equal(oct10Events.length, 2)
    assert.ok(oct10Events.every((e) => e.spanPosition === "middle"))

    // endDate 만 있는 작업은 10/22(endDate)에서 끝나고, dueDate 가 10/25 인 작업은 10/25 에서 끝난다
    const oct22Events = byDate.get("2026-10-22")?.events ?? []
    assert.equal(oct22Events.find((e) => e.id === "w-long-end-only")?.spanPosition, "end")
    assert.equal(oct22Events.find((e) => e.id === "w-long-with-due")?.spanPosition, "middle")

    const oct25Events = byDate.get("2026-10-25")?.events ?? []
    assert.equal(oct25Events.length, 1)
    assert.equal(oct25Events[0].id, "w-long-with-due")
    assert.equal(oct25Events[0].spanPosition, "end")
  })
})

