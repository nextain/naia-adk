import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { isAlias, parseDocument, visit } from "yaml"

export const MAX_PERSONAL_FILE_BYTES = 256 * 1024
export const MAX_TITLE_LENGTH = 200
export const MAX_MEMO_LENGTH = 2000
export const PERSONAL_SCHEDULE_LOCK_STALE_MS = 30_000

const USER_KEY_RE = /^[a-z0-9\uAC00-\uD7A3][a-z0-9._\-\uAC00-\uD7A3]{0,39}$/
const ACTOR_ROLE_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/

export interface PersonalScheduleItem {
  id: string
  title: string
  start: string
  end: string
  allDay: boolean
  memo: string
  beforeMinutes?: number
}
export interface PersonalScheduleInput {
  id?: string
  title: unknown
  start: unknown
  end?: unknown
  allDay?: unknown
  memo?: unknown
  beforeMinutes?: unknown
}
export interface PersonalScheduleDocument {
  user: string
  updatedAt: string | null
  items: PersonalScheduleItem[]
  warnings: string[]
}
export interface ParsedScheduleDateTime {
  normalized: string
  dateOnly: string
  timePart: string | null
  hasTime: boolean
}
export interface PersonalScheduleSnapshot {
  stat: fs.Stats
  bytes: Buffer
}
export interface PersonalScheduleAuditEntry {
  at?: string
  action: "add" | "update" | "delete"
  actorRole: string
  user: string
  itemId: string
}

export class PersonalScheduleConflictError extends Error {
  code = "personal-schedule-conflict"
  status = 409
  constructor(message = "personal-schedule-conflict") {
    super(message)
    this.name = "PersonalScheduleConflictError"
  }
}

export class PersonalScheduleBusyError extends Error {
  code = "personal-schedule-busy"
  status = 409
  constructor(message = "personal-schedule-busy") {
    super(message)
    this.name = "PersonalScheduleBusyError"
  }
}

export class PersonalScheduleUnsafeError extends Error {
  code = "personal-schedule-unsafe"
  status = 500
  constructor(message = "unsafe personal schedule path") {
    super(message)
    this.name = "PersonalScheduleUnsafeError"
  }
}

/** Validates canonical lowercase user key and blocks path traversal characters. */
export function safeUserKey(userKey: unknown): string {
  if (typeof userKey !== "string" || !USER_KEY_RE.test(userKey) || userKey.includes("..")) {
    throw new Error("invalid schedule user key")
  }
  return userKey
}

export function isValidActorRole(role: unknown): role is string {
  return typeof role === "string" && ACTOR_ROLE_RE.test(role) && !role.includes("..")
}

/** The caller authenticates the identity; this function only confines its filename. */
export function getPersonalScheduleFilePath(userKey: string, dir: string): string {
  const safeKey = safeUserKey(userKey)
  const resolvedDir = path.resolve(dir)
  const file = path.join(resolvedDir, `${safeKey}.yaml`)
  if (path.dirname(file) !== resolvedDir || path.basename(file) !== `${safeKey}.yaml`) {
    throw new Error("invalid schedule user key")
  }
  return file
}

export function parseScheduleDateTime(raw: unknown): ParsedScheduleDateTime | null {
  if (typeof raw !== "string") return null
  const match = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/)
  if (!match) return null
  const [, year, month, day, hour, minute, second] = match
  const y = Number(year), m = Number(month), d = Number(day)
  const date = new Date(Date.UTC(y, m - 1, d))
  if (y < 1970 || y > 2100 || date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null
  if (hour !== undefined && (Number(hour) > 23 || Number(minute) > 59 || (second !== undefined && Number(second) > 59))) return null
  const dateOnly = `${year}-${month}-${day}`
  const timePart = hour === undefined ? null : `${hour.padStart(2, "0")}:${minute}`
  return { normalized: timePart ? `${dateOnly} ${timePart}` : dateOnly, dateOnly, timePart, hasTime: timePart !== null }
}

