import type { BoardScheduleProjection } from "./schedule-calendar"

export type BoardScheduleStatus = "loading" | "ready" | "not-configured" | "unavailable"
export type BoardScheduleResult =
  | { status: "ready"; data: BoardScheduleProjection }
  | { status: "not-configured" | "unavailable" }

export async function requestBoardSchedule(fetcher: typeof fetch): Promise<BoardScheduleResult> {
  try {
    const response = await fetcher("/board-schedule", { cache: "no-store" })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      return { status: response.status === 503 && body.error === "board_not_configured" ? "not-configured" : "unavailable" }
    }
    const data = await response.json() as BoardScheduleProjection
    if (!data || !Array.isArray(data.workItems) || !Array.isArray(data.undatedItems) || !Array.isArray(data.milestones)) {
      return { status: "unavailable" }
    }
    return { status: "ready", data }
  } catch {
    return { status: "unavailable" }
  }
}

export function retainLocalToday(current: BoardScheduleProjection, incoming: BoardScheduleProjection): BoardScheduleProjection {
  return { ...incoming, todayDate: current.todayDate }
}
