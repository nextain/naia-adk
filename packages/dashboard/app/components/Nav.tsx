"use client"

import React, { useEffect, useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { isTopNavTabActive, visibleTopNavTabs } from "./nav-tabs"
import { observeAxMessengerStatus } from "./ax-messenger-status.mjs"
import { useI18n, useOptionalLocale } from "../i18n/provider.tsx"
import { tFor } from "../i18n/index.ts"
import { DecisionsBadge } from "../decisions/DecisionsBadge.tsx"
import type { Locale } from "../i18n/types.ts"
import {
  DEFAULT_FONT_SIZE_STEP,
  DEFAULT_THEME_PREFERENCE,
  applyDocumentPreferences,
  detectSystemPrefersDark,
  fontSizeSteps,
  readFontSizeStep,
  readThemePreference,
  resolveTheme,
  stepFontSize,
  themeOptions,
  writeFontSizeStep,
  writeThemePreference,
  type FontSizeStep,
  type ThemePreference,
} from "../theme-prefs"

interface PortalData {
  board: { port: number } | null
  messenger?: { enabled: boolean }
}

export interface NavProps {
  initialTheme?: ThemePreference
  initialFontSize?: FontSizeStep
  hasBoard?: boolean | null
  hasLedger?: boolean | null
  hasMessenger?: boolean | null
  hasAxMessenger?: boolean | null
  /** @deprecated The navigation no longer displays ledger todo counts. */
  todoBadgeCount?: number | null
  workspaceDisplayName?: string
}

const tabClass = (active: boolean) =>
  `whitespace-nowrap px-1.5 sm:px-3 py-1 sm:py-1.5 rounded-md text-[12px] sm:text-sm font-medium transition-colors ${
    active ? "bg-neutral-800 text-white" : "text-neutral-400 hover:text-white hover:bg-neutral-900"
  }`

export interface NavTabsProps {
  pathname: string
  hasBoard: boolean | null
  hasLedger?: boolean | null
  hasMessenger?: boolean | null
  hasAxMessenger?: boolean | null
}

export function NavTabs({
  pathname,
  hasBoard,
  hasLedger,
  hasMessenger,
  hasAxMessenger,
  locale: localeProp,
}: NavTabsProps & { locale?: Locale }) {
  const ctxLocale = useOptionalLocale()
  const locale = ctxLocale ?? localeProp ?? "ko"
  const t = tFor(locale)
  const boardDisabledTitle = t("nav.boardDisabled")
  return (
    <div className="flex items-center gap-0.5 sm:gap-1 shrink-0">
      {visibleTopNavTabs(hasMessenger, hasAxMessenger, locale).map((tab) => {
        if (tab.requiresBoard && hasBoard === false && hasLedger !== true) {
          return (
            <span
              key={tab.id}
              data-testid={`nav-tab-${tab.id}`}
              aria-disabled="true"
              className="px-1.5 sm:px-3 py-1 sm:py-1.5 text-[12px] sm:text-sm font-medium text-neutral-600 cursor-not-allowed whitespace-nowrap"
              title={boardDisabledTitle}
            >
              {tab.label}
            </span>
          )
        }
        const active = isTopNavTabActive(tab, pathname)
        return (
          <Link
            key={tab.id}
            href={tab.href}
            data-testid={`nav-tab-${tab.id}`}
            aria-current={active ? "page" : undefined}
            className={tabClass(active)}
          >
            {tab.label}
          </Link>
        )
      })}
    </div>
  )
}

export function LocaleSwitcher({ locale: localeProp }: { locale?: Locale } = {}) {
  const ctxLocale = useOptionalLocale()
  const ctx = useI18n()
  const locale = ctxLocale ?? localeProp ?? "ko"
  const t = tFor(locale)
  const switchLocale = (next: Locale) => {
    if (next === locale) return
    try {
      ctx.setLocale(next)
    } catch {
      // Switching outside the provider must never throw.
    }
  }
  return (
    <div
      role="group"
      aria-label={t("nav.localeGroup")}
      data-testid="locale-switcher"
      className="inline-flex items-center rounded-md border border-neutral-800 bg-neutral-900 p-0.5"
    >
      {(["en", "ko"] as const).map((value) => {
        const active = locale === value
        return (
          <button
            key={value}
            type="button"
            onClick={() => switchLocale(value)}
            aria-label={value === "en" ? t("nav.switchToEn") : t("nav.switchToKo")}
            aria-pressed={active}
            data-testid={`locale-btn-${value}`}
            className={`px-1 sm:px-2 py-1 rounded text-[11px] sm:text-[12px] leading-none font-medium transition-colors whitespace-nowrap ${
              active ? "bg-neutral-800 text-white" : "text-neutral-400 hover:text-white"
            }`}
          >
            {value === "en" ? "EN" : "KO"}
          </button>
        )
      })}
    </div>
  )
}

export function Nav({
  initialTheme = DEFAULT_THEME_PREFERENCE,
  initialFontSize = DEFAULT_FONT_SIZE_STEP,
  hasBoard: hasBoardProp,
  hasLedger: hasLedgerProp,
  hasMessenger: hasMessengerProp,
  hasAxMessenger: hasAxMessengerProp,
  locale: localeProp,
  workspaceDisplayName = "Naia ADK",
}: NavProps & { locale?: Locale } = {}) {
  const pathname = usePathname() || "/"
  const ctxLocale = useOptionalLocale()
  const locale = ctxLocale ?? localeProp ?? "ko"
  const t = tFor(locale)
  const [fetchedHasBoard, setFetchedHasBoard] = useState<boolean | null>(null)
  const [fetchedHasLedger, setFetchedHasLedger] = useState<boolean | null>(null)
  const [fetchedHasMessenger, setFetchedHasMessenger] = useState<boolean | null>(null)
  const [fetchedHasAxMessenger, setFetchedHasAxMessenger] = useState(false)
  const [themePref, setThemePref] = useState<ThemePreference>(initialTheme)
  const [fontSize, setFontSize] = useState<FontSizeStep>(initialFontSize)

  const hasBoard = hasBoardProp !== undefined ? hasBoardProp : fetchedHasBoard
  const hasLedger = hasLedgerProp !== undefined ? hasLedgerProp : fetchedHasLedger
  const hasMessenger = hasMessengerProp !== undefined ? hasMessengerProp : fetchedHasMessenger
  const hasAxMessenger = hasAxMessengerProp !== undefined ? hasAxMessengerProp : fetchedHasAxMessenger

  useEffect(() => {
    if (hasBoardProp !== undefined && hasMessengerProp !== undefined) return
    fetch("/api/portal")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: PortalData | null) => {
        if (hasBoardProp === undefined) {
          setFetchedHasBoard(Boolean(data?.board?.port))
        }
        if (hasMessengerProp === undefined) {
          // Older servers do not send messenger; keep the tab then.
          setFetchedHasMessenger(typeof data?.messenger?.enabled === "boolean" ? data.messenger.enabled : null)
        }
      })
      .catch(() => {
        if (hasBoardProp === undefined) setFetchedHasBoard(false)
      })
  }, [hasBoardProp, hasMessengerProp])

  useEffect(() => {
    if (hasAxMessengerProp !== undefined) return
    return observeAxMessengerStatus(
      (signal: AbortSignal) => fetch("/api/ax-messenger/status", { cache: "no-store", signal }),
      setFetchedHasAxMessenger,
    )
  }, [hasAxMessengerProp])



  useEffect(() => {
    if (hasLedgerProp !== undefined) return
    fetch("/api/portal/ledger?status=todo", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { configured?: boolean } | null) => {
        setFetchedHasLedger(Boolean(data?.configured))
      })
      .catch(() => {
        setFetchedHasLedger(false)
      })
  }, [hasLedgerProp])

  useEffect(() => {
    const storedTheme = readThemePreference()
    const storedFont = readFontSizeStep()
    setThemePref(storedTheme)
    setFontSize(storedFont)
    const resolved = resolveTheme(storedTheme, detectSystemPrefersDark())
    applyDocumentPreferences(document.documentElement, resolved, storedTheme, storedFont)
  }, [])

  useEffect(() => {
    if (themePref !== "system" || typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return
    }
    try {
      const mql = window.matchMedia("(prefers-color-scheme: dark)")
      const onChange = () => {
        const resolved = resolveTheme("system", detectSystemPrefersDark())
        applyDocumentPreferences(document.documentElement, resolved, "system", fontSize)
      }
      if (typeof mql.addEventListener === "function") {
        mql.addEventListener("change", onChange)
        return () => mql.removeEventListener("change", onChange)
      }
    } catch {
      // matchMedia 이벤트 구독 실패 시 무시
    }
  }, [themePref, fontSize])

  const selectTheme = (nextPref: ThemePreference) => {
    setThemePref(nextPref)
    writeThemePreference(nextPref)
    const resolved = resolveTheme(nextPref, detectSystemPrefersDark())
    if (typeof document !== "undefined") {
      applyDocumentPreferences(document.documentElement, resolved, nextPref, fontSize)
    }
  }

  const selectFontSize = (nextStep: FontSizeStep) => {
    setFontSize(nextStep)
    writeFontSizeStep(nextStep)
    const resolved = resolveTheme(themePref, detectSystemPrefersDark())
    if (typeof document !== "undefined") {
      applyDocumentPreferences(document.documentElement, resolved, themePref, nextStep)
    }
  }

  const adjustFontSize = (direction: -1 | 1) => {
    selectFontSize(stepFontSize(fontSize, direction))
  }

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`)

  return (
    <>
    <nav className="sticky top-0 z-10 h-14 border-b border-neutral-800 bg-neutral-950 px-2 sm:px-6 flex items-center gap-1 sm:gap-6 overflow-x-auto">
      <Link href="/docs" className="font-bold text-[13px] sm:text-lg text-white shrink-0 whitespace-nowrap">
         {workspaceDisplayName}
      </Link>

      <NavTabs pathname={pathname} hasBoard={hasBoard} hasLedger={hasLedger} hasMessenger={hasMessenger} hasAxMessenger={hasAxMessenger} locale={localeProp} />

      <div className="ml-auto flex items-center gap-1 sm:gap-3 shrink-0">
        <DecisionsBadge />
        {/* 개발자용 화면은 뒤로 뺀다. 좁은 화면에서는 숨긴다. */}
        <div className="hidden xl:flex items-center gap-1">
          <span className="px-2 text-xs text-neutral-600 whitespace-nowrap">{t("nav.devTools")}</span>
          <Link href="/" className={tabClass(pathname === "/")}>
            {t("nav.overview")}
          </Link>
          <Link href="/workspace" className={tabClass(isActive("/workspace"))}>
            {t("nav.workspace")}
          </Link>
          <Link href="/skills" className={tabClass(isActive("/skills"))}>
            {t("nav.skills")}
          </Link>
          <Link href="/settings" className={tabClass(isActive("/settings"))}>
            {t("nav.settings")}
          </Link>
        </div>

        <LocaleSwitcher />

        {/* 화면 테마(라이트·다크·시스템)와 글자 크기(4단계)는 좁은 화면에서도 항상 보인다. */}
        <div
          role="group"
          aria-label={t("nav.themeGroup")}
          className="inline-flex items-center rounded-md border border-neutral-800 bg-neutral-900 p-0.5"
        >
          {themeOptions(locale).map((opt) => {
            const active = themePref === opt.value
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => selectTheme(opt.value)}
                aria-label={opt.ariaLabel}
                aria-pressed={active}
                data-testid={`theme-btn-${opt.value}`}
                className={`px-1 sm:px-2 py-1 rounded text-[11px] sm:text-[12px] leading-none font-medium transition-colors whitespace-nowrap ${
                  active ? "bg-neutral-800 text-white" : "text-neutral-400 hover:text-white"
                }`}
              >
                {opt.label}
              </button>
            )
          })}
        </div>

        <div
          role="group"
          aria-label={t("nav.fontGroup")}
          className="inline-flex items-center rounded-md border border-neutral-800 bg-neutral-900 p-0.5"
        >
          <button
            type="button"
            onClick={() => adjustFontSize(-1)}
            disabled={fontSize === "sm"}
            aria-label={t("nav.fontDecrease")}
            title={t("nav.fontDecreaseTitle")}
            data-testid="font-size-dec"
            className="px-1 sm:px-2 py-1 rounded text-[11px] sm:text-[12px] leading-none font-semibold text-neutral-200 hover:text-white hover:bg-neutral-800 disabled:text-neutral-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            A−
          </button>
          <select
            value={fontSize}
            onChange={(e) => selectFontSize(e.target.value as FontSizeStep)}
            aria-label={t("nav.fontStepSelect")}
            data-testid="font-size-select"
            className="w-[38px] sm:w-auto appearance-none bg-transparent px-0.5 sm:px-1.5 py-1 text-[11px] sm:text-[12px] leading-none font-medium text-neutral-200 text-center cursor-pointer focus:outline-none"
          >
            {fontSizeSteps(locale).map((step) => (
              <option key={step.value} value={step.value} className="bg-neutral-900 text-neutral-100">
                {step.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => adjustFontSize(1)}
            disabled={fontSize === "xl"}
            aria-label={t("nav.fontIncrease")}
            title={t("nav.fontIncreaseTitle")}
            data-testid="font-size-inc"
            className="px-1 sm:px-2 py-1 rounded text-[11px] sm:text-[12px] leading-none font-semibold text-neutral-200 hover:text-white hover:bg-neutral-800 disabled:text-neutral-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            A+
          </button>
        </div>
      </div>
    </nav>
    </>
  )
}
