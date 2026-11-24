import type { Locale } from "../i18n/types.ts"
import { formatMessage, getDict } from "../i18n/index.ts"

export type LedgerStatus = "open" | "waiting_human" | "escalated_human" | "done" | "dropped"

export interface LedgerResultLink {
  kind: "doc" | "url" | "unlinked"
  label: string
  displayPath: string | null
  href: string | null
  source: string | null
  path: string | null
}

export interface LedgerCardItem {
  id: string
  role: string
  title: string
  status: LedgerStatus
  due: string | null
  dueDate: string | null
  overdue: boolean
  isTodo: boolean
  createdAt: string | null
  checkedAt: string | null
  note: string
  channel: string
  msgId: string
  quote: string
  sourceUrl: string | null
  resultLinks: LedgerResultLink[]
  workerName: string | null
  hasDrive: boolean
}

export interface LedgerSummary {
  total: number
  todoCount: number
  open: number
  waiting_human: number
  escalated_human: number
  done: number
  dropped: number
  overdue: number
  processing?: number
}

export interface LedgerPayload {
  configured: boolean
  available: boolean
  view: "board" | "due"
  observedAt: string
  todayDate: string
  timezone: string
  roles: string[]
  summary: LedgerSummary
  filteredSummary: LedgerSummary
  maxSubagents?: number | null
  items: LedgerCardItem[]
  warnings: string[]
}

export type WorkBoardTab = "summary" | "detail" | "archive"
export type DetailStatusFilter = "todo" | "all" | LedgerStatus | "processing"

export const WORK_BOARD_TABS: readonly { id: WorkBoardTab; label: string }[] = [
  { id: "summary", label: "요약" },
  { id: "detail", label: "상세" },
  { id: "archive", label: "보관(옛 대기열)" },
]

export const LEDGER_STATUS_LABEL: Record<LedgerStatus, string> = {
  open: "진행 중",
  waiting_human: "사람 확인 대기",
  escalated_human: "사람 올림",
  done: "완료",
  dropped: "취소",
}

export const DETAIL_STATUS_FILTERS: readonly { id: DetailStatusFilter; label: string }[] = [
  { id: "todo", label: "할 일(열림·대기)" },
  { id: "all", label: "전체" },
  { id: "open", label: "진행 중" },
  { id: "processing", label: "서브에이전트 작업 중" },
  { id: "waiting_human", label: "사람 확인 대기" },
  { id: "escalated_human", label: "사람 올림" },
  { id: "done", label: "완료" },
  { id: "dropped", label: "취소" },
]

export function workBoardTabs(locale: Locale = "ko"): readonly { id: WorkBoardTab; label: string }[] {
  const dict = getDict(locale)
  return [
    { id: "summary", label: dict["work.tabSummary"] },
    { id: "detail", label: dict["work.tabDetail"] },
    { id: "archive", label: dict["work.tabArchive"] },
  ]
}

export function ledgerStatusLabel(status: LedgerStatus, locale: Locale = "ko"): string {
  const dict = getDict(locale)
  if (status === "open") return dict["work.statusOpen"]
  if (status === "waiting_human") return dict["work.statusWaiting"]
  if (status === "escalated_human") return dict["work.statusEscalated"]
  if (status === "done") return dict["work.statusDone"]
  return dict["work.statusDropped"]
}

export function isProcessingWorkerItem(item: Pick<LedgerCardItem, "status" | "workerName">): boolean {
  return item.status === "open" && Boolean(item.workerName)
}

export function detailStatusFilters(locale: Locale = "ko"): readonly { id: DetailStatusFilter; label: string }[] {
  const dict = getDict(locale)
  return [
    { id: "todo", label: dict["work.filterTodo"] },
    { id: "all", label: dict["work.filterAll"] },
    { id: "open", label: dict["work.statusOpen"] },
    { id: "processing", label: dict["work.processing"] },
    { id: "waiting_human", label: dict["work.statusWaiting"] },
    { id: "escalated_human", label: dict["work.statusEscalated"] },
    { id: "done", label: dict["work.statusDone"] },
    { id: "dropped", label: dict["work.statusDropped"] },
  ]
}

export function isActiveStatus(status: LedgerStatus): boolean {
  return status === "open" || status === "waiting_human" || status === "escalated_human"
}

export function normalizeWorkTab(tabParam?: string | null, viewParam?: string | null): WorkBoardTab {
  if (tabParam === "detail" || viewParam === "detail") return "detail"
  if (tabParam === "archive" || viewParam === "archive") return "archive"
  return "summary"
}

export function isSafeHttpUrl(url: string | null | undefined): url is string {
  return typeof url === "string" && /^https?:\/\//i.test(url.trim())
}

