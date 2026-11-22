import assert from "node:assert/strict"
import test from "node:test"
import { MatrixEvent } from "matrix-js-sdk"
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
