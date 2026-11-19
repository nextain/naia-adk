import { describe, it, expect, beforeAll, afterAll } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { createServer } from "../src/server.js"

describe("Portal work-ledger routes (/api/portal/ledger)", () => {
  const TEST_SECRET = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
  const TRUSTED_HEADERS = {
    host: "localhost:3141",
    "x-naia-proxy-secret": TEST_SECRET,
    "x-naia-peer": "127.0.0.1",
    "x-naia-local": "127.0.0.1",
  }

  let unconfiguredRoot: string
  let configuredRoot: string
  let reportsDir: string
  let appUnconfigured: Awaited<ReturnType<typeof createServer>>
  let appConfigured: Awaited<ReturnType<typeof createServer>>

  beforeAll(async () => {
    unconfiguredRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adk-ledger-unconf-"))
    configuredRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adk-ledger-conf-"))
    reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), "adk-ledger-reports-"))

    // Configured root: docs + view-folders + work-ledger.json + ledgers
    fs.mkdirSync(path.join(configuredRoot, "docs/guides"), { recursive: true })
    fs.writeFileSync(path.join(configuredRoot, "docs/guides/result-doc.md"), "# 결과 보고서\n")

    fs.mkdirSync(path.join(configuredRoot, ".agents/work/ledger"), { recursive: true })
    fs.writeFileSync(path.join(reportsDir, ".naia-view"), "")
    fs.writeFileSync(path.join(reportsDir, "report-r1.md"), "# 외부 폴더 결과\n")
    fs.writeFileSync(
      path.join(configuredRoot, ".agents/work/view-folders.json"),
      JSON.stringify({
        schemaVersion: 1,
        folders: [{ id: "reports", label: "결과 폴더", path: reportsDir, tab: "developer" }],
      }),
    )

    fs.mkdirSync(path.join(configuredRoot, "config"), { recursive: true })
    fs.writeFileSync(
      path.join(configuredRoot, "config/work-ledger.json"),
      JSON.stringify({
        version: 1,
        provider: { type: "discord", guild_id: "999888777" },
        roles: [{ role: "minho" }, { role: "jina" }],
      }),
    )

    fs.writeFileSync(
      path.join(configuredRoot, "config/work-board.json"),
      JSON.stringify({ exportDir: "../.agents/work/ledger", roles: ["minho", "jina"], guildId: "999888777" }),
    )

    fs.writeFileSync(
      path.join(configuredRoot, ".agents/work/ledger/minho.json"),
      JSON.stringify({
        version: 1,
        role: "minho",
        report: { every_min: 60, channel: "100", last_msg_id: null, last_at: null },
        items: [
          {
            id: "m-overdue",
            title: "민호 기한 넘은 카드",
            from: { channel: "100", msg_id: "200", quote: "" },
            due: "2020-01-01T00:00:00Z",
            status: "open",
            worker: { name: "w1", result: "docs/guides/result-doc.md", done_file: "w1.done" },
            checked_at: null,
            note: "긴급",
          },
          {
            id: "m-wait",
            title: "대표님 확인 대기",
            from: { channel: "100", msg_id: "201", quote: "" },
            due: "2035-05-01T16:00:00Z", // 2035-05-02 KST
            status: "waiting_human",
            worker: null,
            checked_at: null,
            note: "",
          },
          {
            id: "m-outside",
            title: "포털 밖 결과물",
            from: { channel: "100", msg_id: "202", quote: "" },
            due: "2025-01-01T00:00:00Z",
            status: "done",
            worker: { name: "w2", result: "/var/private/secret-path/hidden-result.md", done_file: "w2.done" },
            checked_at: "2025-01-01T01:00:00Z",
            note: "",
          },
        ],
      }),
    )

    fs.writeFileSync(
      path.join(configuredRoot, ".agents/work/ledger/jina.json"),
      JSON.stringify({
        version: 1,
        role: "jina",
        report: { every_min: 0, channel: "", last_msg_id: null, last_at: null },
        items: [
          {
            id: "j-data-res",
            title: "지나 뷰폴더 결과 카드",
            from: { channel: "300", msg_id: "400", quote: "" },
            due: "2035-05-01T10:00:00Z", // 2035-05-01 KST
            status: "open",
            worker: { name: "wj", result: path.join(reportsDir, "report-r1.md"), done_file: "wj.done" },
            checked_at: null,
            note: "",
          },
          {
            id: "j-url-res",
            title: "URL 결과 링크 카드",
            from: { channel: "300", msg_id: "401", quote: "" },
            due: "2025-02-01T00:00:00Z",
            status: "dropped",
            worker: {
              name: "wj2",
              result: "https://ax.nextain.io/docs?source=adk&path=guides%2Fresult-doc.md",
              done_file: "wj2.done",
            },
            checked_at: null,
            note: "",
          },
        ],
      }),
    )

    appUnconfigured = await createServer({ root: unconfiguredRoot, port: 3141, host: "127.0.0.1" })
    ;(appUnconfigured as any).proxySecret = TEST_SECRET

    appConfigured = await createServer({ root: configuredRoot, port: 3141, host: "127.0.0.1" })
    ;(appConfigured as any).proxySecret = TEST_SECRET
  })

  afterAll(async () => {
    await appUnconfigured.close()
    await appConfigured.close()
    fs.rmSync(unconfiguredRoot, { recursive: true, force: true })
    fs.rmSync(configuredRoot, { recursive: true, force: true })
    fs.rmSync(reportsDir, { recursive: true, force: true })
  })

  it("rejects untrusted requests and cross-site fetch with 403", async () => {
    const noSecret = await appConfigured.inject({
      method: "GET",
      url: "/api/portal/ledger",
      headers: { host: "localhost:3141" },
    })
    expect(noSecret.statusCode).toBe(403)

    const crossSite = await appConfigured.inject({
      method: "GET",
      url: "/api/portal/ledger?view=due",
      headers: { ...TRUSTED_HEADERS, "sec-fetch-site": "cross-site" },
    })
    expect(crossSite.statusCode).toBe(403)
  })

  it("returns configured: false when server has no work-ledger config", async () => {
    const res = await appUnconfigured.inject({
      method: "GET",
      url: "/api/portal/ledger",
      headers: TRUSTED_HEADERS,
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.configured).toBe(false)
    expect(body.items).toEqual([])
    expect(body.summary.todoCount).toBe(0)
  })

  it("serves sorted ledger items, role filter, discord sourceUrl, and safe portal resultLinks", async () => {
    const res = await appConfigured.inject({
      method: "GET",
      url: "/api/portal/ledger",
      headers: TRUSTED_HEADERS,
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.configured).toBe(true)
    expect(body.roles).toEqual(["jina", "minho"])
    expect(body.summary).toMatchObject({
      total: 5,
      todoCount: 3, // m-overdue(open) + m-wait(waiting_human) + j-data-res(open)
      open: 2,
      waiting_human: 1,
      done: 1,
      dropped: 1,
      overdue: 1,
    })

    // First item must be overdue active item
    expect(body.items[0].id).toBe("m-overdue")
    expect(body.items[0].overdue).toBe(true)
    expect(body.items[0].sourceUrl).toBe("https://discord.com/channels/999888777/100/200")
    expect(body.items[0].resultLinks[0]).toMatchObject({
      kind: "doc",
      source: "adk",
      path: "guides/result-doc.md",
      href: "/docs?tab=developer&source=adk&path=guides%2Fresult-doc.md",
    })

    // Outside server path must not leak directory prefix
    const outsideItem = body.items.find((i: any) => i.id === "m-outside")
    expect(outsideItem.resultLinks[0]).toEqual({
      kind: "unlinked",
      label: "hidden-result.md",
      displayPath: null,
      href: null,
      source: null,
      path: null,
    })
    expect(res.payload).not.toContain("/var/private/secret-path")

    // Role filter
    const jinaRes = await appConfigured.inject({
      method: "GET",
      url: "/api/portal/ledger?role=jina",
      headers: TRUSTED_HEADERS,
    })
    const jinaBody = JSON.parse(jinaRes.payload)
    expect(jinaBody.items.every((i: any) => i.role === "jina")).toBe(true)
    expect(jinaBody.filteredSummary.total).toBe(2)
  })

  it("matches cards linked to a specific document (source + path)", async () => {
    const adkDocRes = await appConfigured.inject({
      method: "GET",
      url: "/api/portal/ledger?source=adk&path=guides/result-doc.md",
      headers: TRUSTED_HEADERS,
    })
    expect(adkDocRes.statusCode).toBe(200)
    const adkDocBody = JSON.parse(adkDocRes.payload)
    expect(adkDocBody.items.map((i: any) => i.id)).toEqual(["m-overdue", "j-url-res"])

    const dataDocRes = await appConfigured.inject({
      method: "GET",
      url: "/api/portal/ledger?source=data:reports&path=report-r1.md",
      headers: TRUSTED_HEADERS,
    })
    const dataDocBody = JSON.parse(dataDocRes.payload)
    expect(dataDocBody.items.map((i: any) => i.id)).toEqual(["j-data-res"])
  })

  it("serves GET /api/portal/ledger?view=due grouped by Asia/Seoul due date", async () => {
    const res = await appConfigured.inject({
      method: "GET",
      url: "/api/portal/ledger?view=due",
      headers: TRUSTED_HEADERS,
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.view).toBe("due")
    expect(body.timezone).toBe("Asia/Seoul")
    expect(Array.isArray(body.dates)).toBe(true)
    const dateKeys = body.dates.map((d: any) => d.date)
    expect(dateKeys).toEqual(["2020-01-01", "2025-01-01", "2025-02-01", "2035-05-01", "2035-05-02"])
    const may2 = body.dates.find((d: any) => d.date === "2035-05-02")
    expect(may2.items.map((i: any) => i.id)).toEqual(["m-wait"])
  })
})
