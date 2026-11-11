"use client"

import React, { useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { getPublishApprovedRevision, isPublishIdentityError, publishErrorMessage, type PublishApprovedRevision, type PublishIssue, type PublishPreviewResponse, type PublishReceipt, type PublishStatus } from "./publish-client"

const buttonClass = "rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"

export function PublishIssues({ issues }: { issues: PublishIssue[] }) {
  return issues.length ? <ul data-testid="publish-issues" className="space-y-1 break-words text-sm text-amber-300">
    {issues.map((issue, index) => <li key={index}>{[issue.image_index === undefined ? null : `그림 ${issue.image_index}`, issue.message].filter(Boolean).join(" · ")}</li>)}
  </ul> : null
}

export function PublishReceiptView({ receipt, slug, fetchFn }: { receipt: PublishReceipt; slug?: string; fetchFn?: typeof fetch }) {
  const [approved, setApproved] = useState<PublishApprovedRevision | null>(null)
  const [error, setError] = useState<unknown>(null), [loading, setLoading] = useState(false), [view, setView] = useState("")
  const revisionSlug = slug ?? (typeof receipt.slug === "string" ? receipt.slug : undefined)
  const open = async () => {
    if (!revisionSlug || loading) return
    setLoading(true); setError(null); setApproved(null)
    try {
      const result = await getPublishApprovedRevision(revisionSlug, receipt.revision_id, fetchFn)
      if (result.receipt.receipt_id !== receipt.receipt_id || result.revision_id !== receipt.revision_id || result.slug !== revisionSlug) throw new Error("승인판 불일치")
      setApproved(result)
    } catch (error) { setError(error) } finally { setLoading(false) }
  }
  return <details data-testid="publish-receipt" data-revision-id={receipt.revision_id} data-receipt-id={receipt.receipt_id} className="max-w-full break-all text-xs text-neutral-400">
    <summary className="cursor-pointer">승인판·영수증 보기</summary>
    <dl className="mt-2 space-y-1"><dt>승인판</dt><dd>저장된 판</dd><dt>승인 시각</dt><dd>{receipt.approved_at}</dd></dl>
    {revisionSlug && <button type="button" data-testid="publish-open-approved-revision" className={buttonClass} disabled={loading} onClick={() => { void open() }}>{loading ? "승인판을 불러오는 중…" : "승인판 내용 읽기"}</button>}
    {error && <p role="alert" className="mt-2 text-amber-300">{publishErrorMessage(error)}</p>}
    {approved && <section data-testid="publish-approved-revision" aria-label="보관한 승인판" className="mt-3 min-w-0 space-y-3 rounded border border-neutral-700 p-3 text-neutral-200">
      <p>보관한 승인판</p><p>승인 시각: {approved.receipt.approved_at}</p>
      <PublishPreviewDetails preview={approved} view={view} onChangeView={setView} />
    </section>}
  </details>
}

export function PublishStatusNotice({ status, error, previousReceipt, slug, fetchFn }: { status: PublishStatus | null; error?: unknown; previousReceipt?: PublishReceipt | null; slug?: string; fetchFn?: typeof fetch }) {
  const receipt = isPublishIdentityError(error) ? null : status?.receipt ?? previousReceipt
  return <div data-testid="publish-status" role="status" className="min-w-0 space-y-2 break-words text-sm text-neutral-300">
    {error ? <><p className="text-amber-300">현재 판 일치 여부를 확인하지 못했습니다.</p><p className="text-xs text-neutral-400">{publishErrorMessage(error)}</p></>
      : !status ? <p>게시 상태 확인 중…</p>
      : status.changed_after_approval || status.state === "changed_after_approval" ? <p className="text-amber-300">승인한 판과 현재 원고가 다릅니다. 새 게시 확인이 필요합니다.</p>
      : status.state === "approved_waiting_export" ? <p data-testid="publish-approved-matches" className="text-emerald-300">승인 완료·내보내기 대기 · 현재 저장판과 일치합니다.</p>
      : status.state === "pending_review" ? <p>게시 확인 대기 · 요청판과 현재 저장판이 일치합니다.</p>
      : <p>저장된 원고의 게시 확인을 요청할 수 있습니다.</p>}
    {status?.draft_error && <><p className="text-amber-300">{status.draft_error.message}</p><PublishIssues issues={status.draft_error.issues} /></>}
    {receipt && <PublishReceiptView key={receipt.receipt_id} receipt={receipt} slug={slug} fetchFn={fetchFn} />}
  </div>
}

export function PublishRequestAction({ blocked, busy, onRequest }: { blocked?: string | null; busy?: boolean; onRequest: () => void }) {
  return <button type="button" data-testid="publish-request-review" className={buttonClass} disabled={!!blocked || busy} title={blocked ?? undefined} onClick={onRequest}>
    {busy ? "게시 확인 요청 중…" : "게시 확인 요청"}
  </button>
}

export function publishAssetUrl(preview: PublishPreviewResponse, path: string): string | undefined {
  let decoded: string
  try { decoded = decodeURIComponent(path) } catch { return undefined }
  const asset = preview.assets.find((asset) => asset.path === decoded)
  const prefix = `/api/portal/publish/${encodeURIComponent(preview.slug)}/revisions/${encodeURIComponent(preview.revision_id)}/assets/`
  return asset && asset.url === `${prefix}${asset.sha256}` ? asset.url : undefined
}

function PreviewBody({ preview, body }: { preview: PublishPreviewResponse; body: string }) {
  return <div data-testid="publish-preview-body" className="prose prose-invert max-w-none break-words [&_img]:max-w-full [&_table]:block [&_table]:overflow-x-auto [&_pre]:overflow-x-auto">
    <ReactMarkdown remarkPlugins={[[remarkGfm, { singleTilde: false }]]} rehypePlugins={[rehypePublishImages]} components={{
      img: ({ src, alt }) => {
        const url = typeof src === "string" ? publishAssetUrl(preview, src) : undefined
        return url ? <img src={url} alt={alt ?? ""} /> : <span className="text-amber-300">고정된 그림을 확인하지 못했습니다: {alt}</span>
      },
      a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    }}>{body}</ReactMarkdown>
  </div>
}

// 서버가 검사한 원시 그림 태그도 고정 그림 처리기로 보낸다. HTML의 다른 속성은 실행하지 않는다.
function rehypePublishImages() {
  interface Node { type: string; value?: string; tagName?: string; properties?: Record<string, string>; children?: Node[] }
  return (tree: Node) => {
    const visit = (parent: Node) => {
      parent.children = parent.children?.flatMap((node) => {
        if (node.type !== "raw") { if (node.children) visit(node); return [node] }
        const raw = node.value ?? "", output: Node[] = []
        let offset = 0
        for (const match of raw.matchAll(/<!--(?:>|->|[\s\S]*?(?:--!?>|$))|<(?:(?:"[^"]*"|'[^']*'|[^<'">])*)>/g)) {
          if (!/^<img(?=[\s/>])/i.test(match[0])) continue
          const attribute = (name: string) => new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(match[0])?.slice(1).find((value) => value !== undefined)
          const src = attribute("src")
          if (!src) continue
          if (match.index! > offset) output.push({ type: "raw", value: raw.slice(offset, match.index) })
          output.push({ type: "element", tagName: "img", properties: { src, alt: attribute("alt") ?? "" }, children: [] })
          offset = match.index! + match[0].length
        }
        if (!offset) return [node]
        if (offset < raw.length) output.push({ type: "raw", value: raw.slice(offset) })
        return output
      })
    }
    visit(tree)
  }
}

