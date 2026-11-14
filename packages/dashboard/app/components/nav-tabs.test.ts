import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { isMessagesPath, isTopNavTabActive, mainClassForPath, TOP_NAV_TABS, visibleTopNavTabs } from "./nav-tabs.ts"

describe("위 탭", () => {
  it("서버가 메신저를 껐다고 할 때만 대화 탭을 숨긴다", () => {
    assert.deepEqual(visibleTopNavTabs(true).map((t) => t.id), ["docs", "work", "messages"])
    assert.deepEqual(visibleTopNavTabs(null).map((t) => t.id), ["docs", "work", "messages"])
    assert.deepEqual(visibleTopNavTabs(false).map((t) => t.id), ["docs", "work"])
  })
  it("/messages 아래에서 대화 탭이 켜지고 본문은 꽉 찬다", () => {
    const messages = TOP_NAV_TABS.find((t) => t.id === "messages")!
    assert.ok(isTopNavTabActive(messages, "/messages/work"))
    assert.ok(!isTopNavTabActive(messages, "/messagesx"))
    assert.ok(isMessagesPath("/messages") && !isMessagesPath("/docs"))
    assert.equal(mainClassForPath("/messages/work"), "w-full")
    assert.equal(mainClassForPath("/docs"), "max-w-7xl mx-auto px-6 py-8")
  })
})
