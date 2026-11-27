import fs from "node:fs"
import path from "node:path"

export type DocEditOrigin = "대시보드" | "AI 메모 처리"

export interface DocEditHistoryEntry {
  timestamp: string
  source: string
  path: string
  previousHash: string
  newHash: string
  origin: DocEditOrigin
}

function dayInKorea(date: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date).map((part) => [part.type, part.value]),
  )
  return `${parts.year}${parts.month}${parts.day}`
}

export function appendDocEditHistory(root: string, entry: DocEditHistoryEntry): string {
  if (entry.origin !== "대시보드" && entry.origin !== "AI 메모 처리") {
    throw new Error("Invalid document edit origin")
  }

  const day = dayInKorea(new Date(entry.timestamp))
  const dir = path.join(root, ".agents", "work", "doc-edits")
  const filePath = path.join(dir, `${day}.jsonl`)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })

  const flags = fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0)
  const fd = fs.openSync(filePath, flags, 0o600)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.nlink > 1) throw new Error("Unsafe document edit history file")
    fs.writeFileSync(fd, `${JSON.stringify(entry)}\n`, "utf8")
  } finally {
    fs.closeSync(fd)
  }
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {}
  return filePath
}
