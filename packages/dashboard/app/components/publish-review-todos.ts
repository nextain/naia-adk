// Publish-review todo list adapter for the decisions/todo surfaces.
//
// The timeline/work-review stacks this helper was extracted with do not exist
// in this workspace, so the two tiny display dependencies are mirrored here
// (UNKNOWN_PERSON, formatShortDate) with the same values and behavior.

export const PUBLISH_REVIEW_TODOS_URL = "/api/portal/publish/review-todos"
export const PUBLISH_REVIEW_CHANGED_EVENT = "portal:publish-review-changed"
export const MSG_PUBLISH_REVIEW_TODOS_FAILED = "게시 확인 할 일을 불러오지 못했습니다"

export type PublishReviewTaskState = "pending_review" | "superseded" | "completed"

/** Unknown person label (mirrors the timeline stack). */
export const UNKNOWN_PERSON = "모름"

/** "M/D HH:MM" in Asia/Seoul (mirrors the timeline stack). */
export function formatShortDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  )
  return `${Number(parts.month)}/${Number(parts.day)} ${parts.hour}:${parts.minute}`
}

export interface PublishReviewLink {
  label: string
  href: string
  external: boolean
}

export interface PublishReviewTimelineItem {
  key: string
  kind: "publish_review"
  by: string
  byRaw: string
  atMs: number | null
  atLabel: string
  due: string | null
  dueMs: number | null
  overdue: boolean
  title: string
  detail: string
  links: PublishReviewLink[]
  publishReviewState: PublishReviewTaskState
}

export interface PublishReviewTask {
  task_id: string
  kind: "publish_review"
  title: string
  assignee_id: string
  slug: string
  review_id: string
  revision_id: string
  saved_revision: string
  created_at: string
  review_url: string
  state: PublishReviewTaskState
}

export interface PublishReviewTodosResponse {
  ok: true
  enabled: boolean
  tasks: PublishReviewTask[]
}

export interface PublishReviewTodosResult {
  enabled: boolean
  tasks: PublishReviewTask[]
}

export const PUBLISH_REVIEW_STATE_LABEL: Record<PublishReviewTaskState, string> = {
  pending_review: "게시 확인 대기",
  superseded: "새 요청판으로 대체됨",
  completed: "승인 완료·내보내기 대기",
}

function validTask(value: unknown): value is PublishReviewTask {
  if (!value || typeof value !== "object") return false
  const task = value as Record<string, unknown>
  const fields = ["task_id", "title", "assignee_id", "slug", "review_id", "revision_id", "saved_revision", "created_at", "review_url"]
  if (fields.some((field) => typeof task[field] !== "string" || !(task[field] as string).trim())) return false
  if (task.kind !== "publish_review" || !["pending_review", "superseded", "completed"].includes(String(task.state))) return false
  if (!Number.isFinite(Date.parse(task.created_at as string))) return false
  // 서버 주소를 재조립하지 않는다. 다른 사이트나 다른 요청판의 주소는 사용하지 않는다.
  if (!(task.review_url as string).startsWith("/docs?")) return false
  const url = new URL(task.review_url as string, "https://portal.invalid")
  return url.pathname === "/docs" && url.searchParams.getAll("publishReview").length === 1 &&
    url.searchParams.get("publishReview") === task.review_id &&
    !!url.searchParams.get("source") && !!url.searchParams.get("path")
}

// 손상된 응답도 조회 실패다. 빈 성공이나 일부 항목만의 성공으로 바꾸지 않는다.
export async function loadPublishReviewTodosResult(fetchFn: typeof fetch = fetch): Promise<PublishReviewTodosResult> {
  const response = await fetchFn(PUBLISH_REVIEW_TODOS_URL, { cache: "no-store" })
  if (!response.ok) {
    const failure = await response.json().catch(() => null) as { code?: unknown } | null
    if (response.status === 403 && failure?.code === "publish_gateway_unconfirmed") return { enabled: false, tasks: [] }
    throw new Error(MSG_PUBLISH_REVIEW_TODOS_FAILED)
  }
  const data: unknown = await response.json()
  if (!data || typeof data !== "object") throw new Error(MSG_PUBLISH_REVIEW_TODOS_FAILED)
  const result = data as Record<string, unknown>
  const enabled = result.enabled !== false
  if (result.ok !== true || !Array.isArray(result.tasks) || !result.tasks.every(validTask) || (!enabled && result.tasks.length !== 0)) {
    throw new Error(MSG_PUBLISH_REVIEW_TODOS_FAILED)
  }
  if (new Set(result.tasks.map((task) => task.task_id)).size !== result.tasks.length) {
    throw new Error(MSG_PUBLISH_REVIEW_TODOS_FAILED)
  }
  return { enabled, tasks: result.tasks }
}

export async function loadPublishReviewTodos(fetchFn: typeof fetch = fetch): Promise<PublishReviewTask[]> {
  return (await loadPublishReviewTodosResult(fetchFn)).tasks
}

export function publishReviewTimelineItems(tasks: PublishReviewTask[]): PublishReviewTimelineItem[] {
  return tasks.map((task) => ({
    key: `publish-review-${task.task_id}`,
    kind: "publish_review" as const,
    // 서버 계약에는 요청자 이름이 없다. 담당자를 올린 사람으로 표시하지 않는다.
    by: UNKNOWN_PERSON,
    byRaw: "",
    atMs: Date.parse(task.created_at),
    atLabel: formatShortDate(task.created_at),
    due: null,
    dueMs: null,
    overdue: false,
    title: task.title,
    detail: "",
    links: [{ label: "요청판 열기", href: task.review_url, external: false }],
    publishReviewState: task.state,
  }))
}
