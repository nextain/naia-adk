#!/usr/bin/env node
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  acquirePersonalScheduleLock,
  appendPersonalScheduleAuditLog,
  assertPersonalScheduleUnchanged,
  assertSafePersonalScheduleAuditLog,
  ensurePersonalScheduleDir,
  getPersonalScheduleFilePath,
  isValidActorRole,
  isValidScheduleItemId,
  PersonalScheduleBusyError,
  PersonalScheduleConflictError,
  personalScheduleRevision,
  PersonalScheduleUnsafeError,
  readPersonalSchedule,
  readVersionedPersonalSchedule,
  safeUserKey,
  serializePersonalScheduleYaml,
  snapshotPersonalSchedule,
  validateAndNormalizeItem,
  writePersonalScheduleAtomic,
} from "../../packages/core/src/personal-schedule.ts"
import { scheduleDetailHref } from "../../packages/core/src/schedule-link.ts"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const BOOLEAN_FLAGS = new Set(["all-day", "clear-before-minutes", "help", "h"])
const VALUE_FLAGS = new Set([
  "dir",
  "user",
  "actor-role",
  "delegates",
  "if-match",
  "id",
  "title",
  "start",
  "end",
  "before-minutes",
  "memo",
  "lock-timeout",
])

export class CliError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = "CliError"
    this.status = status
    this.code = code
  }
}

export function defaultPersonalScheduleDir(env = process.env) {
  return path.resolve(
    env.NAIA_PERSONAL_SCHEDULE_DIR?.trim() || path.join(ROOT, "packages/dashboard/data/schedule/personal"),
  )
}

function parseAllDayValue(raw) {
  if (typeof raw === "boolean") return raw
  const normalized = String(raw).trim().toLowerCase()
  if (["true", "yes", "1", "예"].includes(normalized)) return true
  if (["false", "no", "0", "아니오"].includes(normalized)) return false
  throw new CliError(400, "invalid-all-day", `400 Bad Request: invalid --all-day value: ${raw}`)
}

export function parseCliArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new CliError(400, "missing-command", "400 Bad Request: subcommand required (read|add|update|delete)")
  }
  const args = [...argv]
  if (args[0] === "--help" || args[0] === "-h") {
    return { command: "help", options: {} }
  }
  const command = args.shift()
  if (!["read", "add", "update", "delete"].includes(command)) {
    throw new CliError(400, "invalid-command", `400 Bad Request: unknown subcommand "${command}" (expected read|add|update|delete)`)
  }
  const options = {}
  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (token === "--help" || token === "-h") return { command: "help", options }
    if (!token.startsWith("--")) {
      throw new CliError(400, "unexpected-arg", `400 Bad Request: unexpected positional argument: ${token}`)
    }
    const eq = token.indexOf("=")
    const key = eq >= 0 ? token.slice(2, eq) : token.slice(2)
    const inlineValue = eq >= 0 ? token.slice(eq + 1) : undefined
    if (key === "all-day") {
      if (inlineValue !== undefined) {
        options.allDay = parseAllDayValue(inlineValue)
      } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        options.allDay = parseAllDayValue(args[++i])
      } else {
        options.allDay = true
      }
      continue
    }
    if (key === "clear-before-minutes") {
      if (inlineValue !== undefined) {
        options.clearBeforeMinutes = parseAllDayValue(inlineValue)
      } else {
        options.clearBeforeMinutes = true
      }
      continue
    }
    if (!VALUE_FLAGS.has(key) && !BOOLEAN_FLAGS.has(key)) {
      throw new CliError(400, "unknown-option", `400 Bad Request: unknown option --${key}`)
    }
    let val = inlineValue
    if (val === undefined) {
      if (i + 1 >= args.length) {
        throw new CliError(400, "missing-option-value", `400 Bad Request: --${key} requires a value`)
      }
      val = args[++i]
    }
    options[key] = val
  }
  return { command, options }
}

function addDelegatePair(map, role, targetUser) {
  if (!isValidActorRole(role)) {
    throw new CliError(403, "role-not-delegated", "403 Forbidden: role not delegated")
  }
  let safeTarget
  try {
    safeTarget = safeUserKey(targetUser)
  } catch {
    throw new CliError(403, "role-not-delegated", "403 Forbidden: role not delegated")
  }
  let targets = map.get(role)
  if (!targets) {
    targets = new Set()
    map.set(role, targets)
  }
  targets.add(safeTarget)
}

