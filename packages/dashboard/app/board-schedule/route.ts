// 작업보드 스냅숏(/api/snapshot)에서 [일정] 달력·목록 보기에 쓸
// 그룹(작업) 일정(날짜 있는 항목·날짜 없는 항목)과 마일스톤만 추려서 내려준다.
// 스냅숏 원본이 수 MB 이므로 /board-waits 와 마찬가지로 서버에서 읽어 필요한 칸만 보낸다.

import { apiBase } from "../api-base"
import { extractBoardSchedule, type BoardScheduleProjection } from "../schedule/schedule-calendar"

const BOARD_HOST = process.env.ADK_BOARD_HOST || "127.0.0.1"
const CACHE_MS = 15_000

export const dynamic = "force-dynamic"

let cached: { at: number; data: BoardScheduleProjection } | null = null

async function boardPort(fetchFn: typeof fetch = fetch): Promise<number | null> {
  const envPort = Number(process.env.ADK_BOARD_PORT)
  if (Number.isInteger(envPort) && envPort > 0 && envPort < 65536) {
    return envPort
  }
  try {
    const res = await fetchFn(`${apiBase()}/api/portal`, { cache: "no-store" })
    if (!res.ok) return null
    const data = (await res.json()) as { board?: { port?: number } | null }
    const port = data.board?.port
    return Number.isInteger(port) && port! > 0 && port! < 65536 ? port! : null
  } catch {
    return null
  }
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  })
}

async function handleBoardScheduleGet(
  opts: { fetchFn?: typeof fetch; useCache?: boolean } = {},
): Promise<Response> {
  const fetchFn = opts.fetchFn ?? fetch
  const useCache = opts.useCache ?? true
  if (useCache && cached && Date.now() - cached.at < CACHE_MS) {
    return reply(200, { ...cached.data, cached: true })
  }
  const port = await boardPort(fetchFn)
  if (!port) {
    return reply(503, {
      error: "board_not_configured",
      observedAt: null,
      todayDate: new Date().toISOString().slice(0, 10),
      workItems: [],
      undatedItems: [],
      milestones: [],
    })
  }
  try {
    const res = await fetchFn(`http://${BOARD_HOST}:${port}/api/snapshot`, {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      return reply(502, {
        error: "board_unavailable",
        observedAt: null,
        todayDate: new Date().toISOString().slice(0, 10),
        workItems: [],
        undatedItems: [],
        milestones: [],
      })
    }
    const data = extractBoardSchedule(await res.json())
    if (useCache) {
      cached = { at: Date.now(), data }
    }
    return reply(200, data)
  } catch {
    return reply(502, {
      error: "board_unavailable",
      observedAt: null,
      todayDate: new Date().toISOString().slice(0, 10),
      workItems: [],
      undatedItems: [],
      milestones: [],
    })
  }
}

export async function GET(): Promise<Response> {
  return handleBoardScheduleGet()
}
