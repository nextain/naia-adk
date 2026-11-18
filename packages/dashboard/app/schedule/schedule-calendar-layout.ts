import { MONTH_MAX_VISIBLE_LANES, WEEK_MAX_VISIBLE_LANES, type CalendarUnit } from "./schedule-calendar-base"
import { compareCalendarEvents, placeScheduleOnCalendar, type CalendarCellEvent, type CalendarDayCell, type PlaceScheduleOptions } from "./schedule-calendar-cells"

// ── 주(일~토) 줄 단위 이어진 막대 배치 및 줄(lane) 탐욕 배정 ───────────────────

export interface CalendarWeekBarSegment {
  key: string
  event: CalendarCellEvent
  startCol: number
  endCol: number
  lane: number
  continuesBefore: boolean
  continuesAfter: boolean
  hidden: boolean
}

export interface CalendarWeekLayout {
  weekIndex: number
  startDate: string
  endDate: string
  cells: CalendarDayCell[]
  bars: CalendarWeekBarSegment[]
  allBars: CalendarWeekBarSegment[]
  visibleLaneCount: number
  maxVisibleLanes: number
  hiddenCounts: number[]
  hiddenCountByDate: Record<string, number>
}

export interface LayoutCalendarWeeksOptions extends Partial<PlaceScheduleOptions> {
  unit?: CalendarUnit
  maxVisibleLanes?: number
}

/**
 * 달력 날짜 칸 배열을 주(7일) 단위로 묶어, 각 주 안에서 시작~끝 열을 잇는 막대 조각과
 * 탐욕 줄(lane) 배정 및 날짜별 숨은 일정 개수를 계산하는 순수 함수.
 */
export function layoutCalendarWeeks(
  inputCells: CalendarDayCell[],
  opts: LayoutCalendarWeeksOptions = {},
): CalendarWeekLayout[] {
  if (!inputCells.length) return []

  const needsPlacement =
    opts.layers !== undefined &&
    inputCells.every((c) => c.events.length === 0) &&
    Boolean(opts.personalItems?.length || opts.workItems?.length || opts.milestones?.length)

  const cells = needsPlacement
    ? placeScheduleOnCalendar(inputCells, {
        layers: opts.layers!,
        workFilter: opts.workFilter,
        personalItems: opts.personalItems,
        workItems: opts.workItems,
        milestones: opts.milestones,
      })
    : inputCells

  const unit: CalendarUnit = opts.unit ?? (cells.length <= 7 ? "week" : "month")
  const maxVisibleLanes =
    typeof opts.maxVisibleLanes === "number" && opts.maxVisibleLanes >= 0
      ? opts.maxVisibleLanes
      : unit === "week"
        ? WEEK_MAX_VISIBLE_LANES
        : MONTH_MAX_VISIBLE_LANES

  const weeks: CalendarWeekLayout[] = []

  for (let offset = 0, weekIndex = 0; offset < cells.length; offset += 7, weekIndex++) {
    const weekCells = cells.slice(offset, offset + 7)
    if (!weekCells.length) continue

    const rawByKey = new Map<
      string,
      {
        event: CalendarCellEvent
        startCol: number
        endCol: number
      }
    >()

    for (let col = 0; col < weekCells.length; col++) {
      const dayCell = weekCells[col]
      for (const ev of dayCell.events) {
        const eventKey = `${ev.layer}:${ev.id}`
        const existing = rawByKey.get(eventKey)
        if (!existing) {
          rawByKey.set(eventKey, {
            event: ev,
            startCol: col,
            endCol: col,
          })
        } else {
          if (col < existing.startCol) existing.startCol = col
          if (col > existing.endCol) existing.endCol = col
        }
      }
    }

    const sortedCandidates = Array.from(rawByKey.values()).sort((a, b) => {
      const cmp = compareCalendarEvents(a.event, b.event)
      if (cmp !== 0) return cmp
      if (a.startCol !== b.startCol) return a.startCol - b.startCol
      return b.endCol - b.startCol - (a.endCol - a.startCol)
    })

    // 탐욕 줄(lane) 배정: 각 줄의 마지막 사용 열(endCol)을 기억하여 겹치지 않는 가장 위쪽 줄에 넣는다.
    const laneLastCol: number[] = []
    const allBars: CalendarWeekBarSegment[] = []

    for (const item of sortedCandidates) {
      let assignedLane = -1
      for (let l = 0; l < laneLastCol.length; l++) {
        if (laneLastCol[l] < item.startCol) {
          assignedLane = l
          laneLastCol[l] = item.endCol
          break
        }
      }
      if (assignedLane === -1) {
        assignedLane = laneLastCol.length
        laneLastCol.push(item.endCol)
      }

      const firstCellDate = weekCells[item.startCol].date
      const lastCellDate = weekCells[item.endCol].date
      const continuesBefore = item.event.startDate < firstCellDate
      const continuesAfter = item.event.endDate > lastCellDate
      const hidden = assignedLane >= maxVisibleLanes

      allBars.push({
        key: `${item.event.layer}-${item.event.id}-w${weekIndex}`,
        event: item.event,
        startCol: item.startCol,
        endCol: item.endCol,
        lane: assignedLane,
        continuesBefore,
        continuesAfter,
        hidden,
      })
    }

    const bars = allBars.filter((b) => !b.hidden)
    const visibleLaneCount = bars.reduce((max, b) => Math.max(max, b.lane + 1), 0)

    const hiddenCounts: number[] = []
    const hiddenCountByDate: Record<string, number> = {}
    for (let col = 0; col < weekCells.length; col++) {
      const count = allBars.filter((b) => b.hidden && b.startCol <= col && col <= b.endCol).length
      hiddenCounts.push(count)
      hiddenCountByDate[weekCells[col].date] = count
    }

    weeks.push({
      weekIndex,
      startDate: weekCells[0].date,
      endDate: weekCells[weekCells.length - 1].date,
      cells: weekCells,
      bars,
      allBars,
      visibleLaneCount,
      maxVisibleLanes,
      hiddenCounts,
      hiddenCountByDate,
    })
  }

  return weeks
}
