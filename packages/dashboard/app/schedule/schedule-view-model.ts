import type { PersonalScheduleItem } from "@naia-adk/core/src/personal-schedule"
import type { BoardScheduleProjection, CalendarCellEvent, CalendarUnit, ScheduleDisplayMode, ScheduleLayers, WorkScheduleFilter } from "./schedule-calendar"

export const PERSONAL_IDENTITY_REQUIRED_NOTICE =
  "개인 일정은 로그인 연결 설정 뒤에 켜집니다(다른 분 일정이 섞이지 않게 지금은 꺼 두었습니다)"

export const PERSONAL_WARNINGS_LOCKED_NOTICE =
  "내 일정 정보를 읽지 못해 화면에서 고치기를 잠갔습니다. 관리자에게 알려 주세요."

export const PERSONAL_LOADING_NOTICE = "개인 일정 불러오는 중"
export const MAX_VISIBLE_PERSONAL_WARNINGS = 5

export type PersonalLayerStatus = "loading" | "ready" | "identity-required" | "warnings-locked" | "unavailable"

export interface PersonalLayerState {
  status: PersonalLayerStatus
  user: string
  userLabel: string
  items: PersonalScheduleItem[]
  warnings: string[]
  canMutate: boolean
}

/**
 * /schedule-personal 응답(HTTP 상태 코드와 본문)을 화면의 개인 일정 겹 상태로 변환하는 순수 함수.
 * - 신원 오류 403 -> identity-required (편집 잠금, 항목 비움)
 * - 200/201 이고 warnings 가 1개 이상 -> warnings-locked (항목과 경고 표시, 편집 잠금)
 * - 200/201 이고 warnings 가 없음 -> ready (항목 표시, 편집 가능)
 */
export function personalLayerStateFromResponse(
  httpStatus: number,
  body: unknown,
): PersonalLayerState {
  const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
  if (httpStatus === 403 && obj.error === "personal-schedule-identity-required") {
    return {
      status: "identity-required",
      user: "",
      userLabel: "",
      items: [],
      warnings: [],
      canMutate: false,
    }
  }

  const user = typeof obj.user === "string" ? obj.user : ""
  const userLabel = typeof obj.userLabel === "string" && obj.userLabel ? obj.userLabel : user
  const items = Array.isArray(obj.items) ? (obj.items as PersonalScheduleItem[]) : []
  const warnings = Array.isArray(obj.warnings)
    ? obj.warnings.filter((w): w is string => typeof w === "string" && w.trim().length > 0)
    : []

  if ((httpStatus === 409 && obj.error === "personal-schedule-has-warnings") || warnings.length > 0) {
    return {
      status: "warnings-locked",
      user,
      userLabel,
      items,
      warnings,
      canMutate: false,
    }
  }

  if (httpStatus >= 200 && httpStatus < 300) {
    return {
      status: "ready",
      user,
      userLabel,
      items,
      warnings: [],
      canMutate: true,
    }
  }

  return {
    status: "unavailable",
    user,
    userLabel,
    items,
    warnings,
    canMutate: false,
  }
}

export interface ScheduleViewProps {
  hasBoard: boolean | null
  initialMode?: ScheduleDisplayMode
  initialUnit?: CalendarUnit
  initialLayers?: Partial<ScheduleLayers>
  initialWorkFilter?: WorkScheduleFilter
  initialAnchorDate?: string
  initialPersonalItems?: PersonalScheduleItem[]
  initialPersonalWarnings?: string[]
  initialPersonalIdentityRequired?: boolean
  initialPersonalLayerState?: PersonalLayerState
  initialUserKey?: string
  initialUserLabel?: string
  initialBoardSchedule?: BoardScheduleProjection
  initialFormOpen?: boolean
  initialSelectedEvent?: CalendarCellEvent | null
  initialDayListDate?: string | null
  fetchFn?: typeof fetch
}

export interface FormState {
  editingId: string | null
  title: string
  allDay: boolean
  startDate: string
  startTime: string
  endDate: string
  endTime: string
  memo: string
}

/** A draft belongs only to the identity that was visible when it was opened. */
export function shouldDiscardPersonalDraft(previousUser: string | null, nextState: PersonalLayerState): boolean {
  if (!nextState.canMutate || !nextState.user) return true
  return previousUser !== null && previousUser !== nextState.user
}

export function emptyFormState(defaultDate: string): FormState {
  return {
    editingId: null,
    title: "",
    allDay: true,
    startDate: defaultDate,
    startTime: "09:00",
    endDate: defaultDate,
    endTime: "10:00",
    memo: "",
  }
}

export function formStateFromItem(item: PersonalScheduleItem): FormState {
  const startDate = item.start.slice(0, 10)
  const endDate = (item.end || item.start).slice(0, 10)
  const startTimeMatch = item.start.match(/[ T](\d{2}:\d{2})/)
  const endTimeMatch = (item.end || "").match(/[ T](\d{2}:\d{2})/)
  return {
    editingId: item.id,
    title: item.title,
    allDay: item.allDay,
    startDate,
    startTime: startTimeMatch ? startTimeMatch[1] : "09:00",
    endDate,
    endTime: endTimeMatch ? endTimeMatch[1] : startTimeMatch ? startTimeMatch[1] : "10:00",
    memo: item.memo || "",
  }
}

export function buildInitialPersonalLayerState(props: ScheduleViewProps): PersonalLayerState {
  if (props.initialPersonalLayerState) {
    return props.initialPersonalLayerState
  }
  if (props.initialPersonalIdentityRequired) {
    return personalLayerStateFromResponse(403, { error: "personal-schedule-identity-required" })
  }
  if (props.initialPersonalItems !== undefined || props.initialPersonalWarnings !== undefined) {
    return personalLayerStateFromResponse(200, {
      user: props.initialUserKey ?? "",
      userLabel: props.initialUserLabel ?? props.initialUserKey ?? "",
      items: props.initialPersonalItems ?? [],
      warnings: props.initialPersonalWarnings ?? [],
    })
  }
  return {
    status: "loading",
    user: props.initialUserKey ?? "",
    userLabel: props.initialUserLabel ?? props.initialUserKey ?? "",
    items: [],
    warnings: [],
    canMutate: false,
  }
}

