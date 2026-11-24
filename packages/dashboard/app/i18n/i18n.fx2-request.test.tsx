// fx2 repair-round failing regression tests for Sonnet S2 (RootLayout SSR
// test coverage), S5 (package-standalone excludes *.test.*), S6 (getRequestLocale
// error logging), and Hydrogen H-L3 (?lang= query precedence).
import assert from "node:assert/strict"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import vm from "node:vm"
import React from "react"
import { renderToReadableStream } from "react-dom/server"
import { buildLocaleInitScript } from "./index.ts"
import * as serverMod from "./server.ts"

const require = createRequire(import.meta.url)
require.extensions[".css"] = () => {}
const { default: RootLayout } = require("../layout.tsx") as typeof import("../layout.tsx")
const { NextRequest } = require("next/server") as typeof import("next/server")
const { middleware } = require("../../middleware.ts") as typeof import("../../middleware.ts")

const here = path.dirname(fileURLToPath(import.meta.url))
const dashboardDir = path.resolve(here, "../..")
const HANGUL = /[\uAC00-\uD7A3]/

describe("fx2 finding S2 & H-L3: RootLayout SSR request locale and ?lang= query precedence", () => {
  it("RootLayout honors request cookie via getRequestLocale without initialLocale prop", async () => {
    const runWithRequestLocaleContext = (
      serverMod as unknown as {
        runWithRequestLocaleContext?: <T>(ctx: Record<string, unknown>, fn: () => T) => T
      }
    ).runWithRequestLocaleContext
    assert.equal(
      typeof runWithRequestLocaleContext,
      "function",
      "server.ts must export runWithRequestLocaleContext for SSR layout testing",
    )

    const [enHtml, koHtml] = await Promise.all([
      runWithRequestLocaleContext!({ cookie: "naia-adk-lang=en" }, async () => {
        const stream = await renderToReadableStream(
          <RootLayout>
            <div>content</div>
          </RootLayout>,
        )
        return await new Response(stream).text()
      }),
      runWithRequestLocaleContext!({ cookie: "naia-adk-lang=ko" }, async () => {
        const stream = await renderToReadableStream(
          <RootLayout>
            <div>내용</div>
          </RootLayout>,
        )
        return await new Response(stream).text()
      }),
    ])

    assert.match(enHtml, /<html[^>]*lang="en"/)
    assert.ok(enHtml.includes(">Docs<"), "en RootLayout must render English Nav")
    assert.match(enHtml, /data-testid="locale-btn-en"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-testid="locale-btn-en"/)
    assert.equal(HANGUL.test(enHtml), false, "en RootLayout chrome must contain zero Hangul")

    assert.match(koHtml, /<html[^>]*lang="ko"/)
    assert.ok(koHtml.includes(">문서<"), "ko RootLayout must render Korean Nav")
  })

  it("?lang= query beats cookie in RootLayout, middleware, getRequestLocale, and buildLocaleInitScript", async () => {
    const runWithRequestLocaleContext = (
      serverMod as unknown as {
        runWithRequestLocaleContext?: <T>(ctx: Record<string, unknown>, fn: () => T) => T
      }
    ).runWithRequestLocaleContext
    assert.equal(typeof runWithRequestLocaleContext, "function")

    const html = await runWithRequestLocaleContext!(
      { searchParams: new URLSearchParams("lang=en"), cookie: "naia-adk-lang=ko" },
      async () => {
        const stream = await renderToReadableStream(
          <RootLayout>
            <div>content</div>
          </RootLayout>,
        )
        return await new Response(stream).text()
      },
    )
    assert.match(html, /<html[^>]*lang="en"/)
    assert.ok(html.includes(">Docs<"))

    // Middleware forwards ?lang= via x-naia-lang-query and strips spoofed headers when absent.
    const reqWithQuery = new NextRequest("http://localhost:3142/settings?lang=en", {
      headers: { host: "localhost:3142" },
    })
    const resWithQuery = middleware(reqWithQuery)
    assert.equal(resWithQuery.headers.get("x-middleware-request-x-naia-lang-query"), "en")

    const reqSpoofed = new NextRequest("http://localhost:3142/settings", {
      headers: { host: "localhost:3142", "x-naia-lang-query": "en" },
    })
    const resSpoofed = middleware(reqSpoofed)
    assert.equal(resSpoofed.headers.get("x-middleware-request-x-naia-lang-query"), null)

    // getRequestLocale reads x-naia-lang-query from headers over cookie.
    const getRequestLocale = serverMod.getRequestLocale as (
      sp?: unknown,
      deps?: { loadModule?: () => Promise<unknown> },
    ) => Promise<string>
    const resolved = await getRequestLocale(null, {
      loadModule: async () => ({
        headers: async () => new Headers({ "x-naia-lang-query": "en", cookie: "naia-adk-lang=ko" }),
        cookies: async () => new Map(),
      }),
    })
    assert.equal(resolved, "en")

    // Pre-paint script honors ?lang= over cookie and localStorage.
    const attrs: Record<string, string> = {}
    const sandbox = {
      location: { search: "?lang=en" },
      document: {
        cookie: "naia-adk-lang=ko",
        documentElement: {
          setAttribute(k: string, v: string) {
            attrs[k] = v
          },
        },
      },
      localStorage: { getItem: () => "ko" },
    }
    vm.runInNewContext(buildLocaleInitScript(), sandbox)
    assert.equal(attrs.lang, "en")
  })
})

