// Unified human-review inbox (single backend source of truth).
//
// Aggregates every active human-action-required item plus the permanent
// completed decision/approval history from:
//   1. messenger approval requests and their approval-code resolutions
//      (pending AND decided approvals are preserved),
//   2. AX document notes where it is the human's turn,
//   3. work-ledger `waiting_human` items,
//   4. publish-review items (extensible slot, wired when present).
//
// Items dedupe strictly by explicit linkage id (`decisionId`: shared
// approval/card/plan id) so the same item is never double-counted. Human
// resolutions append to a permanent JSONL audit log under the workspace state
// dir, so history survives git syncs. Everything instance-specific (role
// names, channels, hosts) lives in the underlying stores or env — this module
// ships zero built-in names.
import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { listNotes, readNote, saveNote } from "./notes.js"
import { queryPortalWorkLedger } from "./work-ledger-portal.js"
import { MessengerStore } from "./messenger-store.js"

export type DecisionKind = "approval" | "note" | "work" | "publish"
export type DecisionStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "acknowledged"
  | "resolved"
  | "expired"
export type DecisionAction = "approve" | "reject" | "acknowledge"

export interface DecisionItem {
  /** Namespaced id: `approval:<messageId>` | `note:<noteId>` | `work:<role>:<itemId>` | `publish:<key>`. */
  id: string
  /** Explicit linkage id used for cross-source dedup. */
  decisionId: string
  kind: DecisionKind
  status: DecisionStatus
  title: string
  detail: string | null
  source: string | null
  path: string | null
  url: string | null
  actor: string | null
  method: string | null
  createdAt: string | null
  updatedAt: string | null
}

export interface DecisionCounts {
  total: number
  approvals: number
  notes: number
  workWaits: number
  publish: number
}

export interface DecisionsSnapshot {
  pending: DecisionItem[]
  history: DecisionItem[]
  counts: DecisionCounts
}

export interface DecisionAuditEntry {
  at: string
  id: string
  decisionId: string
  kind: DecisionKind
  action: DecisionAction
  outcome: DecisionStatus
  actor: string
  via: string
  title: string
  comment: string | null
}

export function decisionsAuditPath(root: string): string {
  return path.join(root, ".agents", "work", "state", "decisions-audit.jsonl")
}

export function messengerDbPath(root: string, env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): string {
  const raw = typeof env.NAIA_MESSENGER_DB === "string" && env.NAIA_MESSENGER_DB.trim()
    ? env.NAIA_MESSENGER_DB.trim()
    : path.join(root, "data-company", "messenger", "messenger.db")
  return path.isAbsolute(raw) ? raw : path.join(root, raw)
}

function fail(message: string, statusCode = 400): never {
  throw Object.assign(new Error(message), { statusCode })
}

function oneLine(text: string, max = 160): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim()
  return flat.length > max ? flat.slice(0, max) + "…" : flat
}

function msToIso(ms: unknown): string | null {
  const n = typeof ms === "number" ? ms : Number(ms)
  if (!Number.isSafeInteger(n) || n <= 0) return null
  try {
    return new Date(n).toISOString()
  } catch {
    return null
  }
}

// --- messenger approvals (pending + decided, preserved) ---------------------

function readApprovalItems(
  root: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): { pending: DecisionItem[]; history: DecisionItem[] } {
  const pending: DecisionItem[] = []
  const history: DecisionItem[] = []
  const dbPath = messengerDbPath(root, env)
  if (!fs.existsSync(dbPath)) return { pending, history }
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(dbPath)
    db.exec("PRAGMA busy_timeout=5000")
    const rows = db.prepare(
      `SELECT a.message_id, a.plan_code, a.step_code, a.status, a.decided_by, a.decided_at,
              m.channel_id, m.author_id, m.author_kind, m.body, m.created_at
       FROM approvals a JOIN messages m ON m.id = a.message_id
       ORDER BY m.id`,
    ).all() as any[]
    for (const row of rows) {
      const body = String(row.body ?? "")
      const titleMatch = body.match(/^1\.\s*제목:\s*(.+)$/m)
      const rawTitle = titleMatch ? titleMatch[1].trim() : body.split("\n").map((l) => l.trim()).find(Boolean) ?? ""
      const item: DecisionItem = {
        id: `approval:${String(row.message_id)}`,
        decisionId: `${String(row.plan_code)}/${String(row.step_code)}`,
        kind: "approval",
        status: row.status === "approved" ? "approved" : row.status === "rejected" ? "rejected" : "pending",
        title: oneLine(rawTitle.replace(/^\[|\]$/g, "")) || `${String(row.plan_code)} ${String(row.step_code)}`,
        detail: `${String(row.plan_code)} ${String(row.step_code)} · ${oneLine(String(row.channel_id ?? ""), 80)}`,
        source: `messenger:${String(row.channel_id ?? "")}`,
        path: null,
        url: null,
        actor: row.decided_by ? String(row.decided_by) : String(row.author_id ?? ""),
        method: "approval-code",
        createdAt: msToIso(row.created_at),
        updatedAt: row.decided_at ? msToIso(row.decided_at) : msToIso(row.created_at),
      }
      if (item.status === "pending") pending.push(item)
      else history.push(item)
    }
  } catch {
    return { pending, history }
  } finally {
    try {
      db?.close()
    } catch {}
  }
  return { pending, history }
}

