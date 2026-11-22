import assert from "node:assert/strict"
import test from "node:test"
import { createClient, MatrixEvent } from "matrix-js-sdk"
import { AxMessengerClient, messageFromEvent, type MatrixClient } from "./index.js"

const roomId = "!shared:local"
const alice = "@alice:local"
const bob = "@bob:local"
const session = (userId: string) => ({ homeserverUrl: "http://127.0.0.1:1", userId, accessToken: `${userId}-token` })
const event = (id: string, sender: string, content: Record<string, unknown>) => new MatrixEvent({
  event_id: id, sender, room_id: roomId, origin_server_ts: 1, type: "m.room.message", content,
})

test("두 모의 세션은 일반 글과 멘션·원문 관계를 보존하고 비가입 캐시를 숨긴다", async () => {
  const events = [event("$original", alice, { msgtype: "m.text", body: "원문" })]
  const sent: Array<{ sender: string; content: Record<string, unknown> }> = []
  function account(userId: string, membership: string) {
    const room = {
      roomId, name: "shared", getMyMembership: () => membership,
      getJoinedMembers: () => [{}, {}], getMembers: () => [{ userId: alice, name: "Alice", membership: "join" }],
      getLiveTimeline: () => ({ getEvents: () => events }),
    }
    const matrix = {
      getRoom: (id: string) => id === roomId ? room : null,
      getRooms: () => [room],
      sendTextMessage: async (_room: string, body: string) => { sent.push({ sender: userId, content: { msgtype: "m.text", body } }) },
      sendMessage: async (_room: string, content: Record<string, unknown>) => { sent.push({ sender: userId, content }) },
    } as unknown as MatrixClient
    return AxMessengerClient.fromSession(session(userId), matrix)
  }
  const a = account(alice, "join")
  const b = account(bob, "join")
  const outsider = account("@outsider:local", "invite")
  assert.notEqual(a.session.accessToken, b.session.accessToken)
  await a.sendText(roomId, "안녕")
  await b.sendText(roomId, "답", { replyToEventId: "$original", mentionUserIds: [alice, alice] })
  assert.deepEqual(sent[0], { sender: alice, content: { msgtype: "m.text", body: "안녕" } })
  assert.deepEqual(sent[1], { sender: bob, content: {
    msgtype: "m.text", body: "> <@alice:local> 원문\n\n답", "m.mentions": { user_ids: [alice] },
    "m.relates_to": { "m.in_reply_to": { event_id: "$original" } },
  } })
  events.push(event("$reply", bob, sent[1].content))
  for (const client of [a, b]) {
    const reply = client.getMessages(roomId)[1]
    assert.equal(reply.eventId, "$reply")
    assert.equal(reply.body, "답")
    assert.equal(reply.replyToEventId, "$original")
    assert.deepEqual(reply.mentionUserIds, [alice])
    assert.equal(client.listRooms()[0].lastMessage, "답")
  }
  assert.deepEqual(outsider.listRooms(), [])
  assert.deepEqual(outsider.getMessages(roomId), [])
  assert.deepEqual(outsider.listParticipants(roomId), [])
  await assert.rejects(outsider.sendText(roomId, "답", { replyToEventId: "$original" }))
  assert.equal(sent.length, 2)
})

test("원문 ID와 멘션 입력을 검증하고 실패 시 전송하지 않는다", async () => {
  let sends = 0
  const room = { getMyMembership: () => "join", getLiveTimeline: () => ({ getEvents: () => [event("$real", alice, { msgtype: "m.text", body: "a" })] }) }
  const client = AxMessengerClient.fromSession(session(bob), {
    getRoom: () => room,
    sendMessage: async () => { sends++ },
  } as unknown as MatrixClient)
  for (const replyToEventId of ["synthetic", "$absent", "", "$bad id"]) {
    await assert.rejects(client.sendText(roomId, "답", { replyToEventId }))
  }
  await assert.rejects(client.sendText(roomId, "답", { mentionUserIds: ["alice"] }))
  assert.equal(sends, 0)
})

test("수신 답글의 fallback은 제거하고 관계 ID로 원문을 찾는다", () => {
  const received = event("$reply", bob, {
    msgtype: "m.text", body: "> <@alice:local> 위조된 인용\n> 두 줄\n\n답",
    "m.relates_to": { "m.in_reply_to": { event_id: "$original" } },
    "m.mentions": { user_ids: [alice] },
  })
  const parsed = messageFromEvent(received, roomId)
  assert.equal(parsed?.body, "답")
  assert.equal(parsed?.replyToEventId, "$original")
  assert.deepEqual(parsed?.mentionUserIds, [alice])
  assert.equal(messageFromEvent(event("$plain", bob, { msgtype: "m.text", body: "> 인용\n\n내용" }), roomId)?.body, "> 인용\n\n내용")
  assert.equal(messageFromEvent(event("$file-reply", bob, {
    msgtype: "m.text", body: "> <@alice:local> sent a file.\n답",
    "m.relates_to": { "m.in_reply_to": { event_id: "$original" } },
  }), roomId)?.body, "답")
})

