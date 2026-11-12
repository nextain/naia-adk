// /schedule?item=<layer>:<id>&date=YYYY-MM-DD (messenger reminders, "일정에 넣기" result) opens that item's detail.
import { parseScheduleDetailSearch, type ScheduleLinkTarget } from "@naia-adk/core/src/schedule-link"
import type { CalendarCellEvent, CalendarDayCell } from "./schedule-calendar"

export type { ScheduleLinkTarget }

export function readScheduleDeepLink(search: string | null | undefined): ScheduleLinkTarget | null {
  return search ? parseScheduleDetailSearch(search) : null
}

/** The event the link points at, looked up on the linked date first and then anywhere on the grid. */
export function findLinkedEvent(cells: CalendarDayCell[], target: ScheduleLinkTarget): CalendarCellEvent | null {
  const match = (ev: CalendarCellEvent) => ev.layer === target.layer && ev.id === target.id
  const onDate = cells.find((c) => c.date === target.date)?.events.find(match)
  if (onDate) return onDate
  for (const cell of cells) {
    const ev = cell.events.find(match)
    if (ev) return ev
  }
  return null
}
