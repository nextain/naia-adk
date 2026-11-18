/**
 * Utility for copying text to the clipboard with robust fallbacks.
 *
 * Preferred: navigator.clipboard.writeText
 * Fallback: document.execCommand("copy") using a temporary hidden textarea
 *
 * Guarantees:
 * - Falls back on absent, non-function, rejected, or throwing navigator.clipboard.writeText.
 * - Exact-text transports: copyTextToClipboard and copyWithExecCommandFallback never normalize.
 * - Normalization occurs exactly once at pre extraction (extractPreText).
 * - Returns true only when execCommand returns true. False or throw results in failure (false).
 * - Always cleans up the temporary textarea, even if an exception occurs.
 * - Restores focus before selection to prevent focus events from altering restored selection.
 * - Snapshots and restores all selection range clones.
 * - Safely catches DOM exceptions (createElement, appendChild, getSelection).
 */

export interface CopyOptions {
  doc?: Document
  nav?: Navigator
}

/**
 * Normalizes code text by removing exactly one trailing newline,
 * preserving pre.innerText.replace(/\n$/, "") semantics.
 */
export function normalizeCodeText(text: string): string {
  if (typeof text !== "string") return ""
  return text.replace(/\n$/, "")
}

/**
 * Extracts text from a pre element, preserving trailing newline semantics.
 * Normalization occurs exactly once here.
 */
export function extractPreText(
  pre: { innerText?: string; textContent?: string | null } | null | undefined
): string {
  if (!pre) return ""
  const raw = typeof pre.innerText === "string" ? pre.innerText : (pre.textContent ?? "")
  return normalizeCodeText(raw)
}

/**
 * Fallback copy method using a hidden textarea and document.execCommand("copy").
 * Exact-text transport: never normalizes input text.
 * Restores activeElement focus before selection, and cleans up the textarea in a finally block.
 * Returns true ONLY if execCommand returns true; returns false if execCommand returns false or throws.
 */
export function copyWithExecCommandFallback(text: string, doc?: Document): boolean {
  if (typeof text !== "string") {
    return false
  }

  const currentDoc = doc ?? (typeof document !== "undefined" ? document : undefined)
  if (!currentDoc) {
    return false
  }

  let activeElement: HTMLElement | null = null
  try {
    activeElement = (
      typeof currentDoc.activeElement !== "undefined" ? currentDoc.activeElement : null
    ) as HTMLElement | null
  } catch {}

  let selection: Selection | null = null
  try {
    selection =
      typeof currentDoc.getSelection === "function"
        ? currentDoc.getSelection()
        : typeof window !== "undefined" && typeof window.getSelection === "function"
        ? window.getSelection()
        : null
  } catch {}

  const savedRanges: Range[] = []
  let anchorNode: Node | null = null
  let anchorOffset = 0
  let focusNode: Node | null = null
  let focusOffset = 0
  let isBackwards = false

  if (selection) {
    try {
      anchorNode = selection.anchorNode ?? null
      anchorOffset = selection.anchorOffset ?? 0
      focusNode = selection.focusNode ?? null
      focusOffset = selection.focusOffset ?? 0
    } catch {}

    if (typeof selection.rangeCount === "number" && typeof selection.getRangeAt === "function") {
      for (let i = 0; i < selection.rangeCount; i++) {
        try {
          const range = selection.getRangeAt(i)
          if (range) {
            savedRanges.push(typeof range.cloneRange === "function" ? range.cloneRange() : range)
          }
        } catch {}
      }
    }

    try {
      if (
        selection.rangeCount === 1 &&
        !selection.isCollapsed &&
        anchorNode &&
        focusNode
      ) {
        if (anchorNode === focusNode) {
          isBackwards = anchorOffset > focusOffset
        } else if (typeof anchorNode.compareDocumentPosition === "function") {
          const pos = anchorNode.compareDocumentPosition(focusNode)
          if (pos & 2 /* Node.DOCUMENT_POSITION_PRECEDING */) {
            isBackwards = true
          }
        }
        if (!isBackwards && savedRanges.length === 1) {
          const r = savedRanges[0]
          if (
            r &&
            r.startContainer === focusNode &&
            r.startOffset === focusOffset &&
            (r.endContainer !== focusNode || r.endOffset !== focusOffset)
          ) {
            isBackwards = true
          }
        }
      }
    } catch {}
  }

  let container: HTMLElement | null = null
  try {
    container = currentDoc.body || currentDoc.documentElement
  } catch {}

  if (!container) {
    return false
  }

  let textarea: HTMLTextAreaElement | null = null
  let success = false
  try {
    textarea = currentDoc.createElement("textarea")
    textarea.value = text
    textarea.setAttribute("readonly", "")
    textarea.setAttribute("aria-hidden", "true")
    textarea.tabIndex = -1
    if (textarea.style) {
      textarea.style.position = "fixed"
      textarea.style.top = "-9999px"
      textarea.style.left = "-9999px"
      textarea.style.opacity = "0"
    }

    container.appendChild(textarea)

    if (typeof textarea.select === "function") {
      textarea.select()
    }
    if (typeof textarea.setSelectionRange === "function") {
      textarea.setSelectionRange(0, textarea.value.length)
    }

    if (typeof currentDoc.execCommand === "function") {
      success = currentDoc.execCommand("copy") === true
    } else {
      success = false
    }
  } catch {
    success = false
  } finally {
    // 1. Cleanup textarea always
    try {
      if (textarea && textarea.parentNode) {
        textarea.parentNode.removeChild(textarea)
      }
    } catch {}

    // 2. Restore focus before selection to avoid focus changing restored selection
    try {
      if (activeElement && typeof activeElement.focus === "function") {
        activeElement.focus()
      }
    } catch {}

    // 3. Restore selection range clones and backwards direction safely
    try {
      if (selection) {
        let directionRestored = false
        if (savedRanges.length === 1 && isBackwards && anchorNode && focusNode) {
          if (typeof selection.setBaseAndExtent === "function") {
            try {
              selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset)
              directionRestored = true
            } catch {}
          }
          if (
            !directionRestored &&
            typeof selection.collapse === "function" &&
            typeof selection.extend === "function"
          ) {
            try {
              selection.collapse(anchorNode, anchorOffset)
              selection.extend(focusNode, focusOffset)
              directionRestored = true
            } catch {}
          }
        }

        if (!directionRestored && typeof selection.removeAllRanges === "function") {
          selection.removeAllRanges()
          for (const range of savedRanges) {
            if (typeof selection.addRange === "function") {
              selection.addRange(range)
            }
          }
        }
      }
    } catch {}
  }

  return success
}

/**
 * Copies text to the clipboard.
 * Exact-text transport: never normalizes input text.
 * Prefers navigator.clipboard.writeText.
 * On absent, nonfunction, rejected, or throwing writeText, falls back to copyWithExecCommandFallback.
 */
export async function copyTextToClipboard(
  text: string,
  options?: CopyOptions
): Promise<boolean> {
  const nav = options?.nav ?? (typeof navigator !== "undefined" ? navigator : undefined)
  const doc = options?.doc ?? (typeof document !== "undefined" ? document : undefined)

  if (nav) {
    try {
      const clipboard = nav.clipboard
      if (clipboard && typeof clipboard.writeText === "function") {
        await clipboard.writeText(text)
        return true
      }
    } catch {
      // Rejected promise or threw synchronously, fall back to execCommand
    }
  }

  return copyWithExecCommandFallback(text, doc)
}
