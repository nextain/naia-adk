import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import YAML from "yaml"
import { MAX_PERSONAL_FILE_BYTES, parsePersonalScheduleYaml, parseScheduleDateTime, readPersonalSchedule, validateAndNormalizeItem } from "../personal-schedule.js"

const dirs: string[] = []
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-test-"))
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

describe("personal schedules", () => {
  it("reads both legacy Korean keys and YAML stringify scalars without loss", () => {
    const legacy = `사용자: user\n일정:\n  - 제목: 'Review: plan'\n    시작: 2026-11-11 9:30\n    끝: 2026-11-11 10:15\n    메모: |\n      First line\n      Second line\n`
    const doc = parsePersonalScheduleYaml(legacy, "user")
    expect(doc.warnings.some((warning) => warning.includes("whitespace"))).toBe(true)
    expect(doc.items[0]).toMatchObject({ title: "Review: plan", start: "2026-11-11 09:30", end: "2026-11-11 10:15", allDay: false, memo: "First line\nSecond line" })
    const serialized = YAML.stringify({ user: "user", updatedAt: "2026-11-11T00:00:00Z", items: doc.items })
    expect(parsePersonalScheduleYaml(serialized, "user")).toEqual({ ...doc, updatedAt: "2026-11-11T00:00:00Z", warnings: [] })
  })
  it("preserves the requested identity and warns on malformed, unknown or duplicate content", () => {
    expect(parsePersonalScheduleYaml('items: [unterminated', 'user').warnings.length).toBeGreaterThan(0)
    const doc = parsePersonalScheduleYaml(`user: other\nitems:\n  - id: one\n    title: first\n    start: 2026-11-11\n    unknown: preserved-only-in-original\n  - id: one\n    title: second\n    start: 2026-11-12\n  - title: incomplete\n`, "user")
    expect(doc.user).toBe("user")
    expect(doc.items.map((item) => item.title)).toEqual(["first"])
    expect(doc.warnings).toHaveLength(4)
    expect(parsePersonalScheduleYaml('items: []\nitems: []', 'user').warnings.length).toBeGreaterThan(0)
  })
  it("warns about actual YAML comments without mistaking quoted hash characters for comments", () => {
    const uncommented = 'items:\n  - title: "Topic #1"\n    start: 2026-11-11\n    memo: "#keep"\n'
    expect(parsePersonalScheduleYaml(uncommented, "user").warnings).toEqual([])
    for (const commented of [
      `# header\n${uncommented}`,
      uncommented.replace('"Topic #1"', '"Topic #1" # inline'),
      `${uncommented}# footer\n`,
      uncommented.replace('    memo:', '    # note\n    memo:'),
    ]) {
      expect(parsePersonalScheduleYaml(commented, "user").warnings.some((warning) => warning.includes("comments"))).toBe(true)
    }
  })
  it("warns when YAML anchors, aliases or explicit tags would be lost on save", () => {
    const anchored = `items:
  - title: &name meeting
    start: 2026-11-11
    memo: *name
`
    const doc = parsePersonalScheduleYaml(anchored, "user")
    expect(doc.items[0].memo).toBe("meeting")
    expect(doc.warnings.some((warning) => warning.includes("anchors"))).toBe(true)
    expect(parsePersonalScheduleYaml("items: !!seq []", "user").warnings.length).toBeGreaterThan(0)
  })
  it("warns when saving an existing item would alter its time or date range", () => {
    for (const fields of [
      "start: 2026-11-11 09:30:45",
      "start: 2026-11-11 09:30\n    allDay: true",
      "start: 2026-11-11\n    allDay: false",
      "start: 2026-11-11 09:30\n    end: 2026-11-12\n    allDay: false",
      "start: 2026-11-11\n    end: 2026-11-10",
      "start: 2026-11-11 10:00\n    end: 2026-11-11 09:00",
    ]) {
      const doc = parsePersonalScheduleYaml(`items:\n  - title: Event\n    ${fields}\n`, "user")
      expect(doc.items).toHaveLength(1)
      expect(doc.warnings.length).toBeGreaterThan(0)
    }
    expect(parsePersonalScheduleYaml("items:\n  - title: Event\n    start: 2026-11-11 09:30\n    end: 2026-11-11 10:00\n", "user").warnings).toEqual([])
    expect(validateAndNormalizeItem({ title: "Event", start: "2026-11-11", allDay: false })).toMatchObject({ ok: true, item: { start: "2026-11-11 09:00" } })
  })
  it("warns when saving would trim ID whitespace", () => {
    const doc = parsePersonalScheduleYaml('items:\n  - id: " item-1 "\n    title: Event\n    start: 2026-11-11\n', "user")
    expect(doc.items[0].id).toBe("item-1")
    expect(doc.warnings.some((warning) => warning.includes("id whitespace"))).toBe(true)
    expect(parsePersonalScheduleYaml('items:\n  - id: item-1\n    title: Event\n    start: 2026-11-11\n', "user").warnings).toEqual([])
  })
  it("warns when saving would trim title or memo whitespace", () => {
    for (const field of [
      'title: " Event "\n    memo: clean',
      'title: Event\n    memo: "  keep  "',
      'title: Event\n    memo: |+\n      keep\n\n',
    ]) {
      const doc = parsePersonalScheduleYaml(`items:\n  - ${field}\n    start: 2026-11-11\n`, "user")
      expect(doc.items).toHaveLength(1)
      expect(doc.warnings.some((warning) => warning.includes("whitespace"))).toBe(true)
    }
    expect(validateAndNormalizeItem({ title: " Event ", start: "2026-11-11", memo: " note " })).toMatchObject({ ok: true, item: { title: "Event", memo: "note" } })
  })
  it("checks calendar boundaries and normalizes all-day and timed inputs", () => {
    expect(parseScheduleDateTime("2026-02-29")).toBeNull()
    expect(parseScheduleDateTime("2024-02-29 24:00")).toBeNull()
    expect(parseScheduleDateTime("2024-02-29 01:00:99")).toBeNull()
    expect(validateAndNormalizeItem({ title: "Event", start: "2024-02-29" })).toMatchObject({ ok: true, item: { start: "2024-02-29", end: "2024-02-29", allDay: true } })
    expect(validateAndNormalizeItem({ title: "Event", start: "2024-02-29 9:00", end: "2024-02-28 8:00" })).toMatchObject({ ok: true, item: { start: "2024-02-29 09:00", end: "2024-02-29 09:00", allDay: false } })
  })
  it("reads only the selected user's file and rejects unsafe paths and files", () => {
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, "user.yaml"), "items:\n  - title: Personal\n    start: 2026-11-11\n")
    expect(readPersonalSchedule("user", dir).items[0].title).toBe("Personal")
    expect(readPersonalSchedule("another", dir).items).toEqual([])
    expect(() => readPersonalSchedule("../user", dir)).toThrow()
    fs.symlinkSync(path.join(dir, "user.yaml"), path.join(dir, "link.yaml"))
    expect(() => readPersonalSchedule("link", dir)).toThrow()
    fs.linkSync(path.join(dir, "user.yaml"), path.join(dir, "hard.yaml"))
    expect(() => readPersonalSchedule("hard", dir)).toThrow()
    fs.writeFileSync(path.join(dir, "large.yaml"), Buffer.alloc(MAX_PERSONAL_FILE_BYTES + 1))
    expect(() => readPersonalSchedule("large", dir)).toThrow()
  })
})
