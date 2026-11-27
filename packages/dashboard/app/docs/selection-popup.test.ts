import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  computeMemoButtonPosition,
  isTouchSelectionMode,
  MEMO_BUTTON_GAP,
  MEMO_BUTTON_HEIGHT,
  MEMO_BUTTON_MARGIN,
  MEMO_BUTTON_WIDTH,
} from "./selection-popup.ts"

describe("selection-popup (터치 메모 단추 위치·모드)", () => {
  it("선택 글 아래 가운데에 단추를 두고 화면 밖으로 나가지 않는다", () => {
    const pos = computeMemoButtonPosition({
      rect: { top: 100, bottom: 120, left: 200, right: 300 },
      viewportWidth: 800,
      viewportHeight: 600,
    })
    assert.equal(pos.top, 120 + MEMO_BUTTON_GAP)
    assert.equal(pos.left, Math.round(250 - MEMO_BUTTON_WIDTH / 2))
  })

  it("오른쪽·아래 가장자리에서는 안쪽으로 가둔다", () => {
    const pos = computeMemoButtonPosition({
      rect: { top: 580, bottom: 595, left: 750, right: 795 },
      viewportWidth: 800,
      viewportHeight: 600,
    })
    assert.ok(pos.top <= 600 - MEMO_BUTTON_HEIGHT - MEMO_BUTTON_MARGIN)
    assert.ok(pos.left <= 800 - MEMO_BUTTON_WIDTH - MEMO_BUTTON_MARGIN)
    assert.ok(pos.top >= MEMO_BUTTON_MARGIN)
    assert.ok(pos.left >= MEMO_BUTTON_MARGIN)
  })

  it("왼쪽·위 가장자리에서는 margin 안쪽에 둔다", () => {
    const pos = computeMemoButtonPosition({
      rect: { top: 0, bottom: 4, left: 0, right: 10 },
      viewportWidth: 800,
      viewportHeight: 600,
    })
    assert.ok(pos.top >= MEMO_BUTTON_MARGIN)
    assert.ok(pos.left >= MEMO_BUTTON_MARGIN)
  })

  it("isTouchSelectionMode: 터치·펜은 true, 마우스는 false", () => {
    assert.equal(isTouchSelectionMode("touch", false), true)
    assert.equal(isTouchSelectionMode("pen", false), true)
    assert.equal(isTouchSelectionMode("mouse", true), false)
    assert.equal(isTouchSelectionMode(null, true), true)
    assert.equal(isTouchSelectionMode(null, false), false)
  })
})
