import assert from "node:assert/strict"
import test from "node:test"
import {
  createRoom,
  createUsageCollector,
  invite,
  provisionAccount,
  setDisplayName,
} from "./admin.js"
import { AxMessengerError, httpStatusOfAxError } from "./errors.js"

const BASE = "http://127.0.0.1:6167"
const SESSION = { homeserverUrl: BASE, userId: "@admin:tenant.example.invalid", accessToken: "t" }

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

// FE-ax1-02-07 계정 발급
test("발급 성공은 아이디·1회 비밀번호·이름을 돌려준다", async () => {
  const seen: string[] = []
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const path = String(url)
    seen.push(path)
    if (path.endsWith("/register") && init?.body && !String(init.body).includes("registration_token")) {
      return jsonResponse({ session: "s1" })
    }
    if (path.endsWith("/register")) return jsonResponse({ user_id: "@org1:tenant.example.invalid" })
    if (path.endsWith("/login")) return jsonResponse({ user_id: "@org1:tenant.example.invalid", access_token: "a" })
    return jsonResponse({})
  }) as typeof fetch
  const result = await provisionAccount({
    homeserverUrl: BASE,
    registrationToken: "reg",
    localpart: "org1",
    displayName: "조직 담당자",
    deps: { fetchImpl },
  })
  assert.equal(result.userId, "@org1:tenant.example.invalid")
  assert.ok(result.password.length >= 8)
  assert.equal(result.displayName, "조직 담당자")
  assert.deepEqual(result.pending, [])
  assert.equal(result.notice, undefined)
  assert.ok(seen.some((path) => path.endsWith("/register")))
})

test("이미 쓴 아이디는 invalid-input 사용자 문구다", async () => {
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/register") && init?.body && !String(init.body).includes("registration_token")) {
      return jsonResponse({ session: "s1" })
    }
    return jsonResponse({ errcode: "M_USER_IN_USE", error: "taken" }, 400)
  }) as typeof fetch
  await assert.rejects(
    provisionAccount({ homeserverUrl: BASE, registrationToken: "reg", localpart: "org1", displayName: "이름", deps: { fetchImpl } }),
    (error: unknown) => {
      assert.ok(error instanceof AxMessengerError)
      assert.equal(error.kind, "invalid-input")
      assert.equal(error.userMessage, "이미 사용 중인 아이디입니다.")
      return true
    },
  )
})

test("잘못된 발급 입력은 invalid-input이다", async () => {
  await assert.rejects(
    provisionAccount({ homeserverUrl: BASE, registrationToken: "reg", localpart: "BAD ID!", displayName: "이름" }),
    (error: unknown) => error instanceof AxMessengerError && error.kind === "invalid-input",
  )
})

function provisionFetch(overrides: Record<string, (init?: RequestInit) => Response>) {
  return (async (url: unknown, init?: RequestInit) => {
    const path = String(url)
    if (path.endsWith("/register")) {
      if (init?.body && !String(init.body).includes("registration_token")) return jsonResponse({ session: "s1" })
      return jsonResponse({ user_id: "@org1:tenant.example.invalid" })
    }
    if (path.endsWith("/login")) return overrides["login"]?.(init) ?? jsonResponse({ user_id: "@org1:tenant.example.invalid", access_token: "tok-secret-1" })
    if (path.endsWith("/displayname")) return overrides["displayname"]?.(init) ?? jsonResponse({})
    if (path.endsWith("/logout")) return overrides["logout"]?.(init) ?? jsonResponse({})
    return jsonResponse({})
  }) as typeof fetch
}

const SECRET_RE = /m\.login\.password|password|access_token|tok-secret|registration_token|Bearer/i

function provisionInput(fetchImpl: typeof fetch) {
  return {
    homeserverUrl: BASE,
    registrationToken: "reg-token-secret",
    localpart: "org1",
    displayName: "조직 담당자",
    deps: { fetchImpl },
  }
}

test("이미 쓴 아이디 오류는 409 대응이다", async () => {
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/register") && init?.body && !String(init.body).includes("registration_token")) {
      return jsonResponse({ session: "s1" })
    }
    return jsonResponse({ errcode: "M_USER_IN_USE", error: "taken" }, 400)
  }) as typeof fetch
  const error = await provisionAccount(provisionInput(fetchImpl)).then(
    () => { throw new Error("실패해야 한다") },
    (error: unknown) => error,
  )
  assert.ok(error instanceof AxMessengerError)
  assert.equal(error.kind, "invalid-input")
  assert.equal(error.userMessage, "이미 사용 중인 아이디입니다.")
  assert.equal(httpStatusOfAxError(error), 409)
})

