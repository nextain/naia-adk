import assert from "node:assert/strict"
import test from "node:test"
import { MatrixEvent } from "matrix-js-sdk"
import { AxMessengerClient } from "./client.js"
import { AxMessengerError } from "./errors.js"
import * as main from "./index.js"
import type { AxSession } from "./types.js"

const SESSION: AxSession = {
  homeserverUrl: "http://127.0.0.1:6167/",
  userId: "@org:tenant.example.invalid",
  accessToken: "token",
  deviceId: "device",
}

function fakeClient(methods: Record<string, unknown>) {
  return methods as unknown as import("./client.js").MatrixClient
}

function fakeCreateClient(behavior: Record<string, unknown>) {
  return (() => fakeClient(behavior)) as unknown as typeof import("matrix-js-sdk").createClient
}

function textEvent(body: string, ts: number, sender = "@a:tenant.example.invalid") {
  return new MatrixEvent({
    event_id: `$${ts}`,
    sender,
    origin_server_ts: ts,
    type: "m.room.message",
    room_id: "!r:tenant.example.invalid",
    content: { msgtype: "m.text", body },
  })
}

function fakeRoom(overrides: Record<string, unknown> = {}) {
  return {
    roomId: "!r:tenant.example.invalid",
    name: "방",
    getMyMembership: () => "join",
    getJoinedMembers: () => [{}, {}],
    getLiveTimeline: () => ({ getEvents: () => [] }),
    getMembers: () => [],
    ...overrides,
  }
}

// FE-ax1-02-01 로그인
test("로그인 성공은 끝 슬래시를 뗀 세션을 돌려준다", async () => {
  const client = await AxMessengerClient.login("http://127.0.0.1:6167/", "org", "pw", {
    createClient: fakeCreateClient({
      login: async () => ({ user_id: "@org:tenant.example.invalid", access_token: "t", device_id: "d" }),
    }),
  })
  assert.equal(client.session.homeserverUrl, "http://127.0.0.1:6167")
  assert.equal(client.session.userId, "@org:tenant.example.invalid")
})

