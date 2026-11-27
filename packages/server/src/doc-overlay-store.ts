// Non-git AX document overlay store.
//
// `PUT /api/portal/doc` used to write straight into the git checkout, which a
// periodic `git reset --hard` (or a read-only `ProtectSystem=strict` mount)
// wipes out. This SQLite overlay sits beside the checkout: dashboard edits
// land here first and survive any baseline reset. Reads check the overlay
// before falling back to the git baseline.
//
// Selection is fully generic: the database path comes from `NAIA_AX_DOC_STORE`
// (absolute, or relative to the workspace root); otherwise a workspace-local
// default under `.agents/work/state/` is used. No workspace-specific names.
import { DatabaseSync } from "node:sqlite"
import { chmodSync, closeSync, constants, fchmodSync, mkdirSync, openSync, statSync } from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex")
}

export interface OverlayEntry {
  source: string
  path: string
  content: string
  updatedAt: string
  updatedBy: string
  baseGitSha: string
  revision: number
}

export interface OverlayMeta {
  source: string
  path: string
  updatedAt: string
  updatedBy: string
  baseGitSha: string
  revision: number
}

export function overlayDbPath(root: string, env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): string {
  const raw = typeof env.NAIA_AX_DOC_STORE === "string" ? env.NAIA_AX_DOC_STORE.trim() : ""
  if (raw) return path.isAbsolute(raw) ? raw : path.join(root, raw)
  return path.join(root, ".agents", "work", "state", "ax-doc-overlay.sqlite")
}

const SOURCE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/

// Same confinement shape as the portal doc routes: no absolute paths, no
// parent escapes, no hidden segments, markdown only.
export function normalizeOverlayPath(raw: string): string | null {
  if (typeof raw !== "string" || !raw) return null
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) return null
  const clean = raw.replace(/\\/g, "/")
  const segments = clean.split("/").filter((s) => s.length > 0)
  if (segments.length === 0) return null
  if (segments.some((s) => s === "." || s === ".." || s.startsWith("."))) return null
  const joined = segments.join("/")
  if (!joined.toLowerCase().endsWith(".md")) return null
  if (joined.length > 1024) return null
  return joined
}

export function isValidOverlaySource(source: string): boolean {
  return typeof source === "string" && SOURCE_RE.test(source)
}

function fail(message: string, statusCode = 400): never {
  throw Object.assign(new Error(message), { statusCode })
}

// The overlay DB holds dashboard edits: folder 0700, files 0600 whatever the umask.
function prepareDbFiles(dbPath: string): void {
  const dir = path.dirname(dbPath)
  mkdirSync(path.dirname(dir), { recursive: true })
  try {
    mkdirSync(dir, { mode: 0o700 })
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error
    try {
      const mode = statSync(dir).mode & 0o777
      if (mode & 0o077) {
        // Keep serving; an existing shared folder is the deployer's choice.
      }
    } catch {}
  }
  const file = openSync(dbPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
  try {
    fchmodSync(file, 0o600)
  } finally {
    closeSync(file)
  }
  for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      chmodSync(sidecar, 0o600)
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error
    }
  }
}

