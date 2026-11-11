import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import {
  getPersonalScheduleFilePath,
  isValidScheduleItemId,
  MAX_PERSONAL_FILE_BYTES,
  readPersonalSchedule,
  validateAndNormalizeItem,
  type PersonalScheduleItem,
} from "@naia-adk/core/src/personal-schedule"
import {
  GATE_SECRET_HEADER,
  GATE_VERIFIED_HEADER,
  inspectSingleHeaderInBag,
  isGateVerifiedHeaders,
} from "../../identity-header-guard.mjs"
import { hostGuard } from "../../host-guard.mjs"

const MAX_BODY_BYTES = 16 * 1024
const USER_KEY = /^[A-Za-z0-9\uAC00-\uD7A3][A-Za-z0-9._\-\uAC00-\uD7A3]{0,39}$/

export function normalizeScheduleUser(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  let value = raw.trim()
  try { value = decodeURIComponent(value).normalize("NFC") } catch { return null }
  if (!USER_KEY.test(value) || value.includes("..") || /[A-Z]/.test(value)) return null
  return value
}

export function resolveScheduleUser(headers: Headers, env: Record<string, string | undefined> = process.env): string | null {
  const names = [env.NAIA_SCHEDULE_USER_HEADER, env.NAIA_NOTE_USER_HEADER]
    .map((name) => name?.trim().toLowerCase() || "")
    .filter((name) => /^x-[a-z0-9-]+$/.test(name) && name !== GATE_SECRET_HEADER && name !== GATE_VERIFIED_HEADER)
  if (names.length && isGateVerifiedHeaders(headers, env)) {
    for (const name of names) {
      const header = inspectSingleHeaderInBag(headers, name)
      if (!header.present) continue
      if (!header.valid || !header.value) return null
      return normalizeScheduleUser(header.value)
    }
  }
  return normalizeScheduleUser(env.NAIA_SCHEDULE_SINGLE_USER)
}

export function defaultPersonalScheduleDir(env: Record<string, string | undefined> = process.env): string {
  const cwd = process.cwd()
  const dashboard = fs.existsSync(path.join(cwd, "packages", "dashboard", "package.json"))
    ? path.join(cwd, "packages", "dashboard") : cwd
  return path.resolve(env.NAIA_PERSONAL_SCHEDULE_DIR?.trim() || path.join(dashboard, "data", "schedule", "personal"))
}

function reply(status: number, body: object): Response {
  return Response.json(body, { status, headers: { "cache-control": "private, no-store" } })
}

function serialize(user: string, items: PersonalScheduleItem[]): string {
  const quote = (value: string) => JSON.stringify(value)
  const lines = [`user: ${quote(user)}`, `updatedAt: ${quote(new Date().toISOString())}`, items.length ? "items:" : "items: []"]
  for (const item of items) lines.push(
    `  - id: ${quote(item.id)}`, `    title: ${quote(item.title)}`, `    start: ${quote(item.start)}`,
    `    end: ${quote(item.end)}`, `    allDay: ${item.allDay}`, `    memo: ${quote(item.memo)}`,
  )
  return lines.join("\n") + "\n"
}

class ScheduleChanged extends Error {}
interface FileSnapshot { stat: fs.Stats; bytes: Buffer }

function sameStat(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink
}

function snapshot(file: string): FileSnapshot | null {
  let before: fs.Stats
  try { before = fs.lstatSync(file) }
  catch (error: any) { if (error?.code === "ENOENT") return null; throw error }
  if (!before.isFile() || before.nlink !== 1 || before.size > MAX_PERSONAL_FILE_BYTES) throw new Error("unsafe schedule file")
  let fd: number
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0)) }
  catch (error: any) { if (["ENOENT", "ELOOP"].includes(error?.code)) throw new ScheduleChanged(); throw error }
  try {
    const opened = fs.fstatSync(fd)
    if (!opened.isFile() || !sameStat(before, opened)) throw new ScheduleChanged()
    const buffer = Buffer.alloc(MAX_PERSONAL_FILE_BYTES + 1)
    let size = 0
    while (size < buffer.length) {
      const count = fs.readSync(fd, buffer, size, buffer.length - size, size)
      if (!count) break
      size += count
    }
    if (size > MAX_PERSONAL_FILE_BYTES) throw new ScheduleChanged()
    const after = fs.fstatSync(fd)
    let current: fs.Stats
    try { current = fs.lstatSync(file) } catch (error: any) { if (error?.code === "ENOENT") throw new ScheduleChanged(); throw error }
    if (!sameStat(opened, after) || !sameStat(after, current)) throw new ScheduleChanged()
    return { stat: after, bytes: buffer.subarray(0, size) }
  } finally { fs.closeSync(fd) }
}

function assertUnchanged(file: string, original: FileSnapshot | null): void {
  let current: FileSnapshot | null
  try { current = snapshot(file) } catch { throw new ScheduleChanged() }
  if (original === null && current === null) return
  if (!original || !current || !sameStat(original.stat, current.stat) || !original.bytes.equals(current.bytes)) throw new ScheduleChanged()
}

function revision(user: string, snapshot: FileSnapshot | null): string {
  const hash = crypto.createHash("sha256").update("schedule-user:").update(user).update("\0")
  if (!snapshot) hash.update("missing")
  else {
    const s = snapshot.stat
    hash.update(`file:${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:`)
    hash.update(snapshot.bytes)
  }
  return `"${hash.digest("hex")}"`
}

