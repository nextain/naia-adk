"use client"

import React, { useEffect, useState } from "react"
import { ExternalLink, X } from "lucide-react"
import { DocMarkdown } from "./MessageMarkdown"
import { docHref, inferTab } from "../docs/tabs"
import { MSG, resolveDocLink } from "./messenger"

type DocState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; source: string; path: string; content: string }

// 글 속 /d/<키> 문서를 오른쪽 나뉜 창에서 기존 문서 보기(DocMarkdown)로 보여 준다.
export function DocPreview({
  docKey,
  onClose,
  fetchFn,
  initial,
}: {
  docKey: string
  onClose: () => void
  fetchFn?: typeof fetch
  initial?: DocState
}) {
  const [state, setState] = useState<DocState>(initial ?? { kind: "loading" })
  useEffect(() => {
    if (initial) return
    let alive = true
    setState({ kind: "loading" })
    resolveDocLink(docKey, fetchFn ?? fetch)
      .then((d) => alive && setState({ kind: "ready", ...d }))
      .catch(() => alive && setState({ kind: "error" }))
    return () => {
      alive = false
    }
  }, [docKey, fetchFn, initial])

  const tab = state.kind === "ready" ? inferTab(state.source, state.path) : "common"
  const title = state.kind === "ready" ? state.path.split("/").pop() : docKey
  return (
    <section data-testid="doc-preview" aria-label={MSG.docPreview} className="flex h-full min-h-0 flex-col bg-neutral-950">
      <header className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs text-neutral-500">{MSG.docPreview}</div>
          <div className="truncate text-sm font-semibold text-neutral-100" title={state.kind === "ready" ? state.path : docKey}>
            {title}
          </div>
        </div>
        {state.kind === "ready" && (
          <a
            href={docHref(tab, state.source, state.path)}
            data-testid="doc-preview-open"
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-neutral-300 hover:text-white hover:bg-neutral-900"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            <span className="max-sm:hidden">{MSG.openDoc}</span>
          </a>
        )}
        <button type="button" data-testid="doc-preview-close" aria-label={MSG.closePanel} onClick={onClose} className="p-1.5 rounded-md text-neutral-400 hover:text-white hover:bg-neutral-900">
          <X className="w-4 h-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {state.kind === "loading" && <p className="text-sm text-neutral-400">{MSG.docLoading}</p>}
        {state.kind === "error" && <p className="text-sm text-red-300">{MSG.docFailed}</p>}
        {state.kind === "ready" && <DocMarkdown content={state.content} sourceId={state.source} path={state.path} activeTab={tab} />}
      </div>
    </section>
  )
}
