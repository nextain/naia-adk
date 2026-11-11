import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { performance } from "node:perf_hooks"
import { buildPublishBundle, canonicalBytes, hashBytes, PublishError, type PublishDescriptor, type PublishBundle } from "./publish-bundle.js"
import { PublishStore, assertPrivatePlacement, type PublishFault, type PublishOperation } from "./publish-store.js"
import { withPublishLock } from "./publish-lock.js"
import { canApprove, requireApprover } from "./publish-identity.js"
import { getSourcesAndBoard, resolveSecureFile, resolveSecureDir, resolveSourceBase, isHiddenPath, type ResolvedSource } from "./routes/portal.js"
import type { FolderCheckContext } from "./view-folders.js"
import { FileLockTimeoutError } from "./file-lock.js"
import { openRegularFile, readRegularFile } from "./publish-files.js"

export type ApprovalReceipt = {
  receipt_id: string; slug: string; revision_id: string; approved_hash: string; approver_id: string
  approved_at: string; targets: string[]; languages: Record<string, string[]>; date: string
  media_map_hash: string; preview_hashes: Record<string, Record<string, string>>; action: "approve"; key_id: string; signature: string
}

const receiptFields = ["receipt_id", "slug", "revision_id", "approved_hash", "approver_id", "approved_at", "targets", "languages", "date", "media_map_hash", "preview_hashes", "action", "key_id", "signature"].sort()
const activeOperations = new Map<string, string>()

function checkInputReadFailure(cause: unknown, field: string): void {
  if (!cause || ["ENOENT", "ENOTDIR", "EISDIR", "ELOOP", "EMLINK", "ESTALE", "ENAMETOOLONG"].includes((cause as NodeJS.ErrnoException).code ?? "")) return
  throw new PublishError(503, "PUBLISH_UNAVAILABLE", "문서·그림을 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.", field)
}

function processStart(pid: number): string {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? ""
  } catch { return "" }
}

export function verifyApprovalReceipt(receipt: ApprovalReceipt, publicKeys: Record<string, string>): boolean {
  try {
    if (JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(receiptFields) || !publicKeys[receipt.key_id] || receipt.action !== "approve") return false
    const { signature, ...unsigned } = receipt
    if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) return false
    return crypto.verify(null, canonicalBytes(unsigned), publicKeys[receipt.key_id], Buffer.from(signature, "base64url"))
  } catch { return false }
}

export class PublishService {
  readonly store: PublishStore
  constructor(readonly workspace: string, readonly env: NodeJS.ProcessEnv = process.env, readonly folderContext?: FolderCheckContext, fault?: PublishFault) {
    if (!env.PUBLISH_STATE_DIR) throw new PublishError(503, "PUBLISH_CONFIG_INVALID", "게시 저장소가 설정되지 않았습니다")
    this.store = new PublishStore(env.PUBLISH_STATE_DIR, fault)
  }

  async placement(): Promise<void> {
    const { resolvedSources } = await getSourcesAndBoard(this.workspace, this.folderContext)
    assertPrivatePlacement(this.store.root, [...resolvedSources.values()].map((source) => source.baseDir), this.env.PUBLISH_SIGNING_KEY_FILE)
  }

