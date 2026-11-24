import { localDateOnly, daysBetweenDates, MAX_WORK_DOCUMENT_TASKS, MAX_TASK_TEXT_LENGTH, MAX_QUEUE_DESCRIPTION_LENGTH, type TaskStatusBadge } from "./schedule-calendar-base"
import type { Locale } from "../i18n/types.ts"
import { getDict } from "../i18n/index.ts"

// ── 작업보드 스냅숏 → 작업 일정 & 마일스톤 추출 ──────────────────────────────

export interface WorkScheduleTask {
  number: string
  task: string
  assignee: string
  status: string
  done: boolean
}

export interface WorkScheduleItem {
  id: string
  title: string
  issue: string
  status: string
  rawStatus?: string
  kind: "queue" | "work_document"
  completed: boolean
  cancelled: boolean
  overdue: boolean
  hasDates: boolean
  startDate: string | null
  endDate: string | null
  dueDate: string | null
  startSource: string | null
  endSource: string | null
  dueSource: string | null
  dateSources: string[]
  milestoneId: string | null
  milestoneName: string | null
  parentGroupId: string | null
  parentGroupName: string | null
  assignee?: string | null
  tasks?: WorkScheduleTask[]
  taskTotal?: number
  taskDone?: number
  docLink?: string | null
  attemptCount?: number
  description?: string
  openEnded?: boolean
}

export interface MilestoneScheduleItem {
  id: string
  name: string
  description: string
  order: number
  dueDate: string | null
  daysRemaining: number | null
  completed: number
  total: number
  overdue: boolean
}

export interface BoardScheduleProjection {
  observedAt: string | null
  todayDate: string
  workItems: WorkScheduleItem[]
  undatedItems: WorkScheduleItem[]
  milestones: MilestoneScheduleItem[]
}

function canonicalIssueKey(value: unknown): string {
  const match = String(value ?? "")
    .trim()
    .match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*)(?=$|\s)/)
  return match ? match[1].toLowerCase() : ""
}

const COMPLETE_STATUS_SET = new Set(["완료", "완료됨", "끝", "완료 처리", "done", "complete", "completed", "closed"])
const SUCCESS_OUTCOME_SET = new Set(["succeeded", "success", "passed"])
const VALID_DOC_SOURCE_RE = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,127}$/

function truncateText(value: unknown, maxLen: number): string {
  if (typeof value !== "string") return ""
  const trimmed = value.trim()
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed
}

/**
 * 세부 작업의 상태 글이 완료("끝", "완료", "done", "complete" 로 시작)인지 판정한다.
 */
export function isTaskDoneStatus(status: unknown): boolean {
  const normalized = String(status ?? "")
    .trim()
    .toLowerCase()
  if (!normalized) return false
  return (
    normalized.startsWith("끝") ||
    normalized.startsWith("완료") ||
    normalized.startsWith("done") ||
    normalized.startsWith("complete")
  )
}

/**
 * 세부 작업 상태 글 앞머리를 보고 딱지("완료" | "진행" | "대기" | "미완료")를 정하는 순수 함수.
 * - 끝/완료/done/complete → "완료"
 * - 진행/doing/in progress/working → "진행"
 * - 대기/todo/pending/예정/보류/blocked/(빈 값) → "대기"
 * - 그 밖 → "미완료"
 */
export function taskStatusBadge(status: unknown): TaskStatusBadge
export function taskStatusBadge(status: unknown, locale: Locale): string
export function taskStatusBadge(status: unknown, locale: Locale = "ko"): TaskStatusBadge | string {
  const normalized = String(status ?? "")
    .trim()
    .toLowerCase()
  const dict = locale === "en" ? getDict("en") : null
  const pick = (ko: TaskStatusBadge, key: "sched.taskBadgeDone" | "sched.taskBadgeProgress" | "sched.taskBadgeWaiting" | "sched.taskBadgeTodo"): TaskStatusBadge | string =>
    dict ? dict[key] : ko
  if (!normalized) return pick("대기", "sched.taskBadgeWaiting")
  if (isTaskDoneStatus(normalized)) return pick("완료", "sched.taskBadgeDone")
  if (
    normalized.startsWith("진행") ||
    normalized.startsWith("doing") ||
    normalized.startsWith("in progress") ||
    normalized.startsWith("in-progress") ||
    normalized.startsWith("in_progress") ||
    normalized.startsWith("working")
  ) {
    return pick("진행", "sched.taskBadgeProgress")
  }
  if (
    normalized.startsWith("대기") ||
    normalized.startsWith("todo") ||
    normalized.startsWith("to do") ||
    normalized.startsWith("to-do") ||
    normalized.startsWith("pending") ||
    normalized.startsWith("예정") ||
    normalized.startsWith("보류") ||
    normalized.startsWith("blocked")
  ) {
    return pick("대기", "sched.taskBadgeWaiting")
  }
  return pick("미완료", "sched.taskBadgeTodo")
}

