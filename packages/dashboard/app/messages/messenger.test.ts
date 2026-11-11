import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  applyMention,
  applyReactionDelta,
  applyStreamEvent,
  checkAttachment,
  composerKeyAction,
  docLinkKey,
  findDocLinks,
  loadChannels,
  loadMessages,
  loadMessagesThrough,
  mentionCandidates,
  mentionQueryAt,
  messageAuthorLabel,
  messagesHref,
  normalizeMessage,
  optimisticReaction,
  parseApprovalForm,
  parseMessagesPath,
  postMessage,
  reconnectDelay,
  streamPath,
  resolveDocLink,
  shouldFoldCode,
  splitThreads,
  tableToTsv,
  toggleReaction,
  decideApproval,
  type MessengerState,
} from "./messenger.ts"
import { DEFAULT_MENTION_ROLES, getMentionRoles, setMentionRoles } from "./messenger.ts"

const FIXTURE_ROLES = [
  { id: "coder", label: "코더" },
  { id: "planner", label: "플래너" },
  { id: "reviewer", label: "리뷰어" },
  { id: "writer", label: "작성자" },
  { id: "naia", label: "나이아" },
  { id: "designer", label: "디자이너" },
]
setMentionRoles(FIXTURE_ROLES)

const msg = (id: string, extra: Record<string, unknown> = {}) =>
  normalizeMessage({ id, channel_id: "c1", author_id: "owner", author_kind: "human", body: id, created_at: `2026-11-08T10:00:0${id.slice(-1)}Z`, ...extra })

const baseState = (): MessengerState => ({
  channels: [
    { id: "c1", name: "업무-요청", kind: "channel", unread: 0 },
    { id: "c2", name: "자유", kind: "channel", unread: 2 },
  ],
  messages: { c1: [msg("m1"), msg("m2")] },
  alerts: [],
})

