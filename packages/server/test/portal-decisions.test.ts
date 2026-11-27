import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { createServer } from "../src/server.js"
import { MessengerStore } from "../src/messenger-store.js"
import { backfillMissingApprovalAudits } from "../src/decisions-service.js"

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
  // 로그인 게이트가 확인한 사람 신원(대시보드가 넘기는 표시 + 계정 키).
  const GATE_HEADERS = {
    ...WRITE_HEADERS,
    "x-naia-gate-verified": "1",
    "x-ax-account-key": "reviewer",
  }
  const PUBLIC_HEADERS = {
    ...READ_HEADERS,
    "x-naia-user-email": "staff@example.com",
  }
  const PUBLIC_WRITE_HEADERS = {
    ...PUBLIC_HEADERS,
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

    // One open doc note (agent asked a human: awaiting human).
    const noteRes = await app.inject({
      method: "POST",
      url: "/api/portal/notes",
      headers: WRITE_HEADERS,
      payload: JSON.stringify({ source: "adk", path: "plan.md", body: "방향을 확인해 주세요", awaiting: "human" }),
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
      headers: GATE_HEADERS,
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

  it("public-mode proxy requests never see decisions (403, no leak)", async () => {
    const get = await app.inject({ method: "GET", url: "/api/portal/decisions", headers: PUBLIC_HEADERS })
    expect(get.statusCode).toBe(403)
    expect(get.body).not.toContain("approval:")
    const post = await app.inject({
      method: "POST",
      url: `/api/portal/decisions/approval:${approvalMessageId}/resolve`,
      headers: PUBLIC_WRITE_HEADERS,
      payload: JSON.stringify({ action: "approve" }),
    })
    expect(post.statusCode).toBe(403)
    expect(post.body).not.toContain("approval:")
  })

  it("approval resolve without the verified human gate is rejected", async () => {
    const pendingId = makeApproval("PLAN-CCCCC1", "STEP-DDDDD1")
    const noGate = await app.inject({
      method: "POST",
      url: `/api/portal/decisions/approval:${pendingId}/resolve`,
      headers: WRITE_HEADERS,
      payload: JSON.stringify({ action: "approve" }),
    })
    expect(noGate.statusCode).toBe(401)
    const displayOnly = await app.inject({
      method: "POST",
      url: `/api/portal/decisions/approval:${pendingId}/resolve`,
      headers: { ...WRITE_HEADERS, "x-ax-user": "boss" },
      payload: JSON.stringify({ action: "approve" }),
    })
    expect(displayOnly.statusCode).toBe(401)
    const synthetic = await app.inject({
      method: "POST",
      url: `/api/portal/decisions/approval:${pendingId}/resolve`,
      headers: { ...WRITE_HEADERS, "x-naia-gate-verified": "1", "x-ax-account-key": "dashboard" },
      payload: JSON.stringify({ action: "approve" }),
    })
    expect(synthetic.statusCode).toBe(403)
    const snap = await app.inject({ method: "GET", url: "/api/portal/decisions", headers: READ_HEADERS })
    expect(JSON.parse(snap.body).pending.map((i: any) => i.id)).toContain(`approval:${pendingId}`)
  })

  it("acknowledging a pending approval is rejected and keeps it pending", async () => {
    const pendingId = makeApproval("PLAN-CCCCC2", "STEP-DDDDD2")
    const ack = await app.inject({
      method: "POST",
      url: `/api/portal/decisions/approval:${pendingId}/resolve`,
      headers: GATE_HEADERS,
      payload: JSON.stringify({ action: "acknowledge" }),
    })
    expect(ack.statusCode).toBe(400)
    const snap = await app.inject({ method: "GET", url: "/api/portal/decisions", headers: READ_HEADERS })
    const json = JSON.parse(snap.body)
    expect(json.pending.map((i: any) => i.id)).toContain(`approval:${pendingId}`)
    expect(json.history.map((i: any) => i.id)).not.toContain(`approval:${pendingId}`)
  })

  it("verified resolve emits SSE events and writes permanent audit history", async () => {
    const pendingId = makeApproval("PLAN-CCCCC3", "STEP-DDDDD3")
    const resolve = await app.inject({
      method: "POST",
      url: `/api/portal/decisions/approval:${pendingId}/resolve`,
      headers: GATE_HEADERS,
      payload: JSON.stringify({ action: "approve" }),
    })
    expect(resolve.statusCode).toBe(200)
    expect(JSON.parse(resolve.body).item.actor).toBe("reviewer")
    const store = new MessengerStore(path.join(tempRoot, "data-company", "messenger", "messenger.db"))
    try {
      const types = (store.db.prepare("SELECT type FROM messenger_events ORDER BY id").all() as any[]).map((r) => String(r.type))
      expect(types).toContain("approval")
      expect(types).toContain("message")
    } finally {
      store.close()
    }
    const audit = fs.readFileSync(path.join(tempRoot, ".agents", "work", "state", "decisions-audit.jsonl"), "utf-8")
    expect(audit).toContain(`approval:${pendingId}`)
  })

  it("only human-turn notes count; agent-turn feedback stays out of the inbox", async () => {
    const before = await app.inject({ method: "GET", url: "/api/portal/decisions", headers: READ_HEADERS })
    const notesBefore = JSON.parse(before.body).counts.notes
    // Human-authored feedback (no explicit turn) is the agent's turn: not counted.
    const feedback = await app.inject({
      method: "POST",
      url: "/api/portal/notes",
      headers: WRITE_HEADERS,
      payload: JSON.stringify({ source: "adk", path: "plan.md", body: "방향 좋습니다" }),
    })
    expect(feedback.statusCode).toBe(201)
    expect(JSON.parse(feedback.body).note.awaiting).toBe("agent")
    // Agent-authored question defaults to the human's turn: counted.
    const question = await app.inject({
      method: "POST",
      url: "/api/portal/notes",
      headers: WRITE_HEADERS,
      payload: JSON.stringify({ source: "adk", path: "plan.md", body: "어느 안이 좋을까요", authorKind: "agent" }),
    })
    expect(question.statusCode).toBe(201)
    expect(JSON.parse(question.body).note.awaiting).toBe("human")
    const explicit = await app.inject({
      method: "POST",
      url: "/api/portal/notes",
      headers: WRITE_HEADERS,
      payload: JSON.stringify({ source: "adk", path: "plan.md", body: "사람 확인 요청", awaiting: "human" }),
    })
    expect(explicit.statusCode).toBe(201)
    const bad = await app.inject({
      method: "POST",
      url: "/api/portal/notes",
      headers: WRITE_HEADERS,
      payload: JSON.stringify({ source: "adk", path: "plan.md", body: "x", awaiting: "someone" }),
    })
    expect(bad.statusCode).toBe(400)
    const after = await app.inject({ method: "GET", url: "/api/portal/decisions", headers: READ_HEADERS })
    expect(JSON.parse(after.body).counts.notes).toBe(notesBefore + 2)
    // Flipping the feedback note to the human's turn brings it into the inbox.
    const feedbackId = JSON.parse(feedback.body).note.id
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/portal/notes/${feedbackId}`,
      headers: WRITE_HEADERS,
      payload: JSON.stringify({ awaiting: "human" }),
    })
    expect(patched.statusCode).toBe(200)
    const flipped = await app.inject({ method: "GET", url: "/api/portal/decisions", headers: READ_HEADERS })
    expect(JSON.parse(flipped.body).counts.notes).toBe(notesBefore + 3)
  })

  it("a one-shot post-commit audit failure self-heals on retry/read and survives DB removal", async () => {
    // 독립 루트에서 돌린다: DB 제거가 공용 suite DB의 WAL을 깨지 않게 한다.
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "adk-decisions-heal-"))
    fs.mkdirSync(path.join(root2, "docs"), { recursive: true })
    fs.writeFileSync(path.join(root2, "docs", "plan.md"), "# 계획 문서\n", "utf-8")
    const dbPath = path.join(root2, "data-company", "messenger", "messenger.db")
    const setup = new MessengerStore(dbPath)
    let pendingId: string
    try {
      pendingId = setup.createMessage("업무-요청", { id: "boss", kind: "human" }, APPROVAL_BODY).id
    } finally {
      setup.close()
    }
    const app2 = await createServer({ root: root2, port: 3142, host: "127.0.0.1" })
    ;(app2 as any).proxySecret = TEST_SECRET
    try {
      const auditFile = path.join(root2, ".agents", "work", "state", "decisions-audit.jsonl")
      // 커밋 뒤 감사 쓰기 한 번만 실패시킨다: pre-check(503)는 통과하고 append에서 500.
      const appendSpy = vi.spyOn(fs, "appendFileSync").mockImplementationOnce(() => {
        throw new Error("injected post-commit audit failure")
      })
      try {
        const failed = await app2.inject({
          method: "POST",
          url: `/api/portal/messenger/approvals/${pendingId}`,
          headers: { ...GATE_HEADERS, host: "localhost:3142" },
          payload: JSON.stringify({ decision: "reject" }),
        })
        expect(failed.statusCode).toBe(500)
        expect(JSON.parse(failed.body)).toEqual({ error: "Audit log unavailable" })
      } finally {
        appendSpy.mockRestore()
      }
      // 커밋은 됐지만 감사 기록은 비어 있다.
      const decided = new MessengerStore(dbPath)
      try {
        expect((decided.db.prepare("SELECT status FROM approvals WHERE message_id=?").get(pendingId) as any)?.status).toBe("rejected")
      } finally {
        decided.close()
      }
      expect(fs.readFileSync(auditFile, "utf-8")).not.toContain(`approval:${pendingId}`)
      // 재시도는 409이지만 그 전에 영구 기록을 치유한다.
      const retry = await app2.inject({
        method: "POST",
        url: `/api/portal/messenger/approvals/${pendingId}`,
        headers: { ...GATE_HEADERS, host: "localhost:3142" },
        payload: JSON.stringify({ decision: "reject" }),
      })
      expect(retry.statusCode).toBe(409)
      expect(fs.readFileSync(auditFile, "utf-8")).toContain(`approval:${pendingId}`)
      // 읽기 경로도 치유한다: 다시 읽어도 감사 기록이 유지된다.
      const reread = await app2.inject({ method: "GET", url: "/api/portal/decisions", headers: { ...READ_HEADERS, host: "localhost:3142" } })
      expect(reread.statusCode).toBe(200)
      expect(JSON.parse(reread.body).history.map((i: any) => i.id)).toContain(`approval:${pendingId}`)
      // 메신저 DB를 통째로 치워도 영구 history에 결정이 남는다.
      await app2.close()
      fs.renameSync(dbPath, `${dbPath}.healed`)
      try {
        fs.rmSync(`${dbPath}-wal`, { force: true })
        fs.rmSync(`${dbPath}-shm`, { force: true })
      } catch {}
      const app3 = await createServer({ root: root2, port: 3143, host: "127.0.0.1" })
      ;(app3 as any).proxySecret = TEST_SECRET
      try {
        const snap = await app3.inject({ method: "GET", url: "/api/portal/decisions", headers: { ...READ_HEADERS, host: "localhost:3143" } })
        expect(snap.statusCode).toBe(200)
        const hist = (JSON.parse(snap.body).history as any[]).find((i) => i.id === `approval:${pendingId}`)
        expect(hist?.status).toBe("rejected")
      } finally {
        await app3.close()
      }
    } finally {
      try {
        await app2.close()
      } catch {}
      fs.rmSync(root2, { recursive: true, force: true })
    }
  })

  it("messenger-side resolution stays in history even when its DB is gone", async () => {
    const pendingId = makeApproval("PLAN-CCCCC4", "STEP-DDDDD4")
    const decided = await app.inject({
      method: "POST",
      url: `/api/portal/messenger/approvals/${pendingId}`,
      headers: GATE_HEADERS,
      payload: JSON.stringify({ decision: "reject" }),
    })
    expect(decided.statusCode).toBe(200)
    const audit = fs.readFileSync(path.join(tempRoot, ".agents", "work", "state", "decisions-audit.jsonl"), "utf-8")
    expect(audit).toContain(`approval:${pendingId}`)
    const dbPath = path.join(tempRoot, "data-company", "messenger", "messenger.db")
    fs.renameSync(dbPath, `${dbPath}.gone`)
    try {
      fs.rmSync(`${dbPath}-wal`, { force: true })
      fs.rmSync(`${dbPath}-shm`, { force: true })
    } catch {}
    const snap = await app.inject({ method: "GET", url: "/api/portal/decisions", headers: READ_HEADERS })
    expect(snap.statusCode).toBe(200)
    const json = JSON.parse(snap.body)
    expect(json.pending.map((i: any) => i.id)).not.toContain(`approval:${pendingId}`)
    const hist = json.history.find((i: any) => i.id === `approval:${pendingId}`)
    expect(hist?.status).toBe("rejected")
  })

  it("heals a post-commit audit gap from a configured messenger dbPath on GET-only read", async () => {
    // Custom `createServer({ messenger: { dbPath } })`: no 409 retry at all —
    // one GET must heal the audit, stay at one row, and survive DB removal.
    const root3 = fs.mkdtempSync(path.join(os.tmpdir(), "adk-decisions-customdb-"))
    fs.mkdirSync(path.join(root3, "docs"), { recursive: true })
    fs.writeFileSync(path.join(root3, "docs", "plan.md"), "# 계획 문서\n", "utf-8")
    const customDbPath = path.join(root3, "custom", "msg.db")
    const setup = new MessengerStore(customDbPath)
    let pendingId: string
    try {
      pendingId = setup.createMessage("업무-요청", { id: "boss", kind: "human" }, APPROVAL_BODY).id
    } finally {
      setup.close()
    }
    const app3 = await createServer({ root: root3, port: 3144, host: "127.0.0.1", messenger: { dbPath: customDbPath } })
    ;(app3 as any).proxySecret = TEST_SECRET
    try {
      const auditFile = path.join(root3, ".agents", "work", "state", "decisions-audit.jsonl")
      const appendSpy = vi.spyOn(fs, "appendFileSync").mockImplementationOnce(() => {
        throw new Error("injected post-commit audit failure")
      })
      try {
        const failed = await app3.inject({
          method: "POST",
          url: `/api/portal/messenger/approvals/${pendingId}`,
          headers: { ...GATE_HEADERS, host: "localhost:3144" },
          payload: JSON.stringify({ decision: "approve" }),
        })
        expect(failed.statusCode).toBe(500)
        expect(JSON.parse(failed.body)).toEqual({ error: "Audit log unavailable" })
      } finally {
        appendSpy.mockRestore()
      }
      const decided = new MessengerStore(customDbPath)
      try {
        expect((decided.db.prepare("SELECT status FROM approvals WHERE message_id=?").get(pendingId) as any)?.status).toBe("approved")
      } finally {
        decided.close()
      }
      expect(fs.readFileSync(auditFile, "utf-8")).not.toContain(`approval:${pendingId}`)
      // GET-only healing: no 409 retry happens before this read.
      const first = await app3.inject({ method: "GET", url: "/api/portal/decisions", headers: { ...READ_HEADERS, host: "localhost:3144" } })
      expect(first.statusCode).toBe(200)
      expect(JSON.parse(first.body).history.map((i: any) => i.id)).toContain(`approval:${pendingId}`)
      expect(fs.readFileSync(auditFile, "utf-8").split("\n").filter((l) => l.trim())).toHaveLength(1)
      // A second GET stays at exactly one row (no duplicate append).
      const second = await app3.inject({ method: "GET", url: "/api/portal/decisions", headers: { ...READ_HEADERS, host: "localhost:3144" } })
      expect(second.statusCode).toBe(200)
      expect(fs.readFileSync(auditFile, "utf-8").split("\n").filter((l) => l.trim())).toHaveLength(1)
      // Removing the custom DB keeps the decision in permanent history.
      await app3.close()
      fs.rmSync(customDbPath, { force: true })
      try {
        fs.rmSync(`${customDbPath}-wal`, { force: true })
        fs.rmSync(`${customDbPath}-shm`, { force: true })
      } catch {}
      const app4 = await createServer({ root: root3, port: 3145, host: "127.0.0.1", messenger: { dbPath: customDbPath } })
      ;(app4 as any).proxySecret = TEST_SECRET
      try {
        const snap = await app4.inject({ method: "GET", url: "/api/portal/decisions", headers: { ...READ_HEADERS, host: "localhost:3145" } })
        expect(snap.statusCode).toBe(200)
        const hist = (JSON.parse(snap.body).history as any[]).find((i) => i.id === `approval:${pendingId}`)
        expect(hist?.status).toBe("approved")
      } finally {
        await app4.close()
      }
    } finally {
      try {
        await app3.close()
      } catch {}
      fs.rmSync(root3, { recursive: true, force: true })
    }
  })

  it("concurrent backfills append exactly one audit line per decision", async () => {
    const rootC = fs.mkdtempSync(path.join(os.tmpdir(), "adk-decisions-race-"))
    fs.mkdirSync(path.join(rootC, "docs"), { recursive: true })
    fs.writeFileSync(path.join(rootC, "docs", "plan.md"), "# 계획 문서\n", "utf-8")
    const customDbPath = path.join(rootC, "custom", "msg.db")
    const setup = new MessengerStore(customDbPath)
    let pendingId: string
    try {
      pendingId = setup.createMessage("업무-요청", { id: "boss", kind: "human" }, APPROVAL_BODY).id
      setup.decideApproval(pendingId, { id: "boss", kind: "human" }, "approve")
    } finally {
      setup.close()
    }
    const results = await Promise.all(
      Array.from({ length: 8 }, () => backfillMissingApprovalAudits(rootC, process.env, customDbPath)),
    )
    expect(results.reduce((sum, n) => sum + n, 0)).toBe(1)
    const lines = fs.readFileSync(path.join(rootC, ".agents", "work", "state", "decisions-audit.jsonl"), "utf-8")
      .split("\n")
      .filter((l) => l.trim())
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`approval:${pendingId}`)
    fs.rmSync(rootC, { recursive: true, force: true })
  })

  function makeApproval(plan: string, step: string): string {
    const store = new MessengerStore(path.join(tempRoot, "data-company", "messenger", "messenger.db"))
    try {
      return store.createMessage(
        "업무-요청",
        { id: "boss", kind: "human" },
        ["1. 제목: [승인 요청] 새 문서 발행", "2. 요약: 테스트 요약입니다", "3. 문서: https://docs.example.test/d/abc123", `${plan} ${step}`].join("\n"),
      ).id
    } finally {
      store.close()
    }
  }
})
