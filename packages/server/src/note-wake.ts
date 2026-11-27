// Document-memo wake writer (ported from the pre-11/24 docs UX and
// generalized: no workspace-specific role names, paths, or dashboard hosts).
//
// When a doc memo is saved, this module writes one wake file into the
// responsible role's wake directory (roles file `wakeDir`) so the existing
// waiter/delivery loop can hand it over in one batch. It never calls a model:
// batching stays with the caller-side delivery loop.
//
// Role resolution order: doc header "author" line -> last git commit author of
// the doc -> doc header "owner" line -> configured default role (or the first
// role in the file). All role identities come from the roles file, which the
// workspace owns; this module ships no built-in names.
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { execFileSync } from "node:child_process"

export interface WakeRole {
  id: string
  names: string[]
  wakeDir: string
  activeMarker?: string
  inboxDir: string
}

export interface NoteForWake {
  id: string
  source: string
  path: string
  quote: string | null
  body: string
}

export interface RoleChoice {
  role: WakeRole
  reason: string
}

const ROLE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const HEAD_BYTES = 8 * 1024
const HEAD_LINES = 40

export function rolesFilePath(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.NAIA_WAKE_ROLES_FILE ?? "").trim()
  if (override) return path.isAbsolute(override) ? override : path.join(root, override)
  return path.join(root, ".agents", "work", "l4", "roles.json")
}

function insideRoot(root: string, rel: string): string | null {
  if (typeof rel !== "string" || !rel || path.isAbsolute(rel)) return null
  const abs = path.resolve(root, rel)
  const base = path.resolve(root)
  return abs.startsWith(base + path.sep) ? abs : null
}

export function loadWakeRoles(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): WakeRole[] {
  let parsed: any
  try {
    parsed = JSON.parse(fs.readFileSync(rolesFilePath(root, env), "utf-8"))
  } catch {
    return []
  }
  const inboxRoot = insideRoot(root, parsed?.roleInboxRoot) ?? path.join(root, ".agents", "work", "l4", "role-inbox")
  const roles: WakeRole[] = []
  for (const raw of Array.isArray(parsed?.roles) ? parsed.roles : []) {
    if (!raw || typeof raw.id !== "string" || !ROLE_ID_RE.test(raw.id)) continue
    const wakeDir = insideRoot(root, raw.wakeDir)
    if (!wakeDir) continue
    const names = Array.isArray(raw.names) ? raw.names.filter((n: unknown) => typeof n === "string" && n.trim()) : []
    const activeMarker = typeof raw.activeMarker === "string" ? insideRoot(root, raw.activeMarker) ?? undefined : undefined
    roles.push({ id: raw.id, names, wakeDir, activeMarker, inboxDir: path.join(inboxRoot, raw.id) })
  }
  return roles
}