describe("메신저 REST 호출 모양(약속)", () => {
  it("채널·글 목록·글 쓰기·반응·승인 주소와 방법이 약속과 같다", async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push([url, init])
      if (url.endsWith("/channels")) return Response.json([{ id: "c1", name: "자유", kind: "channel", unread: "3" }])
      if (url.includes("/messages?")) return Response.json({ messages: [msg("m2"), msg("m1")] })
      if (url.includes("/channels/c1/messages")) return Response.json({ id: "m9", channel_id: "c1", body: "hi" })
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const channels = await loadChannels(fake)
    assert.equal(channels[0].unread, 3)
    const list = await loadMessages("c1", { before: "m5" }, fake)
    assert.deepEqual(list.map((m) => m.id), ["m1", "m2"], "시간순으로 정렬")
    assert.equal(calls[1][0], "/api/portal/messenger/channels/c1/messages?before=m5&limit=50")
    const created = await postMessage("c1", "hi", "m1", [], fake)
    assert.equal(created.id, "m9")
    assert.deepEqual(JSON.parse(String(calls[2][1]?.body)), { body: "hi", reply_to_id: "m1" })
    await toggleReaction("m1", "👍", false, fake)
    assert.equal(calls[3][0], "/api/portal/messenger/messages/m1/reactions")
    assert.equal(calls[3][1]?.method, "POST")
    await toggleReaction("m1", "👍", true, fake)
    assert.equal(calls[4][0], `/api/portal/messenger/messages/m1/reactions?emoji=${encodeURIComponent("👍")}`)
    assert.equal(calls[4][1]?.method, "DELETE")
    await decideApproval("m1", "approve", fake)
    assert.equal(calls[5][0], "/api/portal/messenger/approvals/m1")
    assert.deepEqual(JSON.parse(String(calls[5][1]?.body)), { decision: "approve" })
  })

  it("첨부만 있는 글은 빈 본문과 첨부 번호를 함께 보낸다", async () => {
    let sent: unknown
    const fake = (async (_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body))
      return Response.json({ id: "m9", channel_id: "c1", body: "" })
    }) as unknown as typeof fetch
    await postMessage("c1", "", null, ["a1"], fake)
    assert.deepEqual(sent, { body: "", attachment_ids: ["a1"] })
  })

  describe("직접 링크 대상까지 이전 페이지 불러오기", () => {
    // 글 번호는 시간순으로 정렬되는 문자열(ULID 와 같은 성질)이다.
    const ids = Array.from({ length: 130 }, (_, i) => `m${String(i).padStart(3, "0")}`)
    function pagedFetch() {
      const calls: string[] = []
      const fake = (async (url: string) => {
        calls.push(url)
        const q = new URL(url, "http://x").searchParams
        const before = q.get("before")
        const limit = Number(q.get("limit"))
        const older = before ? ids.filter((id) => id < before) : ids
        const at = (id: string) => new Date(Date.UTC(2026, 10, 8, 10, 0, Number(id.slice(1, 4)))).toISOString()
        return Response.json({ messages: older.slice(-limit).reverse().map((id) => msg(id, { created_at: at(id) })) })
      }) as unknown as typeof fetch
      return { calls, fake }
    }

    it("대상이 최신 페이지 밖이면 대상이 나올 때까지 이전 페이지를 더 불러온다", async () => {
      const { calls, fake } = pagedFetch()
      const out = await loadMessagesThrough("c1", "m005", { limit: 50 }, fake)
      assert.ok(out.messages.some((m) => m.id === "m005"))
      assert.equal(calls.length, 3)
      assert.equal(out.messages[0].id, "m000")
      assert.equal(out.hasMore, false)
      assert.deepEqual(out.messages.map((m) => m.id), ids, "시간순, 빠짐·겹침 없음")
    })

    it("대상이 최신 페이지에 있으면 한 번만 부른다", async () => {
      const { calls, fake } = pagedFetch()
      const out = await loadMessagesThrough("c1", "m120", { limit: 50 }, fake)
      assert.equal(calls.length, 1)
      assert.equal(out.messages.length, 50)
      assert.equal(out.hasMore, true)
    })

    it("상한에서 멈추고, 대상보다 옛 글까지 받았는데 없으면 더 부르지 않는다", async () => {
      const capped = pagedFetch()
      await loadMessagesThrough("c1", "m000", { limit: 10, maxPages: 3 }, capped.fake)
      assert.equal(capped.calls.length, 3)
      const missing = pagedFetch()
      await loadMessagesThrough("c1", "m100x", { limit: 50 }, missing.fake)
      assert.equal(missing.calls.length, 1, "m080~m129 를 받으면 m100x 는 이 채널에 없다")
    })
  })

  it("/d/<키> 는 짧은 주소가 넘겨 준 /docs 주소에서 출처·경로를 풀어 문서를 읽는다", async () => {
    const fake = (async (url: string) => {
      if (url === "/d/abc123") return { ok: true, url: "http://x/docs?tab=common&source=adk&path=common%2Fa.md" } as Response
      if (url.startsWith("/api/portal/text")) {
        assert.equal(url, "/api/portal/text?source=adk&path=common%2Fa.md")
        return Response.json({ content: "# 제목" })
      }
      throw new Error(url)
    }) as unknown as typeof fetch
    const doc = await resolveDocLink("/d/abc123", fake)
    assert.deepEqual(doc, { source: "adk", path: "common/a.md", content: "# 제목" })
    const direct = await resolveDocLink("/d/adk/common/a.md", fake)
    assert.equal(direct.path, "common/a.md")
  })
})