function PublishPreviewDetails({ preview, view, onChangeView }: { preview: PublishPreviewResponse; view: string; onChangeView: (view: string) => void }) {
  const entries = Object.entries(preview.previews).flatMap(([site, languages]) => Object.entries(languages).map(([language, display]) => ({ key: `${site}:${language}`, site, language, display })))
  const selected = entries.find((entry) => entry.key === view) ?? entries[0]
  const sourceView = view === "source"
  return <>
      <div role="tablist" aria-label="게시 미리보기 선택" className="flex flex-wrap gap-2">
        {entries.map((entry) => <button key={entry.key} type="button" role="tab" aria-selected={!sourceView && selected?.key === entry.key} className={buttonClass} onClick={() => onChangeView(entry.key)}>{entry.site} · {entry.language}</button>)}
        <button type="button" role="tab" aria-selected={sourceView} className={buttonClass} onClick={() => onChangeView("source")}>원고 보기</button>
      </div>
      {sourceView ? <div data-testid="publish-source-preview" className="space-y-3"><p className="text-xs text-neutral-400">서버가 확인한 게시 원고입니다.</p><PreviewBody preview={preview} body={entries[0]?.display.body ?? ""} /></div>
        : selected && <article data-testid="publish-site-preview" className="min-w-0 space-y-3">
          <h3 className="break-words text-xl font-semibold">{selected.display.title}</h3>
          <p className="break-words text-neutral-300">{selected.display.summary}</p>
          {selected.display.hero && <figure><figcaption className="text-xs text-neutral-400">대표 그림</figcaption>{publishAssetUrl(preview, selected.display.hero)
            ? <img data-testid="publish-hero" className="max-h-96 max-w-full" src={publishAssetUrl(preview, selected.display.hero)} alt="대표 그림" />
            : <p className="text-amber-300">고정된 대표 그림을 확인하지 못했습니다.</p>}</figure>}
          <dl className="space-y-1 break-words text-xs text-neutral-400"><dt>대상 사이트</dt><dd>{selected.display.targets.join(", ")}</dd><dt>언어</dt><dd>{Object.entries(selected.display.languages).map(([site, languages]) => `${site}: ${languages.join(", ")}`).join(" · ")}</dd><dt>공개 시각</dt><dd>{selected.display.date}</dd></dl>
          <PreviewBody preview={preview} body={selected.display.body} />
        </article>}
      <div data-testid="publish-media-map" className="space-y-2"><h3 className="text-sm font-medium">언어별 미디어 준비 상태</h3>{Object.entries(preview.media_map).map(([language, value]) => {
        const media = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
        const hasValue = (candidate: unknown) => candidate !== undefined && candidate !== null && candidate !== false && candidate !== "" && (!Array.isArray(candidate) || candidate.length > 0)
        const hasHero = hasValue(media.hero) || hasValue(media.cover) || hasValue(media.image)
        const hasVideo = hasValue(media.shorts_url)
        return <div key={language} className="rounded border border-neutral-800 p-2 text-xs"><p>{language}</p><ul className="mt-1 flex flex-wrap gap-x-3 text-neutral-300"><li>{media.ready === true ? "준비됨" : "준비 안 됨"}</li><li>대표 그림 {hasHero ? "있음" : "없음"}</li><li>영상 {hasVideo ? "있음" : "없음"}</li></ul></div>
      })}</div>
      <PublishIssues issues={preview.issues} />
  </>
}

