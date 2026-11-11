import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MessengerView } from "./MessengerView"
import { ApprovalCard, MessageItem } from "./MessageItem"
import { MessageBody, linkifyDocPaths } from "./MessageBody"
import { Composer } from "./Composer"
import { DocPreview } from "./DocPreview"
import { NavTabs } from "../components/Nav"
import { normalizeMessage, setMentionRoles, type MessengerState } from "./messenger"

setMentionRoles([
  { id: "coder", label: "코더" },
  { id: "planner", label: "플래너" },
  { id: "designer", label: "디자이너" },
])

const now = new Date("2026-11-08T12:00:00Z")
const m = (id: string, extra: Record<string, unknown> = {}) =>
  normalizeMessage({ id, channel_id: "work", author_id: "owner", author_kind: "human", body: "안녕하세요", created_at: "2026-11-08T11:00:00Z", ...extra })

const TABLE = "| 일 | 담당 | 상태 |\n|---|---|---|\n| 메신저 화면 | 코더 | 진행 |\n| 서버 | 플래너 | 완료 |"
const LONG_CODE = "```ts\n" + Array.from({ length: 40 }, (_, i) => `const line${i} = ${i}`).join("\n") + "\n```"
const APPROVAL_BODY = "1. 제목: [배포] 메신저 1차 올리기\n2. 요약: 대시보드 대화창을 운영에 올립니다.\n3. 문서: https://dashboard.example.com/d/a1b2c3"

const state = (): MessengerState => ({
  channels: [
    { id: "work", name: "업무-요청", kind: "channel", unread: 0 },
    { id: "infra", name: "사내-인프라", kind: "channel", unread: 4 },
    { id: "free", name: "자유", kind: "channel", unread: 0 },
    { id: "dm-coder", name: "coder", kind: "dm", unread: 1 },
  ],
  messages: {
    work: [
      m("m1", { body: `이번 주 진행 표입니다.\n\n${TABLE}` }),
      m("m2", { author_id: "coder", author_kind: "agent", body: LONG_CODE, reactions: [{ emoji: "👍", count: 2, mine: true }] }),
      m("m3", { author_id: "coder", author_kind: "agent", body: APPROVAL_BODY, approval: { plan_code: "PLAN-AB12CD", step_code: "STEP-EF34GH", status: "pending" } }),
      m("m4", { reply_to_id: "m1", thread_root_id: "m1", body: "확인했습니다" }),
      m("m5", { reply_to_id: "m1", thread_root_id: "m1", body: "저도요" }),
    ],
  },
  alerts: [],
})

const render = (el: React.ReactElement) => renderToStaticMarkup(el)

