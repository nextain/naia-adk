// PR #2 foundation tests: dictionary parity, English purity, locale
// precedence, message formatting, and gateway machine-readable error codes.
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  availableLocales,
  buildLocaleInitScript,
  formatMessage,
  getDict,
  isLocale,
  LOCALE_COOKIE,
  LOCALE_STORAGE_KEY,
  parseAcceptLanguage,
  parseLocale,
  resolveLocale,
  serializeLocaleCookie,
  tFor,
} from "./index.ts"
import { en } from "./en.ts"
import { ko } from "./ko.ts"
import { codeFromGatewayError } from "../../ax-messenger-gateway.mjs"

const HANGUL = /[\uAC00-\uD7A3]/

describe("i18n dictionary parity (en / ko)", () => {
  it("en and ko expose exactly the same keys", () => {
    assert.deepEqual(Object.keys(en).sort(), Object.keys(ko).sort())
  })

  it("no dictionary value is empty", () => {
    for (const [key, value] of Object.entries({ ...ko, ...en })) {
      assert.ok(typeof value === "string" && value.length > 0, `empty value for ${key}`)
    }
  })

  it("en values contain zero Hangul characters", () => {
    const offenders = Object.entries(en).filter(([, value]) => HANGUL.test(value))
    assert.deepEqual(offenders, [])
  })

  it("ko values are non-empty (spot check on chrome labels)", () => {
    for (const key of ["nav.docs", "settings.title", "ax.title", "work.title", "dec.title", "msg.title", "docs.tabCommon", "sched.personal"] as const) {
      assert.ok(ko[key].length > 0, key)
    }
  })
})

describe("locale parsing and precedence", () => {
  it("isLocale accepts only en/ko", () => {
    assert.equal(isLocale("en"), true)
    assert.equal(isLocale("ko"), true)
    assert.equal(isLocale("ja"), false)
    assert.equal(isLocale(""), false)
    assert.equal(isLocale(null), false)
  })

  it("parseLocale handles case and region suffixes", () => {
    assert.equal(parseLocale("en"), "en")
    assert.equal(parseLocale("EN"), "en")
    assert.equal(parseLocale("en-US"), "en")
    assert.equal(parseLocale("ko-KR"), "ko")
    assert.equal(parseLocale("ko"), "ko")
    assert.equal(parseLocale("fr"), null)
    assert.equal(parseLocale(""), null)
    assert.equal(parseLocale(null), null)
  })

  it("parseAcceptLanguage prefers the highest-q supported locale", () => {
    assert.equal(parseAcceptLanguage("en-US,en;q=0.9,ko;q=0.8"), "en")
    assert.equal(parseAcceptLanguage("ko-KR,ko;q=0.9,en;q=0.8"), "ko")
    assert.equal(parseAcceptLanguage("fr-FR,fr;q=0.9"), null)
    assert.equal(parseAcceptLanguage(""), null)
    assert.equal(parseAcceptLanguage(null), null)
  })

  it("resolveLocale precedence: ?lang= > cookie > Accept-Language > env > ko", () => {
    const envKo = {}
    // Fallback when nothing is present.
    assert.equal(resolveLocale({}, envKo), "ko")
    // Env default applies without request context.
    assert.equal(resolveLocale({}, { NAIA_DEFAULT_LOCALE: "en" }), "en")
    assert.equal(resolveLocale({}, { NAIA_DEFAULT_LOCALE: "xx" }), "ko")
    // Accept-Language beats the env default.
    assert.equal(
      resolveLocale({ acceptLanguage: "en-US,en;q=0.9" }, { NAIA_DEFAULT_LOCALE: "ko" }),
      "en",
    )
    assert.equal(
      resolveLocale({ acceptLanguage: "ko-KR,ko;q=0.9" }, { NAIA_DEFAULT_LOCALE: "en" }),
      "ko",
    )
    // Cookie beats Accept-Language.
    assert.equal(
      resolveLocale(
        { cookie: `${LOCALE_COOKIE}=ko; other=1`, acceptLanguage: "en-US,en;q=0.9" },
        {},
      ),
      "ko",
    )
    assert.equal(
      resolveLocale(
        { cookies: { [LOCALE_COOKIE]: "en" }, acceptLanguage: "ko-KR,ko;q=0.9" },
        {},
      ),
      "en",
    )
    // Explicit ?lang= beats everything.
    assert.equal(
      resolveLocale(
        {
          searchParams: new URLSearchParams("lang=en"),
          cookie: `${LOCALE_COOKIE}=ko`,
          acceptLanguage: "ko-KR,ko;q=0.9",
        },
        { NAIA_DEFAULT_LOCALE: "ko" },
      ),
      "en",
    )
    assert.equal(
      resolveLocale({ query: { lang: "ko" }, cookies: { [LOCALE_COOKIE]: "en" } }, {}),
      "ko",
    )
  })

  it("getDict/tFor resolve per locale with ko default", () => {
    assert.equal(getDict("en")["nav.docs"], "Docs")
    assert.equal(getDict("ko")["nav.docs"], "문서")
    assert.equal(getDict("xx" as never)["nav.docs"], "문서")
    assert.equal(tFor("en")("nav.docs"), "Docs")
    assert.equal(tFor()("nav.docs"), "문서")
  })

  it("formatMessage substitutes {vars} and leaves unknown placeholders", () => {
    assert.equal(formatMessage("할 일 {count}", { count: 7 }), "할 일 7")
    assert.equal(formatMessage("Tasks {count}", { count: 0 }), "Tasks 0")
    assert.equal(formatMessage("plain", { count: 1 }), "plain")
    assert.equal(formatMessage("keep {missing}"), "keep {missing}")
  })

  it("cookie constants and serializer stay consistent", () => {
    assert.equal(LOCALE_COOKIE, "naia-adk-lang")
    assert.equal(LOCALE_STORAGE_KEY, "naia-adk-lang")
    assert.ok(serializeLocaleCookie("en").startsWith(`${LOCALE_COOKIE}=en;`))
    assert.ok(serializeLocaleCookie("ko").includes("path=/"))
    assert.deepEqual([...availableLocales()].sort(), ["en", "ko"])
  })

  it("buildLocaleInitScript syncs documentElement.lang without throwing", () => {
    const script = buildLocaleInitScript()
    assert.ok(script.includes(LOCALE_COOKIE))
    assert.ok(script.includes("document.documentElement"))
    assert.ok(script.includes("setAttribute"))
    // Must not reference theme keys: locale init stays independent.
    assert.ok(!script.includes("naia-adk-theme"))
  })
})

