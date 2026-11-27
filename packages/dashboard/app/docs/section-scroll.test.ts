import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  findFocusNoteElement,
  findSectionElement,
  scrollToFocusNote,
  scrollToSection,
} from "./section-scroll.ts"

function heading(text: string, id = "", tag = "H2"): any {
  const classes = new Set<string>()
  return {
    tagName: tag,
    textContent: text,
    id,
    classList: {
      add: (c: string) => classes.add(c),
      remove: (c: string) => classes.delete(c),
      has: (c: string) => classes.has(c),
    },
    scrollIntoView: () => {},
    setAttribute: () => {},
    removeAttribute: () => {},
    offsetWidth: 0,
  }
}

describe("section-scroll (제목·메모 이동)", () => {
  it("hash와 같은 id의 제목을 찾는다", () => {
    const h1 = heading("시작하기", "start", "H1")
    const h2 = heading("설정", "setup", "H2")
    const root = {
      querySelectorAll: (sel: string) =>
        sel === "[data-section-target]" ? [] : [h1, h2],
    }
    assert.equal(findSectionElement(root, { hash: "#setup" }), h2)
    assert.equal(findSectionElement(root, { hash: "#missing" }), null)
    assert.equal(findSectionElement(root, {}), null)
    assert.equal(findSectionElement(null, { hash: "#setup" }), null)
  })

  it("없는 제목이면 이동하지 않고 false를 돌려준다", () => {
    const root = { querySelectorAll: () => [heading("안내", "guide")] }
    assert.equal(scrollToSection(root, { hash: "#없음" }), false)
  })

  it("제목을 찾으면 scrollIntoView하고 true를 돌려준다", () => {
    let scrolled = 0
    const h = heading("안내", "guide")
    h.scrollIntoView = () => {
      scrolled += 1
    }
    const root = { querySelectorAll: () => [h] }
    assert.equal(scrollToSection(root, { hash: "#guide" }), true)
    assert.equal(scrolled, 1)
  })

  it("메모 카드를 찾아 newest 스레드 항목을 돌려준다", () => {
    const newest = { scrolled: false }
    const panelLike = {
      querySelector: (sel: string) => {
        if (!sel.includes("n1")) return null
        return {
          querySelectorAll: () => [{ kind: "old" }, newest],
        }
      },
    }
    assert.equal(findFocusNoteElement(panelLike, "n1"), newest)
    assert.equal(findFocusNoteElement(panelLike, "missing"), null)
    assert.equal(findFocusNoteElement(null, "n1"), null)
    assert.equal(scrollToFocusNote(panelLike, "missing"), false)
  })
})
