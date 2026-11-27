"use client"

import React, { useCallback, useEffect, useState } from "react"
import { PublishClientError, getPublishResults, publishErrorMessage, type PublishExportCell, type PublishExportRevision, type PublishResults } from "../docs/publish-client"

const stateLabels: Record<PublishExportCell["state"], string> = {
  queued: "저장 대기",
  sending: "저장 중",
  saved: "저장 완료 · 공개 예정",
  published: "공개",
  failed: "실패",
}
const stateClasses: Record<PublishExportCell["state"], string> = {
  queued: "border-neutral-700 bg-neutral-900 text-neutral-300",
  sending: "border-sky-900 bg-sky-950/50 text-sky-200",
  saved: "border-cyan-900 bg-cyan-950/40 text-cyan-200",
  published: "border-emerald-900 bg-emerald-950/40 text-emerald-200",
  failed: "border-rose-900 bg-rose-950/40 text-rose-200",
}

const failureMessages: Record<string, string> = {
  DESTINATION_UNAVAILABLE: "대상 사이트에 연결할 수 없습니다.",
  GATEWAY_UNAVAILABLE: "게시 게이트웨이가 응답하지 않습니다.",
  PAYLOAD_REJECTED: "승인 자료를 대상 사이트가 거절했습니다.",
  PUBLISH_FAILED: "대상 사이트 게시 처리에 실패했습니다.",
  STORAGE_FAILED: "대상 사이트에 저장하지 못했습니다.",
}

export function publishFailureReason(code?: string): string {
  if (!code) return "실패 이유 코드가 없습니다."
  return failureMessages[code] ? `${failureMessages[code]} (${code})` : `실패 코드: ${code}`
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ko-KR")
}

export function ExportRevision({ revision, canRetry }: {
  revision: PublishExportRevision
  canRetry: boolean
}) {
  return (
    <section data-testid="publish-results-revision" data-slug={revision.slug} className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-950/40 p-3 sm:p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold text-neutral-100">{revision.slug}</h2>
        <p className="text-xs text-neutral-500">승인 {formatUpdatedAt(revision.approved_at)}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] border-collapse text-left text-sm">
          <thead className="text-xs text-neutral-500">
            <tr>
              <th scope="col" className="whitespace-nowrap border-b border-neutral-800 px-2 py-2 font-medium">사이트</th>
              <th scope="col" className="whitespace-nowrap border-b border-neutral-800 px-2 py-2 font-medium">언어</th>
              <th scope="col" className="whitespace-nowrap border-b border-neutral-800 px-2 py-2 font-medium">상태</th>
              <th scope="col" className="whitespace-nowrap border-b border-neutral-800 px-2 py-2 font-medium">최근 변경</th>
              <th scope="col" className="whitespace-nowrap border-b border-neutral-800 px-2 py-2 font-medium">동작</th>
            </tr>
          </thead>
          <tbody>
            {revision.cells.map((cell) => {
              return (
                <tr key={`${cell.site}:${cell.language}`} data-testid="publish-results-cell" data-state={cell.state} className="align-top text-neutral-200">
                  <td className="whitespace-nowrap border-b border-neutral-900 px-2 py-3">{cell.site}</td>
                  <td className="whitespace-nowrap border-b border-neutral-900 px-2 py-3">{cell.language}</td>
                  <td className="border-b border-neutral-900 px-2 py-3">
                    <span data-testid="publish-results-status" className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-xs ${stateClasses[cell.state]}`}>{stateLabels[cell.state]}</span>
                    {cell.state === "failed" && <p data-testid="publish-results-failure" className="mt-1 max-w-sm text-xs text-rose-300">실패 이유: {publishFailureReason(cell.failure_code)}</p>}
                  </td>
                  <td className="border-b border-neutral-900 px-2 py-3 text-xs text-neutral-400">{formatUpdatedAt(cell.updated_at)}</td>
                  <td className="border-b border-neutral-900 px-2 py-3">
                    {cell.state === "failed" && canRetry && <div className="space-y-1">
                      <button type="button" data-testid="publish-results-retry" data-cell={`${cell.site}:${cell.language}`} disabled aria-describedby={`publish-retry-blocked-${cell.site}-${cell.language}`}
                        title="게이트웨이 재전송 경로가 연결되지 않았습니다."
                        className="cursor-not-allowed rounded border border-neutral-700 px-2.5 py-1 text-xs text-neutral-400 opacity-70">이 칸 다시 하기</button>
                      <p id={`publish-retry-blocked-${cell.site}-${cell.language}`} className="max-w-xs text-xs text-amber-300">게이트웨이 재전송 연결 전까지 사용할 수 없습니다.</p>
                    </div>}
                    {cell.state === "failed" && !canRetry && <span className="text-xs text-neutral-500">승인 담당자만 다시 할 수 있습니다.</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export function PublishResults() {
  const [results, setResults] = useState<PublishResults | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    setError(null)
    try {
      setResults(await getPublishResults())
    } catch (caught) {
      setError(caught)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const message = error instanceof PublishClientError && error.code === "publish_gateway_unconfirmed"
    ? "게시 결과 기능을 준비하고 있습니다."
    : error ? publishErrorMessage(error) : null

  return (
    <main data-testid="publish-results-page" className="mx-auto w-full max-w-6xl space-y-5 px-3 py-6 sm:px-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold text-white">게시 결과</h1>
          <p className="text-sm text-neutral-400">승인판의 사이트·언어별 저장과 공개 상태입니다.</p>
          <p className="text-xs text-neutral-500">저장 완료는 공개 예정 상태입니다. 실패 칸 다시 하기는 게이트웨이 연결 전까지 사용할 수 없습니다.</p>
        </div>
        <button type="button" data-testid="publish-results-refresh" onClick={() => { void load() }} disabled={loading}
          className="rounded border border-neutral-700 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-900 disabled:opacity-50">{loading ? "불러오는 중…" : "새로 고침"}</button>
      </header>
      {message && <p role="alert" data-testid="publish-results-error" className="rounded border border-amber-900/70 bg-amber-950/30 p-3 text-sm text-amber-200">{message}</p>}
      {loading && !results && <p role="status" className="text-sm text-neutral-400">게시 결과를 불러오는 중…</p>}
      {!loading && !results && !error && <p role="status" className="text-sm text-neutral-400">표시할 게시 결과가 없습니다.</p>}
      {results && results.revisions.length === 0 && <p role="status" className="text-sm text-neutral-400">표시할 게시 결과가 없습니다.</p>}
      {results && results.revisions.length > 0 && <div className="space-y-4">
        {results.revisions.map((revision) => <ExportRevision key={`${revision.slug}:${revision.revision_id}`} revision={revision} canRetry={results.can_retry} />)}
      </div>}
    </main>
  )
}
