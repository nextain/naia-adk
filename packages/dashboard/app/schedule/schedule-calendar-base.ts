// [일정] 화면의 달력 보기·목록 보기 계산과 브라우저 저장소 기억.
// 네 겹(개인 일정 · 그룹(작업) 일정 · 마일스톤 · 실행 대기열)을 달력 칸(월간·주간)에 배치하고 켜고 끄기를 적용한다.
//
// 표시 규칙 (조정자 결정 정본 기록 대상):
// 1) 그룹(작업) 일정의 기본 보기(workFilter="open")는 완료(completed) 또는 취소(cancelled)된 작업을 숨기고
//    미완료 작업만 달력과 요약에 표시한다. 사용자가 [전체 작업](workFilter="all") 필터를 고르면 완료·취소 작업도 다시 보인다.
//    실행 대기열(kind="queue") 층은 기본 끔(queue=false)이며, 사용자가 [실행 대기열] 단추를 켰을 때만 달력에 표시한다.
//    [그룹(작업) 일정] 단추와 숫자는 작업 문서(kind="work_document")만 다룬다.
// 2) 여러 날에 걸친 일정은 날마다 쪼개 반복하지 않고, 같은 주(일~토) 줄 안에서 시작~끝 칸을 잇는 긴 막대 하나로 그린다.
//    주를 넘으면 다음 주 줄에서 이어 그리며(이어지는 쪽 끝 표시, 앞 주에서 이어 온 막대에도 제목 표시),
//    세부 작업이 있는 일정은 막대 끝에 완료/전체 숫자를 함께 보여 준다.
// 3) 줄(lane)은 마일스톤 → 개인 일정 → 작업 문서(그룹 작업) → 큐 항목 순(같은 종류 안에서는 기간이 긴 것 먼저·시작 이른 것 먼저·제목 순)으로
//    탐욕 배정하며, 보이는 줄 상한(월 단위 3줄 · 주 단위 10줄)을 넘은 일정은 칸 아래 "+n건" 단추로 묶어 그날 목록 창과 상세 창에서 보여 준다.

export type ScheduleDisplayMode = "calendar" | "list"
export type CalendarUnit = "month" | "week"
export type ScheduleLayerKey = "personal" | "work" | "milestone" | "queue"
export type WorkScheduleFilter = "open" | "all"
export type SpanPosition = "single" | "start" | "middle" | "end"
export type TaskStatusBadge = "완료" | "진행" | "대기" | "미완료"

export interface ScheduleLayers {
  personal: boolean
  work: boolean
  milestone: boolean
  queue: boolean
}

export const DEFAULT_SCHEDULE_LAYERS: ScheduleLayers = {
  personal: true,
  work: true,
  milestone: true,
  queue: false,
}

export const SCHEDULE_MODE_STORAGE_KEY = "portal.schedule.mode.v1"
export const SCHEDULE_UNIT_STORAGE_KEY = "portal.schedule.unit.v1"
export const SCHEDULE_LAYERS_STORAGE_KEY = "portal.schedule.layers.v1"
export const SCHEDULE_WORK_FILTER_STORAGE_KEY = "portal.schedule.workFilter.v1"

export const LAYER_LABELS: Record<ScheduleLayerKey, string> = {
  personal: "개인 일정",
  work: "그룹(작업) 일정",
  milestone: "마일스톤",
  queue: "대기 중인 작업",
}

export const WEEKDAY_LABELS_KO = ["일", "월", "화", "수", "목", "금", "토"] as const

export const MONTH_MAX_VISIBLE_LANES = 3
export const WEEK_MAX_VISIBLE_LANES = 10
export const MAX_WORK_DOCUMENT_TASKS = 60
export const MAX_TASK_TEXT_LENGTH = 300
export const MAX_QUEUE_DESCRIPTION_LENGTH = 500

// ── 브라우저 저장소(localStorage) 읽기·쓰기 ───────────────────────────────────

export function normalizeDisplayMode(value: unknown): ScheduleDisplayMode {
  return value === "list" ? "list" : "calendar"
}

export function normalizeCalendarUnit(value: unknown): CalendarUnit {
  return value === "week" ? "week" : "month"
}

export function normalizeWorkFilter(value: unknown): WorkScheduleFilter {
  return value === "all" ? "all" : "open"
}

export function normalizeScheduleLayers(value: unknown): ScheduleLayers {
  if (!value || typeof value !== "object") return { ...DEFAULT_SCHEDULE_LAYERS }
  const v = value as Record<string, unknown>
  return {
    personal: typeof v.personal === "boolean" ? v.personal : true,
    work: typeof v.work === "boolean" ? v.work : true,
    milestone: typeof v.milestone === "boolean" ? v.milestone : true,
    queue: typeof v.queue === "boolean" ? v.queue : false,
  }
}

export function readStoredDisplayMode(storage?: Pick<Storage, "getItem"> | null): ScheduleDisplayMode {
  try {
    const store = storage ?? (typeof window !== "undefined" ? window.localStorage : null)
    return normalizeDisplayMode(store?.getItem(SCHEDULE_MODE_STORAGE_KEY))
  } catch {
    return "calendar"
  }
}

export function writeStoredDisplayMode(mode: ScheduleDisplayMode, storage?: Pick<Storage, "setItem"> | null): void {
  try {
    const store = storage ?? (typeof window !== "undefined" ? window.localStorage : null)
    store?.setItem(SCHEDULE_MODE_STORAGE_KEY, mode)
  } catch {}
}

