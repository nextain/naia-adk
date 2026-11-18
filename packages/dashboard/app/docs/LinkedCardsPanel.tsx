"use client"

import React from "react"
import Link from "next/link"
import { AlertTriangle, Briefcase, ExternalLink } from "lucide-react"
import {
  LEDGER_STATUS_LABEL,
  formatDueLabel,
  isSafeHttpUrl,
  type LedgerCardItem,
} from "../work/work-ledger-view"
import { statusBadgeClass } from "../work/WorkBoard"

export function LinkedCardsPanel({
  cards,
  nowMs,
}: {
  cards: LedgerCardItem[]
  nowMs?: number
}) {
  if (!cards || cards.length === 0) return null

  return (
    <section
      data-testid="doc-linked-cards"
      aria-label="연결된 업무 카드"
      className="rounded-lg border border-blue-900/60 bg-blue-950/20 p-4 space-y-3"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-white">
          <Briefcase className="w-4 h-4 text-blue-300 shrink-0" />
          <span>연결된 업무 카드</span>
          <span className="rounded-full bg-blue-900/60 px-2 py-0.5 text-xs text-blue-200">
            {cards.length}
          </span>
        </div>
        <Link
          href="/work"
          className="text-xs text-blue-300 hover:underline whitespace-nowrap"
        >
          작업 보드 →
        </Link>
      </div>

      <ul className="space-y-2.5">
        {cards.map((card) => (
          <li
            key={`${card.role}:${card.id}`}
            data-testid={`doc-linked-card-${card.id}`}
            className={`rounded-md border p-2.5 space-y-1.5 text-xs ${
              card.overdue
                ? "border-rose-700/80 bg-rose-950/25"
                : "border-neutral-800 bg-neutral-900/60"
            }`}
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="rounded-full border border-neutral-700 bg-neutral-800 px-2 py-0.5 text-[11px] font-semibold text-neutral-100">
                {card.role}
              </span>
              <span
                className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusBadgeClass(card.status)}`}
              >
                {LEDGER_STATUS_LABEL[card.status]}
              </span>
              {card.overdue && (
                <span className="inline-flex items-center gap-0.5 rounded-full border border-rose-600/80 bg-rose-950/70 px-2 py-0.5 text-[11px] font-semibold text-rose-300">
                  <AlertTriangle className="w-3 h-3" />
                  기한 넘음
                </span>
              )}
            </div>

            <div className="font-medium text-neutral-100 break-words">{card.title}</div>

            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-neutral-400">
              <span className="font-mono">{formatDueLabel(card.due, card.overdue, nowMs)}</span>
              <div className="flex items-center gap-2">
                {isSafeHttpUrl(card.sourceUrl) && (
                  <a
                    href={card.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-blue-300 hover:underline"
                  >
                    <ExternalLink className="w-3 h-3" />
                    원글
                  </a>
                )}
                <Link
                  href={`/work?role=${encodeURIComponent(card.role)}`}
                  className="text-neutral-300 hover:text-white underline"
                >
                  역할 카드
                </Link>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