/**
 * 작업 문서의 viewerUrl 에서 source·path 를 읽어 현재 대시보드 문서 주소로 변환한다.
 * 외부 호스트와 기기 이름은 내보내지 않는다.
 */
export function buildShortDocLink(viewerUrl: unknown): string | null {
  if (typeof viewerUrl !== "string") return null
  const trimmed = viewerUrl.trim()
  if (!trimmed) return null

  let u: URL
  try {
    u = new URL(trimmed, "http://placeholder.invalid")
  } catch {
    return null
  }

  let source = u.searchParams.get("source")?.trim() ?? ""
  let rawPath = u.searchParams.get("path")?.trim() ?? ""

  if ((!source || !rawPath) && u.pathname.startsWith("/d/")) {
    const rest = u.pathname.slice(3).split("/")
    if (rest.length >= 2) {
      try {
        source = decodeURIComponent(rest[0]).trim()
        rawPath = rest
          .slice(1)
          .map((seg) => decodeURIComponent(seg))
          .join("/")
          .trim()
      } catch {
        return null
      }
    }
  }

  if (!source || !rawPath) return null
  if (!VALID_DOC_SOURCE_RE.test(source) || source.includes("..")) return null
  if (
    rawPath.length > 1024 ||
    rawPath.startsWith("/") ||
    rawPath.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(rawPath)
  ) {
    return null
  }

  const segments = rawPath.split("/")
  if (segments.some((seg) => seg === "" || seg === "." || seg === "..")) {
    return null
  }

  return `/docs?source=${encodeURIComponent(source)}&path=${encodeURIComponent(rawPath)}`
}

/**
 * 작업 문서의 tasks 배열을 최대 60개, 각 문자열 최대 300자로 추려 { tasks, taskTotal, taskDone } 으로 돌려준다.
 */
export function extractWorkDocumentTasks(rawTasks: unknown): {
  tasks: WorkScheduleTask[]
  taskTotal: number
  taskDone: number
} {
  if (!Array.isArray(rawTasks)) {
    return { tasks: [], taskTotal: 0, taskDone: 0 }
  }
  const validTasks = rawTasks.filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === "object")
  const tasks: WorkScheduleTask[] = validTasks.slice(0, MAX_WORK_DOCUMENT_TASKS).map((t, idx) => {
    const rawNum =
      typeof t.number === "string" || typeof t.number === "number" ? String(t.number) : String(idx + 1)
    const number = truncateText(rawNum, MAX_TASK_TEXT_LENGTH) || String(idx + 1)
    const task = truncateText(
      typeof t.task === "string" ? t.task : typeof t.title === "string" ? t.title : "",
      MAX_TASK_TEXT_LENGTH,
    )
    const assignee = truncateText(typeof t.assignee === "string" ? t.assignee : "", MAX_TASK_TEXT_LENGTH)
    const status = truncateText(typeof t.status === "string" ? t.status : "", MAX_TASK_TEXT_LENGTH)
    const done = isTaskDoneStatus(status)
    return { number, task, assignee, status, done }
  })
  const taskTotal = tasks.length
  const taskDone = tasks.filter((t) => t.done).length
  return { tasks, taskTotal, taskDone }
}

function isQueueEntryComplete(entry: Record<string, unknown>, schedule: Record<string, unknown>): boolean {
  if (schedule.completed === true) return true
  const ver = (entry.verification && typeof entry.verification === "object" ? entry.verification : {}) as Record<
    string,
    unknown
  >
  const outcome = String(ver.executionOutcome ?? "").toLowerCase()
  return ver.resultIsCurrent === true && SUCCESS_OUTCOME_SET.has(outcome)
}

/**
 * 작업보드(/api/snapshot) 응답에서 그룹(작업) 일정(날짜 있는 항목·날짜 없는 항목)과 마일스톤을 추출한다.
 * board/index.html 의 scheduleEntries / renderSchedule 규칙과 1:1 동등하게 동작한다.
 */