test("로그인 실패(403)는 비밀번호를 돌려주는 부분 성공으로 돌려준다", async () => {
  const result = await provisionAccount(provisionInput(provisionFetch({
    login: () => jsonResponse({ errcode: "M_FORBIDDEN", error: "bad" }, 403),
  })))
  assert.equal(result.userId, "@org1:tenant.example.invalid")
  assert.ok(result.password.length >= 8)
  assert.deepEqual(result.pending, ["login"])
  assert.equal(result.notice, "계정을 만들었으나 로그인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.")
  assert.doesNotMatch(`${result.notice ?? ""} ${result.password}`, SECRET_RE)
})

test("빈 토큰 로그인은 부분 성공(pending login)으로 돌려준다", async () => {
  const result = await provisionAccount(provisionInput(provisionFetch({
    login: () => jsonResponse({ user_id: "@org1:tenant.example.invalid" }),
  })))
  assert.equal(result.userId, "@org1:tenant.example.invalid")
  assert.ok(result.password.length >= 8)
  assert.deepEqual(result.pending, ["login"])
  assert.equal(result.notice, "계정을 만들었으나 로그인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.")
  assert.doesNotMatch(`${result.notice ?? ""}`, SECRET_RE)
})

test("로그인 끊김도 비밀번호를 돌려주는 부분 성공으로 돌려준다", async () => {
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const path = String(url)
    if (path.endsWith("/register")) {
      if (init?.body && !String(init.body).includes("registration_token")) return jsonResponse({ session: "s1" })
      return jsonResponse({ user_id: "@org1:tenant.example.invalid" })
    }
    throw Object.assign(new TypeError("fetch failed"), { code: "ECONNREFUSED" })
  }) as typeof fetch
  const result = await provisionAccount(provisionInput(fetchImpl))
  assert.equal(result.userId, "@org1:tenant.example.invalid")
  assert.ok(result.password.length >= 8)
  assert.deepEqual(result.pending, ["login"])
  assert.ok((result.notice ?? "").length > 0)
  assert.doesNotMatch(`${result.notice ?? ""}`, SECRET_RE)
})

test("표시 이름 실패는 비밀번호를 돌려주는 부분 성공으로 돌려준다", async () => {
  let logoutCalls = 0
  const fetchImpl = provisionFetch({
    displayname: () => jsonResponse({ errcode: "M_UNKNOWN", error: "no" }, 500),
    logout: () => {
      logoutCalls += 1
      return jsonResponse({})
    },
  })
  const result = await provisionAccount(provisionInput(fetchImpl))
  assert.equal(result.userId, "@org1:tenant.example.invalid")
  assert.ok(result.password.length >= 8)
  assert.deepEqual(result.pending, ["display-name"])
  assert.equal(result.notice, "계정은 만들었으나 이름을 설정하지 못했습니다. 다시 로그인해 이름을 설정해 주세요.")
  assert.doesNotMatch(`${result.notice ?? ""}`, SECRET_RE)
  assert.equal(logoutCalls, 1)
})

test("등록 자체가 실패하면 부분 성공이 아니라 던진다", async () => {
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/register") && init?.body && !String(init.body).includes("registration_token")) {
      return jsonResponse({ session: "s1" })
    }
    return jsonResponse({ errcode: "M_UNKNOWN", error: "no" }, 500)
  }) as typeof fetch
  await assert.rejects(
    provisionAccount(provisionInput(fetchImpl)),
    (error: unknown) => {
      assert.ok(error instanceof AxMessengerError)
      assert.equal(error.userMessage, "계정을 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.")
      assert.equal(httpStatusOfAxError(error), 502)
      return true
    },
  )
})

test("로그인 실패 때 표시 이름 요청을 보내지 않는다", async () => {
  const seen: string[] = []
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const path = String(url)
    seen.push(path)
    if (path.endsWith("/register")) {
      if (init?.body && !String(init.body).includes("registration_token")) return jsonResponse({ session: "s1" })
      return jsonResponse({ user_id: "@org1:tenant.example.invalid" })
    }
    if (path.endsWith("/login")) return jsonResponse({ errcode: "M_FORBIDDEN", error: "bad" }, 403)
    return jsonResponse({})
  }) as typeof fetch
  const result = await provisionAccount(provisionInput(fetchImpl))
  assert.deepEqual(result.pending, ["login"])
  assert.ok(!seen.some((path) => path.endsWith("/displayname")))
})

