import { describe, it, expect, beforeAll, afterAll } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { createServer } from "../src/server.js"
import { MessengerStore } from "../src/messenger-store.js"

const APPROVAL_BODY = [
  "1. 제목: [승인 요청] 새 문서 발행",
  "2. 요약: 테스트 요약입니다",
  "3. 문서: https://docs.example.test/d/abc123",
  "PLAN-AAAAAA STEP-BBBBBB",
].join("\n")

describe("Portal unified decisions (/api/portal/decisions)", () => {
  const TEST_SECRET = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
  const READ_HEADERS = {
    host: "localhost:3141",
    "x-naia-proxy-secret": TEST_SECRET,
    "x-naia-peer": "127.0.0.1",
    "x-naia-local": "127.0.0.1",
  }
  const WRITE_HEADERS = {
    ...READ_HEADERS,
    "x-naia-origin-ok": "1",
    "content-type": "application/json",
  }

  let tempRoot: string
  let app: Awaited<ReturnType<typeof createServer>>
  let noteId: string
  let approvalMessageId: string
  let secondApprovalMessageId: string

  beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adk-decisions-"))
    fs.mkdirSync(path.join(tempRoot, "docs"), { recursive: true })
    fs.writeFileSync(path.join(tempRoot, "docs", "plan.md"), "# 계획 문서\n", "utf-8")

    // Work ledger with one waiting_human item.
    fs.mkdirSync(path.join(tempRoot, "config"), { recursive: true })
    fs.writeFileSync(
      path.join(tempRoot, "config", "work-ledger.json"),
      JSON.stringify({ version: 1, provider: { type: "discord", guild_id: "1" }, roles: [{ role: "helper" }] }),
    )
    fs.mkdirSync(path.join(tempRoot, ".agents", "work", "ledger"), { recursive: true })
    fs.writeFileSync(
      path.join(tempRoot, ".agents", "work", "ledger", "helper.json"),
      JSON.stringify({
        version: 1,
        role: "helper",
        report: { every_min: 60, channel: "10", last_msg_id: null, last_at: null },
        publication: { max_subagents: 3 },
        items: [
          {
            id: "w1",
            title: "사람 확인 필요",
            from: { channel: "10", msg_id: "11", quote: "" },
            due: null,
            status: "waiting_human",
            worker: null,
            checked_at: null,
            note: "검토 바람",
          },
        ],
      }),
    )

    // Messenger approval (pending) written straight into the store.
    const dbPath = path.join(tempRoot, "data-company", "messenger", "messenger.db")
    const store = new MessengerStore(dbPath)
    try {
      const msg = store.createMessage("업무-요청", { id: "boss", kind: "human" }, APPROVAL_BODY)
      approvalMessageId = msg.id
      const row = store.db.prepare("SELECT status FROM approvals WHERE message_id=?").get(msg.id) as any
      if (!row || row.status !== "pending") throw new Error("approval row missing")
    } finally {
      store.close()
    }

    app = await createServer({ root: tempRoot, port: 3141, host: "127.0.0.1" })
    ;(app as any).proxySecret = TEST_SECRET

    // One open doc note (human's turn).
    const noteRes = await app.inject({
      method: "POST",
      url: "/api/portal/notes",
      headers: WRITE_HEADERS,
      payload: JSON.stringify({ source: "adk", path: "plan.md", body: "방향을 확인해 주세요" }),
    })
    expect(noteRes.statusCode).toBe(201)
    noteId = JSON.parse(noteRes.body).note.id
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })

  it("aggregates approvals, notes, and work waits with counts", async () => {
    const res = await app.inject({ method: "GET", url: "/api/portal/decisions", headers: READ_HEADERS })
    expect(res.statusCode).toBe(200)
    const json = JSON.parse(res.body)
    expect(json.counts).toMatchObject({ total: 3, approvals: 1, notes: 1, workWaits: 1, publish: 0 })
    const ids = json.pending.map((i: any) => i.id)
    expect(ids).toContain(`approval:${approvalMessageId}`)
    expect(ids).toContain(`note:${noteId}`)
    expect(ids).toContain("work:helper:w1")
    expect(json.history).toEqual([])
  })

  it("dedupes by explicit linkage id (same plan/step twice -> one item)", async () => {
    const store = new MessengerStore(path.join(tempRoot, "data-company", "messenger", "messenger.db"))
    try {
      secondApprovalMessageId = store.createMessage("업무-요청", { id: "boss", kind: "human" }, `${APPROVAL_BODY}\n추가 설명`).id
    } finally {
      store.close()
    }
    const res = await app.inject({ method: "GET", url: "/api/portal/decisions", headers: READ_HEADERS })
    const json = JSON.parse(res.body)
    const approvals = json.pending.filter((i: any) => i.kind === "approval")
    expect(approvals).toHaveLength(1)
    expect(json.counts.total).toBe(3)
  })

  it("acknowledging a note moves it to permanent history with an audit trail", async () => {
    const resolve = await app.inject({
      method: "POST",
      url: `/api/portal/decisions/note:${noteId}/resolve`,
      headers: WRITE_HEADERS,
      payload: JSON.stringify({ action: "acknowledge", comment: "확인했습니다" }),
    })
    expect(resolve.statusCode).toBe(200)
    const item = JSON.parse(resolve.body).item
    expect(item.status).toBe("acknowledged")

    const snap = await app.inject({ method: "GET", url: "/api/portal/decisions", headers: READ_HEADERS })
    const json = JSON.parse(snap.body)
    expect(json.pending.map((i: any) => i.id)).not.toContain(`note:${noteId}`)
    expect(json.history.map((i: any) => i.id)).toContain(`note:${noteId}`)
    expect(json.counts).toMatchObject({ total: 2, notes: 0 })

    const audit = fs.readFileSync(path.join(tempRoot, ".agents", "work", "state", "decisions-audit.jsonl"), "utf-8")
    expect(audit).toContain(`note:${noteId}`)
    expect(audit).toContain("acknowledge")
  })

  it("approving a messenger approval writes back and preserves history", async () => {
    const resolve = await app.inject({
      method: "POST",
      url: `/api/portal/decisions/approval:${approvalMessageId}/resolve`,
      headers: WRITE_HEADERS,
      payload: JSON.stringify({ action: "approve" }),
    })
    expect(resolve.statusCode).toBe(200)
    expect(JSON.parse(resolve.body).item.status).toBe("approved")

    const snap = await app.inject({ method: "GET", url: "/api/portal/decisions", headers: READ_HEADERS })
    const json = JSON.parse(snap.body)
    expect(json.pending.map((i: any) => i.id)).not.toContain(`approval:${approvalMessageId}`)
    const hist = json.history.find((i: any) => i.id === `approval:${approvalMessageId}`)
    expect(hist?.status).toBe("approved")
    // The duplicate request for the same plan/step stays pending until resolved itself.
    expect(json.pending.map((i: any) => i.id)).toContain(`approval:${secondApprovalMessageId}`)
    expect(json.counts.approvals).toBe(1)
  })

  it("rejects bad actions, unknown ids, and untrusted writes", async () => {
    const bad = await app.inject({
      method: "POST",
      url: `/api/portal/decisions/note:${noteId}/resolve`,
      headers: WRITE_HEADERS,
      payload: JSON.stringify({ action: "explode" }),
    })
    expect(bad.statusCode).toBe(400)

    const missing = await app.inject({
      method: "POST",
      url: "/api/portal/decisions/note:20990101-000000-abcdef/resolve",
      headers: WRITE_HEADERS,
      payload: JSON.stringify({ action: "acknowledge" }),
    })
    expect(missing.statusCode).toBe(404)

    const untrusted = await app.inject({
      method: "POST",
      url: `/api/portal/decisions/work:helper:w1/resolve`,
      headers: { host: "localhost:3141", "content-type": "application/json" },
      payload: JSON.stringify({ action: "acknowledge" }),
    })
    expect(untrusted.statusCode).toBe(403)
  })
})