export function extractBoardSchedule(snapshot: unknown, fallbackToday?: string, locale: Locale = "ko"): BoardScheduleProjection {
  const s = (snapshot && typeof snapshot === "object" ? snapshot : {}) as Record<string, unknown>
  const observedAt = typeof s.observedAt === "string" ? s.observedAt : null
  const todayDate = fallbackToday ?? localDateOnly(observedAt) ?? localDateOnly(new Date()) ?? "2000-01-01"
  const untitled = getDict(locale)["sched.untitled"]

  const allEntries: WorkScheduleItem[] = []
  const rawItems = Array.isArray(s.items) ? s.items : []

  for (const rawEntry of rawItems) {
    if (!rawEntry || typeof rawEntry !== "object") continue
    const entry = rawEntry as Record<string, unknown>
    const itemObj = (entry.item && typeof entry.item === "object" ? entry.item : entry) as Record<string, unknown>
    const sched = (entry.schedule && typeof entry.schedule === "object" ? entry.schedule : {}) as Record<
      string,
      unknown
    >

    const id = String(itemObj.id || itemObj.issue || itemObj.title || "unknown")
    const title = String(itemObj.title || itemObj.id || untitled)
    const issue = typeof itemObj.issue === "string" ? itemObj.issue : ""
    const status = typeof entry.status === "string" ? entry.status : "unknown"
    const cancelled = entry.cancelled === true
    const completed = isQueueEntryComplete(entry, sched)
    const startDate = localDateOnly(sched.startAt)
    const endDate = localDateOnly(sched.endAt)
    const dueDate = localDateOnly(sched.dueDate)
    const startSource = typeof sched.startSource === "string" ? sched.startSource : null
    const endSource = typeof sched.endSource === "string" ? sched.endSource : null
    const dueSource = typeof sched.dueSource === "string" ? sched.dueSource : null
    const dateSources = Array.isArray(sched.dateSource)
      ? sched.dateSource.filter((x): x is string => typeof x === "string")
      : []
    const hasDates = sched.hasDates === true || Boolean(startDate || endDate || dueDate)
    const overdue = Boolean(dueDate && dueDate < todayDate && !completed && !cancelled)
    const openEnded = endSource === "projection.today"

    const runnerObj = entry.runner && typeof entry.runner === "object" ? (entry.runner as Record<string, unknown>) : null
    const assignee =
      typeof itemObj.assignee === "string" && itemObj.assignee.trim()
        ? truncateText(itemObj.assignee, MAX_TASK_TEXT_LENGTH)
        : typeof itemObj.runnerRef === "string" && itemObj.runnerRef.trim()
          ? truncateText(itemObj.runnerRef, MAX_TASK_TEXT_LENGTH)
          : typeof runnerObj?.ref === "string" && runnerObj.ref.trim()
            ? truncateText(runnerObj.ref, MAX_TASK_TEXT_LENGTH)
            : null

    const attemptCount = Array.isArray(entry.attempts) ? entry.attempts.length : 0
    const description = truncateText(itemObj.description, MAX_QUEUE_DESCRIPTION_LENGTH)

    allEntries.push({
      id,
      title,
      issue,
      status,
      rawStatus: status,
      kind: "queue",
      completed,
      cancelled,
      overdue,
      hasDates,
      startDate,
      endDate,
      dueDate,
      startSource,
      endSource,
      dueSource,
      dateSources,
      milestoneId: typeof sched.milestoneId === "string" ? sched.milestoneId : null,
      milestoneName: typeof sched.milestoneName === "string" ? sched.milestoneName : null,
      parentGroupId: typeof sched.parentGroupId === "string" ? sched.parentGroupId : null,
      parentGroupName: typeof sched.parentGroupName === "string" ? sched.parentGroupName : null,
      assignee,
      tasks: [],
      taskTotal: 0,
      taskDone: 0,
      docLink: null,
      attemptCount,
      description,
      openEnded,
    })
  }

  const linkedIssues = new Set(allEntries.map((e) => canonicalIssueKey(e.issue)).filter(Boolean))
  const rawDocs = Array.isArray(s.workDocuments) ? s.workDocuments : []

  for (const rawDoc of rawDocs) {
    if (!rawDoc || typeof rawDoc !== "object") continue
    const doc = rawDoc as Record<string, unknown>
    const issue = typeof doc.issue === "string" ? doc.issue : ""
    const issueKey = canonicalIssueKey(issue)
    if (issueKey && linkedIssues.has(issueKey)) continue

    const sched = (doc.schedule && typeof doc.schedule === "object" ? doc.schedule : {}) as Record<string, unknown>
    const id = String(doc.id || doc.path || "document")
    const title = String(doc.title || doc.id || untitled)
    const status = typeof doc.status === "string" ? doc.status : "unknown"
    const completed = sched.completed === true || COMPLETE_STATUS_SET.has(status.trim().toLowerCase())
    const startDate = localDateOnly(sched.startAt)
    const endDate = localDateOnly(sched.endAt)
    const dueDate = localDateOnly(sched.dueDate)
    const startSource = typeof sched.startSource === "string" ? sched.startSource : null
    const endSource = typeof sched.endSource === "string" ? sched.endSource : null
    const dueSource = typeof sched.dueSource === "string" ? sched.dueSource : null
    const dateSources = Array.isArray(sched.dateSource)
      ? sched.dateSource.filter((x): x is string => typeof x === "string")
      : []
    const hasDates = sched.hasDates === true || Boolean(startDate || endDate || dueDate)
    const overdue = Boolean(dueDate && dueDate < todayDate && !completed)
    const openEnded = endSource === "projection.today"

    const assignee =
      typeof doc.assignee === "string" && doc.assignee.trim()
        ? truncateText(doc.assignee, MAX_TASK_TEXT_LENGTH)
        : null
    const { tasks, taskTotal, taskDone } = extractWorkDocumentTasks(doc.tasks)
    const docLink = buildShortDocLink(doc.viewerUrl)
    const description = truncateText(doc.description, MAX_QUEUE_DESCRIPTION_LENGTH)

    allEntries.push({
      id,
      title,
      issue,
      status,
      rawStatus: status,
      kind: "work_document",
      completed,
      cancelled: false,
      overdue,
      hasDates,
      startDate,
      endDate,
      dueDate,
      startSource,
      endSource,
      dueSource,
      dateSources,
      milestoneId: typeof sched.milestoneId === "string" ? sched.milestoneId : null,
      milestoneName: typeof sched.milestoneName === "string" ? sched.milestoneName : null,
      parentGroupId: typeof sched.parentGroupId === "string" ? sched.parentGroupId : null,
      parentGroupName: typeof sched.parentGroupName === "string" ? sched.parentGroupName : null,
      assignee,
      tasks,
      taskTotal,
      taskDone,
      docLink,
      attemptCount: 0,
      description,
      openEnded,
    })
  }

  const workItems = allEntries.filter((e) => e.hasDates)
  const undatedItems = allEntries.filter((e) => !e.hasDates)

  const rawMilestones = Array.isArray(s.milestones) ? s.milestones : []
  const milestones: MilestoneScheduleItem[] = rawMilestones
    .filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === "object")
    .map((m, idx) => {
      const id = String(m.id || `milestone-${idx + 1}`)
      const name = locale === "en"
        ? String(m.nameEn || m.name || m.nameKo || id)
        : String(m.nameKo || m.name || m.nameEn || id)
      const description = typeof m.description === "string" ? m.description : ""
      const order = typeof m.order === "number" && Number.isFinite(m.order) ? m.order : idx + 1
      const dueDate = localDateOnly(m.dueDate)
      const completed = typeof m.completed === "number" && Number.isFinite(m.completed) ? m.completed : 0
      const total = typeof m.total === "number" && Number.isFinite(m.total) ? m.total : 0
      const daysRemaining =
        typeof m.daysRemaining === "number" && Number.isFinite(m.daysRemaining)
          ? m.daysRemaining
          : dueDate
            ? daysBetweenDates(todayDate, dueDate)
            : null
      const overdue = Boolean(dueDate && dueDate < todayDate && (total === 0 || completed < total))
      return {
        id,
        name,
        description,
        order,
        dueDate,
        daysRemaining,
        completed,
        total,
        overdue,
      }
    })
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, locale))

  return {
    observedAt,
    todayDate,
    workItems,
    undatedItems,
    milestones,
  }
}