export function isValidScheduleItemId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id.trim()) && !id.includes("..")
}
export function deterministicPersonalScheduleId(title: string, start: string, index: number): string {
  const hash = crypto.createHash("sha256").update(`${title}\n${start}\n${index}`).digest("hex").slice(0, 6)
  return `ps-${start.slice(0, 10).replace(/-/g, "")}-${hash}`
}
export function validateAndNormalizeItem(input: PersonalScheduleInput, fallbackIndex = 0):
  { ok: true; item: PersonalScheduleItem } | { ok: false; error: string } {
  const title = typeof input.title === "string" ? input.title.trim() : ""
  if (!title) return { ok: false, error: "제목을 입력하세요." }
  if (title.length > MAX_TITLE_LENGTH) return { ok: false, error: `제목은 ${MAX_TITLE_LENGTH}자 이하로 입력하세요.` }
  const startDate = parseScheduleDateTime(input.start)
  if (!startDate) return { ok: false, error: "시작 날짜 형식이 올바르지 않습니다." }
  const endDate = input.end === undefined || input.end === null || input.end === "" ? startDate : parseScheduleDateTime(input.end)
  if (!endDate) return { ok: false, error: "끝 날짜 형식이 올바르지 않습니다." }
  let allDay = !startDate.hasTime && !endDate.hasTime
  if (typeof input.allDay === "boolean") allDay = input.allDay
  else if (typeof input.allDay === "string") {
    const value = input.allDay.trim().toLowerCase()
    if (["true", "yes", "1", "예"].includes(value)) allDay = true
    else if (["false", "no", "0", "아니오"].includes(value)) allDay = false
  }
  const start = allDay ? startDate.dateOnly : `${startDate.dateOnly} ${startDate.timePart ?? "09:00"}`
  const candidateEnd = allDay ? endDate.dateOnly : `${endDate.dateOnly} ${endDate.timePart ?? startDate.timePart ?? "09:00"}`
  const end = candidateEnd < start ? start : candidateEnd
  const memo = input.memo === undefined || input.memo === null ? "" : String(input.memo).trim()
  if (memo.length > MAX_MEMO_LENGTH) return { ok: false, error: `메모는 ${MAX_MEMO_LENGTH}자 이하로 입력하세요.` }
  let beforeMinutes: number | undefined
  if (input.beforeMinutes !== undefined && input.beforeMinutes !== null && input.beforeMinutes !== "") {
    let parsedMinutes = NaN
    if (typeof input.beforeMinutes === "number") parsedMinutes = input.beforeMinutes
    else if (typeof input.beforeMinutes === "string" && /^\d+$/.test(input.beforeMinutes.trim())) {
      parsedMinutes = Number(input.beforeMinutes.trim())
    }
    if (!Number.isSafeInteger(parsedMinutes) || parsedMinutes <= 0) {
      return { ok: false, error: "사전 알림 분(beforeMinutes)은 양의 정수여야 합니다." }
    }
    beforeMinutes = parsedMinutes
  }
  const id = isValidScheduleItemId(input.id) ? input.id.trim() : deterministicPersonalScheduleId(title, start, fallbackIndex)
  return {
    ok: true,
    item: { id, title, start, end, allDay, memo, ...(beforeMinutes !== undefined ? { beforeMinutes } : {}) },
  }
}

