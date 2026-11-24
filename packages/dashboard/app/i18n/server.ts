// Server-side locale reader for Next.js Server Components.
// Never throws and never crashes direct `renderToStaticMarkup` / `renderToReadableStream`
// unit tests: outside a request scope (or when `next/headers` is unavailable), falls back
// cleanly without logging, while unexpected errors are logged via `console.warn`.
import { AsyncLocalStorage } from "node:async_hooks"
import type { Locale } from "./types.ts"
import { LOCALE_COOKIE, resolveLocale, type LocaleRequestContext } from "./index.ts"

type SearchParamsLike = { get(name: string): string | null } | Record<string, string | string[] | undefined>

export const REQUEST_QUERY_LANG_HEADER = "x-naia-lang-query"

const requestLocaleContextStorage = new AsyncLocalStorage<LocaleRequestContext>()

/** Run `fn` with an explicit request locale context (for SSR unit tests without `next/headers`). */
export function runWithRequestLocaleContext<T>(ctx: LocaleRequestContext, fn: () => T): T {
  return requestLocaleContextStorage.run(ctx, fn)
}

function isOutsideRequestScopeError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const e = err as { code?: unknown; message?: unknown }
  if (e.code === "ERR_MODULE_NOT_FOUND" || e.code === "MODULE_NOT_FOUND") return true
  const msg = typeof e.message === "string" ? e.message : ""
  return (
    msg.includes("outside a request scope") ||
    msg.includes("next-dynamic-api-wrong-context") ||
    msg.includes("was called outside")
  )
}

export interface GetRequestLocaleDeps {
  loadModule?: () => Promise<unknown>
}

/**
 * Resolve the request locale for a Server Component. Safe to call in unit
 * tests: expected non-request scope errors fall back silently, while unexpected
 * failures are logged via `console.warn`.
 */
export async function getRequestLocale(
  searchParams?: SearchParamsLike | null,
  deps?: GetRequestLocaleDeps,
): Promise<Locale> {
  try {
    const override = requestLocaleContextStorage.getStore()
    if (override) {
      return resolveLocale({
        ...override,
        searchParams: searchParams ?? override.searchParams,
      })
    }

    let cookieHeader: string | null = null
    let acceptLanguage: string | null = null
    let queryLangHeader: string | null = null
    try {
      const mod: unknown = await (deps?.loadModule ? deps.loadModule() : import("next/headers"))
      const headersFn = (mod as { headers?: unknown } | null)?.headers
      if (typeof headersFn === "function") {
        const headerStore = await (headersFn as () => Promise<unknown>)()
        const get = (headerStore as { get?: unknown })?.get
        if (typeof get === "function") {
          const bound = get as (name: string) => string | null
          cookieHeader = bound.call(headerStore, "cookie")
          acceptLanguage = bound.call(headerStore, "accept-language")
          queryLangHeader = bound.call(headerStore, REQUEST_QUERY_LANG_HEADER)
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
    } catch (err) {
      if (!isOutsideRequestScopeError(err)) {
        console.warn("[i18n] getRequestLocale failed:", err instanceof Error ? err.message : String(err))
      }
    }
    const effectiveSearchParams = searchParams ?? (queryLangHeader ? { lang: queryLangHeader } : undefined)
    return resolveLocale({ searchParams: effectiveSearchParams, cookie: cookieHeader, acceptLanguage })
  } catch (err) {
    if (!isOutsideRequestScopeError(err)) {
      console.warn("[i18n] getRequestLocale failed:", err instanceof Error ? err.message : String(err))
    }
    return "ko"
  }
}