function readVersioned(user: string, dir: string) {
  const file = getPersonalScheduleFilePath(user, dir)
  const original = snapshot(file)
  const doc = readPersonalSchedule(user, dir)
  assertUnchanged(file, original)
  return { ...doc, userLabel: user, revision: revision(user, original) }
}

function writeAtomic(file: string, body: string, original: FileSnapshot | null): void {
  if (Buffer.byteLength(body) > MAX_PERSONAL_FILE_BYTES) throw new Error("schedule too large")
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(12).toString("hex")}.tmp`
  let created = false
  try {
    const fd = fs.openSync(tmp, "wx", 0o600)
    created = true
    try { fs.writeFileSync(fd, body) } finally { fs.closeSync(fd) }
    assertUnchanged(file, original)
    fs.renameSync(tmp, file)
    created = false
  } finally {
    if (created) fs.unlinkSync(tmp)
  }
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new Error("content type")
  const length = Number(req.headers.get("content-length"))
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new Error("body size")
  const reader = req.body?.getReader()
  if (!reader) return {}
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new Error("body size") }
    chunks.push(value)
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body shape")
  return parsed as Record<string, unknown>
}

function hasAllowedOrigin(req: Request, env: Record<string, string | undefined>): boolean {
  const host = inspectSingleHeaderInBag(req.headers, "host")
  if (!host.present || !host.valid || !host.value || !hostGuard(host.value)) return false
  const origin = req.headers.get("origin")
  try {
    const configured = env.NAIA_SCHEDULE_PUBLIC_ORIGIN?.trim()
    const expected = configured ? new URL(configured) : new URL(req.url)
    if (!["http:", "https:"].includes(expected.protocol) || expected.username || expected.password) return false
    if (configured && configured !== expected.origin) return false
    const incomingHost = new URL(`${expected.protocol}//${host.value}`)
    if (incomingHost.username || incomingHost.password || incomingHost.pathname !== "/" || incomingHost.search || incomingHost.hash) return false
    if (configured && expected.host !== incomingHost.host) return false
    if (!origin) return true
    const supplied = new URL(origin)
    if (!["http:", "https:"].includes(supplied.protocol) || supplied.origin !== origin) return false
    return supplied.origin === `${expected.protocol}//${incomingHost.host}`
  } catch { return false }
}

export async function handlePersonalScheduleRequest(req: Request, opts: { env?: Record<string, string | undefined>; dir?: string } = {}): Promise<Response> {
  const env = opts.env ?? process.env
  const user = resolveScheduleUser(req.headers, env)
  if (!user) return reply(403, { error: "personal-schedule-identity-required" })
  const dir = opts.dir ?? defaultPersonalScheduleDir(env)
  const method = req.method.toUpperCase()
  if (method === "GET") {
    try { return reply(200, readVersioned(user, dir)) }
    catch (error) { if (error instanceof ScheduleChanged) return reply(409, { error: "personal-schedule-conflict" }); return reply(500, { error: "personal-schedule-read-failed" }) }
  }
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return reply(405, { error: "method-not-allowed" })
  if (!hasAllowedOrigin(req, env)) return reply(403, { error: "origin-not-allowed" })
  const expectedRevision = req.headers.get("if-match")
  if (!expectedRevision || !/^"[a-f0-9]{64}"$/.test(expectedRevision)) return reply(428, { error: "personal-schedule-revision-required" })
  let body: Record<string, unknown>
  try { body = await readBody(req) } catch { return reply(400, { error: "invalid-request" }) }
  let lockFd: number | undefined
  let lockPath: string | undefined
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = getPersonalScheduleFilePath(user, dir)
    lockPath = `${file}.lock`
    try { lockFd = fs.openSync(lockPath, "wx", 0o600) }
    catch (error: any) {
      if (error?.code === "EEXIST") return reply(409, { error: "personal-schedule-busy" })
      throw error
    }
    const original = snapshot(file)
    if (revision(user, original) !== expectedRevision) throw new ScheduleChanged()
    let doc: ReturnType<typeof readPersonalSchedule>
    try { doc = readPersonalSchedule(user, dir) }
    catch (error) { assertUnchanged(file, original); throw error }
    assertUnchanged(file, original)
    if (doc.warnings?.length) return reply(409, { ...doc, userLabel: user, error: "personal-schedule-has-warnings" })
    const items = [...doc.items]
    let id: string
    if (method === "POST") {
      id = `ps-${crypto.randomBytes(12).toString("hex")}`
    } else {
      const supplied = body.id ?? new URL(req.url).searchParams.get("id")
      if (!isValidScheduleItemId(supplied)) return reply(400, { error: "invalid-id" })
      id = supplied as string
    }
    const index = items.findIndex((item) => item.id === id)
    if (method !== "POST" && index < 0) return reply(404, { error: "schedule-item-not-found" })
    if (method === "DELETE") items.splice(index, 1)
    else {
      const input = method === "PATCH" ? { ...items[index], ...body, id } : { ...body, id }
      const checked = validateAndNormalizeItem(input as any, Math.max(index, 0))
      if (!checked.ok) return reply(400, { error: (checked as { error: string }).error })
      if (method === "POST") items.push({ ...checked.item, id })
      else items[index] = { ...checked.item, id }
    }
    writeAtomic(file, serialize(user, items), original)
    return reply(method === "POST" ? 201 : 200, readVersioned(user, dir))
  } catch (error) {
    if (error instanceof ScheduleChanged) return reply(409, { error: "personal-schedule-conflict" })
    return reply(500, { error: "personal-schedule-write-failed" })
  } finally {
    if (lockFd !== undefined && lockPath) { fs.closeSync(lockFd); fs.unlinkSync(lockPath) }
  }
}
