"use client"

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import type { Locale, TranslationKey } from "./types.ts"
import { LOCALE_COOKIE, LOCALE_STORAGE_KEY, formatMessage, getDict, isLocale, parseLocale } from "./index.ts"

interface I18nContextValue {
  locale: Locale
  setLocale: (next: Locale) => void
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

function readStoredLocale(): Locale | null {
  try {
    if (typeof document !== "undefined") {
      const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]*)`))
      if (match) {
        const parsed = parseLocale(decodeURIComponent(match[1]))
        if (parsed) return parsed
      }
    }
  } catch {
    // Cookie read must never throw.
  }
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      const parsed = parseLocale(window.localStorage.getItem(LOCALE_STORAGE_KEY))
      if (parsed) return parsed
    }
  } catch {
    // localStorage read must never throw.
  }
  return null
}

function persistLocale(locale: Locale): void {
  try {
    if (typeof document !== "undefined") {
      document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(locale)}; path=/; max-age=31536000; samesite=lax`
    }
  } catch {
    // Cookie write must never throw.
  }
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, locale)
    }
  } catch {
    // localStorage write must never throw.
  }
  try {
    if (typeof document !== "undefined" && document.documentElement) {
      document.documentElement.setAttribute("lang", locale)
    }
  } catch {
    // DOM write must never throw.
  }
}

let activeLocale: Locale = "ko"
const localeListeners = new Set<(locale: Locale) => void>()

function readActiveLocale(): Locale {
  if (isLocale(activeLocale)) return activeLocale
  return readStoredLocale() ?? "ko"
}

/** Current UI locale without React context (safe for mocked-hook unit tests). */
export function getActiveLocale(): Locale {
  return readActiveLocale()
}

function publishLocale(next: Locale): void {
  activeLocale = next
  persistLocale(next)
  try {
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      window.dispatchEvent(new Event("naia-adk-locale"))
    }
  } catch {
    // Event dispatch must never throw.
  }
  for (const listener of [...localeListeners]) {
    try {
      listener(next)
    } catch {
      // Listener failures must never break the switch.
    }
  }
}

/**
 * Reactive locale subscription using only `useState`/`useEffect`, so it also
 * works under the mocked-hook render harness used by `page.render.test.tsx`.
 */
export function useActiveLocale(): Locale {
  const [locale, setLocaleState] = useState<Locale>(() => readActiveLocale())
  useEffect(() => {
    localeListeners.add(setLocaleState)
    const hasWindow = typeof window !== "undefined" && typeof window.addEventListener === "function"
    const onExternal = () => {
      try {
        setLocaleState(readActiveLocale())
      } catch {
        // Locale re-reads must never throw.
      }
    }
    if (hasWindow) {
      window.addEventListener("naia-adk-locale", onExternal)
    }
    return () => {
      localeListeners.delete(setLocaleState)
      try {
        if (hasWindow) window.removeEventListener("naia-adk-locale", onExternal)
      } catch {
        // Cleanup must never throw.
      }
    }
  }, [])
  return locale
}

export function I18nProvider({
  initialLocale = "ko",
  children,
}: {
  initialLocale?: Locale
  children: React.ReactNode
}) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const normalized = isLocale(initialLocale) ? initialLocale : "ko"
    activeLocale = normalized
    return normalized
  })
  let router: { refresh: () => void } | null = null
  try {
    // Safe when rendered outside the Next router (unit render tests).
    router = useRouter() as unknown as { refresh: () => void }
  } catch {
    router = null
  }

  useEffect(() => {
    // Re-sync from cookie/localStorage on mount (client-only correction).
    const stored = readStoredLocale()
    if (stored && stored !== locale) {
      setLocaleState(stored)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setLocale = useCallback(
    (next: Locale) => {
      if (!isLocale(next)) return
      setLocaleState(next)
      publishLocale(next)
      try {
        router?.refresh()
      } catch {
        // Refresh outside the Next router must never throw.
      }
    },
    // router identity is stable in practice; refresh on locale change only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const value = useMemo<I18nContextValue>(() => {
    const dict = getDict(locale)
    return {
      locale,
      setLocale,
      t: (key, vars) => formatMessage(dict[key] ?? key, vars),
    }
  }, [locale, setLocale])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

/** Active locale (`"ko"` when no provider is mounted, e.g. unit render tests). */
export function useLocale(): Locale {
  return useContext(I18nContext)?.locale ?? "ko"
}

/** Translate function (`"ko"` dict when no provider is mounted). */
export function useT(): (key: TranslationKey, vars?: Record<string, string | number>) => string {
  const ctx = useContext(I18nContext)
  return useMemo(() => {
    if (ctx) return ctx.t
    const dict = getDict("ko")
    return (key: TranslationKey, vars?: Record<string, string | number>) => formatMessage(dict[key] ?? key, vars)
  }, [ctx])
}

/** Locale state + translator + setter (`"ko"` defaults without a provider). */
export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext)
  const t = useT()
  return useMemo<I18nContextValue>(() => {
    if (ctx) return ctx
    return {
      locale: "ko" as Locale,
      setLocale: () => {},
      t,
    }
  }, [ctx, t])
}

export function setStoredLocale(locale: Locale): void {
  if (isLocale(locale)) persistLocale(locale)
}
