#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"

export const NOTE_ID_REGEX = /^\d{8}-\d{6}-[a-z0-9]{6}$/
export const NOTE_MAX_BYTES = 64 * 1024 // 64KB, 서버 코드와 동일

const loggedSkippedNotes = new Set()

export function logSkippedNote(filePath, reason) {
  if (!loggedSkippedNotes.has(filePath)) {
    loggedSkippedNotes.add(filePath)
    console.log(`${filePath}: ${reason}`)
  }
}

export function clearLoggedSkippedNotes() {
  loggedSkippedNotes.clear()
}

export function isValidNoteId(id) {
  return typeof id === "string" && NOTE_ID_REGEX.test(id)
}

export function getDefaultRoot() {
  const currentFile = fileURLToPath(import.meta.url)
  return path.resolve(path.dirname(currentFile), "..")
}

export function getNotesDir(workspaceRoot) {
  return path.join(workspaceRoot, ".agents", "work", "doc-notes")
}

export function getNoteFilePath(workspaceRoot, id) {
  return path.join(getNotesDir(workspaceRoot), `${id}.json`)
}

export class FileLockTimeoutError extends Error {
  constructor(message = "Lock timeout") {
    super(message)
    this.name = "FileLockTimeoutError"
  }
}

export async function withFileLock(targetFilePath, fn) {
  const lockFilePath = `${targetFilePath}.lock`
  const dir = path.dirname(lockFilePath)
  fs.mkdirSync(dir, { recursive: true })

  const timeoutMs = 2000
  const retryIntervalMs = 50
  const staleThresholdMs = 30000
  const startTime = Date.now()

  let acquired = false
  while (!acquired) {
    try {
      const fd = fs.openSync(
        lockFilePath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o644,
      )
      try {
        fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`)
      } finally {
        fs.closeSync(fd)
      }
      acquired = true
    } catch (err) {
      if (err?.code === "EEXIST") {
        try {
          const stat = fs.statSync(lockFilePath)
          if (Date.now() - stat.mtimeMs > staleThresholdMs) {
            try {
              fs.unlinkSync(lockFilePath)
            } catch {}
            continue
          }
        } catch {}

        if (Date.now() - startTime >= timeoutMs) {
          throw new FileLockTimeoutError(`Lock timeout on ${lockFilePath}`)
        }

        await new Promise((resolve) => setTimeout(resolve, retryIntervalMs))
      } else {
        throw err
      }
    }
  }

  try {
    return await fn()
  } finally {
    try {
      fs.unlinkSync(lockFilePath)
    } catch {}
  }
}

export function readNoteSecure(workspaceRoot, id, forListing = false) {
  if (!isValidNoteId(id)) return { ok: false, error: "not_found" }
  const filePath = getNoteFilePath(workspaceRoot, id)

  let fd
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  } catch (err) {
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
    const parsed = JSON.parse(raw)
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

export function readNote(workspaceRoot, id) {
  const res = readNoteSecure(workspaceRoot, id, false)
  return res.ok ? res.note : null
}

export function saveNote(workspaceRoot, note) {
  const dir = getNotesDir(workspaceRoot)
  fs.mkdirSync(dir, { recursive: true })

  const filePath = getNoteFilePath(workspaceRoot, note.id)
  const tempPath = path.join(
    dir,
    `.tmp-${note.id}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
  )

  const content = JSON.stringify(note, null, 2)
  fs.writeFileSync(tempPath, content, "utf-8")
  fs.renameSync(tempPath, filePath)
}

export function listNotes(workspaceRoot, filter = {}) {
  const dir = getNotesDir(workspaceRoot)
  if (!fs.existsSync(dir)) return []

  let files = []
  try {
    files = fs.readdirSync(dir)
  } catch {
    return []
  }

  const notes = []
  for (const file of files) {
    if (!file.endsWith(".json")) continue
    const id = file.slice(0, -5)
    if (!isValidNoteId(id)) continue

    const res = readNoteSecure(workspaceRoot, id, true)
    if (!res.ok) continue

    const note = res.note
    if (filter.status && note.status !== filter.status) continue
    notes.push(note)
  }

  notes.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return notes
}

export function parseCliArgs(args) {
  let rootArg = null
  let openOnly = false
  let replyArg = null
  const positional = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--root" && i + 1 < args.length) {
      rootArg = args[++i]
    } else if (arg === "--open") {
      openOnly = true
    } else if (arg === "--reply" && i + 1 < args.length) {
      replyArg = args[++i]
    } else {
      positional.push(arg)
    }
  }

  return { rootArg, openOnly, replyArg, positional }
}