const fieldNames: Record<string, keyof PersonalScheduleInput> = {
  id: "id", 식별자: "id", title: "title", 제목: "title", 이름: "title",
  start: "start", 시작: "start", startat: "start", startdate: "start",
  end: "end", 끝: "end", 종료: "end", endat: "end", enddate: "end",
  allday: "allDay", all_day: "allDay", 종일: "allDay", 종일여부: "allDay",
  memo: "memo", 메모: "memo", note: "memo", 노트: "memo", description: "memo",
  beforeminutes: "beforeMinutes", before_minutes: "beforeMinutes", "before-minutes": "beforeMinutes",
  사전알림: "beforeMinutes", 알림분: "beforeMinutes",
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Parse supported YAML while reporting anything a subsequent save could lose. */
export function parsePersonalScheduleYaml(text: string, defaultUser: string): PersonalScheduleDocument {
  const result: PersonalScheduleDocument = { user: defaultUser, updatedAt: null, items: [], warnings: [] }
  if (!text.trim()) return result
  const parsed = parseDocument(text, { uniqueKeys: true })
  if (parsed.errors.length || parsed.warnings.length) {
    result.warnings.push(...[...parsed.errors, ...parsed.warnings].map((e) => `YAML: ${e.message}`))
    return result
  }
  let hasComments = Boolean(parsed.comment || parsed.commentBefore)
  visit(parsed, (_key, node) => {
    if (node && typeof node === "object" && (("comment" in node && node.comment) || ("commentBefore" in node && node.commentBefore))) hasComments = true
    if (isAlias(node) || (node && typeof node === "object" && (("anchor" in node && node.anchor) || ("tag" in node && node.tag)))) {
      result.warnings.push("YAML anchors, aliases, and explicit tags cannot be preserved on save.")
    }
  })
  if (hasComments) result.warnings.push("YAML comments cannot be preserved on save.")
  let data: unknown
  try { data = parsed.toJS({ maxAliasCount: 50 }) } catch {
    result.warnings.push("YAML aliases could not be resolved safely.")
    return result
  }
  let items: unknown = data
  if (isRecord(data)) {
    const keys = Object.keys(data)
    for (const key of keys) {
      if (!["user", "사용자", "updatedAt", "updated_at", "items", "항목", "일정"].includes(key)) result.warnings.push(`Unknown top-level field: ${key}`)
    }
    const itemKeys = ["items", "항목", "일정"].filter((key) => Object.hasOwn(data, key))
    if (itemKeys.length > 1) result.warnings.push("Multiple item fields are present.")
    items = itemKeys.length ? data[itemKeys[0]] : []
    if (["user", "사용자"].filter((key) => Object.hasOwn(data, key)).length > 1 || ["updatedAt", "updated_at"].filter((key) => Object.hasOwn(data, key)).length > 1) result.warnings.push("Multiple metadata fields are present.")
    const user = data.user ?? data.사용자
    if (user !== undefined && (typeof user !== "string" || user !== defaultUser)) result.warnings.push("Document user does not match the requested user.")
    const updated = data.updatedAt ?? data.updated_at
    if (updated !== undefined && updated !== null) {
      if (typeof updated === "string") result.updatedAt = updated
      else result.warnings.push("Invalid updatedAt field.")
    }
  }
  if (!Array.isArray(items)) {
    result.warnings.push("Schedule items must be a list.")
    return result
  }
  const ids = new Set<string>()
  items.forEach((entry, index) => {
    if (!isRecord(entry)) { result.warnings.push(`Item ${index + 1} must be an object.`); return }
    const fields: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(entry)) {
      const normalizedKey = key.trim().toLowerCase()
      const field = Object.hasOwn(fieldNames, normalizedKey) ? fieldNames[normalizedKey] : undefined
      if (!field) result.warnings.push(`Item ${index + 1}: unknown field ${key}.`)
      else if (Object.hasOwn(fields, field)) result.warnings.push(`Item ${index + 1}: duplicate field ${field}.`)
      else fields[field] = value
    }
    if (fields.id !== undefined && !isValidScheduleItemId(fields.id)) result.warnings.push(`Item ${index + 1}: invalid ID.`)
    if (fields.allDay !== undefined && typeof fields.allDay !== "boolean" && !(typeof fields.allDay === "string" && ["true", "false", "yes", "no", "1", "0", "예", "아니오"].includes(fields.allDay.trim().toLowerCase()))) result.warnings.push(`Item ${index + 1}: invalid allDay.`)
    if (fields.memo !== undefined && fields.memo !== null && typeof fields.memo !== "string") result.warnings.push(`Item ${index + 1}: memo must be text.`)
    if (typeof fields.beforeMinutes === "string" && /^\d+$/.test(fields.beforeMinutes.trim()) && Number(fields.beforeMinutes.trim()) > 0) {
      result.warnings.push(`Item ${index + 1}: beforeMinutes must be a positive integer.`)
    }
    for (const field of ["id", "title", "memo"] as const) {
      const value = fields[field]
      if (typeof value === "string" && value !== value.trim()) {
        result.warnings.push(`Item ${index + 1}: ${field} whitespace cannot be preserved on save.`)
      }
    }
    const validated = validateAndNormalizeItem(fields as unknown as PersonalScheduleInput, index)
    if (validated.ok === false) { result.warnings.push(`Item ${index + 1}: ${validated.error}`); return }
    const originalStart = parseScheduleDateTime(fields.start)
    const originalEnd = fields.end === undefined || fields.end === null || fields.end === "" ? originalStart : parseScheduleDateTime(fields.end)
    if ([fields.start, fields.end].some((value) => typeof value === "string" && /[ T]\d{1,2}:\d{2}:\d{2}$/.test(value.trim()))) {
      result.warnings.push(`Item ${index + 1}: seconds cannot be preserved on save.`)
    }
    if (validated.item.allDay && (originalStart?.hasTime || originalEnd?.hasTime)) {
      result.warnings.push(`Item ${index + 1}: all-day item contains a time.`)
    }
    if (!validated.item.allDay && (originalStart && !originalStart.hasTime || originalEnd && !originalEnd.hasTime)) {
      result.warnings.push(`Item ${index + 1}: timed item is missing a time.`)
    }
    if (originalStart && originalEnd) {
      const originalStartComparable = validated.item.allDay ? originalStart.dateOnly : `${originalStart.dateOnly} ${originalStart.timePart ?? "09:00"}`
      const originalEndComparable = validated.item.allDay ? originalEnd.dateOnly : `${originalEnd.dateOnly} ${originalEnd.timePart ?? originalStart.timePart ?? "09:00"}`
      if (originalEndComparable < originalStartComparable) result.warnings.push(`Item ${index + 1}: end precedes start.`)
    }
    if (ids.has(validated.item.id)) { result.warnings.push(`Item ${index + 1}: duplicate ID.`); return }
    ids.add(validated.item.id)
    result.items.push(validated.item)
  })
  result.items.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title))
  return result
}

