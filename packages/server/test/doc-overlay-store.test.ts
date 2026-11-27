import { describe, it, expect } from "vitest"
import { DocOverlayStore, isValidOverlaySource, normalizeOverlayPath, overlayDbPath } from "../src/doc-overlay-store.js"

describe("doc-overlay-store (path confinement)", () => {
  it("accepts clean markdown paths and rejects escapes", () => {
    expect(normalizeOverlayPath("guide/intro.md")).toBe("guide/intro.md")
    expect(normalizeOverlayPath("a.md")).toBe("a.md")
    expect(normalizeOverlayPath("../secret.md")).toBeNull()
    expect(normalizeOverlayPath("a/../../b.md")).toBeNull()
    expect(normalizeOverlayPath("/abs/path.md")).toBeNull()
    expect(normalizeOverlayPath(".hidden/a.md")).toBeNull()
    expect(normalizeOverlayPath("a/.git/x.md")).toBeNull()
    expect(normalizeOverlayPath("notes.txt")).toBeNull()
    expect(normalizeOverlayPath("")).toBeNull()
    expect(normalizeOverlayPath("a\\b.md")).toBe("a/b.md")
  })

  it("validates source ids", () => {
    expect(isValidOverlaySource("adk")).toBe(true)
    expect(isValidOverlaySource("company:co-docs")).toBe(true)
    expect(isValidOverlaySource("../../../etc")).toBe(false)
    expect(isValidOverlaySource("")).toBe(false)
  })

  it("resolves the db path from NAIA_AX_DOC_STORE with a workspace default", () => {
    expect(overlayDbPath("/root", { NAIA_AX_DOC_STORE: "/data/ax.sqlite" } as any)).toBe("/data/ax.sqlite")
    expect(overlayDbPath("/root", { NAIA_AX_DOC_STORE: "state/x.sqlite" } as any)).toBe("/root/state/x.sqlite")
    expect(overlayDbPath("/root", {} as any)).toBe("/root/.agents/work/state/ax-doc-overlay.sqlite")
  })
})

describe("doc-overlay-store (CRUD + revisions)", () => {
  it("creates, updates, lists, and keeps revision history", () => {
    const store = new DocOverlayStore(":memory:")
    try {
      expect(store.get("adk", "a.md")).toBeNull()
      const first = store.put({ source: "adk", path: "a.md", content: "# v1", updatedBy: "tester", baseGitSha: "aaa" })
      expect(first.revision).toBe(1)
      expect(first.updatedBy).toBe("tester")
      const second = store.put({ source: "adk", path: "a.md", content: "# v2", updatedBy: "tester", baseGitSha: "aaa" })
      expect(second.revision).toBe(2)
      expect(store.get("adk", "a.md")?.content).toBe("# v2")
      expect(store.list()).toHaveLength(1)
      const history = store.history("adk", "a.md")
      expect(history.map((h) => h.revision)).toEqual([2, 1])
      expect(history[1].content).toBe("# v1")
      store.put({ source: "hub", path: "b.md", content: "# hub" })
      expect(store.list()).toHaveLength(2)
    } finally {
      store.close()
    }
  })

  it("rejects bad input with 400 status codes", () => {
    const store = new DocOverlayStore(":memory:")
    try {
      expect(() => store.put({ source: "adk", path: "../x.md", content: "hi" })).toThrowError()
      try {
        store.put({ source: "bad/../id", path: "a.md", content: "hi" })
        expect.unreachable()
      } catch (err: any) {
        expect(err?.statusCode).toBe(400)
      }
    } finally {
      store.close()
    }
  })
})