function populateFromJson(map, data) {
  const root = data && typeof data === "object" && !Array.isArray(data) && Object.hasOwn(data, "delegates")
    ? data.delegates
    : data
  if (Array.isArray(root)) {
    for (const entry of root) {
      if (typeof entry === "string") {
        const parts = entry.split(":")
        if (parts.length !== 2) throw new CliError(403, "role-not-delegated", "403 Forbidden: role not delegated")
        addDelegatePair(map, parts[0].trim(), parts[1].trim())
      } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const role = entry.actorRole ?? entry.role
        const target = entry.targetUser ?? entry.user
        if (typeof role !== "string" || typeof target !== "string") {
          throw new CliError(403, "role-not-delegated", "403 Forbidden: role not delegated")
        }
        addDelegatePair(map, role.trim(), target.trim())
      } else {
        throw new CliError(403, "role-not-delegated", "403 Forbidden: role not delegated")
      }
    }
    return map
  }
  if (root && typeof root === "object") {
    for (const [role, value] of Object.entries(root)) {
      if (typeof value === "string") {
        addDelegatePair(map, role.trim(), value.trim())
      } else if (Array.isArray(value)) {
        for (const target of value) {
          if (typeof target !== "string") throw new CliError(403, "role-not-delegated", "403 Forbidden: role not delegated")
          addDelegatePair(map, role.trim(), target.trim())
        }
      } else {
        throw new CliError(403, "role-not-delegated", "403 Forbidden: role not delegated")
      }
    }
    return map
  }
  throw new CliError(403, "role-not-delegated", "403 Forbidden: role not delegated")
}

function readDelegatesFile(filePath) {
  const resolved = path.resolve(filePath)
  let st
  try {
    st = fs.lstatSync(resolved)
  } catch {
    throw new CliError(403, "role-not-delegated", "403 Forbidden: role not delegated")
  }
  if (st.isSymbolicLink() || !st.isFile() || st.size > 64 * 1024) {
    throw new CliError(403, "role-not-delegated", "403 Forbidden: role not delegated")
  }
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const fstat = fs.fstatSync(fd)
    if (!fstat.isFile() || fstat.dev !== st.dev || fstat.ino !== st.ino || fstat.size > 64 * 1024) {
      throw new CliError(403, "role-not-delegated", "403 Forbidden: role not delegated")
    }
    const buf = fs.readFileSync(fd, "utf8")
    return JSON.parse(buf)
  } catch (err) {
    if (err instanceof CliError) throw err
    throw new CliError(403, "role-not-delegated", "403 Forbidden: role not delegated")
  } finally {
    fs.closeSync(fd)
  }
}

export function parseScheduleDelegates(raw, { allowFile = false } = {}) {
  const map = new Map()
  if (typeof raw !== "string") return map
  const trimmed = raw.trim()
  if (!trimmed) return map
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      throw new CliError(403, "role-not-delegated", "403 Forbidden: role not delegated")
    }
    return populateFromJson(map, parsed)
  }
  const looksLikePath =
    trimmed.endsWith(".json") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../")
  if (allowFile && looksLikePath) {
    return populateFromJson(map, readDelegatesFile(trimmed))
  }
  for (const token of trimmed.split(/[,\s;]+/).filter(Boolean)) {
    const parts = token.split(":")
    if (parts.length !== 2) {
      throw new CliError(403, "role-not-delegated", "403 Forbidden: role not delegated")
    }
    addDelegatePair(map, parts[0].trim(), parts[1].trim())
  }
  return map
}

export function assertDelegatedActor(actorRole, targetUser, options, env = process.env) {
  if (!actorRole || !isValidActorRole(actorRole)) {
    throw new CliError(403, "role-not-delegated", "403 Forbidden: role not delegated")
  }
  const hasFlag = Object.hasOwn(options, "delegates")
  const rawDelegates = hasFlag ? options.delegates : env.NAIA_SCHEDULE_DELEGATES
  const map = parseScheduleDelegates(rawDelegates, { allowFile: hasFlag })
  const allowedTargets = map.get(actorRole)
  if (!allowedTargets || !allowedTargets.has(targetUser)) {
    throw new CliError(403, "role-not-delegated", "403 Forbidden: role not delegated")
  }
}

function normalizeIfMatch(raw) {
  if (raw === undefined) return null
  const trimmed = String(raw).trim()
  if (/^"[a-f0-9]{64}"$/.test(trimmed)) return trimmed
  if (/^[a-f0-9]{64}$/.test(trimmed)) return `"${trimmed}"`
  throw new CliError(428, "personal-schedule-revision-required", "428 Precondition Required: invalid --if-match revision")
}

