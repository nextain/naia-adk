// Schedule screen deep link: /schedule?item=<layer>:<id>&date=YYYY-MM-DD.
// The messenger notifier writes it and the schedule screen opens the matching detail.

export const SCHEDULE_LINK_LAYERS = ["personal", "milestone", "work", "queue"] as const
export type ScheduleLinkLayer = (typeof SCHEDULE_LINK_LAYERS)[number]

export interface ScheduleLinkTarget {
  layer: ScheduleLinkLayer
  id: string
  date: string
}

const ID_RE = /^[A-Za-z0-9._:\-가-힣]{1,120}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function validDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false
  const [y, m, d] = date.split("-").map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

export function isScheduleLinkTarget(value: { layer?: unknown; id?: unknown; date?: unknown }): value is ScheduleLinkTarget {
  return (
    typeof value.layer === "string" && (SCHEDULE_LINK_LAYERS as readonly string[]).includes(value.layer) &&
    typeof value.id === "string" && ID_RE.test(value.id) &&
    typeof value.date === "string" && validDate(value.date)
  )
}

/** Path (and query) of the schedule detail. Prefix with an origin when the reader is outside the dashboard. */
export function scheduleDetailHref(target: ScheduleLinkTarget, origin = ""): string {
  if (!isScheduleLinkTarget(target)) throw new Error("invalid schedule link target")
  const base = origin.replace(/\/+$/, "")
  const query = new URLSearchParams({ item: `${target.layer}:${target.id}`, date: target.date })
  return `${base}/schedule?${query.toString()}`
}

/** Reads ?item=&date= from a search string ("?a=b" or "a=b"). Invalid or partial values give null. */
export function parseScheduleDetailSearch(search: string): ScheduleLinkTarget | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)
  const item = params.get("item")
  const date = params.get("date")
  if (!item || !date) return null
  const colon = item.indexOf(":")
  if (colon < 1) return null
  const target = { layer: item.slice(0, colon), id: item.slice(colon + 1), date }
  return isScheduleLinkTarget(target) ? target : null
}

/**
 * When href points at the schedule screen of this dashboard (relative, or absolute on one of the given
 * origins), returns the in-dashboard path to navigate to. Anything else gives null.
 */
export function scheduleLinkPath(href: string, sameOrigins: readonly string[] = []): string | null {
  let url: URL
  try {
    url = new URL(href, "http://relative.invalid")
  } catch {
    return null
  }
  const relative = url.origin === "http://relative.invalid" && href.startsWith("/") && !href.startsWith("//")
  if (!relative) {
    const origins = sameOrigins.map((o) => { try { return new URL(o).origin } catch { return "" } }).filter(Boolean)
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || !origins.includes(url.origin)) return null
  }
  if (url.pathname !== "/schedule") return null
  const target = parseScheduleDetailSearch(url.search)
  return target ? scheduleDetailHref(target) : "/schedule"
}