// First role-name (or id) occurrence wins.
export function findRoleInText(text: string, roles: WakeRole[]): WakeRole | null {
  let best: { role: WakeRole; at: number } | null = null
  for (const role of roles) {
    for (const label of [...role.names, role.id]) {
      if (!label) continue
      // ASCII ids match on word boundaries only; display names match literally.
      const at = label === role.id
        ? text.search(new RegExp(`(?<![A-Za-z0-9])${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "i"))
        : text.indexOf(label)
      if (at >= 0 && (!best || at < best.at)) best = { role, at }
    }
  }
  return best?.role ?? null
}

// Doc header (first lines) author/owner values. Reads both plain `author:` /
// `owner:` style lines and the equivalent Korean doc-header labels.
export function readDocHeader(text: string): { author: string | null; owner: string | null } {
  const lines = text.slice(0, HEAD_BYTES).split(/\r?\n/).slice(0, HEAD_LINES)
  let author: string | null = null
  let owner: string | null = null
  for (const line of lines) {
    const m = line.match(/^\s*(?:[-*]\s*)?(?:\*\*)?\s*(작성자|작성|마지막\s*작성|author|담당자|담당|owner)\s*(?:\*\*)?\s*[:：]\s*(.+)$/i)
    if (!m) continue
    const key = m[1].replace(/\s+/g, "").toLowerCase()
    const value = m[2].trim()
    if ((key === "작성자" || key === "작성" || key === "마지막작성" || key === "author") && author === null) author = value
    if ((key === "담당자" || key === "담당" || key === "owner") && owner === null) owner = value
  }
  return { author, owner }
}

function gitLastAuthor(absDocPath: string | null | undefined): string | null {
  if (!absDocPath) return null
  try {
    const out = execFileSync(
      "git",
      ["-C", path.dirname(absDocPath), "log", "-1", "--format=%an %ae", "--", path.basename(absDocPath)],
      { encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] },
    )
    return out.trim() || null
  } catch {
    return null
  }
}

export function chooseWakeRole(
  roles: WakeRole[],
  docText: string,
  lastCommitAuthor: string | null,
  env: NodeJS.ProcessEnv = process.env,
): RoleChoice | null {
  if (roles.length === 0) return null
  const header = readDocHeader(docText)
  if (header.author) {
    const role = findRoleInText(header.author, roles)
    if (role) return { role, reason: `doc header author: ${header.author.slice(0, 80)}` }
  }
  if (lastCommitAuthor) {
    const role = findRoleInText(lastCommitAuthor, roles)
    if (role) return { role, reason: `last commit author: ${lastCommitAuthor.slice(0, 80)}` }
  }
  if (header.owner) {
    const role = findRoleInText(header.owner, roles)
    if (role) return { role, reason: `doc header owner: ${header.owner.slice(0, 80)}` }
  }
  const fallbackId = (env.NAIA_WAKE_DEFAULT_ROLE ?? "").trim()
  const fallback = fallbackId ? (roles.find((r) => r.id === fallbackId) ?? roles[0]) : roles[0]
  return { role: fallback, reason: "no matching author/owner in doc; sent to the default role" }
}

// Matches the waiter-side cursor shape: file names sort with the backlog.
export function wakeTimestampKey(date: Date): string {
  return date.toISOString().replace(/[-:.TZ]/g, "")
}

function waiterAlive(markerPath: string | undefined): boolean {
  if (!markerPath) return false
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8"))
    const pid = Number.isSafeInteger(marker?.pid) && marker.pid > 0 ? marker.pid : null
    if (pid === null) return false
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err?.code === "EPERM"
  }
}

function writeNewPrivateFile(filePath: string, content: string): boolean {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(5).toString("hex")}`
  fs.writeFileSync(temp, content, { mode: 0o600, flag: "wx" })
  try {
    fs.linkSync(temp, filePath)
    return true
  } catch (err: any) {
    if (err?.code === "EEXIST") return false
    throw err
  } finally {
    try { fs.unlinkSync(temp) } catch {}
  }
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? flat.slice(0, max) + "…" : flat
}

export function dashboardDocUrl(
  params: { source: string; path: string },
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const base = (env.NAIA_DASHBOARD_PUBLIC_URL ?? "").trim().replace(/\/+$/, "")
  if (!base) return null
  return `${base}/docs?source=${encodeURIComponent(params.source)}&path=${encodeURIComponent(params.path)}`
}

export function buildNoteWakeBody(params: {
  note: NoteForWake
  choice: RoleChoice
  docRelPath: string
  dashboardUrl: string | null
  now: Date
}): string {
  const { note, choice, docRelPath, dashboardUrl, now } = params
  const bodyText = note.body.length > 4000 ? note.body.slice(0, 4000) + "…" : note.body
  return [
    "# Doc memo wake",
    "",
    `- at: ${now.toISOString()}`,
    `- role: ${choice.role.names[0] ?? choice.role.id} (${choice.reason})`,
    `- doc: ${docRelPath}`,
    ...(dashboardUrl ? [`- dashboard: ${dashboardUrl}`] : []),
    `- memo id: ${note.id}`,
    `- quote: ${note.quote ? oneLine(note.quote, 300) : "(whole doc)"}`,
    "- memo:",
    "",
    bodyText,
    "",
    "- next: read the memo and reply in the dashboard memo thread. If the doc needs edits, edit it and note what changed in the reply.",
    "  Handle backlogged memo wakes in one batch (no per-item model calls).",
    "",
  ].join("\n")
}

export interface NoteWakeResult {
  role: string
  reason: string
  wakePath: string
  inboxPath: string | null
}

// Call right after a memo save; callers swallow errors so memo writes survive.
export function writeNoteWake(params: {
  root: string
  note: NoteForWake
  absDocPath?: string | null
  now?: Date
  dashboardUrl?: string | null
  lastCommitAuthor?: string | null
  env?: NodeJS.ProcessEnv
}): NoteWakeResult | null {
  const { root, note } = params
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(note.id)) return null
  const env = params.env ?? process.env
  const now = params.now ?? new Date()
  const roles = loadWakeRoles(root, env)
  let docText = ""
  if (params.absDocPath) {
    try {
      const fd = fs.openSync(params.absDocPath, "r")
      try {
        const buf = Buffer.alloc(HEAD_BYTES)
        const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0)
        docText = buf.subarray(0, n).toString("utf-8")
      } finally {
        fs.closeSync(fd)
      }
    } catch {}
  }
  const lastAuthor = params.lastCommitAuthor !== undefined
    ? params.lastCommitAuthor
    : gitLastAuthor(params.absDocPath)
  const choice = chooseWakeRole(roles, docText, lastAuthor, env)
  if (!choice) return null
  const rel = params.absDocPath
    ? path.relative(root, params.absDocPath)
    : `${note.source}/${note.path}`
  const docRelPath = rel.startsWith("..") || path.isAbsolute(rel) ? `${note.source}/${note.path}` : rel.split(path.sep).join("/")
  const dashboardUrl = params.dashboardUrl !== undefined
    ? params.dashboardUrl
    : dashboardDocUrl({ source: note.source, path: note.path }, env)
  const body = buildNoteWakeBody({ note, choice, docRelPath, dashboardUrl, now })
  const fileName = `${wakeTimestampKey(now)}-note-${note.id}.md`
  const wakePath = path.join(choice.role.wakeDir, fileName)
  writeNewPrivateFile(wakePath, body)
  let inboxPath: string | null = null
  if (!waiterAlive(choice.role.activeMarker)) {
    // The recipient is not waiting live; also leave it in the role inbox.
    inboxPath = path.join(choice.role.inboxDir, fileName)
    writeNewPrivateFile(inboxPath, body)
  }
  const toRel = (p: string) => path.relative(root, p).split(path.sep).join("/")
  return { role: choice.role.id, reason: choice.reason, wakePath: toRel(wakePath), inboxPath: inboxPath ? toRel(inboxPath) : null }
}