describe("SSE 이벤트 반영", () => {
  it("보고 있지 않은 채널 새 글은 안 읽은 수를 올리고, 같은 글이 두 번 와도 한 번만 센다", () => {
    let s = baseState()
    const m = { ...msg("m3"), channel_id: "c2" }
    s = applyStreamEvent(s, "message", m, { activeChannelId: "c1" }).state
    assert.equal(s.channels[1].unread, 3)
    s = applyStreamEvent(s, "message", { ...msg("m3"), channel_id: "c1" }, { activeChannelId: "c1" }).state
    assert.deepEqual(s.messages.c1.map((x) => x.id), ["m1", "m2", "m3"])
    s = applyStreamEvent(s, "message", { ...msg("m3"), channel_id: "c1" }, { activeChannelId: "c1" }).state
    assert.equal(s.messages.c1.length, 3)
  })

  it("반응·승인·읽음·alert 이벤트", () => {
    let s = baseState()
    s = applyStreamEvent(s, "reaction", { message_id: "m1", reactions: [{ emoji: "🔥", count: 2, mine: true }] }, { activeChannelId: "c1" }).state
    assert.deepEqual(s.messages.c1[0].reactions, [{ emoji: "🔥", count: 2, mine: true }])
    s = applyStreamEvent(s, "reaction", { message_id: "m1", emoji: "👍", author_id: "coder" }, { activeChannelId: "c1" }).state
    assert.equal(s.messages.c1[0].reactions.length, 2)
    s = applyStreamEvent(s, "approval", { message_id: "m2", plan_code: "PLAN-AAAAAA", step_code: "STEP-BBBBBB", status: "approved" }, { activeChannelId: "c1" }).state
    assert.equal(s.messages.c1[1].approval?.status, "approved")
    s = applyStreamEvent(s, "read", { channel_id: "c2", unread: 0 }, { activeChannelId: "c1" }).state
    assert.equal(s.channels[1].unread, 0)
    s = applyStreamEvent(s, "alert", { message_id: "m1", channel_id: "c1", target_id: "coder" }, { activeChannelId: "c1" }).state
    s = applyStreamEvent(s, "alert", { message_id: "m1", channel_id: "c1", target_id: "coder" }, { activeChannelId: "c1" }).state
    assert.equal(s.alerts.length, 1)
    s = applyStreamEvent(s, "alert", { message_id: "m1", stage: "none" }, { activeChannelId: "c1" }).state
    assert.equal(s.alerts.length, 0)
    const unknown = applyStreamEvent(s, "reaction", { message_id: "zz", channel_id: "c1", emoji: "👍" }, { activeChannelId: "c1" })
    assert.equal(unknown.refetchChannel, "c1", "모르는 글의 반응은 지금 채널을 다시 읽는다")
  })

  it("core 메시지 객체로 반응·승인을 갱신하고 읽음 커서는 서버에서 다시 센다", () => {
    let s = baseState()
    const reactions = [{ emoji: "✅", count: 2, mine: false }]
    s = applyStreamEvent(s, "reaction", { ...msg("m1"), reactions }, { activeChannelId: "c1" }).state
    assert.deepEqual(s.messages.c1[0].reactions, reactions)
    const approval = { plan_code: "PLAN-AAAAAA", step_code: "STEP-BBBBBB", status: "approved" as const }
    s = applyStreamEvent(s, "approval", { ...msg("m2"), approval }, { activeChannelId: "c1" }).state
    assert.deepEqual(s.messages.c1[1].approval, approval)
    const cursor = { channel_id: "c2", reader_id: "coder", last_message_id: "m3" }
    const result = applyStreamEvent(s, "read", cursor, { activeChannelId: "c1" })
    assert.equal(result.state.channels[1].unread, 2, "다른 사람의 읽음으로 내 안 읽은 수를 지우지 않는다")
    assert.equal(result.refetchChannels, true)
    const other = applyStreamEvent(s, "read", { ...cursor, unread: 0 }, { activeChannelId: "c1", viewerId: "owner" })
    assert.equal(other.state.channels[1].unread, 2)
  })

  it("보는 사람과 이름이 같은 에이전트의 글·반응·읽음은 내 것으로 치지 않는다", () => {
    const s = baseState()
    const ctx = { activeChannelId: "c1", viewerId: "coder" }
    const before = s.channels[1].unread
    const agentPost = applyStreamEvent(s, "message", { ...msg("m9"), channel_id: "c2", author_id: "coder", author_kind: "agent" }, ctx)
    assert.equal(agentPost.state.channels[1].unread, before + 1)
    const humanPost = applyStreamEvent(s, "message", { ...msg("m9"), channel_id: "c2", author_id: "coder", author_kind: "human" }, ctx)
    assert.equal(humanPost.state.channels[1].unread, before)
    assert.deepEqual(applyReactionDelta([], { emoji: "👍", author_id: "coder", author_kind: "agent" }, "coder"), [{ emoji: "👍", count: 1, mine: false }])
    assert.deepEqual(applyReactionDelta([], { emoji: "👍", author_id: "coder", author_kind: "human" }, "coder"), [{ emoji: "👍", count: 1, mine: true }])
    const agentRead = applyStreamEvent(s, "read", { channel_id: "c2", reader_id: "coder", reader_kind: "agent", unread: 0 }, ctx)
    assert.equal(agentRead.state.channels[1].unread, before)
    const humanRead = applyStreamEvent(s, "read", { channel_id: "c2", reader_id: "coder", reader_kind: "human", unread: 0 }, ctx)
    assert.equal(humanRead.state.channels[1].unread, 0)
  })

  it("같은 글의 역할별 무응답 알림은 응답한 역할만 해제한다", () => {
    const state = baseState()
    state.alerts = [
      { message_id: "m1", target_id: "coder" },
      { message_id: "m1", target_id: "designer" },
      { message_id: "m2", target_id: "coder" },
    ]
    const result = applyStreamEvent(state, "alert", { message_id: "m1", target_id: "coder", cleared: true }, { activeChannelId: "c1" })
    assert.deepEqual(result.state.alerts, [state.alerts[1], state.alerts[2]])
    const legacy = applyStreamEvent(result.state, "alert", { message_id: "m1", stage: "none" }, { activeChannelId: "c1" })
    assert.deepEqual(legacy.state.alerts, [state.alerts[2]])
  })

  it("반응 하나씩 더하고 빼기, 내 반응 먼저 반영", () => {
    let r = applyReactionDelta([], { emoji: "👀", author_id: "me" }, "me")
    assert.deepEqual(r, [{ emoji: "👀", count: 1, mine: true }])
    r = applyReactionDelta(r, { emoji: "👀", author_id: "me", op: "remove" }, "me")
    assert.deepEqual(r, [])
    assert.deepEqual(optimisticReaction([{ emoji: "🎉", count: 2, mine: true }], "🎉"), [{ emoji: "🎉", count: 1, mine: false }])
  })

  it("다시 붙기 간격은 1초부터 두 배, 15초 상한", () => {
    assert.deepEqual([0, 1, 2, 3, 4, 9].map(reconnectDelay), [1000, 2000, 4000, 8000, 15000, 15000])
  })

  it("새로 여는 SSE 는 받은 마지막 id 를 넘기고, 처음에는 커서 없이 연다", () => {
    assert.equal(streamPath(null), "/stream")
    assert.equal(streamPath(""), "/stream")
    assert.equal(streamPath("42"), "/stream?last_event_id=42")
    assert.equal(streamPath("4 2&x=1"), "/stream")
  })
})

