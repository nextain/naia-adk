"use client"

import React from "react"
import {
  LAYER_LABELS,
  WEEKDAY_LABELS_KO,
  type CalendarCellEvent,
  type CalendarDayCell,
  type CalendarUnit,
  type CalendarWeekBarSegment,
  type CalendarWeekLayout,
} from "./schedule-calendar"

export interface ScheduleCalendarGridProps {
  weeks: CalendarWeekLayout[]
  unit: CalendarUnit
  canMutatePersonal: boolean
  onAddPersonal: (dateStr: string) => void
  onSelectEvent: (ev: CalendarCellEvent) => void
  onOpenDayList: (cell: CalendarDayCell) => void
}

function formatBarTitleAttr(bar: CalendarWeekBarSegment): string {
  const { event: ev } = bar
  const parts: string[] = [ev.title, `${LAYER_LABELS[ev.layer]} (${ev.startDate} ~ ${ev.endDate})`]
  if (ev.layer === "work" && ev.workItem && (ev.workItem.taskTotal ?? 0) > 0) {
    parts.push(`세부 작업 ${ev.workItem.taskDone ?? 0}/${ev.workItem.taskTotal}`)
  } else if (ev.layer === "milestone" && ev.milestoneItem && ev.milestoneItem.total > 0) {
    parts.push(`완료 ${ev.milestoneItem.completed}/${ev.milestoneItem.total}`)
  }
  if (ev.subtitle) {
    parts.push(ev.subtitle)
  }
  return parts.join(" · ")
}

function barContinuationClass(bar: CalendarWeekBarSegment): string {
  if (bar.continuesBefore && bar.continuesAfter) {
    return "rounded-none border-l-2 border-r-2 mx-0"
  }
  if (bar.continuesBefore) {
    return "rounded-l-none rounded-r-md border-l-2 ml-0 mr-0.5"
  }
  if (bar.continuesAfter) {
    return "rounded-l-md rounded-r-none border-r-2 ml-0.5 mr-0"
  }
  return "rounded-md mx-0.5"
}

function barColorClass(ev: CalendarCellEvent): string {
  if (ev.layer === "personal") {
    return "bg-emerald-950/90 border-emerald-500/75 text-emerald-100 hover:bg-emerald-900/90"
  }
  if (ev.layer === "milestone") {
    if (ev.overdue) {
      return "bg-amber-950/90 border-rose-500/85 text-amber-100 font-medium hover:bg-amber-900/90"
    }
    return "bg-amber-950/85 border-amber-500/75 text-amber-100 font-medium hover:bg-amber-900/85"
  }
  if (ev.overdue) {
    return "bg-rose-950/85 border-rose-500/80 text-rose-100 hover:bg-rose-900/85"
  }
  if (ev.completed) {
    return "bg-slate-900/80 border-slate-700/70 text-slate-300 hover:bg-slate-800/80"
  }
  return "bg-sky-950/85 border-sky-500/70 text-sky-100 hover:bg-sky-900/85"
}

function getBarTaskBadge(ev: CalendarCellEvent): string | null {
  if (ev.layer === "work" && ev.workItem && (ev.workItem.taskTotal ?? 0) > 0) {
    return `${ev.workItem.taskDone ?? 0}/${ev.workItem.taskTotal}`
  }
  if (ev.layer === "milestone" && ev.milestoneItem && ev.milestoneItem.total > 0) {
    return `${ev.milestoneItem.completed}/${ev.milestoneItem.total}`
  }
  return null
}

