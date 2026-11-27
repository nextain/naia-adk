"use client"

import React, { Suspense, useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
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

type MainTab = "pending" | "history"
type Category = "" | DecisionKind

const CATEGORIES: { id: Category; labelKey: "dec.tabAll" | "dec.tabApprovals" | "dec.tabNotes" | "dec.tabWork" }[] = [
  { id: "", labelKey: "dec.tabAll" },
  { id: "approval", labelKey: "dec.tabApprovals" },
  { id: "note", labelKey: "dec.tabNotes" },
  { id: "work", labelKey: "dec.tabWork" },
]

function statusLabel(status: DecisionItem["status"], t: (key: any) => string): string {
  switch (status) {
    case "approved":
      return t("dec.approve")
    case "rejected":
      return t("dec.reject")
    case "acknowledged":
      return t("dec.acknowledge")
    case "resolved":
      return t("dec.resolved")
    case "expired":
      return status
    default:
      return t("dec.pendingTab")
  }
}

function statusBadgeClass(status: DecisionItem["status"]): string {
  switch (status) {
    case "approved":
    case "resolved":
    case "acknowledged":
      return "border-emerald-800/70 bg-emerald-950/60 text-emerald-300"
    case "rejected":
      return "border-rose-700/70 bg-rose-950/60 text-rose-300"
    default:
      return "border-amber-700/70 bg-amber-950/60 text-amber-300"
  }
}

function DecisionsRow({
  item,
  highlight,
  busy,
  onResolve,
}: {
  item: DecisionItem
  highlight: boolean
  busy: boolean
  onResolve: (id: string, action: DecisionAction) => void
}) {
  const t = useT()
  const href = decisionHref(item)
  return (
    <div
      data-testid={`decision-row-${item.id}`}
      data-highlight={highlight ? "true" : undefined}
      className={`rounded-lg border p-4 space-y-2 ${highlight ? "border-amber-500 bg-amber-950/20" : "border-neutral-800 bg-neutral-900/40"}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${statusBadgeClass(item.status)}`}>
          {statusLabel(item.status, t)}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-white" title={item.title}>
          {item.title}
        </span>
      </div>
      {item.detail && <p className="text-xs text-neutral-400 break-words whitespace-pre-wrap">{item.detail}</p>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-neutral-500">
        <span>{item.kind}</span>
        {item.actor && <span>{item.actor}</span>}
        {item.method && <span className="font-mono">{item.method}</span>}
        {item.updatedAt && <span>{new Date(item.updatedAt).toLocaleString()}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {href && (
          <Link href={href} className="text-xs text-blue-400 underline hover:text-blue-300">
            {item.kind === "work" ? t("dec.viewWork") : t("dec.openInDocs")}
          </Link>
        )}
        {item.status === "pending" && (
          <span className="ml-auto flex items-center gap-1.5">
            {item.kind === "approval" ? (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onResolve(item.id, "approve")}
                  className="rounded bg-emerald-700 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
                >
                  {t("dec.approve")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onResolve(item.id, "reject")}
                  className="rounded bg-rose-800 px-3 py-1 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-50"
                >
                  {t("dec.reject")}
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => onResolve(item.id, "acknowledge")}
                className="rounded bg-neutral-700 px-3 py-1 text-xs font-medium text-white hover:bg-neutral-600 disabled:opacity-50"
              >
                {t("dec.acknowledge")}
              </button>
            )}
          </span>
        )}
      </div>
    </div>
  )
}

function DecisionsInner() {
  const t = useT()
  const searchParams = useSearchParams()
  const focusItem = searchParams?.get("item") ?? null
  const [mainTab, setMainTab] = useState<MainTab>("pending")
  const [category, setCategory] = useState<Category>("")
  const [snapshot, setSnapshot] = useState<DecisionsSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    const res = await fetchDecisions()
    setLoading(false)
    if (res.ok) setSnapshot(res.snapshot)
    else setError(t("dec.errLoadGeneric"))
  }, [t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!focusItem || !snapshot) return
    setMainTab("pending")
    const el = document.querySelector(`[data-testid="decision-row-${CSS.escape(focusItem)}"]`)
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "center", behavior: "smooth" })
    }
  }, [focusItem, snapshot])

  const handleResolve = useCallback(
    async (id: string, action: DecisionAction) => {
      setBusyId(id)
      const res = await resolveDecisionItem(id, action)
      setBusyId(null)
      if (res.ok) await refresh()
      else setError(t("dec.resolveFailed"))
    },
    [refresh, t],
  )

  const list = useMemo(() => {
    const base = mainTab === "pending" ? (snapshot?.pending ?? []) : (snapshot?.history ?? [])
    const filtered = category ? base.filter((i) => i.kind === category) : base
    if (focusItem && mainTab === "pending") {
      return [...filtered].sort((a, b) => (a.id === focusItem ? -1 : b.id === focusItem ? 1 : 0))
    }
    return filtered
  }, [snapshot, mainTab, category, focusItem])

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 text-neutral-100">
      <h1 className="mb-1 text-2xl font-bold">{t("dec.title")}</h1>
      <p className="mb-4 text-xs text-neutral-500">{t("dec.openDoc")}</p>

      <div role="tablist" aria-label={t("dec.title")} className="mb-3 grid grid-cols-2 gap-1 rounded-lg border border-neutral-800 bg-neutral-900 p-1">
        {(
          [
            { id: "pending", label: t("dec.pendingTab"), count: snapshot?.counts.total ?? 0 },
            { id: "history", label: t("dec.historyTab"), count: snapshot?.history.length ?? 0 },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={mainTab === tab.id}
            data-testid={`decisions-main-tab-${tab.id}`}
            onClick={() => setMainTab(tab.id)}
            className={`rounded px-3 py-1.5 text-sm transition-colors ${
              mainTab === tab.id ? "bg-neutral-700 font-semibold text-white" : "text-neutral-400 hover:text-white"
            }`}
          >
            {tab.label} ({tab.count})
          </button>
        ))}
      </div>

      <div role="tablist" aria-label={t("dec.tabAll")} className="mb-4 flex flex-wrap gap-1.5">
        {CATEGORIES.map(({ id, labelKey }) => (
          <button
            key={id || "all"}
            type="button"
            role="tab"
            aria-selected={category === id}
            data-testid={`decisions-category-${id || "all"}`}
            onClick={() => setCategory(id)}
            className={`rounded-full border px-3 py-1 text-xs transition-colors ${
              category === id
                ? "border-blue-600 bg-blue-950/70 text-blue-200"
                : "border-neutral-800 bg-neutral-900 text-neutral-300 hover:border-neutral-700"
            }`}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>

      {loading && <p className="py-8 text-center text-sm text-neutral-500">{t("dec.loading")}</p>}
      {error && (
        <div role="alert" className="mb-4 rounded border border-red-900/60 bg-red-950/40 p-3 text-sm text-red-300">
          {error}{" "}
          <button type="button" className="underline" onClick={() => void refresh()}>
            {t("dec.retry")}
          </button>
        </div>
      )}
      {!loading && !error && list.length === 0 && (
        <p className="py-8 text-center text-sm text-neutral-500">{t("dec.empty")}</p>
      )}
      <div className="space-y-3">
        {list.map((item) => (
          <DecisionsRow
            key={item.id}
            item={item}
            highlight={focusItem === item.id}
            busy={busyId === item.id}
            onResolve={handleResolve}
          />
        ))}
      </div>
    </main>
  )
}

export default function DecisionsPage() {
  return (
    <Suspense fallback={<main className="mx-auto max-w-3xl px-4 py-8 text-neutral-100" />}>
      <DecisionsInner />
    </Suspense>
  )
}
