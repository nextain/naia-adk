// Server-side locale reader for Next.js Server Components.
// Never throws and never crashes direct `renderToStaticMarkup` unit tests:
// outside a request scope (or when `next/headers` is unavailable), `"ko"`.
import type { Locale } from "./types.ts"
import { LOCALE_COOKIE, resolveLocale } from "./index.ts"

type SearchParamsLike = { get(name: string): string | null }

/**
 * Resolve the request locale for a Server Component. Safe to call in unit
 * tests: any failure (no request scope, no `next/headers`) falls back to `"ko"`.
 */
export async function getRequestLocale(searchParams?: SearchParamsLike | null): Promise<Locale> {
  try {
    let cookieHeader: string | null = null
    let acceptLanguage: string | null = null
    try {
      const mod: unknown = await import("next/headers").catch(() => null)
      const headersFn = (mod as { headers?: unknown } | null)?.headers
      if (typeof headersFn === "function") {
        const headerStore = await (headersFn as () => Promise<unknown>)()
        const get = (headerStore as { get?: unknown })?.get
        if (typeof get === "function") {
          const bound = get as (name: string) => string | null
          cookieHeader = bound.call(headerStore, "cookie")
          acceptLanguage = bound.call(headerStore, "accept-language")
        }
      }
      const cookiesFn = (mod as { cookies?: unknown } | null)?.cookies
      if (typeof cookiesFn === "function") {
        const store = await (cookiesFn as () => Promise<unknown>)()
        const get = (store as { get?: unknown })?.get
        if (typeof get === "function") {
          const hit = (get as (name: string) => { value?: string } | undefined).call(store, LOCALE_COOKIE)
          if (hit && typeof hit.value === "string") {
            cookieHeader = `${LOCALE_COOKIE}=${encodeURIComponent(hit.value)}${cookieHeader ? `; ${cookieHeader}` : ""}`
          }
        }
      }
    } catch {
      // Outside a request scope: fall through to the default.
    }
    return resolveLocale({ searchParams, cookie: cookieHeader, acceptLanguage })
  } catch {
    return "ko"
  }
}
