import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { MAX_MEMO_LENGTH as CORE_MEMO, MAX_TITLE_LENGTH as CORE_TITLE } from "@naia-adk/core/src/personal-schedule"
import { handlePersonalScheduleRequest } from "../schedule/personal-schedule"
import { stripUntrustedIdentityHeaders } from "../../identity-header-guard.mjs"
import {
  addToPersonalSchedule,
  draftScheduleFromMessage,
  MAX_MEMO_LENGTH,
  MAX_TITLE_LENGTH,
  PERSONAL_SCHEDULE_PATH,
  ScheduleAddError,
  scheduleWriteBody,
} from "./schedule-from-message"

const msg = (body: string) => ({ id: "m-1", channel_id: "c-1", body })

describe("일정에 넣기: 글에서 초안 뽑기", () => {
  it("첫 줄을 제목으로, 날짜·시각을 본문에서 찾고 메모에 글 주소를 남긴다", () => {
    const d = draftScheduleFromMessage(msg("## **회의** [자료](https://x.test)\n2026-11-20 14:30 회의실"), "2026-11-12")
    assert.equal(d.title, "회의 자료")
    assert.equal(d.date, "2026-11-20")
    assert.equal(d.time, "14:30")
    assert.ok(d.memo.startsWith("메신저 글: /messages/c-1/m-1\n\n## **회의**"))
  })
  it("한국어 날짜·시각(오후 3시 반)과 날짜 없는 글(오늘 종일)", () => {
    const d = draftScheduleFromMessage(msg("점심 약속 11월 14일 오후 3시 반"), "2026-11-12")
    assert.deepEqual([d.date, d.time], ["2026-11-14", "15:30"])
    const plain = draftScheduleFromMessage(msg("그냥 메모"), "2026-11-12")
    assert.deepEqual([plain.date, plain.time], ["2026-11-12", null])
    const code = draftScheduleFromMessage(msg("```\n2030-01-01 10:00\n```\n코드만"), "2026-11-12")
    assert.deepEqual([code.title, code.date, code.time], ["코드만", "2026-11-12", null])
    assert.equal(draftScheduleFromMessage(msg("2026-02-30 날짜 아님"), "2026-11-12").date, "2026-11-12")
  })
  it("제목·메모 길이 한도는 core 개인 일정과 같다", () => {
    assert.deepEqual([MAX_TITLE_LENGTH, MAX_MEMO_LENGTH], [CORE_TITLE, CORE_MEMO])
    const long = draftScheduleFromMessage(msg("가".repeat(500)), "2026-11-12")
    assert.equal(Array.from(long.title).length, CORE_TITLE)
    assert.ok(Array.from(long.memo).length <= CORE_MEMO)
  })
  it("API 몸통: 종일은 날짜만, 시각 일정은 한 시간(같은 날 안), 사용자 칸은 없다", () => {
    const base = { title: "  A ", date: "2026-11-20", memo: "" }
    assert.deepEqual(scheduleWriteBody({ ...base, time: null }), { title: "A", start: "2026-11-20", end: "2026-11-20", allDay: true, memo: "" })
    assert.deepEqual(scheduleWriteBody({ ...base, time: "23:30" }), { title: "A", start: "2026-11-20 23:30", end: "2026-11-20 23:59", allDay: false, memo: "" })
    assert.throws(() => scheduleWriteBody({ ...base, title: " ", time: null }), /제목/)
    assert.throws(() => scheduleWriteBody({ ...base, date: "2026-13-01", time: null }), /날짜/)
    assert.ok(!("user" in scheduleWriteBody({ ...base, time: null })))
  })
})

