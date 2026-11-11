import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { canonicalBytes, hashBytes, PublishError } from "./publish-bundle.js"
import { openRegularFile } from "./publish-files.js"

export interface OperationScope {
  actor_id: string
  slug: string
  action: "request-review" | "approve"
  key_hash: string
}

export interface PublishOperation {
  operation_id: string
  scope: OperationScope
  request_hash: string
  state: "processing" | "committed" | "retry_wait" | "rejected"
  requester_id: string
  assignee_ids?: string[]
  owner?: { pid: number; started: string }
  updated_at: string
  result?: Record<string, unknown>
  code?: string
}

export type PublishFault = (point: string) => void

function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep)
}

export function privateDirectory(directory: string): string {
  if (!path.isAbsolute(directory)) throw new PublishError(503, "PUBLISH_CONFIG_INVALID", "게시 저장소 설정을 확인하지 못했습니다")
  const absolute = path.resolve(directory)
  let current = path.parse(absolute).root
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 })
    const stat = fs.lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PublishError(503, "PUBLISH_CONFIG_INVALID", "게시 저장소 설정을 확인하지 못했습니다")
  }
  if (fs.statSync(absolute).mode & 0o077) throw new PublishError(503, "PUBLISH_CONFIG_INVALID", "게시 저장소 접근 권한을 확인해 주세요")
  return fs.realpathSync(absolute)
}

export function assertPrivatePlacement(stateDir: string, sourceRoots: string[], signingKey?: string): void {
  const state = fs.realpathSync(stateDir)
  const key = signingKey ? fs.realpathSync(signingKey) : null
  if (key && inside(key, state)) throw new PublishError(503, "PUBLISH_CONFIG_INVALID", "서명키는 게시 저장소 밖에 두어야 합니다")
  if (key) {
    // A linked worktree uses a .git file; ordinary repositories use a directory.
    for (let directory = path.dirname(key); ; directory = path.dirname(directory)) {
      if (fs.existsSync(path.join(directory, ".git"))) throw new PublishError(503, "PUBLISH_CONFIG_INVALID", "서명키는 깃 작업 트리 밖에 두어야 합니다")
      if (directory === path.dirname(directory)) break
    }
  }
  for (const root of sourceRoots) {
    const real = fs.realpathSync(root)
    if (inside(state, real) || inside(real, state) || (key && inside(key, real))) {
      throw new PublishError(503, "PUBLISH_CONFIG_INVALID", "게시 저장소와 서명키는 문서 출처 밖에 두어야 합니다")
    }
  }
}

export class PublishStore {
  readonly root: string
  constructor(root: string, readonly fault: PublishFault = () => {}) {
    this.root = privateDirectory(root)
    for (const name of ["descriptors", "objects", "reviews", "approvals", "operations", "selections", "reservations"]) {
      const target = path.join(this.root, name)
      if (!fs.existsSync(target)) fs.mkdirSync(target, { mode: 0o700 })
      if (fs.lstatSync(target).isSymbolicLink() || !fs.statSync(target).isDirectory()) throw new Error("private directory")
    }
  }

  file(relative: string): string {
    const target = path.resolve(this.root, relative)
    if (!inside(target, this.root)) throw new Error("private path")
    let current = this.root
    for (const part of path.relative(this.root, target).split(path.sep)) {
      current = path.join(current, part)
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error("private link")
    }
    return target
  }

  json<T = any>(relative: string): T | null {
    const file = this.file(relative)
    try {
      const { fd, stat } = openRegularFile(file)
      try {
        if (stat.size > 8 * 1024 * 1024) throw new Error("private file")
        return JSON.parse(fs.readFileSync(fd, "utf8"))
      } finally { fs.closeSync(fd) }
    } catch (error: any) {
      if (error.code === "ENOENT") return null
      throw error
    }
  }

  directories(relative: string): string[] {
    return fs.readdirSync(this.file(relative), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name).sort()
  }

