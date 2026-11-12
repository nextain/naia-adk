"use client"

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { PersonalScheduleItem } from "@naia-adk/core/src/personal-schedule"
import {
  buildCalendarCells, DEFAULT_SCHEDULE_LAYERS, formatCalendarPeriodTitle, localDateOnly,
  layoutCalendarWeeks, placeScheduleOnCalendar, readStoredCalendarUnit, readStoredDisplayMode,
  readStoredScheduleLayers, readStoredWorkFilter, writeStoredCalendarUnit, writeStoredDisplayMode,
  writeStoredScheduleLayers, writeStoredWorkFilter, type BoardScheduleProjection,
  type CalendarCellEvent, type CalendarDayCell, type CalendarUnit, type ScheduleDisplayMode,
  type ScheduleLayerKey, type ScheduleLayers, type WorkScheduleFilter,
} from "./schedule-calendar"
import {
  buildInitialPersonalLayerState, emptyFormState, formStateFromItem, personalLayerStateFromResponse, shouldDiscardPersonalDraft,
  type FormState, type PersonalLayerState, type ScheduleViewProps,
} from "./schedule-view-model"
import { requestBoardSchedule, retainLocalToday, type BoardScheduleStatus } from "./schedule-board-state"
import { readScheduleDeepLink, resolveDeepLink, type ScheduleLinkTarget } from "./schedule-deep-link"

export function createLatestRequestGuard() {
  let generation = 0
  return {
    begin: () => ++generation,
    isCurrent: (candidate: number) => candidate === generation,
  }
}

