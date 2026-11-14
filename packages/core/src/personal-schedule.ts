import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { isAlias, parseDocument, visit } from "yaml"

export const MAX_PERSONAL_FILE_BYTES = 256 * 1024
export const MAX_TITLE_LENGTH = 200
export const MAX_MEMO_LENGTH = 2000

export interface PersonalScheduleItem {
  id: string
  title: string
  start: string
  end: string
  allDay: boolean
  memo: string
}
export interface PersonalScheduleInput {
  id?: string
  title: unknown
  start: unknown
  end?: unknown
  allDay?: unknown
  memo?: unknown
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

/** The caller authenticates the identity; this function only confines its filename. */
export function getPersonalScheduleFilePath(userKey: string, dir: string): string {
  if (typeof userKey !== "string" || !/^[A-Za-z0-9\uAC00-\uD7A3][A-Za-z0-9._\-\uAC00-\uD7A3]{0,39}$/.test(userKey) || userKey.includes("..")) {
    throw new Error("invalid schedule user key")
  }
  return path.join(path.resolve(dir), `${userKey}.yaml`)
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
  const id = isValidScheduleItemId(input.id) ? input.id.trim() : deterministicPersonalScheduleId(title, start, fallbackIndex)
  return { ok: true, item: { id, title, start, end, allDay, memo } }
}

const fieldNames: Record<string, keyof PersonalScheduleInput> = {
  id: "id", 식별자: "id", title: "title", 제목: "title", 이름: "title",
  start: "start", 시작: "start", startat: "start", startdate: "start",
  end: "end", 끝: "end", 종료: "end", endat: "end", enddate: "end",
  allday: "allDay", all_day: "allDay", 종일: "allDay", 종일여부: "allDay",
  memo: "memo", 메모: "memo", note: "memo", 노트: "memo", description: "memo",
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

/** Read only the requested user's regular, singly linked, bounded file. */
export function readPersonalSchedule(userKey: string, dir: string): PersonalScheduleDocument {
  const file = getPersonalScheduleFilePath(userKey, dir)
  let before: fs.Stats
  try { before = fs.lstatSync(file) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { user: userKey, updatedAt: null, items: [], warnings: [] }
    throw error
  }
  if (!before.isFile() || before.nlink !== 1) throw new Error("unsafe personal schedule file")
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0))
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > MAX_PERSONAL_FILE_BYTES) throw new Error("unsafe personal schedule file")
    const buffer = Buffer.alloc(MAX_PERSONAL_FILE_BYTES + 1)
    let size = 0
    while (size < buffer.length) {
      const bytes = fs.readSync(fd, buffer, size, buffer.length - size, size)
      if (!bytes) break
      size += bytes
    }
    if (size > MAX_PERSONAL_FILE_BYTES) throw new Error("personal schedule file is too large")
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size))
    return parsePersonalScheduleYaml(text, userKey)
  } finally { fs.closeSync(fd) }
}
