// 나이아 메신저 화면의 모양·규칙(화면 없이 시험하는 부분).
// 서버 약속: packages/server/src/routes/portal-messenger.ts 의 REST·SSE 모양만 믿는다.

export const MESSENGER_API = "/api/portal/messenger"

export type ChannelKind = "channel" | "dm"
export interface Channel {
  id: string
  name: string
  kind: ChannelKind
  unread: number
}

export interface Reaction {
  emoji: string
  count: number
  mine: boolean
}

export interface Attachment {
  id: string
  name: string
  mime?: string
  size?: number
  url?: string
}

export type ApprovalStatus = "pending" | "approved" | "rejected"
export interface Approval {
  plan_code: string
  step_code: string
  status: ApprovalStatus
  decided_by?: string | null
  decided_at?: string | null
}

export interface Message {
  id: string
  channel_id: string
  author_id: string
  author_kind: "human" | "agent"
  /** 사람의 표시 이름. author_id 는 계정 키다. */
  author_name?: string | null
  body: string
  reply_to_id: string | null
  thread_root_id: string | null
  created_at: string
  edited_at?: string | null
  reactions: Reaction[]
  attachments: Attachment[]
  approval: Approval | null
}

export interface MessengerAlert {
  message_id: string
  channel_id?: string
  target_id?: string
  created_at?: string
}

// 아이콘 반응 6종(순서 고정)
export const REACTION_EMOJIS = ["👍", "✅", "👀", "❤️", "🔥", "🎉"] as const

// @부를 수 있는 역할(약속의 깨움 대상). 서버의 NAIA_MESSENGER_ROLES 를 /roles 로 받아 바꾼다.
export interface MentionRole {
  id: string
  label: string
}
export const DEFAULT_MENTION_ROLES: readonly MentionRole[] = [{ id: "naia", label: "나이아" }]
let mentionRoles: readonly MentionRole[] = DEFAULT_MENTION_ROLES

export function getMentionRoles(): readonly MentionRole[] {
  return mentionRoles
}

// 빈 목록이나 모양이 틀린 값은 기본 목록으로 되돌린다.
export function setMentionRoles(roles: unknown): readonly MentionRole[] {
  const list = Array.isArray(roles)
    ? roles
        .filter((r) => r && typeof r.id === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(r.id))
        .map((r) => ({ id: r.id as string, label: typeof r.label === "string" && r.label.trim() ? r.label.trim() : (r.id as string) }))
    : []
  mentionRoles = list.length ? list : DEFAULT_MENTION_ROLES
  return mentionRoles
}

export const CODE_FOLD_LINES = 30
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024
export const ATTACHMENT_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "pdf", "txt", "md", "csv", "json", "zip"]

export const MSG = {
  title: "대화",
  channels: "채널",
  dms: "개인 대화",
  empty: "아직 글이 없습니다. 첫 글을 남겨 보세요.",
  loading: "글을 불러오는 중입니다.",
  loadFailed: "글을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.",
  channelsFailed: "채널 목록을 불러오지 못했습니다.",
  placeholder: (name: string) => `${name}에 글 쓰기`,
  keyHint: "Enter 보내기 · Shift+Enter 줄바꿈 · @ 로 부르기",
  send: "보내기",
  sendFailed: "보내지 못했습니다. 다시 시도해 주세요.",
  attach: "파일 첨부",
  attachTooBig: "25MB 보다 큰 파일은 올릴 수 없습니다.",
  attachBadType: "올릴 수 없는 파일 종류입니다. (사진·PDF·글·표·zip 만)",
  reply: "답글",
  replies: (n: number) => `답글 ${n}개`,
  replyingTo: "답글 쓰는 중",
  cancel: "취소",
  thread: "스레드",
  closePanel: "닫기",
  docPreview: "문서 미리보기",
  docLoading: "문서를 불러오는 중입니다.",
  docFailed: "문서를 열지 못했습니다.",
  openDoc: "문서 화면에서 열기",
  foldShow: (n: number) => `코드 ${n}줄 모두 보기`,
  foldHide: "코드 접기",
  copyTable: "표 복사",
  copied: "복사됨",
  copyFailed: "복사 실패",
  approve: "승인",
  reject: "거절",
  copyCode: "코드 복사",
  approvalPending: "승인 기다림",
  approvalApproved: "승인됨",
  approvalRejected: "거절됨",
  approvalFailed: "처리하지 못했습니다. 다시 시도해 주세요.",
  live: "실시간 연결됨",
  reconnecting: "연결이 끊겨 다시 붙는 중",
  alertTitle: "무응답 알림",
  alertOpen: "글 보기",
  agent: "에이전트",
  backToList: "채널 목록",
} as const