test("로그인 거부는 auth 갈래의 사용자 문구다", async () => {
  await assert.rejects(
    AxMessengerClient.login("http://127.0.0.1:6167", "org", "wrong", {
      createClient: fakeCreateClient({
        login: async () => { throw { httpStatus: 403, errcode: "M_FORBIDDEN", message: "forbidden" } },
      }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof AxMessengerError)
      assert.equal(error.kind, "auth")
      assert.equal(error.userMessage, "아이디나 비밀번호를 확인해 주세요.")
      return true
    },
  )
})

test("빈 로그인 입력은 invalid-input이다", async () => {
  await assert.rejects(AxMessengerClient.login("", "", ""), (error: unknown) => {
    assert.ok(error instanceof AxMessengerError)
    assert.equal(error.kind, "invalid-input")
    return true
  })
})

// FE-ax1-02-02 다시 연결
test("보관 세션으로 다시 이어진다", () => {
  const client = AxMessengerClient.fromSession(SESSION, fakeClient({}))
  assert.equal(client.session.homeserverUrl, "http://127.0.0.1:6167")
  assert.equal(client.session.userId, "@org:tenant.example.invalid")
})

test("빈 세션은 다시 잇지 않고 invalid-input이다", () => {
  assert.throws(
    () => AxMessengerClient.fromSession({ homeserverUrl: "", userId: "", accessToken: "" }),
    (error: unknown) => error instanceof AxMessengerError && error.kind === "invalid-input",
  )
})

// FE-ax1-02-03 실시간 갱신 시작·끝
test("시작 성공은 새 대화·방 바뀜 받기를 건다", async () => {
  const handlers = new Map<string, (...args: never[]) => void>()
  let stopped = false
  const client = AxMessengerClient.fromSession(SESSION, fakeClient({
    on: (event: string, handler: (...args: never[]) => void) => { handlers.set(event, handler) },
    getRooms: () => [],
    startClient: async () => undefined,
    stopClient: () => { stopped = true },
  }))
  const received: unknown[] = []
  let roomsChanged = 0
  await client.start(
    (message) => { received.push(message) },
    () => { roomsChanged += 1 },
  )
  const sync = handlers.get("sync")
  assert.ok(sync)
  sync()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(roomsChanged, 1)
  client.stop()
  assert.equal(stopped, true)
})

test("시작 실패는 사용자 문구로 감싼다", async () => {
  const client = AxMessengerClient.fromSession(SESSION, fakeClient({
    on: () => undefined,
    startClient: async () => { throw new Error("boom") },
  }))
  await assert.rejects(client.start(), (error: unknown) => {
    assert.ok(error instanceof AxMessengerError)
    assert.equal(error.userMessage, "실시간 연결을 시작하지 못했습니다. 잠시 뒤 다시 시도해 주세요.")
    return true
  })
})

// FE-ax1-02-04 방 목록·대화·참가자 읽기
test("방 목록은 들어간 방만 최신순으로 보인다", () => {
  const first = fakeRoom({ roomId: "!old:tenant.example.invalid", name: "옛방" })
  const second = fakeRoom({ roomId: "!new:tenant.example.invalid", name: "새방" })
  const invited = fakeRoom({ roomId: "!inv:tenant.example.invalid", getMyMembership: () => "invite" })
  // 최신 대화 시각을 심는다
  const withTime = (room: unknown, ts: number) => ({
    ...(room as object),
    getLiveTimeline: () => ({ getEvents: () => [textEvent("hi", ts)] }),
  })
  const client = AxMessengerClient.fromSession(SESSION, fakeClient({
    getRooms: () => [withTime(first, 1), withTime(second, 2), invited],
  }))
  const rooms = client.listRooms()
  assert.deepEqual(rooms.map((room) => room.roomId), ["!new:tenant.example.invalid", "!old:tenant.example.invalid"])
  assert.equal(rooms[0].lastMessage, "hi")
})

test("대화 읽기는 글만 시간순으로, 없는 방은 빈 값이다", () => {
  const member = new MatrixEvent({ type: "m.room.member", content: { membership: "join" } })
  const room = fakeRoom({
    getLiveTimeline: () => ({ getEvents: () => [textEvent("둘", 2), member, textEvent("하나", 1)] }),
  })
  const client = AxMessengerClient.fromSession(SESSION, fakeClient({
    getRoom: (id: string) => (id === "!r:tenant.example.invalid" ? room : null),
  }))
  const messages = client.getMessages("!r:tenant.example.invalid")
  assert.deepEqual(messages.map((message) => message.body), ["하나", "둘"])
  assert.deepEqual(client.getMessages("!없음"), [])
})

test("참가자 읽기는 이름·소속을, 없는 방은 빈 값이다", () => {
  const room = fakeRoom({
    getMembers: () => [
      { userId: "@a:tenant.example.invalid", name: "에이", membership: "join" },
      { userId: "@b:tenant.example.invalid", name: "", membership: "join" },
    ],
  })
  const client = AxMessengerClient.fromSession(SESSION, fakeClient({
    getRoom: () => room,
  }))
  assert.deepEqual(client.listParticipants("!r:tenant.example.invalid"), [
    { userId: "@a:tenant.example.invalid", displayName: "에이", membership: "join" },
    { userId: "@b:tenant.example.invalid", displayName: "@b:tenant.example.invalid", membership: "join" },
  ])
  const empty = AxMessengerClient.fromSession(SESSION, fakeClient({ getRoom: () => null }))
  assert.deepEqual(empty.listParticipants("!없음"), [])
})

// FE-ax1-02-05 보내기
test("보내기 성공은 방·글을 넘긴다", async () => {
  let got: unknown
  const client = AxMessengerClient.fromSession(SESSION, fakeClient({
    sendTextMessage: async (roomId: string, body: string) => { got = [roomId, body] },
  }))
  await client.sendText("!r:tenant.example.invalid", "  업무 글  ")
  assert.deepEqual(got, ["!r:tenant.example.invalid", "업무 글"])
})

test("빈 글은 보내지 않고 invalid-input이다", async () => {
  const client = AxMessengerClient.fromSession(SESSION, fakeClient({ sendTextMessage: async () => undefined }))
  await assert.rejects(client.sendText("!r:tenant.example.invalid", "   "), (error: unknown) => {
    assert.ok(error instanceof AxMessengerError)
    assert.equal(error.kind, "invalid-input")
    assert.equal(error.userMessage, "메시지를 입력해 주세요.")
    return true
  })
})

test("빈도 초과 거부는 rate-limited 갈래다", async () => {
  const client = AxMessengerClient.fromSession(SESSION, fakeClient({
    sendTextMessage: async () => { throw { httpStatus: 429, errcode: "M_LIMIT_EXCEEDED", message: "slow" } },
  }))
  await assert.rejects(client.sendText("!r:tenant.example.invalid", "글"), (error: unknown) => {
    assert.ok(error instanceof AxMessengerError)
    assert.equal(error.kind, "rate-limited")
    return true
  })
})

// FE-ax1-02-06 파일 올리기·내려받기
test("파일 올리기 성공은 그림 갈래를 구분한다", async () => {
  const calls: unknown[] = []
  const client = AxMessengerClient.fromSession(SESSION, fakeClient({
    uploadContent: async () => ({ content_uri: "mxc://tenant.example.invalid/abc" }),
    sendEvent: async (...args: unknown[]) => { calls.push(args) },
  }))
  await client.sendFile("!r:tenant.example.invalid", {
    name: "그림.png",
    mimeType: "image/png",
    size: 10,
    data: new Blob(["x"]),
  })
  const content = (calls[0] as unknown[])[2] as Record<string, unknown>
  assert.equal(content["msgtype"], "m.image")
  assert.equal(content["url"], "mxc://tenant.example.invalid/abc")
})

test("크기 초과 올리기는 too-large 갈래다", async () => {
  const client = AxMessengerClient.fromSession(SESSION, fakeClient({
    uploadContent: async () => { throw { httpStatus: 413, errcode: "M_TOO_LARGE", message: "big" } },
  }))
  await assert.rejects(
    client.sendFile("!r:tenant.example.invalid", { name: "큰.bin", mimeType: "application/octet-stream", size: 1, data: new Blob(["x"]) }),
    (error: unknown) => error instanceof AxMessengerError && error.kind === "too-large",
  )
})

test("파일 내려받기 성공은 바이트를 돌려준다", async () => {
  const realFetch = globalThis.fetch
  const client = AxMessengerClient.fromSession(SESSION, fakeClient({
    mxcUrlToHttp: () => "http://127.0.0.1:6167/_matrix/media/download/abc",
  }))
  globalThis.fetch = (async () => new Response("bytes", { status: 200 })) as typeof fetch
  try {
    const blob = await client.downloadMedia("mxc://tenant.example.invalid/abc")
    assert.equal(await blob.text(), "bytes")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("잘못된 파일 주소는 invalid-input이다", async () => {
  const client = AxMessengerClient.fromSession(SESSION, fakeClient({ mxcUrlToHttp: () => null }))
  await assert.rejects(client.downloadMedia("https://example.com/x"), (error: unknown) => {
    assert.ok(error instanceof AxMessengerError)
    assert.equal(error.kind, "invalid-input")
    return true
  })
})

// 비밀번호 바꾸기(첫 로그인 흐름, 화면 몫의 강제와 잇는 호출)
test("비밀번호 바꾸기 성공과 실패 갈래", async () => {
  let authed: unknown
  const ok = AxMessengerClient.fromSession(SESSION, fakeClient({
    setPassword: async (auth: unknown) => { authed = auth },
  }))
  await ok.changePassword("old", "new")
  assert.match(JSON.stringify(authed), /m\.login\.password/)
  const denied = AxMessengerClient.fromSession(SESSION, fakeClient({
    setPassword: async () => { throw { httpStatus: 403, errcode: "M_FORBIDDEN", message: "no" } },
  }))
  await assert.rejects(denied.changePassword("old", "new"), (error: unknown) => {
    assert.ok(error instanceof AxMessengerError)
    assert.equal(error.kind, "auth")
    return true
  })
})

// 출입구 분리: 직접 길에서 관리 일을 가져갈 수 없다
test("직접 길 출입구에 관리 함수가 없다", () => {
  for (const name of ["provisionAccount", "createRoom", "invite", "setDisplayName", "createUsageCollector"]) {
    assert.ok(!(name in main), `${name}은 직접 길에 없어야 한다`)
  }
  assert.ok("AxMessengerClient" in main)
  assert.ok("messageFromEvent" in main)
})