test("로그아웃 실패(거부·끊김)는 발급 성공을 막지 않고 detail 기록만 남긴다", async () => {
  const warned: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(" ")) }
  try {
    const rejected = await provisionAccount(provisionInput(provisionFetch({
      logout: () => jsonResponse({ errcode: "M_UNKNOWN_TOKEN", error: "gone" }, 401),
    })))
    assert.equal(rejected.userId, "@org1:tenant.example.invalid")
    assert.ok(rejected.password.length >= 8)
    const thrown = (async () => { throw Object.assign(new TypeError("fetch failed"), { code: "ECONNREFUSED" }) }) as unknown as typeof fetch
    const fetchImpl = provisionFetch({})
    const mixed = (async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith("/logout")) return thrown(url, init)
      return fetchImpl(url, init)
    }) as typeof fetch
    const second = await provisionAccount(provisionInput(mixed))
    assert.equal(second.userId, "@org1:tenant.example.invalid")
    assert.ok(second.password.length >= 8)
    assert.ok(warned.length >= 2)
    for (const line of warned) {
      assert.match(line, /ax-provision: logout/)
      assert.doesNotMatch(line, SECRET_RE)
    }
  } finally {
    console.warn = originalWarn
  }
})

// FE-ax1-02-07 방 만들기·초대·표시 이름
test("방 만들기 성공은 방 아이디를 돌려준다", async () => {
  const createClient = (() => ({
    createRoom: async (options: { name: string }) => {
      assert.equal(options.name, "조직 · 뼈대 세우기")
      return { room_id: "!new:tenant.example.invalid" }
    },
  })) as unknown as typeof import("matrix-js-sdk").createClient
  const roomId = await createRoom(SESSION, "조직 · 뼈대 세우기", ["@org:tenant.example.invalid"], { createClient })
  assert.equal(roomId, "!new:tenant.example.invalid")
})

test("방 만들기 거부는 사용자 문구로 감싼다", async () => {
  const createClient = (() => ({
    createRoom: async () => { throw { httpStatus: 403, errcode: "M_FORBIDDEN", message: "no" } },
  })) as unknown as typeof import("matrix-js-sdk").createClient
  await assert.rejects(createRoom(SESSION, "방", [], { createClient }), (error: unknown) => {
    assert.ok(error instanceof AxMessengerError)
    assert.equal(error.kind, "forbidden")
    assert.equal(error.userMessage, "대화방을 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.")
    assert.equal(httpStatusOfAxError(error), 403)
    return true
  })
})

test("초대 성공과 빈 입력 실패", async () => {
  let got: unknown
  const createClient = (() => ({
    invite: async (roomId: string, userId: string) => { got = [roomId, userId] },
  })) as unknown as typeof import("matrix-js-sdk").createClient
  await invite(SESSION, "!r:tenant.example.invalid", "@org:tenant.example.invalid", { createClient })
  assert.deepEqual(got, ["!r:tenant.example.invalid", "@org:tenant.example.invalid"])
  await assert.rejects(invite(SESSION, "", ""), (error: unknown) => {
    assert.ok(error instanceof AxMessengerError)
    assert.equal(error.kind, "invalid-input")
    return true
  })
})

test("표시 이름 성공과 빈 입력 실패", async () => {
  let got: unknown
  const createClient = (() => ({
    setDisplayName: async (name: string) => { got = name },
  })) as unknown as typeof import("matrix-js-sdk").createClient
  await setDisplayName(SESSION, "조직 담당자", { createClient })
  assert.equal(got, "조직 담당자")
  await assert.rejects(setDisplayName(SESSION, "  "), (error: unknown) => {
    assert.ok(error instanceof AxMessengerError)
    assert.equal(error.kind, "invalid-input")
    return true
  })
})

// FE-ax1-02-07 사용량 모으기 자리
test("사용량 자리는 기록을 쌓고 잘못된 값은 막는다", () => {
  const collector = createUsageCollector()
  const entry = collector.record({ kind: "file", userId: "@a:tenant.example.invalid", bytes: 12 })
  assert.equal(collector.entries.length, 1)
  assert.equal(entry.kind, "file")
  assert.ok(entry.at > 0)
  assert.throws(
    () => collector.record({ kind: "nope" as never }),
    (error: unknown) => error instanceof AxMessengerError && error.kind === "invalid-input",
  )
  assert.throws(
    () => collector.record({ kind: "file", bytes: -1 }),
    (error: unknown) => error instanceof AxMessengerError && error.kind === "invalid-input",
  )
})