export function messengerUrl(path: string): string {
  return `${MESSENGER_API}${path}`
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as T
}

export function normalizeMessage(raw: Partial<Message> & { id: string }): Message {
  return {
    channel_id: "",
    author_id: "",
    author_kind: "human",
    body: "",
    reply_to_id: null,
    thread_root_id: null,
    created_at: "",
    ...raw,
    reactions: Array.isArray(raw.reactions) ? raw.reactions : [],
    attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
    approval: raw.approval ?? null,
  }
}

export async function loadChannels(fetchFn: typeof fetch = fetch): Promise<Channel[]> {
  const data = await readJson<Channel[] | { channels: Channel[] }>(
    await fetchFn(messengerUrl("/channels"), { cache: "no-store" }),
  )
  const list = Array.isArray(data) ? data : data.channels
  return (list ?? []).map((c) => ({ ...c, unread: Number(c.unread) || 0 }))
}

export async function loadRoles(fetchFn: typeof fetch = fetch): Promise<MentionRole[]> {
  const data = await readJson<{ roles?: MentionRole[] }>(await fetchFn(messengerUrl("/roles"), { cache: "no-store" }))
  return Array.isArray(data?.roles) ? data.roles : []
}

export async function loadMessages(
  channelId: string,
  opts: { before?: string; limit?: number } = {},
  fetchFn: typeof fetch = fetch,
): Promise<Message[]> {
  const q = new URLSearchParams()
  if (opts.before) q.set("before", opts.before)
  q.set("limit", String(opts.limit ?? 50))
  const data = await readJson<{ messages: Message[] }>(
    await fetchFn(messengerUrl(`/channels/${encodeURIComponent(channelId)}/messages?${q}`), { cache: "no-store" }),
  )
  return sortMessages((data.messages ?? []).map(normalizeMessage))
}

