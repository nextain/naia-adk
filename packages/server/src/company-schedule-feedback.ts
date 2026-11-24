import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

// 회사 일정(`/schedule` 회사 겹) 댓글·직접 수정/삭제 오버레이 저장소.
// 운영 포털은 adkRoot를 읽기 전용으로 마운트하므로, 쓰기 위치는 환경변수로
// 지정한 상태 디렉터리(NAIA_SCHEDULE_COMMENTS_DIR / NAIA_SCHEDULE_OVERRIDES_FILE)를
// 우선 사용하고, 미설정 때만 adkRoot 아래 .agents/work으로 폴백한다.
// 댓글 레코드(action comment/edit/delete)는 담당 AI를 깨우는 외부 감시기가
// targetRole 기준으로 읽는 표준 wake/피드백 레코드다(문서 메모 doc-notes와 같은 철학).

export const SCHEDULE_COMMENT_MAX_BYTES = 64 * 1024
export const SCHEDULE_OVERRIDES_MAX_BYTES = 256 * 1024
export const SCHEDULE_COMMENT_BODY_MAX = 2000

export const SCHEDULE_COMMENT_ID_REGEX = /^\d{8}-\d{6}-[a-z0-9]{6}$/
export const SCHEDULE_ITEM_ID_REGEX = /^[A-Za-z0-9:_.-]{1,160}$/

export type ScheduleCommentAction = "comment" | "edit" | "delete"

export interface ScheduleComment {
  schemaVersion: 1
  id: string
  scheduleId: string
  scheduleTitle: string
  targetRole: string | null
  sourceDocPath: string | null
  author: string
  action: ScheduleCommentAction
  body: string
  createdAt: string
}

export interface ScheduleOverridePatch {
  deleted?: boolean
  title?: string
  startDate?: string
  endDate?: string
  startTime?: string | null
  endTime?: string | null
  status?: string
  updatedAt: string
  updatedBy: string
}

export interface ScheduleOverridesData {
  schemaVersion: 1
  overrides: Record<string, ScheduleOverridePatch>
}

export type ScheduleEnv = NodeJS.ProcessEnv | Record<string, string | undefined>

function envValue(env: ScheduleEnv | undefined, key: string): string {
  if (!env) return ""
  const raw = (env as Record<string, unknown>)[key]
  return typeof raw === "string" ? raw.trim() : ""
}

function resolveStatePath(adkRoot: string, raw: string): string {
  if (path.isAbsolute(raw)) return path.normalize(raw)
  return path.resolve(adkRoot, raw)
}

function rejectSymlinkedParents(targetPath: string): void {
  const absolute = path.resolve(targetPath)
  const parts = absolute.split(path.sep).filter(Boolean)
  let current = path.isAbsolute(absolute) ? path.parse(absolute).root : ""
  for (const part of parts) {
    current = path.join(current, part)
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error("Refusing symlinked state path")
      }
    } catch (err: any) {
      if (err?.code === "ENOENT") break
      throw err
    }
  }
}

export function getScheduleCommentsDir(adkRoot: string, env?: ScheduleEnv): string {
  const override = envValue(env ?? process.env, "NAIA_SCHEDULE_COMMENTS_DIR")
  if (override && !override.includes("\0")) return resolveStatePath(adkRoot, override)
  return path.join(adkRoot, ".agents", "work", "schedule-comments")
}

export function getScheduleOverridesFilePath(adkRoot: string, env?: ScheduleEnv): string {
  const override = envValue(env ?? process.env, "NAIA_SCHEDULE_OVERRIDES_FILE")
  if (override && !override.includes("\0")) return resolveStatePath(adkRoot, override)
  return path.join(adkRoot, ".agents", "work", "schedule-overrides.json")
}

export function getScheduleCommentFilePath(
  adkRoot: string,
  commentId: string,
  env?: ScheduleEnv,
): string {
  return path.join(getScheduleCommentsDir(adkRoot, env), `${commentId}.json`)
}

export function isValidScheduleCommentId(id: unknown): id is string {
  return typeof id === "string" && SCHEDULE_COMMENT_ID_REGEX.test(id)
}

export function isValidScheduleItemId(id: unknown): id is string {
  return typeof id === "string" && SCHEDULE_ITEM_ID_REGEX.test(id)
}

export function generateScheduleCommentId(now = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0")
  const yyyymmdd = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const hhmmss = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const rand = crypto.randomBytes(3).toString("hex").toLowerCase()
  return `${yyyymmdd}-${hhmmss}-${rand}`
}

export function validateScheduleCommentBody(
  body: unknown,
): { valid: true } | { valid: false; error: string } {
  if (typeof body !== "string" || body.length < 1 || body.length > SCHEDULE_COMMENT_BODY_MAX) {
    return {
      valid: false,
      error: `body must be a string between 1 and ${SCHEDULE_COMMENT_BODY_MAX} characters`,
    }
  }
  return { valid: true }
}

/**
 * 담당 AI 역할 추론: 일정 항목의 role이 있으면 우선 사용하고,
 * 없으면 sourceDocPath의 역할 세그먼트(common/<role>/...)에서 추론한다.
 * 인스턴스별 고정 역할명은 쓰지 않는다.
 */
