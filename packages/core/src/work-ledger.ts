import fs from "node:fs"
import path from "node:path"
import {
  resolveWorkLedgerLocation,
  safeLedgerName,
  type WorkLedgerConfig,
  type WorkLedgerRoleConfig,
} from "../work-ledger-meta.mjs"

export {
  readWorkLedgerMeta,
  resolveWorkLedgerLocation,
  safeLedgerName,
  ledgerFilePath,
  validateWorkLedgerConfig,
  type WorkLedgerConfig,
  type WorkLedgerRoleConfig,
  type WorkLedgerMeta,
  type WorkLedgerLocationResult,
} from "../work-ledger-meta.mjs"

export type WorkLedgerStatus = "open" | "waiting_human" | "escalated_human" | "done" | "dropped"

export const VALID_WORK_LEDGER_STATUSES = new Set<WorkLedgerStatus>([
  "open",
  "waiting_human",
  "escalated_human",
  "done",
  "dropped",
])

export function isActiveWorkLedgerStatus(status: string): boolean {
  return status === "open" || status === "waiting_human" || status === "escalated_human"
}

export function isTodoWorkLedgerStatus(status: string): boolean {
  return status === "open" || status === "waiting_human"
}

export interface WorkLedgerNormalizedItem {
  id: string
  role: string
  title: string
  status: WorkLedgerStatus
  due: string | null
  dueMs: number | null
  overdue: boolean
  isTodo: boolean
  createdAt: string | null
  checkedAt: string | null
  updatedAt: string | null
  note: string
  channel: string
  msgId: string
  quote: string
  sourceUrl: string | null
  rawResults: string[]
  workerName: string | null
  workerAlive: boolean | null
  hasDrive: boolean
}

export interface WorkLedgerSummary {
  total: number
  todoCount: number
  open: number
  waiting_human: number
  escalated_human: number
  done: number
  dropped: number
  overdue: number
}

export interface LoadedWorkLedgers {
  configured: boolean
  available: boolean
  root: string | null
  dir: string | null
  guildId: string | null
  roles: string[]
  items: WorkLedgerNormalizedItem[]
  summary: WorkLedgerSummary
  warnings: string[]
}

const MAX_LEDGER_FILE_BYTES = 8 * 1024 * 1024

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function validIsoOrNull(value: unknown): { iso: string | null; ms: number | null } {
  if (typeof value !== "string" || !value.trim()) return { iso: null, ms: null }
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return { iso: null, ms: null }
  return { iso: value.trim(), ms }
}