// 직접 링크 대상이 최신 페이지 밖이면 대상이 나올 때까지 이전 페이지를 더 부른다(최대 maxPages 번).
// 글 번호는 시간순 문자열이라, 대상보다 옛 글까지 받았는데 없으면 이 채널에 없는 것으로 보고 멈춘다.
export async function loadMessagesThrough(
  channelId: string,
  targetId: string | null,
  opts: { limit: number; maxPages?: number },
  fetchFn: typeof fetch = fetch,
): Promise<{ messages: Message[]; hasMore: boolean; pages: number }> {
  const maxPages = opts.maxPages ?? 20
  let messages = await loadMessages(channelId, { limit: opts.limit }, fetchFn)
  let hasMore = messages.length >= opts.limit
  let pages = 1
  while (
    targetId &&
    hasMore &&
    pages < maxPages &&
    messages[0] &&
    messages[0].id > targetId &&
    !messages.some((m) => m.id === targetId)
  ) {
    const older = await loadMessages(channelId, { before: messages[0].id, limit: opts.limit }, fetchFn)
    for (const m of older) messages = upsertMessage(messages, m)
    hasMore = older.length >= opts.limit
    pages++
  }
  return { messages, hasMore, pages }
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

export async function postMessage(
  channelId: string,
  body: string,
  replyToId: string | null,
  attachmentIds: string[] = [],
  fetchFn: typeof fetch = fetch,
): Promise<Message> {
  const payload: Record<string, unknown> = { body }
  if (replyToId) payload.reply_to_id = replyToId
  if (attachmentIds.length) payload.attachment_ids = attachmentIds
  const data = await readJson<Message>(
    await fetchFn(messengerUrl(`/channels/${encodeURIComponent(channelId)}/messages`), jsonInit("POST", payload)),
  )
  return normalizeMessage(data)
}

export async function toggleReaction(
  messageId: string,
  emoji: string,
  mine: boolean,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const base = messengerUrl(`/messages/${encodeURIComponent(messageId)}/reactions`)
  const res = mine
    ? await fetchFn(`${base}?emoji=${encodeURIComponent(emoji)}`, { method: "DELETE" })
    : await fetchFn(base, jsonInit("POST", { emoji }))
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

export async function markRead(channelId: string, lastMessageId: string, fetchFn: typeof fetch = fetch): Promise<void> {
  await fetchFn(messengerUrl(`/channels/${encodeURIComponent(channelId)}/read`), jsonInit("POST", { last_message_id: lastMessageId }))
}

export async function decideApproval(
  messageId: string,
  decision: "approve" | "reject",
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchFn(messengerUrl(`/approvals/${encodeURIComponent(messageId)}`), jsonInit("POST", { decision }))
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

export async function uploadAttachment(file: File, fetchFn: typeof fetch = fetch): Promise<Attachment> {
  const form = new FormData()
  form.append("file", file, file.name)
  return readJson<Attachment>(await fetchFn(messengerUrl("/attachments"), { method: "POST", body: form }))
}

export async function loadAlerts(fetchFn: typeof fetch = fetch): Promise<MessengerAlert[]> {
  const data = await readJson<MessengerAlert[] | { alerts: MessengerAlert[] }>(
    await fetchFn(messengerUrl("/alerts"), { cache: "no-store" }),
  )
  return (Array.isArray(data) ? data : data.alerts) ?? []
}

export function attachmentHref(a: Attachment): string {
  return a.url || messengerUrl(`/attachments/${encodeURIComponent(a.id)}`)
}

// 올리기 전 화면에서 거르는 것(서버가 다시 거른다).
export function checkAttachment(name: string, size: number): string | null {
  if (size > ATTACHMENT_MAX_BYTES) return MSG.attachTooBig
  const parts = name.toLowerCase().split(".")
  if (parts.length < 2) return MSG.attachBadType
  const ext = parts[parts.length - 1]
  if (!ATTACHMENT_EXTS.includes(ext)) return MSG.attachBadType
  // 이중 확장자(보고서.pdf.exe 같은 것) 앞 조각이 실행형이면 거절
  if (parts.slice(1, -1).some((p) => /^(exe|bat|cmd|com|sh|ps1|js|msi|scr|vbs|jar|docm|xlsm|pptm)$/.test(p))) return MSG.attachBadType
  return null
}

export function formatBytes(size?: number): string {
  if (!size && size !== 0) return ""
  if (size < 1024) return `${size}B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)}KB`
  return `${(size / 1024 / 1024).toFixed(1)}MB`
}

// ULID 는 시간순 문자열이라 id 로도 정렬되지만, 시각을 먼저 본다.
export function sortMessages(list: Message[]): Message[] {
  return [...list].sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1))
}

export function upsertMessage(list: Message[], msg: Message): Message[] {
  const i = list.findIndex((m) => m.id === msg.id)
  if (i < 0) return sortMessages([...list, msg])
  const next = [...list]
  next[i] = { ...next[i], ...msg }
  return next
}

// 스레드: 맨 위 글(thread_root_id 없음)만 본문 목록에 두고 답글은 묶는다.
export function threadRootOf(m: Message): string | null {
  return m.thread_root_id || m.reply_to_id || null
}

export function splitThreads(list: Message[]): { roots: Message[]; replies: Map<string, Message[]> } {
  const ids = new Set(list.map((m) => m.id))
  const roots: Message[] = []
  const replies = new Map<string, Message[]>()
  for (const m of list) {
    const root = threadRootOf(m)
    // 뿌리 글이 이 쪽에 없으면(옛 글) 본문 목록에 그냥 보인다.
    if (root && ids.has(root)) {
      const arr = replies.get(root) ?? []
      arr.push(m)
      replies.set(root, arr)
    } else {
      roots.push(m)
    }
  }
  return { roots, replies }
}

// SSE 이벤트 반영. 서버가 보내는 모양이 약속보다 넓을 수 있어 아는 필드만 쓴다.
export type StreamEventType = "message" | "attachment" | "reaction" | "read" | "approval" | "alert"

export interface MessengerState {
  channels: Channel[]
  messages: Record<string, Message[]>
  alerts: MessengerAlert[]
}

export function applyStreamEvent(
  state: MessengerState,
  type: StreamEventType,
  data: any,
  ctx: { activeChannelId: string | null; viewerId?: string | null },
): { state: MessengerState; refetchChannel?: string; refetchChannels?: boolean } {
  if (!data || typeof data !== "object") return { state }
  if (type === "message") {
    const msg = normalizeMessage(data)
    const list = state.messages[msg.channel_id]
    const known = list?.some((m) => m.id === msg.id)
    const messages = list ? { ...state.messages, [msg.channel_id]: upsertMessage(list, msg) } : state.messages
    // The dashboard viewer is a person; an agent with the same name is someone else.
    const mine = ctx.viewerId && msg.author_id === ctx.viewerId && msg.author_kind !== "agent"
    const channels =
      known || mine || msg.channel_id === ctx.activeChannelId
        ? state.channels
        : state.channels.map((c) => (c.id === msg.channel_id ? { ...c, unread: c.unread + 1 } : c))
    return { state: { ...state, messages, channels } }
  }
  if (type === "attachment") {
    // 이미 받은 글에 첨부가 붙었다는 알림이라 안 읽은 수는 건드리지 않는다.
    const msg = normalizeMessage(data)
    const list = state.messages[msg.channel_id]
    if (!list) return { state }
    return { state: { ...state, messages: { ...state.messages, [msg.channel_id]: upsertMessage(list, msg) } } }
  }
  if (type === "reaction" || type === "approval") {
    const messageId: string | undefined = data.message_id ?? data.id
    if (!messageId) return { state }
    let found: string | null = null
    const messages: Record<string, Message[]> = {}
    for (const [cid, list] of Object.entries(state.messages)) {
      messages[cid] = list.map((m) => {
        if (m.id !== messageId) return m
        found = cid
        if (type === "approval") {
          const approval = data.approval ?? data
          const base: Approval = m.approval ?? { plan_code: "", step_code: "", status: "pending" }
          return { ...m, approval: { ...base, ...pickApproval(approval) } }
        }
        if (Array.isArray(data.reactions)) return { ...m, reactions: data.reactions.map((r: Reaction) => fixMine(r, data, ctx.viewerId)) }
        return { ...m, reactions: applyReactionDelta(m.reactions, data, ctx.viewerId) }
      })
    }
    if (!found) return { state, refetchChannel: data.channel_id === ctx.activeChannelId ? data.channel_id : undefined }
    return { state: { ...state, messages } }
  }
  if (type === "read") {
    // Core sends a reader cursor, not an unread total. Without the viewer identity,
    // another person's cursor must not clear this viewer's unread count.
    if (data.channel_id && (data.unread === undefined || (data.reader_id && !ctx.viewerId))) {
      return { state, refetchChannels: true }
    }
    if (data.channel_id && (!ctx.viewerId || !data.reader_id || (data.reader_id === ctx.viewerId && data.reader_kind !== "agent"))) {
      const channels = state.channels.map((c) => (c.id === data.channel_id ? { ...c, unread: Number(data.unread) || 0 } : c))
      return { state: { ...state, channels } }
    }
    return { state }
  }
  if (type === "alert") {
    if (!data.message_id) return { state }
    if (data.cleared || data.stage === "none") {
      return { state: { ...state, alerts: state.alerts.filter((a) => a.message_id !== data.message_id || (data.target_id && a.target_id !== data.target_id)) } }
    }
    if (state.alerts.some((a) => a.message_id === data.message_id && a.target_id === data.target_id)) return { state }
    return { state: { ...state, alerts: [...state.alerts, data as MessengerAlert] } }
  }
  return { state }
}

function pickApproval(a: any): Partial<Approval> {
  const out: Partial<Approval> = {}
  for (const k of ["plan_code", "step_code", "status", "decided_by", "decided_at"] as const) {
    if (a[k] !== undefined) (out as any)[k] = a[k]
  }
  return out
}

function fixMine(r: Reaction, _data: any, _viewer?: string | null): Reaction {
  return { emoji: r.emoji, count: Number(r.count) || 0, mine: Boolean(r.mine) }
}

// {message_id, emoji, author_id, op:'add'|'remove'} 한 건짜리 이벤트
export function applyReactionDelta(list: Reaction[], data: any, viewerId?: string | null): Reaction[] {
  const emoji: string | undefined = data.emoji
  if (!emoji) return list
  const removing = data.op === "remove" || data.removed === true || data.action === "remove"
  const isMine = Boolean(viewerId && data.author_id === viewerId && data.author_kind !== "agent")
  const next = list.map((r) => ({ ...r }))
  const r = next.find((x) => x.emoji === emoji)
  if (removing) {
    if (!r) return list
    r.count = Math.max(0, r.count - 1)
    if (isMine) r.mine = false
    return next.filter((x) => x.count > 0)
  }
  if (r) {
    if (isMine && r.mine) return list
    r.count += 1
    if (isMine) r.mine = true
    return next
  }
  return [...next, { emoji, count: 1, mine: isMine }]
}

// 내가 누른 반응을 서버 답 전에 화면에 먼저 반영
export function optimisticReaction(list: Reaction[], emoji: string): Reaction[] {
  const r = list.find((x) => x.emoji === emoji)
  if (r?.mine) return applyReactionDelta(list, { emoji, author_id: "__me", op: "remove" }, "__me")
  return applyReactionDelta(list, { emoji, author_id: "__me" }, "__me")
}

// 승인 양식: 본문에서 제목·요약·문서 주소를 꺼낸다(판정은 서버의 approval 줄이 한다).
export interface ApprovalForm {
  title: string
  summary: string
  docUrl: string | null
  code: string | null
}

export function parseApprovalForm(body: string, approval?: Approval | null): ApprovalForm {
  const line = (re: RegExp) => body.match(re)?.[1]?.trim() ?? ""
  const title = line(/1\.\s*제목:\s*(.+)/)
  const summary = line(/2\.\s*요약:\s*([\s\S]*?)(?:\n\s*3\.\s*문서:|$)/)
  // 서버와 같이 첫 "3. 문서:" 줄 하나만 본다(뒷줄이 앞줄 주소를 대신 통과시키지 못하게).
  const docLine = body.match(/3\.\s*문서:[^\r\n]*/)?.[0] ?? ""
  const docUrl = docLine.match(/^3\.\s*문서:\s*(https?:\/\/\S+|\/d\/\S+)/)?.[1] ?? null
  const fromBody = body.match(/PLAN-[A-Z0-9]{6}\s+STEP-[A-Z0-9]{6}/)?.[0] ?? null
  const code = approval?.plan_code && approval?.step_code ? `${approval.plan_code} ${approval.step_code}` : fromBody
  return { title, summary, docUrl, code }
}

// 글 속 /d/<키> 또는 /d/<출처>/<경로> 문서 주소(호스트는 무시)
export interface DocLinkRef {
  href: string
  key: string // "/d/..." 꼴
}

export function findDocLinks(body: string): DocLinkRef[] {
  const out: DocLinkRef[] = []
  const seen = new Set<string>()
  const re = /(https?:\/\/[^\s)<>\]]+)?(\/d\/[A-Za-z0-9._~%\-/]+)/g
  for (const m of body.matchAll(re)) {
    // 앞 글자가 주소 일부(예: /abc/d/..)면 건너뜀
    const start = m.index ?? 0
    if (!m[1] && start > 0 && /[A-Za-z0-9._~%\-/]/.test(body[start - 1])) continue
    const key = docLinkKey(m[0])
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push({ href: m[0], key })
  }
  return out
}