export function useScheduleView(props: ScheduleViewProps) {
  const {
    hasBoard,
    initialMode,
    initialUnit,
    initialLayers,
    initialWorkFilter,
    initialAnchorDate,
    initialPersonalItems,
    initialPersonalWarnings,
    initialPersonalIdentityRequired = false,
    initialPersonalLayerState,
    initialBoardSchedule,
    initialFormOpen = false,
    initialSelectedEvent = null,
    initialDayListDate = null,
    initialDeepLink,
    fetchFn,
  } = props

  const defaultToday = initialAnchorDate ?? initialBoardSchedule?.todayDate ?? "2000-01-01"

  const [mode, setModeState] = useState<ScheduleDisplayMode>(initialMode ?? "calendar")
  const [unit, setUnitState] = useState<CalendarUnit>(initialUnit ?? "month")
  const [layers, setLayersState] = useState<ScheduleLayers>({
    ...DEFAULT_SCHEDULE_LAYERS,
    ...initialLayers,
  })
  const [workFilter, setWorkFilterState] = useState<WorkScheduleFilter>(initialWorkFilter ?? "open")
  const [anchorDate, setAnchorDate] = useState<string>(initialDeepLink?.date ?? defaultToday)
  // Detail link waiting for its event to appear (personal and board data load after mount).
  const pendingDeepLink = useRef<ScheduleLinkTarget | null>(initialDeepLink ?? null)
  const [deepLinkMissing, setDeepLinkMissing] = useState<boolean>(false)

  const [personalState, setPersonalState] = useState<PersonalLayerState>(() => buildInitialPersonalLayerState(props))
  const personalRevision = useRef<string | null>(null)
  const personalUser = useRef<string | null>(personalState.user || null)
  const personalRequests = useRef(createLatestRequestGuard())
  const mutationPending = useRef(false)
  const userKey = personalState.user
  const userLabel = personalState.userLabel
  const personalIdentityRequired = personalState.status === "identity-required"
  const personalWarningsLocked = personalState.status === "warnings-locked"
  const personalLoading = personalState.status === "loading"
  const personalUnavailable = personalState.status === "unavailable"
  const canMutatePersonal = personalState.canMutate
  const personalItems = personalState.items
  const personalWarnings = personalState.warnings

  const [boardSchedule, setBoardSchedule] = useState<BoardScheduleProjection>(
    initialBoardSchedule ?? {
      observedAt: null,
      todayDate: defaultToday,
      workItems: [],
      undatedItems: [],
      milestones: [],
    },
  )
  const [boardStatus, setBoardStatus] = useState<BoardScheduleStatus>(initialBoardSchedule ? "ready" : "loading")

  useEffect(() => {
    if (initialAnchorDate !== undefined || initialBoardSchedule !== undefined) return
    const today = localDateOnly(new Date())
    if (!today) return
    setAnchorDate(pendingDeepLink.current?.date ?? today)
    setBoardSchedule((current) => ({ ...current, todayDate: today }))
  }, [initialAnchorDate, initialBoardSchedule])

  const [formOpen, setFormOpen] = useState<boolean>(() =>
    buildInitialPersonalLayerState(props).canMutate ? initialFormOpen : false,
  )
  const [form, setForm] = useState<FormState>(() => emptyFormState(defaultToday))
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState<boolean>(false)
  const [selectedWorkEvent, setSelectedWorkEvent] = useState<CalendarCellEvent | null>(initialSelectedEvent)
  const [dayListDate, setDayListDate] = useState<string | null>(initialDayListDate)

  // 브라우저 저장소에서 보기 설정 복원 (시험용 초기값이 없을 때)
  useEffect(() => {
    if (initialMode === undefined) {
      setModeState(readStoredDisplayMode())
    }
    if (initialUnit === undefined) {
      setUnitState(readStoredCalendarUnit())
    }
    if (initialLayers === undefined) {
      setLayersState(readStoredScheduleLayers())
    }
    if (initialWorkFilter === undefined) {
      setWorkFilterState(readStoredWorkFilter())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Read the detail link from the address once; show its layer even if the stored view hides it.
  useEffect(() => {
    if (initialDeepLink === undefined && typeof window !== "undefined") {
      const link = readScheduleDeepLink(window.location.search)
      if (link) {
        pendingDeepLink.current = link
        setAnchorDate(link.date)
      }
    }
    const link = pendingDeepLink.current
    if (link) setLayersState((prev) => (prev[link.layer] ? prev : { ...prev, [link.layer]: true }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setMode = (next: ScheduleDisplayMode) => {
    setModeState(next)
    writeStoredDisplayMode(next)
  }

  const setUnit = (next: CalendarUnit) => {
    setUnitState(next)
    writeStoredCalendarUnit(next)
  }

  const toggleLayer = (key: ScheduleLayerKey) => {
    setLayersState((prev) => {
      const next = { ...prev, [key]: !prev[key] }
      writeStoredScheduleLayers(next)
      return next
    })
  }

  const setWorkFilter = (next: WorkScheduleFilter) => {
    setWorkFilterState(next)
    writeStoredWorkFilter(next)
  }

  const loadPersonal = useCallback(async () => {
    const fetcher = fetchFn ?? fetch
    const generation = personalRequests.current.begin()
    try {
      const res = await fetcher("/schedule-personal", { cache: "no-store" })
      const data = await res.json().catch(() => ({}))
      if (!personalRequests.current.isCurrent(generation)) return
      const validRevision = typeof data.revision === "string" && /^"[a-f0-9]{64}"$/.test(data.revision) && typeof data.user === "string" && data.user.length > 0
      personalRevision.current = res.ok && validRevision ? data.revision : null
      const nextState = personalLayerStateFromResponse(res.ok && !validRevision ? 500 : res.status, data)
      if (shouldDiscardPersonalDraft(personalUser.current, nextState)) {
        setFormOpen(false)
        setForm(emptyFormState(localDateOnly(new Date()) ?? "2000-01-01"))
        setFormError(null)
      }
      personalUser.current = nextState.user || null
      setPersonalState(nextState)
    } catch {
      if (!personalRequests.current.isCurrent(generation)) return
      personalRevision.current = null
      personalUser.current = null
      setFormOpen(false)
      setForm(emptyFormState(localDateOnly(new Date()) ?? "2000-01-01"))
      setFormError(null)
      setPersonalState(personalLayerStateFromResponse(500, null))
    }
  }, [fetchFn])

  const loadBoardSchedule = useCallback(async () => {
    setBoardStatus("loading")
    const result = await requestBoardSchedule(fetchFn ?? fetch)
    if (result.status === "ready") setBoardSchedule((current) => retainLocalToday(current, result.data))
    setBoardStatus(result.status)
  }, [fetchFn])

  useEffect(() => {
    if (
      initialPersonalLayerState === undefined &&
      initialPersonalItems === undefined &&
      initialPersonalWarnings === undefined &&
      !initialPersonalIdentityRequired
    ) {
      void loadPersonal()
    }
    if (initialBoardSchedule === undefined) {
      void loadBoardSchedule()
    }
  }, [
    initialPersonalLayerState,
    initialPersonalItems,
    initialPersonalWarnings,
    initialPersonalIdentityRequired,
    initialBoardSchedule,
    loadPersonal,
    loadBoardSchedule,
  ])

  const openAddForm = (dateStr?: string) => {
    if (!canMutatePersonal || mutationPending.current) return
    const targetDate = dateStr ?? anchorDate
    setForm(emptyFormState(targetDate))
    setFormError(null)
    setFormOpen(true)
  }

  const openEditForm = (item: PersonalScheduleItem) => {
    if (!canMutatePersonal || mutationPending.current) return
    setForm(formStateFromItem(item))
    setFormError(null)
    setFormOpen(true)
  }

  const handleSaveForm = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canMutatePersonal || mutationPending.current) return
    if (!personalRevision.current) { setFormError("일정 버전을 확인하지 못했습니다. 새로고침한 뒤 다시 시도하세요."); return }
    const trimmedTitle = form.title.trim()
    if (!trimmedTitle) {
      setFormError("제목을 입력하세요.")
      return
    }
    const start = form.allDay ? form.startDate : `${form.startDate} ${form.startTime || "09:00"}`
    const end = form.allDay ? form.endDate || form.startDate : `${form.endDate || form.startDate} ${form.endTime || form.startTime || "10:00"}`

    mutationPending.current = true
    const generation = personalRequests.current.begin()
    setSaving(true)
    setFormError(null)
    const fetcher = fetchFn ?? fetch
    try {
      const isEdit = Boolean(form.editingId)
      const res = await fetcher("/schedule-personal", {
        method: isEdit ? "PUT" : "POST",
        headers: { "content-type": "application/json", "if-match": personalRevision.current },
        body: JSON.stringify({
          ...(isEdit ? { id: form.editingId } : {}),
          title: trimmedTitle,
          start,
          end,
          allDay: form.allDay,
          memo: form.memo.trim(),
        }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        error?: string
        user?: string
        userLabel?: string
        items?: PersonalScheduleItem[]
        warnings?: string[]
        revision?: string
      }
      if (!personalRequests.current.isCurrent(generation)) return
      if (res.status === 403 && data.error === "personal-schedule-identity-required") {
        setPersonalState(personalLayerStateFromResponse(403, data))
        setFormOpen(false)
        return
      }
      if (res.status === 409 && data.error === "personal-schedule-has-warnings") {
        setPersonalState((prev) =>
          personalLayerStateFromResponse(409, {
            user: data.user ?? prev.user,
            userLabel: data.userLabel ?? prev.userLabel,
            items: Array.isArray(data.items) ? data.items : prev.items,
            warnings: data.warnings,
          }),
        )
        setFormOpen(false)
        return
      }
      if (!res.ok) {
        setFormError(data.error === "personal-schedule-busy"
          ? "다른 변경이 진행 중입니다. 잠시 후 다시 시도하세요."
          : data.error === "personal-schedule-conflict"
            ? "일정 파일이 바뀌었습니다. 새로고침한 뒤 다시 시도하세요."
            : res.status === 403 ? "일정을 저장하지 못했습니다. 연결 설정을 확인하고 다시 시도하세요."
              : (data.error || "일정을 저장하지 못했습니다."))
        return
      }
      if (Array.isArray(data.items) && typeof data.revision === "string" && /^"[a-f0-9]{64}"$/.test(data.revision)) {
        personalRevision.current = data.revision
        setPersonalState((prev) =>
          personalLayerStateFromResponse(res.status, {
            user: data.user ?? prev.user,
            userLabel: data.userLabel ?? prev.userLabel,
            items: data.items,
            warnings: data.warnings,
          }),
        )
      } else {
        await loadPersonal()
      }
      setFormOpen(false)
    } catch {
      if (personalRequests.current.isCurrent(generation)) setFormError("네트워크 오류로 일정을 저장하지 못했습니다.")
    } finally {
      mutationPending.current = false
      setSaving(false)
    }
  }

  const handleDeleteItem = async (id: string) => {
    if (!canMutatePersonal || mutationPending.current) return
    if (!personalRevision.current) { setFormError("일정 버전을 확인하지 못했습니다. 새로고침한 뒤 다시 시도하세요."); return }
    mutationPending.current = true
    const generation = personalRequests.current.begin()
    setSaving(true)
    setFormError(null)
    const fetcher = fetchFn ?? fetch
    try {
      const res = await fetcher(`/schedule-personal?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json", "if-match": personalRevision.current },
        body: JSON.stringify({ id }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        error?: string
        user?: string
        userLabel?: string
        items?: PersonalScheduleItem[]
        warnings?: string[]
        revision?: string
      }
      if (!personalRequests.current.isCurrent(generation)) return
      if (res.status === 403 && data.error === "personal-schedule-identity-required") {
        setPersonalState(personalLayerStateFromResponse(403, data))
        setFormOpen(false)
        return
      }
      if (res.status === 409 && data.error === "personal-schedule-has-warnings") {
        setPersonalState((prev) =>
          personalLayerStateFromResponse(409, {
            user: data.user ?? prev.user,
            userLabel: data.userLabel ?? prev.userLabel,
            items: Array.isArray(data.items) ? data.items : prev.items,
            warnings: data.warnings,
          }),
        )
        setFormOpen(false)
        return
      }
      if (!res.ok) {
        setFormError(data.error === "personal-schedule-busy"
          ? "다른 변경이 진행 중입니다. 잠시 후 다시 시도하세요."
          : data.error === "personal-schedule-conflict"
            ? "일정 파일이 바뀌었습니다. 새로고침한 뒤 다시 시도하세요."
            : res.status === 403 ? "일정을 지우지 못했습니다. 연결 설정을 확인하고 다시 시도하세요."
              : (data.error || "일정을 지우지 못했습니다."))
        return
      }
      if (Array.isArray(data.items) && typeof data.revision === "string" && /^"[a-f0-9]{64}"$/.test(data.revision)) {
        personalRevision.current = data.revision
        setPersonalState((prev) =>
          personalLayerStateFromResponse(res.status, {
            user: data.user ?? prev.user,
            userLabel: data.userLabel ?? prev.userLabel,
            items: data.items,
            warnings: data.warnings,
          }),
        )
      } else {
        await loadPersonal()
      }
      if (form.editingId === id) {
        setFormOpen(false)
      }
    } catch {
      if (personalRequests.current.isCurrent(generation)) setFormError("네트워크 오류로 일정을 지우지 못했습니다.")
    } finally {
      mutationPending.current = false
      setSaving(false)
    }
  }

  const filteredWorkItems = useMemo(
    () =>
      boardSchedule.workItems.filter((w) =>
        workFilter === "all" ? true : !w.completed && !w.cancelled,
      ),
    [boardSchedule.workItems, workFilter],
  )

  const filteredWorkDocCount = useMemo(
    () => filteredWorkItems.filter((w) => w.kind !== "queue").length,
    [filteredWorkItems],
  )

  const filteredQueueCount = useMemo(
    () => filteredWorkItems.filter((w) => w.kind === "queue").length,
    [filteredWorkItems],
  )

  const filteredUndatedItems = useMemo(
    () =>
      boardSchedule.undatedItems.filter((w) => {
        if (w.kind === "queue" ? !layers.queue : !layers.work) return false
        return workFilter === "all" ? true : !w.completed && !w.cancelled
      }),
    [boardSchedule.undatedItems, layers.queue, layers.work, workFilter],
  )

  const calendarCells = useMemo(() => {
    const base = buildCalendarCells(anchorDate, unit, boardSchedule.todayDate)
    return placeScheduleOnCalendar(base, {
      layers,
      workFilter,
      personalItems,
      workItems: boardSchedule.workItems,
      milestones: boardSchedule.milestones,
    })
  }, [anchorDate, unit, boardSchedule.todayDate, layers, workFilter, personalItems, boardSchedule.workItems, boardSchedule.milestones])

  const calendarWeeks = useMemo(
    () => layoutCalendarWeeks(calendarCells, { unit }),
    [calendarCells, unit],
  )

  const selectedDayCell: CalendarDayCell | null = useMemo(
    () => (dayListDate ? calendarCells.find((c) => c.date === dayListDate) ?? null : null),
    [calendarCells, dayListDate],
  )

  const handleSelectCalendarEvent = useCallback(
    (ev: CalendarCellEvent) => {
      if (ev.layer === "personal" && mutationPending.current) return
      setDayListDate(null)
      if (ev.layer === "personal" && ev.personalItem && canMutatePersonal) {
        openEditForm(ev.personalItem)
      } else {
        setSelectedWorkEvent(ev)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canMutatePersonal],
  )

  useEffect(() => {
    const link = pendingDeepLink.current
    if (!link) return
    const result = resolveDeepLink(calendarCells, link, {
      sourceLoaded: link.layer === "personal" ? !personalLoading : boardStatus !== "loading",
      layerShown: layers[link.layer],
    })
    if (result.status === "wait") return
    pendingDeepLink.current = null
    if (result.status === "found") handleSelectCalendarEvent(result.event)
    else setDeepLinkMissing(true)
  }, [calendarCells, handleSelectCalendarEvent, personalLoading, boardStatus, layers])

  const layerCounts: Record<ScheduleLayerKey, number> = {
    personal: personalItems.length,
    work: filteredWorkDocCount,
    milestone: boardSchedule.milestones.length,
    queue: filteredQueueCount,
  }

  const periodTitle = formatCalendarPeriodTitle(anchorDate, unit)

  return {
    hasBoard, mode, unit, layers, workFilter, anchorDate, setAnchorDate,
    userLabel, personalIdentityRequired, personalWarningsLocked, personalLoading,
    personalUnavailable, canMutatePersonal, personalItems, personalWarnings,
    boardSchedule, boardStatus, loadBoardSchedule, formOpen, setFormOpen, form, setForm, formError, saving,
    selectedWorkEvent, setSelectedWorkEvent, setDayListDate, setMode, setUnit,
    toggleLayer, setWorkFilter, loadPersonal, openAddForm, openEditForm,
    handleSaveForm, handleDeleteItem, filteredUndatedItems, calendarWeeks,
    selectedDayCell, handleSelectCalendarEvent, layerCounts, periodTitle,
    deepLinkMissing, dismissDeepLinkMissing: () => setDeepLinkMissing(false),
  }
}