// ── 업무 장부(/api/portal/ledger?view=due) → 통합 일정 투영 변환 ─────────────

const SAFE_SCHEDULE_LOCAL_ID_RE = /^[A-Za-z0-9._:\-가-힣]{1,120}$/

function strictDateOnly(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const dt = new Date(Date.UTC(year, month - 1, day))
  if (
    dt.getUTCFullYear() !== year
    || dt.getUTCMonth() !== month - 1
    || dt.getUTCDate() !== day
  ) {
    return null
  }
  return trimmed
}

export function isSafeScheduleLocalId(value: unknown): value is string {
  return typeof value === "string" && SAFE_SCHEDULE_LOCAL_ID_RE.test(value)
}

function sanitizeLedgerItemId(rawId: unknown): string | null {
  if (typeof rawId !== "string") return null
  const trimmed = rawId.trim()
  if (!trimmed) return null
  if (SAFE_SCHEDULE_LOCAL_ID_RE.test(trimmed)) return trimmed
  const cleaned = trimmed.replace(/[^A-Za-z0-9._:\-가-힣]/g, "_").slice(0, 120)
  return cleaned && SAFE_SCHEDULE_LOCAL_ID_RE.test(cleaned) ? cleaned : null
}

export function formatLedgerStatusLabel(rawStatus: unknown, locale: Locale = "ko"): string {
  const status = typeof rawStatus === "string" ? rawStatus.trim() : ""
  const dict = getDict(locale)
  switch (status) {
    case "open":
      return dict["sched.statusInProgress"]
    case "waiting_human":
      return dict["sched.statusReview"]
    case "escalated_human":
      return dict["sched.statusEscalated2"]
    case "done":
      return dict["sched.statusDone2"]
    case "dropped":
      return dict["sched.statusDropped2"]
    default:
      return truncateText(status, MAX_TASK_TEXT_LENGTH) || dict["sched.statusUnknown"]
  }
}

