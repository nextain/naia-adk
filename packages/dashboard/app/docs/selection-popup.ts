// Selection popup position helpers (ported from the pre-11/24 docs UX).
// On touch devices `mouseup` never fires for a long-press selection, so the
// docs view watches `selectionchange` and floats a memo action right below the
// selected text instead of forcing the reader to scroll back to the top.
// The OS selection menu (copy, ...) stays above the selection; this button
// sits below it, clear of the selection handles.

export interface RectLike {
  top: number
  bottom: number
  left: number
  right: number
}

export interface MemoButtonPositionInput {
  /** Last line rect of the selection, in viewport coordinates. */
  rect: RectLike
  viewportWidth: number
  viewportHeight: number
  buttonWidth?: number
  buttonHeight?: number
  /** Gap below the selection so the button clears the selection handles. */
  gap?: number
  margin?: number
}

export const MEMO_BUTTON_WIDTH = 112
export const MEMO_BUTTON_HEIGHT = 40
export const MEMO_BUTTON_GAP = 36
export const MEMO_BUTTON_MARGIN = 8

/** Viewport-clamped `position: fixed` coordinates for the floating memo button. */
export function computeMemoButtonPosition(input: MemoButtonPositionInput): { top: number; left: number } {
  const w = input.buttonWidth ?? MEMO_BUTTON_WIDTH
  const h = input.buttonHeight ?? MEMO_BUTTON_HEIGHT
  const gap = input.gap ?? MEMO_BUTTON_GAP
  const margin = input.margin ?? MEMO_BUTTON_MARGIN
  const { rect, viewportWidth, viewportHeight } = input

  const maxTop = Math.max(margin, viewportHeight - h - margin)
  const top = Math.min(Math.max(rect.bottom + gap, margin), maxTop)

  const center = (rect.left + rect.right) / 2
  const maxLeft = Math.max(margin, viewportWidth - w - margin)
  const left = Math.min(Math.max(center - w / 2, margin), maxLeft)

  return { top: Math.round(top), left: Math.round(left) }
}

/**
 * Whether the current selection gesture is touch/pen driven.
 * Desktop (mouse) keeps the existing `mouseup` flow, so this returns false.
 * - Last pointer was touch/pen: true
 * - Last pointer was mouse: false
 * - No pointer seen yet: fall back to coarse-pointer media (phones/tablets).
 */
export function isTouchSelectionMode(lastPointerType: string | null, coarsePointer: boolean): boolean {
  if (lastPointerType === "touch" || lastPointerType === "pen") return true
  if (lastPointerType === "mouse") return false
  return coarsePointer
}
