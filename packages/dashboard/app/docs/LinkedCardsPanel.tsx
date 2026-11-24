"use client"

import React from "react"
import Link from "next/link"
import { AlertTriangle, Briefcase, ExternalLink } from "lucide-react"
import {
  formatDueLabel,
  isSafeHttpUrl,
  ledgerStatusLabel,
  type LedgerCardItem,
} from "../work/work-ledger-view"
import { statusBadgeClass } from "../work/WorkBoard"
import { useLocale, useT } from "../i18n/provider.tsx"

export function LinkedCardsPanel({
  cards,
  nowMs,
}: {
  cards: LedgerCardItem[]
  nowMs?: number
}) {
  const locale = useLocale()
  const t = useT()
  if (!cards || cards.length === 0) return null

  return (
    <section
      data-testid="doc-linked-cards"
      aria-label={t("docs.linkedCards")}
      className="rounded-lg border border-blue-900/60 bg-blue-950/20 p-4 space-y-3"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-white">
          <Briefcase className="w-4 h-4 text-blue-300 shrink-0" />
          <span>{t("docs.linkedCards")}</span>
          <span className="rounded-full bg-blue-900/60 px-2 py-0.5 text-xs text-blue-200">
            {cards.length}
          </span>
        </div>
        <Link
          href="/work"
          className="text-xs text-blue-300 hover:underline whitespace-nowrap"
        >
          {t("docs.openBoard")}
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
                {ledgerStatusLabel(card.status, locale)}
              </span>
              {card.overdue && (
                <span className="inline-flex items-center gap-0.5 rounded-full border border-rose-600/80 bg-rose-950/70 px-2 py-0.5 text-[11px] font-semibold text-rose-300">
                  <AlertTriangle className="w-3 h-3" />
                  {t("work.overdueBadge")}
                </span>
              )}
            </div>

            <div className="font-medium text-neutral-100 break-words">{card.title}</div>

            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-neutral-400">
              <span className="font-mono">{formatDueLabel(card.due, card.overdue, nowMs, "Asia/Seoul", locale)}</span>
              <div className="flex items-center gap-2">
                {isSafeHttpUrl(card.sourceUrl) && (
                  <a
                    href={card.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-blue-300 hover:underline"
                  >
                    <ExternalLink className="w-3 h-3" />
                    {t("home.sourcePost")}
                  </a>
                )}
                <Link
                  href={`/work?role=${encodeURIComponent(card.role)}`}
                  className="text-neutral-300 hover:text-white underline"
                >
                  {t("docs.roleCard")}
                </Link>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
