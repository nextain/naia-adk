// Section + focus-note scrolling for the docs view (ported from the
// pre-11/24 docs UX, dependency-free).
// After the doc body renders, an address hash (`#...`) or a `&section=N`
// param scrolls to the matching heading and flashes it briefly. A
// `&note=<id>` param scrolls the memo panel to that note card instead.
// Misses are silent no-ops: the reader stays at the top.

export const SECTION_FLASH_CLASS = "doc-section-flash"
export const SECTION_FLASH_MS = 2400

export const NOTE_FLASH_CLASS = "doc-note-flash"
export const NOTE_FLASH_MS = 2500

export interface SectionScrollRoot {
  querySelectorAll: (selector: string) => ArrayLike<Element> | Iterable<Element>
}

export interface FocusNotePanel {
  querySelector: (selector: string) => Element | null
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .slice(0, 120)
}

function headingText(el: Element): string {
  return (el.textContent || "").trim()
}

function findHeading(
  root: SectionScrollRoot | null | undefined,
  target: { hash?: string | null; section?: string | null },
): Element | null {
  if (!root) return null
  const hash = (target.hash || "").replace(/^#/, "").trim()
  const section = (target.section || "").trim()
  if (!hash && !section) return null
  const elements = Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6")) as HTMLElement[]
  if (elements.length === 0) return null

  if (hash) {
    const decoded = (() => {
      try {
        return decodeURIComponent(hash)
      } catch {
        return hash
      }
    })()
    const byId = elements.find((el) => el.id === hash || el.id === decoded)
    if (byId) return byId
    const bySlug = elements.find((el) => slugify(headingText(el)) === slugify(decoded))
    if (bySlug) return bySlug
  }

  if (section) {
    const normalized = section.replace(/-/g, ".")
    const byPrefix = elements.find((el) => {
      const text = headingText(el)
      return text.startsWith(`${section}.`) || text.startsWith(`${section} `) || text.startsWith(normalized)
    })
    if (byPrefix) return byPrefix
  }

  return null
}

export function findSectionElement(
  root: SectionScrollRoot | null | undefined,
  target: { hash?: string | null; section?: string | null },
): HTMLElement | null {
  return findHeading(root, target) as HTMLElement | null
}

// Scroll to the heading and flash it. Returns true when a target was found.
export function scrollToSection(
  root: SectionScrollRoot | null | undefined,
  target: { hash?: string | null; section?: string | null },
): boolean {
  const el = findHeading(root, target) as HTMLElement | null
  if (!el) return false
  if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "start" })
  el.classList.remove(SECTION_FLASH_CLASS)
  // Re-trigger the flash even when the same heading is picked twice in a row.
  void el.offsetWidth
  el.classList.add(SECTION_FLASH_CLASS)
  for (const other of Array.from((root as SectionScrollRoot).querySelectorAll("[data-section-target]")) as HTMLElement[]) {
    if (other !== el) other.removeAttribute("data-section-target")
  }
  el.setAttribute("data-section-target", "1")
  setTimeout(() => {
    el.classList.remove(SECTION_FLASH_CLASS)
  }, SECTION_FLASH_MS)
  return true
}

// Find the note card for `&note=<id>`, preferring the thread's newest item.
export function findFocusNoteElement(
  panel: FocusNotePanel | null | undefined,
  noteId: string | null | undefined,
): HTMLElement | null {
  if (!panel || !noteId) return null
  const escaped =
    typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(noteId) : noteId
  const card = panel.querySelector(`[data-note-id="${escaped}"]`) as HTMLElement | null
  if (!card) return null
  const items = card.querySelectorAll('[data-testid="note-thread-item]')
  const list = Array.from(items) as HTMLElement[]
  return list.length ? list[list.length - 1] : card
}

// Scroll the memo panel to the note card and flash it. Returns true on success.
export function scrollToFocusNote(
  panel: FocusNotePanel | null | undefined,
  noteId: string | null | undefined,
): boolean {
  const el = findFocusNoteElement(panel, noteId)
  if (!el) return false
  if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" })
  el.classList.remove(NOTE_FLASH_CLASS)
  void el.offsetWidth
  el.classList.add(NOTE_FLASH_CLASS)
  setTimeout(() => {
    el.classList.remove(NOTE_FLASH_CLASS)
  }, NOTE_FLASH_MS)
  return true
}
