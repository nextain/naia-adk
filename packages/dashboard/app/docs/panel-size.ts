export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const TREE_WIDTH_KEY = "docs.treeWidth"
export const TREE_COLLAPSED_KEY = "docs.treeCollapsed"
export const NOTES_WIDTH_KEY = "docs.notesWidth"
export const EDITOR_SPLIT_KEY = "docs.editorSplit"

export const TREE_WIDTH_DEFAULT = 288
export const TREE_WIDTH_MIN = 200
export const TREE_WIDTH_MAX = 560
export const TREE_WIDTH_STEP = 16

export const NOTES_WIDTH_DEFAULT = 320
export const NOTES_WIDTH_MIN = 240
export const NOTES_WIDTH_MAX = 560
export const NOTES_WIDTH_STEP = 16

export const EDITOR_SPLIT_DEFAULT = 50
export const EDITOR_SPLIT_MIN = 25
export const EDITOR_SPLIT_MAX = 75
export const EDITOR_SPLIT_STEP = 2

/**
 * 값을 [min, max] 범위로 자른다.
 */
export function clampSize(val: number, min: number, max: number): number {
  if (isNaN(val)) return min
  return Math.min(Math.max(val, min), max)
}

/**
 * 저장된 문자열 값을 숫자로 파싱하고 범위를 보정한다.
 * 숫자가 아니거나 빈 값이면 defaultValue 반환.
 * 범위를 벗어나면 범위 안 값으로 clamp.
 */
export function parseStoredNumber(
  raw: string | null | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number {
  if (raw === null || raw === undefined || raw.trim() === "") {
    return defaultValue
  }
  const parsed = Number(raw)
  if (isNaN(parsed)) {
    return defaultValue
  }
  return clampSize(parsed, min, max)
}

/**
 * 저장된 접힘 불리언 값을 파싱한다 ("1"/"0").
 */
export function parseStoredBoolean(
  raw: string | null | undefined,
  defaultValue = false,
): boolean {
  if (raw === "1" || raw === "true") return true
  if (raw === "0" || raw === "false") return false
  return defaultValue
}

/**
 * 키보드 이벤트에 따른 다음 크기 계산:
 * - ArrowLeft / ArrowDown: -step
 * - ArrowRight / ArrowUp: +step
 * - Home: min
 * - End: max
 */
export function getNextSizeFromKey(
  key: string,
  current: number,
  min: number,
  max: number,
  step: number,
  invert = false,
): number {
  const direction = invert ? -1 : 1
  switch (key) {
    case "ArrowLeft":
    case "ArrowDown":
      return clampSize(current - step * direction, min, max)
    case "ArrowRight":
    case "ArrowUp":
      return clampSize(current + step * direction, min, max)
    case "Home":
      return min
    case "End":
      return max
    default:
      return current
  }
}

/**
 * 안전한 저장소 읽기
 */
export function getStoredItem(key: string, storage?: StorageLike | null): string | null {
  try {
    const store = storage ?? (typeof window !== "undefined" ? window.localStorage : null)
    if (!store) return null
    return store.getItem(key)
  } catch {
    return null
  }
}

/**
 * 안전한 저장소 쓰기
 */
export function setStoredItem(
  key: string,
  value: string,
  storage?: StorageLike | null,
): void {
  try {
    const store = storage ?? (typeof window !== "undefined" ? window.localStorage : null)
    if (!store) return
    store.setItem(key, value)
  } catch {}
}

/**
 * 1.3 트리 패널 표시 클래스 계산 순수 함수:
 * - 좁은 화면(md 미만)의 보임은 mobileTreeOpen만으로 결정 ("block" / "hidden")
 * - 넓은 화면(md 이상)의 보임은 treeCollapsed만으로 결정 ("md:hidden" / "md:block")
 * !important (!block) 덮어쓰기를 쓰지 않는다.
 */
export function computeTreeAsideClasses(
  mobileTreeOpen: boolean,
  treeCollapsed: boolean,
): string {
  const mobileClass = mobileTreeOpen ? "block" : "hidden"
  const mdClass = treeCollapsed ? "md:hidden" : "md:block"
  return `${mobileClass} ${mdClass}`
}

/**
 * 1.5 끌기 시작 시 userSelect 설정 및 원래 값 기억:
 * target 객체의 원래 userSelect를 반환하고 "none"으로 설정한다.
 */
export function beginDragUserSelect(target?: { userSelect: string } | null): string {
  if (!target) return ""
  const original = target.userSelect || ""
  target.userSelect = "none"
  return original
}

/**
 * 1.5 끌기 종료 시 userSelect 복원:
 * target 객체의 userSelect를 기억해 둔 원래 값으로 되돌린다.
 */
export function restoreUserSelect(
  target?: { userSelect: string } | null,
  originalUserSelect = "",
): void {
  if (!target) return
  target.userSelect = originalUserSelect
}
