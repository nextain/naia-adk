"use client"

import React, { useEffect, useRef } from "react"
import {
  LAYER_LABELS,
  taskStatusBadge,
  type CalendarCellEvent,
  type CalendarDayCell,
  type ScheduleLayerKey,
  type TaskStatusBadge,
} from "./schedule-calendar"

function taskStatusBadgeClass(badge: TaskStatusBadge): string {
  if (badge === "완료") return "bg-emerald-900/80 text-emerald-200"
  if (badge === "진행") return "bg-sky-900/80 text-sky-200"
  return "bg-neutral-800 text-neutral-300"
}

export interface ScheduleDetailDialogProps {
  event: CalendarCellEvent | null
  onClose: () => void
}

export interface ScheduleDayListDialogProps {
  cell: CalendarDayCell | null
  onClose: () => void
  onSelectEvent: (ev: CalendarCellEvent) => void
}

function formatEventPeriodLabel(ev: CalendarCellEvent): string {
  if (ev.layer === "work" && ev.workItem) {
    const start = ev.workItem.startDate ?? ev.startDate
    const end = ev.workItem.endDate ?? ev.endDate
    if (ev.workItem.openEnded) {
      return `${start} ~ 진행 중(오늘까지)`
    }
    return start === end ? start : `${start} ~ ${end}`
  }
  if (ev.layer === "personal" && ev.personalItem) {
    const p = ev.personalItem
    const range = p.start === p.end ? p.start : `${p.start} ~ ${p.end}`
    return `${range} (${p.allDay ? "종일" : "시각 지정"})`
  }
  return ev.startDate === ev.endDate ? ev.startDate : `${ev.startDate} ~ ${ev.endDate}`
}

