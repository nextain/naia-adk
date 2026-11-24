"use client"

import React, { useEffect, useRef, useState } from "react"
import {
  buildCompanyDocLink,
  formatWorkStatusLabel,
  layerLabels,
  taskStatusBadge,
  type CalendarCellEvent,
  type CalendarDayCell,
  type ScheduleLayerKey,
} from "./schedule-calendar"
import { formatMessage, tFor } from "../i18n/index.ts"
import { useLocale, useT } from "../i18n/provider.tsx"
import type { Locale } from "../i18n/types.ts"

function taskStatusBadgeClass(badge: string, locale: Locale = "ko"): string {
  const done = locale === "en" ? "Done" : "완료"
  const progress = locale === "en" ? "In progress" : "진행"
  if (badge === done) return "bg-emerald-900/80 text-emerald-200"
  if (badge === progress) return "bg-sky-900/80 text-sky-200"
  return "bg-neutral-800 text-neutral-300"
}

export interface ScheduleDetailDialogProps {
  event: CalendarCellEvent | null
  onClose: () => void
  onMutate?: () => void
}

export interface CompanyScheduleComment {
  schemaVersion: 1
  id: string
  scheduleId: string
  scheduleTitle: string
  targetRole: string | null
  sourceDocPath: string | null
  author: string
  action: "comment" | "edit" | "delete"
  body: string
  createdAt: string
}

export interface CompanyScheduleFeedbackSectionProps {
  scheduleId: string
  scheduleTitle: string
  targetRole?: string | null
  sourceDocPath?: string | null
  initialComments?: CompanyScheduleComment[]
  onMutate?: () => void
}

/**
 * 회사 일정 댓글 목록 및 작성 폼. 담당 AI(targetRole) 표시를 포함한다.
 * initialComments가 주어지면 그대로 그리고, 없으면 API에서 불러온다.
 */