const KNOWN_WORK_STATUS_CODES: Record<string, string> = {
  open: "open",
  active: "open",
  "in progress": "open",
  "진행": "open",
  "진행 중": "open",
  waiting_human: "waiting_human",
  waiting: "waiting_human",
  pending: "waiting_human",
  "awaiting review": "waiting_human",
  "확인 대기": "waiting_human",
  "대기": "waiting_human",
  escalated_human: "escalated_human",
  escalated: "escalated_human",
  "사람 개입": "escalated_human",
  done: "done",
  complete: "done",
  completed: "done",
  "완료": "done",
  "완료됨": "done",
  dropped: "dropped",
  cancelled: "dropped",
  "제외": "dropped",
  "취소": "dropped",
  unknown: "",
  "미확인": "",
}

/** Localizes a projected work schedule item's status at render time without losing custom text. */
export function formatWorkStatusLabel(
  item: Pick<WorkScheduleItem, "status" | "rawStatus">,
  locale: Locale = "ko",
): string {
  const rawCandidate = typeof item.rawStatus === "string" ? item.rawStatus.trim() : ""
  const rawLower = rawCandidate.toLowerCase()
  if (rawCandidate && Object.hasOwn(KNOWN_WORK_STATUS_CODES, rawLower)) {
    return formatLedgerStatusLabel(KNOWN_WORK_STATUS_CODES[rawLower], locale)
  }
  const statusCandidate = typeof item.status === "string" ? item.status.trim() : ""
  const statusLower = statusCandidate.toLowerCase()
  if (statusCandidate && Object.hasOwn(KNOWN_WORK_STATUS_CODES, statusLower)) {
    return formatLedgerStatusLabel(KNOWN_WORK_STATUS_CODES[statusLower], locale)
  }
  return statusCandidate || "-"
}

export function sanitizeLedgerDocHref(rawHref: unknown): string | null {
  if (typeof rawHref !== "string") return null
  const trimmed = rawHref.trim()
  if (!trimmed || trimmed.length > 2048) return null
  if (trimmed.startsWith("//") || trimmed.includes("\\") || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    return null
  }
  if (!(trimmed === "/docs" || trimmed.startsWith("/docs?") || trimmed.startsWith("/d/"))) {
    return null
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed, "http://placeholder.invalid")
  } catch {
    return null
  }
  if (parsed.origin !== "http://placeholder.invalid") return null
  if (parsed.pathname !== "/docs" && !parsed.pathname.startsWith("/d/")) return null
  const segments = parsed.pathname.split("/").slice(1)
  for (const seg of segments) {
    if (seg === "." || seg === "..") return null
    try {
      const dec = decodeURIComponent(seg)
      if (dec === "." || dec === ".." || dec.includes("\\")) return null
    } catch {
      return null
    }
  }
  return trimmed
}

