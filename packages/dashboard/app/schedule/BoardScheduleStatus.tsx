"use client"
import React from "react"
import type { BoardScheduleStatus as Status } from "./schedule-board-state"

export function BoardScheduleStatus({ status, retry }: { status: Status; retry: () => void }) {
  if (status === "ready") return null
  if (status === "loading") return <p role="status" className="px-3 py-2 text-sm text-neutral-400">작업 일정을 불러오는 중입니다.</p>
  return (
    <p role="alert" className="px-3 py-2 text-sm text-amber-300">
      {status === "not-configured" ? "작업보드가 설정되지 않았습니다." : "작업 일정을 불러오지 못했습니다."}{" "}
      <button type="button" className="underline" onClick={retry}>다시 시도</button>
    </p>
  )
}