export function CompanyScheduleFeedbackSection({
  scheduleId,
  scheduleTitle,
  targetRole,
  sourceDocPath,
  initialComments,
  onMutate,
}: CompanyScheduleFeedbackSectionProps) {
  const t = useT()
  const [comments, setComments] = useState<CompanyScheduleComment[]>(initialComments ?? [])
  const [loaded, setLoaded] = useState<boolean>(initialComments !== undefined)
  const [draft, setDraft] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (initialComments !== undefined) {
      setComments(initialComments)
      setLoaded(true)
      return
    }
    let cancelled = false
    setLoaded(false)
    setError(null)
    fetch(`/api/portal/schedule/company/${encodeURIComponent(scheduleId)}/comments`, {
      cache: "no-store",
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data) => {
        if (cancelled) return
        setComments(Array.isArray(data?.comments) ? data.comments : [])
        setLoaded(true)
      })
      .catch(() => {
        if (cancelled) return
        setLoaded(true)
        setError(t("sched.errSaveNet"))
      })
    return () => {
      cancelled = true
    }
  }, [scheduleId, initialComments, t])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const body = draft.trim()
    if (!body || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/portal/schedule/company/${encodeURIComponent(scheduleId)}/comments`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body, scheduleTitle, targetRole, sourceDocPath }),
        },
      )
      const data = (await res.json().catch(() => null)) as { comment?: CompanyScheduleComment } | null
      if (!res.ok || !data?.comment) {
        setError(t("sched.errSave"))
        return
      }
      setComments((prev) => [...prev, data.comment as CompanyScheduleComment])
      setDraft("")
      onMutate?.()
    } catch {
      setError(t("sched.errSaveNet"))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (commentId: string) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/portal/schedule/company/${encodeURIComponent(scheduleId)}/comments/${encodeURIComponent(commentId)}`,
        { method: "DELETE" },
      )
      if (!res.ok) {
        setError(t("sched.errDelete"))
        return
      }
      setComments((prev) => prev.filter((c) => c.id !== commentId))
      onMutate?.()
    } catch {
      setError(t("sched.errDeleteNet"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      data-testid="company-schedule-comments"
      className="space-y-2 rounded-lg border border-neutral-800 bg-neutral-950/70 p-3"
    >
      <h3 className="text-xs font-bold text-neutral-100">
        {t("sched.companyComments")}
        {targetRole ? <span className="ml-1 font-normal text-neutral-400">· {targetRole}</span> : null}
      </h3>
      {!loaded ? (
        <p className="text-xs text-neutral-500">{t("common.loading")}</p>
      ) : comments.length === 0 ? (
        <p data-testid="company-schedule-comments-empty" className="text-xs text-neutral-500">
          {t("sched.noDesc")}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {comments.map((c) => (
            <li
              key={c.id}
              data-testid={`company-schedule-comment-${c.id}`}
              className="rounded border border-neutral-800 bg-neutral-900 p-2 text-xs"
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-[11px] text-neutral-400">
                  {c.targetRole ?? t("sched.unspecified")} · {c.createdAt.slice(0, 16).replace("T", " ")}
                </span>
                <button
                  type="button"
                  data-testid={`company-schedule-comment-delete-${c.id}`}
                  onClick={() => void remove(c.id)}
                  disabled={busy}
                  className="px-1.5 py-0.5 rounded border border-neutral-700 text-[11px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
                >
                  {t("sched.deleteBtn")}
                </button>
              </div>
              <p className="whitespace-pre-wrap break-words text-neutral-100">{c.body}</p>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-xs text-rose-300">
          {error}
        </p>
      )}
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-1.5">
        <textarea
          data-testid="company-schedule-comment-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          maxLength={2000}
          placeholder={t("sched.memoLabel")}
          className="w-full rounded border border-neutral-700 bg-neutral-900 p-2 text-xs text-neutral-100 placeholder:text-neutral-500"
        />
        <button
          type="submit"
          data-testid="company-schedule-comment-submit"
          disabled={busy || !draft.trim()}
          className="self-end px-3 py-1 rounded bg-sky-600 hover:bg-sky-500 text-xs font-semibold text-white disabled:opacity-50"
        >
          {busy ? t("common.saving") : t("common.save")}
        </button>
      </form>
    </section>
  )
}

export interface CompanyScheduleMutateProps {
  scheduleId: string
  title: string
  startDate: string
  endDate: string
  startTime?: string | null
  endTime?: string | null
  status?: string | null
  scheduleTitle: string
  targetRole?: string | null
  sourceDocPath?: string | null
  onMutate?: () => void
  onDeleted?: () => void
}

/** 회사 일정 직접 수정 폼 토글 및 삭제 버튼. 저장·삭제 뒤 onMutate로 목록을 새로고침한다. */
export function CompanyScheduleMutate({
  scheduleId,
  title,
  startDate,
  endDate,
  startTime,
  endTime,
  status,
  scheduleTitle,
  targetRole,
  sourceDocPath,
  onMutate,
  onDeleted,
}: CompanyScheduleMutateProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [formTitle, setFormTitle] = useState(title)
  const [formStart, setFormStart] = useState(startDate)
  const [formEnd, setFormEnd] = useState(endDate)
  const [formStartTime, setFormStartTime] = useState(startTime ?? "")
  const [formEndTime, setFormEndTime] = useState(endTime ?? "")
  const [formStatus, setFormStatus] = useState(status ?? "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/portal/schedule/company/${encodeURIComponent(scheduleId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: formTitle.trim() || undefined,
          startDate: formStart || undefined,
          endDate: formEnd || undefined,
          startTime: formStartTime.trim() ? formStartTime.trim() : null,
          endTime: formEndTime.trim() ? formEndTime.trim() : null,
          status: formStatus.trim() || undefined,
          scheduleTitle,
          targetRole,
          sourceDocPath,
        }),
      })
      if (!res.ok) {
        setError(t("sched.errSave"))
        return
      }
      setOpen(false)
      onMutate?.()
    } catch {
      setError(t("sched.errSaveNet"))
    } finally {
      setBusy(false)
    }
  }

  const removeSchedule = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/portal/schedule/company/${encodeURIComponent(scheduleId)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scheduleTitle, targetRole, sourceDocPath }),
      })
      if (!res.ok) {
        setError(t("sched.errDelete"))
        return
      }
      onMutate?.()
      onDeleted?.()
    } catch {
      setError(t("sched.errDeleteNet"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-neutral-800 bg-neutral-950/70 p-3">
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          data-testid="company-schedule-edit-btn"
          onClick={() => setOpen((v) => !v)}
          className="px-2.5 py-1 rounded border border-neutral-700 bg-neutral-800 hover:bg-neutral-700 text-xs text-neutral-200"
        >
          {t("sched.companyEditSchedule")}
        </button>
        <button
          type="button"
          data-testid="company-schedule-delete-btn"
          onClick={() => void removeSchedule()}
          disabled={busy}
          className="px-2.5 py-1 rounded border border-rose-800 bg-rose-950/60 hover:bg-rose-900/60 text-xs text-rose-200 disabled:opacity-50"
        >
          {t("sched.companyDeleteSchedule")}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-rose-300">
          {error}
        </p>
      )}
      {open && (
        <form
          data-testid="company-schedule-edit-form"
          onSubmit={(e) => void save(e)}
          className="grid grid-cols-1 sm:grid-cols-2 gap-1.5"
        >
          <label className="sm:col-span-2 flex flex-col gap-0.5 text-[11px] text-neutral-400">
            {t("sched.fieldTitle")}
            <input
              data-testid="company-schedule-edit-title"
              value={formTitle}
              onChange={(e) => setFormTitle(e.target.value)}
              className="rounded border border-neutral-700 bg-neutral-900 p-1.5 text-xs text-neutral-100"
            />
          </label>
          <label className="flex flex-col gap-0.5 text-[11px] text-neutral-400">
            {t("sched.fieldStartDate")}
            <input
              type="date"
              data-testid="company-schedule-edit-start"
              value={formStart}
              onChange={(e) => setFormStart(e.target.value)}
              className="rounded border border-neutral-700 bg-neutral-900 p-1.5 text-xs text-neutral-100"
            />
          </label>
          <label className="flex flex-col gap-0.5 text-[11px] text-neutral-400">
            {t("sched.fieldEndDate")}
            <input
              type="date"
              data-testid="company-schedule-edit-end"
              value={formEnd}
              onChange={(e) => setFormEnd(e.target.value)}
              className="rounded border border-neutral-700 bg-neutral-900 p-1.5 text-xs text-neutral-100"
            />
          </label>
          <label className="flex flex-col gap-0.5 text-[11px] text-neutral-400">
            {t("sched.fieldStartTime")}
            <input
              data-testid="company-schedule-edit-start-time"
              value={formStartTime}
              onChange={(e) => setFormStartTime(e.target.value)}
              placeholder="09:00"
              className="rounded border border-neutral-700 bg-neutral-900 p-1.5 text-xs text-neutral-100"
            />
          </label>
          <label className="flex flex-col gap-0.5 text-[11px] text-neutral-400">
            {t("sched.fieldEndTime")}
            <input
              data-testid="company-schedule-edit-end-time"
              value={formEndTime}
              onChange={(e) => setFormEndTime(e.target.value)}
              placeholder="10:00"
              className="rounded border border-neutral-700 bg-neutral-900 p-1.5 text-xs text-neutral-100"
            />
          </label>
          <label className="sm:col-span-2 flex flex-col gap-0.5 text-[11px] text-neutral-400">
            {t("sched.statusLabel")}
            <input
              data-testid="company-schedule-edit-status"
              value={formStatus}
              onChange={(e) => setFormStatus(e.target.value)}
              className="rounded border border-neutral-700 bg-neutral-900 p-1.5 text-xs text-neutral-100"
            />
          </label>
          <div className="sm:col-span-2 flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="px-2.5 py-1 rounded border border-neutral-700 text-xs text-neutral-300"
            >
              {t("common.cancel")}
            </button>
            <button
              type="submit"
              data-testid="company-schedule-edit-save"
              disabled={busy}
              className="px-3 py-1 rounded bg-sky-600 hover:bg-sky-500 text-xs font-semibold text-white disabled:opacity-50"
            >
              {busy ? t("common.saving") : t("common.save")}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}

export interface ScheduleDayListDialogProps {
  cell: CalendarDayCell | null
  onClose: () => void
  onSelectEvent: (ev: CalendarCellEvent) => void
}

function formatEventPeriodLabel(ev: CalendarCellEvent, locale: Locale = "ko"): string {
  const t = tFor(locale)
  if (ev.layer === "work" && ev.workItem) {
    const start = ev.workItem.startDate ?? ev.startDate
    const end = ev.workItem.endDate ?? ev.endDate
    if (ev.workItem.openEnded) {
      return `${start} ~ ${t("sched.ongoingToday")}`
    }
    return start === end ? start : `${start} ~ ${end}`
  }
  if (ev.layer === "personal" && ev.personalItem) {
    const p = ev.personalItem
    const range = p.start === p.end ? p.start : `${p.start} ~ ${p.end}`
    return `${range} (${p.allDay ? t("sched.allDay") : t("sched.timed")})`
  }
  if (ev.layer === "company" && ev.companyItem) {
    const c = ev.companyItem
    const startTime = c.startTime ? ` ${c.startTime}` : ""
    const endTime = c.endTime ? ` ${c.endTime}` : ""
    if (c.startDate === c.endDate) {
      if (c.times && c.times.length > 1) return `${c.startDate} (${c.times.join(", ")})`
      if (c.startTime && c.endTime && c.startTime !== c.endTime) return `${c.startDate} ${c.startTime}~${c.endTime}`
      if (c.startTime) return `${c.startDate} ${c.startTime}`
      return `${c.startDate} (${t("sched.allDay")})`
    }
    return `${c.startDate}${startTime} ~ ${c.endDate}${endTime}`
  }
  return ev.startDate === ev.endDate ? ev.startDate : `${ev.startDate} ~ ${ev.endDate}`
}

function formatMilestoneDaysLabel(daysRemaining: number | null, overdue: boolean, locale: Locale = "ko"): string {
  const t = tFor(locale)
  if (daysRemaining === null || !Number.isFinite(daysRemaining)) {
    return t("sched.dueUnset")
  }
  if (daysRemaining < 0) {
    const n = Math.abs(daysRemaining)
    return formatMessage(t("sched.ddayPast"), { n })
  }
  if (daysRemaining === 0) {
    return overdue ? t("sched.ddayOver") : t("sched.ddayToday")
  }
  return `D-${daysRemaining}`
}

/**
 * 막대 또는 그날 목록 줄을 눌렀을 때 뜨는 일정 상세 모달 창.
 * - 작업 일정: 제목 전체, 종류(작업 문서/큐 항목), 시작·끝(열려 있으면 "~ 진행 중(오늘까지)"),
 *   마감일(지났으면 경고), 담당, 상태 글, 이슈, 마일스톤 이름, 상위 그룹 이름,
 *   세부 작업 목록(번호·내용·담당·상태, 끝난 것 표시)과 "세부 작업 n개 중 m개 완료",
 *   큐 항목이면 시도 횟수·설명, docLink 가 있으면 "문서 열기" 링크.
 * - 마일스톤: 이름, 기한, D-n(지났으면 경과), 설명, 묶인 작업 완료/전체.
 * - 개인 일정(쓰기 불가일 때): 제목, 기간·시각, 메모.
 */
export function ScheduleDetailDialog({ event, onClose, onMutate }: ScheduleDetailDialogProps) {
  const closeBtnRef = useRef<HTMLButtonElement | null>(null)
  const locale = useLocale()
  const t = useT()
  const names = layerLabels(locale)

  useEffect(() => {
    if (!event) return
    closeBtnRef.current?.focus()
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [event, onClose])

  if (!event) return null

  const w = event.workItem
  const ms = event.milestoneItem
  const p = event.personalItem
  const c = event.companyItem
  const companyDocLink = c ? buildCompanyDocLink(c.sourceDocPath) : null

  const tasks = w?.tasks ?? []
  const taskTotal = w?.taskTotal ?? tasks.length
  const taskDone = w?.taskDone ?? tasks.filter((t) => t.done).length
  const isLedgerDue = w?.dueSource === "ledger.due"
  const kindLabel = w
    ? isLedgerDue
      ? t("sched.layerLedger")
      : w.kind === "work_document"
        ? t("sched.layerWorkDoc")
        : t("sched.layerQueue")
    : c
      ? c.kind === "regular"
        ? t("sched.regular")
        : t("sched.company")
      : null

  return (
    <div
      data-testid="schedule-event-detail-backdrop"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 p-0 sm:p-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="schedule-detail-title"
        data-testid="schedule-event-detail"
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-xl max-h-[85dvh] overflow-y-auto overflow-x-hidden rounded-t-2xl sm:rounded-xl border border-neutral-700 bg-neutral-900 text-neutral-100 shadow-2xl flex flex-col"
      >
        {/* 상단 머리글 */}
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-neutral-800 bg-neutral-900/95 px-4 py-3">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="px-2 py-0.5 rounded bg-neutral-800 text-neutral-200 font-semibold">
                {names[event.layer]}
              </span>
              {kindLabel && (
                <span
                  data-testid="schedule-detail-kind"
                  className="px-2 py-0.5 rounded bg-sky-950/90 border border-sky-700/70 text-sky-200 font-medium"
                >
                  {kindLabel}
                </span>
              )}
              {event.overdue && (
                <span
                  data-testid="schedule-detail-overdue-badge"
                  className="px-2 py-0.5 rounded bg-rose-950/90 border border-rose-500/80 text-rose-200 font-semibold"
                >
                  {t("sched.overdueBadgeLong")}
                </span>
              )}
              {event.completed && (
                <span className="px-2 py-0.5 rounded bg-emerald-950/80 border border-emerald-700/70 text-emerald-200 font-medium">
                  {t("sched.completedBadge")}
                </span>
              )}
            </div>
            <h2
              id="schedule-detail-title"
              className="text-sm sm:text-base font-bold text-white break-words leading-snug"
            >
              {event.title}
            </h2>
          </div>

          <button
            ref={closeBtnRef}
            type="button"
            data-testid="schedule-detail-close"
            onClick={onClose}
            className="px-2.5 py-1 rounded border border-neutral-700 bg-neutral-800 hover:bg-neutral-700 text-xs text-neutral-200 hover:text-white shrink-0"
          >
            {t("common.close")}
          </button>
        </div>

        {/* 본문 */}
        <div className="p-4 space-y-4 text-xs">
          {/* 1) 그룹(작업) 일정 상세 */}
          {event.layer === "work" && (
            <>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 rounded-lg border border-neutral-800 bg-neutral-950/70 p-3">
                <div>
                  <dt className="text-[11px] text-neutral-400">{t("sched.periodLabel")}</dt>
                  <dd data-testid="schedule-detail-period" className="font-medium text-neutral-100 mt-0.5 break-words">
                    {formatEventPeriodLabel(event, locale)}
                  </dd>
                </div>

                <div>
                  <dt className="text-[11px] text-neutral-400">{t("sched.dueLabel")}</dt>
                  <dd
                    data-testid="schedule-detail-due"
                    className={`font-medium mt-0.5 ${
                      w?.overdue ? "text-rose-300 font-semibold" : "text-neutral-100"
                    }`}
                  >
                    {w?.dueDate ? `${w.dueDate}${w.overdue ? t("sched.overdueWarn") : ""}` : t("sched.noneValue")}
                  </dd>
                </div>

                <div>
                  <dt className="text-[11px] text-neutral-400">{t("sched.assigneeLabel")}</dt>
                  <dd data-testid="schedule-detail-assignee" className="font-medium text-neutral-100 mt-0.5 break-words">
                    {w?.assignee || t("sched.unspecified")}
                  </dd>
                </div>

                <div>
                  <dt className="text-[11px] text-neutral-400">{t("sched.statusLabel")}</dt>
                  <dd data-testid="schedule-detail-status" className="font-medium text-neutral-100 mt-0.5 break-words">
                    {w ? formatWorkStatusLabel(w, locale) : "-"}
                    {w?.completed ? t("sched.doneSuffix") : w?.cancelled ? t("sched.cancelledSuffix") : ""}
                  </dd>
                </div>

                <div>
                  <dt className="text-[11px] text-neutral-400">{t("sched.issueLabel")}</dt>
                  <dd data-testid="schedule-detail-issue" className="font-medium text-neutral-100 mt-0.5 break-words">
                    {w?.issue || "-"}
                  </dd>
                </div>

                <div>
                  <dt className="text-[11px] text-neutral-400">{t("sched.milestoneLabel")}</dt>
                  <dd data-testid="schedule-detail-milestone" className="font-medium text-neutral-100 mt-0.5 break-words">
                    {w?.milestoneName || "-"}
                  </dd>
                </div>

                <div className="sm:col-span-2">
                  <dt className="text-[11px] text-neutral-400">{t("sched.parentGroupLabel")}</dt>
                  <dd data-testid="schedule-detail-parent-group" className="font-medium text-neutral-100 mt-0.5 break-words">
                    {w?.parentGroupName || "-"}
                  </dd>
                </div>
              </dl>

              {/* 작업 문서 링크 */}
              {w?.docLink && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-sky-800/70 bg-sky-950/30 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] text-neutral-400">{t("sched.workDocAddress")}</div>
                    <code className="text-xs text-sky-200 break-all">{w.docLink}</code>
                  </div>
                  <a
                    href={w.docLink}
                    target="_blank"
                    rel="noopener"
                    data-testid="schedule-detail-doc-link"
                    className="px-3 py-1.5 rounded-md bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold shrink-0 transition-colors"
                  >
                    {t("sched.openDoc")}
                  </a>
                </div>
              )}

              {/* 세부 작업 목록 (작업 문서이거나 세부 작업이 있는 경우, 단 업무 장부 카드의 빈 목록은 숨김) */}
              {((w?.kind === "work_document" && !isLedgerDue) || taskTotal > 0) && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h3 data-testid="schedule-detail-task-summary" className="text-xs font-bold text-sky-300">
                      {formatMessage(t("sched.taskTotal"), { total: taskTotal, done: taskDone })}
                    </h3>
                    <span className="text-[11px] tabular-nums text-neutral-400">
                      {taskDone}/{taskTotal}
                    </span>
                  </div>

                  {tasks.length === 0 ? (
                    <p className="text-xs text-neutral-500">{t("sched.noTasks")}</p>
                  ) : (
                    <ul
                      data-testid="schedule-detail-task-list"
                      className="space-y-1.5 max-h-64 overflow-y-auto pr-1"
                    >
                      {tasks.map((task, idx) => {
                        const badge: string = task.done ? t("sched.taskBadgeDone") : String(taskStatusBadge(task.status, locale))
                        return (
                          <li
                            key={`${task.number}-${idx}`}
                            data-testid={`schedule-detail-task-${task.number}`}
                            data-done={task.done ? "1" : "0"}
                            className={`p-2.5 rounded-lg border text-xs space-y-1 ${
                              task.done
                                ? "border-emerald-800/60 bg-emerald-950/20 text-neutral-200"
                                : "border-neutral-800 bg-neutral-950/80 text-neutral-100"
                            }`}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0 flex-1 font-medium break-words">
                                <span
                                  data-testid={`schedule-detail-task-badge-${task.number}`}
                                  data-badge={badge}
                                  className={`inline-block mr-1.5 px-1.5 py-0.2 rounded text-[10px] font-semibold ${taskStatusBadgeClass(badge, locale)}`}
                                >
                                  {task.done ? t("sched.doneCheck") : badge}
                                </span>
                                <span className="text-neutral-400 mr-1">#{task.number}</span>
                                <span>{task.task}</span>
                              </div>
                              {task.assignee && (
                                <span className="text-[11px] text-neutral-400 shrink-0">{t("sched.assigneeLabel")}: {task.assignee}</span>
                              )}
                            </div>
                            {task.status && (
                              <div className="text-[11px] text-neutral-400 break-words">{t("sched.statusLabel")}: {task.status}</div>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
              )}

              {/* 큐 항목 또는 업무 장부 설명 */}
              {(w?.kind === "queue" || (isLedgerDue && Boolean(w?.description))) && (
                <div className="space-y-2 rounded-lg border border-neutral-800 bg-neutral-950/70 p-3">
                  {w?.kind === "queue" && (
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-neutral-400">{t("sched.attempts")}</span>
                      <span data-testid="schedule-detail-attempt-count" className="font-semibold text-neutral-200">
                        {formatMessage(t("sched.timesCount"), { count: w.attemptCount ?? 0 })}
                      </span>
                    </div>
                  )}
                  <div>
                    <div className="text-[11px] text-neutral-400 mb-1">{t("sched.descLabel")}</div>
                    <p
                      data-testid="schedule-detail-description"
                      className="text-xs text-neutral-200 whitespace-pre-wrap break-words leading-relaxed"
                    >
                      {w?.description || t("sched.noDesc")}
                    </p>
                  </div>
                </div>
              )}
            </>
          )}

          {/* 2) 마일스톤 상세 */}
          {event.layer === "milestone" && (
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-lg border border-neutral-800 bg-neutral-950/70 p-3">
              <div>
                <dt className="text-[11px] text-neutral-400">{t("sched.dueLabel")}</dt>
                <dd data-testid="schedule-detail-milestone-due" className="font-medium text-neutral-100 mt-0.5">
                  {ms?.dueDate || event.startDate || t("sched.noDue")}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] text-neutral-400">{t("sched.remainingDays")}</dt>
                <dd
                  data-testid="schedule-detail-milestone-dday"
                  className={`font-semibold mt-0.5 ${
                    ms?.overdue ? "text-rose-300" : "text-amber-300"
                  }`}
                >
                  {formatMilestoneDaysLabel(ms?.daysRemaining ?? null, Boolean(ms?.overdue), locale)}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-[11px] text-neutral-400">{t("sched.boundProgress")}</dt>
                <dd data-testid="schedule-detail-milestone-progress" className="font-medium text-neutral-100 mt-0.5">
                  {formatMessage(t("sched.progressDone"), { done: ms?.completed ?? 0, total: ms?.total ?? 0 })}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-[11px] text-neutral-400">{t("sched.descLabel")}</dt>
                <dd data-testid="schedule-detail-milestone-desc" className="text-neutral-200 mt-0.5 break-words">
                  {ms?.description || t("sched.noDesc")}
                </dd>
              </div>
            </dl>
          )}

          {/* 3) 개인 일정 상세 (쓰기 불가일 때) */}
          {event.layer === "personal" && (
            <dl className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-950/70 p-3">
              <div>
                <dt className="text-[11px] text-neutral-400">{t("sched.periodTimeLabel")}</dt>
                <dd data-testid="schedule-detail-personal-period" className="font-medium text-neutral-100 mt-0.5 break-words">
                  {formatEventPeriodLabel(event, locale)}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] text-neutral-400">{t("sched.memoLabel")}</dt>
                <dd
                  data-testid="schedule-detail-personal-memo"
                  className="text-neutral-200 mt-0.5 whitespace-pre-wrap break-words"
                >
                  {p?.memo || event.subtitle || t("sched.noMemo")}
                </dd>
              </div>
            </dl>
          )}

          {/* 4) 회사 · 정기 일정 상세 */}
          {event.layer === "company" && (
            <>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 rounded-lg border border-neutral-800 bg-neutral-950/70 p-3">
                <div>
                  <dt className="text-[11px] text-neutral-400">{t("sched.periodTimeLabel")}</dt>
                  <dd data-testid="schedule-detail-company-period" className="font-medium text-neutral-100 mt-0.5 break-words">
                    {formatEventPeriodLabel(event, locale)}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-neutral-400">{t("sched.assigneeLabel")}</dt>
                  <dd data-testid="schedule-detail-company-role" className="font-medium text-neutral-100 mt-0.5 break-words">
                    {c?.roleLabel || c?.role || t("sched.unspecified")}
                  </dd>
                </div>
                <div className={c?.repeatSummary ? "" : "sm:col-span-2"}>
                  <dt className="text-[11px] text-neutral-400">{t("sched.statusLabel")}</dt>
                  <dd data-testid="schedule-detail-company-status" className="font-medium text-neutral-100 mt-0.5 break-words">
                    {c?.state || c?.status || "-"}
                  </dd>
                </div>
                {c?.repeatSummary && (
                  <div>
                    <dt className="text-[11px] text-neutral-400">{t("sched.repeatCycle")}</dt>
                    <dd data-testid="schedule-detail-company-repeat" className="font-medium text-neutral-100 mt-0.5 break-words">
                      {c.repeatSummary}
                    </dd>
                  </div>
                )}
              </dl>

              {companyDocLink && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-violet-800/70 bg-violet-950/30 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] text-neutral-400">{t("sched.sourceDocPath")}</div>
                    <code className="text-xs text-violet-200 break-all">{c?.sourceDocPath}</code>
                  </div>
                  <a
                    href={companyDocLink}
                    target="_blank"
                    rel="noopener"
                    data-testid="schedule-detail-company-doc-link"
                    className="px-3 py-1.5 rounded-md bg-violet-600 hover:bg-violet-500 text-white text-xs font-semibold shrink-0 transition-colors"
                  >
                    {t("sched.viewSourceDoc")}
                  </a>
                </div>
              )}

              {c && (
                <>
                  <CompanyScheduleFeedbackSection
                    scheduleId={c.id}
                    scheduleTitle={c.title}
                    targetRole={c.role ?? null}
                    sourceDocPath={c.sourceDocPath ?? null}
                    onMutate={onMutate}
                  />
                  <CompanyScheduleMutate
                    scheduleId={c.id}
                    title={c.title}
                    startDate={c.startDate}
                    endDate={c.endDate}
                    startTime={c.startTime ?? null}
                    endTime={c.endTime ?? null}
                    status={c.state ?? c.status ?? null}
                    scheduleTitle={c.title}
                    targetRole={c.role ?? null}
                    sourceDocPath={c.sourceDocPath ?? null}
                    onMutate={onMutate}
                    onDeleted={onClose}
                  />
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * 날짜 칸 아래 "+n건" 단추를 눌렀을 때 뜨는 그날 일정 목록 모달 창.
 * 그날에 걸친 모든 일정(숨은 것 포함)을 종류별로 보여 주고, 줄을 누르면 상세 창(또는 편집 창)을 연다.
 */
export function ScheduleDayListDialog({ cell, onClose, onSelectEvent }: ScheduleDayListDialogProps) {
  const closeBtnRef = useRef<HTMLButtonElement | null>(null)
  const locale = useLocale()
  const t = useT()
  const names = layerLabels(locale)

  useEffect(() => {
    if (!cell) return
    closeBtnRef.current?.focus()
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [cell, onClose])

  if (!cell) return null

  const groups: Array<{ layer: ScheduleLayerKey; label: string; items: CalendarCellEvent[] }> = (
    ["milestone", "company", "personal", "work"] as const
  )
    .map((layer) => ({
      layer,
      label: names[layer],
      items: cell.events.filter((ev) => ev.layer === layer),
    }))
    .filter((g) => g.items.length > 0)

  return (
    <div
      data-testid="schedule-day-list-backdrop"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 p-0 sm:p-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="schedule-day-list-title"
        data-testid="schedule-day-list"
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-lg max-h-[85dvh] overflow-y-auto overflow-x-hidden rounded-t-2xl sm:rounded-xl border border-neutral-700 bg-neutral-900 text-neutral-100 shadow-2xl flex flex-col"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-neutral-800 bg-neutral-900/95 px-4 py-3">
          <h2 id="schedule-day-list-title" className="text-sm sm:text-base font-bold text-white">
            {cell.date} {t("nav.schedule")} ({formatMessage(t("work.count"), { count: cell.events.length })})
          </h2>
          <button
            ref={closeBtnRef}
            type="button"
            data-testid="schedule-day-list-close"
            onClick={onClose}
            className="px-2.5 py-1 rounded border border-neutral-700 bg-neutral-800 hover:bg-neutral-700 text-xs text-neutral-200 hover:text-white"
          >
            {t("common.close")}
          </button>
        </div>

        <div className="p-4 space-y-4 text-xs">
          {groups.length === 0 ? (
            <p className="text-neutral-400">{t("sched.noDayEvents")}</p>
          ) : (
            groups.map((group) => (
              <div key={group.layer} className="space-y-1.5">
                <h3 className="text-xs font-bold text-neutral-300">
                  {group.label} ({formatMessage(t("work.count"), { count: group.items.length })})
                </h3>
                <ul className="space-y-1.5">
                  {group.items.map((ev) => {
                    const taskBadge =
                      ev.layer === "work" && ev.workItem && (ev.workItem.taskTotal ?? 0) > 0
                        ? formatMessage(t("sched.taskCompact"), { done: ev.workItem.taskDone ?? 0, total: ev.workItem.taskTotal })
                        : ev.layer === "milestone" && ev.milestoneItem && ev.milestoneItem.total > 0
                          ? formatMessage(t("sched.doneCompact"), { done: ev.milestoneItem.completed, total: ev.milestoneItem.total })
                          : null
                    return (
                      <li key={ev.key}>
                        <button
                          type="button"
                          data-testid={`day-list-event-${ev.layer}-${ev.id}`}
                          onClick={() => onSelectEvent(ev)}
                          className="w-full text-left p-2.5 rounded-lg border border-neutral-800 bg-neutral-950/80 hover:border-sky-600/70 hover:bg-neutral-900 transition-colors space-y-1 cursor-pointer"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <span className="font-semibold text-white break-words">{ev.title}</span>
                            {taskBadge && (
                              <span className="px-1.5 py-0.5 rounded bg-neutral-800 text-[11px] tabular-nums text-sky-300 shrink-0">
                                {taskBadge}
                              </span>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-2 text-[11px] text-neutral-400">
                            <span>{t("sched.periodShort")}: {formatEventPeriodLabel(ev, locale)}</span>
                            {ev.overdue && <span className="text-rose-400 font-semibold">{t("work.overdueBadge")}</span>}
                          </div>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