export async function runCli(argv = process.argv.slice(2)) {
  const command = argv[0]
  if (!command || !["list", "show", "resolve", "reply"].includes(command)) {
    console.error("사용법: doc-notes.mjs list [--open] [--root <루트>]")
    console.error("       doc-notes.mjs show <id> [--root <루트>]")
    console.error("       doc-notes.mjs resolve <id> --reply \"...\" [--root <루트>]")
    console.error("       doc-notes.mjs reply <id> --reply \"...\" [--root <루트>]")
    process.exit(1)
  }

  const { rootArg, openOnly, replyArg, positional } = parseCliArgs(argv.slice(1))
  const workspaceRoot = rootArg ? path.resolve(rootArg) : getDefaultRoot()

  if (command === "list") {
    const notes = listNotes(workspaceRoot, openOnly ? { status: "open" } : {})
    if (notes.length === 0) {
      console.log(openOnly ? "열린 메모가 없습니다." : "메모가 없습니다.")
      return
    }

    console.log(`메모 목록 (${notes.length}건):`)
    for (const n of notes) {
      const statusBadge = n.status === "open" ? "[열림]" : "[해결]"
      console.log(`${statusBadge} ${n.id} (${n.source}:${n.path}) - ${n.body}`)
      if (n.quote) {
        console.log(`   인용: "${n.quote}"`)
      }
      if (n.reply) {
        console.log(`   ↳ 답: ${n.reply}`)
      }
    }
    return
  }

  const id = positional[0]
  if (!id || !isValidNoteId(id)) {
    console.error(`올바르지 않은 메모 id 형식입니다: "${id}" (형식: YYYYMMDD-HHMMSS-[a-z0-9]{6})`)
    process.exit(1)
  }

  if (command === "show") {
    const note = readNote(workspaceRoot, id)
    if (!note) {
      console.error(`메모를 찾을 수 없습니다: ${id}`)
      process.exit(1)
    }

    console.log(`메모: ${note.id}`)
    console.log(`상태: ${note.status}`)
    console.log(`문서: ${note.source}:${note.path}`)
    console.log(`생성: ${note.createdAt}`)
    console.log(`수정: ${note.updatedAt}`)
    if (note.resolvedAt) console.log(`해결: ${note.resolvedAt}`)
    if (note.quote) console.log(`인용:\n${note.quote}`)
    console.log(`내용:\n${note.body}`)
    if (note.reply) console.log(`답글:\n${note.reply}`)
    return
  }

  if (command === "resolve") {
    if (!replyArg || typeof replyArg !== "string" || replyArg.trim().length === 0) {
      console.error("오류: resolve 명령에는 --reply \"...\" 가 필수입니다.")
      process.exit(1)
    }

    if (replyArg.length > 4000) {
      console.error("오류: reply는 4000자 이하여야 합니다.")
      process.exit(1)
    }

    const filePath = getNoteFilePath(workspaceRoot, id)
    try {
      await withFileLock(filePath, async () => {
        // 잠금 안에서 다시 읽기
        const note = readNote(workspaceRoot, id)
        if (!note) {
          console.error(`메모를 찾을 수 없습니다: ${id}`)
          process.exit(1)
        }

        const now = new Date().toISOString()
        note.status = "resolved"
        note.reply = replyArg
        note.resolvedAt = now
        note.updatedAt = now

        // 원자적 쓰기 (임시 파일 + rename)
        saveNote(workspaceRoot, note)
      })
      console.log(`메모가 해결되었습니다: ${id}`)
      return
    } catch (err) {
      if (err instanceof FileLockTimeoutError) {
        console.error("오류: 잠금 파일 획득 실패 (동시 쓰기 제한 시간 초과)")
        process.exit(1)
      }
      throw err
    }
  }

  if (command === "reply") {
    if (!replyArg || typeof replyArg !== "string" || replyArg.trim().length === 0) {
      console.error("오류: reply 명령에는 --reply \"...\" 가 필수입니다.")
      process.exit(1)
    }

    if (replyArg.length > 4000) {
      console.error("오류: reply는 4000자 이하여야 합니다.")
      process.exit(1)
    }

    const filePath = getNoteFilePath(workspaceRoot, id)
    try {
      await withFileLock(filePath, async () => {
        // 잠금 안에서 다시 읽기
        const note = readNote(workspaceRoot, id)
        if (!note) {
          console.error(`메모를 찾을 수 없습니다: ${id}`)
          process.exit(1)
        }

        const now = new Date().toISOString()
        note.reply = replyArg
        note.updatedAt = now
        // status는 open 유지

        // 원자적 쓰기 (임시 파일 + rename)
        saveNote(workspaceRoot, note)
      })
      console.log(`메모에 답글이 등록되었습니다: ${id}`)
      return
    } catch (err) {
      if (err instanceof FileLockTimeoutError) {
        console.error("오류: 잠금 파일 획득 실패 (동시 쓰기 제한 시간 초과)")
        process.exit(1)
      }
      throw err
    }
  }
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isDirectRun) {
  runCli().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
