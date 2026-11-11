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


describe("작업 문서 세부 작업(tasks/done) · 짧은 문서 주소(docLink) · openEnded · 큐 항목 필드 추출", () => {
  it("buildShortDocLink 는 viewerUrl 에서 호스트를 빼고 문서 화면 상대 주소만 만든다", () => {
    assert.equal(
      buildShortDocLink(
        "http://board.invalid:3142/docs?tab=developer&source=adk&path=developer%2Fpipeline%2Fwork%2FP-03-doc-notes-ai-loop.md",
      ),
      "/docs?source=adk&path=developer%2Fpipeline%2Fwork%2FP-03-doc-notes-ai-loop.md",
    )
    // 한글·공백을 포함한 경로는 쿼리 값으로 인코딩한다.
    assert.equal(
      buildShortDocLink("https://board.invalid:3142/docs?source=company&path=회의록/10월 일정.md"),
      `/docs?source=company&path=${encodeURIComponent("회의록/10월 일정.md")}`,
    )
    // 없거나 잘못된 viewerUrl 은 null
    assert.equal(buildShortDocLink(""), null)
    assert.equal(buildShortDocLink(null), null)
    assert.equal(buildShortDocLink("http://board.invalid:3142/docs?source=adk"), null)
    assert.equal(buildShortDocLink("http://board.invalid:3142/docs?source=adk&path=../secret.md"), null)
  })

  it("isTaskDoneStatus 와 extractWorkDocumentTasks 는 완료 상태 판정·300자 자르기·최대 60개 제한을 지킨다", () => {
    assert.equal(isTaskDoneStatus("끝 (검수 통과)"), true)
    assert.equal(isTaskDoneStatus("완료 — 배포됨"), true)
    assert.equal(isTaskDoneStatus("done"), true)
    assert.equal(isTaskDoneStatus("Completed in PR"), true)
    assert.equal(isTaskDoneStatus("진행 (코드 작성 중)"), false)
    assert.equal(isTaskDoneStatus("대기 (1번 끝난 뒤)"), false)
    assert.equal(isTaskDoneStatus(""), false)

    const longText = "가".repeat(350)
    const manyTasks = Array.from({ length: 65 }, (_, i) => ({
      number: String(i + 1),
      task: i === 0 ? longText : `세부 작업 ${i + 1}`,
      assignee: "루나",
      status: i % 2 === 0 ? "끝 (통과)" : "대기",
    }))

    const { tasks, taskTotal, taskDone } = extractWorkDocumentTasks(manyTasks)
    assert.equal(tasks.length, 60)
    assert.equal(taskTotal, 60)
    assert.equal(taskDone, 30)
    assert.equal(tasks[0].task.length, 300)
    assert.equal(tasks[0].done, true)
    assert.equal(tasks[1].done, false)
  })

  it("taskStatusBadge 는 세부 작업 상태 글 앞머리에 따라 완료 · 진행 · 대기 · 미완료 딱지를 정확히 판정한다", () => {
    // 완료: 끝/완료/done/complete
    assert.equal(taskStatusBadge("끝"), "완료")
    assert.equal(taskStatusBadge("끝 (검수 통과)"), "완료")
    assert.equal(taskStatusBadge("완료 — 배포됨"), "완료")
    assert.equal(taskStatusBadge("done"), "완료")
    assert.equal(taskStatusBadge("Completed in PR"), "완료")

    // 진행: 진행/doing/in progress/working
    assert.equal(taskStatusBadge("진행"), "진행")
    assert.equal(taskStatusBadge("진행 중 (코드 작성)"), "진행")
    assert.equal(taskStatusBadge("doing"), "진행")
    assert.equal(taskStatusBadge("In Progress"), "진행")
    assert.equal(taskStatusBadge("working on tests"), "진행")

    // 대기: 대기/todo/pending/예정/보류/blocked/(빈 값)
    assert.equal(taskStatusBadge("대기"), "대기")
    assert.equal(taskStatusBadge("대기 (1번 끝난 뒤)"), "대기")
    assert.equal(taskStatusBadge("todo"), "대기")
    assert.equal(taskStatusBadge("Pending review"), "대기")
    assert.equal(taskStatusBadge("예정 (다음 주)"), "대기")
    assert.equal(taskStatusBadge("보류"), "대기")
    assert.equal(taskStatusBadge("Blocked by API"), "대기")
    assert.equal(taskStatusBadge(""), "대기")
    assert.equal(taskStatusBadge("   "), "대기")
    assert.equal(taskStatusBadge(null), "대기")
    assert.equal(taskStatusBadge(undefined), "대기")

    // 그 밖 → 미완료
    assert.equal(taskStatusBadge("검토 요청"), "미완료")
    assert.equal(taskStatusBadge("재시도 필요"), "미완료")
    assert.equal(taskStatusBadge("확인 중"), "미완료")
  })

  it("extractBoardSchedule 는 작업 문서(assignee·tasks·taskTotal·taskDone·docLink·openEnded)와 큐 항목(attemptCount·description·openEnded)을 추출한다", () => {
    const longDesc = "설".repeat(600)
    const snapshot = {
      observedAt: "2026-10-24T05:00:00.000Z",
      items: [
        {
          item: {
            id: "queue-1",
            title: "큐 작업 1",
            issue: "example/project#301",
            description: longDesc,
          },
          status: "waiting",
          attempts: [{ id: "a1" }, { id: "a2" }, { id: "a3" }],
          schedule: {
            startAt: "2026-10-20",
            endAt: "2026-10-24",
            endSource: "projection.today",
            hasDates: true,
            completed: false,
          },
        },
      ],
      workDocuments: [
        {
          id: "P-08-meeting-ai-attendance",
          title: "P-08 회의 AI 참석",
          issue: "example/project#88",
          status: "진행",
          assignee: "조정자",
          viewerUrl:
            "http://board.invalid:3142/docs?tab=developer&source=adk&path=developer%2Fpipeline%2Fwork%2FP-08-meeting-ai-attendance.md",
          tasks: [
            { number: "1", task: "설계 정리", assignee: "조정자", status: "끝" },
            { number: "2", task: "음성 연결", assignee: "구현(luna)", status: "완료됨" },
            { number: "3", task: "실측 검증", assignee: "검수(muse)", status: "진행 중" },
          ],
          schedule: {
            startAt: "2026-10-14",
            endAt: "2026-10-24",
            endSource: "projection.today",
            hasDates: true,
            completed: false,
            milestoneId: "ms-1",
            milestoneName: "개발 절차 정비",
            parentGroupId: "pg-1",
            parentGroupName: "그룹 작업",
          },
        },
      ],
    }

    const proj = extractBoardSchedule(snapshot, "2026-10-24")
    const qItem = proj.workItems.find((w) => w.id === "queue-1")!
    const docItem = proj.workItems.find((w) => w.id === "P-08-meeting-ai-attendance")!

    assert.equal(qItem.kind, "queue")
    assert.deepEqual(qItem.tasks, [])
    assert.equal(qItem.taskTotal, 0)
    assert.equal(qItem.taskDone, 0)
    assert.equal(qItem.docLink, null)
    assert.equal(qItem.attemptCount, 3)
    assert.equal(qItem.description?.length, 500)
    assert.equal(qItem.openEnded, true)

    assert.equal(docItem.kind, "work_document")
    assert.equal(docItem.assignee, "조정자")
    assert.equal(docItem.taskTotal, 3)
    assert.equal(docItem.taskDone, 2)
    assert.equal(docItem.tasks?.length, 3)
    assert.equal(docItem.tasks?.[0].done, true)
    assert.equal(docItem.tasks?.[1].done, true)
    assert.equal(docItem.tasks?.[2].done, false)
    assert.equal(docItem.docLink, "/docs?source=adk&path=developer%2Fpipeline%2Fwork%2FP-08-meeting-ai-attendance.md")
    assert.equal(docItem.openEnded, true)
  })
})

