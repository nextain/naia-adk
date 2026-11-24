"use client"

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import type { Locale, TranslationKey } from "./types.ts"
import { LOCALE_COOKIE, LOCALE_STORAGE_KEY, formatMessage, getDict, isLocale, parseLocale, tFor } from "./index.ts"

interface I18nContextValue {
  locale: Locale
  setLocale: (next: Locale) => void
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)
const DEFAULT_T = tFor("ko")
const DEFAULT_I18N: I18nContextValue = {
  locale: "ko",
  setLocale: () => {},
  t: DEFAULT_T,
}

function readQueryLocale(): Locale | null {
  try {
    if (typeof window !== "undefined" && typeof window.location?.search === "string" && window.location.search) {
      const parsed = parseLocale(new URLSearchParams(window.location.search).get("lang"))
      if (parsed) return parsed
    }
  } catch {
    // Query reads must never throw.
  }
  return null
}

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

function applyDocumentLang(locale: Locale): void {
  try {
    if (typeof document !== "undefined" && document.documentElement) {
      document.documentElement.setAttribute("lang", locale)
    }
  } catch {
    // DOM write must never throw.
  }
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
  applyDocumentLang(locale)
}

/**
 * Safe Context reader: works normally in React SSR and Browser DOM, and returns
 * `null` when invoked outside React (bare component call in unit tests) or
 * under a minimal mock dispatcher that omits `useContext`.
 */
function readI18nContext(): I18nContextValue | null {
  const internals = (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: {
        H?: { useContext?: unknown } | null
      }
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
  if (internals && (!internals.H || typeof internals.H.useContext !== "function")) {
    return null
  }
  try {
    return useContext(I18nContext)
  } catch {
    return null
  }
}

/** Legacy stateless reader (never reads or mutates shared SSR state). */
export function getActiveLocale(): Locale {
  if (typeof window === "undefined") return "ko"
  return readQueryLocale() ?? readStoredLocale() ?? "ko"
}

/** Subscribes to the nearest `I18nProvider` Context (defaults to `"ko"` outside a provider). */
export function useActiveLocale(): Locale {
  return useLocale()
}

export function I18nProvider({
  initialLocale = "ko",
  children,
}: {
  initialLocale?: Locale
  children: React.ReactNode
}) {
  const normalizedInitial: Locale = isLocale(initialLocale) ? initialLocale : "ko"
  const [locale, setLocaleState] = useState<Locale>(normalizedInitial)
  const prevInitialRef = useRef<Locale>(normalizedInitial)

  let router: { refresh: () => void } | null = null
  try {
    // Safe when rendered outside the Next router (unit render tests).
    router = useRouter() as unknown as { refresh: () => void }
  } catch {
    router = null
  }
  const routerRef = useRef(router)
  routerRef.current = router

  useEffect(() => {
    if (prevInitialRef.current !== normalizedInitial) {
      prevInitialRef.current = normalizedInitial
      setLocaleState(normalizedInitial)
    }
  }, [normalizedInitial])

  useEffect(() => {
    // Query override takes precedence over cookie/localStorage without clobbering stored cookie.
    const fromQuery = readQueryLocale()
    if (fromQuery) {
      applyDocumentLang(fromQuery)
      setLocaleState((prev) => (prev === fromQuery ? prev : fromQuery))
      return
    }
    const stored = readStoredLocale()
    if (stored) {
      persistLocale(stored)
      setLocaleState((prev) => (prev === stored ? prev : stored))
    }
  }, [])

  const setLocale = useCallback((next: Locale) => {
    if (!isLocale(next)) return
    setLocaleState(next)
    persistLocale(next)
    try {
      routerRef.current?.refresh()
    } catch {
      // Refresh outside the Next router must never throw.
    }
  }, [])

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

/** Active Context locale (`null` when rendered outside an `I18nProvider`). */
export function useOptionalLocale(): Locale | null {
  return readI18nContext()?.locale ?? null
}

/** Active locale (`"ko"` when no provider is mounted, e.g. standalone unit render tests). */
export function useLocale(): Locale {
  return readI18nContext()?.locale ?? "ko"
}

/** Translate function (`"ko"` dict when no provider is mounted). */
export function useT(): (key: TranslationKey, vars?: Record<string, string | number>) => string {
  return readI18nContext()?.t ?? DEFAULT_T
}

/** Locale state + translator + setter (`"ko"` defaults without a provider). */
export function useI18n(): I18nContextValue {
  return readI18nContext() ?? DEFAULT_I18N
}

export function setStoredLocale(locale: Locale): void {
  if (isLocale(locale)) persistLocale(locale)
}