  async document(sourceId: string, documentPath: string) {
    await this.placement()
    const source = resolveSourceBase(this.workspace, sourceId, this.folderContext)
    if (!source) throw new PublishError(403, "DOCUMENT_FORBIDDEN", "문서를 열람할 수 없습니다")
    const relative = path.relative(source.baseDir, path.resolve(source.baseDir, documentPath)).split(path.sep).join("/")
    if (relative !== documentPath || relative === ".." || relative.startsWith("../") || documentPath.includes("\\") || documentPath.includes("\0")) throw new PublishError(400, "REQUEST_INVALID", "문서 경로를 확인해 주세요")
    const checked = resolveSecureFile(source, documentPath, { rejectLinks: true })
    if (isHiddenPath(documentPath) || !documentPath.endsWith(".md") || "error" in checked) {
      if ("error" in checked) checkInputReadFailure(checked.cause, "source")
      throw new PublishError(403, "DOCUMENT_FORBIDDEN", "문서를 열람할 수 없습니다")
    }
    let slug: string | null = null
    for (const entry of fs.readdirSync(this.store.file("descriptors"), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || !entry.name.endsWith(".json")) continue
      const candidate = entry.name.slice(0, -5)
      if (!entry.isFile() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate)) throw new PublishError(422, "DESCRIPTOR_INVALID", "게시 설정을 확인해 주세요", "descriptor")
      let descriptor: PublishDescriptor | null
      try { descriptor = this.store.json<PublishDescriptor>(`descriptors/${entry.name}`) } catch (error) {
        if (error instanceof SyntaxError) throw new PublishError(422, "DESCRIPTOR_INVALID", "게시 설정을 올바른 JSON으로 저장해 주세요", "descriptor")
        throw error
      }
      if (!descriptor || descriptor.slug !== candidate || typeof descriptor.source !== "string" || typeof descriptor.path !== "string") throw new PublishError(422, "DESCRIPTOR_INVALID", "게시 설정을 확인해 주세요", "descriptor")
      if (descriptor.source !== sourceId || descriptor.path !== documentPath) continue
      if (slug !== null) throw new PublishError(503, "DESCRIPTOR_AMBIGUOUS", "문서의 게시 설정이 중복되어 있습니다", "descriptor")
      slug = candidate
    }
    return { ok: true, slug, can_request_review: slug !== null && !source.readOnly }
  }

  descriptor(slug: string, write = false): { descriptor: PublishDescriptor; source: ResolvedSource } {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new PublishError(404, "PUBLISH_NOT_FOUND", "게시 대상을 찾지 못했습니다")
    let descriptor: PublishDescriptor | null
    try { descriptor = this.store.json<PublishDescriptor>(`descriptors/${slug}.json`) } catch (error) {
      if (error instanceof SyntaxError) throw new PublishError(422, "DESCRIPTOR_INVALID", "게시 설정을 올바른 JSON으로 저장해 주세요", "descriptor")
      throw error
    }
    if (!descriptor) throw new PublishError(404, "PUBLISH_NOT_FOUND", "게시 대상을 찾지 못했습니다")
    if (descriptor.slug !== slug || typeof descriptor.source !== "string" || typeof descriptor.path !== "string") throw new PublishError(422, "DESCRIPTOR_INVALID", "게시 설정을 확인해 주세요")
    const source = resolveSourceBase(this.workspace, descriptor.source, this.folderContext)
    if (!source) throw new PublishError(404, "PUBLISH_NOT_FOUND", "문서 출처를 찾지 못했습니다")
    if (write && source.readOnly) throw new PublishError(403, "DOCUMENT_READ_ONLY", "읽기 전용 문서는 확인을 요청할 수 없습니다")
    const relative = path.relative(source.baseDir, path.resolve(source.baseDir, descriptor.path)).split(path.sep).join("/")
    const allowed = relative === descriptor.path && !isHiddenPath(relative) && descriptor.path.endsWith(".md") && (source.allowedPrefixes === null || source.allowedPrefixes.some((prefix) => relative.startsWith(prefix.replace(/\/$/, "") + "/")))
    const checked = resolveSecureFile(source, descriptor.path, { rejectLinks: true })
    if ("error" in checked || !descriptor.path.endsWith(".md")) {
      if ("error" in checked) checkInputReadFailure(checked.cause, "source")
      if ("error" in checked && checked.reason === "not_file" && descriptor.path.endsWith(".md")) throw new PublishError(422, "DOCUMENT_INVALID", "원고는 실제 문서 파일이어야 합니다", "source")
      if (allowed) {
        try { fs.lstatSync(path.join(source.baseDir, relative)) } catch (error: any) {
          checkInputReadFailure(error, "source")
          if (error.code === "ENOENT" || error.code === "ENOTDIR") throw new PublishError(404, "DOCUMENT_NOT_FOUND", "문서를 찾지 못했습니다")
        }
      }
      throw new PublishError(403, "DOCUMENT_FORBIDDEN", "문서를 열람할 수 없습니다")
    }
    if (!Array.isArray(descriptor.asset_roots) || descriptor.asset_roots.some((root) => typeof root !== "string")) throw new PublishError(422, "DESCRIPTOR_INVALID", "그림 폴더 설정을 확인해 주세요", "asset_roots")
    for (const relative of descriptor.asset_roots) {
      const checked = resolveSecureDir(source, path.posix.join(path.posix.dirname(descriptor.path), relative))
      if ("error" in checked) {
        checkInputReadFailure(checked.cause, "asset_roots")
        throw new PublishError(422, "ASSET_INVALID", "그림 폴더를 확인해 주세요")
      }
    }
    return { descriptor, source }
  }

  async bundle(slug: string, write = false, expectedInputHash?: string): Promise<PublishBundle> {
    await this.placement()
    let resolved: ReturnType<PublishService["descriptor"]>
    try { resolved = this.descriptor(slug, write) } catch (error) {
      if (expectedInputHash && error instanceof PublishError && [404, 422].includes(error.status)) throw new PublishError(409, "PREVIEW_CHANGED", "내용이 바뀌었습니다. 다시 확인해 주세요")
      throw error
    }
    const { descriptor, source } = resolved
    const bundle = await buildPublishBundle(descriptor, source.baseDir, expectedInputHash)
    for (const asset of bundle.assets) {
      const checked = resolveSecureFile(source, asset.source_path, { rejectLinks: true })
      if ("error" in checked) {
        checkInputReadFailure(checked.cause, asset.path)
        throw new PublishError(422, "ASSET_INVALID", "그림을 열람할 수 없습니다", asset.path)
      }
    }
    return bundle
  }

  reviewers(): string[] {
    const ids = (this.env.PUBLISH_APPROVER_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean)
    if (!ids.length || ids.some((id) => !canApprove(id, this.env))) throw new PublishError(503, "APPROVER_CONFIG_INVALID", "승인 계정 설정을 확인하지 못했습니다")
    return [...new Set(ids)].sort()
  }

  reviews(slug?: string): any[] { return this.store.committedRecords("reviews").filter((record) => !slug || record.slug === slug) }
  approvals(slug?: string): any[] { return this.store.committedRecords("approvals").filter((record) => !slug || record.slug === slug) }

  review(slug: string, reviewId: string, revisionId: string): any {
    if (!/^review_[a-f0-9]{64}$/.test(reviewId) || !/^rev_[a-f0-9]{64}$/.test(revisionId)) throw new PublishError(400, "REQUEST_INVALID", "확인 요청판을 지정해 주세요")
    const review = this.store.json(`reviews/${reviewId}/commit.json`)
    if (!review || review.slug !== slug || review.revision_id !== revisionId) throw new PublishError(404, "REVIEW_NOT_FOUND", "확인 요청판을 찾지 못했습니다")
    return review
  }

  persistBundle(bundle: PublishBundle): void {
    this.store.atomic(`objects/${bundle.preview_hash}`, bundle.files, { schema_version: 1, preview_hash: bundle.preview_hash, revision_id: bundle.revision_id })
  }

  operation(actor: string, slug: string, action: "request-review" | "approve", key: string, input: Record<string, unknown>): PublishOperation {
    if (!/^[\x21-\x7e]{1,200}$/.test(key) || key.includes(",")) throw new PublishError(400, "IDEMPOTENCY_KEY_REQUIRED", "멱등키를 지정해 주세요")
    const scope = { actor_id: actor, slug, action, key_hash: hashBytes(Buffer.from(key)) }
    const operation_id = `op_${hashBytes(canonicalBytes(scope))}`
    const request_hash = hashBytes(canonicalBytes(input))
    const existing = this.store.json<PublishOperation>(`operations/${operation_id}/state.json`)
    if (existing && existing.request_hash !== request_hash) throw new PublishError(409, "IDEMPOTENCY_CONFLICT", "같은 멱등키에 다른 요청을 보낼 수 없습니다")
    return existing ?? { operation_id, scope, request_hash, state: "processing", requester_id: actor, updated_at: new Date().toISOString() }
  }

  async execute(actor: string, slug: string, action: "request-review" | "approve", key: string, input: Record<string, unknown>, perform: (op: PublishOperation) => Promise<Record<string, unknown>>): Promise<{ status: number; body: any }> {
    await this.placement()
    const operation = this.store.reserveOperation(this.operation(actor, slug, action, key, input))
    const recovered = this.store.recover(operation)
    if (recovered?.result || (operation.state === "committed" && operation.result)) {
      const result = recovered?.result ?? operation.result!
      this.checkResultAccess(slug, result, true)
      return { status: 200, body: result }
    }
    const activeKey = `${this.store.root}/${operation.operation_id}`
    const pendingResponse = { status: 202, body: { ok: true, state: "processing", operation_id: operation.operation_id } }
    const activeHash = activeOperations.get(activeKey)
    if (activeHash && activeHash !== operation.request_hash) throw new PublishError(409, "IDEMPOTENCY_CONFLICT", "같은 멱등키에 다른 요청을 보낼 수 없습니다")
    if (activeHash) return pendingResponse
    activeOperations.set(activeKey, operation.request_hash)
    try {
      return await withPublishLock(async () => {
        const latest = this.operation(actor, slug, action, key, input)
        const committed = this.store.recover(latest)
        if (committed?.result || (latest.state === "committed" && latest.result)) {
          const result = committed?.result ?? latest.result!
          this.checkResultAccess(slug, result, true)
          return { status: 200, body: result }
        }
        const pending = { ...latest, assignee_ids: latest.assignee_ids ?? this.reviewers(), owner: { pid: process.pid, started: processStart(process.pid) }, state: "processing" as const, updated_at: new Date().toISOString() }
        this.store.saveOperation(pending)
        try {
          const result = await perform(pending)
          this.store.atomic(`operations/${pending.operation_id}/result`, { "result.json": canonicalBytes(result) }, { operation: pending, result })
          this.store.saveOperation({ ...pending, state: "committed", result, updated_at: new Date().toISOString() })
          return { status: 201, body: result }
        } catch (error: any) {
          const retryable = !(error instanceof PublishError) || error.status >= 500
          try { this.store.saveOperation({ ...pending, state: retryable ? "retry_wait" : "rejected", code: error.code ?? "PUBLISH_UNAVAILABLE", updated_at: new Date().toISOString() }) } catch {}
          error.operation_id = operation.operation_id
          throw error
        }
      }, this.store.root, 0)
    } catch (error) {
      if (error instanceof FileLockTimeoutError) return pendingResponse
      throw error
    } finally { activeOperations.delete(activeKey) }
  }

  checkResultAccess(slug: string, result: Record<string, unknown>, write = false): void {
    const revision = result.revision_id
    if (typeof revision !== "string" || !/^rev_[a-f0-9]{64}$/.test(revision)) throw new PublishError(503, "OBJECT_INVALID", "보관판을 확인하지 못했습니다")
    const manifest = this.store.json(`objects/${revision.slice(4)}/manifest.json`)
    const source: ResolvedSource | null = manifest ? resolveSourceBase(this.workspace, manifest.source, this.folderContext) : null
    if (!manifest || manifest.slug !== slug || !source || (write && source.readOnly) || typeof manifest.path !== "string" || (source.allowedPrefixes !== null && !source.allowedPrefixes.some((prefix) => manifest.path.startsWith(prefix.replace(/\/$/, "") + "/")))) throw new PublishError(403, "DOCUMENT_FORBIDDEN", "문서를 열람할 수 없습니다")
  }

  async requestReview(actor: string, slug: string, key: string, input: { saved_revision: string }) {
    return this.execute(actor, slug, "request-review", key, input, async (operation) => {
      const bundle = await this.bundle(slug, true)
      if (bundle.manifest.source_hash !== input.saved_revision) throw new PublishError(409, "SAVED_REVISION_CHANGED", "저장판이 바뀌었습니다")
      const assignees = operation.assignee_ids ?? this.reviewers()
      const existing = this.reviews(slug).find((review) => review.revision_id === bundle.revision_id && canonicalBytes(review.assignees).equals(canonicalBytes(assignees)))
      if (existing) {
        this.store.syncDir(this.store.file("reviews"))
        return this.selectReview(existing, operation)
      }
      this.persistBundle(bundle)
      const review_id = `review_${hashBytes(canonicalBytes({ slug, revision_id: bundle.revision_id, kind: "publish_review", assignees }))}`
      const created_at = new Date().toISOString()
      const source = this.descriptor(slug).source
      const query = new URLSearchParams({ tab: source.tab ?? "common", source: bundle.descriptor.source, path: bundle.descriptor.path, publishReview: review_id, publishRevision: bundle.revision_id })
      const review_url = `/docs?${query}`
      const task_id = `task_${review_id.slice(7)}`
      const tasks = assignees.map((assignee_id) => ({ task_id: `${task_id}_${hashBytes(Buffer.from(assignee_id)).slice(0, 12)}`, kind: "publish_review", title: `게시 확인: ${bundle.frontmatter.title}`, assignee_id, slug, review_id, revision_id: bundle.revision_id, saved_revision: input.saved_revision, created_at, review_url }))
      const result = { ok: true, state: "pending_review", review_id, revision_id: bundle.revision_id, saved_revision: input.saved_revision, task_id: tasks[0].task_id, operation_id: operation.operation_id, review_url }
      const request = { slug, review_id, revision_id: bundle.revision_id, saved_revision: input.saved_revision, preview_hash: bundle.preview_hash, input_hash: bundle.input_hash, assignees, requester_id: actor, created_at, operation, result }
      this.store.atomic(`reviews/${review_id}`, { "request.json": canonicalBytes(request), "task.json": canonicalBytes(tasks) }, request)
      return this.selectReview(request, operation)
    })
  }

  currentReview(slug: string): any {
    const selected = this.store.committedRecords("selections").filter((record) => record.slug === slug).sort((a, b) => b.sequence - a.sequence)[0]
    return selected ? this.store.json(`reviews/${selected.review_id}/commit.json`) : null
  }

  selectReview(review: any, operation: PublishOperation): Record<string, unknown> {
    const selections = this.store.committedRecords("selections").filter((record) => record.slug === review.slug)
    const sequence = Math.max(0, ...selections.map((record) => record.sequence)) + 1
    const result = { ...review.result, operation_id: operation.operation_id }
    this.store.atomic(`selections/${operation.operation_id}`, {}, { slug: review.slug, review_id: review.review_id, sequence, operation, result })
    return result
  }

  async preview(actor: string, slug: string, reviewId: string, revisionId: string) {
    return withPublishLock(async () => {
      const review = this.review(slug, reviewId, revisionId)
      this.checkResultAccess(slug, { revision_id: review.revision_id })
      const bundle = await this.bundle(slug, false, review.input_hash)
      if (review.preview_hash !== bundle.preview_hash) throw new PublishError(409, "PREVIEW_CHANGED", "내용이 바뀌었습니다. 다시 확인해 주세요")
      const previews = Object.fromEntries(Object.entries(bundle.previews).map(([site, languages]) => [site, Object.fromEntries(Object.entries(languages).map(([language, preview]: [string, any]) => { const { bytes, ...display } = preview; return [language, display] }))]))
      const writable = !this.descriptor(slug).source.readOnly
      return { ok: true, slug, review_id: reviewId, revision_id: bundle.revision_id, saved_revision: bundle.manifest.source_hash, preview_hash: bundle.preview_hash, preview_hashes: bundle.manifest.preview_hashes, previews, frontmatter: bundle.frontmatter, media_map: bundle.media_map, assets: bundle.manifest.asset_hashes.map(asset => ({ ...asset, url: `/api/portal/publish/${slug}/revisions/${revisionId}/assets/${asset.sha256}` })), issues: [], can_approve: writable && canApprove(actor, this.env) && review.assignees.includes(actor) }
    }, this.store.root)
  }

  async approvedRevision(slug: string, revisionId: string) {
    return withPublishLock(async () => {
      await this.placement()
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || !/^rev_[a-f0-9]{64}$/.test(revisionId)) throw new PublishError(404, "APPROVED_REVISION_NOT_FOUND", "승인판을 찾지 못했습니다")
      const approval = this.store.json(`approvals/${slug}/${revisionId}/commit.json`)
      if (!approval || approval.slug !== slug || approval.revision_id !== revisionId) throw new PublishError(404, "APPROVED_REVISION_NOT_FOUND", "승인판을 찾지 못했습니다")
      this.checkResultAccess(slug, { revision_id: revisionId })
      const invalid = () => new PublishError(503, "OBJECT_INVALID", "보관한 승인판을 확인하지 못했습니다")
      const hash = revisionId.slice(4), prefix = `objects/${hash}`
      const object = this.store.json(`${prefix}/commit.json`)
      const receipt = approval.result?.receipt
      if (approval.approved_hash !== hash || object?.preview_hash !== hash || object?.revision_id !== revisionId || receipt?.slug !== slug || receipt?.revision_id !== revisionId || receipt?.approved_hash !== hash) throw invalid()
      const read = (relative: string, expected: string) => {
        const bytes = readRegularFile(this.store.file(`${prefix}/${relative}`))
        if (hashBytes(bytes) !== expected) throw invalid()
        return JSON.parse(bytes.toString("utf8"))
      }
      const manifest = read("manifest.json", hash)
      const descriptor = read("descriptor.json", manifest.descriptor_hash)
      const media = read("media-map.json", manifest.media_map_hash)
      const previews: Record<string, Record<string, unknown>> = {}
      for (const [site, languages] of Object.entries(manifest.preview_hashes as Record<string, Record<string, string>>)) {
        if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(site)) throw invalid()
        previews[site] = {}
        for (const [language, expected] of Object.entries(languages)) {
          if (!/^[a-z]{2}(?:-[A-Za-z0-9]+)*$/.test(language)) throw invalid()
          previews[site][language] = { ...read(`previews/${site}/${language}.json`, expected), sha256: expected }
        }
      }
      return { ok: true, slug, review_id: approval.review_id, revision_id: revisionId, saved_revision: manifest.source_hash, preview_hash: hash,
        preview_hashes: manifest.preview_hashes, previews, frontmatter: descriptor.frontmatter, media_map: media,
        assets: manifest.asset_hashes.map((asset: any) => ({ ...asset, url: `/api/portal/publish/${slug}/revisions/${revisionId}/assets/${asset.sha256}` })),
        issues: [], can_approve: false, receipt }
    }, this.store.root)
  }

  signingKey(): { key: crypto.KeyObject; keyId: string; publicKeys: Record<string, string> } {
    try {
      const file = this.env.PUBLISH_SIGNING_KEY_FILE
      const keyId = this.env.PUBLISH_SIGNING_KEY_ID
      const publicKeys = JSON.parse(this.env.PUBLISH_PUBLIC_KEYS ?? "{}")
      if (!file || !keyId || !/^[A-Za-z0-9._-]{1,64}$/.test(keyId) || typeof publicKeys[keyId] !== "string") throw new Error("key config")
      const { fd, stat } = openRegularFile(file)
      let pem: Buffer
      try { if (stat.mode & 0o077) throw new Error("key permissions"); pem = fs.readFileSync(fd) } finally { fs.closeSync(fd) }
      const key = crypto.createPrivateKey(pem)
      if (key.asymmetricKeyType !== "ed25519") throw new Error("key type")
      const probe = Buffer.from("publish-key-check")
      if (!crypto.verify(null, probe, publicKeys[keyId], crypto.sign(null, probe, key))) throw new Error("key mismatch")
      return { key, keyId, publicKeys }
    } catch { throw new PublishError(503, "SIGNING_KEY_UNAVAILABLE", "승인 서명키를 확인하지 못했습니다") }
  }

  async approve(actor: string, slug: string, key: string, input: { review_id: string; revision_id: string; saved_revision: string; preview_hash: string }) {
    if (!canApprove(actor, this.env)) throw new PublishError(403, "APPROVER_REQUIRED", "승인 담당 계정이 필요합니다")
    return this.execute(actor, slug, "approve", key, input, async (operation) => {
      const review = this.review(slug, input.review_id, input.revision_id)
      if (!review.assignees.includes(actor)) throw new PublishError(403, "APPROVER_REQUIRED", "승인 담당 계정이 필요합니다")
      this.checkResultAccess(slug, { revision_id: review.revision_id }, true)
      const bundle = await this.bundle(slug, true, review.input_hash)
      if (review.saved_revision !== input.saved_revision || bundle.manifest.source_hash !== input.saved_revision || review.preview_hash !== input.preview_hash || bundle.preview_hash !== input.preview_hash || bundle.revision_id !== input.revision_id) throw new PublishError(409, "PREVIEW_CHANGED", "내용이 바뀌었습니다. 다시 확인해 주세요")
      const relative = `approvals/${slug}/${bundle.revision_id}`
      const existing = this.store.json(`${relative}/commit.json`)
      if (existing) {
        this.store.syncDir(path.dirname(this.store.file(relative)))
        return { ...existing.result, operation_id: operation.operation_id }
      }
      const { key: signingKey, keyId } = this.signingKey()
      const unsigned = { receipt_id: `receipt_${crypto.randomUUID()}`, slug, revision_id: bundle.revision_id, approved_hash: bundle.preview_hash, approver_id: actor, approved_at: new Date().toISOString(), targets: bundle.manifest.targets, languages: bundle.manifest.languages, date: bundle.manifest.date, media_map_hash: bundle.manifest.media_map_hash, preview_hashes: bundle.manifest.preview_hashes, action: "approve" as const, key_id: keyId }
      const receipt = { ...unsigned, signature: crypto.sign(null, canonicalBytes(unsigned), signingKey).toString("base64url") }
      this.persistBundle(bundle)
      const result = { ok: true, state: "approved_waiting_export", operation_id: operation.operation_id, revision_id: bundle.revision_id, approved_hash: bundle.preview_hash, receipt }
      this.store.atomic(relative, { "receipt.json": canonicalBytes(receipt), "state.json": canonicalBytes({ state: "approved_waiting_export", operation_id: operation.operation_id, object: `objects/${bundle.preview_hash}`, receipt_id: receipt.receipt_id }) }, { slug, revision_id: bundle.revision_id, approved_hash: bundle.preview_hash, approved_at: receipt.approved_at, review_id: input.review_id, operation, result })
      return result
    })
  }

  async status(actor: string, slug: string) {
    const started = performance.now()
    return withPublishLock(async () => {
      const approvals = this.approvals(slug).sort((a, b) => b.approved_at.localeCompare(a.approved_at))
      if (approvals.length) this.checkResultAccess(slug, approvals[0].result)
      let bundle: PublishBundle
      try { bundle = await this.bundle(slug) } catch (error) {
        if (!approvals.length || !(error instanceof PublishError) || ![404, 413, 422].includes(error.status)) throw error
        const elapsed_ms = Math.ceil(performance.now() - started)
        return { ok: true, state: "changed_after_approval", revision_id: null, saved_revision: null, preview_hash: null, pending_revision_id: null, review_id: null, approved_revision_id: approvals[0].revision_id, receipt: approvals[0].result.receipt, changed_after_approval: true, can_request_review: false, can_approve: false, draft_error: { code: error.code, message: error.message, issues: error.field ? [{ field: error.field }] : [] }, elapsed_ms, change_display_budget_ms: 5000, max_poll_interval_ms: Math.max(0, 5000 - elapsed_ms - 250) }
      }
      const current = approvals.find((approval) => approval.revision_id === bundle.revision_id)
      const selected = this.currentReview(slug)
      const pending = selected?.revision_id === bundle.revision_id && !current ? selected : null
      const changed = !!approvals.length && approvals[0].revision_id !== bundle.revision_id
      const state = current ? "approved_waiting_export" : pending ? "pending_review" : changed ? "changed_after_approval" : "draft"
      const elapsed_ms = Math.ceil(performance.now() - started)
      const writable = !this.descriptor(slug).source.readOnly
      return { ok: true, state, revision_id: bundle.revision_id, saved_revision: bundle.manifest.source_hash, preview_hash: bundle.preview_hash, pending_revision_id: pending?.revision_id ?? null, review_id: pending?.review_id ?? null, approved_revision_id: (current ?? approvals[0])?.revision_id ?? null, receipt: (current ?? approvals[0])?.result?.receipt ?? null, changed_after_approval: changed, can_request_review: writable, can_approve: writable && !!pending && pending.assignees.includes(actor) && canApprove(actor, this.env), draft_error: null, elapsed_ms, change_display_budget_ms: 5000, max_poll_interval_ms: Math.max(0, 5000 - elapsed_ms - 250) }
    }, this.store.root)
  }

  private reviewTasks(review: any): any[] {
    const invalid = () => new PublishError(503, "REVIEW_TASK_READ_FAILED", "게시 확인 할 일을 불러오지 못했습니다")
    try {
      if (!review || typeof review !== "object" || typeof review.slug !== "string" ||
          !/^review_[a-f0-9]{64}$/.test(review.review_id) || !/^rev_[a-f0-9]{64}$/.test(review.revision_id) ||
          !/^[a-f0-9]{64}$/.test(review.saved_revision) || typeof review.created_at !== "string" ||
          !Number.isFinite(Date.parse(review.created_at)) || !Array.isArray(review.assignees) || !review.assignees.length ||
          review.assignees.some((id: unknown) => typeof id !== "string" || !id) ||
          new Set(review.assignees).size !== review.assignees.length || review.relative !== `reviews/${review.review_id}`) throw invalid()
      const expectedId = `review_${hashBytes(canonicalBytes({ slug: review.slug, revision_id: review.revision_id, kind: "publish_review", assignees: review.assignees }))}`
      if (review.review_id !== expectedId) throw invalid()
      const request = this.store.json(`reviews/${review.review_id}/request.json`)
      const { relative: _relative, ...commit } = review
      if (!request || !canonicalBytes(request).equals(canonicalBytes(commit))) throw invalid()
      const result = review.result
      if (!result || result.review_id !== review.review_id || result.revision_id !== review.revision_id ||
          result.saved_revision !== review.saved_revision || typeof result.review_url !== "string" || !result.review_url.startsWith("/docs?")) throw invalid()
      const url = new URL(result.review_url, "https://portal.invalid")
      if (url.pathname !== "/docs" || url.searchParams.getAll("publishReview").length !== 1 ||
          url.searchParams.get("publishReview") !== review.review_id || url.searchParams.getAll("publishRevision").length !== 1 ||
          url.searchParams.get("publishRevision") !== review.revision_id || url.searchParams.getAll("source").length !== 1 ||
          !url.searchParams.get("source") || url.searchParams.getAll("path").length !== 1 || !url.searchParams.get("path")) throw invalid()
      const tasks = this.store.json<any[]>(`reviews/${review.review_id}/task.json`)
      if (!Array.isArray(tasks) || tasks.length !== review.assignees.length) throw invalid()
      const seen = new Set<string>()
      let title: string | undefined
      for (const task of tasks) {
        if (!task || typeof task !== "object" || typeof task.assignee_id !== "string" ||
            !review.assignees.includes(task.assignee_id) || seen.has(task.assignee_id) ||
            task.task_id !== `task_${review.review_id.slice(7)}_${hashBytes(Buffer.from(task.assignee_id)).slice(0, 12)}` ||
            task.kind !== "publish_review" || task.slug !== review.slug || task.review_id !== review.review_id ||
            task.revision_id !== review.revision_id || task.saved_revision !== review.saved_revision ||
            task.created_at !== review.created_at || task.review_url !== result.review_url ||
            typeof task.title !== "string" || !task.title.trim() || (title !== undefined && task.title !== title)) throw invalid()
        title = task.title
        seen.add(task.assignee_id)
      }
      const firstId = `task_${review.review_id.slice(7)}_${hashBytes(Buffer.from(review.assignees[0])).slice(0, 12)}`
      if (result.task_id !== firstId) throw invalid()
      return tasks
    } catch (error) {
      if (error instanceof PublishError && error.code === "REVIEW_TASK_READ_FAILED") throw error
      throw invalid()
    }
  }

  async todos(actor: string) {
    requireApprover(actor, this.env)
    return withPublishLock(async () => {
      await this.placement()
      const tasks: any[] = []
      const reviews = this.reviews().sort((a, b) => b.created_at.localeCompare(a.created_at))
      const completedRevisions = new Set(this.approvals().map((approval) => `${approval.slug}/${approval.revision_id}`))
      const selections = new Map<string, any>()
      for (const selection of this.store.committedRecords("selections")) {
        if (!selections.has(selection.slug) || selection.sequence > selections.get(selection.slug).sequence) selections.set(selection.slug, selection)
      }
      for (const review of reviews) {
        const stored = this.reviewTasks(review)
        if (!review.assignees.includes(actor)) continue
        this.descriptor(review.slug)
        const completed = completedRevisions.has(`${review.slug}/${review.revision_id}`)
        const superseded = selections.get(review.slug)?.review_id !== review.review_id
        for (const task of stored.filter((task) => task.assignee_id === actor)) tasks.push({ ...task, state: completed ? "completed" : superseded ? "superseded" : "pending_review" })
      }
      return { ok: true, tasks }
    }, this.store.root)
  }

  async operationStatus(actor: string, id: string) {
    await this.placement()
    if (!/^op_[a-f0-9]{64}$/.test(id)) throw new PublishError(404, "OPERATION_NOT_FOUND", "처리 기록을 찾지 못했습니다")
    const operation = this.store.json<PublishOperation>(`operations/${id}/state.json`) ?? this.store.json<PublishOperation>(`reservations/${id}/commit.json`)
    if (!operation) throw new PublishError(404, "OPERATION_NOT_FOUND", "처리 기록을 찾지 못했습니다")
    const resolved = this.store.recover(operation) ?? operation
    if (resolved.result) this.checkResultAccess(operation.scope.slug, resolved.result)
    else this.descriptor(operation.scope.slug)
    const assignees = operation.assignee_ids ?? this.reviews(operation.scope.slug).find((review) =>
      typeof resolved.result?.review_id === "string" ? review.review_id === resolved.result.review_id : review.operation?.operation_id === id
    )?.assignees ?? []
    if (operation.requester_id !== actor && (!canApprove(actor, this.env) || !assignees.includes(actor))) throw new PublishError(403, "OPERATION_FORBIDDEN", "처리 기록을 열람할 수 없습니다")
    return { ok: true, ...resolved }
  }

  async asset(slug: string, revision: string, hash: string): Promise<{ bytes: Buffer; format: string }> {
    await this.placement()
    this.descriptor(slug)
    if (!/^rev_[a-f0-9]{64}$/.test(revision) || !/^[a-f0-9]{64}$/.test(hash)) throw new PublishError(404, "ASSET_NOT_FOUND", "그림을 찾지 못했습니다")
    const commit = this.store.json(`objects/${revision.slice(4)}/commit.json`)
    const manifest = this.store.json(`objects/${revision.slice(4)}/manifest.json`)
    if (!commit || !manifest || manifest.slug !== slug) throw new PublishError(404, "ASSET_NOT_FOUND", "그림을 찾지 못했습니다")
    this.checkResultAccess(slug, { revision_id: revision })
    const asset = manifest.asset_hashes.find((asset: any) => asset.sha256 === hash)
    if (!asset) throw new PublishError(404, "ASSET_NOT_FOUND", "그림을 찾지 못했습니다")
    const bytes = readRegularFile(this.store.file(`objects/${revision.slice(4)}/${asset.path}`))
    if (hashBytes(bytes) !== hash) throw new PublishError(503, "OBJECT_INVALID", "보관판 그림을 확인하지 못했습니다")
    return { bytes, format: asset.format }
  }
}