describe("layoutCalendarWeeks — 주 넘김 막대 조각 · 줄(lane) 탐욕 배정 정렬 · 넘침 개수", () => {
  it("주를 넘는 여러 날 일정은 주마다 하나의 막대 조각으로 나뉘고 continuesBefore / continuesAfter 가 정확히 표시된다", () => {
    const baseCells = buildCalendarCells("2026-10-22", "month", "2026-10-24")
    const snapshot = {
      observedAt: "2026-10-24T05:00:00.000Z",
      workDocuments: [
        {
          id: "P-08",
          title: "P-08 주 넘김 작업",
          status: "진행",
          tasks: [
            { number: "1", task: "세부 1", assignee: "루나", status: "끝" },
            { number: "2", task: "세부 2", assignee: "루나", status: "대기" },
          ],
          schedule: {
            startAt: "2026-10-14", // 수요일 (weekIndex 2: 10/11~10/17)
            endAt: "2026-10-24", // 토요일 (weekIndex 3: 10/18~10/24)
            endSource: "projection.today",
            hasDates: true,
            completed: false,
          },
        },
      ],
    }

    const extracted = extractBoardSchedule(snapshot, "2026-10-24")
    const placed = placeScheduleOnCalendar(baseCells, {
      layers: { personal: true, work: true, milestone: true },
      workItems: extracted.workItems,
    })
    const weeks = layoutCalendarWeeks(placed, { unit: "month" })

    assert.equal(weeks.length, 5)
    // 10/11~10/17 주(weekIndex 2): 수요일(col 3)~토요일(col 6) 막대 1개, 다음 주로 이어짐
    const week2 = weeks[2]
    assert.equal(week2.startDate, "2026-10-11")
    assert.equal(week2.bars.length, 1)
    assert.equal(week2.bars[0].event.id, "P-08")
    assert.equal(week2.bars[0].startCol, 3)
    assert.equal(week2.bars[0].endCol, 6)
    assert.equal(week2.bars[0].lane, 0)
    assert.equal(week2.bars[0].continuesBefore, false)
    assert.equal(week2.bars[0].continuesAfter, true)

    // 10/18~10/24 주(weekIndex 3): 일요일(col 0)~토요일(col 6) 막대 1개, 앞 주에서 이어옴
    const week3 = weeks[3]
    assert.equal(week3.startDate, "2026-10-18")
    assert.equal(week3.bars.length, 1)
    assert.equal(week3.bars[0].event.id, "P-08")
    assert.equal(week3.bars[0].startCol, 0)
    assert.equal(week3.bars[0].endCol, 6)
    assert.equal(week3.bars[0].lane, 0)
    assert.equal(week3.bars[0].continuesBefore, true)
    assert.equal(week3.bars[0].continuesAfter, false)
  })

  it("줄(lane) 배정은 마일스톤 → 개인 → 작업 문서 → 큐 항목 순이고, 같은 종류에서는 긴 기간·이른 시작·제목 순이며 겹치지 않으면 같은 줄을 재사용한다", () => {
    const weekCells = buildCalendarCells("2026-10-22", "week", "2026-10-22") // 10/18(일) ~ 10/24(토)
    const personalItems: PersonalScheduleItem[] = [
      {
        id: "p-mon-tue",
        title: "개인 일정 A",
        start: "2026-10-19",
        end: "2026-10-20",
        allDay: true,
        memo: "",
      },
    ]
    const snapshot = {
      observedAt: "2026-10-22T03:00:00.000Z",
      milestones: [
        {
          id: "ms-mon",
          nameKo: "월요일 마일스톤",
          dueDate: "2026-10-19",
          completed: 1,
          total: 2,
        },
        {
          id: "ms-thu",
          nameKo: "목요일 마일스톤",
          dueDate: "2026-10-22",
          completed: 0,
          total: 1,
        },
      ],
      workDocuments: [
        {
          id: "doc-short",
          title: "작업 문서 짧은 것",
          status: "진행",
          schedule: { startAt: "2026-10-19", endAt: "2026-10-21", hasDates: true },
        },
        {
          id: "doc-long",
          title: "작업 문서 긴 것",
          status: "진행",
          schedule: { startAt: "2026-10-18", endAt: "2026-10-24", hasDates: true },
        },
      ],
      items: [
        {
          item: { id: "q-item", title: "큐 작업", issue: "example/project#500" },
          status: "active",
          schedule: { startAt: "2026-10-18", endAt: "2026-10-24", hasDates: true },
        },
      ],
    }

    const extracted = extractBoardSchedule(snapshot, "2026-10-22")

    // 1) queue: false(기본)일 때는 작업 문서(doc-long, doc-short)만 배치되고 큐 작업(q-item)은 빠진다
    const placedWithoutQueue = placeScheduleOnCalendar(weekCells, {
      layers: { personal: true, work: true, milestone: true, queue: false },
      personalItems,
      workItems: extracted.workItems,
      milestones: extracted.milestones,
    })
    const [weekWithoutQueue] = layoutCalendarWeeks(placedWithoutQueue, { unit: "week" })
    assert.equal(weekWithoutQueue.allBars.some((b) => b.event.id === "q-item"), false)
    assert.equal(weekWithoutQueue.allBars.some((b) => b.event.id === "doc-long"), true)

    // 2) work: false, queue: true 일 때는 작업 문서는 빠지고 큐 작업만 배치된다
    const placedQueueOnly = placeScheduleOnCalendar(weekCells, {
      layers: { personal: false, work: false, milestone: false, queue: true },
      personalItems,
      workItems: extracted.workItems,
      milestones: extracted.milestones,
    })
    const [weekQueueOnly] = layoutCalendarWeeks(placedQueueOnly, { unit: "week" })
    assert.deepEqual(
      weekQueueOnly.allBars.map((b) => b.event.id),
      ["q-item"],
    )

    // 3) 모든 층(queue 포함)을 켰을 때 줄 배정 우선순위 검증
    const placed = placeScheduleOnCalendar(weekCells, {
      layers: { personal: true, work: true, milestone: true, queue: true },
      personalItems,
      workItems: extracted.workItems,
      milestones: extracted.milestones,
    })

    const [week] = layoutCalendarWeeks(placed, { unit: "week" })
    const laneById = new Map(week.allBars.map((b) => [b.event.id, b.lane]))

    // 두 마일스톤(10/19 월, 10/22 목)은 서로 겹치지 않으므로 둘 다 lane 0 에 탐욕 배정된다
    assert.equal(laneById.get("ms-mon"), 0)
    assert.equal(laneById.get("ms-thu"), 0)
    // 개인 일정(10/19~10/20)은 마일스톤(10/19)과 겹치므로 lane 1
    assert.equal(laneById.get("p-mon-tue"), 1)
    // 작업 문서 중 기간이 더 긴 doc-long(7일)이 먼저 lane 2, doc-short(3일)가 lane 3
    assert.equal(laneById.get("doc-long"), 2)
    assert.equal(laneById.get("doc-short"), 3)
    // 큐 작업은 작업 문서 뒤인 lane 4
    assert.equal(laneById.get("q-item"), 4)
  })

  it("월 단위 상한(3줄)을 넘는 일정은 숨겨지고 날짜 칸마다 정확한 넘침 개수(hiddenCounts)가 계산된다", () => {
    const monthCells = buildCalendarCells("2026-10-22", "month", "2026-10-22")
    const snapshot = {
      observedAt: "2026-10-22T03:00:00.000Z",
      items: [1, 2, 3, 4, 5].map((n) => ({
        item: { id: `q-${n}`, title: `동시 진행 작업 ${n}`, issue: `example/project#${600 + n}` },
        status: "active",
        schedule: {
          startAt: "2026-10-20",
          endAt: "2026-10-22",
          hasDates: true,
          completed: false,
        },
      })),
    }

    const extracted = extractBoardSchedule(snapshot, "2026-10-22")
    const placed = placeScheduleOnCalendar(monthCells, {
      layers: { personal: false, work: true, milestone: false, queue: true },
      workItems: extracted.workItems,
    })

    const weeks = layoutCalendarWeeks(placed, { unit: "month" }) // maxVisibleLanes = 3
    const week3 = weeks[3] // 2026-10-18 ~ 2026-10-24

    // 보이는 막대는 3개(lane 0, 1, 2), 전체 막대는 5개
    assert.equal(week3.bars.length, 3)
    assert.equal(week3.allBars.length, 5)
    // 10/20(화, col 2), 10/21(수, col 3), 10/22(목, col 4) 에는 각 2건씩 숨겨짐
    assert.equal(week3.hiddenCountByDate["2026-10-19"], 0)
    assert.equal(week3.hiddenCountByDate["2026-10-20"], 2)
    assert.equal(week3.hiddenCountByDate["2026-10-21"], 2)
    assert.equal(week3.hiddenCountByDate["2026-10-22"], 2)
    assert.equal(week3.hiddenCountByDate["2026-10-23"], 0)

    // queue 층이 꺼진 기본 상태(queue: false)에서는 큐 항목 5건이 모두 빠져 막대와 넘침 개수가 0 이 된다
    const placedQueueOff = placeScheduleOnCalendar(monthCells, {
      layers: { personal: false, work: true, milestone: false, queue: false },
      workItems: extracted.workItems,
    })
    const weeksQueueOff = layoutCalendarWeeks(placedQueueOff, { unit: "month" })
    const week3QueueOff = weeksQueueOff[3]
    assert.equal(week3QueueOff.bars.length, 0)
    assert.equal(week3QueueOff.allBars.length, 0)
    assert.equal(week3QueueOff.hiddenCountByDate["2026-10-21"], 0)
  })
})
