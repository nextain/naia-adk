import { localDateOnly, daysBetweenDates, MAX_WORK_DOCUMENT_TASKS, MAX_TASK_TEXT_LENGTH, MAX_QUEUE_DESCRIPTION_LENGTH, type TaskStatusBadge } from "./schedule-calendar-base"

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
export function taskStatusBadge(status: unknown): TaskStatusBadge {
  const normalized = String(status ?? "")
    .trim()
    .toLowerCase()
  if (!normalized) return "대기"
  if (isTaskDoneStatus(normalized)) return "완료"
  if (
    normalized.startsWith("진행") ||
    normalized.startsWith("doing") ||
    normalized.startsWith("in progress") ||
    normalized.startsWith("in-progress") ||
    normalized.startsWith("in_progress") ||
    normalized.startsWith("working")
  ) {
    return "진행"
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
    return "대기"
  }
  return "미완료"
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
export function extractBoardSchedule(snapshot: unknown, fallbackToday?: string): BoardScheduleProjection {
  const s = (snapshot && typeof snapshot === "object" ? snapshot : {}) as Record<string, unknown>
  const observedAt = typeof s.observedAt === "string" ? s.observedAt : null
  const todayDate = fallbackToday ?? localDateOnly(observedAt) ?? localDateOnly(new Date()) ?? "2000-01-01"

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
    const title = String(itemObj.title || itemObj.id || "제목 없음")
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
    const title = String(doc.title || doc.id || "제목 없음")
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
      const name = String(m.nameKo || m.name || m.nameEn || id)
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
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, "ko"))

  return {
    observedAt,
    todayDate,
    workItems,
    undatedItems,
    milestones,
  }
}