export function inferTargetRole(input: {
  role?: unknown
  sourceDocPath?: unknown
}): string | null {
  if (typeof input.role === "string" && input.role.trim()) {
    return input.role.trim().slice(0, 120)
  }
  if (typeof input.sourceDocPath !== "string") return null
  const normalized = input.sourceDocPath.trim().replace(/\\/g, "/")
  if (!normalized || normalized.includes("\0")) return null
  const segments = normalized.split("/").filter((s) => s.length > 0)
  const commonIdx = segments.findIndex((s) => s === "common")
  if (commonIdx < 0 || commonIdx + 1 >= segments.length) return null
  const candidate = segments[commonIdx + 1].trim()
  if (!candidate || candidate === "." || candidate === ".." || candidate.startsWith(".")) return null
  return candidate.slice(0, 120)
}

function isValidAction(value: unknown): value is ScheduleCommentAction {
  return value === "comment" || value === "edit" || value === "delete"
}

function isValidCommentRecord(value: unknown, expectedId?: string): value is ScheduleComment {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  if (v.schemaVersion !== 1) return false
  if (!isValidScheduleCommentId(v.id)) return false
  if (expectedId !== undefined && v.id !== expectedId) return false
  if (!isValidScheduleItemId(v.scheduleId)) return false
  if (typeof v.scheduleTitle !== "string" || v.scheduleTitle.length > 500) return false
  if (v.targetRole !== null && (typeof v.targetRole !== "string" || !v.targetRole)) return false
  if (v.sourceDocPath !== null && typeof v.sourceDocPath !== "string") return false
  if (typeof v.author !== "string" || !v.author) return false
  if (!isValidAction(v.action)) return false
  if (validateScheduleCommentBody(v.body).valid !== true) {
    // edit/delete 피드백 레코드는 짧은 자동 생성 문구이므로 본문 규칙은 동일하게 적용
    return false
  }
  if (typeof v.createdAt !== "string" || !v.createdAt) return false
  return true
}

function openSecureRead(absPath: string): number | null {
  let fd: number
  try {
    fd = fs.openSync(absPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  } catch {
    return null
  }
  return fd
}

function readJsonSecure<T>(
  absPath: string,
  maxBytes: number,
  validate: (value: unknown) => value is T,
): T | null {
  const fd = openSecureRead(absPath)
  if (fd === null) return null
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1) return null
    if (stat.size > maxBytes) return null
    const buf = Buffer.alloc(stat.size)
    let totalRead = 0
    while (totalRead < stat.size) {
      const n = fs.readSync(fd, buf, totalRead, stat.size - totalRead, totalRead)
      if (n === 0) break
      totalRead += n
    }
    const parsed: unknown = JSON.parse(buf.subarray(0, totalRead).toString("utf-8"))
    if (validate(parsed)) return parsed
    return null
  } catch {
    return null
  } finally {
    try {
      fs.closeSync(fd)
    } catch {}
  }
}

export function readScheduleComment(
  adkRoot: string,
  commentId: string,
  env?: ScheduleEnv,
): ScheduleComment | null {
  if (!isValidScheduleCommentId(commentId)) return null
  const filePath = getScheduleCommentFilePath(adkRoot, commentId, env)
  return readJsonSecure<ScheduleComment>(
    filePath,
    SCHEDULE_COMMENT_MAX_BYTES,
    (v): v is ScheduleComment => isValidCommentRecord(v, commentId),
  )
}

export function listScheduleComments(
  adkRoot: string,
  scheduleId: string,
  env?: ScheduleEnv,
): ScheduleComment[] {
  if (!isValidScheduleItemId(scheduleId)) return []
  const dir = getScheduleCommentsDir(adkRoot, env)
  let files: string[]
  try {
    files = fs.readdirSync(dir)
  } catch {
    return []
  }
  const comments: ScheduleComment[] = []
  for (const file of files) {
    if (!file.endsWith(".json")) continue
    const id = file.slice(0, -5)
    if (!isValidScheduleCommentId(id)) continue
    const comment = readJsonSecure<ScheduleComment>(
      path.join(dir, `${id}.json`),
      SCHEDULE_COMMENT_MAX_BYTES,
      (v): v is ScheduleComment => isValidCommentRecord(v, id),
    )
    if (!comment) continue
    if (comment.scheduleId !== scheduleId) continue
    comments.push(comment)
  }
  comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return comments
}