export function serializePersonalScheduleYaml(user: string, items: readonly PersonalScheduleItem[]): string {
  const safeUser = safeUserKey(user)
  const quote = (value: string) => JSON.stringify(value)
  const lines = [`user: ${quote(safeUser)}`, `updatedAt: ${quote(new Date().toISOString())}`, items.length ? "items:" : "items: []"]
  for (const item of items) {
    lines.push(
      `  - id: ${quote(item.id)}`,
      `    title: ${quote(item.title)}`,
      `    start: ${quote(item.start)}`,
      `    end: ${quote(item.end)}`,
      `    allDay: ${item.allDay}`,
      `    memo: ${quote(item.memo)}`,
    )
    if (item.beforeMinutes !== undefined) {
      lines.push(`    beforeMinutes: ${item.beforeMinutes}`)
    }
  }
  return lines.join("\n") + "\n"
}

function sameFileStat(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink
}

function checkNoSymlinkParent(resolvedDir: string): void {
  const parent = path.dirname(resolvedDir)
  if (!parent || parent === resolvedDir || parent === "/" || parent === "/tmp" || parent === "/var") return
  try {
    if (fs.lstatSync(parent).isSymbolicLink()) {
      throw new PersonalScheduleUnsafeError("unsafe personal schedule parent directory")
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

/** Reject symlinked directories and ensure 0o700 permissions when creating/writing. */
export function assertSafePersonalScheduleDir(dir: string, { create = false }: { create?: boolean } = {}): string {
  const resolved = path.resolve(dir)
  checkNoSymlinkParent(resolved)
  let st: fs.Stats | null = null
  try { st = fs.lstatSync(resolved) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  if (st) {
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new PersonalScheduleUnsafeError("unsafe personal schedule directory")
    }
    if (!create) return resolved
    if ((st.mode & 0o777) !== 0o700) fs.chmodSync(resolved, 0o700)
    const verified = fs.lstatSync(resolved)
    if (verified.isSymbolicLink() || !verified.isDirectory() || (verified.mode & 0o777) !== 0o700) {
      throw new PersonalScheduleUnsafeError("unsafe personal schedule directory mode")
    }
    return resolved
  }
  if (!create) return resolved
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 })
  const created = fs.lstatSync(resolved)
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new PersonalScheduleUnsafeError("unsafe personal schedule directory")
  }
  if ((created.mode & 0o777) !== 0o700) fs.chmodSync(resolved, 0o700)
  const verified = fs.lstatSync(resolved)
  if (verified.isSymbolicLink() || !verified.isDirectory() || (verified.mode & 0o777) !== 0o700) {
    throw new PersonalScheduleUnsafeError("unsafe personal schedule directory mode")
  }
  return resolved
}

