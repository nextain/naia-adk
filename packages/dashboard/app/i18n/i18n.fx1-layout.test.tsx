// fx1 repair-round regression tests: verify2 findings 1 (layout.tsx dropped
// `globals.css`) and 2 (RootLayout ignores the request locale; I18nProvider
// Context isolation and mount correction).
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { I18nProvider, getActiveLocale, useLocale } from "./provider.tsx"

const here = path.dirname(fileURLToPath(import.meta.url))
const layoutSource = fs.readFileSync(path.resolve(here, "../layout.tsx"), "utf8")
const providerSource = fs.readFileSync(path.resolve(here, "./provider.tsx"), "utf8")

describe("fx1 finding 1: dashboard CSS entry", () => {
  it("RootLayout keeps the globals.css import so builds emit CSS", () => {
    assert.ok(
      layoutSource.includes('import "./globals.css"'),
      "layout.tsx must import ./globals.css",
    )
  })
})

describe("fx1 finding 2: request locale reaches SSR and Context without mutating server globals", () => {
  it("RootLayout resolves the request locale instead of hard-coding ko", () => {
    assert.ok(
      layoutSource.includes("getRequestLocale"),
      "layout.tsx must resolve the request locale for <html lang> and I18nProvider",
    )
  })

  it("I18nProvider passes initialLocale to Context readers without mutating SSR global state", () => {
    let seenContext: string | null = null
    let seenGlobal: string | null = null
    function Probe(): null {
      seenContext = useLocale()
      seenGlobal = getActiveLocale()
      return null
    }
    renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <Probe />
      </I18nProvider>,
    )
    assert.equal(seenContext, "en")
    assert.equal(seenGlobal, "ko", "SSR must never write per-request locale into a server global")
    renderToStaticMarkup(
      <I18nProvider initialLocale="ko">
        <Probe />
      </I18nProvider>,
    )
    assert.equal(seenContext, "ko")
  })

  it("provider mount correction syncs a stored cookie locale into Context", () => {
    const holder = (
      React as unknown as {
        __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown }
      }
    ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
    const prevDispatcher = holder.H
    const slots: Array<{ value: unknown }> = []
    const pending: Array<() => void | (() => void)> = []
    let idx = 0
    holder.H = {
      useState(initial: unknown) {
        const i = idx++
        if (!slots[i]) {
          slots[i] = { value: typeof initial === "function" ? (initial as () => unknown)() : initial }
        }
        const slot = slots[i]
        return [
          slot.value,
          (next: unknown) => {
            slot.value = typeof next === "function" ? (next as (p: unknown) => unknown)(slot.value) : next
          },
        ]
      },
      useRef(initial: unknown) {
        const i = idx++
        if (!slots[i]) slots[i] = { value: initial }
        return slots[i]
      },
      useMemo(fn: () => unknown) {
        return fn()
      },
      useCallback(fn: unknown) {
        return fn
      },
      useEffect(create: () => void | (() => void)) {
        pending.push(create)
      },
    }
    const g = globalThis as unknown as Record<string, unknown>
    const prevDocument = g.document
    g.document = { cookie: "naia-adk-lang=en" }
    try {
      idx = 0
      // SSR/prerender carried initialLocale="ko"; the stored cookie says "en".
      let tree = I18nProvider({ initialLocale: "ko", children: null })
      assert.equal((tree.props as { value: { locale: string } }).value.locale, "ko")
      for (const create of pending.splice(0)) {
        const cleanup = create()
        if (typeof cleanup === "function") cleanup()
      }
      idx = 0
      tree = I18nProvider({ initialLocale: "ko", children: null })
      assert.equal((tree.props as { value: { locale: string } }).value.locale, "en")
    } finally {
      holder.H = prevDispatcher
      if (prevDocument === undefined) delete g.document
      else g.document = prevDocument
    }
  })

  it("provider source persists stored locale on mount without a mutable activeLocale global", () => {
    assert.ok(
      providerSource.includes("persistLocale(stored)"),
      "provider mount effect must sync stored locale cleanly",
    )
    assert.equal(
      /\blet\s+activeLocale\b/.test(providerSource),
      false,
      "provider.tsx must not hold module-global activeLocale",
    )
  })
})