// --- doc notes ---------------------------------------------------------------

function readNoteItems(root: string): { pending: DecisionItem[]; history: DecisionItem[] } {
  const pending: DecisionItem[] = []
  const history: DecisionItem[] = []
  let notes: ReturnType<typeof listNotes> = []
  try {
    notes = listNotes(root)
  } catch {
    return { pending, history }
  }
  for (const note of notes) {
    const item: DecisionItem = {
      id: `note:${note.id}`,
      decisionId: note.id,
      kind: "note",
      status: note.status === "resolved" ? "resolved" : "pending",
      title: note.quote ? `“${oneLine(note.quote, 100)}”` : oneLine(note.body, 120),
      detail: oneLine(note.body, 240),
      source: note.source,
      path: note.path,
      url: null,
      actor: null,
      method: "memo",
      createdAt: note.createdAt ?? null,
      updatedAt: note.updatedAt ?? null,
    }
    if (item.status === "pending") pending.push(item)
    else history.push(item)
  }
  return { pending, history }
}

// --- work-ledger waiting_human --------------------------------------------------

async function readWorkWaitItems(root: string): Promise<{ pending: DecisionItem[]; history: DecisionItem[] }> {
  const pending: DecisionItem[] = []
  const history: DecisionItem[] = []
  try {
    const res = await queryPortalWorkLedger(root, {})
    for (const item of res.items ?? []) {
      if (item.status !== "waiting_human") continue
      pending.push({
        id: `work:${item.role}:${item.id}`,
        decisionId: `${item.role}:${item.id}`,
        kind: "work",
        status: "pending",
        title: oneLine(item.title, 160) || item.id,
        detail: oneLine(item.note ?? "", 240) || null,
        source: null,
        path: null,
        url: null,
        actor: item.workerName ?? null,
        method: "work-wait",
        createdAt: item.createdAt ?? null,
        updatedAt: item.checkedAt ?? null,
      })
    }
  } catch {
    // Ledger unconfigured: no work waits, not an error.
  }
  return { pending, history }
}

// --- audit log ------------------------------------------------------------------

export function readAuditLog(root: string): DecisionAuditEntry[] {
  const file = decisionsAuditPath(root)
  let raw: string
  try {
    raw = fs.readFileSync(file, "utf-8")
  } catch {
    return []
  }
  const entries: DecisionAuditEntry[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as DecisionAuditEntry
      if (parsed && typeof parsed.id === "string" && typeof parsed.action === "string") entries.push(parsed)
    } catch {}
  }
  return entries
}

function appendAuditLog(root: string, entry: DecisionAuditEntry): void {
  const file = decisionsAuditPath(root)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf-8")
}

function auditOutcomeToHistory(entry: DecisionAuditEntry): DecisionItem {
  return {
    id: entry.id,
    decisionId: entry.decisionId,
    kind: entry.kind,
    status: entry.outcome,
    title: entry.title,
    detail: entry.comment,
    source: null,
    path: null,
    url: null,
    actor: entry.actor,
    method: null,
    createdAt: null,
    updatedAt: entry.at,
  }
}

// --- aggregation ------------------------------------------------------------------

export async function collectDecisions(
  root: string,
  opts: { env?: NodeJS.ProcessEnv | Record<string, string | undefined> } = {},
): Promise<DecisionsSnapshot> {
  const env = opts.env ?? process.env
  const approvals = readApprovalItems(root, env)
  const notes = readNoteItems(root)
  const work = await readWorkWaitItems(root)
  const publish: { pending: DecisionItem[]; history: DecisionItem[] } = { pending: [], history: [] }

  const seen = new Set<string>()
  const pending: DecisionItem[] = []
  // Priority order keeps the richest record when sources overlap on one linkage id.
  for (const item of [...approvals.pending, ...notes.pending, ...work.pending, ...publish.pending]) {
    if (seen.has(item.decisionId)) continue
    seen.add(item.decisionId)
    pending.push(item)
  }

  const history: DecisionItem[] = [...approvals.history, ...notes.history, ...work.history, ...publish.history]
  const historyIds = new Set(history.map((h) => h.id))

  // Audit-only resolutions (acknowledged work waits, publish reviews, ...).
  for (const entry of readAuditLog(root)) {
    if (historyIds.has(entry.id)) continue
    historyIds.add(entry.id)
    history.push(auditOutcomeToHistory(entry))
  }

  // Anything the audit log already resolved drops out of pending.
  const resolvedIds = new Set(readAuditLog(root).map((e) => e.id))
  const open = pending.filter((item) => !resolvedIds.has(item.id))

  const counts: DecisionCounts = {
    total: open.length,
    approvals: open.filter((i) => i.kind === "approval").length,
    notes: open.filter((i) => i.kind === "note").length,
    workWaits: open.filter((i) => i.kind === "work").length,
    publish: open.filter((i) => i.kind === "publish").length,
  }
  return { pending: open, history, counts }
}