function pickLedgerDocLink(rawLinks: unknown): string | null {
  if (!Array.isArray(rawLinks)) return null
  for (const entry of rawLinks) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
    const link = entry as Record<string, unknown>
    if (link.kind !== "doc") continue
    const safeHref = sanitizeLedgerDocHref(link.href)
    if (safeHref) return safeHref
  }
  return null
}

/**
 * 읽기 전용 업무 장부 응답(`/api/portal/ledger?view=due`)을 통합 일정 달력용 `BoardScheduleProjection`으로 변환한다.
 * - `dueDate`가 유효한 `YYYY-MM-DD`인 항목은 모두 `workItems`에 포함한다.
 * - 기한이 없는 활성(`!done && !dropped`) 항목만 `undatedItems`에 포함하고, 완료·제외 무기한 항목은 제외한다.
 * - `kind: "work_document"`로 투영해 기본 켜짐(`layers.work`) 및 `work:<id>` 딥링크 조회와 1:1로 맞춘다.
 */
export function extractLedgerDueSchedule(
  payload: unknown,
  fallbackToday?: string,
  locale: Locale = "ko",
): BoardScheduleProjection {
  const p = (payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {}) as Record<string, unknown>
  const observedAt = typeof p.observedAt === "string" ? p.observedAt : null
  const todayDate =
    strictDateOnly(p.todayDate)
    ?? strictDateOnly(fallbackToday)
    ?? localDateOnly(fallbackToday)
    ?? localDateOnly(new Date())
    ?? "2000-01-01"

  const rawItems = Array.isArray(p.items) ? p.items : []
  const workItems: WorkScheduleItem[] = []
  const undatedItems: WorkScheduleItem[] = []

  for (const rawEntry of rawItems) {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) continue
    const item = rawEntry as Record<string, unknown>
    const id = sanitizeLedgerItemId(item.id)
    if (!id) continue

    const rawStatus = typeof item.status === "string" ? item.status.trim() : ""
    const completed = rawStatus === "done"
    const cancelled = rawStatus === "dropped"
    const overdue = Boolean(item.overdue) && !completed && !cancelled
    const status = formatLedgerStatusLabel(rawStatus, locale)
    const title = truncateText(item.title, MAX_TASK_TEXT_LENGTH) || id
    const assignee =
      typeof item.role === "string" && item.role.trim()
        ? truncateText(item.role, MAX_TASK_TEXT_LENGTH)
        : null
    const description = truncateText(item.note, MAX_QUEUE_DESCRIPTION_LENGTH)
    const docLink = pickLedgerDocLink(item.resultLinks)
    const dueDate = strictDateOnly(item.dueDate)

    if (dueDate) {
      workItems.push({
        id,
        title,
        issue: "",
        status,
        rawStatus,
        kind: "work_document",
        completed,
        cancelled,
        overdue,
        hasDates: true,
        startDate: dueDate,
        endDate: dueDate,
        dueDate,
        startSource: "ledger.due",
        endSource: "ledger.due",
        dueSource: "ledger.due",
        dateSources: ["ledger.due"],
        milestoneId: null,
        milestoneName: null,
        parentGroupId: null,
        parentGroupName: null,
        assignee,
        tasks: [],
        taskTotal: 0,
        taskDone: 0,
        docLink,
        attemptCount: 0,
        description,
        openEnded: false,
      })
    } else if (!completed && !cancelled) {
      undatedItems.push({
        id,
        title,
        issue: "",
        status,
        rawStatus,
        kind: "work_document",
        completed,
        cancelled,
        overdue,
        hasDates: false,
        startDate: null,
        endDate: null,
        dueDate: null,
        startSource: null,
        endSource: null,
        dueSource: null,
        dateSources: [],
        milestoneId: null,
        milestoneName: null,
        parentGroupId: null,
        parentGroupName: null,
        assignee,
        tasks: [],
        taskTotal: 0,
        taskDone: 0,
        docLink,
        attemptCount: 0,
        description,
        openEnded: false,
      })
    }
  }

  return {
    observedAt,
    todayDate,
    workItems,
    undatedItems,
    milestones: [],
  }
}
