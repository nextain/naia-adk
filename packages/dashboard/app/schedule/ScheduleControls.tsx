"use client"
import React from "react"
import type { useScheduleView } from "./useScheduleView"
import { PERSONAL_LOADING_NOTICE } from "./schedule-view-model"
import { LAYER_LABELS, type ScheduleLayerKey } from "./schedule-calendar"

type View = ReturnType<typeof useScheduleView>
const LAYER_DOT_CLASS: Record<ScheduleLayerKey, string> = {
  personal: "bg-emerald-400",
  work: "bg-sky-400",
  milestone: "bg-amber-400",
  queue: "bg-slate-400",
}

const LAYER_ACTIVE_BTN_CLASS: Record<ScheduleLayerKey, string> = {
  personal: "bg-emerald-950/80 border-emerald-500/80 text-emerald-200",
  work: "bg-sky-950/80 border-sky-500/80 text-sky-200",
  milestone: "bg-amber-950/80 border-amber-500/80 text-amber-200",
  queue: "bg-slate-900/90 border-slate-500/80 text-slate-200",
}

const SCHEDULE_LAYER_KEYS: ScheduleLayerKey[] = ["personal", "work", "milestone", "queue"]


export function ScheduleControls({ view }: { view: View }) {
  const {
    mode, layers, userLabel, personalIdentityRequired,
    personalWarningsLocked, personalLoading, personalUnavailable, canMutatePersonal,
    formOpen, setFormOpen, form, setForm,
    formError, saving, setMode, toggleLayer,
    openAddForm, handleSaveForm, handleDeleteItem, layerCounts,
  } = view
  return (
    <>
      {!formOpen && formError && <p role="alert" className="px-3 py-2 text-sm text-red-300">{formError}</p>}
      {/* 상단 제어 막대: 달력/목록 전환 + 3개 겹 켜고 끄기 + 개인 일정 추가 */}
      <div className="border-b border-neutral-800 bg-neutral-950/95 px-3 py-2.5 sm:px-6 flex flex-wrap items-center gap-2 sm:gap-3">
        <div className="flex items-center gap-2">
          <h1 className="text-base font-bold text-white">일정</h1>
          {personalLoading ? (
            <span
              data-testid="schedule-user-badge"
              className="px-2 py-0.5 rounded-full text-xs bg-neutral-900 border border-neutral-700 text-neutral-400"
            >
              {PERSONAL_LOADING_NOTICE}
            </span>
          ) : personalUnavailable ? (
            <span className="px-2 py-0.5 text-xs text-amber-300">내 일정: 불러오기 실패</span>
          ) : personalIdentityRequired ? (
            <span
              data-testid="schedule-user-badge"
              className="px-2 py-0.5 rounded-full text-xs bg-neutral-900 border border-neutral-700 text-neutral-400"
            >
              내 일정: 꺼짐 (로그인 연결 필요)
            </span>
          ) : personalWarningsLocked ? (
            <span
              data-testid="schedule-user-badge"
              className="px-2 py-0.5 rounded-full text-xs bg-amber-950/70 border border-amber-700/60 text-amber-300"
            >
              내 일정: 편집 잠금
            </span>
          ) : (
            <span
              data-testid="schedule-user-badge"
              className="px-2 py-0.5 rounded-full text-xs bg-emerald-950/70 border border-emerald-700/60 text-emerald-300"
              title="내 일정"
            >
              내 일정{userLabel ? ` · ${userLabel}` : ""}
            </span>
          )}
        </div>

        {/* 보기 방식 전환 (달력 / 목록) */}
        <div
          role="group"
          aria-label="일정 보기 방식"
          className="inline-flex rounded-lg border border-neutral-800 bg-neutral-900 p-0.5"
        >
          <button
            type="button"
            data-testid="schedule-mode-calendar"
            aria-pressed={mode === "calendar"}
            onClick={() => setMode("calendar")}
            className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
              mode === "calendar" ? "bg-neutral-700 text-white" : "text-neutral-400 hover:text-white"
            }`}
          >
            달력 보기
          </button>
          <button
            type="button"
            data-testid="schedule-mode-list"
            aria-pressed={mode === "list"}
            onClick={() => setMode("list")}
            className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
              mode === "list" ? "bg-neutral-700 text-white" : "text-neutral-400 hover:text-white"
            }`}
          >
            목록 보기
          </button>
        </div>

        {/* 네 겹 켜고 끄기 단추 */}
        <div role="group" aria-label="일정 겹 켜고 끄기" className="flex flex-wrap items-center gap-1.5">
          {SCHEDULE_LAYER_KEYS.map((key) => {
            const active = layers[key]
            return (
              <button
                key={key}
                type="button"
                data-testid={`schedule-layer-${key}`}
                aria-pressed={active}
                onClick={() => toggleLayer(key)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium transition-colors ${
                  active
                    ? LAYER_ACTIVE_BTN_CLASS[key]
                    : "bg-neutral-900/70 border-neutral-800 text-neutral-500 hover:text-neutral-300"
                }`}
              >
                <span className={`w-2 h-2 rounded-full ${active ? LAYER_DOT_CLASS[key] : "bg-neutral-600"}`} />
                <span>{LAYER_LABELS[key]}</span>
                <span className="text-[11px] tabular-nums opacity-80">{layerCounts[key]}</span>
              </button>
            )
          })}
        </div>

        {canMutatePersonal && (
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              data-testid="personal-schedule-add-btn"
              disabled={saving}
              onClick={() => openAddForm()}
              className="px-3 py-1.5 rounded-md bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-semibold transition-colors"
            >
              + 개인 일정 추가
            </button>
          </div>
        )}
      </div>

      {/* 개인 일정 추가·고치기·지우기 창 */}
      {formOpen && canMutatePersonal && (
        <form
          data-testid="personal-schedule-form"
          onSubmit={handleSaveForm}
          className="mx-3 mt-3 sm:mx-6 p-4 rounded-lg border border-emerald-700/70 bg-neutral-900/95 shadow-lg space-y-3"
        >
          <fieldset disabled={saving} className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-emerald-300">
              {form.editingId ? "개인 일정 고치기" : "새 개인 일정 추가"}
            </h2>
          </div>

          {formError && (
            <p data-testid="personal-form-error" className="text-xs text-rose-400">
              {formError}
            </p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <label className="block sm:col-span-2">
              <span className="block text-xs text-neutral-300 mb-1">제목 *</span>
              <input
                type="text"
                required
                data-testid="personal-input-title"
                value={form.title}
                onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
                placeholder="예: 주간 점검 회의"
                className="w-full px-2.5 py-1.5 rounded border border-neutral-700 bg-neutral-950 text-xs text-white focus:outline-none focus:border-emerald-500"
              />
            </label>

            <label className="flex items-center gap-2 pt-5 cursor-pointer select-none">
              <input
                type="checkbox"
                data-testid="personal-input-allday"
                checked={form.allDay}
                onChange={(e) => setForm((prev) => ({ ...prev, allDay: e.target.checked }))}
                className="accent-emerald-500"
              />
              <span className="text-xs text-neutral-200">종일 일정</span>
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <label className="block">
              <span className="block text-xs text-neutral-300 mb-1">시작 날짜 *</span>
              <input
                type="date"
                required
                data-testid="personal-input-start-date"
                value={form.startDate}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    startDate: e.target.value,
                    endDate: prev.endDate < e.target.value ? e.target.value : prev.endDate,
                  }))
                }
                className="w-full px-2.5 py-1.5 rounded border border-neutral-700 bg-neutral-950 text-xs text-white"
              />
            </label>

            {!form.allDay && (
              <label className="block">
                <span className="block text-xs text-neutral-300 mb-1">시작 시각</span>
                <input
                  type="time"
                  data-testid="personal-input-start-time"
                  value={form.startTime}
                  onChange={(e) => setForm((prev) => ({ ...prev, startTime: e.target.value }))}
                  className="w-full px-2.5 py-1.5 rounded border border-neutral-700 bg-neutral-950 text-xs text-white"
                />
              </label>
            )}

            <label className="block">
              <span className="block text-xs text-neutral-300 mb-1">끝 날짜</span>
              <input
                type="date"
                required
                data-testid="personal-input-end-date"
                value={form.endDate}
                onChange={(e) => setForm((prev) => ({ ...prev, endDate: e.target.value }))}
                className="w-full px-2.5 py-1.5 rounded border border-neutral-700 bg-neutral-950 text-xs text-white"
              />
            </label>

            {!form.allDay && (
              <label className="block">
                <span className="block text-xs text-neutral-300 mb-1">끝 시각</span>
                <input
                  type="time"
                  data-testid="personal-input-end-time"
                  value={form.endTime}
                  onChange={(e) => setForm((prev) => ({ ...prev, endTime: e.target.value }))}
                  className="w-full px-2.5 py-1.5 rounded border border-neutral-700 bg-neutral-950 text-xs text-white"
                />
              </label>
            )}
          </div>

          <label className="block">
            <span className="block text-xs text-neutral-300 mb-1">메모</span>
            <textarea
              rows={2}
              data-testid="personal-input-memo"
              value={form.memo}
              onChange={(e) => setForm((prev) => ({ ...prev, memo: e.target.value }))}
              placeholder="참고 메모나 준비물"
              className="w-full px-2.5 py-1.5 rounded border border-neutral-700 bg-neutral-950 text-xs text-white focus:outline-none focus:border-emerald-500"
            />
          </label>

          <div className="flex items-center gap-2 justify-end">
            {form.editingId && (
              <button
                type="button"
                disabled={saving}
                data-testid="personal-delete-btn"
                onClick={() => void handleDeleteItem(form.editingId!)}
                className="px-3 py-1.5 rounded bg-rose-800 hover:bg-rose-700 text-white text-xs font-medium mr-auto"
              >
                지우기
              </button>
            )}
            <button
              type="button"
              data-testid="personal-cancel-btn"
              onClick={() => setFormOpen(false)}
              className="px-3 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:text-white text-xs"
            >
              취소
            </button>
            <button
              type="submit"
              disabled={saving}
              data-testid="personal-submit-btn"
              className="px-3 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-semibold"
            >
              {form.editingId ? "고치기 저장" : "추가 저장"}
            </button>
          </div>
          </fieldset>
        </form>
      )}

    </>
  )
}
