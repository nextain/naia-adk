export const PUBLISH_REVIEW_TODOS_URL = "/api/portal/publish/review-todos"
export const PUBLISH_REVIEW_CHANGED_EVENT = "portal:publish-review-changed"
export const MSG_PUBLISH_REVIEW_TODOS_FAILED = "게시 확인 할 일을 불러오지 못했습니다."

export type PublishReviewTaskState = "pending_review" | "superseded" | "completed"
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
  if (!(task.review_url as string).startsWith("/docs?")) return false
  const url = new URL(task.review_url as string, "https://portal.invalid")
  const one = (name: string) => url.searchParams.getAll(name).length === 1 && !!url.searchParams.get(name)
  return url.pathname === "/docs" && !url.hash && one("source") && one("path") && one("publishReview") && one("publishRevision") &&
    url.searchParams.get("publishReview") === task.review_id && url.searchParams.get("publishRevision") === task.revision_id
}

export async function loadPublishReviewTodos(fetchFn: typeof fetch = fetch, signal?: AbortSignal): Promise<PublishReviewTask[]> {
  try {
    const response = await fetchFn(PUBLISH_REVIEW_TODOS_URL, { cache: "no-store", ...(signal ? { signal } : {}) })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(MSG_PUBLISH_REVIEW_TODOS_FAILED)
    }
    const data: unknown = await response.json()
    if (!data || typeof data !== "object") throw new Error(MSG_PUBLISH_REVIEW_TODOS_FAILED)
    const result = data as Record<string, unknown>
    if (result.ok !== true || !Array.isArray(result.tasks) || !result.tasks.every(validTask) ||
        new Set(result.tasks.map((task) => task.task_id)).size !== result.tasks.length) {
      throw new Error(MSG_PUBLISH_REVIEW_TODOS_FAILED)
    }
    return result.tasks
  } catch {
    throw new Error(MSG_PUBLISH_REVIEW_TODOS_FAILED)
  }
}
