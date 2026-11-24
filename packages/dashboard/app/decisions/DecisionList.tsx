"use client"

import React from "react"
import Link from "next/link"
import { searchResultHref } from "../docs/tabs.ts"
import { parseDecisionSection, plainDecisionText, type DecisionConfig, type DecisionRow } from "./decisions.ts"
import { formatMessage, tFor } from "../i18n/index.ts"
import { getActiveLocale } from "../i18n/provider.tsx"
import type { Locale } from "../i18n/types.ts"

function Rows({ rows, href, emptyLabel }: { rows: DecisionRow[]; href: string; emptyLabel: string }) {
  if (!rows.length) return <p className="py-3 text-sm text-neutral-400">{emptyLabel}</p>
  return <ul className="space-y-2">{rows.map((row, index) => <li key={`${row.number}-${index}`}>
    <Link href={href} className="block rounded-lg border border-neutral-700 bg-neutral-900 p-3 text-sm hover:border-blue-500">
      <span className="text-neutral-400">{plainDecisionText(row.number)} </span>{plainDecisionText(row.title)}
    </Link>
  </li>)}</ul>
}

export function DecisionList({ markdown, config, locale: localeProp }: { markdown: string; config: DecisionConfig; locale?: Locale }) {
  const locale = localeProp ?? getActiveLocale()
  const t = tFor(locale)
  const pending = parseDecisionSection(markdown, config.pendingHeading)
  const done = parseDecisionSection(markdown, config.doneHeading)
  const href = searchResultHref(config.source, config.path)
  return <div data-testid="decision-list">
    <p className="mb-6 text-sm text-neutral-400">{t("dec.openDoc")}</p>
    <section><h2 className="mb-3 text-lg font-semibold">{formatMessage(t("dec.pending"), { count: pending.length })}</h2><Rows rows={pending} href={href} emptyLabel={t("dec.empty")} /></section>
    <details className="mt-8 rounded-lg border border-neutral-800 p-4"><summary className="cursor-pointer font-semibold">{formatMessage(t("dec.done"), { count: done.length })}</summary><div className="mt-4"><Rows rows={done} href={href} emptyLabel={t("dec.empty")} /></div></details>
  </div>
}
