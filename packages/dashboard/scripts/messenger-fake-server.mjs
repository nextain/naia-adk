// 메신저 화면 시험용 가짜 API 서버. 약속(packages/server/src/routes/portal-messenger.ts)의 REST·SSE 모양만 흉내 낸다.
// 실행: node scripts/messenger-fake-server.mjs 3241
//   대시보드: NAIA_API_PORT=3241 node server.mjs -p 3242
// 시험 손잡이: POST /__fake/alert {message_id, channel_id, target_id} → SSE alert 이벤트
//              POST /__fake/message {channel_id, author_id, body} → SSE message 이벤트
import http from "node:http"
import { randomUUID } from "node:crypto"

const port = Number(process.argv[2]) || 3241
const T = (min) => new Date(Date.UTC(2026, 10, 8, 2, min)).toISOString()
let seq = 0
const nextId = () => `01JFAKE${String(++seq).padStart(6, "0")}`

const channels = [
  { id: "work-request", name: "업무-요청", kind: "channel" },
  { id: "infra", name: "사내-인프라", kind: "channel" },
  { id: "free", name: "자유", kind: "channel" },
  { id: "dm-coder", name: "coder", kind: "dm" },
  { id: "dm-planner", name: "planner", kind: "dm" },
]
const unread = { infra: 3, "dm-coder": 2 }

const TABLE_BODY = `@coder 이번 주 메신저 일 나눔 표입니다. 확인 부탁드려요.

| 일 | 담당 | 상태 | 마감 |
|---|---|---|---|
| 대화 화면(대시보드) | 코더 | 진행 중 | 11/9 |
| 서버·저장(SQLite) | 플래너 | 진행 중 | 11/9 |
| 깨움·무응답 감시 | 플래너 | 시작 전 | 11/10 |
| 옛 채팅 떼기 | 리뷰어 | 시작 전 | 11/12 |

설계 문서: https://dashboard.example.com/d/a1b2c3`

const CODE_BODY = "깨움 파일 만드는 부분 초안입니다.\n\n```ts\n" +
  Array.from({ length: 36 }, (_, i) => (i === 0 ? "export function wakeFile(role: string, id: string) {" : i === 35 ? "}" : `  const step${i} = prepare(role, id, ${i}) // ${i}번째 줄`)).join("\n") +
  "\n```"

const APPROVAL_BODY = `1. 제목: [배포] 나이아 메신저 1차 대화 화면 올리기
2. 요약: 대시보드에 "대화" 탭을 더하고 외부 채팅 없이 지시·답·승인을 주고받습니다. 운영 관문은 바꾸지 않습니다.
3. 문서: https://dashboard.example.com/d/a1b2c3`

const messages = []
const add = (m) => {
  const msg = {
    id: nextId(), reply_to_id: null, thread_root_id: null, author_kind: "human", reactions: [], attachments: [], approval: null, edited_at: null, ...m,
  }
  messages.push(msg)
  return msg
}
const first = add({ channel_id: "work-request", author_id: "owner", body: "오늘 메신저 1차 화면 보겠습니다. 표·승인·알림 다 볼 수 있게 올려 주세요.", created_at: T(0) })
const tableMsg = add({ channel_id: "work-request", author_id: "owner", body: TABLE_BODY, created_at: T(5), reactions: [{ emoji: "👍", count: 2, mine: true }, { emoji: "👀", count: 1, mine: false }] })
add({ channel_id: "work-request", author_id: "coder", author_kind: "agent", body: "확인했습니다. 화면부터 만들고 캡처 올리겠습니다.", created_at: T(7), reply_to_id: tableMsg.id, thread_root_id: tableMsg.id })
add({ channel_id: "work-request", author_id: "planner", author_kind: "agent", body: "서버는 약속 모양 그대로 맞추겠습니다.", created_at: T(8), reply_to_id: tableMsg.id, thread_root_id: tableMsg.id })
add({ channel_id: "work-request", author_id: "planner", author_kind: "agent", body: CODE_BODY, created_at: T(12), reactions: [{ emoji: "🔥", count: 1, mine: false }] })
const approvalMsg = add({
  channel_id: "work-request", author_id: "coder", author_kind: "agent", body: APPROVAL_BODY, created_at: T(20),
  approval: { plan_code: "PLAN-MSG001", step_code: "STEP-UI0001", status: "pending" },
})
add({ channel_id: "work-request", author_id: "coder", author_kind: "agent", body: "승인 코드는 카드 아래 [코드 복사]로 받으실 수 있습니다.", created_at: T(21) })
add({ channel_id: "infra", author_id: "writer", author_kind: "agent", body: "GPU 서버 디스크 80% 넘었습니다. 오늘 밤 정리하겠습니다.", created_at: T(3) })
add({ channel_id: "free", author_id: "owner", body: "점심 뭐 먹을까요?", created_at: T(1) })
add({ channel_id: "dm-coder", author_id: "coder", author_kind: "agent", body: "대표님, 내일 아침 보고서 /d/a1b2c3 먼저 보시면 됩니다.", created_at: T(15) })

const alerts = []
const clients = new Set()
let eventId = 0