export function ensurePersonalScheduleDir(dir: string): string {
  return assertSafePersonalScheduleDir(dir, { create: true })
}

/** Read only the requested user's regular, singly linked, bounded file. */
export function readPersonalSchedule(userKey: string, dir: string): PersonalScheduleDocument {
  const file = getPersonalScheduleFilePath(userKey, dir)
  assertSafePersonalScheduleDir(dir, { create: false })
  let before: fs.Stats
  try { before = fs.lstatSync(file) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { user: userKey, updatedAt: null, items: [], warnings: [] }
    throw error
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) throw new PersonalScheduleUnsafeError("unsafe personal schedule file")
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0))
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > MAX_PERSONAL_FILE_BYTES) {
      throw new PersonalScheduleUnsafeError("unsafe personal schedule file")
    }
    const buffer = Buffer.alloc(MAX_PERSONAL_FILE_BYTES + 1)
    let size = 0
    while (size < buffer.length) {
      const bytes = fs.readSync(fd, buffer, size, buffer.length - size, size)
      if (!bytes) break
      size += bytes
    }
    if (size > MAX_PERSONAL_FILE_BYTES) throw new PersonalScheduleUnsafeError("personal schedule file is too large")
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size))
    return parsePersonalScheduleYaml(text, userKey)
  } finally { fs.closeSync(fd) }
}

export function snapshotPersonalSchedule(file: string): PersonalScheduleSnapshot | null {
  let before: fs.Stats
  try { before = fs.lstatSync(file) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.size > MAX_PERSONAL_FILE_BYTES) {
    throw new PersonalScheduleUnsafeError("unsafe schedule file")
  }
  let fd: number
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0)) }
  catch (error) {
    if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new PersonalScheduleConflictError()
    throw error
  }
  try {
    const opened = fs.fstatSync(fd)
    if (!opened.isFile() || !sameFileStat(before, opened)) throw new PersonalScheduleConflictError()
    const buffer = Buffer.alloc(MAX_PERSONAL_FILE_BYTES + 1)
    let size = 0
    while (size < buffer.length) {
      const count = fs.readSync(fd, buffer, size, buffer.length - size, size)
      if (!count) break
      size += count
    }
    if (size > MAX_PERSONAL_FILE_BYTES) throw new PersonalScheduleConflictError()
    const after = fs.fstatSync(fd)
    let current: fs.Stats
    try { current = fs.lstatSync(file) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new PersonalScheduleConflictError()
      throw error
    }
    if (!sameFileStat(opened, after) || !sameFileStat(after, current)) throw new PersonalScheduleConflictError()
    return { stat: after, bytes: buffer.subarray(0, size) }
  } finally { fs.closeSync(fd) }
}

export function assertPersonalScheduleUnchanged(file: string, original: PersonalScheduleSnapshot | null): void {
  let current: PersonalScheduleSnapshot | null
  try { current = snapshotPersonalSchedule(file) }
  catch { throw new PersonalScheduleConflictError() }
  if (original === null && current === null) return
  if (!original || !current || !sameFileStat(original.stat, current.stat) || !original.bytes.equals(current.bytes)) {
    throw new PersonalScheduleConflictError()
  }
}