export function hasValidDiscordMessageId(msgId: string): boolean {
  const trimmed = msgId.trim()
  if (!trimmed || trimmed === "-") return false
  if (/^(?:none|null|self)(?:[-:]|$)/i.test(trimmed)) return false
  if (/[\s/\\#?]/.test(trimmed)) return false
  return true
}

export function buildDiscordMessageUrl(
  guildId: string | null | undefined,
  channel: string | null | undefined,
  msgId: string | null | undefined,
  directChannels?: string[],
): string | null {
  const ch = typeof channel === "string" ? channel.trim() : ""
  const mid = typeof msgId === "string" ? msgId.trim() : ""
  if (!ch || /[\s/\\#?]/.test(ch)) return null
  if (!hasValidDiscordMessageId(mid)) return null
  if (Array.isArray(directChannels) && directChannels.includes(ch)) {
    return `https://discord.com/channels/@me/${encodeURIComponent(ch)}/${encodeURIComponent(mid)}`
  }
  const guild = typeof guildId === "string" ? guildId.trim() : ""
  if (!guild || /[\s/\\#?]/.test(guild)) return null
  return `https://discord.com/channels/${encodeURIComponent(guild)}/${encodeURIComponent(ch)}/${encodeURIComponent(mid)}`
}

export function resolveTimeZone(requested?: string | null): string {
  const candidate = typeof requested === "string" && requested.trim() ? requested.trim() : "Asia/Seoul"
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: candidate }).format(0)
    return candidate
  } catch {
    return "Asia/Seoul"
  }
}

export function formatDateInTimeZone(value: number | string | Date | null | undefined, timeZone = "Asia/Seoul"): string | null {
  if (value === null || value === undefined || value === "") return null
  const dt = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(dt.getTime())) return null
  const tz = resolveTimeZone(timeZone)
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(dt)
  const map: Record<string, string> = {}
  for (const part of parts) {
    map[part.type] = part.value
  }
  if (!map.year || !map.month || !map.day) return null
  return `${map.year}-${map.month}-${map.day}`
}

export function sortWorkLedgerItems(items: WorkLedgerNormalizedItem[]): WorkLedgerNormalizedItem[] {
  return [...items].sort((a, b) => {
    const aActive = isActiveWorkLedgerStatus(a.status)
    const bActive = isActiveWorkLedgerStatus(b.status)
    if (aActive !== bActive) return aActive ? -1 : 1
    if (aActive && bActive) {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1
      const aDue = a.dueMs ?? Number.MAX_SAFE_INTEGER
      const bDue = b.dueMs ?? Number.MAX_SAFE_INTEGER
      if (aDue !== bDue) return aDue - bDue
    } else {
      const aDone = Date.parse(a.checkedAt ?? a.due ?? "") || 0
      const bDone = Date.parse(b.checkedAt ?? b.due ?? "") || 0
      if (aDone !== bDone) return bDone - aDone
    }
    const roleCmp = a.role.localeCompare(b.role, "ko")
    if (roleCmp !== 0) return roleCmp
    return a.id.localeCompare(b.id)
  })
}

export function summarizeWorkLedgerItems(items: WorkLedgerNormalizedItem[]): WorkLedgerSummary {
  const summary: WorkLedgerSummary = {
    total: items.length,
    todoCount: 0,
    open: 0,
    waiting_human: 0,
    escalated_human: 0,
    done: 0,
    dropped: 0,
    overdue: 0,
  }
  for (const item of items) {
    if (item.status === "open") summary.open++
    else if (item.status === "waiting_human") summary.waiting_human++
    else if (item.status === "escalated_human") summary.escalated_human++
    else if (item.status === "done") summary.done++
    else if (item.status === "dropped") summary.dropped++
    if (item.isTodo) summary.todoCount++
    if (item.overdue) summary.overdue++
  }
  return summary
}

function collectRawResultCandidates(raw: Record<string, unknown>): string[] {
  const out: string[] = []
  const pushUnique = (v: unknown) => {
    const clean = nonEmpty(v)
    if (clean && !/[\r\n\0]/.test(clean) && !out.includes(clean)) {
      out.push(clean)
    }
  }
  const drive = raw.drive && typeof raw.drive === "object" && !Array.isArray(raw.drive)
    ? (raw.drive as Record<string, unknown>)
    : null
  const closed = drive?.closed && typeof drive.closed === "object" && !Array.isArray(drive.closed)
    ? (drive.closed as Record<string, unknown>)
    : null
  const worker = raw.worker && typeof raw.worker === "object" && !Array.isArray(raw.worker)
    ? (raw.worker as Record<string, unknown>)
    : null

  pushUnique(closed?.result)
  pushUnique(worker?.result)
  pushUnique(raw.result)
  pushUnique(raw.result_path)
  pushUnique(drive?.result_file)
  return out
}

function resolveRoleGuildId(
  roleConfig: WorkLedgerRoleConfig | undefined,
  config: WorkLedgerConfig | null,
  fallbackGuildId: string | null,
): string | null {
  return (
    nonEmpty(roleConfig?.guild_id)
    ?? nonEmpty(roleConfig?.guildId)
    ?? nonEmpty(config?.defaults?.guild_id)
    ?? nonEmpty(config?.defaults?.guildId)
    ?? nonEmpty(config?.guild_id)
    ?? nonEmpty(config?.guildId)
    ?? nonEmpty(config?.provider?.guild_id)
    ?? nonEmpty(config?.provider?.guildId)
    ?? fallbackGuildId
  )
}

function normalizeRoleLedgerItem(
  rawItem: unknown,
  role: string,
  nowMs: number,
  guildId: string | null,
  directChannels?: string[],
): WorkLedgerNormalizedItem | null {
  if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) return null
  const item = rawItem as Record<string, unknown>
  if (typeof item.id !== "string" || !item.id.trim()) return null
  try {
    safeLedgerName(item.id)
  } catch {
    return null
  }
  const rawStatus = typeof item.status === "string" ? item.status : ""
  if (!VALID_WORK_LEDGER_STATUSES.has(rawStatus as WorkLedgerStatus)) return null
  const status = rawStatus as WorkLedgerStatus
  const title = typeof item.title === "string" ? item.title : typeof item.task === "string" ? item.task : item.id
  const { iso: due, ms: dueMs } = validIsoOrNull(item.due)
  const { iso: createdAt } = validIsoOrNull(item.created_at)
  const { iso: checkedAt } = validIsoOrNull(item.checked_at)
  const { iso: updatedAt } = validIsoOrNull(item.updated_at ?? item.checked_at)
  const from = item.from && typeof item.from === "object" && !Array.isArray(item.from)
    ? (item.from as Record<string, unknown>)
    : {}
  const channel = typeof from.channel === "string" ? from.channel.trim() : ""
  const msgId = typeof from.msg_id === "string" ? from.msg_id.trim() : ""
  const quote = typeof from.quote === "string" ? from.quote : ""
  const note = typeof item.note === "string" ? item.note : ""
  const workerObj = item.worker && typeof item.worker === "object" && !Array.isArray(item.worker)
    ? (item.worker as Record<string, unknown>)
    : null
  const workerName = nonEmpty(workerObj?.name)
  const workerAlive = typeof workerObj?.alive === "boolean" ? workerObj.alive : null
  const hasDrive = item.drive !== undefined && item.drive !== null
  const active = isActiveWorkLedgerStatus(status)
  const overdue = active && dueMs !== null && dueMs < nowMs

  return {
    id: item.id,
    role,
    title,
    status,
    due,
    dueMs,
    overdue,
    isTodo: isTodoWorkLedgerStatus(status),
    createdAt,
    checkedAt,
    updatedAt,
    note,
    channel,
    msgId,
    quote,
    sourceUrl: buildDiscordMessageUrl(guildId, channel, msgId, directChannels),
    rawResults: collectRawResultCandidates(item),
    workerName,
    workerAlive,
    hasDrive,
  }
}

export async function loadWorkLedgers(
  adkRoot: string,
  options: {
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>
    now?: number
    exportLocation?: { dir: string; roles: string[]; guildId?: string | null }
  } = {},
): Promise<LoadedWorkLedgers> {
  const nowMs = options.now ?? Date.now()
  const location = options.exportLocation
    ? { configured: true, available: true, root: null, dir: options.exportLocation.dir, guildId: options.exportLocation.guildId ?? null, config: { roles: options.exportLocation.roles.map((role) => ({ role })) }, error: null }
    : await resolveWorkLedgerLocation(adkRoot, options.env)
  const emptySummary = summarizeWorkLedgerItems([])

  if (!location.configured) {
    return {
      configured: false,
      available: false,
      root: null,
      dir: null,
      guildId: null,
      roles: [],
      items: [],
      summary: emptySummary,
      warnings: [],
    }
  }

  if (!location.available || !location.dir) {
    return {
      configured: true,
      available: false,
      root: location.root,
      dir: location.dir,
      guildId: location.guildId,
      roles: [],
      items: [],
      summary: emptySummary,
      warnings: [location.error || "work ledger configuration unavailable"],
    }
  }

  const warnings: string[] = []
  const roleConfigMap = new Map<string, WorkLedgerRoleConfig>()
  const roleSet = new Set<string>()
  for (const rc of location.config?.roles ?? []) {
    try {
      const rName = safeLedgerName(rc.role)
      roleConfigMap.set(rName, rc)
      roleSet.add(rName)
    } catch {
      warnings.push("skipped invalid role in work-ledger config")
    }
  }

  // Discover `<role>.json` files inside ledger dir (supports multi-role instances where
  // work-ledger.json only configures watcher channels for a subset of roles).
  let realLedgerDir = location.dir
  if (fs.existsSync(location.dir) && !options.exportLocation) {
    try {
      realLedgerDir = fs.realpathSync.native(location.dir)
      const dirEntries = fs.readdirSync(realLedgerDir, { withFileTypes: true })
      for (const entry of dirEntries) {
        if (!entry.name.endsWith(".json")) continue
        if (entry.name === "watch-state.json") continue
        if (entry.isSymbolicLink() || !entry.isFile()) continue
        const stem = entry.name.slice(0, -5)
        try {
          safeLedgerName(stem)
          roleSet.add(stem)
        } catch {
          // Ignore non-role JSON filenames
        }
      }
    } catch (err: any) {
      warnings.push(`ledger directory unreadable (${err?.code || "error"})`)
    }
  }

  const items: WorkLedgerNormalizedItem[] = []
  const roles = [...roleSet].sort((a, b) => a.localeCompare(b, "ko"))

  for (const role of roles) {
    const filePath = path.join(realLedgerDir, `${role}.json`)
    if (!fs.existsSync(filePath)) {
      if (options.exportLocation) warnings.push(`${role}: export missing`)
      continue
    }
    try {
      const lstat = fs.lstatSync(filePath)
      if (lstat.isSymbolicLink() || !lstat.isFile()) {
        warnings.push(`${role}: skipped non-regular ledger file`)
        continue
      }
      if (lstat.size > MAX_LEDGER_FILE_BYTES) {
        warnings.push(`${role}: ledger file exceeds size limit`)
        continue
      }
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
        version?: unknown
        role?: unknown
        items?: unknown
      }
      if (!parsed || parsed.version !== 1 || parsed.role !== role || !Array.isArray(parsed.items)) {
        warnings.push(`${role}: invalid ledger schema`)
        continue
      }
      const rc = roleConfigMap.get(role)
      const guildId = resolveRoleGuildId(rc, location.config, location.guildId)
      const directChannels = Array.isArray(rc?.direct_channels) ? rc.direct_channels : undefined
      const seenIds = new Set<string>()
      for (const rawItem of parsed.items) {
        const normalized = normalizeRoleLedgerItem(rawItem, role, nowMs, guildId, directChannels)
        if (!normalized) {
          warnings.push(`${role}: skipped invalid item`)
          continue
        }
        if (seenIds.has(normalized.id)) continue
        seenIds.add(normalized.id)
        items.push(normalized)
      }
    } catch (err: any) {
      warnings.push(`${role}: unreadable (${err?.code || "error"})`)
    }
  }

  const sorted = sortWorkLedgerItems(items)
  return {
    configured: true,
    available: true,
    root: location.root,
    dir: location.dir,
    guildId: location.guildId,
    roles,
    items: sorted,
    summary: summarizeWorkLedgerItems(sorted),
    warnings,
  }
}