describe("본문 해석", () => {
  it("승인 양식 글에서 제목·요약·문서·코드를 꺼낸다", () => {
    const body = "1. 제목: [배포] 메신저 1차 올리기\n2. 요약: 대시보드 대화창을 운영에 올립니다.\n3. 문서: https://dashboard.example.com/d/a1b2c3\n4. 승인 코드 PLAN-AB12CD STEP-EF34GH"
    const form = parseApprovalForm(body, null)
    assert.equal(form.title, "[배포] 메신저 1차 올리기")
    assert.equal(form.summary, "대시보드 대화창을 운영에 올립니다.")
    assert.equal(form.docUrl, "https://dashboard.example.com/d/a1b2c3")
    assert.equal(form.code, "PLAN-AB12CD STEP-EF34GH")
    assert.equal(parseApprovalForm(body, { plan_code: "PLAN-ZZZZZZ", step_code: "STEP-YYYYYY", status: "pending" }).code, "PLAN-ZZZZZZ STEP-YYYYYY")
  })

  it("승인 양식의 문서 주소는 첫 3. 문서: 줄에서만 꺼낸다", () => {
    const two = "1. 제목: [배포] 조치\n2. 요약: 확인\n3. 문서: https://evil.test/login\n3. 문서: https://dashboard.example.com/d/a1"
    assert.equal(parseApprovalForm(two, null).docUrl, "https://evil.test/login")
    assert.equal(docLinkKey("https://evil.test/login"), null)
    const notUrl = "1. 제목: [배포] 조치\n2. 요약: 확인\n3. 문서: 나중에\n3. 문서: https://dashboard.example.com/d/a1"
    assert.equal(parseApprovalForm(notUrl, null).docUrl, null)
  })

  it("글 속 /d/ 문서 주소는 호스트를 떼고 한 번씩만 찾는다", () => {
    const links = findDocLinks("보세요 https://dashboard.example.com/d/a1b2c3, 그리고 /d/adk/common/x.md 또 /d/a1b2c3. 아님: /abc/d/zz")
    assert.deepEqual(links.map((l) => l.key), ["/d/a1b2c3", "/d/adk/common/x.md"])
    assert.equal(docLinkKey("/d/../etc"), null)
    assert.equal(docLinkKey("https://example.com/docs"), null)
  })

  it("스레드: 답글은 뿌리 글 아래로 묶고, 뿌리가 없으면 목록에 둔다", () => {
    const { roots, replies } = splitThreads([msg("m1"), msg("m2", { reply_to_id: "m1", thread_root_id: "m1" }), msg("m3", { thread_root_id: "gone" })])
    assert.deepEqual(roots.map((m) => m.id), ["m1", "m3"])
    assert.deepEqual(replies.get("m1")?.map((m) => m.id), ["m2"])
  })

  it("30줄 넘는 코드만 접는다", () => {
    assert.equal(shouldFoldCode(Array(30).fill("x").join("\n") + "\n"), false)
    assert.equal(shouldFoldCode(Array(31).fill("x").join("\n")), true)
  })

  it("표 복사는 탭·줄바꿈 꼴(스프레드시트에 붙여 넣기)", () => {
    assert.equal(tableToTsv([["이름", "상태"], ["코더", "할 일\n2건"]]), "이름\t상태\n코더\t할 일 2건")
  })
})

