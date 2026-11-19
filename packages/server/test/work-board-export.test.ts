import { describe, it, expect } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { queryPortalWorkLedger } from "../src/work-ledger-portal.js"

describe("portal work board exports", () => {
  it("uses only configured export files and configured roles", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "board-exports-"))
    try {
      fs.mkdirSync(path.join(root, "config"), { recursive: true })
      fs.mkdirSync(path.join(root, ".agents/work/ledger"), { recursive: true })
      fs.mkdirSync(path.join(root, "exports"))
      const entry = (id: string, overrides = {}) => ({ id, title: id, status: "open", due: "2026-01-01T00:00:00Z", from: { channel: "100", msg_id: "200" }, worker: { name: "w", alive: true }, updated_at: "2026-01-01T01:00:00Z", ...overrides })
      const write = (dir: string, role: string, items: unknown[]) => fs.writeFileSync(path.join(dir, `${role}.json`), JSON.stringify({ version: 1, role, items }))
      write(path.join(root, ".agents/work/ledger"), "one", [entry("private")])
      write(path.join(root, "exports"), "one", [entry("exported")])
      write(path.join(root, "exports"), "unconfigured", [entry("ignored")])
      fs.writeFileSync(path.join(root, "config/work-ledger.json"), JSON.stringify({ roles: [{ role: "one" }] }))
      const withoutBoard = await queryPortalWorkLedger(root, { env: {}, now: Date.parse("2026-01-02T00:00:00Z") })
      expect(withoutBoard.configured).toBe(false)
      expect(withoutBoard.items).toEqual([])
      fs.writeFileSync(path.join(root, "config/work-board.json"), JSON.stringify({ exportDir: "../exports", roles: ["one", "empty"] }))
      const board = await queryPortalWorkLedger(root, { env: {}, now: Date.parse("2026-01-02T00:00:00Z") })
      expect(board.roles).toEqual(["empty", "one"])
      expect(board.items.map((item) => item.id)).toEqual(["exported"])
      expect(board.items[0]).toMatchObject({ overdue: true, updatedAt: "2026-01-01T01:00:00Z", workerName: "w", workerAlive: true })
      expect(board.warnings).toContain("empty: export missing")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