export interface PublishReviewProps {
  preview: PublishPreviewResponse | null; loading?: boolean; error?: unknown; view: string
  onChangeView: (view: string) => void; onReload: () => void; onClose: () => void; onApprove: () => void
  approving?: boolean; blocked?: boolean; receipt?: PublishReceipt | null; approvalError?: unknown; canRetryApproval?: boolean; fetchFn?: typeof fetch
}

export function PublishReview({ preview, loading, error, view, onChangeView, onReload, onClose, onApprove, approving, blocked, receipt, approvalError, canRetryApproval, fetchFn }: PublishReviewProps) {
  const canApprove = preview?.can_approve === true && !receipt
  return <section data-testid="publish-review" aria-label="게시 확인" className="min-w-0 max-w-full space-y-5 rounded-lg border border-neutral-800 p-3 sm:p-5">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold text-neutral-100">게시 확인 · 서버에 저장된 한글본</h2><button className={buttonClass} onClick={onClose}>문서로 돌아가기</button></div>
    <p className="text-xs text-neutral-400">게시 확인을 마치면 승인판을 고정하고 ‘승인 완료·내보내기 대기’로 표시합니다.</p>
    {loading && <p role="status">저장된 요청판을 불러오는 중…</p>}
    {error && <div role="alert" className="space-y-2 text-amber-300"><p>{publishErrorMessage(error)}</p><PublishIssues issues={(error as { issues?: PublishIssue[] }).issues ?? []} /><button className={buttonClass} onClick={onReload}>다시 확인</button></div>}
    {preview && <>
      <div data-testid="publish-preview-match" data-revision-id={preview.revision_id} className="space-y-1 text-xs text-neutral-400"><p>요청한 판과 현재 저장된 판이 일치합니다.</p><p>요청한 판 · 최신</p></div>
      <PublishPreviewDetails preview={preview} view={view} onChangeView={onChangeView} />
      {canApprove && <button type="button" data-testid="publish-approve" className={buttonClass} onClick={onApprove} disabled={loading || !!error || !!approvalError || approving || blocked || preview.issues.length > 0}>{approving ? "게시 확인 처리 중…" : "게시 확인"}</button>}
      {!preview.can_approve && <p className="text-xs text-neutral-400">게시 승인은 서버가 확인한 승인 담당 계정으로 진행해 주세요. 계정 연결 확인 전에는 승인할 수 없습니다.</p>}
    </>}
    {approvalError && <div role="alert" className="space-y-2 text-amber-300"><p>{publishErrorMessage(approvalError)}</p><PublishIssues issues={(approvalError as { issues?: PublishIssue[] }).issues ?? []} />{canRetryApproval && (approvalError as { retryable?: boolean }).retryable && <button data-testid="publish-approve-retry" className={buttonClass} onClick={onApprove} disabled={approving || blocked}>{approving ? "처리 중…" : "같은 요청으로 다시 시도"}</button>}</div>}
    {receipt && <div role="status" className="space-y-2"><p className="text-emerald-300">승인 완료·내보내기 대기</p><PublishReceiptView key={receipt.receipt_id} receipt={receipt} slug={preview?.slug} fetchFn={fetchFn} /></div>}
  </section>
}