describe("fx2 finding S6: getRequestLocale distinguishes expected non-request scope from real errors", () => {
  it("logs a warning on unexpected errors while staying quiet outside request scope", async (t) => {
    const warnings: unknown[][] = []
    t.mock.method(console, "warn", (...args: unknown[]) => {
      warnings.push(args)
    })

    const getRequestLocale = serverMod.getRequestLocale as (
      sp?: unknown,
      deps?: { loadModule?: () => Promise<unknown> },
    ) => Promise<string>

    const scopeLocale = await getRequestLocale(null, {
      loadModule: async () => ({
        headers: async () => {
          throw new Error("`headers` was called outside a request scope.")
        },
      }),
    })
    assert.equal(scopeLocale, "ko")
    assert.equal(warnings.length, 0, "expected outside-request-scope error must not warn")

    const errLocale = await getRequestLocale(null, {
      loadModule: async () => ({
        headers: async () => {
          throw new Error("unexpected header store failure")
        },
      }),
    })
    assert.equal(errLocale, "ko")
    assert.equal(warnings.length, 1, "unexpected error in getRequestLocale must log via console.warn")
  })
})

describe("fx2 finding S5: package-standalone excludes test files from app/i18n", () => {
  it("isPackageableI18nFile filters out *.test.ts and *.test.tsx", async () => {
    const pkgScriptPath = path.join(dashboardDir, "scripts/package-standalone.mjs")
    const src = fs.readFileSync(pkgScriptPath, "utf8")
    assert.ok(
      src.includes("isPackageableI18nFile"),
      "package-standalone.mjs must export isPackageableI18nFile (guarded by isMain) to filter *.test.*",
    )
    const mod = (await import(pkgScriptPath)) as {
      isPackageableI18nFile?: (name: string) => boolean
    }
    assert.equal(typeof mod.isPackageableI18nFile, "function")
    assert.equal(mod.isPackageableI18nFile!("index.ts"), true)
    assert.equal(mod.isPackageableI18nFile!("provider.tsx"), true)
    assert.equal(mod.isPackageableI18nFile!("i18n.test.ts"), false)
    assert.equal(mod.isPackageableI18nFile!("i18n.render.test.tsx"), false)
    assert.equal(mod.isPackageableI18nFile!("i18n.fx1-layout.test.tsx"), false)
  })
})