export function saveScheduleComment(
  adkRoot: string,
  comment: ScheduleComment,
  env?: ScheduleEnv,
): void {
  if (!isValidCommentRecord(comment)) {
    throw new Error("Invalid schedule comment")
  }
  const dir = getScheduleCommentsDir(adkRoot, env)
  rejectSymlinkedParents(dir)
  fs.mkdirSync(dir, { recursive: true })
  rejectSymlinkedParents(dir)
  const filePath = path.join(dir, `${comment.id}.json`)
  const tempPath = path.join(
    dir,
    `.tmp-${comment.id}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
  )
  fs.writeFileSync(tempPath, JSON.stringify(comment, null, 2), "utf-8")
  fs.renameSync(tempPath, filePath)
}

export function deleteScheduleComment(
  adkRoot: string,
  commentId: string,
  env?: ScheduleEnv,
): boolean {
  if (!isValidScheduleCommentId(commentId)) return false
  const filePath = getScheduleCommentFilePath(adkRoot, commentId, env)
  const existing = readScheduleComment(adkRoot, commentId, env)
  if (!existing) return false
  try {
    fs.unlinkSync(filePath)
    return true
  } catch {
    return false
  }
}

function isValidOverridesRecord(value: unknown): value is ScheduleOverridesData {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  if (v.schemaVersion !== 1) return false
  if (!v.overrides || typeof v.overrides !== "object" || Array.isArray(v.overrides)) return false
  const overrides = v.overrides as Record<string, unknown>
  for (const [key, entry] of Object.entries(overrides)) {
    if (!isValidScheduleItemId(key)) return false
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false
  }
  return true
}

function emptyOverrides(): ScheduleOverridesData {
  return { schemaVersion: 1, overrides: {} }
}

/** 오버레이 파일 읽기: 없거나 심볼릭 링크·손상본이면 빈 오버레이를 돌려준다. */
export function readScheduleOverrides(adkRoot: string, env?: ScheduleEnv): ScheduleOverridesData {
  const filePath = getScheduleOverridesFilePath(adkRoot, env)
  const data = readJsonSecure<ScheduleOverridesData>(
    filePath,
    SCHEDULE_OVERRIDES_MAX_BYTES,
    isValidOverridesRecord,
  )
  return data ?? emptyOverrides()
}

export function saveScheduleOverrides(
  adkRoot: string,
  data: ScheduleOverridesData,
  env?: ScheduleEnv,
): void {
  if (!isValidOverridesRecord(data)) {
    throw new Error("Invalid schedule overrides")
  }
  const filePath = getScheduleOverridesFilePath(adkRoot, env)
  const dir = path.dirname(filePath)
  rejectSymlinkedParents(dir)
  fs.mkdirSync(dir, { recursive: true })
  rejectSymlinkedParents(dir)
  const tempPath = path.join(
    dir,
    `.tmp-schedule-overrides-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
  )
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf-8")
  fs.renameSync(tempPath, filePath)
}

const OVERRIDE_TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/
const OVERRIDE_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/

function isValidOverrideDate(value: unknown): boolean {
  if (typeof value !== "string" || !OVERRIDE_DATE_REGEX.test(value)) return false
  const [y, m, d] = value.split("-").map(Number)
  if (y < 1970 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

export interface ValidatedScheduleOverridePatch {
  deleted?: boolean
  title?: string
  startDate?: string
  endDate?: string
  startTime?: string | null
  endTime?: string | null
  status?: string
}

export function validateScheduleOverridePatch(
  body: unknown,
  existingDates?: { startDate: string; endDate: string },
): { valid: true; patch: ValidatedScheduleOverridePatch } | { valid: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { valid: false, error: "Invalid request body" }
  }
  const src = body as Record<string, unknown>
  const patch: ValidatedScheduleOverridePatch = {}
  let touched = false

  if (src.title !== undefined) {
    if (typeof src.title !== "string" || !src.title.trim() || src.title.trim().length > 200) {
      return { valid: false, error: "title must be a string between 1 and 200 characters" }
    }
    patch.title = src.title.trim()
    touched = true
  }
  if (src.startDate !== undefined) {
    if (!isValidOverrideDate(src.startDate)) {
      return { valid: false, error: "startDate must be YYYY-MM-DD" }
    }
    patch.startDate = src.startDate as string
    touched = true
  }
  if (src.endDate !== undefined) {
    if (!isValidOverrideDate(src.endDate)) {
      return { valid: false, error: "endDate must be YYYY-MM-DD" }
    }
    patch.endDate = src.endDate as string
    touched = true
  }
  for (const key of ["startTime", "endTime"] as const) {
    if (src[key] !== undefined) {
      const v = src[key]
      if (v !== null && (typeof v !== "string" || !OVERRIDE_TIME_REGEX.test(v.trim()))) {
        return { valid: false, error: `${key} must be HH:mm or null` }
      }
      patch[key] = v === null ? null : (v as string).trim()
      touched = true
    }
  }
  if (src.status !== undefined) {
    if (typeof src.status !== "string" || !src.status.trim() || src.status.trim().length > 100) {
      return { valid: false, error: "status must be a string between 1 and 100 characters" }
    }
    patch.status = src.status.trim()
    touched = true
  }

  if (!touched) {
    return { valid: false, error: "No editable field provided" }
  }
  const finalStart = patch.startDate ?? existingDates?.startDate
  const finalEnd = patch.endDate ?? existingDates?.endDate
  if (finalStart !== undefined && finalEnd !== undefined && finalStart > finalEnd) {
    return { valid: false, error: "startDate must not be after endDate" }
  }
  return { valid: true, patch }
}
