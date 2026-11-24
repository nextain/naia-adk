// fx1 repair-round regression tests: verify2 findings 1 (layout.tsx dropped
// `globals.css`) and 2 (RootLayout ignores the request locale; I18nProvider
// mount correction leaves the module-global `activeLocale` stale).
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { I18nProvider, getActiveLocale } from "./provider.tsx"

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

describe("fx1 finding 2: request locale reaches SSR and the module global", () => {
  it("RootLayout resolves the request locale instead of hard-coding ko", () => {
    assert.ok(
      layoutSource.includes("getRequestLocale"),
      "layout.tsx must resolve the request locale for <html lang> and I18nProvider",
    )
  })

  it("provider initializer publishes initialLocale to getActiveLocale readers (SSR path)", () => {
    let seen: string | null = null
    function Probe(): null {
      seen = getActiveLocale()
      return null
    }
    renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <Probe />
      </I18nProvider>,
    )
    assert.equal(seen, "en")
    renderToStaticMarkup(
      <I18nProvider initialLocale="ko">
        <Probe />
      </I18nProvider>,
    )
    assert.equal(seen, "ko")
  })

  it("provider mount correction syncs a stored cookie locale into the module global", () => {
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
      I18nProvider({ initialLocale: "ko", children: null })
      for (const create of pending.splice(0)) {
        const cleanup = create()
        if (typeof cleanup === "function") cleanup()
      }
      assert.equal(getActiveLocale(), "en")
    } finally {
      holder.H = prevDispatcher
      if (prevDocument === undefined) delete g.document
      else g.document = prevDocument
      // Leave the global in a known state for other tests in this file.
      renderToStaticMarkup(<I18nProvider initialLocale="ko">{null}</I18nProvider>)
    }
  })

  it("provider source keeps the mount effect syncing the module global", () => {
    assert.ok(
      providerSource.includes("publishLocale(stored)"),
      "provider mount effect must publish the stored locale, not only setState",
    )
  })
})
