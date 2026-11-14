import assert from "node:assert/strict"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import vm from "node:vm"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Nav } from "../components/Nav.tsx"

const require = createRequire(import.meta.url)
require.extensions[".css"] = () => {}
const { default: RootLayout } = require("../layout.tsx") as typeof import("../layout.tsx")
import {
  DEFAULT_FONT_SIZE_STEP,
  DEFAULT_THEME_PREFERENCE,
  FONT_SIZE_STEPS,
  FONT_SIZE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  applyDocumentPreferences,
  buildThemeInitScript,
  detectSystemPrefersDark,
  fontSizePx,
  readFontSizeStep,
  readThemePreference,
  resolveTheme,
  stepFontSize,
  writeFontSizeStep,
  writeThemePreference,
  type StorageLike,
} from "../theme-prefs.ts"
import { isSafeVisibleText } from "./kinds.ts"

function createMemoryStorage(initial: Record<string, string> = {}): StorageLike & { dump(): Record<string, string> } {
  const store: Record<string, string> = { ...initial }
  return {
    getItem(key: string) {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null
    },
    setItem(key: string, value: string) {
      store[key] = String(value)
    },
    dump() {
      return { ...store }
    },
  }
}

function createThrowingStorage(): StorageLike {
  return {
    getItem() {
      throw new Error("SecurityError: localStorage blocked")
    },
    setItem() {
      throw new Error("QuotaExceededError: storage full")
    },
  }
}

