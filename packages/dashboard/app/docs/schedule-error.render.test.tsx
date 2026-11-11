import assert from "node:assert/strict"
import { test } from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { personalLayerStateFromResponse, ScheduleView } from "../schedule/ScheduleView"
import { shouldDiscardPersonalDraft } from "../schedule/schedule-view-model"
import { createLatestRequestGuard } from "../schedule/useScheduleView"
import { ScheduleControls } from "../schedule/ScheduleControls"
import { ScheduleCalendarSection } from "../schedule/ScheduleCalendarSection"
import { ScheduleListSection } from "../schedule/ScheduleListSection"

test("non-identity 403 displays a retryable error instead of an identity prompt", () => {
  const error = personalLayerStateFromResponse(403, { error: "origin-not-allowed" })
  assert.equal(error.status, "unavailable")
  assert.equal(error.canMutate, false)
  assert.equal(personalLayerStateFromResponse(403, { error: "personal-schedule-identity-required" }).status, "identity-required")
  const html = renderToStaticMarkup(<ScheduleView hasBoard={false} initialPersonalLayerState={error} />)
  assert.match(html, /개인 일정을 불러오지 못했습니다/)
  assert.match(html, /다시 시도/)
  assert.doesNotMatch(html, /로그인 연결 필요/)
})

test("a draft is discarded when the authenticated identity changes or can no longer be verified", () => {
  const readyA = personalLayerStateFromResponse(200, { user: "person-a", items: [] })
  const readyB = personalLayerStateFromResponse(200, { user: "person-b", items: [] })
  const unavailable = personalLayerStateFromResponse(500, {})
  assert.equal(shouldDiscardPersonalDraft("person-a", readyA), false)
  assert.equal(shouldDiscardPersonalDraft("person-a", readyB), true)
  assert.equal(shouldDiscardPersonalDraft("person-a", unavailable), true)
  assert.equal(shouldDiscardPersonalDraft("person-a", personalLayerStateFromResponse(403, { error: "personal-schedule-identity-required" })), true)
})

test("retries ignore late results and errors from the previous identity", async () => {
  const guard = createLatestRequestGuard()
  const shown: string[] = []
  const delayed = <T,>() => {
    let resolve!: (value: T) => void
    let reject!: (error: Error) => void
    const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
    return { promise, resolve, reject }
  }
  const load = async (response: Promise<string>) => {
    const generation = guard.begin()
    try {
      const user = await response
      if (guard.isCurrent(generation)) shown.push(user)
    } catch {
      if (guard.isCurrent(generation)) shown.push("error")
    }
  }
  const old = delayed<string>(), current = delayed<string>()
  const oldTask = load(old.promise), currentTask = load(current.promise)
  current.resolve("person-b")
  await currentTask
  old.resolve("person-a")
  await oldTask
  assert.deepEqual(shown, ["person-b"])

  const oldError = delayed<string>(), newest = delayed<string>()
  const oldErrorTask = load(oldError.promise), newestTask = load(newest.promise)
  newest.resolve("person-b")
  await newestTask
  oldError.reject(new Error("old request failed"))
  await oldErrorTask
  assert.deepEqual(shown, ["person-b", "person-b"])

  const staleRead = delayed<string>()
  const staleReadTask = load(staleRead.promise)
  const mutation = guard.begin()
  staleRead.resolve("stale after mutation")
  await staleReadTask
  assert.equal(guard.isCurrent(mutation), true)
  assert.deepEqual(shown, ["person-b", "person-b"])
})

test("a concurrent change during GET shows retry, while YAML warnings lock editing", () => {
  const conflict = personalLayerStateFromResponse(409, { error: "personal-schedule-conflict" })
  assert.equal(conflict.status, "unavailable")
  assert.equal(conflict.canMutate, false)
  const html = renderToStaticMarkup(<ScheduleView hasBoard={false} initialPersonalLayerState={conflict} />)
  assert.match(html, /다시 시도/)
  assert.doesNotMatch(html, /편집 잠금/)
  const warned = personalLayerStateFromResponse(409, { error: "personal-schedule-has-warnings", warnings: ["Unsupported field"] })
  assert.equal(warned.status, "warnings-locked")
  assert.equal(warned.canMutate, false)
})

test("saving disables the entire draft and every personal edit entry point", () => {
  const item = { id: "item-1", title: "Meeting", start: "2026-11-11", end: "2026-11-11", allDay: true, memo: "" }
  const view = {
    mode: "calendar", unit: "month", layers: { personal: true, work: false, milestone: false, queue: false },
    workFilter: "open", layerCounts: { personal: 1, work: 0, milestone: 0, queue: 0 },
    canMutatePersonal: true, formOpen: true, saving: true, formError: null,
    form: { editingId: "item-1", title: "Draft", allDay: true, startDate: "2026-11-11", endDate: "2026-11-11", startTime: "09:00", endTime: "10:00", memo: "draft" },
    personalItems: [item], personalWarnings: [], calendarWeeks: [], selectedDayCell: null, selectedWorkEvent: null,
    boardSchedule: { todayDate: "2026-11-11", milestones: [], workItems: [], undatedItems: [] },
    filteredUndatedItems: [], periodTitle: "November", hasBoard: false,
  } as any
  const controls = renderToStaticMarkup(<ScheduleControls view={view} />)
  assert.match(controls, /<fieldset disabled=""/)
  assert.match(controls, /data-testid="personal-schedule-add-btn" disabled=""/)
  const calendar = renderToStaticMarkup(<ScheduleCalendarSection view={view} />)
  assert.match(calendar, /data-testid="personal-edit-item-1" disabled=""/)
  assert.match(calendar, /data-testid="personal-delete-item-1" disabled=""/)
  const list = renderToStaticMarkup(<ScheduleListSection view={{ ...view, mode: "list" }} />)
  assert.match(list, /<button type="button" disabled=""[^>]*><strong>Meeting/)
  const readyControls = renderToStaticMarkup(<ScheduleControls view={{ ...view, saving: false }} />)
  assert.match(readyControls, /<fieldset class="space-y-3"/)
})
