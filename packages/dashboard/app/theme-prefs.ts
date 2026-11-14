// 대시보드 화면 테마(라이트·다크·시스템)와 글자 크기(4단계) 설정 도우미.
// 브라우저 localStorage 읽기·쓰기는 사생활 보호 모드나 저장 공간 제한에서도 안전하도록 모두 try/catch로 감싼다.

export type ThemePreference = "light" | "dark" | "system"
export type ResolvedTheme = "light" | "dark"
export type FontSizeStep = "sm" | "md" | "lg" | "xl"

export const THEME_STORAGE_KEY = "naia-adk-theme"
export const FONT_SIZE_STORAGE_KEY = "naia-adk-font-size"

export const DEFAULT_THEME_PREFERENCE: ThemePreference = "system"
export const DEFAULT_FONT_SIZE_STEP: FontSizeStep = "md"

export const THEME_OPTIONS: ReadonlyArray<{
  value: ThemePreference
  label: string
  ariaLabel: string
}> = [
  { value: "light", label: "라이트", ariaLabel: "라이트 테마" },
  { value: "dark", label: "다크", ariaLabel: "다크 테마" },
  { value: "system", label: "시스템", ariaLabel: "시스템 테마" },
]

export const FONT_SIZE_STEPS: ReadonlyArray<{
  value: FontSizeStep
  label: string
  px: number
}> = [
  { value: "sm", label: "작게", px: 14 },
  { value: "md", label: "보통", px: 16 },
  { value: "lg", label: "크게", px: 18 },
  { value: "xl", label: "아주 크게", px: 20 },
]

const FONT_STEP_ORDER: ReadonlyArray<FontSizeStep> = ["sm", "md", "lg", "xl"]

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function defaultStorage(): StorageLike | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage
    }
  } catch {
    // localStorage 접근이 막힌 환경이면 null 반환
  }
  return null
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system"
}

export function isFontSizeStep(value: unknown): value is FontSizeStep {
  return value === "sm" || value === "md" || value === "lg" || value === "xl"
}

export function readThemePreference(storage: Pick<StorageLike, "getItem"> | null = defaultStorage()): ThemePreference {
  try {
    const raw = storage?.getItem(THEME_STORAGE_KEY)
    if (isThemePreference(raw)) return raw
  } catch {
    // 읽기 실패 시 기본값(system) 사용
  }
  return DEFAULT_THEME_PREFERENCE
}

export function writeThemePreference(
  pref: ThemePreference,
  storage: Pick<StorageLike, "setItem"> | null = defaultStorage(),
): boolean {
  if (!isThemePreference(pref)) return false
  try {
    storage?.setItem(THEME_STORAGE_KEY, pref)
    return true
  } catch {
    return false
  }
}

export function resolveTheme(pref: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (pref === "light") return "light"
  if (pref === "dark") return "dark"
  return systemPrefersDark ? "dark" : "light"
}

export function detectSystemPrefersDark(win?: { matchMedia?: (query: string) => { matches: boolean } } | null): boolean {
  try {
    const target = win ?? (typeof window !== "undefined" ? window : null)
    if (target && typeof target.matchMedia === "function") {
      if (target.matchMedia("(prefers-color-scheme: dark)").matches) return true
      if (target.matchMedia("(prefers-color-scheme: light)").matches) return false
    }
  } catch {
    // matchMedia 미지원 또는 오류 시 다크 기본값 유지
  }
  return true
}

export function readFontSizeStep(storage: Pick<StorageLike, "getItem"> | null = defaultStorage()): FontSizeStep {
  try {
    const raw = storage?.getItem(FONT_SIZE_STORAGE_KEY)
    if (isFontSizeStep(raw)) return raw
  } catch {
    // 읽기 실패 시 기본값(md) 사용
  }
  return DEFAULT_FONT_SIZE_STEP
}

export function writeFontSizeStep(
  step: FontSizeStep,
  storage: Pick<StorageLike, "setItem"> | null = defaultStorage(),
): boolean {
  if (!isFontSizeStep(step)) return false
  try {
    storage?.setItem(FONT_SIZE_STORAGE_KEY, step)
    return true
  } catch {
    return false
  }
}

export function stepFontSize(current: FontSizeStep, direction: -1 | 1): FontSizeStep {
  const index = FONT_STEP_ORDER.indexOf(current)
  const safeIndex = index === -1 ? 1 : index
  const nextIndex = Math.min(Math.max(safeIndex + direction, 0), FONT_STEP_ORDER.length - 1)
  return FONT_STEP_ORDER[nextIndex]
}

export function fontSizePx(step: FontSizeStep): number {
  const found = FONT_SIZE_STEPS.find((item) => item.value === step)
  return found ? found.px : 16
}

export function fontSizeLabel(step: FontSizeStep): string {
  const found = FONT_SIZE_STEPS.find((item) => item.value === step)
  return found ? found.label : "보통"
}

export interface DocumentRootLike {
  setAttribute(name: string, value: string): void
  style?: {
    fontSize?: string
    colorScheme?: string
  }
}

export function applyDocumentPreferences(
  root: DocumentRootLike | null | undefined,
  resolvedTheme: ResolvedTheme,
  themePref: ThemePreference,
  fontSize: FontSizeStep,
): void {
  if (!root) return
  try {
    root.setAttribute("data-theme", resolvedTheme)
    root.setAttribute("data-theme-pref", themePref)
    root.setAttribute("data-font-size", fontSize)
    if (root.style) {
      root.style.fontSize = `${fontSizePx(fontSize)}px`
      root.style.colorScheme = resolvedTheme
    }
  } catch {
    // DOM 조작 실패 시 무시
  }
}

// 첫 화면이 깜박이지 않도록 <head> 안에서 동기 실행할 짧은 초기화 스크립트.
export function buildThemeInitScript(): string {
  return `(function(){try{var d=document.documentElement;var t=null,f=null;try{t=localStorage.getItem("${THEME_STORAGE_KEY}");f=localStorage.getItem("${FONT_SIZE_STORAGE_KEY}");}catch(_){}var pref=(t==="light"||t==="dark"||t==="system")?t:"system";var sysDark=true;try{if(typeof window.matchMedia==="function"){if(window.matchMedia("(prefers-color-scheme: dark)").matches)sysDark=true;else if(window.matchMedia("(prefers-color-scheme: light)").matches)sysDark=false;}}catch(_){}var resolved=pref==="light"?"light":pref==="dark"?"dark":(sysDark?"dark":"light");var step=(f==="sm"||f==="md"||f==="lg"||f==="xl")?f:"md";var px=step==="sm"?"14px":step==="lg"?"18px":step==="xl"?"20px":"16px";d.setAttribute("data-theme",resolved);d.setAttribute("data-theme-pref",pref);d.setAttribute("data-font-size",step);d.style.fontSize=px;d.style.colorScheme=resolved;}catch(_){}})();`
}
