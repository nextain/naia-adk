import type { PersonalScheduleItem } from "@naia-adk/core/src/personal-schedule"
import { addDays, daysBetweenDates, formatUtcDate, parseDateParts, type CalendarUnit, type ScheduleLayerKey, type SpanPosition, type ScheduleLayers, type WorkScheduleFilter } from "./schedule-calendar-base"
import type { WorkScheduleItem, MilestoneScheduleItem } from "./schedule-board-projection"

// ── 달력 칸 생성 및 3개 겹 배치 ──────────────────────────────────────────────

export interface CalendarCellEvent {
  key: string
  id: string
  layer: ScheduleLayerKey
  title: string
  startDate: string
  endDate: string
  spanPosition: SpanPosition
  allDay: boolean
  timeLabel: string
  subtitle: string
  overdue: boolean
  completed: boolean
  personalItem?: PersonalScheduleItem
  workItem?: WorkScheduleItem
  milestoneItem?: MilestoneScheduleItem
}

export interface CalendarDayCell {
  date: string
  year: number
  month: number
  day: number
  dayOfWeek: number
  inCurrentMonth: boolean
  isToday: boolean
  events: CalendarCellEvent[]
}

/**
 * 기준 날짜(anchorDate)와 단위(month | week)에 맞춰 7열 달력 날짜 칸 배열을 만든다.
 * - month: 해당 달 1일이 속한 주의 일요일부터 말일이 속한 주의 토요일까지 (35 또는 42칸)
 * - week: 기준 날짜가 속한 주의 일요일부터 토요일까지 (7칸)
 */
export function buildCalendarCells(
  anchorDate: string,
  unit: CalendarUnit,
  todayDate = anchorDate,
): CalendarDayCell[] {
  const parts = parseDateParts(anchorDate) ?? { year: 2026, month: 10, day: 22 }
  const cells: CalendarDayCell[] = []

  if (unit === "week") {
    const dt = new Date(Date.UTC(parts.year, parts.month - 1, parts.day))
    const dow = dt.getUTCDay()
    const sunday = addDays(formatUtcDate(dt), -dow)
    for (let i = 0; i < 7; i++) {
      const date = addDays(sunday, i)
      const p = parseDateParts(date)!
      cells.push({
        date,
        year: p.year,
        month: p.month,
        day: p.day,
        dayOfWeek: i,
        inCurrentMonth: p.month === parts.month && p.year === parts.year,
        isToday: date === todayDate,
        events: [],
      })
    }
    return cells
  }

  const firstOfMonth = new Date(Date.UTC(parts.year, parts.month - 1, 1))
  const startDow = firstOfMonth.getUTCDay()
  const gridStart = addDays(formatUtcDate(firstOfMonth), -startDow)

  const lastOfMonth = new Date(Date.UTC(parts.year, parts.month, 0))
  const endDow = lastOfMonth.getUTCDay()
  const gridEnd = addDays(formatUtcDate(lastOfMonth), 6 - endDow)

  const totalDays = daysBetweenDates(gridStart, gridEnd) + 1
  for (let i = 0; i < totalDays; i++) {
    const date = addDays(gridStart, i)
    const p = parseDateParts(date)!
    cells.push({
      date,
      year: p.year,
      month: p.month,
      day: p.day,
      dayOfWeek: i % 7,
      inCurrentMonth: p.year === parts.year && p.month === parts.month,
      isToday: date === todayDate,
      events: [],
    })
  }
  return cells
}

function calcSpanPosition(cellDate: string, startDate: string, endDate: string): SpanPosition {
  if (startDate === endDate) return "single"
  if (cellDate === startDate) return "start"
  if (cellDate === endDate) return "end"
  return "middle"
}

function extractTimePart(dateTimeStr: string): string | null {
  const m = String(dateTimeStr || "").match(/[ T](\d{2}:\d{2})/)
  return m ? m[1] : null
}