export function personalScheduleRevision(user: string, snapshot: PersonalScheduleSnapshot | null): string {
  const hash = crypto.createHash("sha256").update("schedule-user:").update(user).update("\0")
  if (!snapshot) hash.update("missing")
  else {
    const s = snapshot.stat
    hash.update(`file:${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:`)
    hash.update(snapshot.bytes)
  }
  return `"${hash.digest("hex")}"`
}

export function readVersionedPersonalSchedule(user: string, dir: string) {
  const safeUser = safeUserKey(user)
  const file = getPersonalScheduleFilePath(safeUser, dir)
  assertSafePersonalScheduleDir(dir, { create: false })
  const original = snapshotPersonalSchedule(file)
  const doc = readPersonalSchedule(safeUser, dir)
  assertPersonalScheduleUnchanged(file, original)
  return { ...doc, userLabel: safeUser, revision: personalScheduleRevision(safeUser, original) }
}

function createLockReleaser(lockPath: string, dev: number, ino: number): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    try {
      const cur = fs.lstatSync(lockPath)
      if (!cur.isSymbolicLink() && cur.isFile() && cur.dev === dev && cur.ino === ino) {
        fs.unlinkSync(lockPath)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
}

function tryOpenExclusiveLock(lockPath: string): () => void {
  const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0)
  const fd = fs.openSync(lockPath, flags, 0o600)
  let stat: fs.Stats | null = null
  try {
    fs.fchmodSync(fd, 0o600)
    stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
      throw new PersonalScheduleUnsafeError("unsafe personal schedule lock file")
    }
    fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`)
    return createLockReleaser(lockPath, stat.dev, stat.ino)
  } catch (error) {
    try {
      const cur = fs.lstatSync(lockPath)
      if (!cur.isSymbolicLink() && (!stat || (cur.dev === stat.dev && cur.ino === stat.ino))) {
        fs.unlinkSync(lockPath)
      }
    } catch {}
    throw error
  } finally {
    fs.closeSync(fd)
  }
}

function reclaimStaleLockIfExpired(lockPath: string, seen: fs.Stats, staleMs: number): boolean {
  const breakPath = `${lockPath}.break`
  let releaseBreak: (() => void) | null = null
  try {
    releaseBreak = tryOpenExclusiveLock(breakPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ELOOP") throw new PersonalScheduleUnsafeError("unsafe lock breaker symlink")
    if (code !== "EEXIST") throw error
    let breakStat: fs.Stats
    try { breakStat = fs.lstatSync(breakPath) }
    catch (statError) {
      if ((statError as NodeJS.ErrnoException).code === "ENOENT") return true
      throw statError
    }
    if (breakStat.isSymbolicLink() || !breakStat.isFile()) {
      throw new PersonalScheduleUnsafeError("unsafe lock breaker file")
    }
    if (Date.now() - breakStat.mtimeMs > staleMs) {
      try { fs.unlinkSync(breakPath) } catch {}
      return true
    }
    return false
  }
  try {
    const cur = fs.lstatSync(lockPath)
    if (cur.isSymbolicLink() || !cur.isFile()) {
      throw new PersonalScheduleUnsafeError("unsafe personal schedule lock file")
    }
    if (cur.dev === seen.dev && cur.ino === seen.ino && cur.mtimeMs === seen.mtimeMs && Date.now() - cur.mtimeMs > staleMs) {
      fs.unlinkSync(lockPath)
      return true
    }
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true
    throw error
  } finally {
    releaseBreak?.()
  }
}

/** Acquire `<user>.yaml.lock` (`O_CREAT|O_EXCL` `0o600`, `O_NOFOLLOW`, 30s stale lock check). */
export function acquirePersonalScheduleLockSync(
  file: string,
  { staleMs = PERSONAL_SCHEDULE_LOCK_STALE_MS }: { staleMs?: number } = {},
): () => void {
  const lockPath = `${file}.lock`
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return tryOpenExclusiveLock(lockPath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ELOOP") throw new PersonalScheduleUnsafeError("unsafe personal schedule lock symlink")
      if (code !== "EEXIST") throw error
      let seen: fs.Stats
      try { seen = fs.lstatSync(lockPath) }
      catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue
        throw statError
      }
      if (seen.isSymbolicLink() || !seen.isFile()) {
        throw new PersonalScheduleUnsafeError("unsafe personal schedule lock file")
      }
      if (Date.now() - seen.mtimeMs <= staleMs) {
        throw new PersonalScheduleBusyError()
      }
      if (!reclaimStaleLockIfExpired(lockPath, seen, staleMs)) {
        throw new PersonalScheduleBusyError()
      }
    }
  }
  throw new PersonalScheduleBusyError()
}

export async function acquirePersonalScheduleLock(
  file: string,
  { staleMs = PERSONAL_SCHEDULE_LOCK_STALE_MS, timeoutMs = 0, retryIntervalMs = 25 }: {
    staleMs?: number
    timeoutMs?: number
    retryIntervalMs?: number
  } = {},
): Promise<() => void> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  for (;;) {
    try {
      return acquirePersonalScheduleLockSync(file, { staleMs })
    } catch (error) {
      if (!(error instanceof PersonalScheduleBusyError) || Date.now() >= deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, retryIntervalMs))
    }
  }
}

export function writePersonalScheduleAtomic(file: string, body: string, original: PersonalScheduleSnapshot | null): void {
  if (Buffer.byteLength(body) > MAX_PERSONAL_FILE_BYTES) throw new Error("schedule too large")
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(12).toString("hex")}.tmp`
  let created = false
  try {
    const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0)
    const fd = fs.openSync(tmp, flags, 0o600)
    created = true
    try {
      fs.fchmodSync(fd, 0o600)
      const st = fs.fstatSync(fd)
      if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o777) !== 0o600) {
        throw new PersonalScheduleUnsafeError("unsafe schedule temp file")
      }
      fs.writeFileSync(fd, body)
      fs.fsyncSync(fd)
    } finally { fs.closeSync(fd) }
    assertPersonalScheduleUnchanged(file, original)
    fs.renameSync(tmp, file)
    created = false
    const finalStat = fs.lstatSync(file)
    if (finalStat.isSymbolicLink() || !finalStat.isFile() || finalStat.nlink !== 1 || (finalStat.mode & 0o777) !== 0o600) {
      throw new PersonalScheduleUnsafeError("unsafe personal schedule file mode")
    }
  } finally {
    if (created) try { fs.unlinkSync(tmp) } catch {}
  }
}

