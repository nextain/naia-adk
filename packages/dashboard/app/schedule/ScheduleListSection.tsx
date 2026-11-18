"use client"
import React from "react"
import type { useScheduleView } from "./useScheduleView"
import { companyItemToCalendarEvent } from "./useScheduleView"
import { ScheduleDetailDialog } from "./ScheduleDetailDialog"
import { PERSONAL_IDENTITY_REQUIRED_NOTICE, PERSONAL_LOADING_NOTICE, PERSONAL_WARNINGS_LOCKED_NOTICE, MAX_VISIBLE_PERSONAL_WARNINGS } from "./schedule-view-model"

type View = ReturnType<typeof useScheduleView>

const workBoardIframeSrc = (_view?: string) => "/board/index.html?view=schedule"

export function ScheduleListSection({ view }: { view: View }) {
  const {
    hasBoard, mode, layers, userLabel,
    personalIdentityRequired, personalWarningsLocked, personalLoading, personalUnavailable,
    canMutatePersonal, personalItems, personalWarnings, loadPersonal, saving,
    openEditForm,
  } = view
  return (
    <>
      {/* 목록 보기일 때 개인 일정 목록 표시 */}
      {mode === "list" && layers.personal && (
        <div data-testid="schedule-list-personal" className="px-3 py-2.5 sm:px-6 border-b border-neutral-800 bg-neutral-900/40 space-y-2">
          {personalLoading ? (
            <p data-testid="personal-loading-notice" className="text-xs text-neutral-400">
              {PERSONAL_LOADING_NOTICE}
            </p>
          ) : personalUnavailable ? (
            <p role="alert" className="text-xs text-amber-300">
              개인 일정을 불러오지 못했습니다. <button type="button" className="underline" onClick={() => void loadPersonal()}>다시 시도</button>
            </p>
          ) : personalIdentityRequired ? (
            <p data-testid="personal-identity-required-notice" className="text-xs text-neutral-400">
              {PERSONAL_IDENTITY_REQUIRED_NOTICE}
            </p>
          ) : (
            <>
              <div className="flex items-center justify-between mb-1.5">
                <h2 className="text-xs font-bold text-emerald-300">
                  개인 일정 ({userLabel ? `${userLabel} · ` : ""}{personalItems.length}건)
                </h2>
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
                <p className="text-xs text-neutral-500">등록된 개인 일정이 없습니다.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {personalItems.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      disabled={saving}
                      onClick={() => {
                        if (canMutatePersonal) openEditForm(item)
                      }}
                      className="px-2.5 py-1 rounded border border-emerald-700/70 bg-emerald-950/70 text-emerald-100 text-xs text-left hover:bg-emerald-900/70"
                    >
                      <strong>{item.title}</strong>{" "}
                      <span className="opacity-80">
                        ({item.start === item.end ? item.start : `${item.start}~${item.end}`})
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* 목록 보기일 때 회사·정기 일정 목록 표시 */}
      {mode === "list" && layers.company && (
        <div data-testid="schedule-list-company" className="px-3 py-2.5 sm:px-6 border-b border-neutral-800 bg-neutral-900/40 space-y-2">
          <div className="flex items-center justify-between mb-1.5">
            <h2 className="text-xs font-bold text-violet-300">
              회사 일정 ({(view.companyMdItems ?? []).length}건
              {view.showRegular ? ` · 정기 반복 ${(view.regularItems ?? []).length}건` : ""})
            </h2>
          </div>
          {(view.companyMdItems ?? []).length === 0 && (!view.showRegular || (view.regularItems ?? []).length === 0) ? (
            <p className="text-xs text-neutral-500">
              {view.companyStatus === "loading" ? "회사 일정 불러오는 중" : "이 기간에 등록된 회사 일정이 없습니다."}
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {[
                ...(view.companyMdItems ?? []),
                ...(view.showRegular ? (view.regularItems ?? []) : []),
              ].map((item) => (
                <button
                  key={item.id}
                  type="button"
                  data-testid={`list-company-item-${item.id}`}
                  onClick={() => view.setSelectedWorkEvent?.(companyItemToCalendarEvent(item))}
                  className={`px-2.5 py-1 rounded border text-xs text-left cursor-pointer ${
                    item.kind === "regular"
                      ? "border-fuchsia-700/70 bg-fuchsia-950/70 text-fuchsia-100 hover:bg-fuchsia-900/70"
                      : "border-violet-700/70 bg-violet-950/70 text-violet-100 hover:bg-violet-900/70"
                  }`}
                >
                  <strong>{item.title}</strong>{" "}
                  <span className="opacity-80">
                    ({item.startDate === item.endDate ? item.startDate : `${item.startDate}~${item.endDate}`}
                    {item.startTime ? ` ${item.startTime}` : ""})
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {mode === "list" && (
        <ScheduleDetailDialog
          event={view.selectedWorkEvent ?? null}
          onClose={() => view.setSelectedWorkEvent?.(null)}
        />
      )}

      {/* 기존 작업보드 일정 목록 보기 iframe (목록 보기에서 표시, 달력 보기에서는 숨겨 두어 즉시 전환 및 기존 시험 호환 유지) */}
      {hasBoard !== false && (
        <iframe
          src={workBoardIframeSrc("schedule")}
          title="작업보드"
          className={
            mode === "list"
              ? "block flex-1 min-h-[calc(100dvh-7rem)] w-full border-0 bg-neutral-950"
              : "hidden"
          }
        />
      )}
    </>
  )
}