function formatPersonalTimeLabel(item: PersonalScheduleItem, spanPos: SpanPosition): string {
  if (item.allDay) return "종일"
  const startTime = extractTimePart(item.start)
  const endTime = extractTimePart(item.end)
  if (spanPos === "single") {
    if (startTime && endTime && startTime !== endTime) return `${startTime}~${endTime}`
    return startTime ?? "종일"
  }
  if (spanPos === "start") return startTime ? `${startTime}~` : "시작"
  if (spanPos === "end") return endTime ? `~${endTime}` : "종료"
  return "계속"
}

/**
 * 줄(lane) 배정 및 날짜 칸 정렬 우선순위 그룹:
 * 0: 마일스톤 -> 1: 개인 일정 -> 2: 작업 문서(그룹 작업) -> 3: 큐 항목
 */
export function eventSortGroup(ev: CalendarCellEvent): number {
  if (ev.layer === "milestone") return 0
  if (ev.layer === "personal") return 1
  if (ev.layer === "work" && ev.workItem?.kind === "work_document") return 2
  return 3
}

/**
 * 달력 일정 정렬 함수:
 * 마일스톤 → 개인 일정 → 작업 문서 → 큐 항목 순,
 * 같은 종류 안에서는 기간이 긴 것 먼저 · 시작 이른 것 먼저 · (종일 먼저) · 제목 순.
 */
export function compareCalendarEvents(a: CalendarCellEvent, b: CalendarCellEvent): number {
  const groupDiff = eventSortGroup(a) - eventSortGroup(b)
  if (groupDiff !== 0) return groupDiff

  const spanA = daysBetweenDates(a.startDate, a.endDate)
  const spanB = daysBetweenDates(b.startDate, b.endDate)
  if (spanB !== spanA) return spanB - spanA

  if (a.startDate !== b.startDate) {
    return a.startDate.localeCompare(b.startDate)
  }

  if (a.allDay !== b.allDay) {
    return a.allDay ? -1 : 1
  }

  const titleCmp = a.title.localeCompare(b.title, "ko")
  if (titleCmp !== 0) return titleCmp

  return a.id.localeCompare(b.id)
}

export interface PlaceScheduleOptions {
  layers: Omit<ScheduleLayers, "queue"> & { queue?: boolean }
  workFilter?: WorkScheduleFilter
  personalItems?: PersonalScheduleItem[]
  workItems?: WorkScheduleItem[]
  milestones?: MilestoneScheduleItem[]
}

/**
 * 달력 날짜 칸에 네 겹(개인 일정 · 그룹(작업) 일정 · 마일스톤 · 실행 대기열)을 배치한다.
 * - 꺼진 겹(layers[layer] === false, queue 미지정 시 기본 false)은 배치하지 않는다.
 * - 그룹(작업) 일정(layers.work)은 작업 문서(kind === "work_document")만 결정하고,
 *   실행 대기열(layers.queue)은 큐 항목(kind === "queue")만 결정한다.
 * - 여러 날에 걸친 일정은 시작일~종료일 사이의 모든 달력 칸에 spanPosition(start/middle/end)과 함께 배치된다.
 */
