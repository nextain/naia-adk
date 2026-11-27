import { describe, it, expect } from "vitest"
import { createHash } from "node:crypto"
import { DocOverlayStore, isValidOverlaySource, normalizeOverlayPath, overlayDbPath } from "../src/doc-overlay-store.js"

const sha256 = (text: string) => createHash("sha256").update(text, "utf-8").digest("hex")

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

  it("CAS rejects stale writers and keeps revisions strictly monotonic", () => {
    const store = new DocOverlayStore(":memory:")
    try {
      const v1 = "# v1"
      const first = store.put({ source: "adk", path: "c.md", content: v1, expectedBaseHash: null })
      expect(first.revision).toBe(1)
      // A second writer that never saw the row must not silently overwrite it.
      try {
        store.put({ source: "adk", path: "c.md", content: "# racing", expectedBaseHash: null })
        expect.unreachable()
      } catch (err: any) {
        expect(err?.statusCode).toBe(409)
      }
      // A writer holding a wrong base hash is a conflict too.
      try {
        store.put({ source: "adk", path: "c.md", content: "# stale", expectedBaseHash: sha256("# something else") })
        expect.unreachable()
      } catch (err: any) {
        expect(err?.statusCode).toBe(409)
      }
      const second = store.put({ source: "adk", path: "c.md", content: "# v2", expectedBaseHash: sha256(v1) })
      expect(second.revision).toBe(2)
      // The consumed base hash cannot be reused (lost-update race, sequential view).
      try {
        store.put({ source: "adk", path: "c.md", content: "# v2-dup", expectedBaseHash: sha256(v1) })
        expect.unreachable()
      } catch (err: any) {
        expect(err?.statusCode).toBe(409)
      }
      const history = store.history("adk", "c.md")
      expect(history.map((h) => h.revision)).toEqual([2, 1])
      const revisions = history.map((h) => h.revision)
      expect(new Set(revisions).size).toBe(revisions.length)
      // Empty-string content round-trips through CAS as well.
      const empty = store.put({ source: "adk", path: "e.md", content: "", expectedBaseHash: null })
      expect(empty.revision).toBe(1)
      expect(store.get("adk", "e.md")?.content).toBe("")
      const afterEmpty = store.put({ source: "adk", path: "e.md", content: "# back", expectedBaseHash: sha256("") })
      expect(afterEmpty.revision).toBe(2)
    } finally {
      store.close()
    }
  })

  it("rolls back overlapping commits from surviving history, never stale rows", () => {
    const store = new DocOverlayStore(":memory:")
    try {
      store.put({ source: "adk", path: "o.md", content: "# v0", baseGitSha: "a" })
      store.put({ source: "adk", path: "o.md", content: "# v1", baseGitSha: "a" })
      store.put({ source: "adk", path: "o.md", content: "# v2", baseGitSha: "a" })
      // Rolling back the older commit leaves the newer current row alone.
      store.rollbackRevision("adk", "o.md", 2)
      expect(store.get("adk", "o.md")?.content).toBe("# v2")
      expect(store.get("adk", "o.md")?.revision).toBe(3)
      expect(store.history("adk", "o.md").map((h) => h.revision)).toEqual([3, 1])
      // Rolling back the newer commit restores the latest SURVIVING row (v0),
      // never the already-rolled-back v1 — even when the caller passes it back.
      const staleRow = { source: "adk", path: "o.md", content: "# STALE", updatedAt: "t", updatedBy: "x", baseGitSha: "a", revision: 2 }
      store.rollbackRevision("adk", "o.md", 3, staleRow)
      const cur = store.get("adk", "o.md")
      expect(cur?.content).toBe("# v0")
      expect(cur?.revision).toBe(1)
      expect(store.history("adk", "o.md").map((h) => h.revision)).toEqual([1])
      // Rolling back the last surviving revision deletes the current row:
      // no orphaned current row without history.
      store.rollbackRevision("adk", "o.md", 1)
      expect(store.get("adk", "o.md")).toBeNull()
      expect(store.history("adk", "o.md")).toEqual([])
      expect(store.list()).toEqual([])
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
