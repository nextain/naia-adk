"use client"
import React from "react"
import type { BoardScheduleStatus as Status } from "./schedule-board-state"
import { useT } from "../i18n/provider.tsx"

export function BoardScheduleStatus({ status, retry }: { status: Status; retry: () => void }) {
  const t = useT()
  if (status === "ready") return null
  if (status === "loading") return <p role="status" className="px-3 py-2 text-sm text-neutral-400">{t("sched.boardLoading")}</p>
  return (
    <p role="alert" className="px-3 py-2 text-sm text-amber-300">
      {status === "not-configured" ? t("sched.boardMissing") : t("sched.boardFailed")}{" "}
      <button type="button" className="underline" onClick={retry}>{t("common.retry")}</button>
    </p>
  )
}