export class DocOverlayStore {
  readonly db: DatabaseSync

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") prepareDbFiles(dbPath)
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS doc_overlays(
        source TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL,
        updated_at TEXT NOT NULL, updated_by TEXT NOT NULL, base_git_sha TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY(source, path));
      CREATE TABLE IF NOT EXISTS doc_revisions(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL,
        updated_at TEXT NOT NULL, updated_by TEXT NOT NULL, base_git_sha TEXT NOT NULL,
        revision INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS doc_revisions_lookup ON doc_revisions(source, path, revision);`)
  }

  close(): void {
    this.db.close()
  }

  get(source: string, docPath: string): OverlayEntry | null {
    const row = this.db.prepare(
      "SELECT source, path, content, updated_at, updated_by, base_git_sha, revision FROM doc_overlays WHERE source=? AND path=?",
    ).get(source, docPath) as any
    if (!row) return null
    return {
      source: String(row.source),
      path: String(row.path),
      content: String(row.content),
      updatedAt: String(row.updated_at),
      updatedBy: String(row.updated_by),
      baseGitSha: String(row.base_git_sha),
      revision: Number(row.revision),
    }
  }

  list(): OverlayMeta[] {
    return (this.db.prepare(
      "SELECT source, path, updated_at, updated_by, base_git_sha, revision FROM doc_overlays ORDER BY source, path",
    ).all() as any[]).map((row) => ({
      source: String(row.source),
      path: String(row.path),
      updatedAt: String(row.updated_at),
      updatedBy: String(row.updated_by),
      baseGitSha: String(row.base_git_sha),
      revision: Number(row.revision),
    }))
  }

  put(params: {
    source: string
    path: string
    content: string
    updatedBy?: string
    baseGitSha?: string
    now?: Date
    /**
     * 낙관적 동시성 검사(CAS) 기대값. `undefined`이면 검사하지 않는다.
     * 문자열이면 현재 오버레이 본문의 sha256과 같아야 하고, `null`이면
     * 오버레이 행이 없어야 한다. 다르면 409로 거절한다.
     */
    expectedBaseHash?: string | null
  }): OverlayEntry {
    const source = params.source
    const normPath = normalizeOverlayPath(params.path)
    if (!isValidOverlaySource(source) || !normPath) fail("Invalid source or path", 400)
    if (typeof params.content !== "string") fail("Invalid content", 400)
    if (Buffer.byteLength(params.content, "utf-8") > 2 * 1024 * 1024) fail("Content exceeds 2MB limit", 400)
    if (params.expectedBaseHash !== undefined && params.expectedBaseHash !== null && typeof params.expectedBaseHash !== "string") {
      fail("Invalid expected base hash", 400)
    }
    const updatedAt = (params.now ?? new Date()).toISOString()
    const updatedBy = typeof params.updatedBy === "string" && params.updatedBy.trim()
      ? params.updatedBy.trim().slice(0, 128)
      : "dashboard"
    const baseGitSha = typeof params.baseGitSha === "string" ? params.baseGitSha.slice(0, 128) : ""
    // 기대 해시 확인(CAS) + 리비전 번호 할당 + 현재 행 upsert + 이력 행
    // insert를 하나의 BEGIN IMMEDIATE 트랜잭션에 묶는다. 여러 프로세스가
    // 동시에 써도 같은 리비전을 할당하거나 조용히 덮어쓰지 못한다.
    this.db.exec("BEGIN IMMEDIATE")
    try {
      if (params.expectedBaseHash !== undefined) {
        const current = this.db.prepare(
          "SELECT content FROM doc_overlays WHERE source=? AND path=?",
        ).get(source, normPath) as any
        const currentHash = current ? sha256Hex(String(current.content)) : null
        if (currentHash !== params.expectedBaseHash) fail("changed", 409)
      }
      const maxRow = this.db.prepare(
        "SELECT COALESCE(MAX(revision), 0) AS max_revision FROM doc_revisions WHERE source=? AND path=?",
      ).get(source, normPath) as any
      const revision = Number(maxRow?.max_revision ?? 0) + 1
      if (!Number.isSafeInteger(revision) || revision < 1) fail("Revision allocation failed", 500)
      this.db.prepare(
        `INSERT INTO doc_overlays(source, path, content, updated_at, updated_by, base_git_sha, revision)
         VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(source, path) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at,
           updated_by=excluded.updated_by, base_git_sha=excluded.base_git_sha, revision=excluded.revision`,
      ).run(source, normPath, params.content, updatedAt, updatedBy, baseGitSha, revision)
      this.db.prepare(
        "INSERT INTO doc_revisions(source, path, content, updated_at, updated_by, base_git_sha, revision) VALUES(?,?,?,?,?,?,?)",
      ).run(source, normPath, params.content, updatedAt, updatedBy, baseGitSha, revision)
      this.db.exec("COMMIT")
      return { source, path: normPath, content: params.content, updatedAt, updatedBy, baseGitSha, revision }
    } catch (error) {
      try {
        this.db.exec("ROLLBACK")
      } catch {}
      throw error
    }
  }

  /**
   * 실패한 오버레이 커밋을 되돌린다: 실패한 `revision` 행을 `doc_revisions`에서
   * 지우고, `doc_overlays` 현재 행을 `previousRow`로 되돌린다(새로 생긴
   * 행이었으면 지운다). rename 직전 409처럼 체크아웃 쓰기를 거부하면서
   * 오버레이만 앞서간 경우에 둘을 함께 거부한다. 동시 작성자가 이미
   * 덮어썼으면(현재 리비전이 다르면) 현재 행은 건드리지 않는다.
   */
  rollbackRevision(source: string, docPath: string, revision: number, previousRow: OverlayEntry | null): void {
    const normPath = normalizeOverlayPath(docPath)
    if (!isValidOverlaySource(source) || !normPath) fail("Invalid source or path", 400)
    if (!Number.isSafeInteger(revision) || revision < 1) fail("Invalid revision", 400)
    if (previousRow !== null && (previousRow.source !== source || previousRow.path !== normPath)) {
      fail("Revision mismatch", 400)
    }
    this.db.exec("BEGIN IMMEDIATE")
    try {
      this.db.prepare(
        "DELETE FROM doc_revisions WHERE source=? AND path=? AND revision=?",
      ).run(source, normPath, revision)
      const current = this.db.prepare(
        "SELECT revision FROM doc_overlays WHERE source=? AND path=?",
      ).get(source, normPath) as any
      if (current === undefined || current === null) {
        if (previousRow !== null) {
          this.db.prepare(
            `INSERT INTO doc_overlays(source, path, content, updated_at, updated_by, base_git_sha, revision)
             VALUES(?,?,?,?,?,?,?)`,
          ).run(
            previousRow.source,
            previousRow.path,
            previousRow.content,
            previousRow.updatedAt,
            previousRow.updatedBy,
            previousRow.baseGitSha,
            previousRow.revision,
          )
        }
      } else if (Number(current.revision) === revision) {
        if (previousRow === null) {
          this.db.prepare("DELETE FROM doc_overlays WHERE source=? AND path=?").run(source, normPath)
        } else {
          this.db.prepare(
            `UPDATE doc_overlays SET content=?, updated_at=?, updated_by=?, base_git_sha=?, revision=?
             WHERE source=? AND path=?`,
          ).run(
            previousRow.content,
            previousRow.updatedAt,
            previousRow.updatedBy,
            previousRow.baseGitSha,
            previousRow.revision,
            source,
            normPath,
          )
        }
      }
      this.db.exec("COMMIT")
    } catch (error) {
      try {
        this.db.exec("ROLLBACK")
      } catch {}
      throw error
    }
  }

  history(source: string, docPath: string, limit = 50): OverlayEntry[] {
    const n = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 500) : 50
    return (this.db.prepare(
      "SELECT source, path, content, updated_at, updated_by, base_git_sha, revision FROM doc_revisions WHERE source=? AND path=? ORDER BY revision DESC LIMIT ?",
    ).all(source, docPath, n) as any[]).map((row) => ({
      source: String(row.source),
      path: String(row.path),
      content: String(row.content),
      updatedAt: String(row.updated_at),
      updatedBy: String(row.updated_by),
      baseGitSha: String(row.base_git_sha),
      revision: Number(row.revision),
    }))
  }
}