export function assertSafePersonalScheduleAuditLog(dir: string): string {
  const resolved = path.resolve(dir)
  const auditPath = path.join(resolved, ".audit.jsonl")
  try {
    const st = fs.lstatSync(auditPath)
    if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) {
      throw new PersonalScheduleUnsafeError("unsafe personal schedule audit log")
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  return auditPath
}

export function appendPersonalScheduleAuditLog(dir: string, entry: PersonalScheduleAuditEntry): void {
  if (!isValidActorRole(entry.actorRole)) throw new Error("invalid actor role")
  const user = safeUserKey(entry.user)
  if (!isValidScheduleItemId(entry.itemId)) throw new Error("invalid schedule item id")
  const resolved = ensurePersonalScheduleDir(dir)
  const auditPath = assertSafePersonalScheduleAuditLog(resolved)
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0)
  const fd = fs.openSync(auditPath, flags, 0o600)
  try {
    fs.fchmodSync(fd, 0o600)
    const st = fs.fstatSync(fd)
    if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o777) !== 0o600) {
      throw new PersonalScheduleUnsafeError("unsafe personal schedule audit log")
    }
    const line = Buffer.from(
      JSON.stringify({
        at: entry.at ?? new Date().toISOString(),
        action: entry.action,
        actor: `role:${entry.actorRole}`,
        user,
        itemId: entry.itemId,
      }) + "\n",
      "utf8",
    )
    let written = 0
    while (written < line.length) {
      written += fs.writeSync(fd, line, written, line.length - written)
    }
  } finally { fs.closeSync(fd) }
}
