"use client"
import React from "react"
import type { useScheduleView } from "./useScheduleView"
import { PERSONAL_IDENTITY_REQUIRED_NOTICE, PERSONAL_LOADING_NOTICE, PERSONAL_WARNINGS_LOCKED_NOTICE, MAX_VISIBLE_PERSONAL_WARNINGS } from "./schedule-view-model"
import { shiftCalendarAnchor } from "./schedule-calendar"
import { ScheduleCalendarGrid } from "./ScheduleCalendarGrid"
import { ScheduleDayListDialog, ScheduleDetailDialog } from "./ScheduleDetailDialog"

type View = ReturnType<typeof useScheduleView>

export function ScheduleCalendarSection({ view }: { view: View }) {
  const {
    mode, unit, layers, workFilter,
    setAnchorDate, userLabel, personalIdentityRequired, personalWarningsLocked,
    personalLoading, personalUnavailable, canMutatePersonal, personalItems, saving,
    personalWarnings, boardSchedule, selectedWorkEvent, setSelectedWorkEvent,
    setDayListDate, setUnit, setWorkFilter, loadPersonal,
    openAddForm, openEditForm, handleDeleteItem, filteredUndatedItems,
    calendarWeeks, selectedDayCell, handleSelectCalendarEvent, periodTitle,
  } = view
  return (
    <>
      {/* 달력 보기 */}
      {mode === "calendar" && (
        <div data-testid="schedule-calendar-section" className="px-3 py-3 sm:px-6 space-y-4 flex-1">
          {/* 달력 기간 이동 + 월/주 단위 전환 + 작업 미완료/전체 필터 */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="schedule-nav-prev"
                onClick={() => setAnchorDate((prev) => shiftCalendarAnchor(prev, unit, -1))}
                className="px-2.5 py-1 rounded border border-neutral-800 bg-neutral-900 hover:bg-neutral-800 text-xs text-neutral-200"
              >
                ◀ 이전
              </button>
              <h2 data-testid="schedule-period-title" className="text-base sm:text-lg font-bold text-white min-w-[8rem] text-center">
                {periodTitle}
              </h2>
              <button
                type="button"
                data-testid="schedule-nav-next"
                onClick={() => setAnchorDate((prev) => shiftCalendarAnchor(prev, unit, 1))}
                className="px-2.5 py-1 rounded border border-neutral-800 bg-neutral-900 hover:bg-neutral-800 text-xs text-neutral-200"
              >
                다음 ▶
              </button>
              <button
                type="button"
                data-testid="schedule-nav-today"
                onClick={() => setAnchorDate(boardSchedule.todayDate)}
                className="px-2.5 py-1 rounded border border-neutral-800 bg-neutral-900 hover:bg-neutral-800 text-xs text-neutral-300"
              >
                오늘
              </button>
            </div>

            <div className="flex items-center gap-2">
              {/* 월 / 주 단위 전환 */}
              <div
                role="group"
                aria-label="달력 단위"
                className="inline-flex rounded-lg border border-neutral-800 bg-neutral-900 p-0.5"
              >
                <button
                  type="button"
                  data-testid="schedule-unit-month"
                  aria-pressed={unit === "month"}
                  onClick={() => setUnit("month")}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium ${
                    unit === "month" ? "bg-neutral-700 text-white" : "text-neutral-400 hover:text-white"
                  }`}
                >
                  월 단위
                </button>
                <button
                  type="button"
                  data-testid="schedule-unit-week"
                  aria-pressed={unit === "week"}
                  onClick={() => setUnit("week")}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium ${
                    unit === "week" ? "bg-neutral-700 text-white" : "text-neutral-400 hover:text-white"
                  }`}
                >
                  주 단위
                </button>
              </div>

              {/* 작업 일정 필터 (미완료 / 전체) */}
              {(layers.work || layers.queue) && (
                <div
                  role="group"
                  aria-label="작업 일정 범위"
                  className="inline-flex rounded-lg border border-neutral-800 bg-neutral-900 p-0.5"
                >
                  <button
                    type="button"
                    data-testid="schedule-work-filter-open"
                    aria-pressed={workFilter === "open"}
                    onClick={() => setWorkFilter("open")}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium ${
                      workFilter === "open" ? "bg-neutral-700 text-white" : "text-neutral-400 hover:text-white"
                    }`}
                  >
                    미완료 작업
                  </button>
                  <button
                    type="button"
                    data-testid="schedule-work-filter-all"
                    aria-pressed={workFilter === "all"}
                    onClick={() => setWorkFilter("all")}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium ${
                      workFilter === "all" ? "bg-neutral-700 text-white" : "text-neutral-400 hover:text-white"
                    }`}
                  >
                    전체 작업
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* 7열 달력 격자 (주 줄 단위 이어진 막대 + 칸별 넘침 단추) */}
          <ScheduleCalendarGrid
            weeks={calendarWeeks}
            unit={unit}
            canMutatePersonal={canMutatePersonal && !saving}
            onAddPersonal={(dateStr) => openAddForm(dateStr)}
            onSelectEvent={handleSelectCalendarEvent}
            onOpenDayList={(cell) => setDayListDate(cell.date)}
          />

          {/* 날짜 칸 "+n건" 그날 일정 목록 모달 창 */}
          <ScheduleDayListDialog
            cell={selectedDayCell}
            onClose={() => setDayListDate(null)}
            onSelectEvent={handleSelectCalendarEvent}
          />

          {/* 선택한 일정 상세 모달 창 */}
          <ScheduleDetailDialog
            event={selectedWorkEvent}
            onClose={() => setSelectedWorkEvent(null)}
          />

          {/* 아래쪽 보조 구역: 개인 일정 관리 카드 · 마일스톤 현황 · 날짜 없는 작업 */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* 개인 일정 목록 & 편집 */}
            {layers.personal && (
              <section
                data-testid="personal-schedule-panel"
                className="rounded-lg border border-emerald-900/60 bg-neutral-900/50 p-3 space-y-2"
              >
                {personalLoading ? (
                  <>
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-bold text-emerald-300">개인 일정</h3>
                    </div>
                    <p data-testid="personal-loading-notice" className="text-xs text-neutral-400">
                      {PERSONAL_LOADING_NOTICE}
                    </p>
                  </>
                ) : personalUnavailable ? (
                  <p role="alert" className="text-xs text-amber-300">
                    개인 일정을 불러오지 못했습니다. <button type="button" className="underline" onClick={() => void loadPersonal()}>다시 시도</button>
                  </p>
                ) : personalIdentityRequired ? (
                  <>
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-bold text-emerald-300">개인 일정</h3>
                    </div>
                    <p data-testid="personal-identity-required-notice" className="text-xs text-neutral-400">
                      {PERSONAL_IDENTITY_REQUIRED_NOTICE}
                    </p>
                  </>
                ) : (
                  <>
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-bold text-emerald-300">
                        내 개인 일정 ({userLabel ? `${userLabel} · ` : ""}{personalItems.length}건)
                      </h3>
                      {canMutatePersonal && (
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => openAddForm()}
                          className="text-xs text-emerald-300 hover:text-emerald-200 underline"
                        >
                          + 추가
                        </button>
                      )}
                    </div>
                    {personalWarningsLocked && (
                      <div
                        data-testid="personal-warnings-locked-notice"
                        className="rounded border border-amber-700/70 bg-amber-950/40 p-2 space-y-1 text-xs text-amber-200"
                      >
                        <p className="font-medium">{PERSONAL_WARNINGS_LOCKED_NOTICE}</p>
                        <ul data-testid="personal-warnings-list" className="list-disc pl-4 space-y-0.5 text-[11px] text-amber-300">
                          {personalWarnings.slice(0, MAX_VISIBLE_PERSONAL_WARNINGS).map((w, idx) => (
                            <li key={idx}>{w}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {personalItems.length === 0 ? (
                      <p className="text-xs text-neutral-500">
                        {canMutatePersonal
                          ? "등록된 개인 일정이 없습니다. [+ 개인 일정 추가] 단추로 추가하세요."
                          : "등록된 개인 일정이 없습니다."}
                      </p>
                    ) : (
                      <ul className="space-y-1.5">
                        {personalItems.map((item) => (
                          <li
                            key={item.id}
                            data-testid={`personal-item-${item.id}`}
                            className="p-2 rounded border border-neutral-800 bg-neutral-950/80 flex items-start justify-between gap-2 text-xs"
                          >
                            <div className="min-w-0">
                              <div className="font-semibold text-emerald-200 truncate">{item.title}</div>
                              <div className="text-[11px] text-neutral-400">
                                {item.start === item.end ? item.start : `${item.start} ~ ${item.end}`} ·{" "}
                                {item.allDay ? "종일" : "시각 지정"}
                              </div>
                              {item.memo && <div className="text-[11px] text-neutral-300 mt-0.5">{item.memo}</div>}
                            </div>
                            {canMutatePersonal && (
                              <div className="flex items-center gap-1.5 shrink-0">
                                <button
                                  type="button"
                                  data-testid={`personal-edit-${item.id}`}
                                  disabled={saving}
                                  onClick={() => openEditForm(item)}
                                  className="px-2 py-0.5 rounded border border-neutral-700 hover:border-emerald-500 text-[11px] text-neutral-200"
                                >
                                  고치기
                                </button>
                                <button
                                  type="button"
                                  data-testid={`personal-delete-${item.id}`}
                                  disabled={saving}
                                  onClick={() => void handleDeleteItem(item.id)}
                                  className="px-2 py-0.5 rounded border border-rose-800/80 hover:bg-rose-900/50 text-[11px] text-rose-300"
                                >
                                  지우기
                                </button>
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </section>
            )}

            {/* 마일스톤 요약 */}
            {layers.milestone && (
              <section
                data-testid="milestone-schedule-panel"
                className="rounded-lg border border-amber-900/60 bg-neutral-900/50 p-3 space-y-2"
              >
                <h3 className="text-xs font-bold text-amber-300">
                  마일스톤 ({boardSchedule.milestones.length}건)
                </h3>
                {boardSchedule.milestones.length === 0 ? (
                  <p className="text-xs text-neutral-500">표시할 마일스톤이 없습니다.</p>
                ) : (
                  <ul className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                    {boardSchedule.milestones.map((ms) => (
                      <li
                        key={ms.id}
                        data-testid={`milestone-item-${ms.id}`}
                        className="p-2 rounded border border-neutral-800 bg-neutral-950/80 flex items-center justify-between gap-2 text-xs"
                      >
                        <div className="min-w-0">
                          <span className="font-semibold text-amber-200">{ms.name}</span>
                          <span className="text-[11px] text-neutral-400 ml-2">
                            {ms.dueDate ? `기한 ${ms.dueDate}` : "기한 없음"}
                          </span>
                        </div>
                        <span className="text-[11px] tabular-nums px-2 py-0.5 rounded bg-neutral-900 text-neutral-300 shrink-0">
                          {ms.completed}/{ms.total}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </div>

          {/* 날짜 없는 작업 접기 칸 */}
          {(layers.work || layers.queue) && filteredUndatedItems.length > 0 && (
            <details
              data-testid="schedule-undated"
              className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-3 text-xs"
            >
              <summary className="cursor-pointer font-medium text-neutral-300">
                날짜 없음 ({filteredUndatedItems.length}건)
              </summary>
              <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {filteredUndatedItems.map((item) => (
                  <div key={item.id} className="p-2 rounded border border-neutral-800 bg-neutral-950/70">
                    <div className="font-medium text-neutral-200 truncate">{item.title}</div>
                    <div className="text-[11px] text-neutral-500">{item.issue || item.id}</div>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

    </>
  )
}
