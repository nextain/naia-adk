"use client"

import React, { useEffect, useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  DEFAULT_FONT_SIZE_STEP,
  DEFAULT_THEME_PREFERENCE,
  FONT_SIZE_STEPS,
  THEME_OPTIONS,
  applyDocumentPreferences,
  detectSystemPrefersDark,
  readFontSizeStep,
  readThemePreference,
  resolveTheme,
  stepFontSize,
  writeFontSizeStep,
  writeThemePreference,
  type FontSizeStep,
  type ThemePreference,
} from "../theme-prefs"

interface PortalData {
  board: { port: number } | null
}

export interface NavProps {
  initialTheme?: ThemePreference
  initialFontSize?: FontSizeStep
}

const tabClass = (active: boolean) =>
  `whitespace-nowrap px-1.5 sm:px-3 py-1 sm:py-1.5 rounded-md text-[12px] sm:text-sm font-medium transition-colors ${
    active ? "bg-neutral-800 text-white" : "text-neutral-400 hover:text-white hover:bg-neutral-900"
  }`

export function Nav({
  initialTheme = DEFAULT_THEME_PREFERENCE,
  initialFontSize = DEFAULT_FONT_SIZE_STEP,
}: NavProps = {}) {
  const pathname = usePathname() || "/"
  const [hasBoard, setHasBoard] = useState<boolean | null>(null)
  const [themePref, setThemePref] = useState<ThemePreference>(initialTheme)
  const [fontSize, setFontSize] = useState<FontSizeStep>(initialFontSize)

  useEffect(() => {
    fetch("/api/portal")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: PortalData | null) => setHasBoard(Boolean(data?.board?.port)))
      .catch(() => setHasBoard(false))
  }, [])

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
    <nav className="sticky top-0 z-10 h-14 border-b border-neutral-800 bg-neutral-950 px-2 sm:px-6 flex items-center gap-1 sm:gap-6">
      <Link href="/docs" className="font-bold text-[13px] sm:text-lg text-white shrink-0 whitespace-nowrap">
        Naia ADK
      </Link>

      <div className="flex items-center gap-0.5 sm:gap-1 shrink-0">
        <Link href="/docs" className={tabClass(isActive("/docs"))}>
          문서
        </Link>
        {hasBoard === false ? (
          <span
            className="px-1.5 sm:px-3 py-1 sm:py-1.5 text-[12px] sm:text-sm font-medium text-neutral-600 cursor-not-allowed whitespace-nowrap"
            title="회사 설정이 없어 작업보드가 없습니다. pnpm adk:setup으로 회사 설정을 먼저 하세요."
          >
            작업
          </span>
        ) : (
          <Link href="/work" className={tabClass(isActive("/work"))}>
            작업
          </Link>
        )}
      </div>

      <div className="ml-auto flex items-center gap-1 sm:gap-3 shrink-0">
        {/* 개발자용 화면은 뒤로 뺀다. 좁은 화면에서는 숨긴다. */}
        <div className="hidden xl:flex items-center gap-1">
          <span className="px-2 text-xs text-neutral-600 whitespace-nowrap">개발자 도구</span>
          <Link href="/" className={tabClass(pathname === "/")}>
            Overview
          </Link>
          <Link href="/workspace" className={tabClass(isActive("/workspace"))}>
            Workspace
          </Link>
          <Link href="/skills" className={tabClass(isActive("/skills"))}>
            Skills
          </Link>
          <Link href="/settings" className={tabClass(isActive("/settings"))}>
            Settings
          </Link>
        </div>

        {/* 화면 테마(라이트·다크·시스템)와 글자 크기(4단계)는 좁은 화면에서도 항상 보인다. */}
        <div
          role="group"
          aria-label="테마 선택"
          className="inline-flex items-center rounded-md border border-neutral-800 bg-neutral-900 p-0.5"
        >
          {THEME_OPTIONS.map((opt) => {
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
          aria-label="글자 크기 조정"
          className="inline-flex items-center rounded-md border border-neutral-800 bg-neutral-900 p-0.5"
        >
          <button
            type="button"
            onClick={() => adjustFontSize(-1)}
            disabled={fontSize === "sm"}
            aria-label="글자 작게"
            title="글자 작게 (A−)"
            data-testid="font-size-dec"
            className="px-1 sm:px-2 py-1 rounded text-[11px] sm:text-[12px] leading-none font-semibold text-neutral-200 hover:text-white hover:bg-neutral-800 disabled:text-neutral-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            A−
          </button>
          <select
            value={fontSize}
            onChange={(e) => selectFontSize(e.target.value as FontSizeStep)}
            aria-label="글자 크기 단계 선택"
            data-testid="font-size-select"
            className="w-[38px] sm:w-auto appearance-none bg-transparent px-0.5 sm:px-1.5 py-1 text-[11px] sm:text-[12px] leading-none font-medium text-neutral-200 text-center cursor-pointer focus:outline-none"
          >
            {FONT_SIZE_STEPS.map((step) => (
              <option key={step.value} value={step.value} className="bg-neutral-900 text-neutral-100">
                {step.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => adjustFontSize(1)}
            disabled={fontSize === "xl"}
            aria-label="글자 크게"
            title="글자 크게 (A+)"
            data-testid="font-size-inc"
            className="px-1 sm:px-2 py-1 rounded text-[11px] sm:text-[12px] leading-none font-semibold text-neutral-200 hover:text-white hover:bg-neutral-800 disabled:text-neutral-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            A+
          </button>
        </div>
      </div>
    </nav>
  )
}
