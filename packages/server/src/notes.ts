import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"

export interface DocNote {
  schemaVersion: 1
  id: string
  source: string
  path: string
  quote: string | null
  body: string
  status: "open" | "resolved"
  createdAt: string
  updatedAt: string
  reply: string | null
  resolvedAt: string | null
}

export const NOTE_ID_REGEX = /^\d{8}-\d{6}-[a-z0-9]{6}$/
export const NOTE_MAX_BYTES = 64 * 1024

const loggedSkippedNotes = new Set<string>()

export function logSkippedNote(filePath: string, reason: string) {
  if (!loggedSkippedNotes.has(filePath)) {
    loggedSkippedNotes.add(filePath)
    console.log(`${filePath}: ${reason}`)
  }
}

export function clearLoggedSkippedNotes() {
  loggedSkippedNotes.clear()
}

export function isValidNoteId(id: unknown): id is string {
  return typeof id === "string" && NOTE_ID_REGEX.test(id)
}

export function generateNoteId(now = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0")
  const yyyymmdd = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const hhmmss = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const rand = crypto.randomBytes(3).toString("hex").toLowerCase()
  return `${yyyymmdd}-${hhmmss}-${rand}`
}

export function getNotesDir(adkRoot: string): string {
  return path.join(adkRoot, ".agents", "work", "doc-notes")
}

export function getNoteFilePath(adkRoot: string, id: string): string {
  return path.join(getNotesDir(adkRoot), `${id}.json`)
}

export function validateNoteLengths(params: {
  body?: unknown
  quote?: unknown
  reply?: unknown
  requireBody?: boolean
}): { valid: true } | { valid: false; error: string } {
  if (params.requireBody) {
    if (typeof params.body !== "string" || params.body.length < 1 || params.body.length > 4000) {
      return { valid: false, error: "body must be a string between 1 and 4000 characters" }
    }
  } else if (params.body !== undefined) {
    if (typeof params.body !== "string" || params.body.length < 1 || params.body.length > 4000) {
      return { valid: false, error: "body must be a string between 1 and 4000 characters" }
    }
  }

  if (params.quote !== undefined && params.quote !== null) {
    if (typeof params.quote !== "string" || params.quote.length > 2000) {
      return { valid: false, error: "quote must be a string up to 2000 characters or null" }
    }
  }

  if (params.reply !== undefined && params.reply !== null) {
    if (typeof params.reply !== "string" || params.reply.length > 4000) {
      return { valid: false, error: "reply must be a string up to 4000 characters or null" }
    }
  }

  return { valid: true }
}

export type ReadNoteResult =
  | { ok: true; note: DocNote }
  | { ok: false; error: "not_found" | "link" | "too_large" | "invalid" }

export function readNoteSecure(
  adkRoot: string,
  id: string,
  forListing = false,
): ReadNoteResult {
  if (!isValidNoteId(id)) return { ok: false, error: "not_found" }
  const filePath = getNoteFilePath(adkRoot, id)

  let fd: number
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  } catch (err: any) {
    if (err?.code === "ELOOP") {
      if (forListing) {
        logSkippedNote(filePath, "심볼릭 링크라 건너뜀")
      }
      return { ok: false, error: "link" }
    }
    return { ok: false, error: "not_found" }
  }

  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.nlink > 1) {
      if (forListing && stat.nlink > 1) {
        logSkippedNote(filePath, "하드 링크라 건너뜀")
      }
      return { ok: false, error: stat.nlink > 1 ? "link" : "invalid" }
    }

    if (stat.size > NOTE_MAX_BYTES) {
      if (forListing) {
        logSkippedNote(filePath, "64KB 초과라 건너뜀")
      }
      return { ok: false, error: "too_large" }
    }

    const buf = Buffer.alloc(stat.size)
    let totalRead = 0
    while (totalRead < stat.size) {
      const n = fs.readSync(fd, buf, totalRead, stat.size - totalRead, totalRead)
      if (n === 0) break
      totalRead += n
    }

    const raw = buf.subarray(0, totalRead).toString("utf-8")
    const parsed = JSON.parse(raw) as DocNote
    if (parsed && parsed.schemaVersion === 1 && parsed.id === id) {
      return { ok: true, note: parsed }
    }
    return { ok: false, error: "invalid" }
  } catch {
    return { ok: false, error: "invalid" }
  } finally {
    try {
      fs.closeSync(fd)
    } catch {}
  }
}

export function readNote(adkRoot: string, id: string): DocNote | null {
  const res = readNoteSecure(adkRoot, id, false)
  return res.ok ? res.note : null
}

export function saveNote(adkRoot: string, note: DocNote): void {
  const dir = getNotesDir(adkRoot)
  fs.mkdirSync(dir, { recursive: true })

  const filePath = getNoteFilePath(adkRoot, note.id)
  const tempPath = path.join(
    dir,
    `.tmp-${note.id}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
  )

  const content = JSON.stringify(note, null, 2)
  fs.writeFileSync(tempPath, content, "utf-8")
  fs.renameSync(tempPath, filePath)
}

export function deleteNote(adkRoot: string, id: string): boolean {
  if (!isValidNoteId(id)) return false
  const filePath = getNoteFilePath(adkRoot, id)
  const existing = readNote(adkRoot, id)
  if (!existing) return false

  try {
    fs.unlinkSync(filePath)
    return true
  } catch {
    return false
  }
}

export function listNotes(
  adkRoot: string,
  filter?: { source?: string; path?: string; status?: string },
): DocNote[] {
  const dir = getNotesDir(adkRoot)
  if (!fs.existsSync(dir)) return []

  let files: string[] = []
  try {
    files = fs.readdirSync(dir)
  } catch {
    return []
  }

  const notes: DocNote[] = []
  for (const file of files) {
    if (!file.endsWith(".json")) continue
    const id = file.slice(0, -5)
    if (!isValidNoteId(id)) continue

    const res = readNoteSecure(adkRoot, id, true)
    if (!res.ok) continue

    const note = res.note
    if (filter?.source && note.source !== filter.source) continue
    if (filter?.path && note.path !== filter.path) continue
    if (filter?.status && note.status !== filter.status) continue

    notes.push(note)
  }

  notes.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return notes
}

export function countOpenNotes(adkRoot: string): Record<string, number> {
  const openNotes = listNotes(adkRoot, { status: "open" })
  const counts: Record<string, number> = {}

  for (const note of openNotes) {
    const key = `${note.source}\u0000${note.path}`
    counts[key] = (counts[key] || 0) + 1
  }

  return counts
}
