import assert from "node:assert/strict"
import { test } from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { BoardScheduleStatus } from "./BoardScheduleStatus"
import { requestBoardSchedule, retainLocalToday } from "./schedule-board-state"

const projection = { observedAt: null, todayDate: "2026-11-12", workItems: [], undatedItems: [], milestones: [] }

test("board responses retain browser-local today while applying work data", async () => {
  const fetcher = (async () => Response.json({ ...projection, workItems: [{ id: "one" }] })) as typeof fetch
  const result = await requestBoardSchedule(fetcher)
  assert.equal(result.status, "ready")
  if (result.status !== "ready") return
  const merged = retainLocalToday({ ...projection, todayDate: "2026-11-11" }, result.data)
  assert.equal(merged.todayDate, "2026-11-11")
  assert.equal(merged.workItems[0].id, "one")
})

test("board outages, missing setup and invalid responses are distinguishable and retryable", async () => {
  const unavailable = await requestBoardSchedule((async () => new Response("", { status: 502 })) as typeof fetch)
  const unconfigured = await requestBoardSchedule((async () => Response.json({ error: "board_not_configured" }, { status: 503 })) as typeof fetch)
  const invalid = await requestBoardSchedule((async () => Response.json({ workItems: [] })) as typeof fetch)
  const offline = await requestBoardSchedule((async () => { throw new Error("offline") }) as typeof fetch)
  assert.equal(unavailable.status, "unavailable")
  assert.equal(unconfigured.status, "not-configured")
  assert.equal(invalid.status, "unavailable")
  assert.equal(offline.status, "unavailable")
  for (const result of [unavailable, unconfigured]) {
    const html = renderToStaticMarkup(React.createElement(BoardScheduleStatus, { status: result.status, retry: () => {} }))
    assert.match(html, /role="alert"/)
    assert.match(html, /다시 시도/)
    assert.match(html, result.status === "not-configured" ? /설정되지 않았습니다/ : /불러오지 못했습니다/)
  }
})
