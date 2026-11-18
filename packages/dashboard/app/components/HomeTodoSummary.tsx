"use client"

import React, { useEffect, useState } from "react"
import Link from "next/link"
import { AlertTriangle, ArrowRight, ExternalLink, FileText } from "lucide-react"
import {
  LEDGER_STATUS_LABEL,
  formatDueLabel,
  isSafeHttpUrl,
  sortLedgerCards,
  summarizeRoles,
  type LedgerPayload,
} from "../work/work-ledger-view"
import { statusBadgeClass } from "../work/WorkBoard"

export function HomeTodoSummary({
  initialLedger,
  nowMs,
}: {
  initialLedger?: LedgerPayload | null
  nowMs?: number
}) {
  const [ledger, setLedger] = useState<LedgerPayload | null>(initialLedger ?? null)

  useEffect(() => {
    if (initialLedger !== undefined) return
    let active = true
    fetch("/api/portal/ledger?status=todo", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: LedgerPayload | null) => {
        if (active) setLedger(data)
      })
      .catch(() => {
        if (active) setLedger(null)
      })
    return () => {
      active = false
    }
  }, [initialLedger])

  if (!ledger || !ledger.configured) return null

  const todoItems = sortLedgerCards(ledger.items.filter((i) => i.isTodo)).slice(0, 8)
  const roleBuckets = summarizeRoles(ledger.items, ledger.roles)

  return (
    <section
      data-testid="home-todo-summary"
      aria-label="업무 장부 할 일 요약"
      className="rounded-lg border border-neutral-800 bg-neutral-950 p-5 space-y-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">할 일 요약</h2>
          <p className="text-xs text-neutral-400 mt-0.5">
            업무 장부의 진행 중·사람 확인 대기 항목입니다. 기한이 넘은 일부터 보여 줍니다.
          </p>
        </div>
        <Link
          href="/work"
          data-testid="home-todo-more"
          className="inline-flex items-center gap-1 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs font-medium text-neutral-200 hover:border-neutral-600 transition-colors"
        >
          작업 보드 전체 보기
          <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-3">
          <div data-testid="home-todo-count" className="text-2xl font-bold text-white">
            {ledger.summary.todoCount}
          </div>
          <div className="text-xs text-neutral-400 mt-1">할 일 (열림+대기)</div>
        </div>
        <div className="rounded-lg border border-rose-900/60 bg-rose-950/20 p-3">
          <div data-testid="home-overdue-count" className="text-2xl font-bold text-rose-300">
            {ledger.summary.overdue}
          </div>
          <div className="text-xs text-rose-300 mt-1">기한 넘음</div>
        </div>
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-3">
          <div className="text-2xl font-bold text-blue-300">{ledger.summary.open}</div>
          <div className="text-xs text-neutral-400 mt-1">진행 중</div>
        </div>
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-3">
          <div className="text-2xl font-bold text-amber-300">{ledger.summary.waiting_human}</div>
          <div className="text-xs text-neutral-400 mt-1">사람 확인 대기</div>
        </div>
      </div>

      {roleBuckets.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {roleBuckets.map((rb) => (
            <Link
              key={rb.role}
              href={`/work?role=${encodeURIComponent(rb.role)}`}
              className="inline-flex items-center gap-1 rounded-full border border-neutral-800 bg-neutral-900 px-2.5 py-1 text-xs text-neutral-200 hover:border-neutral-600 transition-colors"
            >
              <span className="font-semibold">{rb.role}</span>
              <span className="text-neutral-400">{rb.todoCount}</span>
              {rb.overdueCount > 0 && (
                <span className="text-rose-300">· 넘음 {rb.overdueCount}</span>
              )}
            </Link>
          ))}
        </div>
      )}

      {todoItems.length === 0 ? (
        <p className="text-xs text-neutral-500 py-2">열려 있는 할 일이 없습니다.</p>
      ) : (
        <ul className="space-y-2">
          {todoItems.map((item) => {
            const firstDoc = item.resultLinks.find((l) => l.href)
            return (
              <li
                key={`${item.role}:${item.id}`}
                data-testid={`home-todo-item-${item.id}`}
                className={`flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-lg border p-3 text-xs ${
                  item.overdue
                    ? "border-rose-700/70 bg-rose-950/15"
                    : "border-neutral-800 bg-neutral-900/40"
                }`}
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="rounded-full border border-neutral-700 bg-neutral-800 px-2 py-0.5 text-[11px] font-semibold text-neutral-100">
                      {item.role}
                    </span>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusBadgeClass(item.status)}`}
                    >
                      {LEDGER_STATUS_LABEL[item.status]}
                    </span>
                    {item.overdue && (
                      <span className="inline-flex items-center gap-0.5 rounded-full border border-rose-600/80 bg-rose-950/70 px-2 py-0.5 text-[11px] font-semibold text-rose-300">
                        <AlertTriangle className="w-3 h-3" />
                        기한 넘음
                      </span>
                    )}
                    <span className={`font-mono ${item.overdue ? "text-rose-300 font-semibold" : "text-neutral-400"}`}>
                      {formatDueLabel(item.due, item.overdue, nowMs)}
                    </span>
                  </div>
                  <div className="text-sm font-medium text-white truncate">{item.title}</div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {isSafeHttpUrl(item.sourceUrl) && (
                    <a
                      href={item.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded border border-blue-800/70 bg-blue-950/40 px-2 py-1 text-[11px] text-blue-300 hover:bg-blue-900/50"
                    >
                      <ExternalLink className="w-3 h-3" />
                      원글
                    </a>
                  )}
                  {firstDoc && firstDoc.href && (
                    firstDoc.kind === "doc" ? (
                      <Link
                        href={firstDoc.href}
                        className="inline-flex items-center gap-1 rounded border border-emerald-800/70 bg-emerald-950/40 px-2 py-1 text-[11px] text-emerald-300 hover:bg-emerald-900/50"
                      >
                        <FileText className="w-3 h-3" />
                        {firstDoc.label}
                      </Link>
                    ) : isSafeHttpUrl(firstDoc.href) ? (
                      <a
                        href={firstDoc.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded border border-emerald-800/70 bg-emerald-950/40 px-2 py-1 text-[11px] text-emerald-300 hover:bg-emerald-900/50"
                      >
                        <ExternalLink className="w-3 h-3" />
                        {firstDoc.label}
                      </a>
                    ) : null
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