test("관계 글 보내기 실패는 한 번만 호출하고 오류를 전파한다", async () => {
  let sends = 0
  const client = AxMessengerClient.fromSession(session(bob), {
    sendMessage: async () => { sends++; throw { httpStatus: 429, errcode: "M_LIMIT_EXCEEDED" } },
  } as unknown as MatrixClient)
  await assert.rejects(client.sendText(roomId, "안녕", { mentionUserIds: [alice] }))
  assert.equal(sends, 1)
})

test("답 본문의 인용은 fallback을 벗긴 뒤에도 남는다", async () => {
  const original = event("$original", alice, { msgtype: "m.text", body: "원문" })
  let sent: Record<string, unknown> = {}
  const client = AxMessengerClient.fromSession(session(bob), {
    getRoom: () => ({ getMyMembership: () => "join", getLiveTimeline: () => ({ getEvents: () => [original] }) }),
    sendMessage: async (_room: string, content: Record<string, unknown>) => { sent = content },
  } as unknown as MatrixClient)
  await client.sendText(roomId, "> 내 인용\n\n답", { replyToEventId: "$original" })
  assert.deepEqual(sent["m.mentions"], {})
  assert.equal(messageFromEvent(event("$reply", bob, sent), roomId)?.body, "> 내 인용\n\n답")
})

test("결과를 모르는 시간 초과는 자동으로 다시 보내지 않는다", async () => {
  let sends = 0
  const client = AxMessengerClient.fromSession(session(bob), {
    sendMessage: async () => { sends++; throw Object.assign(new Error("timeout"), { name: "TimeoutError" }) },
  } as unknown as MatrixClient)
  await assert.rejects(client.sendText(roomId, "안녕", { mentionUserIds: [alice] }))
  assert.equal(sends, 1)
})

test("실시간 콜백은 가입한 방의 메시지만 전달한다", async () => {
  let handler: ((event: MatrixEvent) => void) | undefined
  let membership = "invite"
  const client = AxMessengerClient.fromSession(session(bob), {
    on: (kind: string, fn: (event: MatrixEvent) => void) => { if (kind === "event") handler = fn },
    getRoom: () => ({ getMyMembership: () => membership }),
    startClient: async () => undefined,
  } as unknown as MatrixClient)
  const seen: string[] = []
  await client.start((message) => { seen.push(message.body) })
  assert.ok(handler)
  const incoming = event("$incoming", alice, { msgtype: "m.text", body: "내용" })
  handler(incoming)
  membership = "leave"
  handler(incoming)
  membership = "join"
  handler(incoming)
  assert.deepEqual(seen, ["내용"])
})

test("각 세션은 캐시 밖 원문을 자기 방에서 조회해 답한다", async () => {
  const calls: string[] = []
  const sent: Record<string, unknown>[] = []
  const make = (userId: string) => AxMessengerClient.fromSession(session(userId), {
    getRoom: (id: string) => id === roomId ? { getMyMembership: () => "join", getLiveTimeline: () => ({ getEvents: () => [] }) } : null,
    fetchRoomEvent: async (room: string, id: string) => { calls.push(`${userId}:${room}:${id}`); return event(id, alice, { msgtype: "m.text", body: "지난 글" }).event },
    sendMessage: async (_room: string, content: Record<string, unknown>) => { sent.push(content) },
  } as unknown as MatrixClient)
  await make(alice).sendText(roomId, "답1", { replyToEventId: "$old" })
  await make(bob).sendText(roomId, "답2", { replyToEventId: "$old" })
  assert.deepEqual(calls, [`${alice}:${roomId}:$old`, `${bob}:${roomId}:$old`])
  assert.equal(sent[0].body, "> <@alice:local> 지난 글\n\n답1")
  assert.deepEqual(sent[1]["m.relates_to"], { "m.in_reply_to": { event_id: "$old" } })
})

