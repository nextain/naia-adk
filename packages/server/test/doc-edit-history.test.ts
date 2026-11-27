import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { appendDocEditHistory } from "../src/doc-edit-history.js"

describe("문서 편집 이력", () => {
  let root = ""
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true })
    root = ""
  })

  it("대시보드 저장 뒤 JSONL에 한 줄을 남긴다", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "doc-edit-history-"))
    const file = appendDocEditHistory(root, {
      timestamp: "2026-11-04T20:00:00.000Z",
      source: "adk",
      path: "article/draft.md",
      previousHash: "0".repeat(64),
      newHash: "1".repeat(64),
      origin: "대시보드",
    })
    expect(path.dirname(file)).toBe(path.join(root, ".agents", "work", "doc-edits"))
    const lines = fs.readFileSync(file, "utf8").trim().split("\n")
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({ source: "adk", path: "article/draft.md", origin: "대시보드" })
  })

  it("잘못된 origin은 기록하지 않는다", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "doc-edit-history-"))
    expect(() => appendDocEditHistory(root, {
      timestamp: "2026-11-04T20:00:00.000Z",
      source: "adk",
      path: "article/draft.md",
      previousHash: "0".repeat(64),
      newHash: "1".repeat(64),
      origin: "unknown" as any,
    })).toThrow("Invalid document edit origin")
    expect(fs.existsSync(path.join(root, ".agents", "work", "doc-edits"))).toBe(false)
  })
})
