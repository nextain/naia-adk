export type PublishJson = null | boolean | number | string | PublishJson[] | { [key: string]: PublishJson }
export interface PublishIssue { field?: string; message?: string; path?: string; image_index?: number }
export interface PublishReceipt {
  receipt_id: string; revision_id: string; approved_at: string; approved_hash: string
  [key: string]: unknown
}
export interface PublishStatus {
  ok: true
  state: "draft" | "pending_review" | "approved_waiting_export" | "changed_after_approval"
  saved_revision: string | null; revision_id: string | null; preview_hash: string | null
  pending_revision_id: string | null; review_id: string | null; approved_revision_id: string | null
  receipt: PublishReceipt | null; changed_after_approval: boolean; can_request_review: boolean; can_approve: boolean
  draft_error: { code: string; message: string; issues: PublishIssue[] } | null
  elapsed_ms: number; max_poll_interval_ms: number; change_display_budget_ms: number
}
export interface PublishSitePreview {
  site: string; language: string; title: string; summary: string; body: string; hero?: string
  frontmatter: Record<string, PublishJson>; media_map: Record<string, PublishJson>
  targets: string[]; languages: Record<string, string[]>; date: string
}
export interface PublishPreviewResponse {
  ok: true; slug: string; review_id: string; revision_id: string; saved_revision: string; preview_hash: string
  previews: Record<string, Record<string, PublishSitePreview>>
  frontmatter: Record<string, PublishJson>; media_map: Record<string, PublishJson>
  assets: { path: string; source_path?: string; sha256: string; url: string }[]
  issues: PublishIssue[]; can_approve: boolean
}
export interface PublishReviewResult {
  ok: true; state: "pending_review"; review_id: string; revision_id: string; saved_revision: string
  operation_id: string; review_url: string; task_id: string
}
export interface PublishApprovedRevision extends PublishPreviewResponse { receipt: PublishReceipt; can_approve: false }
export interface PublishApprovalResult {
  ok: true; state: "approved_waiting_export"; revision_id: string; operation_id: string; receipt: PublishReceipt
}
export interface PublishProcessing { ok: true; state: "processing"; operation_id: string }
export type PublishResult = PublishReviewResult | PublishApprovalResult | PublishProcessing
export interface PublishReviewTodo { slug: string; review_id: string; revision_id: string; review_url: string; state: string }

export class PublishClientError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryable = false,
    readonly issues: PublishIssue[] = [], readonly operation_id?: string) { super(message) }
}

export function isPublishIdentityError(error: unknown): boolean {
  return error instanceof PublishClientError && (error.status === 401 || error.status === 403)
}

export function publishErrorMessage(error: unknown): string {
  if (!(error instanceof PublishClientError)) return "게시 확인 정보를 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요."
  if (error.code === "publish_gateway_unconfirmed") return "승인 기능이 아직 켜지지 않았습니다. 담당자가 게시 승인 계정 연결을 확인한 뒤 다시 시도해 주세요."
  if (error.status === 401) return "로그인 정보를 확인하지 못했습니다. 로그인한 뒤 다시 시도해 주세요."
  if (error.status === 403) return "이 계정으로 게시 확인을 진행할 수 없습니다. 문서 접근 권한과 게시 승인 계정 연결을 확인해 주세요."
  if (["PREVIEW_CHANGED", "SAVED_REVISION_CHANGED"].includes(error.code)) return "내용이 바뀌었습니다. 현재 저장판을 다시 열고 새 게시 확인을 요청해 주세요."
  if (error.code === "IDEMPOTENCY_CONFLICT") return "같은 처리 번호의 원래 요청과 내용이 다릅니다. 원래 요청의 처리 결과를 먼저 확인해 주세요."
  if (error.code === "REVIEW_TASK_WRITE_FAILED") return "게시 확인 할 일을 저장하지 못했습니다. 같은 요청으로 다시 시도해 주세요."
  if (error.status === 413) return "그림 크기를 확인해 주세요. 그림 한 장은 5,242,880바이트, 묶음은 83,886,080바이트까지 허용합니다."
  if (error.status === 503 && error.code === "APPROVER_CONFIG_INVALID") return "승인 계정 설정을 확인하지 못했습니다. 담당자가 설정을 확인한 뒤 다시 시도해 주세요."
  return error.message
}

export async function publishFetch<T>(url: string, init: RequestInit = {}, fetchFn: typeof fetch = fetch): Promise<{ status: number; data: T }> {
  try {
    const response = await fetchFn(url, { ...init, cache: "no-store" })
    const data = await response.json().catch(() => null)
    if (response.ok && !data) throw new PublishClientError(response.status, "PUBLISH_RESPONSE_INVALID",
      "서버 응답을 확인하지 못했습니다. 같은 요청으로 다시 시도해 주세요.", true)
    if (!response.ok || !data || data.ok === false) throw new PublishClientError(response.status, data?.code ?? "PUBLISH_UNAVAILABLE",
      data?.message ?? "게시 확인 정보를 불러오지 못했습니다. 다시 시도해 주세요.", data?.retryable ?? response.status >= 500, data?.issues ?? [], data?.operation_id)
    return { status: response.status, data }
  } catch (error) {
    if (error instanceof PublishClientError) throw error
    throw new PublishClientError(0, "NETWORK_ERROR", "서버 응답을 확인하지 못했습니다. 같은 요청으로 다시 시도해 주세요.", true)
  }
}