test("SDK 단건 조회는 세션별 인증과 요청한 방·이벤트 경로를 사용한다", async () => {
  const requests: Array<{ path: string; authorization: string | null }> = []
  const fetchFn: typeof fetch = async (input, init) => {
    requests.push({ path: new URL(String(input)).pathname, authorization: new Headers(init?.headers).get("authorization") })
    return new Response(JSON.stringify(event("$old", alice, { msgtype: "m.text", body: "지난 글" }).event), { status: 200, headers: { "Content-Type": "application/json" } })
  }
  for (const userId of [alice, bob]) {
    const matrix = createClient({ baseUrl: "http://127.0.0.1:1", userId, accessToken: `${userId}-token`, fetchFn })
    matrix.getRoom = (() => ({ getMyMembership: () => "join", getLiveTimeline: () => ({ getEvents: () => [] }) })) as unknown as MatrixClient["getRoom"]
    matrix.sendMessage = (async () => ({})) as unknown as MatrixClient["sendMessage"]
    await AxMessengerClient.fromSession(session(userId), matrix).sendText(roomId, "답", { replyToEventId: "$old" })
  }
  assert.deepEqual(requests, [alice, bob].map((userId) => ({
    path: `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent("$old")}`,
    authorization: `Bearer ${userId}-token`,
  })))
})

test("가입하지 않은 방과 잘못된 ID는 조회하거나 발송하지 않는다", async () => {
  let fetches = 0, sends = 0
  let membership = "invite"
  const client = AxMessengerClient.fromSession(session(bob), {
    getRoom: (id: string) => id === roomId ? { getMyMembership: () => membership, getLiveTimeline: () => ({ getEvents: () => [] }) } : null,
    fetchRoomEvent: async () => { fetches++; throw new Error("unexpected") },
    sendMessage: async () => { sends++ },
  } as unknown as MatrixClient)
  await assert.rejects(client.sendText(roomId, "답", { replyToEventId: "$old" }))
  await assert.rejects(client.sendText("!other:local", "답", { replyToEventId: "$old" }))
  membership = "join"
  for (const id of ["", "invalid", "$bad id"]) await assert.rejects(client.sendText(roomId, "답", { replyToEventId: id }))
  assert.equal(fetches, 0)
  assert.equal(sends, 0)
})

test("캐시 원문을 우선하고 반환 원문의 방·ID·열람 가능성을 검사한다", async () => {
  const original = event("$old", alice, { msgtype: "m.text", body: "원문" })
  let cached: MatrixEvent[] = [original]
  let response = original.event
  let fetches = 0, sends = 0
  const client = AxMessengerClient.fromSession(session(bob), {
    getRoom: () => ({ getMyMembership: () => "join", getLiveTimeline: () => ({ getEvents: () => cached }) }),
    fetchRoomEvent: async () => { fetches++; return response },
    sendMessage: async () => { sends++ },
  } as unknown as MatrixClient)
  await client.sendText(roomId, "답", { replyToEventId: "$old" })
  assert.equal(fetches, 0)
  cached = []
  for (const invalid of [
    { ...original.event, room_id: "!other:local" },
    { ...original.event, room_id: undefined },
    { ...original.event, event_id: "$other" },
    { ...original.event, type: "m.room.member" },
    { ...original.event, content: {} },
    { ...original.event, sender: undefined },
    { ...original.event, unsigned: { redacted_because: { type: "m.room.redaction" } } },
  ]) {
    response = invalid
    await assert.rejects(client.sendText(roomId, "답", { replyToEventId: "$old" }))
  }
  assert.equal(fetches, 7)
  assert.equal(sends, 1)
})

test("조회 실패와 조회 중 세션 종료 또는 탈퇴는 발송하지 않는다", async () => {
  let sends = 0, membership = "join"
  let fetchEvent: () => Promise<ReturnType<typeof event>["event"]> = async () => { throw { httpStatus: 403, errcode: "M_FORBIDDEN" } }
  const client = AxMessengerClient.fromSession(session(bob), {
    getRoom: () => ({ getMyMembership: () => membership, getLiveTimeline: () => ({ getEvents: () => [] }) }),
    fetchRoomEvent: () => fetchEvent(),
    sendMessage: async () => { sends++ },
    stopClient: () => undefined,
  } as unknown as MatrixClient)
  for (const [status, errcode, kind] of [[403, "M_FORBIDDEN", "forbidden"], [404, "M_NOT_FOUND", "unknown"], [401, "M_UNKNOWN_TOKEN", "auth"], [500, "M_UNKNOWN", "server"]] as const) {
    fetchEvent = async () => { throw { httpStatus: status, errcode } }
    await assert.rejects(client.sendText(roomId, "답", { replyToEventId: "$old" }), (error: any) => error.status === status && error.kind === kind)
  }
  fetchEvent = async () => { membership = "leave"; return event("$old", alice, { msgtype: "m.text", body: "원문" }).event }
  await assert.rejects(client.sendText(roomId, "답", { replyToEventId: "$old" }))
  membership = "join"
  fetchEvent = async () => { client.stop(); return event("$old", alice, { msgtype: "m.text", body: "원문" }).event }
  await assert.rejects(client.sendText(roomId, "답", { replyToEventId: "$old" }))
  assert.equal(sends, 0)
})
