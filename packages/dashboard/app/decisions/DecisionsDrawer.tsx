"use client"

import React, { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { X } from "lucide-react"
import {
  decisionHref,
  fetchDecisions,
  resolveDecisionItem,
  type DecisionAction,
  type DecisionItem,
  type DecisionKind,
  type DecisionsSnapshot,
} from "./decisions-client"
import { useT } from "../i18n/provider.tsx"

export type DecisionTabFilter = "" | DecisionKind

const TABS: { id: DecisionTabFilter; labelKey: "dec.tabAll" | "dec.tabApprovals" | "dec.tabNotes" | "dec.tabWork" }[] = [
  { id: "", labelKey: "dec.tabAll" },
  { id: "approval", labelKey: "dec.tabApprovals" },
  { id: "note", labelKey: "dec.tabNotes" },
  { id: "work", labelKey: "dec.tabWork" },
]

export function kindBadgeClass(kind: DecisionKind): string {
  switch (kind) {
    case "approval":
      return "border-amber-700/70 bg-amber-950/60 text-amber-300"
    case "note":
      return "border-blue-800/70 bg-blue-950/60 text-blue-300"
    case "work":
      return "border-violet-700/70 bg-violet-950/60 text-violet-300"
    default:
      return "border-neutral-700 bg-neutral-900 text-neutral-300"
  }
}

export interface DecisionsDrawerProps {
  open: boolean
  onClose: () => void
  onChanged?: () => void
  initialSnapshot?: DecisionsSnapshot | null
}

function DecisionRow({
  item,
  busy,
  onResolve,
}: {
  item: DecisionItem
  busy: boolean
  onResolve: (id: string, action: DecisionAction) => void
}) {
  const t = useT()
  const href = decisionHref(item)
  return (
    <div
      data-testid={`decision-row-${item.id}`}
      className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-3 space-y-1.5"
    >
      <div className="flex items-center gap-1.5">
        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${kindBadgeClass(item.kind)}`}>
          {item.kind === "approval" ? t("dec.tabApprovals") : item.kind === "note" ? t("dec.tabNotes") : item.kind === "work" ? t("dec.tabWork") : item.kind}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-white" title={item.title}>
          {item.title}
        </span>
      </div>
      {item.detail && <p className="text-xs text-neutral-400 line-clamp-2 break-words">{item.detail}</p>}
      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        {href && (
          <Link
            href={href}
            className="text-[11px] text-blue-400 underline hover:text-blue-300"
            onClick={(e) => e.stopPropagation()}
          >
            {item.kind === "work" ? t("dec.viewWork") : t("dec.openInDocs")}
          </Link>
        )}
        {item.actor && <span className="text-[11px] text-neutral-500">{item.actor}</span>}
        <span className="ml-auto flex items-center gap-1.5">
          {item.kind === "approval" ? (
            <>
              <button
                type="button"
                data-testid={`decision-approve-${item.id}`}
                disabled={busy}
                onClick={() => onResolve(item.id, "approve")}
                className="rounded bg-emerald-700 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
              >
                {t("dec.approve")}
              </button>
              <button
                type="button"
                data-testid={`decision-reject-${item.id}`}
                disabled={busy}
                onClick={() => onResolve(item.id, "reject")}
                className="rounded bg-rose-800 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-rose-700 disabled:opacity-50"
              >
                {t("dec.reject")}
              </button>
            </>
          ) : (
            <button
              type="button"
              data-testid={`decision-ack-${item.id}`}
              disabled={busy}
              onClick={() => onResolve(item.id, "acknowledge")}
              className="rounded bg-neutral-700 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-neutral-600 disabled:opacity-50"
            >
              {t("dec.acknowledge")}
            </button>
          )}
        </span>
      </div>
    </div>
  )
}

export function DecisionsDrawer({ open, onClose, onChanged, initialSnapshot }: DecisionsDrawerProps) {
  const t = useT()
  const [tab, setTab] = useState<DecisionTabFilter>("")
  const [snapshot, setSnapshot] = useState<DecisionsSnapshot | null>(initialSnapshot ?? null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    const res = await fetchDecisions()
    setLoading(false)
    if (res.ok) {
      setSnapshot(res.snapshot)
    } else {
      setError(t("dec.errLoadGeneric"))
    }
  }, [t])

  useEffect(() => {
    if (open && !initialSnapshot) {
      void refresh()
    }
  }, [open, initialSnapshot, refresh])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open, onClose])

  const handleResolve = useCallback(
    async (id: string, action: DecisionAction) => {
      setBusyId(id)
      const res = await resolveDecisionItem(id, action)
      setBusyId(null)
      if (res.ok) {
        await refresh()
        onChanged?.()
      } else {
        setError(t("dec.resolveFailed"))
      }
    },
    [refresh, onChanged, t],
  )

  const items = useMemo(() => {
    const pending = snapshot?.pending ?? []
    return tab ? pending.filter((i) => i.kind === tab) : pending
  }, [snapshot, tab])
  const counts = useMemo(() => {
    const pending = snapshot?.pending ?? []
    return {
      all: pending.length,
      approval: pending.filter((i) => i.kind === "approval").length,
      note: pending.filter((i) => i.kind === "note").length,
      work: pending.filter((i) => i.kind === "work").length,
    }
  }, [snapshot])

  if (!open) return null

  return (
    <div data-testid="decisions-drawer" role="dialog" aria-label={t("dec.title")} className="fixed inset-y-0 right-0 z-50 flex w-full max-w-sm flex-col border-l border-neutral-800 bg-neutral-950 shadow-2xl">
      <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
        <h2 className="text-sm font-semibold text-white">
          {t("dec.pendingTab")} ({snapshot?.counts.total ?? 0})
        </h2>
        <button
          type="button"
          data-testid="decisions-drawer-close"
          onClick={onClose}
          aria-label={t("common.close")}
          className="rounded p-1 text-neutral-400 hover:bg-neutral-900 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div role="tablist" aria-label={t("dec.pendingTab")} className="grid grid-cols-4 gap-1 border-b border-neutral-800 p-2">
        {TABS.map(({ id, labelKey }) => {
          const selected = tab === id
          const count = id === "" ? counts.all : counts[id]
          return (
            <button
              key={id || "all"}
              type="button"
              role="tab"
              aria-selected={selected}
              data-testid={`decisions-tab-${id || "all"}`}
              onClick={() => setTab(id)}
              className={`rounded px-1 py-1.5 text-xs transition-colors ${
                selected ? "bg-neutral-700 font-semibold text-white" : "text-neutral-400 hover:text-white"
              }`}
            >
              {t(labelKey)} ({count})
            </button>
          )
        })}
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {loading && <p className="py-6 text-center text-xs text-neutral-500">{t("dec.loading")}</p>}
        {error && (
          <div className="rounded bg-red-950/40 border border-red-900/60 p-2.5 text-xs text-red-300" role="alert">
            {error}
          </div>
        )}
        {!loading && !error && items.length === 0 && (
          <p className="py-6 text-center text-xs text-neutral-500">{t("dec.empty")}</p>
        )}
        {items.map((item) => (
          <DecisionRow key={item.id} item={item} busy={busyId === item.id} onResolve={handleResolve} />
        ))}
      </div>

      <div className="border-t border-neutral-800 p-3">
        <Link
          href="/decisions"
          onClick={onClose}
          className="block rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-center text-xs font-medium text-neutral-200 hover:bg-neutral-800 hover:text-white"
        >
          {t("dec.openFullPage")}
        </Link>
      </div>
    </div>
  )
}
