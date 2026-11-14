import React from "react"
import Link from "next/link"
import { searchResultHref } from "../docs/tabs"
import { parseDecisionSection, plainDecisionText, type DecisionConfig, type DecisionRow } from "./decisions"

function Rows({ rows, href }: { rows: DecisionRow[]; href: string }) {
  if (!rows.length) return <p className="py-3 text-sm text-neutral-400">항목이 없습니다.</p>
  return <ul className="space-y-2">{rows.map((row, index) => <li key={`${row.number}-${index}`}>
    <Link href={href} className="block rounded-lg border border-neutral-700 bg-neutral-900 p-3 text-sm hover:border-blue-500">
      <span className="text-neutral-400">{plainDecisionText(row.number)} </span>{plainDecisionText(row.title)}
    </Link>
  </li>)}</ul>
}

export function DecisionList({ markdown, config }: { markdown: string; config: DecisionConfig }) {
  const pending = parseDecisionSection(markdown, config.pendingHeading)
  const done = parseDecisionSection(markdown, config.doneHeading)
  const href = searchResultHref(config.source, config.path)
  return <div data-testid="decision-list">
    <p className="mb-6 text-sm text-neutral-400">항목을 누르면 원본 문서를 엽니다.</p>
    <section><h2 className="mb-3 text-lg font-semibold">지금 정할 것 {pending.length}</h2><Rows rows={pending} href={href} /></section>
    <details className="mt-8 rounded-lg border border-neutral-800 p-4"><summary className="cursor-pointer font-semibold">끝난 결정 {done.length}개 보기</summary><div className="mt-4"><Rows rows={done} href={href} /></div></details>
  </div>
}