function formatMilestoneDaysLabel(daysRemaining: number | null, overdue: boolean): string {
  if (daysRemaining === null || !Number.isFinite(daysRemaining)) {
    return "기한 미정"
  }
  if (daysRemaining < 0) {
    return `D+${Math.abs(daysRemaining)} (${Math.abs(daysRemaining)}일 경과)`
  }
  if (daysRemaining === 0) {
    return overdue ? "D-Day (기한 경과)" : "D-Day (오늘 마감)"
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
export function ScheduleDetailDialog({ event, onClose }: ScheduleDetailDialogProps) {
  const closeBtnRef = useRef<HTMLButtonElement | null>(null)

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

  const tasks = w?.tasks ?? []
  const taskTotal = w?.taskTotal ?? tasks.length
  const taskDone = w?.taskDone ?? tasks.filter((t) => t.done).length
  const kindLabel = w ? (w.kind === "work_document" ? "작업 문서" : "큐 항목") : null

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
                {LAYER_LABELS[event.layer]}
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
                  마감 지남 · 경고
                </span>
              )}
              {event.completed && (
                <span className="px-2 py-0.5 rounded bg-emerald-950/80 border border-emerald-700/70 text-emerald-200 font-medium">
                  완료
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
            닫기
          </button>
        </div>

        {/* 본문 */}
        <div className="p-4 space-y-4 text-xs">
          {/* 1) 그룹(작업) 일정 상세 */}
          {event.layer === "work" && (
            <>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 rounded-lg border border-neutral-800 bg-neutral-950/70 p-3">
                <div>
                  <dt className="text-[11px] text-neutral-400">기간 (시작 ~ 끝)</dt>
                  <dd data-testid="schedule-detail-period" className="font-medium text-neutral-100 mt-0.5 break-words">
                    {formatEventPeriodLabel(event)}
                  </dd>
                </div>

                <div>
                  <dt className="text-[11px] text-neutral-400">마감일</dt>
                  <dd
                    data-testid="schedule-detail-due"
                    className={`font-medium mt-0.5 ${
                      w?.overdue ? "text-rose-300 font-semibold" : "text-neutral-100"
                    }`}
                  >
                    {w?.dueDate ? `${w.dueDate}${w.overdue ? " (마감 경과 경고)" : ""}` : "없음"}
                  </dd>
                </div>

                <div>
                  <dt className="text-[11px] text-neutral-400">담당</dt>
                  <dd data-testid="schedule-detail-assignee" className="font-medium text-neutral-100 mt-0.5 break-words">
                    {w?.assignee || "미지정"}
                  </dd>
                </div>

                <div>
                  <dt className="text-[11px] text-neutral-400">진행 상태</dt>
                  <dd data-testid="schedule-detail-status" className="font-medium text-neutral-100 mt-0.5 break-words">
                    {w?.status || "-"}
                    {w?.completed ? " (완료)" : w?.cancelled ? " (취소)" : ""}
                  </dd>
                </div>

                <div>
                  <dt className="text-[11px] text-neutral-400">이슈</dt>
                  <dd data-testid="schedule-detail-issue" className="font-medium text-neutral-100 mt-0.5 break-words">
                    {w?.issue || "-"}
                  </dd>
                </div>

                <div>
                  <dt className="text-[11px] text-neutral-400">마일스톤</dt>
                  <dd data-testid="schedule-detail-milestone" className="font-medium text-neutral-100 mt-0.5 break-words">
                    {w?.milestoneName || "-"}
                  </dd>
                </div>

                <div className="sm:col-span-2">
                  <dt className="text-[11px] text-neutral-400">상위 그룹</dt>
                  <dd data-testid="schedule-detail-parent-group" className="font-medium text-neutral-100 mt-0.5 break-words">
                    {w?.parentGroupName || "-"}
                  </dd>
                </div>
              </dl>

              {/* 작업 문서 링크 */}
              {w?.docLink && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-sky-800/70 bg-sky-950/30 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] text-neutral-400">작업 문서 주소</div>
                    <code className="text-xs text-sky-200 break-all">{w.docLink}</code>
                  </div>
                  <a
                    href={w.docLink}
                    target="_blank"
                    rel="noopener"
                    data-testid="schedule-detail-doc-link"
                    className="px-3 py-1.5 rounded-md bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold shrink-0 transition-colors"
                  >
                    문서 열기
                  </a>
                </div>
              )}

              {/* 세부 작업 목록 (작업 문서이거나 세부 작업이 있는 경우) */}
              {(w?.kind === "work_document" || taskTotal > 0) && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h3 data-testid="schedule-detail-task-summary" className="text-xs font-bold text-sky-300">
                      세부 작업 {taskTotal}개 중 {taskDone}개 완료
                    </h3>
                    <span className="text-[11px] tabular-nums text-neutral-400">
                      {taskDone}/{taskTotal}
                    </span>
                  </div>

                  {tasks.length === 0 ? (
                    <p className="text-xs text-neutral-500">등록된 세부 작업이 없습니다.</p>
                  ) : (
                    <ul
                      data-testid="schedule-detail-task-list"
                      className="space-y-1.5 max-h-64 overflow-y-auto pr-1"
                    >
                      {tasks.map((t, idx) => {
                        const badge: TaskStatusBadge = t.done ? "완료" : taskStatusBadge(t.status)
                        return (
                          <li
                            key={`${t.number}-${idx}`}
                            data-testid={`schedule-detail-task-${t.number}`}
                            data-done={t.done ? "1" : "0"}
                            className={`p-2.5 rounded-lg border text-xs space-y-1 ${
                              t.done
                                ? "border-emerald-800/60 bg-emerald-950/20 text-neutral-200"
                                : "border-neutral-800 bg-neutral-950/80 text-neutral-100"
                            }`}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0 flex-1 font-medium break-words">
                                <span
                                  data-testid={`schedule-detail-task-badge-${t.number}`}
                                  data-badge={badge}
                                  className={`inline-block mr-1.5 px-1.5 py-0.2 rounded text-[10px] font-semibold ${taskStatusBadgeClass(badge)}`}
                                >
                                  {badge === "완료" ? "✓ 완료" : badge}
                                </span>
                                <span className="text-neutral-400 mr-1">#{t.number}</span>
                                <span>{t.task}</span>
                              </div>
                              {t.assignee && (
                                <span className="text-[11px] text-neutral-400 shrink-0">담당: {t.assignee}</span>
                              )}
                            </div>
                            {t.status && (
                              <div className="text-[11px] text-neutral-400 break-words">상태: {t.status}</div>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
              )}

              {/* 큐 항목: 시도 횟수 · 설명 */}
              {w?.kind === "queue" && (
                <div className="space-y-2 rounded-lg border border-neutral-800 bg-neutral-950/70 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-neutral-400">시도 횟수</span>
                    <span data-testid="schedule-detail-attempt-count" className="font-semibold text-neutral-200">
                      {w.attemptCount ?? 0}회
                    </span>
                  </div>
                  <div>
                    <div className="text-[11px] text-neutral-400 mb-1">설명</div>
                    <p
                      data-testid="schedule-detail-description"
                      className="text-xs text-neutral-200 whitespace-pre-wrap break-words leading-relaxed"
                    >
                      {w.description || "설명이 없습니다."}
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
                <dt className="text-[11px] text-neutral-400">기한</dt>
                <dd data-testid="schedule-detail-milestone-due" className="font-medium text-neutral-100 mt-0.5">
                  {ms?.dueDate || event.startDate || "기한 없음"}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] text-neutral-400">남은 날 (D-n)</dt>
                <dd
                  data-testid="schedule-detail-milestone-dday"
                  className={`font-semibold mt-0.5 ${
                    ms?.overdue ? "text-rose-300" : "text-amber-300"
                  }`}
                >
                  {formatMilestoneDaysLabel(ms?.daysRemaining ?? null, Boolean(ms?.overdue))}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-[11px] text-neutral-400">묶인 작업 진행</dt>
                <dd data-testid="schedule-detail-milestone-progress" className="font-medium text-neutral-100 mt-0.5">
                  완료 {ms?.completed ?? 0} / 전체 {ms?.total ?? 0} ({ms?.completed ?? 0}/{ms?.total ?? 0})
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-[11px] text-neutral-400">설명</dt>
                <dd data-testid="schedule-detail-milestone-desc" className="text-neutral-200 mt-0.5 break-words">
                  {ms?.description || "설명이 없습니다."}
                </dd>
              </div>
            </dl>
          )}

          {/* 3) 개인 일정 상세 (쓰기 불가일 때) */}
          {event.layer === "personal" && (
            <dl className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-950/70 p-3">
              <div>
                <dt className="text-[11px] text-neutral-400">기간 · 시각</dt>
                <dd data-testid="schedule-detail-personal-period" className="font-medium text-neutral-100 mt-0.5 break-words">
                  {formatEventPeriodLabel(event)}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] text-neutral-400">메모</dt>
                <dd
                  data-testid="schedule-detail-personal-memo"
                  className="text-neutral-200 mt-0.5 whitespace-pre-wrap break-words"
                >
                  {p?.memo || event.subtitle || "메모가 없습니다."}
                </dd>
              </div>
            </dl>
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
    ["milestone", "personal", "work"] as const
  )
    .map((layer) => ({
      layer,
      label: LAYER_LABELS[layer],
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
            {cell.date} 일정 ({cell.events.length}건)
          </h2>
          <button
            ref={closeBtnRef}
            type="button"
            data-testid="schedule-day-list-close"
            onClick={onClose}
            className="px-2.5 py-1 rounded border border-neutral-700 bg-neutral-800 hover:bg-neutral-700 text-xs text-neutral-200 hover:text-white"
          >
            닫기
          </button>
        </div>

        <div className="p-4 space-y-4 text-xs">
          {groups.length === 0 ? (
            <p className="text-neutral-400">이 날짜에 표시할 일정이 없습니다.</p>
          ) : (
            groups.map((group) => (
              <div key={group.layer} className="space-y-1.5">
                <h3 className="text-xs font-bold text-neutral-300">
                  {group.label} ({group.items.length}건)
                </h3>
                <ul className="space-y-1.5">
                  {group.items.map((ev) => {
                    const taskBadge =
                      ev.layer === "work" && ev.workItem && (ev.workItem.taskTotal ?? 0) > 0
                        ? `세부 작업 ${ev.workItem.taskDone ?? 0}/${ev.workItem.taskTotal}`
                        : ev.layer === "milestone" && ev.milestoneItem && ev.milestoneItem.total > 0
                          ? `완료 ${ev.milestoneItem.completed}/${ev.milestoneItem.total}`
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
                            <span>기간: {formatEventPeriodLabel(ev)}</span>
                            {ev.overdue && <span className="text-rose-400 font-semibold">마감 지남</span>}
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