export function docLinkKey(href: string): string | null {
  let path = href
  try {
    if (/^https?:\/\//.test(href)) path = new URL(href).pathname
  } catch {
    return null
  }
  path = path.replace(/[.,;:!?]+$/, "")
  if (!/^\/d\/[^/]+/.test(path)) return null
  if (path.split("/").some((s) => s === "." || s === "..")) return null
  return path
}

// /d/<출처>/<경로> 는 바로 풀고, /d/<키> 는 대시보드 짧은 주소가 넘겨 주는 /docs?source=&path= 에서 푼다.
export function parseDocTargetFromUrl(url: string): { source: string; path: string } | null {
  try {
    const u = new URL(url, "http://local")
    if (u.pathname === "/docs") {
      const source = u.searchParams.get("source")
      const path = u.searchParams.get("path")
      return source && path ? { source, path } : null
    }
    if (u.pathname.startsWith("/d/")) {
      const segs = u.pathname.slice(3).split("/").map(decodeURIComponent)
      if (segs.length >= 2) return { source: segs[0], path: segs.slice(1).join("/") }
    }
  } catch {
    return null
  }
  return null
}

export async function resolveDocLink(
  key: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ source: string; path: string; content: string }> {
  let target = parseDocTargetFromUrl(key)
  if (!target) {
    const res = await fetchFn(key, { redirect: "follow", cache: "no-store" })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    target = parseDocTargetFromUrl(res.url)
    if (!target) throw new Error("not a document")
  }
  const textRes = await fetchFn(
    `/api/portal/text?source=${encodeURIComponent(target.source)}&path=${encodeURIComponent(target.path)}`,
    { cache: "no-store" },
  )
  const data = await readJson<{ content?: string }>(textRes)
  if (typeof data.content !== "string") throw new Error("missing content")
  return { ...target, content: data.content }
}

// 입력창 @역할 자동 완성: 글자 위치 바로 앞의 @조각을 찾는다.
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const m = before.match(/(^|[\s(])@([A-Za-z가-힣]{0,12})$/)
  if (!m) return null
  return { start: caret - m[2].length - 1, query: m[2].toLowerCase() }
}

export function mentionCandidates(query: string) {
  const q = query.toLowerCase()
  return mentionRoles.filter((r) => r.id.startsWith(q) || r.label.startsWith(query))
}

export function applyMention(text: string, start: number, caret: number, roleId: string): { text: string; caret: number } {
  const insert = `@${roleId} `
  const next = text.slice(0, start) + insert + text.slice(caret)
  return { text: next, caret: start + insert.length }
}

// Enter 보내기, Shift+Enter 줄바꿈, 한글 조합 중 Enter 는 무시
export function composerKeyAction(e: { key: string; shiftKey: boolean; isComposing?: boolean; keyCode?: number }): "send" | "newline" | null {
  if (e.key !== "Enter") return null
  if (e.isComposing || e.keyCode === 229) return null
  return e.shiftKey ? "newline" : "send"
}

export function codeLineCount(code: string): number {
  return code.replace(/\n$/, "").split("\n").length
}

export function shouldFoldCode(code: string): boolean {
  return codeLineCount(code) > CODE_FOLD_LINES
}

// 표 복사: 칸은 탭, 줄은 줄바꿈(스프레드시트에 붙이면 표로 들어간다)
export function tableToTsv(rows: string[][]): string {
  return rows.map((r) => r.map((c) => c.replace(/[\t\n]+/g, " ").trim()).join("\t")).join("\n")
}

export function tableElementRows(table: { rows: ArrayLike<{ cells: ArrayLike<{ textContent: string | null }> }> }): string[][] {
  return Array.from(table.rows, (row) => Array.from(row.cells, (cell) => cell.textContent ?? ""))
}

export function authorLabel(id: string): string {
  const role = mentionRoles.find((r) => r.id === id)
  return role ? role.label : id
}

export function messageAuthorLabel(m: Pick<Message, "author_id" | "author_name">): string {
  return m.author_name || authorLabel(m.author_id)
}

export function formatMessageTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  const sameDay = d.toDateString() === now.toDateString()
  return sameDay ? `${hh}:${mm}` : `${d.getMonth() + 1}월 ${d.getDate()}일 ${hh}:${mm}`
}

