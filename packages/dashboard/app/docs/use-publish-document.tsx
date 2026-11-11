"use client"

import React, { useEffect, useRef, useState } from "react"
import { PublishIssues, PublishRequestAction, PublishReview, PublishStatusNotice } from "./PublishReview"
import { getPublishDocument, getPublishPreview, getPublishReviewTodos, isPublishIdentityError, PublishClientError, PublishMutation, publishErrorMessage, watchPublishStatus,
  type PublishIssue, type PublishPreviewResponse, type PublishReceipt, type PublishReviewResult, type PublishStatus } from "./publish-client"

export interface DocumentPublishOptions {
  source: string | null; path: string | null; savedRevision: string; enabled: boolean; configured?: boolean; canEdit: boolean
  isDirty: boolean; pendingUploads: number; reviewId: string | null; revisionId: string | null
  onNavigate: (href: string) => boolean; fetchFn?: typeof fetch
}

export function publishReviewHref(result: PublishReviewResult): string {
  const query = new URLSearchParams(result.review_url.split("?")[1] ?? "")
  query.set("publishReview", result.review_id)
  query.set("publishRevision", result.revision_id)
  return `/docs?${query}`
}

export function useDocumentPublish(options: DocumentPublishOptions) {
  const { source, path, savedRevision, canEdit, isDirty, pendingUploads, reviewId, revisionId, onNavigate, fetchFn = fetch } = options
  const enabled = options.enabled && options.configured !== false
  const [registration, setRegistration] = useState<{ slug: string; can_request_review: boolean; document: string } | null>(null)
  const [registrationError, setRegistrationError] = useState<unknown>(null)
  const [status, setStatus] = useState<PublishStatus | null>(null)
  const [statusError, setStatusError] = useState<unknown>(null)
  const [lastReceipt, setLastReceipt] = useState<PublishReceipt | null>(null)
  const [requestResult, setRequestResult] = useState<PublishReviewResult | null>(null)
  const [requestError, setRequestError] = useState<unknown>(null)
  const [requesting, setRequesting] = useState(false)
  const [preview, setPreview] = useState<PublishPreviewResponse | null>(null)
  const [previewError, setPreviewError] = useState<unknown>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewReload, setPreviewReload] = useState(0)
  const [previewView, setPreviewView] = useState("")
  const [approving, setApproving] = useState(false)
  const [approvalError, setApprovalError] = useState<unknown>(null)
  const [approvedReceipt, setApprovedReceipt] = useState<PublishReceipt | null>(null)
  const [canRetryApproval, setCanRetryApproval] = useState(false)
  const [identityEpoch, setIdentityEpoch] = useState(0)
  const identityGeneration = useRef(0)
  const mutation = useRef<PublishMutation | null>(null)
  mutation.current ??= new PublishMutation()
  const watcher = useRef<ReturnType<typeof watchPublishStatus> | null>(null)
  const requestIntent = useRef<Record<string, string> | null>(null)
  const approvalIntent = useRef<Record<string, string> | null>(null)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const generation = useRef(0)
  const requestBusy = useRef(false), approvalBusy = useRef(false)
  const latest = useRef(options)
  latest.current = options
  const latestStatus = useRef(status)
  latestStatus.current = status
  const documentKey = JSON.stringify([source, path])
  const activeRegistration = enabled && registration?.document === documentKey ? registration : null
  const slug = activeRegistration?.slug

  useEffect(() => {
    const current = ++generation.current
    setRegistration(null); setRegistrationError(null); setStatus(null); setStatusError(null); setLastReceipt(null)
    setRequestResult(null); setRequestError(null); setRequesting(false); setApproving(false); setApprovalError(null); setApprovedReceipt(null)
    setPreview(null); setPreviewError(null); setCanRetryApproval(false); requestIntent.current = null; approvalIntent.current = null
    requestBusy.current = false; approvalBusy.current = false
    if (retryTimer.current) clearTimeout(retryTimer.current)
    if (enabled && source && path) void getPublishDocument(source, path, fetchFn).then((result) => {
      if (current === generation.current) setRegistration(result.slug ? { slug: result.slug, can_request_review: result.can_request_review, document: JSON.stringify([source, path]) } : null)
    }).catch((error) => { if (current === generation.current) setRegistrationError(error) })
    return () => { generation.current++; if (retryTimer.current) clearTimeout(retryTimer.current) }
  }, [source, path, enabled, fetchFn])

  useEffect(() => {
    if (!slug) return
    const activeWatcher = watchPublishStatus(slug, (nextStatus, error) => {
      setStatus(nextStatus); setStatusError(error ?? null)
      if (nextStatus?.receipt) setLastReceipt(nextStatus.receipt)
      if (error) {
        setPreview(null); setPreviewError(error); setApprovedReceipt(null)
        if (isPublishIdentityError(error)) { setLastReceipt(null); setCanRetryApproval(false) }
      }
    }, fetchFn)
    watcher.current = activeWatcher
    const refresh = () => { void activeWatcher.refresh() }
    const invalidateIdentity = () => { identityGeneration.current++; setCanRetryApproval(false) }
    const focus = () => { if (document.visibilityState === "visible") { setIdentityEpoch(identityGeneration.current); refresh() } }
    const visible = () => {
      if (document.visibilityState === "visible") focus()
      else invalidateIdentity()
    }
    const targetWindow = window, targetDocument = document
    targetWindow.addEventListener("focus", focus)
    targetWindow.addEventListener("blur", invalidateIdentity)
    targetDocument.addEventListener("visibilitychange", visible)
    return () => { activeWatcher.stop(); watcher.current = null; targetWindow.removeEventListener("focus", focus); targetWindow.removeEventListener("blur", invalidateIdentity); targetDocument.removeEventListener("visibilitychange", visible) }
  }, [slug, fetchFn])

  useEffect(() => { if (slug) void watcher.current?.refresh() }, [savedRevision, slug])

  useEffect(() => {
    setApprovalError(null); setApprovedReceipt(null); approvalIntent.current = null
    setApproving(false); approvalBusy.current = false; setCanRetryApproval(false)
    if (retryTimer.current) clearTimeout(retryTimer.current)
  }, [slug, reviewId, revisionId])

  useEffect(() => {
    let active = true
    const input = approvalIntent.current
    if (!slug || !input || !approvalError || !(approvalError as { retryable?: boolean }).retryable || status?.can_request_review === false) { setCanRetryApproval(false); return }
    if (document.visibilityState !== "visible") return
    const identity = identityGeneration.current
    // 완료된 할 일도 현재 계정의 담당 여부를 확인하므로 응답 유실 뒤 같은 키를 복구할 수 있다.
    void getPublishReviewTodos(fetchFn).then((tasks) => {
      if (active && identity === identityGeneration.current) setCanRetryApproval(tasks.some((task) => task.slug === slug && task.review_id === input.review_id && task.revision_id === input.revision_id))
    }).catch((error) => { if (active && identity === identityGeneration.current && isPublishIdentityError(error)) { setCanRetryApproval(false); setLastReceipt(null); setApprovedReceipt(null); setStatus(null); setStatusError(error) } })
    return () => { active = false }
  }, [slug, status, approvalError, fetchFn, identityEpoch])

  useEffect(() => {
    let active = true
    setPreview(null); setPreviewError(null); setApprovedReceipt(null)
    if (!slug || !reviewId || !status || statusError) { setPreviewLoading(false); return }
    setPreviewLoading(true)
    const load = async () => {
      let exactRevision = revisionId || (requestResult?.review_id === reviewId ? requestResult.revision_id : null)
        || (status?.review_id === reviewId ? status.pending_revision_id : null)
      if (!exactRevision) {
        const tasks = await getPublishReviewTodos(fetchFn)
        exactRevision = tasks.find((task) => task.slug === slug && task.review_id === reviewId)?.revision_id ?? null
      }
      if (!exactRevision) throw new PublishClientError(404, "REVIEW_NOT_FOUND", "이 확인 요청의 판을 확인하지 못했습니다. 요청한 화면의 링크를 다시 열어 주세요.")
      if (status && ((status.revision_id && status.revision_id !== exactRevision) || (status.review_id && status.review_id !== reviewId)))
        throw new PublishClientError(409, "PREVIEW_CHANGED", "이전 확인 요청입니다. 현재 저장판으로 새 게시 확인을 요청해 주세요.")
      const result = await getPublishPreview(slug, reviewId, exactRevision, fetchFn)
      if (active) {
        setPreview({ ...result, can_approve: result.can_approve && status.can_approve })
        if (status?.approved_revision_id === exactRevision && status.state === "approved_waiting_export") setApprovedReceipt(status.receipt)
      }
    }
    void load().catch((error) => {
      if (active) {
        setPreviewError(error)
        if (isPublishIdentityError(error)) { setLastReceipt(null); setApprovedReceipt(null); setStatus(null); setStatusError(error) }
      }
    }).finally(() => { if (active) setPreviewLoading(false) })
    return () => { active = false }
  }, [slug, reviewId, revisionId, status?.revision_id, status?.review_id, status?.state, status?.can_approve, !!status, statusError, requestResult, previewReload, fetchFn])

  const notify = () => { window.dispatchEvent(new Event("portal:publish-review-changed")); void watcher.current?.refresh() }
  const request = async () => {
    if (!slug || requestBusy.current) return
    if (latest.current.isDirty || latest.current.pendingUploads > 0 || !latest.current.canEdit) {
      setRequesting(false)
      if (requestIntent.current) setRequestError(new PublishClientError(0, "REQUEST_PAUSED", "이전 게시 확인 요청의 처리가 남아 있습니다. 저장을 마친 뒤 같은 요청으로 다시 시도해 주세요.", true))
      return
    }
    if (!requestIntent.current && latestStatus.current?.saved_revision && latestStatus.current.saved_revision !== latest.current.savedRevision) {
      setRequestError(new PublishClientError(409, "DOCUMENT_CHANGED", "문서가 다른 곳에서 바뀌었습니다. 문서를 다시 연 뒤 게시 확인을 요청해 주세요."))
      return
    }
    const input = requestIntent.current ?? { saved_revision: latest.current.savedRevision }
    if (!input.saved_revision) return
    requestIntent.current = input
    requestBusy.current = true; setRequesting(true); setRequestError(null); setRequestResult(null)
    const current = generation.current
    let processing = false
    try {
      const result = await mutation.current!.execute(slug, "request-review", input, fetchFn)
      if (current !== generation.current) return
      if (result.state === "processing") { processing = true; retryTimer.current = setTimeout(() => { void request() }, 2000) }
      else if (result.state === "pending_review") { setRequestResult(result); requestIntent.current = null; notify() }
    } catch (error) {
      if (current === generation.current) {
        setRequestError(error)
        if (isPublishIdentityError(error)) { setLastReceipt(null); setApprovedReceipt(null); setStatus(null); setStatusError(error) }
        if (!(error instanceof PublishClientError) || !error.retryable) requestIntent.current = null
        if (error instanceof PublishClientError && error.status === 409) { setStatus(null); setStatusError(error); void watcher.current?.refresh() }
      }
    } finally { if (current === generation.current) { requestBusy.current = false; setRequesting(processing) } }
  }

  const approve = async () => {
    if (!slug || approvalBusy.current) return
    if (latest.current.isDirty || latest.current.pendingUploads > 0) {
      setApproving(false)
      if (approvalIntent.current) setApprovalError(new PublishClientError(0, "APPROVAL_PAUSED", "이전 게시 확인의 처리가 남아 있습니다. 저장을 마친 뒤 같은 요청으로 다시 시도해 주세요.", true))
      return
    }
    const retrying = !!approvalIntent.current
    if (!retrying && latestStatus.current?.saved_revision && latestStatus.current.saved_revision !== latest.current.savedRevision) return
    if (!retrying && (!latestStatus.current?.can_approve || statusError)) return
    const input = approvalIntent.current ?? (preview?.can_approve && !preview.issues.length ? {
      review_id: preview.review_id, revision_id: preview.revision_id, saved_revision: preview.saved_revision, preview_hash: preview.preview_hash,
    } : null)
    if (!input) return
    approvalIntent.current = input
    approvalBusy.current = true; setApproving(true)
    const current = generation.current
    const isCurrent = () => current === generation.current && input.review_id === latest.current.reviewId && (!latest.current.revisionId || input.revision_id === latest.current.revisionId)
    let processing = false
    try {
      if (retrying) {
        let tasks
        const identity = identityGeneration.current
        try { tasks = await getPublishReviewTodos(fetchFn) } catch (error) {
          if (isCurrent() && identity === identityGeneration.current && isPublishIdentityError(error)) { setCanRetryApproval(false); setLastReceipt(null); setApprovedReceipt(null); setStatus(null); setStatusError(error) }
          return
        }
        if (!isCurrent() || identity !== identityGeneration.current) return
        const allowed = latestStatus.current?.can_request_review !== false && tasks.some((task) => task.slug === slug && task.review_id === input.review_id && task.revision_id === input.revision_id)
        setCanRetryApproval(allowed)
        if (!allowed) return
      }
      setApprovalError(null)
      const result = await mutation.current!.execute(slug, "approve", input, fetchFn)
      if (!isCurrent()) return
      if (result.state === "processing") { processing = true; retryTimer.current = setTimeout(() => { void approve() }, 2000) }
      else if (result.state === "approved_waiting_export") { setApprovedReceipt(result.receipt); setLastReceipt(result.receipt); approvalIntent.current = null; notify() }
    } catch (error) {
      if (isCurrent()) {
        setApprovalError(error); setPreview(null); setApprovedReceipt(null); setStatus(null); setStatusError(error)
        if (isPublishIdentityError(error)) setLastReceipt(null)
        if (!(error instanceof PublishClientError) || !error.retryable) approvalIntent.current = null
      }
    } finally { if (isCurrent()) { approvalBusy.current = false; setApproving(processing) } }
  }

  const changedElsewhere = !!savedRevision && !!status?.saved_revision && status.saved_revision !== savedRevision
  const blocked = isDirty ? "저장하지 않은 변경이 있습니다. 저장을 마친 뒤 게시 확인을 요청해 주세요."
    : pendingUploads > 0 ? "그림을 올리는 중입니다. 업로드와 저장을 마친 뒤 게시 확인을 요청해 주세요."
      : !savedRevision ? "저장판 정보를 불러온 뒤 다시 시도해 주세요."
        : changedElsewhere && !requestIntent.current && !approvalIntent.current ? "문서가 다른 곳에서 바뀌었습니다. 문서를 다시 열어 주세요." : null
  const close = () => { const query = new URLSearchParams(window.location.search); query.delete("publishReview"); query.delete("publishRevision"); onNavigate(`/docs?${query}`) }
  const currentPreview = status && !statusError && preview?.review_id === reviewId && preview.revision_id === status.revision_id && (!status.review_id || status.review_id === reviewId)
    ? { ...preview, can_approve: preview.can_approve && status.can_approve && canEdit } : null
  const currentReceipt = !statusError && !status?.changed_after_approval && approvedReceipt?.revision_id === status?.revision_id ? approvedReceipt : null
  const notice = !enabled ? null : registrationError ? <p role="status" className="text-xs text-amber-300">{publishErrorMessage(registrationError)}</p>
    : activeRegistration ? <div className="space-y-3"><PublishStatusNotice status={status} error={statusError} previousReceipt={lastReceipt} slug={slug} fetchFn={fetchFn} />
      {blocked && <p data-testid="publish-request-blocked" className="text-xs text-amber-300">{blocked}</p>}
      {requesting && <p role="status">게시 확인 요청을 처리하고 있습니다.</p>}
      {requestError && <div role="alert" className="space-y-2 text-sm text-amber-300"><p>{publishErrorMessage(requestError)}</p><PublishIssues issues={(requestError as { issues?: PublishIssue[] }).issues ?? []} />
        {(requestError as { retryable?: boolean }).retryable && <button type="button" data-testid="publish-request-retry" disabled={!!blocked || requesting} className="rounded border border-neutral-700 p-2 text-xs disabled:opacity-50" onClick={() => { void request() }}>같은 요청으로 다시 시도</button>}</div>}
      {requestResult && <p role="status" className="flex flex-wrap items-center gap-2 text-sm text-emerald-300">게시 확인을 요청했습니다.<a data-testid="publish-open-review" href={publishReviewHref(requestResult)} className="underline" onClick={(event) => { event.preventDefault(); onNavigate(publishReviewHref(requestResult)) }}>확인 화면 열기</a></p>}
    </div> : null
  return {
    actions: activeRegistration?.can_request_review && canEdit ? <PublishRequestAction blocked={blocked} busy={requesting || approving} onRequest={() => { void request() }} /> : null,
    notice,
    review: enabled && reviewId ? <PublishReview preview={slug ? currentPreview : null} loading={previewLoading} error={previewError || statusError || registrationError} view={previewView} onChangeView={setPreviewView}
      onReload={() => { setPreviewReload((value) => value + 1); void watcher.current?.refresh() }} onClose={close} onApprove={() => { void approve() }} approving={approving}
      blocked={!!blocked} receipt={currentReceipt} approvalError={approvalError} canRetryApproval={canRetryApproval} fetchFn={fetchFn} /> : null,
  }
}