export function sortLedgerCards(items: LedgerCardItem[], locale: Locale = "ko"): LedgerCardItem[] {
  return [...items].sort((a, b) => {
    const aActive = isActiveStatus(a.status)
    const bActive = isActiveStatus(b.status)
    if (aActive !== bActive) return aActive ? -1 : 1
    if (aActive && bActive) {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1
      const aDue = a.due ? Date.parse(a.due) : Number.MAX_SAFE_INTEGER
      const bDue = b.due ? Date.parse(b.due) : Number.MAX_SAFE_INTEGER
      const aSafeDue = Number.isFinite(aDue) ? aDue : Number.MAX_SAFE_INTEGER
      const bSafeDue = Number.isFinite(bDue) ? bDue : Number.MAX_SAFE_INTEGER
      if (aSafeDue !== bSafeDue) return aSafeDue - bSafeDue
    } else {
      const aClosed = Date.parse(a.checkedAt ?? a.due ?? "") || 0
      const bClosed = Date.parse(b.checkedAt ?? b.due ?? "") || 0
      if (aClosed !== bClosed) return bClosed - aClosed
    }
    const roleCmp = a.role.localeCompare(b.role, locale)
    if (roleCmp !== 0) return roleCmp
    return a.id.localeCompare(b.id)
  })
}

export function filterLedgerCards(
  items: LedgerCardItem[],
  opts: {
    role?: string
    statusFilter?: DetailStatusFilter
    overdueOnly?: boolean
    query?: string
    locale?: Locale
  },
): LedgerCardItem[] {
  const role = opts.role?.trim() || ""
  const statusFilter = opts.statusFilter ?? "all"
  const overdueOnly = Boolean(opts.overdueOnly)
  const q = opts.query?.trim().toLowerCase() || ""

  const filtered = items.filter((item) => {
    if (role && item.role !== role) return false
    if (statusFilter === "todo") {
      if (item.status !== "open" && item.status !== "waiting_human") return false
    } else if (statusFilter === "processing") {
      if (!isProcessingWorkerItem(item)) return false
    } else if (statusFilter !== "all" && item.status !== statusFilter) {
      return false
    }
    if (overdueOnly && !item.overdue) return false
    if (q) {
      const haystack = `${item.role} ${item.title} ${item.note} ${item.quote} ${item.id}`.toLowerCase()
      if (!haystack.includes(q)) return false
    }
    return true
  })

  return sortLedgerCards(filtered, opts.locale)
}

export function splitSummaryColumns(
  items: LedgerCardItem[],
  opts: { role?: string; overdueOnly?: boolean; query?: string; recentDoneLimit?: number; locale?: Locale } = {},
): {
  openItems: LedgerCardItem[]
  waitingItems: LedgerCardItem[]
  recentDoneItems: LedgerCardItem[]
  processingItems: LedgerCardItem[]
} {
  const filtered = filterLedgerCards(items, {
    role: opts.role,
    statusFilter: "all",
    overdueOnly: opts.overdueOnly,
    query: opts.query,
    locale: opts.locale,
  })
  const limit = opts.recentDoneLimit ?? 20
  const processingItems = filtered.filter((i) => isProcessingWorkerItem(i))
  const openItems = filtered.filter((i) => i.status === "open" && !isProcessingWorkerItem(i))
  const waitingItems = filtered.filter((i) => i.status === "waiting_human" || i.status === "escalated_human")
  const recentDoneItems = filtered.filter((i) => i.status === "done" || i.status === "dropped").slice(0, limit)
  return { openItems, waitingItems, recentDoneItems, processingItems }
}

export interface RoleBucketSummary {
  role: string
  total: number
  todoCount: number
  overdueCount: number
}

export function summarizeRoles(items: LedgerCardItem[], configuredRoles: string[] = [], locale: Locale = "ko"): RoleBucketSummary[] {
  const map = new Map<string, RoleBucketSummary>()
  for (const r of configuredRoles) {
    if (r) map.set(r, { role: r, total: 0, todoCount: 0, overdueCount: 0 })
  }
  for (const item of items) {
    let bucket = map.get(item.role)
    if (!bucket) {
      bucket = { role: item.role, total: 0, todoCount: 0, overdueCount: 0 }
      map.set(item.role, bucket)
    }
    bucket.total++
    if (item.isTodo) bucket.todoCount++
    if (item.overdue) bucket.overdueCount++
  }
  return [...map.values()].sort((a, b) => a.role.localeCompare(b.role, locale))
}

export function formatDueLabel(
  dueIso: string | null,
  overdue: boolean,
  nowMs: number = Date.now(),
  timeZone = "Asia/Seoul",
  locale: Locale = "ko",
): string {
  const dict = getDict(locale)
  if (!dueIso) return dict["work.noDue"]
  const ms = Date.parse(dueIso)
  if (!Number.isFinite(ms)) return dueIso

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms))
  const m: Record<string, string> = {}
  for (const p of parts) m[p.type] = p.value
  const formatted = `${m.month}/${m.day} ${m.hour}:${m.minute}`

  if (!overdue) return formatted
  const diffMin = Math.max(1, Math.round((nowMs - ms) / 60_000))
  if (locale === "en") {
    if (diffMin < 60) return `${formatted} (${diffMin} min overdue)`
    const diffHours = Math.round(diffMin / 60)
    if (diffHours < 48) return `${formatted} (${diffHours}h overdue)`
    const diffDays = Math.round(diffHours / 24)
    return `${formatted} (${diffDays}d overdue)`
  }
  if (diffMin < 60) return `${formatted} (${diffMin}분 지남)`
  const diffHours = Math.round(diffMin / 60)
  if (diffHours < 48) return `${formatted} (${diffHours}시간 지남)`
  const diffDays = Math.round(diffHours / 24)
  return `${formatted} (${diffDays}일 지남)`
}
