import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"
import {
  AX_GREETING_HISTORY_LIMIT,
  AX_GREETING_MARKER_KEY,
  AX_MATRIX_SEND_TIMEOUT_MS,
  AxMatrixAuthError,
  greetingMarkerFor,
  hasPostedGreeting,
  isMatrixAuthFailure,
  putJsonWithDeadline,
} from "./matrix-send.js"

// 실제 HTTP 서버·실제 fetch로 기한을 본다. 주입 가짜가 아니라 진짜로
// 늦게 답하는 서버를 기한 안에 끊는지 확인한다.
async function withSlowServer(responseDelayMs: number, run: (url: string, seen: () => number) => Promise<void>) {
  let hits = 0
  const server = createServer((_request, response) => {
    hits += 1
    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" })
      response.end("{}")
    }, responseDelayMs)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  try {
    await run(`http://127.0.0.1:${port}/send`, () => hits)
  } finally {
    server.close()
  }
}

test("보내기 기한을 넘기면 끊고 오류를 던진다", async () => {
  await withSlowServer(300, async (url, seen) => {
    await assert.rejects(
      putJsonWithDeadline(url, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" }, 50),
      /기한/,
    )
    // 부하 중에는 기한 전에 서버에 도착하지 않을 수도 있다. 어느 쪽이든
    // 결과는 모름이며, 서버에 도착한 요청이 여러 번이어서는 안 된다.
    assert.ok(seen() <= 1)
  })
})

test("기한 만료는 진행 중인 요청의 signal을 중단한다", async () => {
  let attempts = 0
  let aborted = false
  const fetchImpl = ((_url: unknown, init: RequestInit) => {
    attempts++
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")) }, { once: true })
    })
  }) as typeof fetch
  await assert.rejects(putJsonWithDeadline("http://127.0.0.1:1/send", {
    method: "PUT", headers: {}, body: "{}",
  }, 10, fetchImpl), /기한/)
  assert.equal(aborted, true)
  assert.equal(attempts, 1)
})

test("기한 안에 답이 오면 성공한다", async () => {
  await withSlowServer(10, async (url) => {
    const response = await putJsonWithDeadline(
      url,
      { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" },
      2_000,
    )
    assert.equal(response.status, 200)
  })
})

test("보내기 기한 값은 10초이다", () => {
  assert.equal(AX_MATRIX_SEND_TIMEOUT_MS, 10_000)
})

test("표지 값은 기관과 방을 함께 담는다", () => {
  assert.equal(greetingMarkerFor("org-a", "!r1:tenant.example.invalid"), "org-a:!r1:tenant.example.invalid")
  assert.throws(() => greetingMarkerFor("", "!r1:tenant.example.invalid"), /기관·방/)
  assert.throws(() => greetingMarkerFor("org-a", ""), /기관·방/)
  assert.equal(AX_GREETING_MARKER_KEY, "io.nextain.greeting")
  assert.equal(AX_GREETING_HISTORY_LIMIT, 50)
})

test("표지 글이 있으면 true, 없으면 false다", async () => {
  const chunk = [
    { sender: "@bot:tenant.example.invalid", content: { msgtype: "m.text", body: "인사", [AX_GREETING_MARKER_KEY]: "org-a:!r1:tenant.example.invalid" } },
    { sender: "@bot:tenant.example.invalid", content: { msgtype: "m.text", body: "다른 말" } },
    { sender: "@user:tenant.example.invalid", content: { msgtype: "m.text", body: "인사", [AX_GREETING_MARKER_KEY]: "org-a:!r1:tenant.example.invalid" } },
  ]
  const fakeFetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ chunk }),
  })) as unknown as typeof fetch
  const base = {
    homeserverUrl: "http://127.0.0.1:9",
    accessToken: "token",
    roomId: "!r1:tenant.example.invalid",
    userId: "@bot:tenant.example.invalid",
    orgId: "org-a",
    fetchImpl: fakeFetch,
  }
  assert.equal(await hasPostedGreeting(base), true)
  // 표지가 없고 본문만 같은 봇 글은 옛 인사 대조로 true다.
  const legacy = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ chunk: [{ sender: "@bot:tenant.example.invalid", content: { msgtype: "m.text", body: "옛 인사" } }] }),
  })) as unknown as typeof fetch
  assert.equal(await hasPostedGreeting({ ...base, fetchImpl: legacy, greetingBody: "옛 인사" }), true)
  // 남의 표지·다른 방 표지는 false다.
  const others = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      chunk: [
        { sender: "@user:tenant.example.invalid", content: { msgtype: "m.text", body: "인사", [AX_GREETING_MARKER_KEY]: "org-a:!r1:tenant.example.invalid" } },
        { sender: "@bot:tenant.example.invalid", content: { msgtype: "m.text", body: "인사", [AX_GREETING_MARKER_KEY]: "org-a:!다른방" } },
      ],
    }),
  })) as unknown as typeof fetch
  assert.equal(await hasPostedGreeting({ ...base, fetchImpl: others, greetingBody: "표지 없는 옛 인사" }), false)
})