export function ScheduleCalendarGrid({
  weeks,
  unit,
  canMutatePersonal,
  onAddPersonal,
  onSelectEvent,
  onOpenDayList,
}: ScheduleCalendarGridProps) {
  return (
    <div
      data-testid="schedule-calendar-grid"
      className="rounded-lg border border-neutral-800 bg-neutral-900/40 overflow-hidden"
    >
      {/* 요일 머리글 */}
      <div className="grid grid-cols-7 border-b border-neutral-800 bg-neutral-900/90">
        {WEEKDAY_LABELS_KO.map((label, idx) => (
          <div
            key={label}
            className={`py-1.5 text-center text-xs font-semibold ${
              idx === 0 ? "text-rose-400" : idx === 6 ? "text-sky-400" : "text-neutral-300"
            }`}
          >
            {label}
          </div>
        ))}
      </div>

      {/* 주(7일) 단위 줄 격자 */}
      <div className="divide-y divide-neutral-800/80">
        {weeks.map((week) => {
          const hasOverflow = week.hiddenCounts.some((c) => c > 0)
          return (
            <div
              key={`week-${week.weekIndex}-${week.startDate}`}
              data-testid={`calendar-week-${week.weekIndex}`}
              className={`relative ${
                unit === "week" ? "min-h-[14rem]" : "min-h-[6.25rem] sm:min-h-[7.25rem]"
              }`}
            >
              {/* 배경 7열: 날짜별 세로 구분선과 오늘·달 밖 배경색 */}
              <div
                aria-hidden="true"
                className="absolute inset-0 grid grid-cols-7 divide-x divide-neutral-800/80 pointer-events-none"
              >
                {week.cells.map((cell) => (
                  <div
                    key={`bg-${cell.date}`}
                    className={
                      cell.isToday
                        ? "bg-blue-950/25"
                        : cell.inCurrentMonth
                          ? "bg-neutral-950/80"
                          : "bg-neutral-950/30"
                    }
                  />
                ))}
              </div>

              {/* 전경 내용: 1) 날짜 머리 2) 주 단위 이어진 막대 3) 날짜별 +n건 단추 */}
              <div className="relative z-10 flex flex-col h-full">
                {/* 1) 날짜 머리줄 (7열) */}
                <div className="grid grid-cols-7">
                  {week.cells.map((cell) => (
                    <div
                      key={cell.date}
                      data-testid={`calendar-cell-${cell.date}`}
                      data-in-month={cell.inCurrentMonth ? "1" : "0"}
                      data-today={cell.isToday ? "1" : "0"}
                      className={`px-1 pt-1 pb-0.5 flex items-center justify-between min-w-0 ${
                        !cell.inCurrentMonth ? "text-neutral-500" : ""
                      }`}
                    >
                      <span
                        className={`text-[11px] sm:text-xs font-semibold px-1 sm:px-1.5 py-0.5 rounded leading-none ${
                          cell.isToday
                            ? "bg-blue-600 text-white"
                            : !cell.inCurrentMonth
                              ? "text-neutral-500"
                              : cell.dayOfWeek === 0
                                ? "text-rose-400"
                                : cell.dayOfWeek === 6
                                  ? "text-sky-400"
                                  : "text-neutral-200"
                        }`}
                      >
                        {cell.day === 1 || !cell.inCurrentMonth ? `${cell.month}/${cell.day}` : cell.day}
                      </span>
                      {canMutatePersonal && (
                        <button
                          type="button"
                          data-testid={`calendar-add-${cell.date}`}
                          title={`${cell.date} 개인 일정 추가`}
                          onClick={() => onAddPersonal(cell.date)}
                          className="text-[11px] px-1 rounded text-neutral-500 hover:text-emerald-300 hover:bg-neutral-800 shrink-0"
                        >
                          +
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                {/* 2) 이어진 일정 막대 조각 격자 (7열, lane 행) */}
                {week.bars.length > 0 && (
                  <div className="grid grid-cols-7 gap-y-0.5 px-0.5 py-0.5">
                    {week.bars.map((bar) => {
                      const ev = bar.event
                      const taskBadge = getBarTaskBadge(ev)
                      const icon = ev.layer === "milestone" ? "🏁" : ev.layer === "personal" ? "●" : "▪"
                      return (
                        <button
                          key={bar.key}
                          type="button"
                          data-testid={`calendar-event-${ev.layer}-${ev.id}`}
                          data-layer={ev.layer}
                          data-lane={bar.lane}
                          data-start-col={bar.startCol}
                          data-end-col={bar.endCol}
                          data-continues-before={bar.continuesBefore ? "1" : "0"}
                          data-continues-after={bar.continuesAfter ? "1" : "0"}
                          title={formatBarTitleAttr(bar)}
                          onClick={() => onSelectEvent(ev)}
                          style={{
                            gridColumn: `${bar.startCol + 1} / ${bar.endCol + 2}`,
                            gridRow: bar.lane + 1,
                          }}
                          className={`h-5 sm:h-[22px] px-1 sm:px-1.5 text-[10px] sm:text-[11px] leading-tight border flex items-center justify-between gap-1 min-w-0 overflow-hidden transition-colors cursor-pointer ${barContinuationClass(bar)} ${barColorClass(ev)}`}
                        >
                          <span className="flex items-center gap-0.5 sm:gap-1 min-w-0 flex-1 overflow-hidden">
                            {bar.continuesBefore && (
                              <span
                                aria-hidden="true"
                                data-testid={`calendar-bar-cont-before-${ev.id}`}
                                className="text-[9px] opacity-85 shrink-0"
                              >
                                ◀
                              </span>
                            )}
                            <span className="font-semibold shrink-0">{icon}</span>
                            {ev.layer === "personal" && !ev.allDay && (
                              <span className="opacity-80 text-[9px] sm:text-[10px] shrink-0 hidden sm:inline">
                                {ev.timeLabel}
                              </span>
                            )}
                            <span className="truncate">{ev.title}</span>
                          </span>
                          <span className="flex items-center gap-0.5 shrink-0">
                            {taskBadge && (
                              <span
                                data-testid={`calendar-bar-tasks-${ev.id}`}
                                className="px-1 rounded bg-black/35 text-[9px] sm:text-[10px] tabular-nums opacity-95 shrink-0"
                              >
                                {taskBadge}
                              </span>
                            )}
                            {bar.continuesAfter && (
                              <span
                                aria-hidden="true"
                                data-testid={`calendar-bar-cont-after-${ev.id}`}
                                className="text-[9px] opacity-85 shrink-0"
                              >
                                ▶
                              </span>
                            )}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )}

                {/* 3) 상한을 넘은 날짜 칸의 "+n건" 단추 */}
                {hasOverflow && (
                  <div className="grid grid-cols-7 px-0.5 pb-1 pt-0.5 mt-auto">
                    {week.cells.map((cell, col) => {
                      const hiddenCount = week.hiddenCounts[col] ?? 0
                      if (hiddenCount <= 0) return null
                      return (
                        <button
                          key={`more-${cell.date}`}
                          type="button"
                          data-testid={`calendar-more-${cell.date}`}
                          style={{ gridColumn: `${col + 1} / ${col + 2}` }}
                          onClick={() => onOpenDayList(cell)}
                          className="w-full text-left px-1 py-0.5 rounded text-[10px] sm:text-[11px] font-semibold text-sky-300 hover:text-white hover:bg-neutral-800/90 transition-colors truncate cursor-pointer"
                        >
                          +{hiddenCount}건
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