function emit(type, data) {
  const id = ++eventId
  for (const res of clients) res.write(`id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
}

const DOC = `# 나이아 메신저 1차 설계

대시보드 웹 대화창만으로 사람·에이전트가 지시·답·승인을 주고받는다.

## 화면

| 칸 | 내용 |
|---|---|
| 왼쪽 | 채널·개인 대화 목록, 안 읽은 수 |
| 가운데 | 글 목록, 표·코드·답글·반응 |
| 오른쪽 | 스레드·문서 미리보기 |

## 승인

승인 양식 글은 카드로 보이고, 사람만 승인·거절할 수 있다.
`

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  res.end(body === undefined ? "" : JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve({ __raw: raw })
      }
    })
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://fake")
  const p = url.pathname
  const M = "/api/portal/messenger"
  if (p === "/api/portal") return send(res, 200, { sources: [{ id: "adk", name: "ADK", tab: "common" }], board: null, messenger: { enabled: true } })
  if (p === "/api/portal/brand") return send(res, 200, { name: "Naia ADK", logoUrl: null })
  if (p === "/api/portal/text") return send(res, 200, { content: DOC })
  if (p.startsWith("/api/portal/notes")) return send(res, 200, { notes: [], counts: {} })
  if (p === `${M}/roles`) return send(res, 200, { roles: [{ id: "coder", label: "코더" }, { id: "reviewer", label: "리뷰어" }, { id: "naia", label: "나이아" }] })
  if (p === `${M}/channels`) return send(res, 200, channels.map((c) => ({ ...c, unread: unread[c.id] ?? 0 })))
  let m = p.match(/^\/api\/portal\/messenger\/channels\/([^/]+)\/messages$/)
  if (m && req.method === "GET") {
    const id = decodeURIComponent(m[1])
    const list = messages.filter((x) => x.channel_id === id)
    return send(res, 200, { messages: list.slice(-(Number(url.searchParams.get("limit")) || 50)) })
  }
  if (m && req.method === "POST") {
    const body = await readBody(req)
    const msg = add({ channel_id: decodeURIComponent(m[1]), author_id: "owner", body: String(body.body ?? ""), reply_to_id: body.reply_to_id ?? null, thread_root_id: body.reply_to_id ?? null, created_at: new Date().toISOString() })
    emit("message", msg)
    return send(res, 201, msg)
  }
  m = p.match(/^\/api\/portal\/messenger\/channels\/([^/]+)\/read$/)
  if (m) {
    unread[decodeURIComponent(m[1])] = 0
    return send(res, 204)
  }
  m = p.match(/^\/api\/portal\/messenger\/messages\/([^/]+)\/reactions$/)
  if (m) {
    const msg = messages.find((x) => x.id === m[1])
    if (!msg) return send(res, 404, { error: "not found" })
    const emoji = req.method === "DELETE" ? url.searchParams.get("emoji") : (await readBody(req)).emoji
    let r = msg.reactions.find((x) => x.emoji === emoji)
    if (req.method === "DELETE") {
      if (r) { r.count -= 1; r.mine = false }
      msg.reactions = msg.reactions.filter((x) => x.count > 0)
    } else if (!r) msg.reactions.push({ emoji, count: 1, mine: true })
    else if (!r.mine) { r.count += 1; r.mine = true }
    emit("reaction", { message_id: msg.id, channel_id: msg.channel_id, reactions: msg.reactions })
    return send(res, 200, { ok: true })
  }
  m = p.match(/^\/api\/portal\/messenger\/approvals\/([^/]+)$/)
  if (m) {
    const msg = messages.find((x) => x.id === m[1])
    if (!msg?.approval) return send(res, 409, { error: "not an approval" })
    const { decision } = await readBody(req)
    msg.approval = { ...msg.approval, status: decision === "approve" ? "approved" : "rejected", decided_by: "owner", decided_at: new Date().toISOString() }
    emit("approval", { message_id: msg.id, ...msg.approval })
    if (decision === "approve") emit("message", add({ channel_id: msg.channel_id, author_id: "owner", body: `${msg.approval.plan_code} ${msg.approval.step_code}`, created_at: new Date().toISOString() }))
    return send(res, 200, { ok: true })
  }
  if (p === `${M}/attachments` && req.method === "POST") {
    req.resume()
    return send(res, 201, { id: randomUUID(), name: "첨부.txt", mime: "text/plain", size: 12 })
  }
  if (p === `${M}/alerts`) return send(res, 200, alerts)
  if (p === `${M}/stream`) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
    res.write(": hello\n\n")
    clients.add(res)
    const keep = setInterval(() => res.write(": keepalive\n\n"), 15000)
    req.on("close", () => {
      clearInterval(keep)
      clients.delete(res)
    })
    return
  }
  if (p === "/__fake/alert") {
    const body = await readBody(req)
    const a = { message_id: body.message_id ?? first.id, channel_id: body.channel_id ?? "work-request", target_id: body.target_id ?? "coder", created_at: new Date().toISOString() }
    alerts.push(a)
    emit("alert", a)
    return send(res, 200, a)
  }
  if (p === "/__fake/message") {
    const body = await readBody(req)
    const msg = add({ channel_id: body.channel_id ?? "infra", author_id: body.author_id ?? "writer", author_kind: "agent", body: body.body ?? "새 글", created_at: new Date().toISOString() })
    emit("message", msg)
    return send(res, 200, msg)
  }
  if (p === "/__fake/clear-alerts") {
    for (const a of alerts.splice(0)) emit("alert", { message_id: a.message_id, target_id: a.target_id, stage: "none" })
    return send(res, 200, { ok: true })
  }
  if (p === "/__fake/ids") return send(res, 200, { first: first.id, table: tableMsg.id, approval: approvalMsg.id })
  send(res, 404, { error: "not found" })
})

server.listen(port, "127.0.0.1", () => console.log(`messenger fake api on ${port}`))
