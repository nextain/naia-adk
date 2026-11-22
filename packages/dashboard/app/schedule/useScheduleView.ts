"use client"

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { PersonalScheduleItem } from "@naia-adk/core/src/personal-schedule"
import {
  buildCalendarCells, DEFAULT_SCHEDULE_LAYERS, formatCalendarPeriodTitle, localDateOnly,
  layoutCalendarWeeks, placeScheduleOnCalendar, readStoredCalendarUnit, readStoredDisplayMode,
  readStoredScheduleLayers, readStoredShowRegular, readStoredWorkFilter, writeStoredCalendarUnit,
  writeStoredDisplayMode, writeStoredScheduleLayers, writeStoredShowRegular, writeStoredWorkFilter,
  type BoardScheduleProjection, type CalendarCellEvent, type CalendarDayCell, type CalendarUnit,
  type CompanyScheduleItem, type ScheduleDisplayMode, type ScheduleLayerKey, type ScheduleLayers,
  type WorkScheduleFilter,
} from "./schedule-calendar"
import {
  buildInitialPersonalLayerState, emptyFormState, formStateFromItem, personalLayerStateFromResponse,
  requestCompanySchedule, shouldDiscardPersonalDraft, type CompanyLayerStatus, type FormState,
  type PersonalLayerState, type ScheduleViewProps,
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

export function companyItemToCalendarEvent(item: CompanyScheduleItem): CalendarCellEvent {
  const rawEnd = item.endDate || item.startDate
  const startDate = item.startDate <= rawEnd ? item.startDate : rawEnd
  const endDate = item.startDate <= rawEnd ? rawEnd : item.startDate
  const allDay = !item.startTime && !item.endTime && !(item.times && item.times.length > 0)
  const timeLabel = allDay
    ? "종일"
    : item.times && item.times.length > 1
      ? item.times.join(", ")
      : item.startTime && item.endTime && item.startTime !== item.endTime
        ? `${item.startTime}~${item.endTime}`
        : item.startTime ?? item.endTime ?? "종일"
  const completed = Boolean(
    item.status && /^(?:완료|발송\s*완료|출원\s*완료|제출\s*완료)(?:\s|\(|$)/.test(item.status.trim()),
  )
  return {
    key: `company-${item.id}-${startDate}`,
    id: item.id,
    layer: "company",
    title: item.title,
    startDate,
    endDate,
    spanPosition: startDate === endDate ? "single" : "start",
    allDay,
    timeLabel,
    subtitle: [
      item.kind === "regular" ? "정기 반복" : "회사 일정",
      item.roleLabel || item.role,
      item.state || item.status,
    ]
      .filter(Boolean)
      .join(" · "),
    overdue: false,
    completed,
    companyItem: item,
  }
}

export function useScheduleView(props: ScheduleViewProps) {
  const {
    hasBoard,
    initialMode,
    initialUnit,
    initialLayers,
    initialWorkFilter,
    initialShowRegular,
    initialAnchorDate,
    initialPersonalItems,
    initialPersonalWarnings,
    initialPersonalIdentityRequired = false,
    initialPersonalLayerState,
    initialCompanyItems,
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
  const [showRegular, setShowRegularState] = useState<boolean>(initialShowRegular ?? false)
  const [anchorDate, setAnchorDate] = useState<string>(initialDeepLink?.date ?? defaultToday)
  const [anchorReady, setAnchorReady] = useState<boolean>(
    initialAnchorDate !== undefined || initialBoardSchedule !== undefined || initialDeepLink?.date !== undefined,
  )
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

  const [companyItems, setCompanyItems] = useState<CompanyScheduleItem[]>(initialCompanyItems ?? [])
  const [companyStatus, setCompanyStatus] = useState<CompanyLayerStatus>(
    initialCompanyItems !== undefined ? "ready" : "loading",
  )
  const companyRequests = useRef(createLatestRequestGuard())
  const skipInitialCompanyFetch = useRef(initialCompanyItems !== undefined)

  // Restore saved preferences first. A detail link overrides them for this visit only.
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
    if (initialShowRegular === undefined) {
      setShowRegularState(readStoredShowRegular())
    }

    if (initialDeepLink === undefined && typeof window !== "undefined") {
      const link = readScheduleDeepLink(window.location.search)
      if (link) {
        pendingDeepLink.current = link
        setAnchorDate(link.date)
        setAnchorReady(true)
      }
    }
    const link = pendingDeepLink.current
    if (link) {
      setLayersState((prev) => (prev[link.layer] ? prev : { ...prev, [link.layer]: true }))
      setModeState("calendar")
      if (link.layer === "work" || link.layer === "queue") setWorkFilterState("all")
      if (link.layer === "company" && (link.id.startsWith("reg:") || link.id.startsWith("company:reg:"))) {
        setShowRegularState(true)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (initialAnchorDate !== undefined || initialBoardSchedule !== undefined) return
    const today = localDateOnly(new Date())
    if (!today) return
    setAnchorDate(pendingDeepLink.current?.date ?? today)
    setBoardSchedule((current) => ({ ...current, todayDate: today }))
    setAnchorReady(true)
  }, [initialAnchorDate, initialBoardSchedule])

  const [formOpen, setFormOpen] = useState<boolean>(() =>
    buildInitialPersonalLayerState(props).canMutate ? initialFormOpen : false,
  )
  const [form, setForm] = useState<FormState>(() => emptyFormState(defaultToday))
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState<boolean>(false)
  const [selectedWorkEvent, setSelectedWorkEvent] = useState<CalendarCellEvent | null>(initialSelectedEvent)
  const [dayListDate, setDayListDate] = useState<string | null>(initialDayListDate)

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

  const toggleRegular = () => {
    setShowRegularState((prev) => {
      const next = !prev
      writeStoredShowRegular(next)
      if (next && !layers.company) {
        setLayersState((prevLayers) => {
          const nextLayers = { ...prevLayers, company: true }
          writeStoredScheduleLayers(nextLayers)
          return nextLayers
        })
      }
      return next
    })
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

  const baseGridCells = useMemo(
    () => buildCalendarCells(anchorDate, unit, boardSchedule.todayDate),
    [anchorDate, unit, boardSchedule.todayDate],
  )
  const visibleFrom = baseGridCells[0]?.date ?? anchorDate
  const visibleTo = baseGridCells[baseGridCells.length - 1]?.date ?? anchorDate

  const loadCompanySchedule = useCallback(
    async (from = visibleFrom, to = visibleTo) => {
      const generation = companyRequests.current.begin()
      setCompanyStatus("loading")
      const result = await requestCompanySchedule(from, to, fetchFn ?? fetch)
      if (!companyRequests.current.isCurrent(generation)) return
      if (result.status === "ready") {
        setCompanyItems(result.items)
      }
      setCompanyStatus(result.status)
    },
    [fetchFn, visibleFrom, visibleTo],
  )

  useEffect(() => {
    if (!anchorReady) return
    if (skipInitialCompanyFetch.current) {
      skipInitialCompanyFetch.current = false
      return
    }
    void loadCompanySchedule(visibleFrom, visibleTo)
  }, [anchorReady, visibleFrom, visibleTo, loadCompanySchedule])

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
    return placeScheduleOnCalendar(baseGridCells, {
      layers,
      workFilter,
      includeRegular: showRegular,
      personalItems,
      companyItems,
      workItems: boardSchedule.workItems,
      milestones: boardSchedule.milestones,
    })
  }, [baseGridCells, layers, workFilter, showRegular, personalItems, companyItems, boardSchedule.workItems, boardSchedule.milestones])

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
    const sourceLoaded =
      link.layer === "personal"
        ? !personalLoading
        : link.layer === "company"
          ? companyStatus !== "loading"
          : boardStatus !== "loading"
    const result = resolveDeepLink(calendarCells, link, {
      sourceLoaded,
      layerShown: layers[link.layer],
      mode,
      workFilter,
    })
    if (result.status === "wait") return
    pendingDeepLink.current = null
    if (result.status === "found") handleSelectCalendarEvent(result.event)
    else setDeepLinkMissing(true)
  }, [calendarCells, handleSelectCalendarEvent, personalLoading, companyStatus, boardStatus, layers, mode, workFilter])

  const companyMdItems = useMemo(
    () => companyItems.filter((c) => c.kind !== "regular"),
    [companyItems],
  )
  const regularItems = useMemo(
    () => companyItems.filter((c) => c.kind === "regular"),
    [companyItems],
  )

  const layerCounts: Record<ScheduleLayerKey, number> = {
    personal: personalItems.length,
    company: companyMdItems.length,
    work: filteredWorkDocCount,
    milestone: boardSchedule.milestones.length,
    queue: filteredQueueCount,
  }

  const periodTitle = formatCalendarPeriodTitle(anchorDate, unit)

  return {
    hasBoard, mode, unit, layers, workFilter, showRegular, toggleRegular, anchorDate, setAnchorDate,
    userLabel, personalIdentityRequired, personalWarningsLocked, personalLoading,
    personalUnavailable, canMutatePersonal, personalItems, personalWarnings,
    companyItems, companyMdItems, regularItems, regularCount: regularItems.length, companyStatus, loadCompanySchedule,
    boardSchedule, boardStatus, loadBoardSchedule, formOpen, setFormOpen, form, setForm, formError, saving,
    selectedWorkEvent, setSelectedWorkEvent, setDayListDate, setMode, setUnit,
    toggleLayer, setWorkFilter, loadPersonal, openAddForm, openEditForm,
    handleSaveForm, handleDeleteItem, filteredUndatedItems, calendarWeeks,
    selectedDayCell, handleSelectCalendarEvent, layerCounts, periodTitle,
    deepLinkMissing, dismissDeepLinkMissing: () => setDeepLinkMissing(false),
  }
}