test("방 흐름 읽기가 기한을 넘기면 던진다", async () => {
  const server = createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ chunk: [] }))
    }, 300)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  try {
    const started = Date.now()
    await assert.rejects(
      hasPostedGreeting({
        homeserverUrl: `http://127.0.0.1:${port}`,
        accessToken: "bot-token",
        roomId: "!r1:tenant.example.invalid",
        userId: "@bot:tenant.example.invalid",
        orgId: "org-a",
        timeoutMs: 50,
      }),
      /기한/,
    )
    assert.ok(Date.now() - started < 300, "기한 안에 끊어야 한다")
  } finally {
    server.close()
  }
})

test("방 흐름 읽기가 실패하면 없음으로 두지 않고 던진다", async () => {
  const failing = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch
  await assert.rejects(
    hasPostedGreeting({
      homeserverUrl: "http://127.0.0.1:9",
      accessToken: "token",
      roomId: "!r1:tenant.example.invalid",
      userId: "@bot:tenant.example.invalid",
      orgId: "org-a",
      fetchImpl: failing,
    }),
    /방 흐름/,
  )
})

test("방 흐름 조회는 뒤·50건·봇 토큰으로 묻는다", async () => {
  let seenUrl = ""
  let seenAuth = ""
  const server = createServer((request, response) => {
    seenUrl = request.url ?? ""
    seenAuth = request.headers.authorization ?? ""
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({
      chunk: [
        { sender: "@bot:tenant.example.invalid", content: { msgtype: "m.text", body: "인사", [AX_GREETING_MARKER_KEY]: "org-a:!r1:tenant.example.invalid" } },
      ],
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  try {
    const found = await hasPostedGreeting({
      homeserverUrl: `http://127.0.0.1:${port}`,
      accessToken: "bot-token",
      roomId: "!r1:tenant.example.invalid",
      userId: "@bot:tenant.example.invalid",
      orgId: "org-a",
    })
    assert.equal(found, true)
    assert.ok(seenUrl.includes("/rooms/!r1%3Atenant.example.invalid/messages"), `방 흐름 경로이어야 한다(${seenUrl})`)
    assert.ok(seenUrl.includes("dir=b"), `뒤에서 읽어야 한다(${seenUrl})`)
    assert.ok(seenUrl.includes("limit=50"), `상한 50이어야 한다(${seenUrl})`)
    assert.equal(seenAuth, "Bearer bot-token")
  } finally {
    server.close()
  }
})

test("401은 인증 거부로 본다(일반 오류와 길을 나눈다)", () => {
  assert.equal(isMatrixAuthFailure(401), true)
  assert.equal(isMatrixAuthFailure(401, "M_UNKNOWN_TOKEN"), true)
  assert.equal(isMatrixAuthFailure(401, "M_MISSING_TOKEN"), true)
  assert.equal(isMatrixAuthFailure(500), false)
  assert.equal(isMatrixAuthFailure(400), false)
  assert.equal(isMatrixAuthFailure(200), false)
})

test("방 흐름 401은 인증 끊김 오류로 던진다", async () => {
  const authFail = (async () => ({
    ok: false,
    status: 401,
    json: async () => ({ errcode: "M_UNKNOWN_TOKEN" }),
  })) as unknown as typeof fetch
  try {
    await hasPostedGreeting({
      homeserverUrl: "http://127.0.0.1:9",
      accessToken: "stale-token",
      roomId: "!r1:tenant.example.invalid",
      userId: "@bot:tenant.example.invalid",
      orgId: "org-a",
      fetchImpl: authFail,
    })
    assert.fail("인증 끊김은 따로 던져야 한다")
  } catch (error) {
    assert.ok(error instanceof AxMatrixAuthError, "인증 끊김 오류이어야 한다")
    assert.equal((error as AxMatrixAuthError).status, 401)
    assert.equal((error as AxMatrixAuthError).errcode, "M_UNKNOWN_TOKEN")
  }
})