// --- resolution ---------------------------------------------------------------------

export interface ResolveOptions {
  action: DecisionAction
  actor?: string
  via?: string
  comment?: string
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>
}

const TERMINAL: Record<DecisionAction, DecisionStatus> = {
  approve: "approved",
  reject: "rejected",
  acknowledge: "acknowledged",
}

function cleanActor(actor: unknown): string {
  const name = typeof actor === "string" ? actor.trim() : ""
  if (!name || name.length > 128 || /[\x00-\x1f\x7f]/.test(name)) return "dashboard"
  return name
}

export async function resolveDecisionItem(
  root: string,
  id: string,
  opts: ResolveOptions,
): Promise<DecisionItem> {
  const { action } = opts
  if (action !== "approve" && action !== "reject" && action !== "acknowledge") fail("Invalid action", 400)
  const outcome = TERMINAL[action]
  const actor = cleanActor(opts.actor)
  const via = typeof opts.via === "string" && opts.via ? opts.via.slice(0, 160) : "dashboard"
  const comment = typeof opts.comment === "string" && opts.comment.trim()
    ? opts.comment.trim().slice(0, 2000)
    : null
  const at = new Date().toISOString()

  if (id.startsWith("approval:")) {
    const messageId = id.slice("approval:".length)
    if (!messageId) fail("Unknown decision item", 404)
    const env = opts.env ?? process.env
    const dbPath = messengerDbPath(root, env)
    if (!fs.existsSync(dbPath)) fail("Messenger unavailable", 503)
    const store = new MessengerStore(dbPath)
    try {
      const before = store.db.prepare("SELECT status, plan_code, step_code FROM approvals WHERE message_id=?").get(messageId) as any
      if (!before) fail("Unknown decision item", 404)
      if (action === "acknowledge") {
        // No approval-code write; the audit log carries the acknowledgement.
      } else if (before.status === "pending") {
        store.decideApproval(messageId, { id: actor, kind: "human" }, action)
      }
      const after = store.db.prepare(
        `SELECT a.status, a.decided_by, a.decided_at, a.plan_code, a.step_code, m.channel_id, m.author_id, m.body, m.created_at
         FROM approvals a JOIN messages m ON m.id = a.message_id WHERE a.message_id=?`,
      ).get(messageId) as any
      const titleMatch = String(after.body ?? "").match(/^1\.\s*제목:\s*(.+)$/m)
      const title = oneLine((titleMatch ? titleMatch[1].trim() : String(after.body ?? "").split("\n").find(Boolean)) || messageId)
      const item: DecisionItem = {
        id,
        decisionId: `${String(after.plan_code)}/${String(after.step_code)}`,
        kind: "approval",
        status: action === "acknowledge" ? "acknowledged" : after.status === "approved" ? "approved" : after.status === "rejected" ? "rejected" : outcome,
        title,
        detail: comment,
        source: `messenger:${String(after.channel_id ?? "")}`,
        path: null,
        url: null,
        actor,
        method: "approval-code",
        createdAt: msToIso(after.created_at),
        updatedAt: after.decided_at ? msToIso(after.decided_at) : at,
      }
      appendAuditLog(root, { at, id, decisionId: item.decisionId, kind: "approval", action, outcome: item.status, actor, via, title, comment })
      return item
    } finally {
      try {
        store.close()
      } catch {}
    }
  }

  if (id.startsWith("note:")) {
    const noteId = id.slice("note:".length)
    const existing = readNote(root, noteId)
    if (!existing) fail("Unknown decision item", 404)
    const updated = {
      ...existing,
      status: "resolved" as const,
      updatedAt: at,
      resolvedAt: existing.resolvedAt ?? at,
      reply: comment ?? existing.reply,
    }
    saveNote(root, updated)
    const item: DecisionItem = {
      id,
      decisionId: existing.id,
      kind: "note",
      status: outcome === "approved" || outcome === "rejected" ? "resolved" : outcome,
      title: existing.quote ? `“${oneLine(existing.quote, 100)}”` : oneLine(existing.body, 120),
      detail: comment,
      source: existing.source,
      path: existing.path,
      url: null,
      actor,
      method: "memo",
      createdAt: existing.createdAt ?? null,
      updatedAt: at,
    }
    appendAuditLog(root, { at, id, decisionId: item.decisionId, kind: "note", action, outcome: item.status, actor, via, title: item.title, comment })
    return item
  }

  if (id.startsWith("work:") || id.startsWith("publish:")) {
    const kind: DecisionKind = id.startsWith("work:") ? "work" : "publish"
    const snapshot = await collectDecisions(root, { env: opts.env })
    const found = snapshot.pending.find((i) => i.id === id)
    if (!found) fail("Unknown decision item", 404)
    const item: DecisionItem = { ...found, status: outcome, detail: comment ?? found.detail, actor, updatedAt: at }
    appendAuditLog(root, { at, id, decisionId: found.decisionId, kind, action, outcome, actor, via, title: found.title, comment })
    return item
  }

  fail("Unknown decision item", 404)
}