describe("일정에 넣기: 개인 일정 API 한 번", () => {
  it("GET 으로 받은 개정 값을 If-Match 로 POST 하고, 어긋나면 한 번만 다시 한다", async () => {
    const calls: { method: string; ifMatch: string | null; body: string | null }[] = []
    let revision = 0
    const fake: typeof fetch = async (input, init) => {
      assert.equal(String(input), PERSONAL_SCHEDULE_PATH)
      const headers = new Headers(init?.headers)
      const method = init?.method ?? "GET"
      calls.push({ method, ifMatch: headers.get("if-match"), body: (init?.body as string) ?? null })
      if (method === "GET") return Response.json({ revision: `"r${++revision}"`, items: [{ id: "old", title: "x", start: "2026-11-01" }] })
      if (calls.filter((c) => c.method === "POST").length === 1) return Response.json({ error: "personal-schedule-conflict" }, { status: 409 })
      return Response.json({ items: [{ id: "old", title: "x", start: "2026-11-01" }, { id: "ps-new", title: "A", start: "2026-11-20 10:00" }] }, { status: 201 })
    }
    const result = await addToPersonalSchedule({ title: "A", start: "2026-11-20 10:00", end: "2026-11-20 11:00", allDay: false, memo: "" }, fake)
    assert.deepEqual(result, { id: "ps-new", href: "/schedule?item=personal%3Aps-new&date=2026-11-20" })
    assert.deepEqual(calls.map((c) => `${c.method} ${c.ifMatch ?? "-"}`), ["GET -", 'POST "r1"', "GET -", 'POST "r2"'])
    assert.deepEqual(Object.keys(JSON.parse(calls[1].body!)).sort(), ["allDay", "end", "memo", "start", "title"])
  })
  it("신원이 없으면(403) 쓰지 않고 본인 일정만 된다는 말로 거절한다", async () => {
    let posts = 0
    const fake: typeof fetch = async (_input, init) => {
      if (init?.method === "POST") posts++
      return Response.json({ error: "personal-schedule-identity-required" }, { status: 403 })
    }
    await assert.rejects(
      addToPersonalSchedule({ title: "A", start: "2026-11-20", end: "2026-11-20", allDay: true, memo: "" }, fake),
      (e: unknown) => e instanceof ScheduleAddError && e.code === "personal-schedule-identity-required" && /본인 일정/.test(e.message),
    )
    assert.equal(posts, 0)
  })
})

// 실제 개인 일정 처리기와 신원 가드로: 메신저 계정 머리글(x-ax-account-key)을 일정 신원으로 쓰는 설치를 흉내 낸다.
describe("일정에 넣기: 남의 일정에는 쓰지 못한다", () => {
  const secret = "s".repeat(48)
  function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-msg-"))
    const key = path.join(root, "gate-key")
    fs.writeFileSync(key, secret, { mode: 0o600 })
    const env = { NAIA_GATE_SECRET_FILE: key, NAIA_SCHEDULE_USER_HEADER: "x-ax-account-key" }
    return { root, dir: path.join(root, "data"), env }
  }
  // 브라우저 요청이 대시보드 입구 가드를 지나 처리기에 닿는 길. gateSecret 이 없으면 게이트를 거치지 않은 요청이다.
  function viewerFetch(viewer: string, ctx: ReturnType<typeof setup>, opts: { gateSecret?: string; peer?: string } = {}): typeof fetch {
    return async (input, init) => {
      const raw: Record<string, string> = { host: "localhost", "x-ax-account-key": viewer }
      if (opts.gateSecret) raw["x-naia-gate-secret"] = opts.gateSecret
      new Headers(init?.headers).forEach((v, k) => { raw[k] = v })
      const req = { headers: raw, socket: { remoteAddress: opts.peer ?? "127.0.0.1" } }
      stripUntrustedIdentityHeaders(req, ctx.env)
      const request = new Request(`http://localhost${String(input)}`, { method: init?.method ?? "GET", headers: new Headers(req.headers), body: init?.body })
      return handlePersonalScheduleRequest(request, { env: ctx.env, dir: ctx.dir })
    }
  }

  it("보는 사람 본인 파일에만 들어가고, 몸통에 다른 사용자를 적어도 무시된다", async () => {
    const ctx = setup()
    try {
      const body = { ...scheduleWriteBody({ title: "회의", date: "2026-11-20", time: "10:00", memo: "" }), user: "other" }
      const result = await addToPersonalSchedule(body as ReturnType<typeof scheduleWriteBody>, viewerFetch("viewer", ctx, { gateSecret: secret }))
      assert.ok(result.id)
      assert.ok(fs.existsSync(path.join(ctx.dir, "viewer.yaml")))
      assert.ok(!fs.existsSync(path.join(ctx.dir, "other.yaml")))
      assert.match(fs.readFileSync(path.join(ctx.dir, "viewer.yaml"), "utf8"), /title: "회의"/)
    } finally { fs.rmSync(ctx.root, { recursive: true, force: true }) }
  })

  it("게이트를 거치지 않고 계정 머리글만 꾸민 요청(남의 이름)은 거절되고 파일이 생기지 않는다", async () => {
    const ctx = setup()
    try {
      const body = scheduleWriteBody({ title: "끼워넣기", date: "2026-11-20", time: null, memo: "" })
      for (const opts of [{}, { gateSecret: "w".repeat(48) }, { gateSecret: secret, peer: "203.0.113.9" }]) {
        await assert.rejects(addToPersonalSchedule(body, viewerFetch("other", ctx, opts)), (e: unknown) => e instanceof ScheduleAddError && e.code === "personal-schedule-identity-required")
      }
      assert.ok(!fs.existsSync(path.join(ctx.dir, "other.yaml")))
    } finally { fs.rmSync(ctx.root, { recursive: true, force: true }) }
  })
})
