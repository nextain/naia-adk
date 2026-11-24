"use client"

import React from "react"
import { useScheduleView } from "./useScheduleView"
import { ScheduleControls } from "./ScheduleControls"
import { ScheduleCalendarSection } from "./ScheduleCalendarSection"
import { ScheduleListSection } from "./ScheduleListSection"
import { BoardScheduleStatus } from "./BoardScheduleStatus"
import { deepLinkMissingNotice } from "./schedule-deep-link"
import { tFor } from "../i18n/index.ts"
import { useOptionalLocale } from "../i18n/provider.tsx"
import type { ScheduleViewProps } from "./schedule-view-model"
export {
  PERSONAL_IDENTITY_REQUIRED_NOTICE, PERSONAL_WARNINGS_LOCKED_NOTICE, PERSONAL_LOADING_NOTICE,
  MAX_VISIBLE_PERSONAL_WARNINGS, personalLayerStateFromResponse,
} from "./schedule-view-model"
export type { PersonalLayerStatus, PersonalLayerState, ScheduleViewProps } from "./schedule-view-model"

export function ScheduleView(props: ScheduleViewProps) {
  const ctxLocale = useOptionalLocale()
  const locale = ctxLocale ?? props.locale ?? "ko"
  const t = tFor(locale)
  const view = useScheduleView({ ...props, locale })
  return (
    <div data-testid="schedule-view" className="flex flex-col min-h-[calc(100dvh-3.5rem)] bg-neutral-950 text-neutral-100">
      <ScheduleControls view={view} />
      <BoardScheduleStatus status={view.boardStatus} retry={() => void view.loadBoardSchedule()} />
      {view.deepLinkMissing && (
        <p role="status" className="px-3 py-2 text-sm text-amber-300">
          {deepLinkMissingNotice(locale)}{" "}
          <button type="button" className="underline" onClick={view.dismissDeepLinkMissing}>{t("sched.deepLinkDismiss")}</button>
        </p>
      )}
      <ScheduleCalendarSection view={view} />
      <ScheduleListSection view={view} />
    </div>
  )
}
