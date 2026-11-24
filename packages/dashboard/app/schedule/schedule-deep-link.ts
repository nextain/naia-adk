// /schedule?item=<layer>:<id>&date=YYYY-MM-DD (messenger reminders, "일정에 넣기" result) opens that item's detail.
import { parseScheduleDetailSearch, type ScheduleLinkTarget } from "@naia-adk/core/src/schedule-link"
import type { CalendarCellEvent, CalendarDayCell, ScheduleDisplayMode, WorkScheduleFilter } from "./schedule-calendar"
import type { Locale } from "../i18n/types.ts"
import { getDict } from "../i18n/index.ts"

export type { ScheduleLinkTarget }

export function readScheduleDeepLink(search: string | null | undefined): ScheduleLinkTarget | null {
  return search ? parseScheduleDetailSearch(search) : null
}

function matchesTargetLayer(ev: CalendarCellEvent, targetLayer: ScheduleLinkTarget["layer"]): boolean {
  if (targetLayer === "queue") {
    return ev.layer === "queue" || (ev.layer === "work" && ev.workItem?.kind === "queue")
  }
  if (targetLayer === "work") {
    return ev.layer === "work" && ev.workItem?.kind !== "queue"
  }
  return ev.layer === targetLayer
}

function matchesTargetEventId(ev: CalendarCellEvent, target: ScheduleLinkTarget): boolean {
  if (ev.id === target.id) return true
  if (target.layer === "company") {
    return ev.id === `company:${target.id}` || `company:${ev.id}` === target.id
  }
  return false
}

/** The event the link points at, looked up on the linked date first and then anywhere on the grid. */
export function findLinkedEvent(cells: CalendarDayCell[], target: ScheduleLinkTarget): CalendarCellEvent | null {
  const match = (ev: CalendarCellEvent) => matchesTargetLayer(ev, target.layer) && matchesTargetEventId(ev, target)
  const onDate = cells.find((c) => c.date === target.date)?.events.find(match)
  if (onDate) return onDate
  for (const cell of cells) {
    const ev = cell.events.find(match)
    if (ev) return ev
  }
  return null
}

export const DEEP_LINK_MISSING_NOTICE = "일정을 찾지 못했습니다. 지워졌거나 지금 볼 수 없는 일정입니다."

export function deepLinkMissingNotice(locale: Locale = "ko"): string {
  return getDict(locale)["sched.deepLinkMissing"]
}

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
  { sourceLoaded, layerShown, mode = "calendar", workFilter = "all" }: {
    sourceLoaded: boolean; layerShown: boolean; mode?: ScheduleDisplayMode; workFilter?: WorkScheduleFilter
  },
): DeepLinkLookup {
  if (mode !== "calendar" || ((target.layer === "work" || target.layer === "queue") && workFilter !== "all")) return { status: "wait" }
  if (!sourceLoaded || !layerShown || !cells.some((c) => c.date === target.date)) return { status: "wait" }
  const event = findLinkedEvent(cells, target)
  return event ? { status: "found", event } : { status: "missing" }
}
