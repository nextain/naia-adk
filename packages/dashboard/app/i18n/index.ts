// Lightweight locale helpers (PR #2). Zero dependencies, mirroring
// `theme-prefs.ts` so `node --import tsx` and `scripts/package-standalone.mjs`
// work with zero friction.
import type { Locale, TranslationDict, TranslationKey } from "./types.ts"
import { en } from "./en.ts"
import { ko } from "./ko.ts"

export type { Locale, TranslationDict, TranslationKey }
export { en, ko }

export const LOCALE_COOKIE = "naia-adk-lang"
export const LOCALE_STORAGE_KEY = "naia-adk-lang"

const LOCALES: readonly Locale[] = ["en", "ko"]

export function isLocale(value: unknown): value is Locale {
  return value === "en" || value === "ko"
}

export function parseLocale(value: unknown): Locale | null {
  if (typeof value !== "string") return null
  const clean = value.trim().toLowerCase()
  if (clean === "en" || clean.startsWith("en-")) return "en"
  if (clean === "ko" || clean.startsWith("ko-")) return "ko"
  return null
}

/** Parse an `Accept-Language` header into the preferred dashboard locale (or null). */
export function parseAcceptLanguage(header: unknown): Locale | null {
  if (typeof header !== "string" || !header.trim()) return null
  const ranked: Array<{ locale: Locale; q: number; index: number }> = []
  const parts = header.split(",")
  parts.forEach((part, index) => {
    const [range, ...params] = part.split(";")
    const locale = parseLocale(range?.trim())
    if (!locale) return
    let q = 1
    for (const param of params) {
      const match = param.trim().match(/^q=([0-9.]+)$/i)
      if (match) {
        const parsed = Number(match[1])
        if (Number.isFinite(parsed)) q = Math.min(Math.max(parsed, 0), 1)
      }
    }
    ranked.push({ locale, q, index })
  })
  if (ranked.length === 0) return null
  ranked.sort((a, b) => b.q - a.q || a.index - b.index)
  return ranked[0].locale
}

export interface LocaleRequestContext {
  searchParams?: { get(name: string): string | null } | URLSearchParams | Record<string, string | string[] | undefined> | null
  query?: Record<string, string | string[] | undefined> | null
  cookie?: string | null
  cookies?: Record<string, string | undefined> | null
  acceptLanguage?: string | null
  headers?: Record<string, string | string[] | undefined> | null
}

function readSearchParam(ctx: LocaleRequestContext, name: string): string | null {
  try {
    const sp = ctx.searchParams
    if (!sp) return null
    if (typeof (sp as { get?: unknown }).get === "function") {
      return (sp as { get(name: string): string | null }).get(name)
    }
    const record = sp as Record<string, string | string[] | undefined>
    const raw = record[name]
    if (Array.isArray(raw)) return raw[0] ?? null
    return raw ?? null
  } catch {
    return null
  }
}

function readCookie(ctx: LocaleRequestContext, name: string): string | null {
  try {
    if (ctx.cookies && typeof ctx.cookies[name] === "string") return ctx.cookies[name] as string
    if (typeof ctx.cookie === "string") {
      for (const part of ctx.cookie.split(";")) {
        const eq = part.indexOf("=")
        if (eq === -1) continue
        if (part.slice(0, eq).trim() === name) {
          return decodeURIComponent(part.slice(eq + 1).trim())
        }
      }
    }
  } catch {
    // Cookie parsing must never throw.
  }
  return null
}

function readHeader(ctx: LocaleRequestContext, name: string): string | null {
  try {
    if (typeof ctx.acceptLanguage === "string" && name.toLowerCase() === "accept-language") {
      return ctx.acceptLanguage
    }
    const headers = ctx.headers
    if (!headers) return null
    const lower = name.toLowerCase()
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === lower) {
        return Array.isArray(value) ? (value[0] ?? null) : (value ?? null)
      }
    }
  } catch {
    // Header reads must never throw.
  }
  return null
}

/**
 * Locale precedence: `?lang=` query > `naia-adk-lang` cookie >
 * `Accept-Language` header > `NAIA_DEFAULT_LOCALE` env > `"ko"` fallback.
 */
export function resolveLocale(
  ctx: LocaleRequestContext = {},
  env: Record<string, string | undefined> = defaultEnv(),
): Locale {
  const fromQuery =
    parseLocale(readSearchParam(ctx, "lang")) ??
    parseLocale(ctx.query?.["lang"] && Array.isArray(ctx.query["lang"]) ? ctx.query["lang"][0] : ctx.query?.["lang"])
  if (fromQuery) return fromQuery
  const fromCookie = parseLocale(readCookie(ctx, LOCALE_COOKIE))
  if (fromCookie) return fromCookie
  const fromHeader = parseAcceptLanguage(readHeader(ctx, "accept-language"))
  if (fromHeader) return fromHeader
  const fromEnv = parseLocale(env.NAIA_DEFAULT_LOCALE)
  if (fromEnv) return fromEnv
  return "ko"
}

function defaultEnv(): Record<string, string | undefined> {
  try {
    return typeof process !== "undefined" && process.env ? process.env : {}
  } catch {
    return {}
  }
}

const DICTS: Record<Locale, TranslationDict> = { en, ko }

export function getDict(locale: Locale = "ko"): TranslationDict {
  return DICTS[isLocale(locale) ? locale : "ko"] ?? ko
}

export function tFor(locale: Locale = "ko") {
  const dict = getDict(locale)
  return (key: TranslationKey, vars?: Record<string, string | number>): string =>
    formatMessage(dict[key] ?? ko[key] ?? key, vars)
}

/** Replace `{var}` placeholders in a template string. */
export function formatMessage(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : match,
  )
}

/** Tiny pre-paint inline script syncing `documentElement.lang` (mirrors `buildThemeInitScript`). */
export function buildLocaleInitScript(): string {
  return `(function(){try{var p=function(v){if(typeof v!=="string")return null;var c=v.trim().toLowerCase();if(c==="en"||c.indexOf("en-")===0)return "en";if(c==="ko"||c.indexOf("ko-")===0)return "ko";return null;};var l=null;try{if(typeof location!=="undefined"&&typeof location.search==="string"){var q=location.search.match(/(?:^|[?&])lang=([^&#]*)/);if(q)l=p(decodeURIComponent(q[1].replace(/\\+/g," ")));}}catch(_){}try{if(!l){var m=document.cookie.match(/(?:^|;\\s*)${LOCALE_COOKIE}=([^;]*)/);if(m)l=p(decodeURIComponent(m[1]));}}catch(_){}try{if(!l)l=p(localStorage.getItem("${LOCALE_STORAGE_KEY}"));}catch(_){}l=l||"ko";document.documentElement.setAttribute("lang",l);}catch(_){}})();`
}

export function serializeLocaleCookie(locale: Locale): string {
  return `${LOCALE_COOKIE}=${encodeURIComponent(locale)}; path=/; max-age=31536000; samesite=lax`
}

export function availableLocales(): readonly Locale[] {
  return LOCALES
}