export const publishBaseUrl = (slug: string) => `/api/portal/publish/${encodeURIComponent(slug)}`
export async function getPublishDocument(source: string, path: string, fetchFn: typeof fetch = fetch) {
  return (await publishFetch<{ ok: true; slug: string | null; can_request_review: boolean }>(`/api/portal/publish/document?${new URLSearchParams({ source, path })}`, {}, fetchFn)).data
}
export async function getPublishStatus(slug: string, fetchFn: typeof fetch = fetch, signal?: AbortSignal): Promise<PublishStatus> {
  return (await publishFetch<PublishStatus>(`${publishBaseUrl(slug)}/status`, { signal }, fetchFn)).data
}
export async function getPublishPreview(slug: string, reviewId: string, revisionId: string, fetchFn: typeof fetch = fetch): Promise<PublishPreviewResponse> {
  return (await publishFetch<PublishPreviewResponse>(`${publishBaseUrl(slug)}/preview?${new URLSearchParams({ review_id: reviewId, revision_id: revisionId })}`, {}, fetchFn)).data
}
export async function getPublishApprovedRevision(slug: string, revisionId: string, fetchFn: typeof fetch = fetch): Promise<PublishApprovedRevision> {
  return (await publishFetch<PublishApprovedRevision>(`${publishBaseUrl(slug)}/revisions/${encodeURIComponent(revisionId)}`, {}, fetchFn)).data
}
export async function getPublishReviewTodos(fetchFn: typeof fetch = fetch): Promise<PublishReviewTodo[]> {
  return (await publishFetch<{ ok: true; tasks: PublishReviewTodo[] }>("/api/portal/publish/review-todos", {}, fetchFn)).data.tasks
}

// 503·응답 유실·202 뒤에도 같은 작업의 키와 본문을 다시 사용한다.
export class PublishMutation {
  private intents = new Map<string, string>()
  constructor(private createKey = () => crypto.randomUUID()) {}
  async execute(slug: string, action: "request-review" | "approve", input: Record<string, string>, fetchFn: typeof fetch = fetch): Promise<PublishResult> {
    const body = JSON.stringify(Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))))
    const identity = JSON.stringify([slug, action, body])
    const key = this.intents.get(identity) ?? this.createKey()
    this.intents.set(identity, key)
    const response = await publishFetch<PublishResult>(`${publishBaseUrl(slug)}/${action}`, {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body,
    }, fetchFn)
    const acknowledge = (result: PublishResult) => {
      if ((result.state === "pending_review" || result.state === "approved_waiting_export") && this.intents.get(identity) === key) this.intents.delete(identity)
      return result
    }
    if (response.status !== 202) return acknowledge(response.data)
    const operation = (await publishFetch<{ state: string; operation_id: string; result?: PublishReviewResult | PublishApprovalResult; code?: string }>(
      `/api/portal/publish/operations/${encodeURIComponent(response.data.operation_id)}`, {}, fetchFn)).data
    if (operation.state === "committed" && operation.result) return acknowledge(operation.result)
    if (operation.state === "retry_wait" || operation.state === "rejected") throw new PublishClientError(operation.state === "retry_wait" ? 503 : 409,
      operation.code ?? "PUBLISH_UNAVAILABLE", "처리 결과를 확인하지 못했습니다. 같은 요청으로 다시 시도해 주세요.", operation.state === "retry_wait", [], operation.operation_id)
    return { ok: true, state: "processing", operation_id: operation.operation_id }
  }
}

export function publishPollInterval(status: PublishStatus): number {
  return Math.min(2000, Math.max(0, status.max_poll_interval_ms))
}

// 조회 정지·실패 때 이전 일치 표시를 남기지 않는다. 느린 응답도 5초 안에 불확실 상태로 바꾼다.
export function watchPublishStatus(slug: string, onStatus: (status: PublishStatus | null, error?: unknown) => void,
  fetchFn: typeof fetch = fetch, timing = { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) }) {
  let stopped = false, generation = 0, timer: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined, stale: ReturnType<typeof setTimeout> | undefined, request: AbortController | undefined
  const refresh = async () => {
    const current = ++generation
    request?.abort()
    if (timer) timing.clearTimeout(timer)
    if (deadline) timing.clearTimeout(deadline)
    request = new AbortController()
    const controller = request
    let expired = false
    const timeout = timing.setTimeout(() => {
      controller.abort(); expired = true
      if (!stopped && current === generation) {
        onStatus(null, new PublishClientError(0, "STATUS_TIMEOUT", "현재 판 일치 여부를 확인하지 못했습니다.", true))
        timer = timing.setTimeout(refresh, 2000)
      }
    }, 2750)
    deadline = timeout
    try {
      const status = await getPublishStatus(slug, fetchFn, controller.signal)
      if (!stopped && current === generation && !controller.signal.aborted) {
        if (stale) timing.clearTimeout(stale)
        // 복귀·저장으로 조회를 다시 시작해도 마지막 성공의 유효 시간을 미루지 않는다.
        stale = timing.setTimeout(() => {
          if (!stopped) onStatus(null, new PublishClientError(0, "STATUS_TIMEOUT", "현재 판 일치 여부를 확인하지 못했습니다.", true))
        }, 4750)
        onStatus(status)
        timer = timing.setTimeout(refresh, publishPollInterval(status))
      }
    } catch (error) {
      if (!stopped && current === generation && !expired) { onStatus(null, error); timer = timing.setTimeout(refresh, 2000) }
    } finally { timing.clearTimeout(timeout) }
  }
  void refresh()
  return { refresh, stop() { stopped = true; generation++; request?.abort(); if (timer) timing.clearTimeout(timer); if (deadline) timing.clearTimeout(deadline); if (stale) timing.clearTimeout(stale) } }
}