function parseLockTimeoutMs(raw) {
  if (raw === undefined) return 0
  const trimmed = String(raw).trim()
  if (!/^\d+$/.test(trimmed)) {
    throw new CliError(400, "invalid-lock-timeout", "400 Bad Request: --lock-timeout must be a non-negative integer")
  }
  return Number(trimmed)
}

function parseBeforeMinutesOption(raw) {
  if (raw === undefined) return undefined
  const trimmed = String(raw).trim()
  if (!/^\d+$/.test(trimmed)) {
    throw new CliError(400, "invalid-before-minutes", "400 Bad Request: --before-minutes must be a positive integer")
  }
  const n = Number(trimmed)
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new CliError(400, "invalid-before-minutes", "400 Bad Request: --before-minutes must be a positive integer")
  }
  return n
}

function mapStorageError(error) {
  if (error instanceof CliError) return error
  if (error instanceof PersonalScheduleBusyError) {
    return new CliError(409, "personal-schedule-busy", "409 Conflict: personal-schedule-busy")
  }
  if (error instanceof PersonalScheduleConflictError) {
    return new CliError(409, "personal-schedule-conflict", "409 Conflict: personal-schedule-conflict")
  }
  if (error instanceof PersonalScheduleUnsafeError) {
    return new CliError(403, "personal-schedule-unsafe", `403 Forbidden: ${error.message}`)
  }
  return error
}

function usageText() {
  return [
    "Usage: personal-schedule-cli.mjs <read|add|update|delete> --user <user> [options]",
    "  --dir <path>                 Personal schedule directory (or NAIA_PERSONAL_SCHEDULE_DIR)",
    "  --user <userKey>             Target user key (canonical lowercase, no '..')",
    "  --actor-role <role>          Acting agent role (required for add/update/delete)",
    "  --delegates <spec|file>      Delegation pairs or JSON file (overrides NAIA_SCHEDULE_DELEGATES)",
    "  --if-match <revision>        Expected SHA-256 revision (required for update/delete)",
    "  --id <itemId>                Item id (required for update/delete, optional for add)",
    "  --title <text>               Item title (required for add)",
    "  --start <YYYY-MM-DD[ HH:mm]> Start date or datetime (required for add)",
    "  --end <YYYY-MM-DD[ HH:mm]>   End date or datetime",
    "  --all-day [true|false]       All-day toggle",
    "  --before-minutes <int>       Reminder minutes before timed start (positive integer)",
    "  --clear-before-minutes       Remove beforeMinutes on update",
    "  --memo <text>                Item memo",
    "  --lock-timeout <ms>          Wait up to ms for lock release (default 0)",
  ].join("\n")
}

