import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { loadWorkLedgers, buildDiscordMessageUrl, formatDateInTimeZone } from "../work-ledger.js"

describe("work-ledger core loader", () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "core-work-ledger-"))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it("returns configured: false when neither config/work-ledger.json nor env vars exist", async () => {
    const res = await loadWorkLedgers(tempDir, { env: {} })
    expect(res.configured).toBe(false)
    expect(res.available).toBe(false)
    expect(res.items).toEqual([])
    expect(res.summary.todoCount).toBe(0)
  })

  it("loads configured roles and discovered ledger files, sorts overdue first, and builds Discord URLs", async () => {
    const now = Date.parse("2026-11-18T06:00:00Z")
    fs.mkdirSync(path.join(tempDir, "config"), { recursive: true })
    fs.mkdirSync(path.join(tempDir, ".agents/work/ledger"), { recursive: true })

    fs.writeFileSync(
      path.join(tempDir, "config/work-ledger.json"),
      JSON.stringify({
        version: 1,
        provider: { type: "discord", guild_id: "777888999" },
        roles: [{ role: "minho", direct_channels: ["dm-1"] }],
      }),
    )

    fs.writeFileSync(
      path.join(tempDir, ".agents/work/ledger/minho.json"),
      JSON.stringify({
        version: 1,
        role: "minho",
        report: { every_min: 60, channel: "c1", last_msg_id: null, last_at: null },
        items: [
          {
            id: "upcoming",
            title: "앞으로 할 일",
            from: { channel: "ch-1", msg_id: "111", quote: "" },
            due: "2026-11-18T12:00:00Z",
            status: "open",
            worker: null,
            checked_at: null,
            note: "",
          },
          {
            id: "overdue-minho",
            title: "기한 넘긴 일",
            from: { channel: "dm-1", msg_id: "222", quote: "" },
            due: "2026-11-17T12:00:00Z",
            status: "waiting_human",
            worker: null,
            checked_at: null,
            note: "답변 대기",
          },
          {
            id: "done-item",
            title: "완료된 일",
            from: { channel: "ch-1", msg_id: "self-1", quote: "" },
            due: "2026-11-16T12:00:00Z",
            status: "done",
            worker: { name: "w1", result: "docs/guides/out.md", done_file: "w1.done" },
            result: "https://example.org/reviewed-result",
            checked_at: "2026-11-17T01:00:00Z",
            note: "",
          },
        ],
      }),
    )

    // Role present in ledger directory even when watcher config only lists minho
    fs.writeFileSync(
      path.join(tempDir, ".agents/work/ledger/jina.json"),
      JSON.stringify({
        version: 1,
        role: "jina",
        report: { every_min: 0, channel: "", last_msg_id: null, last_at: null },
        items: [
          {
            id: "overdue-jina",
            title: "지나 긴급 카드",
            from: { channel: "ch-2", msg_id: "333", quote: "" },
            due: "2026-11-16T09:00:00Z",
            status: "open",
            worker: null,
            checked_at: null,
            note: "",
          },
        ],
      }),
    )

    // Non-role state file must be ignored
    fs.writeFileSync(path.join(tempDir, ".agents/work/ledger/watch-state.json"), JSON.stringify({ version: 1 }))

    const res = await loadWorkLedgers(tempDir, { env: {}, now })
    expect(res.configured).toBe(true)
    expect(res.available).toBe(true)
    expect(res.roles).toEqual(["jina", "minho"])
    expect(res.summary).toEqual({
      total: 4,
      todoCount: 3,
      open: 2,
      waiting_human: 1,
      escalated_human: 0,
      done: 1,
      dropped: 0,
      overdue: 2,
      processing: 0,
    })

    // Overdue active items sorted by earliest due first
    expect(res.items.map((i) => i.id)).toEqual(["overdue-jina", "overdue-minho", "upcoming", "done-item"])
    expect(res.items[0].sourceUrl).toBe("https://discord.com/channels/777888999/ch-2/333")
    expect(res.items[1].sourceUrl).toBe("https://discord.com/channels/@me/dm-1/222")
    expect(res.items[3].sourceUrl).toBeNull()
    expect(res.items[3].rawResults).toEqual(["https://example.org/reviewed-result", "docs/guides/out.md"])
  })

  it("supports external kit config via NAIA_WORK_LEDGER_CONFIG + NAIA_WORK_LEDGER_ROOT + NAIA_DISCORD_GUILD_ID", async () => {
    const kitDir = path.join(tempDir, "kit")
    const wsDir = path.join(tempDir, "ws")
    const adkDir = path.join(tempDir, "adk")
    fs.mkdirSync(kitDir, { recursive: true })
    fs.mkdirSync(path.join(wsDir, ".agents/work/ledger"), { recursive: true })
    fs.mkdirSync(adkDir, { recursive: true })

    const kitCfg = path.join(kitDir, "work-ledger.json")
    fs.writeFileSync(kitCfg, JSON.stringify({ version: 1, provider: { type: "discord" }, roles: [{ role: "alpha" }] }))
    fs.writeFileSync(
      path.join(wsDir, ".agents/work/ledger/alpha.json"),
      JSON.stringify({
        version: 1,
        role: "alpha",
        report: { every_min: 0, channel: "", last_msg_id: null, last_at: null },
        items: [
          {
            id: "a1",
            title: "알파 작업",
            from: { channel: "ch-a", msg_id: "9001", quote: "" },
            due: "2026-11-18T00:00:00Z",
            status: "open",
            worker: null,
            checked_at: null,
            note: "",
          },
        ],
      }),
    )

    const res = await loadWorkLedgers(adkDir, {
      env: {
        NAIA_WORK_LEDGER_CONFIG: kitCfg,
        NAIA_WORK_LEDGER_ROOT: wsDir,
        NAIA_DISCORD_GUILD_ID: "445566",
      },
      now: Date.parse("2026-11-18T05:00:00Z"),
    })
    expect(res.configured).toBe(true)
    expect(res.available).toBe(true)
    expect(res.items).toHaveLength(1)
    expect(res.items[0].sourceUrl).toBe("https://discord.com/channels/445566/ch-a/9001")
  })

  it("formats dates in Asia/Seoul correctly across UTC midnight", () => {
    expect(formatDateInTimeZone("2026-11-18T16:00:00Z", "Asia/Seoul")).toBe("2026-11-19")
    expect(formatDateInTimeZone("2026-11-18T14:59:59Z", "Asia/Seoul")).toBe("2026-11-18")
    expect(buildDiscordMessageUrl(null, "123", "456")).toBeNull()
  })

  it("counts processing items (open with worker) and exposes publication.max_subagents", async () => {
    const now = Date.parse("2026-11-18T06:00:00Z")
    fs.mkdirSync(path.join(tempDir, "config"), { recursive: true })
    fs.mkdirSync(path.join(tempDir, ".agents/work/ledger"), { recursive: true })
    fs.writeFileSync(
      path.join(tempDir, "config/work-ledger.json"),
      JSON.stringify({
        version: 1,
        provider: { type: "discord", guild_id: "111" },
        roles: [{ role: "alpha" }],
      }),
    )
    fs.writeFileSync(
      path.join(tempDir, ".agents/work/ledger/alpha.json"),
      JSON.stringify({
        version: 1,
        role: "alpha",
        publication: { max_subagents: 4 },
        items: [
          {
            id: "p1",
            title: "구동 중",
            from: { channel: "c", msg_id: "1", quote: "" },
            due: "2026-11-18T12:00:00Z",
            status: "open",
            worker: { name: "w1" },
            checked_at: null,
            note: "step 1",
          },
          {
            id: "o1",
            title: "대기 단위업무",
            from: { channel: "c", msg_id: "2", quote: "" },
            due: "2026-11-18T12:00:00Z",
            status: "open",
            worker: null,
            checked_at: null,
            note: "",
          },
          {
            id: "d1",
            title: "끝난 구동",
            from: { channel: "c", msg_id: "3", quote: "" },
            due: "2026-11-16T12:00:00Z",
            status: "done",
            worker: { name: "w9" },
            checked_at: "2026-11-17T01:00:00Z",
            note: "",
          },
        ],
      }),
    )
    const res = await loadWorkLedgers(tempDir, { env: {}, now })
    expect(res.summary.processing).toBe(1)
    expect(res.maxSubagents).toBe(4)
  })

  it("ignores non-positive publication.max_subagents (null, no hardcoding)", async () => {
    const now = Date.parse("2026-11-18T06:00:00Z")
    fs.mkdirSync(path.join(tempDir, "config"), { recursive: true })
    fs.mkdirSync(path.join(tempDir, ".agents/work/ledger"), { recursive: true })
    fs.writeFileSync(
      path.join(tempDir, "config/work-ledger.json"),
      JSON.stringify({
        version: 1,
        provider: { type: "discord", guild_id: "111" },
        roles: [{ role: "alpha" }],
      }),
    )
    fs.writeFileSync(
      path.join(tempDir, ".agents/work/ledger/alpha.json"),
      JSON.stringify({
        version: 1,
        role: "alpha",
        publication: { max_subagents: 0 },
        items: [
          {
            id: "o1",
            title: "대기 단위업무",
            from: { channel: "c", msg_id: "1", quote: "" },
            due: "2026-11-18T12:00:00Z",
            status: "open",
            worker: null,
            checked_at: null,
            note: "",
          },
        ],
      }),
    )
    const res = await loadWorkLedgers(tempDir, { env: {}, now })
    expect(res.summary.processing).toBe(0)
    expect(res.maxSubagents).toBeNull()
  })
})
