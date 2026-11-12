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

export const DEEP_LINK_MISSING_NOTICE = "일정을 찾지 못했습니다. 지워졌거나 지금 볼 수 없는 일정입니다."

export type DeepLinkLookup =
  | { status: "wait" }
  | { status: "found"; event: CalendarCellEvent }
  | { status: "missing" }

/**
 * Look the link up once its data has arrived: the source for its layer finished loading (personal file
 * or board projection), the layer is shown, and the grid covers the linked date. Until then keep waiting;
 * after that the answer is final, so a link that is not there is dropped instead of opening later.
 */
export function resolveDeepLink(
  cells: CalendarDayCell[],
  target: ScheduleLinkTarget,
  { sourceLoaded, layerShown }: { sourceLoaded: boolean; layerShown: boolean },
): DeepLinkLookup {
  if (!sourceLoaded || !layerShown || !cells.some((c) => c.date === target.date)) return { status: "wait" }
  const event = findLinkedEvent(cells, target)
  return event ? { status: "found", event } : { status: "missing" }
}