describe("입력창 규칙", () => {
  it("@역할 자동 완성", () => {
    const text = "확인 부탁 @co"
    const q = mentionQueryAt(text, text.length)
    assert.deepEqual(q, { start: 6, query: "co" })
    assert.deepEqual(mentionCandidates("co").map((r) => r.id), ["coder"])
    assert.deepEqual(mentionCandidates("리").map((r) => r.id), ["reviewer"])
    assert.equal(mentionCandidates("").length, 6)
    assert.deepEqual(applyMention(text, q!.start, text.length, "coder"), { text: "확인 부탁 @coder ", caret: 13 })
    assert.equal(mentionQueryAt("mail@ex", 7), null, "메일 주소는 부르기가 아니다")
  })

  it("역할 목록은 서버 값을 따르고, 비거나 틀린 값이면 기본 목록", () => {
    try {
      assert.deepEqual(setMentionRoles([{ id: "ops", label: " 운영 " }, { id: "Bad" }, { id: "qa" }, null]), [
        { id: "ops", label: "운영" },
        { id: "qa", label: "qa" },
      ])
      assert.deepEqual(setMentionRoles([]), DEFAULT_MENTION_ROLES)
      assert.deepEqual(setMentionRoles("x"), DEFAULT_MENTION_ROLES)
      assert.equal(getMentionRoles(), DEFAULT_MENTION_ROLES)
    } finally {
      setMentionRoles(FIXTURE_ROLES)
    }
  })

  it("Enter 보내기, Shift+Enter 줄바꿈, 한글 조합 중 Enter 는 무시", () => {
    assert.equal(composerKeyAction({ key: "Enter", shiftKey: false }), "send")
    assert.equal(composerKeyAction({ key: "Enter", shiftKey: true }), "newline")
    assert.equal(composerKeyAction({ key: "Enter", shiftKey: false, isComposing: true }), null)
    assert.equal(composerKeyAction({ key: "a", shiftKey: false }), null)
  })

  it("첨부: 25MB·허용 종류·이중 확장자", () => {
    assert.equal(checkAttachment("표.csv", 10), null)
    assert.ok(checkAttachment("큰.zip", 26 * 1024 * 1024))
    assert.ok(checkAttachment("run.exe", 10))
    assert.ok(checkAttachment("보고서.exe.pdf", 10))
    assert.ok(checkAttachment("매크로.docm", 10))
  })

  it("주소: /messages/<채널>/<글>", () => {
    assert.equal(messagesHref("업무-요청", "01J"), "/messages/%EC%97%85%EB%AC%B4-%EC%9A%94%EC%B2%AD/01J")
    assert.deepEqual(parseMessagesPath(["%EC%9E%90%EC%9C%A0", "m1"]), { channelId: "자유", messageId: "m1" })
    assert.deepEqual(parseMessagesPath(undefined), { channelId: null, messageId: null })
  })
})

describe("attachment stream event", () => {
  const base = { channels: [{ id: "c1", name: "c1", kind: "channel", unread: 0 }, { id: "c2", name: "c2", kind: "channel", unread: 0 }], messages: { c1: [normalizeMessage({ id: "m1", channel_id: "c1", body: "글" })] } } as unknown as MessengerState
  const withFile = { id: "m1", channel_id: "c1", body: "글", attachments: [{ id: "a1", name: "a.txt" }] }

  it("shows the file on a message already on screen without counting it unread", () => {
    const { state } = applyStreamEvent(base, "attachment", withFile, { activeChannelId: "c2" })
    assert.deepEqual(state.messages.c1[0].attachments.map((a) => a.name), ["a.txt"])
    assert.equal(state.channels.find((c) => c.id === "c1")?.unread, 0)
  })

  it("does nothing for a channel that is not loaded", () => {
    const { state } = applyStreamEvent(base, "attachment", { ...withFile, id: "m9", channel_id: "c2" }, { activeChannelId: "c1" })
    assert.equal(state.messages.c2, undefined)
    assert.equal(state.channels.find((c) => c.id === "c2")?.unread, 0)
  })
})

describe("messageAuthorLabel", () => {
  it("prefers a person's display name and falls back to the id or role label", () => {
    assert.equal(messageAuthorLabel({ author_id: "kim", author_name: "김 대리" }), "김 대리")
    assert.equal(messageAuthorLabel({ author_id: "kim", author_name: null }), "kim")
    assert.notEqual(messageAuthorLabel({ author_id: "coder" }), "")
  })
})
