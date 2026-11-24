"use client"

import React, { useState } from "react"
import Link from "next/link"
import { CalendarPlus, X } from "lucide-react"
import { localDateOnly } from "../schedule/schedule-calendar"
import { getMessengerStrings, type Message } from "./messenger"
import { addToPersonalSchedule, draftScheduleFromMessage, scheduleWriteBody, type ScheduleDraft } from "./schedule-from-message"
import { tFor } from "../i18n/index.ts"
import { getActiveLocale } from "../i18n/provider.tsx"

export interface ScheduleAddPanelProps {
  message: Message
  onClose: () => void
  fetchFn?: typeof fetch
  /** 시험용 오늘 날짜(YYYY-MM-DD). */
  today?: string
}

type Status = { kind: "idle" } | { kind: "saving" } | { kind: "done"; href: string } | { kind: "error"; text: string }

// 오른쪽 나뉜 창: 글에서 뽑은 초안을 고쳐서 보는 사람 본인의 개인 일정에 넣는다.
export function ScheduleAddPanel({ message, onClose, fetchFn, today }: ScheduleAddPanelProps) {
  const locale = getActiveLocale()
  const S = getMessengerStrings(locale)
  const t = tFor(locale)
  const [draft, setDraft] = useState<ScheduleDraft>(() =>
    draftScheduleFromMessage(message, today ?? localDateOnly(new Date()) ?? "2000-01-01", locale),
  )
  const [status, setStatus] = useState<Status>({ kind: "idle" })
  const set = (patch: Partial<ScheduleDraft>) => setDraft((d) => ({ ...d, ...patch }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setStatus({ kind: "saving" })
    try {
      const result = await addToPersonalSchedule(scheduleWriteBody(draft, locale), fetchFn ?? fetch, locale)
      setStatus({ kind: "done", href: result.href })
    } catch (error) {
      setStatus({ kind: "error", text: error instanceof Error ? error.message : String(error) })
    }
  }

  const input = "w-full rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
  return (
    <section data-testid="schedule-add-panel" aria-label={S.addToSchedule} className="flex h-full min-h-0 flex-col bg-neutral-950">
      <header className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
        <CalendarPlus className="w-4 h-4 text-emerald-300" />
        <div className="min-w-0 flex-1 text-sm font-semibold text-neutral-100">{S.addToSchedule}</div>
        <button type="button" aria-label={S.closePanel} onClick={onClose} className="p-1.5 rounded-md text-neutral-400 hover:text-white hover:bg-neutral-900">
          <X className="w-4 h-4" />
        </button>
      </header>
      <form onSubmit={submit} className="min-h-0 flex-1 overflow-y-auto p-3 space-y-3 text-sm">
        <p className="text-xs text-neutral-500">{S.scheduleOwnOnly}</p>
        <label className="block space-y-1">
          <span className="text-xs text-neutral-400">{S.fieldTitle}</span>
          <input data-testid="schedule-add-title" className={input} value={draft.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} />
        </label>
        <div className="flex gap-2">
          <label className="block flex-1 space-y-1">
            <span className="text-xs text-neutral-400">{S.fieldDate}</span>
            <input data-testid="schedule-add-date" type="date" className={input} value={draft.date} onChange={(e) => set({ date: e.target.value })} />
          </label>
          <label className="block w-32 space-y-1">
            <span className="text-xs text-neutral-400">{S.fieldTime}</span>
            <input
              data-testid="schedule-add-time"
              type="time"
              className={input}
              value={draft.time ?? ""}
              disabled={draft.time === null}
              onChange={(e) => set({ time: e.target.value || null })}
            />
          </label>
        </div>
        <label className="flex items-center gap-2 text-neutral-300">
          <input
            data-testid="schedule-add-allday"
            type="checkbox"
            checked={draft.time === null}
            onChange={(e) => set({ time: e.target.checked ? null : "09:00" })}
          />
          {t("sched.allDay")}
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-neutral-400">{t("docs.memo")}</span>
          <textarea className={`${input} h-28`} value={draft.memo} maxLength={2000} onChange={(e) => set({ memo: e.target.value })} />
        </label>
        <div className="flex items-center gap-2">
          <button
            type="submit"
            data-testid="schedule-add-submit"
            disabled={status.kind === "saving" || status.kind === "done"}
            className="px-3 py-1.5 rounded-md bg-emerald-700 text-white hover:bg-emerald-600 disabled:opacity-50"
          >
            {status.kind === "saving" ? S.scheduleSaving : S.addToSchedule}
          </button>
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-md text-neutral-400 hover:text-white hover:bg-neutral-900">
            {S.cancel}
          </button>
        </div>
        {status.kind === "done" && (
          <p data-testid="schedule-add-done" className="text-emerald-300">
            {S.scheduleAdded}{" "}
            <Link href={status.href} className="underline underline-offset-2">
              {S.scheduleOpen}
            </Link>
          </p>
        )}
        {status.kind === "error" && (
          <p data-testid="schedule-add-error" role="alert" className="text-red-300">
            {status.text}
          </p>
        )}
      </form>
    </section>
  )
}