export function readStoredCalendarUnit(storage?: Pick<Storage, "getItem"> | null): CalendarUnit {
  try {
    const store = storage ?? (typeof window !== "undefined" ? window.localStorage : null)
    return normalizeCalendarUnit(store?.getItem(SCHEDULE_UNIT_STORAGE_KEY))
  } catch {
    return "month"
  }
}

export function writeStoredCalendarUnit(unit: CalendarUnit, storage?: Pick<Storage, "setItem"> | null): void {
  try {
    const store = storage ?? (typeof window !== "undefined" ? window.localStorage : null)
    store?.setItem(SCHEDULE_UNIT_STORAGE_KEY, unit)
  } catch {}
}

export function readStoredScheduleLayers(storage?: Pick<Storage, "getItem"> | null): ScheduleLayers {
  try {
    const store = storage ?? (typeof window !== "undefined" ? window.localStorage : null)
    const raw = store?.getItem(SCHEDULE_LAYERS_STORAGE_KEY)
    return raw ? normalizeScheduleLayers(JSON.parse(raw)) : { ...DEFAULT_SCHEDULE_LAYERS }
  } catch {
    return { ...DEFAULT_SCHEDULE_LAYERS }
  }
}

export function writeStoredScheduleLayers(
  layers: Omit<ScheduleLayers, "queue"> & { queue?: boolean },
  storage?: Pick<Storage, "setItem"> | null,
): void {
  try {
    const store = storage ?? (typeof window !== "undefined" ? window.localStorage : null)
    store?.setItem(SCHEDULE_LAYERS_STORAGE_KEY, JSON.stringify(normalizeScheduleLayers(layers)))
  } catch {}
}

export function readStoredWorkFilter(storage?: Pick<Storage, "getItem"> | null): WorkScheduleFilter {
  try {
    const store = storage ?? (typeof window !== "undefined" ? window.localStorage : null)
    return normalizeWorkFilter(store?.getItem(SCHEDULE_WORK_FILTER_STORAGE_KEY))
  } catch {
    return "open"
  }
}

export function writeStoredWorkFilter(filter: WorkScheduleFilter, storage?: Pick<Storage, "setItem"> | null): void {
  try {
    const store = storage ?? (typeof window !== "undefined" ? window.localStorage : null)
    store?.setItem(SCHEDULE_WORK_FILTER_STORAGE_KEY, filter)
  } catch {}
}

// ── 날짜 유틸리티 (실행 환경의 현지 날짜 YYYY-MM-DD) ─────────────────────────

export function localDateOnly(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed
    const prefixMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})[ T]\d{1,2}:\d{2}/)
    if (prefixMatch && !trimmed.endsWith("Z") && !/[+-]\d{2}:?\d{2}$/.test(trimmed)) {
      return prefixMatch[1]
    }
  }
  if (!(value instanceof Date) && typeof value !== "string" && typeof value !== "number") return null
  const dt = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(dt.getTime())) return null
  const parts = new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(dt)
  const map: Record<string, string> = {}
  for (const part of parts) {
    map[part.type] = part.value
  }
  return `${map.year}-${map.month}-${map.day}`
}

export function parseDateParts(dateStr: string): { year: number; month: number; day: number } | null {
  const m = String(dateStr || "").match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }
}

export function formatUtcDate(dt: Date): string {
  const y = dt.getUTCFullYear()
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0")
  const d = String(dt.getUTCDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

export function addDays(dateStr: string, deltaDays: number): string {
  const parts = parseDateParts(dateStr)
  if (!parts) return dateStr
  const dt = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + deltaDays))
  return formatUtcDate(dt)
}

export function daysBetweenDates(startDate: string, endDate: string): number {
  const a = parseDateParts(startDate)
  const b = parseDateParts(endDate)
  if (!a || !b) return 0
  const msA = Date.UTC(a.year, a.month - 1, a.day)
  const msB = Date.UTC(b.year, b.month - 1, b.day)
  return Math.round((msB - msA) / 86_400_000)
}

export function shiftCalendarAnchor(anchorDate: string, unit: CalendarUnit, direction: -1 | 1): string {
  const parts = parseDateParts(anchorDate)
  if (!parts) return anchorDate
  if (unit === "week") {
    return addDays(anchorDate, direction * 7)
  }
  // 월 이동 시 해당 달의 1일로 맞춘다.
  const dt = new Date(Date.UTC(parts.year, parts.month - 1 + direction, 1))
  return formatUtcDate(dt)
}

export function formatCalendarPeriodTitle(anchorDate: string, unit: CalendarUnit): string {
  const parts = parseDateParts(anchorDate)
  if (!parts) return anchorDate
  if (unit === "month") {
    return `${parts.year}년 ${parts.month}월`
  }
  const dt = new Date(Date.UTC(parts.year, parts.month - 1, parts.day))
  const dow = dt.getUTCDay()
  const weekStart = addDays(anchorDate, -dow)
  const weekEnd = addDays(weekStart, 6)
  const s = parseDateParts(weekStart)!
  const e = parseDateParts(weekEnd)!
  if (s.year === e.year && s.month === e.month) {
    return `${s.year}년 ${s.month}월 ${s.day}일 ~ ${e.day}일`
  }
  if (s.year === e.year) {
    return `${s.year}년 ${s.month}월 ${s.day}일 ~ ${e.month}월 ${e.day}일`
  }
  return `${s.year}.${s.month}.${s.day} ~ ${e.year}.${e.month}.${e.day}`
}