function relativeLuminance(hex: string): number {
  const clean = hex.replace(/^#/, "")
  const r = parseInt(clean.slice(0, 2), 16) / 255
  const g = parseInt(clean.slice(2, 4), 16) / 255
  const b = parseInt(clean.slice(4, 6), 16) / 255
  const toLinear = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

function contrastRatio(hexA: string, hexB: string): number {
  const l1 = relativeLuminance(hexA)
  const l2 = relativeLuminance(hexB)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

describe("테마(라이트·다크·시스템) 선택·저장 및 초기화 스크립트 시험", () => {
  it("기본 테마는 system이고, localStorage에 light·dark·system을 저장·복원한다", () => {
    const storage = createMemoryStorage()
    assert.equal(readThemePreference(storage), DEFAULT_THEME_PREFERENCE)
    assert.equal(DEFAULT_THEME_PREFERENCE, "system")

    assert.equal(writeThemePreference("light", storage), true)
    assert.equal(storage.getItem(THEME_STORAGE_KEY), "light")
    assert.equal(readThemePreference(storage), "light")

    assert.equal(writeThemePreference("dark", storage), true)
    assert.equal(readThemePreference(storage), "dark")

    assert.equal(writeThemePreference("system", storage), true)
    assert.equal(readThemePreference(storage), "system")
  })

  it("잘못된 테마 값이나 localStorage 예외 발생 시에도 예외를 던지지 않고 기본값(system)을 유지한다", () => {
    const corrupted = createMemoryStorage({ [THEME_STORAGE_KEY]: "neon-pink" })
    assert.equal(readThemePreference(corrupted), "system")
    assert.equal(writeThemePreference("invalid" as never, corrupted), false)
    assert.equal(corrupted.getItem(THEME_STORAGE_KEY), "neon-pink")

    const throwing = createThrowingStorage()
    assert.equal(readThemePreference(throwing), "system")
    assert.equal(writeThemePreference("light", throwing), false)
  })

  it("system 모드는 prefers-color-scheme 결과에 따라 light 또는 dark로 결정된다", () => {
    assert.equal(resolveTheme("light", true), "light")
    assert.equal(resolveTheme("light", false), "light")
    assert.equal(resolveTheme("dark", true), "dark")
    assert.equal(resolveTheme("dark", false), "dark")
    assert.equal(resolveTheme("system", true), "dark")
    assert.equal(resolveTheme("system", false), "light")

    const mockLightWin = {
      matchMedia: (q: string) => ({ matches: q.includes("light") }),
    }
    const mockDarkWin = {
      matchMedia: (q: string) => ({ matches: q.includes("dark") }),
    }
    assert.equal(detectSystemPrefersDark(mockLightWin), false)
    assert.equal(detectSystemPrefersDark(mockDarkWin), true)
  })

  it("head 안 초기화 스크립트가 첫 화면 렌더 전에 <html data-theme>와 글자 크기를 먼저 설정한다", () => {
    const script = buildThemeInitScript()
    const runInit = (storedTheme: string | null, storedFont: string | null, prefersDark: boolean, throwStorage = false) => {
      const attrs: Record<string, string> = {}
      const style: Record<string, string> = {}
      const sandbox = {
        document: {
          documentElement: {
            setAttribute(k: string, v: string) {
              attrs[k] = v
            },
            style,
          },
        },
        localStorage: {
          getItem(k: string) {
            if (throwStorage) throw new Error("blocked")
            if (k === THEME_STORAGE_KEY) return storedTheme
            if (k === FONT_SIZE_STORAGE_KEY) return storedFont
            return null
          },
        },
        window: {
          matchMedia(query: string) {
            if (query === "(prefers-color-scheme: dark)") return { matches: prefersDark }
            if (query === "(prefers-color-scheme: light)") return { matches: !prefersDark }
            return { matches: false }
          },
        },
      }
      vm.runInNewContext(script, sandbox)
      return { attrs, style }
    }

    // 1) 기본(저장값 없음) + OS 라이트 -> data-theme="light", data-font-size="md"(16px)
    const defaultLight = runInit(null, null, false)
    assert.equal(defaultLight.attrs["data-theme"], "light")
    assert.equal(defaultLight.attrs["data-theme-pref"], "system")
    assert.equal(defaultLight.attrs["data-font-size"], "md")
    assert.equal(defaultLight.style.fontSize, "16px")
    assert.equal(defaultLight.style.colorScheme, "light")

    // 2) 저장된 light + lg(크게) -> OS가 dark여도 data-theme="light", 18px
    const savedLightLg = runInit("light", "lg", true)
    assert.equal(savedLightLg.attrs["data-theme"], "light")
    assert.equal(savedLightLg.attrs["data-theme-pref"], "light")
    assert.equal(savedLightLg.attrs["data-font-size"], "lg")
    assert.equal(savedLightLg.style.fontSize, "18px")

    // 3) localStorage 접근 예외 시에도 죽지 않고 시스템 테마 및 기본 글자 크기로 폴백
    const blockedStorage = runInit("light", "xl", true, true)
    assert.equal(blockedStorage.attrs["data-theme"], "dark")
    assert.equal(blockedStorage.attrs["data-theme-pref"], "system")
    assert.equal(blockedStorage.attrs["data-font-size"], "md")
    assert.equal(blockedStorage.style.fontSize, "16px")
  })
})

describe("글자 크기 4단계(작게·보통·크게·아주 크게) 저장 및 단계 이동 시험", () => {
  it("기본 글자 크기는 보통(md, 16px)이고 4단계 각각 올바른 px 크기로 저장·복원된다", () => {
    const storage = createMemoryStorage()
    assert.equal(readFontSizeStep(storage), DEFAULT_FONT_SIZE_STEP)
    assert.equal(DEFAULT_FONT_SIZE_STEP, "md")
    assert.equal(FONT_SIZE_STEPS.length, 4)

    const expected: Array<[ "sm" | "md" | "lg" | "xl", number, string ]> = [
      ["sm", 14, "작게"],
      ["md", 16, "보통"],
      ["lg", 18, "크게"],
      ["xl", 20, "아주 크게"],
    ]
    for (const [step, px, label] of expected) {
      assert.equal(writeFontSizeStep(step, storage), true)
      assert.equal(readFontSizeStep(storage), step)
      assert.equal(fontSizePx(step), px)
      const meta = FONT_SIZE_STEPS.find((s) => s.value === step)
      assert.equal(meta?.label, label)
    }
  })

  it("stepFontSize는 sm 아래로 내려가지 않고 xl 위로 넘어가지 않으며, DOM 루트에 font-size를 반영한다", () => {
    assert.equal(stepFontSize("sm", -1), "sm")
    assert.equal(stepFontSize("sm", 1), "md")
    assert.equal(stepFontSize("md", 1), "lg")
    assert.equal(stepFontSize("lg", 1), "xl")
    assert.equal(stepFontSize("xl", 1), "xl")
    assert.equal(stepFontSize("xl", -1), "lg")

    const attrs: Record<string, string> = {}
    const style: { fontSize?: string; colorScheme?: string } = {}
    applyDocumentPreferences(
      {
        setAttribute(k, v) {
          attrs[k] = v
        },
        style,
      },
      "light",
      "light",
      "lg",
    )
    assert.equal(attrs["data-theme"], "light")
    assert.equal(attrs["data-font-size"], "lg")
    assert.equal(style.fontSize, "18px")
    assert.equal(style.colorScheme, "light")
  })

  it("잘못된 글자 크기 값이나 localStorage 오류 시 기본값(md)으로 폴백한다", () => {
    const badStorage = createMemoryStorage({ [FONT_SIZE_STORAGE_KEY]: "xxl" })
    assert.equal(readFontSizeStep(badStorage), "md")
    assert.equal(writeFontSizeStep("xxl" as never, badStorage), false)

    const throwing = createThrowingStorage()
    assert.equal(readFontSizeStep(throwing), "md")
    assert.equal(writeFontSizeStep("lg", throwing), false)
  })
})

describe("Nav 및 RootLayout 렌더·WCAG AA 대비 시험", () => {
  it("Nav 오른쪽에 테마 단추(라이트·다크·시스템)와 글자 크기 단추(A−·단계 선택·A+)가 한국어 이름표와 aria-label로 렌더된다", () => {
    const html = renderToStaticMarkup(<Nav initialTheme="light" initialFontSize="sm" />)

    // 한국어 이름표 및 aria-label 확인
    assert.match(html, /aria-label="테마 선택"/)
    assert.match(html, /aria-label="라이트 테마"[^>]*aria-pressed="true"[^>]*>라이트<\/button>/)
    assert.match(html, /aria-label="다크 테마"[^>]*aria-pressed="false"[^>]*>다크<\/button>/)
    assert.match(html, /aria-label="시스템 테마"[^>]*aria-pressed="false"[^>]*>시스템<\/button>/)

    assert.match(html, /aria-label="글자 크기 조정"/)
    assert.match(html, /aria-label="글자 작게"/)
    assert.match(html, /aria-label="글자 크기 단계 선택"/)
    assert.match(html, /aria-label="글자 크게"/)
    assert.match(html, />작게<\/option>/)
    assert.match(html, />보통<\/option>/)
    assert.match(html, />크게<\/option>/)
    assert.match(html, />아주 크게<\/option>/)

    // 최소 단계(sm)에서는 A− 단추가 비활성화되고 A+ 단추는 활성화된다
    assert.match(html, /<button[^>]*disabled=""[^>]*data-testid="font-size-dec"/)
    assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*data-testid="font-size-inc"/)

    // 최대 단계(xl)에서는 A+ 단추가 비활성화된다
    const htmlXl = renderToStaticMarkup(<Nav initialTheme="dark" initialFontSize="xl" />)
    assert.match(htmlXl, /<button[^>]*disabled=""[^>]*data-testid="font-size-inc"/)
    assert.doesNotMatch(htmlXl, /<button[^>]*disabled=""[^>]*data-testid="font-size-dec"/)

    // 보이는 텍스트 안전성 검사
    const textTokens = html
      .replace(/<[^>]+>/g, " ")
      .split(/\s+/)
      .filter(Boolean)
    for (const token of textTokens) {
      assert.equal(isSafeVisibleText(token), true, `안전하지 않은 토큰 발견: ${token}`)
    }
  })

  it("RootLayout 렌더 시 <head> 안에 테마 초기화 스크립트가 포함된다", () => {
    const html = renderToStaticMarkup(
      <RootLayout>
        <div>문서 본문</div>
      </RootLayout>,
    )
    assert.match(html, /<html[^>]*lang="ko"/)
    assert.match(html, /data-theme/)
    assert.match(html, /naia-adk-theme/)
    assert.match(html, /naia-adk-font-size/)
  })

  it("globals.css의 라이트 테마 본문·보조·강조색이 모두 흰 배경(#ffffff) 및 보조 배경(#f1f5f9) 대비 WCAG AA(4.5:1) 이상이다", () => {
    const cssPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../globals.css")
    const css = fs.readFileSync(cssPath, "utf8")
    assert.match(css, /html\[data-theme="light"\]/)

    const vars: Record<string, string> = {}
    const lightBlockMatch = css.match(/html\[data-theme="light"\]\s*\{([\s\S]*?)\}/)
    assert.ok(lightBlockMatch, "html[data-theme=\"light\"] 블록이 있어야 한다")
    for (const m of lightBlockMatch[1].matchAll(/(--color-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})/g)) {
      vars[m[1]] = m[2]
    }

    const bgMain = vars["--color-neutral-950"]
    const bgSurface = vars["--color-neutral-900"]
    assert.equal(bgMain, "#ffffff")
    assert.ok(bgSurface)

    const textTokens = [
      "--color-white",
      "--color-neutral-100",
      "--color-neutral-200",
      "--color-neutral-300",
      "--color-neutral-400",
      "--color-neutral-500",
      "--color-neutral-600",
      "--color-amber-300",
      "--color-amber-400",
      "--color-amber-500",
      "--color-blue-200",
      "--color-blue-300",
      "--color-blue-400",
      "--color-emerald-300",
      "--color-emerald-400",
      "--color-green-400",
      "--color-red-300",
      "--color-red-400",
      "--color-rose-300",
      "--color-rose-400",
      "--color-purple-400",
      "--color-pink-400",
      "--color-sky-400",
    ]

    for (const token of textTokens) {
      const hex = vars[token]
      assert.ok(hex, `${token} 변수가 globals.css에 정의되어야 한다`)
      const ratioMain = contrastRatio(hex, bgMain)
      const ratioSurface = contrastRatio(hex, bgSurface)
      assert.ok(
        ratioMain >= 4.5,
        `${token}(${hex}) vs ${bgMain} 대비 ${ratioMain.toFixed(2)}:1 < 4.5:1 (WCAG AA 미달)`,
      )
      assert.ok(
        ratioSurface >= 4.5,
        `${token}(${hex}) vs ${bgSurface} 대비 ${ratioSurface.toFixed(2)}:1 < 4.5:1 (WCAG AA 미달)`,
      )
    }
  })
})
