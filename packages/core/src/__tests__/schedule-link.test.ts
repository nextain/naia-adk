import { describe, expect, it } from "vitest"
import { parseScheduleDetailSearch, scheduleDetailHref, scheduleLinkPath } from "../schedule-link.js"

describe("schedule deep link", () => {
  it("round-trips a personal item link", () => {
    const href = scheduleDetailHref({ layer: "personal", id: "ps-abc", date: "2026-11-12" })
    expect(href).toBe("/schedule?item=personal%3Aps-abc&date=2026-11-12")
    expect(parseScheduleDetailSearch(href.split("?")[1])).toEqual({ layer: "personal", id: "ps-abc", date: "2026-11-12" })
    expect(scheduleDetailHref({ layer: "milestone", id: "m1", date: "2026-11-12" }, "https://dash.example.test/")).toBe(
      "https://dash.example.test/schedule?item=milestone%3Am1&date=2026-11-12",
    )
  })

  it("rejects unknown layers, bad ids and impossible dates", () => {
    expect(parseScheduleDetailSearch("item=other:x&date=2026-11-12")).toBeNull()
    expect(parseScheduleDetailSearch("item=personal:a/b&date=2026-11-12")).toBeNull()
    expect(parseScheduleDetailSearch("item=personal:x&date=2026-02-30")).toBeNull()
    expect(parseScheduleDetailSearch("item=personal:x")).toBeNull()
    expect(() => scheduleDetailHref({ layer: "personal", id: "", date: "2026-11-12" })).toThrow()
  })

  it("keeps schedule links inside the dashboard only for relative or same-origin hrefs", () => {
    const path = "/schedule?item=personal%3Aps-1&date=2026-11-12"
    expect(scheduleLinkPath(path)).toBe(path)
    expect(scheduleLinkPath(`https://dash.example.test${path}`, ["https://dash.example.test"])).toBe(path)
    expect(scheduleLinkPath(`https://evil.example.test${path}`, ["https://dash.example.test"])).toBeNull()
    expect(scheduleLinkPath(`//evil.example.test${path}`)).toBeNull()
    expect(scheduleLinkPath("/schedule?item=bad")).toBe("/schedule")
    expect(scheduleLinkPath("/docs")).toBeNull()
    expect(scheduleLinkPath("javascript:alert(1)")).toBeNull()
  })
})