export function channelLabel(c: Pick<Channel, "name" | "kind">): string {
  return c.kind === "dm" ? authorLabel(c.name) : `# ${c.name}`
}

// /messages/<채널>/<글> 경로
export function parseMessagesPath(segs: string[] | undefined): { channelId: string | null; messageId: string | null } {
  const [c, m] = segs ?? []
  return { channelId: c ? decodeURIComponent(c) : null, messageId: m ? decodeURIComponent(m) : null }
}

export function messagesHref(channelId: string, messageId?: string | null): string {
  return `/messages/${encodeURIComponent(channelId)}${messageId ? `/${encodeURIComponent(messageId)}` : ""}`
}

export function alertText(a: MessengerAlert, channels: Channel[]): string {
  const who = a.target_id ? authorLabel(a.target_id) : "에이전트"
  const ch = channels.find((c) => c.id === a.channel_id)
  return `${ch ? channelLabel(ch) : "대화"} · ${who} 답이 30분째 없습니다`
}

// SSE 다시 붙기 간격(1·2·4·8·15초 상한)
export function reconnectDelay(attempt: number): number {
  return Math.min(15000, 1000 * 2 ** Math.max(0, attempt))
}

// 새로 여는 SSE 주소. 받은 마지막 id 가 있으면 그다음부터, 없으면 서버가 지금부터 보낸다(과거 재생 없음).
export function streamPath(lastEventId: string | null | undefined): string {
  return lastEventId && /^\d+$/.test(lastEventId) ? `/stream?last_event_id=${lastEventId}` : "/stream"
}
