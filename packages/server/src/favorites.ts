import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"

export interface DocFavoriteItem {
  source: string
  path: string
  type: "file" | "directory"
  addedAt: string
}

export interface DocFavoritesData {
  schemaVersion: 1
  items: DocFavoriteItem[]
}

export const FAVORITES_MAX_BYTES = 256 * 1024

export function getFavoritesFilePath(adkRoot: string): string {
  return path.join(adkRoot, ".agents", "work", "doc-favorites.json")
}

export type ReadFavoritesResult =
  | { ok: true; data: DocFavoritesData }
  | { ok: false; error: "favorites_file_invalid" }

export function readFavoritesSecure(adkRoot: string): ReadFavoritesResult {
  const filePath = getFavoritesFilePath(adkRoot)

  let fd: number
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { ok: true, data: { schemaVersion: 1, items: [] } }
    }
    return { ok: false, error: "favorites_file_invalid" }
  }

  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.nlink > 1) {
      return { ok: false, error: "favorites_file_invalid" }
    }

    if (stat.size > FAVORITES_MAX_BYTES) {
      return { ok: false, error: "favorites_file_invalid" }
    }

    const buf = Buffer.alloc(stat.size)
    let totalRead = 0
    while (totalRead < stat.size) {
      const n = fs.readSync(fd, buf, totalRead, stat.size - totalRead, totalRead)
      if (n === 0) break
      totalRead += n
    }

    const raw = buf.subarray(0, totalRead).toString("utf-8")
    const parsed = JSON.parse(raw) as DocFavoritesData
    if (parsed && parsed.schemaVersion === 1 && Array.isArray(parsed.items)) {
      return { ok: true, data: parsed }
    }
    return { ok: false, error: "favorites_file_invalid" }
  } catch {
    return { ok: false, error: "favorites_file_invalid" }
  } finally {
    try {
      fs.closeSync(fd)
    } catch {}
  }
}

export function readFavorites(adkRoot: string): DocFavoritesData {
  const res = readFavoritesSecure(adkRoot)
  if (res.ok) {
    return res.data
  }
  return { schemaVersion: 1, items: [] }
}

export function saveFavorites(adkRoot: string, data: DocFavoritesData): void {
  const filePath = getFavoritesFilePath(adkRoot)
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })

  const tempPath = path.join(
    dir,
    `.tmp-doc-favorites-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
  )

  const content = JSON.stringify(data, null, 2)
  fs.writeFileSync(tempPath, content, "utf-8")
  fs.renameSync(tempPath, filePath)
}