export function placeScheduleOnCalendar(
  baseCells: CalendarDayCell[],
  opts: PlaceScheduleOptions,
): CalendarDayCell[] {
  const cells = baseCells.map((cell) => ({ ...cell, events: [] as CalendarCellEvent[] }))
  if (!cells.length) return cells

  const cellByDate = new Map<string, CalendarDayCell>()
  for (const cell of cells) {
    cellByDate.set(cell.date, cell)
  }
  const gridFirstDate = cells[0].date
  const gridLastDate = cells[cells.length - 1].date

  const addRangeToCells = (
    startDate: string,
    endDate: string,
    buildEvent: (cellDate: string, spanPos: SpanPosition) => CalendarCellEvent,
  ) => {
    const s = startDate <= endDate ? startDate : endDate
    const e = startDate <= endDate ? endDate : startDate
    if (e < gridFirstDate || s > gridLastDate) return
    const clampedStart = s < gridFirstDate ? gridFirstDate : s
    const clampedEnd = e > gridLastDate ? gridLastDate : e
    const spanDays = daysBetweenDates(clampedStart, clampedEnd)
    for (let d = 0; d <= spanDays; d++) {
      const date = addDays(clampedStart, d)
      const cell = cellByDate.get(date)
      if (!cell) continue
      const pos = calcSpanPosition(date, s, e)
      cell.events.push(buildEvent(date, pos))
    }
  }

  // 1) 마일스톤 겹
  if (opts.layers.milestone) {
    for (const ms of opts.milestones ?? []) {
      if (!ms.dueDate) continue
      addRangeToCells(ms.dueDate, ms.dueDate, (cellDate, spanPos) => ({
        key: `milestone-${ms.id}-${cellDate}`,
        id: ms.id,
        layer: "milestone",
        title: ms.name,
        startDate: ms.dueDate!,
        endDate: ms.dueDate!,
        spanPosition: spanPos,
        allDay: true,
        timeLabel: `기한 (${ms.completed}/${ms.total})`,
        subtitle: ms.description || `완료 ${ms.completed}/${ms.total}`,
        overdue: ms.overdue,
        completed: ms.total > 0 && ms.completed >= ms.total,
        milestoneItem: ms,
      }))
    }
  }

  // 2) 개인 일정 겹
  if (opts.layers.personal) {
    for (const p of opts.personalItems ?? []) {
      const startDate = p.start.slice(0, 10)
      const endDate = (p.end || p.start).slice(0, 10)
      addRangeToCells(startDate, endDate, (cellDate, spanPos) => ({
        key: `personal-${p.id}-${cellDate}`,
        id: p.id,
        layer: "personal",
        title: p.title,
        startDate,
        endDate,
        spanPosition: spanPos,
        allDay: p.allDay,
        timeLabel: formatPersonalTimeLabel(p, spanPos),
        subtitle: p.memo || "",
        overdue: false,
        completed: false,
        personalItem: p,
      }))
    }
  }

  // 3) 그룹(작업) 일정(작업 문서) & 실행 대기열(큐 항목) 겹 — 시작일~끝 날(dueDate ?? endDate) 전체 구간에 연속 배치
  const showWorkDocs = Boolean(opts.layers.work)
  const showQueue = Boolean(opts.layers.queue)
  if (showWorkDocs || showQueue) {
    const workFilter = opts.workFilter ?? "open"
    const filteredWork = (opts.workItems ?? []).filter((w) => {
      if (w.kind === "queue" ? !showQueue : !showWorkDocs) return false
      return workFilter === "all" ? true : !w.completed && !w.cancelled
    })

    for (const w of filteredWork) {
      if (!w.hasDates) continue
      const rawStart = w.startDate ?? w.dueDate ?? w.endDate
      const rawEnd = w.dueDate ?? w.endDate ?? w.startDate
      if (!rawStart || !rawEnd) continue

      const spanStart = rawStart <= rawEnd ? rawStart : rawEnd
      const spanEnd = rawStart <= rawEnd ? rawEnd : rawStart

      addRangeToCells(spanStart, spanEnd, (cellDate, spanPos) => ({
        key: `work-${w.id}-${cellDate}`,
        id: w.id,
        layer: "work",
        title: w.title,
        startDate: spanStart,
        endDate: spanEnd,
        spanPosition: spanPos,
        allDay: true,
        timeLabel:
          w.dueDate && cellDate === w.dueDate
            ? "마감"
            : spanPos === "start"
              ? "시작"
              : spanPos === "end"
                ? "종료"
                : "진행",
        subtitle: [w.issue || w.id, w.milestoneName, w.parentGroupName].filter(Boolean).join(" · "),
        overdue: w.overdue,
        completed: w.completed,
        workItem: w,
      }))
    }
  }

  for (const cell of cells) {
    cell.events.sort(compareCalendarEvents)
  }

  return cells
}