describe("대화 화면 (메신저 1차)", () => {
  it("위 탭에 대화가 있고 /messages 에서 켜진다", () => {
    const html = render(<NavTabs pathname="/messages/work" hasBoard={true} />)
    const tab = html.match(/<a[^>]*data-testid="nav-tab-messages"[^>]*>/)?.[0] ?? ""
    assert.ok(tab.includes('href="/messages"'))
    assert.ok(tab.includes('aria-current="page"'))
    assert.ok(html.includes(">대화<"))
  })

  it("채널·개인 대화 목록과 안 읽은 수, 지금 채널은 수를 숨긴다", () => {
    const html = render(<MessengerView initialState={state()} initialChannelId="work" disableStream now={now} />)
    assert.ok(html.includes(">채널<") && html.includes(">개인 대화<"))
    assert.equal((html.match(/data-testid="channel-item"/g) ?? []).length, 4)
    const badges = [...html.matchAll(/data-testid="channel-unread"[^>]*>(\d+)</g)].map((x) => x[1])
    assert.deepEqual(badges, ["4", "1"])
    assert.ok(html.includes(">코더<"), "개인 대화는 역할 이름을 한국어로")
    assert.ok(html.includes("# 업무-요청"))
  })

  it("글 목록: GFM 표를 표로 그리고 표 복사 단추, 긴 코드는 접는다, 답글은 스레드로 묶는다", () => {
    const html = render(<MessengerView initialState={state()} initialChannelId="work" disableStream now={now} />)
    assert.ok(html.includes("<table"))
    assert.ok(html.includes("<th") && html.includes("메신저 화면"))
    assert.ok(html.includes('data-testid="msg-table-copy"') && html.includes(">표 복사<"))
    assert.ok(html.includes('data-testid="msg-code-fold"') && html.includes("코드 40줄 모두 보기"))
    assert.ok(html.includes("답글 2개"))
    assert.ok(!html.includes("확인했습니다"), "답글은 본문 목록에 나오지 않는다")
    assert.ok(html.includes('aria-pressed="true"') && html.includes("👍"))
    assert.ok(html.includes(">에이전트<"))
    assert.ok(html.includes("#업무-요청에 글 쓰기") && html.includes("Enter 보내기 · Shift+Enter 줄바꿈"))
  })

  it("승인 카드: 제목·요약·문서·코드, 사람에게만 승인·거절·코드 복사", () => {
    const msg = state().messages.work[2]
    const human = render(<ApprovalCard message={msg} viewerKind="human" />)
    assert.ok(human.includes("[배포] 메신저 1차 올리기"))
    assert.ok(human.includes("대시보드 대화창을 운영에 올립니다."))
    assert.ok(human.includes('href="/d/a1b2c3"'))
    assert.ok(human.includes("PLAN-AB12CD STEP-EF34GH"))
    for (const id of ["approval-approve", "approval-reject", "approval-copy-code"]) assert.ok(human.includes(`data-testid="${id}"`), id)
    assert.ok(human.includes("승인 기다림"))
    const agent = render(<ApprovalCard message={msg} viewerKind="agent" />)
    for (const id of ["approval-approve", "approval-reject", "approval-copy-code"]) assert.ok(!agent.includes(`data-testid="${id}"`), id)
    const done = render(
      <ApprovalCard message={{ ...msg, approval: { ...msg.approval!, status: "approved", decided_by: "owner", decided_at: "2026-11-08T11:30:00Z" } }} viewerKind="human" />,
    )
    assert.ok(done.includes("승인됨") && !done.includes('data-testid="approval-approve"'))
  })

  it("승인 카드: 첫 문서 줄만 보고, 대시보드 문서(/d/)가 아니면 링크를 만들지 않는다", () => {
    const msg = state().messages.work[2]
    const twoLines = APPROVAL_BODY.replace("3. 문서: https://dashboard.example.com/d/a1b2c3", "3. 문서: https://evil.test/login\n3. 문서: https://dashboard.example.com/d/a1b2c3")
    const html = render(<ApprovalCard message={{ ...msg, body: twoLines }} viewerKind="human" />)
    assert.ok(!html.includes('data-testid="approval-doc-link"'))
    assert.ok(!html.includes('href="https://evil.test/login"'))
    assert.ok(html.includes('data-testid="approval-doc-text"') && html.includes("https://evil.test/login"))
  })

  it("30분 무응답은 위 빨간 띠", () => {
    const s = { ...state(), alerts: [{ message_id: "m1", channel_id: "work", target_id: "coder" }] }
    const html = render(<MessengerView initialState={s} initialChannelId="work" disableStream now={now} />)
    assert.ok(html.includes('data-testid="messenger-alert"') && html.includes('role="alert"'))
    assert.ok(html.includes("bg-rose-800"))
    assert.ok(html.includes("무응답 알림"))
    assert.ok(html.includes("# 업무-요청 · 코더 답이 30분째 없습니다"))
    assert.ok(!render(<MessengerView initialState={state()} initialChannelId="work" disableStream />).includes("messenger-alert"))
  })

  it("오른쪽 나뉜 창: 스레드와 문서 미리보기(기존 문서 보기)", () => {
    const thread = render(<MessengerView initialState={state()} initialChannelId="work" initialPanel={{ kind: "thread", rootId: "m1" }} disableStream now={now} />)
    assert.ok(thread.includes('data-testid="thread-panel"') && thread.includes("확인했습니다") && thread.includes("저도요"))
    assert.ok(thread.includes('data-testid="thread-composer"'))
    const doc = render(
      <DocPreview
        docKey="/d/a1b2c3"
        onClose={() => undefined}
        initial={{ kind: "ready", source: "adk", path: "common/plan.md", content: "# 메신저 계획\n\n| 가 | 나 |\n|---|---|\n| 1 | 2 |" }}
      />,
    )
    assert.ok(doc.includes("문서 미리보기") && doc.includes("plan.md"))
    assert.ok(doc.includes('data-print="doc-body"'), "문서 화면의 DocMarkdown 을 그대로 쓴다")
    assert.ok(doc.includes("메신저 계획") && doc.includes("<table"))
    assert.ok(doc.includes("source=adk&amp;path=common%2Fplan.md"))
  })

  it("글 속 /d/ 주소는 미리보기 링크가 된다(코드 안은 그대로)", () => {
    const html = render(<MessageBody body={"문서 /d/a1b2c3 보세요 `/d/zzzzzz`"} onOpenDoc={() => undefined} />)
    assert.ok(html.includes('data-doc-key="/d/a1b2c3"'))
    assert.ok(!html.includes('data-doc-key="/d/zzzzzz"'))
    assert.equal(linkifyDocPaths("```\n/d/abc\n```"), "```\n/d/abc\n```")
  })

  it("입력창: 첨부 단추와 @ 자동 완성 목록", () => {
    const html = render(<Composer placeholder="쓰기" initialText="@" onSend={async () => undefined} onUpload={async () => ({ id: "a", name: "a" })} />)
    assert.ok(html.includes('data-testid="composer-attach"'))
    assert.ok(html.includes('data-testid="mention-list"') && html.includes("@coder") && html.includes("@designer"))
  })

  it("글 하나: 반응 고르기 단추와 답글 단추", () => {
    const html = render(<MessageItem message={m("x")} onReply={() => undefined} onReact={() => undefined} now={now} />)
    assert.ok(html.includes('data-testid="msg-reaction-add"') && html.includes('data-testid="msg-reply"'))
  })
})
