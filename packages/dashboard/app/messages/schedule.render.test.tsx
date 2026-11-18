import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MessengerView } from "./MessengerView"
import { MessageItem } from "./MessageItem"
import { MessageBody } from "./MessageBody"
import { ScheduleAddPanel } from "./ScheduleAddPanel"
import { normalizeMessage, type MessengerState } from "./messenger"

const now = new Date("2026-11-12T00:00:00Z")
const NOTICE = "10분 뒤 시작: **회의** · 10:00~11:00\n[일정에서 보기](/schedule?item=personal%3Aps-1&date=2026-11-12)"
const msg = (id: string, body: string) =>
  normalizeMessage({ id, channel_id: "work", author_id: "owner", author_kind: "human", body, created_at: "2026-11-11T23:00:00Z" })
const state = (): MessengerState => ({
  channels: [{ id: "work", name: "업무-요청", kind: "channel", unread: 0 }],
  messages: { work: [msg("m1", "11월 20일 14:00 기획 회의")] },
  alerts: [],
})

describe("메신저와 일정", () => {
  it("알림 글의 일정 링크는 대시보드 안에서 열고(새 탭 아님), 다른 원점의 /schedule 은 바깥 링크로 둔다", () => {
    const html = renderToStaticMarkup(<MessageBody body={NOTICE} />)
    assert.match(html, /<a[^>]*href="\/schedule\?item=personal%3Aps-1&amp;date=2026-11-12"[^>]*data-testid="msg-schedule-link"|<a[^>]*data-testid="msg-schedule-link"[^>]*href="\/schedule\?item=personal%3Aps-1&amp;date=2026-11-12"/)
    assert.ok(!/msg-schedule-link[^>]*target="_blank"/.test(html))
    const other = renderToStaticMarkup(<MessageBody body={"[x](https://evil.example.test/schedule?item=personal%3Aps-1&date=2026-11-12)"} />)
    assert.ok(!other.includes("msg-schedule-link") && other.includes('target="_blank"'))
  })

  it("글마다 [일정에 넣기] 단추가 있고, 사람 화면에서만 보인다", () => {
    const human = renderToStaticMarkup(<MessageItem message={msg("x", "a")} onAddToSchedule={() => undefined} now={now} />)
    assert.ok(human.includes('data-testid="msg-add-schedule"') && human.includes('aria-label="일정에 넣기"'))
    const agent = renderToStaticMarkup(<MessageItem message={msg("x", "a")} viewerKind="agent" onAddToSchedule={() => undefined} now={now} />)
    assert.ok(!agent.includes('data-testid="msg-add-schedule"'))
    const view = renderToStaticMarkup(<MessengerView initialState={state()} initialChannelId="work" disableStream now={now} />)
    assert.ok(view.includes('data-testid="msg-add-schedule"'))
  })

  it("오른쪽 창: 글에서 뽑은 제목·날짜·시각을 채우고 본인 일정에만 들어간다고 알린다", () => {
    const panel = renderToStaticMarkup(
      <MessengerView initialState={state()} initialChannelId="work" initialPanel={{ kind: "schedule", message: state().messages.work[0] }} disableStream now={now} />,
    )
    assert.ok(panel.includes('data-testid="schedule-add-panel"'))
    const html = renderToStaticMarkup(<ScheduleAddPanel message={msg("m1", "11월 20일 14:00 기획 회의")} onClose={() => undefined} today="2026-11-12" />)
    assert.ok(html.includes('value="11월 20일 14:00 기획 회의"'))
    assert.ok(html.includes('value="2026-11-20"') && html.includes('value="14:00"'))
    assert.ok(html.includes("내 개인 일정에만 들어갑니다"))
  })
})