  syncDir(directory: string): void {
    const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
    try { this.fault("sync"); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  }

  write(file: string, bytes: Buffer): void {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600)
    try { fs.writeFileSync(fd, bytes); this.fault("sync"); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  }

  atomic(relative: string, files: Record<string, Buffer>, commit: Record<string, unknown>): boolean {
    const destination = this.file(relative)
    const parent = path.dirname(destination)
    if (this.json(`${relative}/commit.json`)) {
      this.syncDir(parent)
      return false
    }
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
    this.syncDir(path.dirname(parent))
    const staging = path.join(parent, `.pending-${crypto.randomUUID()}`)
    fs.mkdirSync(staging, { mode: 0o700 })
    for (const [name, bytes] of Object.entries(files)) {
      const target = path.resolve(staging, name)
      if (!inside(target, staging)) throw new Error("private object path")
      this.fault(name === "task.json" ? "task_write" : "record_write")
      this.write(target, bytes)
      if (name === "task.json") this.fault("task_sync")
    }
    this.write(path.join(staging, "commit.json"), canonicalBytes(commit))
    const syncTree = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) syncTree(path.join(directory, entry.name))
      this.syncDir(directory)
    }
    syncTree(staging)
    this.fault("before_commit")
    if (relative.startsWith("reviews/")) this.fault("review_commit")
    fs.renameSync(staging, destination)
    // Readers can recover this record as soon as rename succeeds. Never remove
    // it after that point; a failed directory sync must be retried in place.
    this.syncDir(parent)
    if (relative.startsWith("approvals/")) this.fault("approval_commit")
    this.fault("after_commit")
    return true
  }

  reserveOperation(operation: PublishOperation): PublishOperation {
    const directory = `reservations/${operation.operation_id}`
    const relative = `${directory}/commit.json`
    const check = (existing: PublishOperation): PublishOperation => {
      if (existing.operation_id !== operation.operation_id || hashBytes(canonicalBytes(existing.scope)) !== hashBytes(canonicalBytes(operation.scope)) || existing.request_hash !== operation.request_hash) {
        throw new PublishError(409, "IDEMPOTENCY_CONFLICT", "같은 멱등키에 다른 요청을 보낼 수 없습니다")
      }
      this.syncDir(this.file("reservations"))
      return existing
    }
    const existing = this.json<PublishOperation>(relative)
    if (existing) return check(existing)
    const temporary = this.file(`reservations/.reservation-${crypto.randomUUID()}`)
    fs.mkdirSync(temporary, { mode: 0o700 })
    this.write(path.join(temporary, "commit.json"), canonicalBytes(operation))
    this.syncDir(temporary)
    try {
      // A complete nonempty directory cannot be replaced by another reservation.
      fs.renameSync(temporary, this.file(directory))
    } catch (error: any) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error
      fs.unlinkSync(path.join(temporary, "commit.json"))
      fs.rmdirSync(temporary)
    }
    const reserved = this.json<PublishOperation>(relative)
    if (!reserved) throw new Error("operation reservation missing")
    return check(reserved)
  }

  saveOperation(operation: PublishOperation): void {
    const directory = this.file(`operations/${operation.operation_id}`)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.syncDir(path.dirname(directory))
    const temporary = path.join(directory, `.operation-${crypto.randomUUID()}`)
    this.fault("operation_write")
    this.write(temporary, canonicalBytes(operation))
    fs.renameSync(temporary, path.join(directory, "state.json"))
    this.syncDir(directory)
  }

  committedRecords(kind: "reviews" | "approvals" | "selections", operationId?: string): any[] {
    const records: any[] = []
    const parents = new Set<string>()
    for (const first of this.directories(kind)) {
      const relatives = kind !== "approvals" ? [`${kind}/${first}`] : this.directories(`approvals/${first}`).map((revision) => `approvals/${first}/${revision}`)
      for (const relative of relatives) {
        const commit = this.json(`${relative}/commit.json`)
        if (commit && (!operationId || commit.operation?.operation_id === operationId)) {
          parents.add(path.dirname(this.file(relative)))
          records.push({ ...commit, relative })
        }
      }
    }
    // Sync after reading every record so each observed rename is durable before
    // any records escape, including records committed during this scan.
    for (const parent of parents) this.syncDir(parent)
    return records
  }

  recover(operation: PublishOperation): PublishOperation | null {
    const boundResult = this.json(`operations/${operation.operation_id}/result/commit.json`)
    if (boundResult) {
      if (hashBytes(canonicalBytes(boundResult.operation.scope)) !== hashBytes(canonicalBytes(operation.scope)) || boundResult.operation.request_hash !== operation.request_hash) throw new PublishError(409, "IDEMPOTENCY_CONFLICT", "같은 멱등키에 다른 요청을 보낼 수 없습니다")
      this.syncDir(this.file(`operations/${operation.operation_id}`))
      return { ...operation, state: "committed", result: boundResult.result }
    }
    for (const kind of ["approvals", "selections"] as const) {
      for (const record of this.committedRecords(kind, operation.operation_id)) {
        if (hashBytes(canonicalBytes(record.operation.scope)) !== hashBytes(canonicalBytes(operation.scope)) || record.operation.request_hash !== operation.request_hash) {
          throw new PublishError(409, "IDEMPOTENCY_CONFLICT", "같은 멱등키에 다른 요청을 보낼 수 없습니다")
        }
        return { ...operation, state: "committed", result: record.result }
      }
    }
    return null
  }
}