describe("gateway machine-readable error codes", () => {
  it("errcode/kind win over the legacy Korean substring fallback", () => {
    assert.equal(codeFromGatewayError({ errcode: "M_USER_IN_USE" }), "user-in-use")
    assert.equal(codeFromGatewayError({ kind: "duplicate" }), "user-in-use")
    assert.equal(codeFromGatewayError({ kind: "invalid-input" }), "invalid-input")
    assert.equal(codeFromGatewayError({ kind: "auth" }), "auth")
    assert.equal(codeFromGatewayError({ kind: "forbidden" }), "forbidden")
    assert.equal(codeFromGatewayError({ errcode: "M_FORBIDDEN" }), "no-permission")
    assert.equal(codeFromGatewayError({ status: 401 }), "login-required")
    assert.equal(codeFromGatewayError({ status: 400 }), "bad-request")
    assert.equal(codeFromGatewayError({ status: 413 }), "too-large")
    assert.equal(codeFromGatewayError({}), "server")
    assert.equal(codeFromGatewayError(null), "server")
  })

  it("every gateway JSON error response carries a stable code", async () => {
    const { createAxMessengerHandler } = await import("../../ax-messenger-gateway.mjs")
    const call = async (
      handler: (req: never, res: never, account?: string) => Promise<unknown>,
      url: string,
      method: string,
      account?: string,
    ): Promise<{ status: number; body: { error?: string; code?: string } }> => {
      const chunks: string[] = []
      const req = {
        url,
        method,
        headers: {},
        [Symbol.asyncIterator]() {
          return {
            next: async () => ({ done: true as const, value: undefined }),
          }
        },
      }
      const res = {
        statusCode: 0,
        setHeader(_k: string, _v: string) {},
        end(data: string) {
          chunks.push(data)
        },
      }
      await handler(req as never, res as never, account)
      return { status: res.statusCode, body: JSON.parse(chunks.join("") || "{}") }
    }
    // Unconfigured instance: every route (including /status) is 404 + code.
    const off = createAxMessengerHandler({
      readConfig: () => ({}),
      env: process.env,
      trustProxyOrigin: () => true,
    })
    const offStatus = await call(off, "/api/ax-messenger/status", "GET")
    assert.equal(offStatus.status, 404)
    assert.equal(offStatus.body.code, "messenger-off")
    assert.equal(offStatus.body.error, ko["ax.err.messengerOff"])
    off.close()
    // Configured instance without a session: protected route is 401 + code.
    const enabled = {
      features: {
        messenger: {
          enabled: true,
          backend: "matrix",
          homeserverUrl: "https://matrix.example.invalid",
          accounts: { alice: { matrixUserId: "@alice:example.invalid", roles: ["member"] } },
          roles: { member: ["read", "write", "manage"] },
        },
      },
    }
    const on = createAxMessengerHandler({
      readConfig: () => enabled,
      env: process.env,
      trustProxyOrigin: () => true,
    })
    const rooms = await call(on, "/api/ax-messenger/rooms", "GET", "alice")
    assert.equal(rooms.status, 401)
    assert.equal(rooms.body.code, "login-required")
    assert.equal(rooms.body.error, ko["ax.err.loginRequired"])
    on.close()
  })
})