export async function runPersonalScheduleCli(argv = process.argv.slice(2), env = process.env) {
  const { command, options } = parseCliArgs(argv)
  if (command === "help") {
    return { ok: true, help: usageText() }
  }
  if (!options.user) {
    throw new CliError(400, "missing-user", "400 Bad Request: --user is required")
  }
  let user
  try {
    user = safeUserKey(options.user)
  } catch {
    throw new CliError(400, "invalid-user", "400 Bad Request: invalid schedule user key")
  }
  const dir = options.dir ? path.resolve(options.dir) : defaultPersonalScheduleDir(env)

  if (command === "read") {
    try {
      const doc = readVersionedPersonalSchedule(user, dir)
      return { ok: true, ...doc }
    } catch (error) {
      throw mapStorageError(error)
    }
  }

  // Enforce delegation ACL before creating directories, locking, or touching any file.
  assertDelegatedActor(options["actor-role"], user, options, env)
  const actorRole = options["actor-role"]

  const expectedRevision = normalizeIfMatch(options["if-match"])
  if ((command === "update" || command === "delete") && expectedRevision === null) {
    throw new CliError(428, "personal-schedule-revision-required", "428 Precondition Required: --if-match <revision> is required")
  }
  const lockTimeoutMs = parseLockTimeoutMs(options["lock-timeout"])
  const beforeMinutesOpt = parseBeforeMinutesOption(options["before-minutes"])

  if (command === "add") {
    if (!options.title || !String(options.title).trim()) {
      throw new CliError(400, "missing-title", "400 Bad Request: --title is required for add")
    }
    if (!options.start) {
      throw new CliError(400, "missing-start", "400 Bad Request: --start is required for add")
    }
    if (options.id !== undefined && !isValidScheduleItemId(options.id)) {
      throw new CliError(400, "invalid-id", "400 Bad Request: invalid --id")
    }
  } else {
    if (!options.id || !isValidScheduleItemId(options.id)) {
      throw new CliError(400, "invalid-id", "400 Bad Request: valid --id is required for update/delete")
    }
  }

  let releaseLock
  try {
    const safeDir = ensurePersonalScheduleDir(dir)
    const file = getPersonalScheduleFilePath(user, safeDir)
    assertSafePersonalScheduleAuditLog(safeDir)
    releaseLock = await acquirePersonalScheduleLock(file, { timeoutMs: lockTimeoutMs })
    const original = snapshotPersonalSchedule(file)
    if (expectedRevision !== null && personalScheduleRevision(user, original) !== expectedRevision) {
      throw new PersonalScheduleConflictError()
    }
    let doc
    try {
      doc = readPersonalSchedule(user, safeDir)
    } catch (error) {
      assertPersonalScheduleUnchanged(file, original)
      throw error
    }
    assertPersonalScheduleUnchanged(file, original)
    if (doc.warnings?.length) {
      throw new CliError(
        409,
        "personal-schedule-has-warnings",
        `409 Conflict: personal-schedule-has-warnings (${doc.warnings.join("; ")})`,
      )
    }

    const items = [...doc.items]
    let itemId
    let savedItem = null

    if (command === "add") {
      itemId = options.id ? options.id.trim() : `ps-${crypto.randomBytes(12).toString("hex")}`
      if (items.some((item) => item.id === itemId)) {
        throw new CliError(409, "duplicate-id", `409 Conflict: schedule item id already exists: ${itemId}`)
      }
      const checked = validateAndNormalizeItem(
        {
          id: itemId,
          title: options.title,
          start: options.start,
          end: options.end,
          allDay: options.allDay,
          memo: options.memo ?? "",
          ...(beforeMinutesOpt !== undefined ? { beforeMinutes: beforeMinutesOpt } : {}),
        },
        items.length,
      )
      if (!checked.ok) {
        throw new CliError(400, "invalid-item", `400 Bad Request: ${checked.error}`)
      }
      savedItem = { ...checked.item, id: itemId }
      items.push(savedItem)
    } else {
      itemId = options.id.trim()
      const index = items.findIndex((item) => item.id === itemId)
      if (index < 0) {
        throw new CliError(404, "schedule-item-not-found", `404 Not Found: schedule-item-not-found (${itemId})`)
      }
      if (command === "delete") {
        items.splice(index, 1)
      } else {
        const existing = items[index]
        const nextStart = options.start ?? existing.start
        const nextEnd = options.end ?? existing.end
        const inferredAllDay =
          options.allDay !== undefined
            ? options.allDay
            : options.start !== undefined || options.end !== undefined
              ? undefined
              : existing.allDay
        let nextBeforeMinutes = existing.beforeMinutes
        if (options.clearBeforeMinutes) nextBeforeMinutes = undefined
        if (beforeMinutesOpt !== undefined) nextBeforeMinutes = beforeMinutesOpt
        const checked = validateAndNormalizeItem(
          {
            id: itemId,
            title: options.title ?? existing.title,
            start: nextStart,
            end: nextEnd,
            allDay: inferredAllDay,
            memo: options.memo !== undefined ? options.memo : existing.memo,
            ...(nextBeforeMinutes !== undefined ? { beforeMinutes: nextBeforeMinutes } : {}),
          },
          index,
        )
        if (!checked.ok) {
          throw new CliError(400, "invalid-item", `400 Bad Request: ${checked.error}`)
        }
        savedItem = { ...checked.item, id: itemId }
        items[index] = savedItem
      }
    }

    writePersonalScheduleAtomic(file, serializePersonalScheduleYaml(user, items), original)
    appendPersonalScheduleAuditLog(safeDir, {
      action: command,
      actorRole,
      user,
      itemId,
    })
    const next = readVersionedPersonalSchedule(user, safeDir)
    const href = savedItem
      ? scheduleDetailHref({ layer: "personal", id: itemId, date: savedItem.start.slice(0, 10) })
      : "/schedule"
    return {
      ok: true,
      action: command,
      user,
      id: itemId,
      revision: next.revision,
      href,
      ...(savedItem ? { item: savedItem } : {}),
    }
  } catch (error) {
    throw mapStorageError(error)
  } finally {
    releaseLock?.()
  }
}

async function main() {
  const result = await runPersonalScheduleCli(process.argv.slice(2), process.env)
  if (result.help) {
    process.stdout.write(`${result.help}\n`)
    return
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`)
    process.exitCode = 1
  })
}
