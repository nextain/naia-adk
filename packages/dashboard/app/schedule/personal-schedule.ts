import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import {
  acquirePersonalScheduleLock,
  assertPersonalScheduleUnchanged,
  ensurePersonalScheduleDir,
  getPersonalScheduleFilePath,
  isValidScheduleItemId,
  PersonalScheduleBusyError,
  PersonalScheduleConflictError,
  personalScheduleRevision,
  readPersonalSchedule,
  readVersionedPersonalSchedule,
  safeUserKey,
  serializePersonalScheduleYaml,
  snapshotPersonalSchedule,
  validateAndNormalizeItem,
  writePersonalScheduleAtomic,
  type PersonalScheduleItem,
} from "../../../core/src/personal-schedule.ts"
import {
  GATE_SECRET_HEADER,
  GATE_VERIFIED_HEADER,
  inspectSingleHeaderInBag,
  isGateVerifiedHeaders,
} from "../../identity-header-guard.mjs"
import { hostGuard } from "../../host-guard.mjs"

const MAX_BODY_BYTES = 16 * 1024

export function normalizeScheduleUser(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  let value = raw.trim()
  try { value = decodeURIComponent(value).normalize("NFC") } catch { return null }
  try { return safeUserKey(value) } catch { return null }
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
  // A gate means several people sign in, so a missing or mistyped identity header must not fall back to one fixed user.
  if (env.NAIA_GATE_SECRET_FILE?.trim()) return null
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
    try { return reply(200, readVersionedPersonalSchedule(user, dir)) }
    catch (error) {
      if (error instanceof PersonalScheduleConflictError) return reply(409, { error: "personal-schedule-conflict" })
      return reply(500, { error: "personal-schedule-read-failed" })
    }
  }
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return reply(405, { error: "method-not-allowed" })
  if (!hasAllowedOrigin(req, env)) return reply(403, { error: "origin-not-allowed" })
  const expectedRevision = req.headers.get("if-match")
  if (!expectedRevision || !/^"[a-f0-9]{64}"$/.test(expectedRevision)) return reply(428, { error: "personal-schedule-revision-required" })
  let body: Record<string, unknown>
  try { body = await readBody(req) } catch { return reply(400, { error: "invalid-request" }) }
  let releaseLock: (() => void) | undefined
  try {
    const safeDir = ensurePersonalScheduleDir(dir)
    const file = getPersonalScheduleFilePath(user, safeDir)
    releaseLock = await acquirePersonalScheduleLock(file)
    const original = snapshotPersonalSchedule(file)
    if (personalScheduleRevision(user, original) !== expectedRevision) throw new PersonalScheduleConflictError()
    let doc: ReturnType<typeof readPersonalSchedule>
    try { doc = readPersonalSchedule(user, safeDir) }
    catch (error) { assertPersonalScheduleUnchanged(file, original); throw error }
    assertPersonalScheduleUnchanged(file, original)
    if (doc.warnings?.length) return reply(409, { ...doc, userLabel: user, error: "personal-schedule-has-warnings" })
    const items = [...doc.items]
    let id: string
    if (method === "POST") {
      id = `ps-${crypto.randomBytes(12).toString("hex")}`
    } else {
      const supplied = body.id ?? new URL(req.url || "/", "http://localhost").searchParams.get("id")
      if (!isValidScheduleItemId(supplied)) return reply(400, { error: "invalid-id" })
      id = supplied as string
    }
    const index = items.findIndex((item) => item.id === id)
    if (method !== "POST" && index < 0) return reply(404, { error: "schedule-item-not-found" })
    if (method === "DELETE") items.splice(index, 1)
    else {
      const existing = index >= 0 ? items[index] : undefined
      const input = method === "PATCH"
        ? { ...existing, ...body, id }
        : {
            ...body,
            ...(method === "PUT" && !Object.hasOwn(body, "beforeMinutes") && existing?.beforeMinutes !== undefined
              ? { beforeMinutes: existing.beforeMinutes }
              : {}),
            id,
          }
      const checked = validateAndNormalizeItem(input as any, Math.max(index, 0))
      if (!checked.ok) return reply(400, { error: (checked as { error: string }).error })
      if (method === "POST") items.push({ ...checked.item, id })
      else items[index] = { ...checked.item, id }
    }
    writePersonalScheduleAtomic(file, serializePersonalScheduleYaml(user, items), original)
    return reply(method === "POST" ? 201 : 200, readVersionedPersonalSchedule(user, safeDir))
  } catch (error) {
    if (error instanceof PersonalScheduleBusyError) return reply(409, { error: "personal-schedule-busy" })
    if (error instanceof PersonalScheduleConflictError) return reply(409, { error: "personal-schedule-conflict" })
    return reply(500, { error: "personal-schedule-write-failed" })
  } finally {
    releaseLock?.()
  }
}
