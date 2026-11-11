import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import { performance } from "node:perf_hooks"
import { spawn } from "node:child_process"
import http from "node:http"
import { Readable, Writable } from "node:stream"
import { createServer } from "../src/server.js"
import { hashBytes, canonicalBytes, type PublishDescriptor } from "../src/publish-bundle.js"
import { PublishService, verifyApprovalReceipt } from "../src/publish-service.js"
import { PublishStore } from "../src/publish-store.js"
import * as publishLock from "../src/publish-lock.js"
import * as portal from "../src/routes/portal.js"

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64")
const secret = "publish-test-proxy-secret"
const actor = "test-gate:owner"
const headers = { host: "localhost:3175", "x-naia-proxy-secret": secret, "x-naia-peer": "127.0.0.1", "x-naia-local": "1", "x-naia-origin-ok": "1", "x-naia-actor-id": actor, "x-naia-actor-verified": "1" }

describe("게시 승인 서버 통합", () => {
  let directory: string, root: string, state: string, document: string
  let app: Awaited<ReturnType<typeof createServer>>
  let descriptor: PublishDescriptor
  let publicKey: string
  let fault: (point: string) => void
  const url = (suffix: string, slug = "test-post") => `/api/portal/publish/${slug}/${suffix}`
  const saveDescriptor = () => fs.writeFileSync(path.join(state, "descriptors", `${descriptor.slug}.json`), JSON.stringify(descriptor))
  const boot = async (beforeRenameHook?: () => Promise<void>) => {
    app = await createServer({ root, port: 3175, host: "127.0.0.1", publishFault: (point) => fault(point), beforeRenameHook })
    ;(app as any).proxySecret = secret
  }
  beforeEach(async () => {
    const allowed = path.resolve(os.tmpdir())
    const relative = path.relative(allowed, fs.realpathSync(os.tmpdir()))
    expect(relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))).toBe(true)
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "publish-approval-"))
    root = path.join(directory, "workspace")
    state = path.join(directory, "state")
    fs.mkdirSync(path.join(root, "docs/article/assets"), { recursive: true })
    fs.mkdirSync(path.join(state, "descriptors"), { recursive: true, mode: 0o700 })
    document = path.join(root, "docs/article/draft.md")
    fs.writeFileSync(document, "안내\r\n\r\n## 본문\r\n\r\n# 게시 제목\r\n\r\n본문 공백  \r\n![그림](assets/hero.png)\r\n\r\n---\r\n\r\n## 근거표\r\n비공개 근거와 대화 기록\r\n")
    fs.writeFileSync(path.join(root, "docs/article/assets/hero.png"), png)
    descriptor = { source: "adk", path: "article/draft.md", slug: "test-post", body_selector: { start_heading: "## 본문", end_heading: "## 근거표", separator: "---" }, frontmatter: { kind: "post", slug: "test-post", title: "시험 게시 제목", summary: "시험용 요약", date: "2030-11-04T20:00+09:00", targets: ["site-a", "site-b"], languages: { "site-a": ["ko", "en"], "site-b": ["ko", "en"] }, hero: "assets/hero.png", secondary_category: "ai" }, asset_roots: ["assets"], asset_path_map: {}, media_map: { ko: { ready: true, hero: "assets/hero.png", body_images: ["assets/hero.png"] }, en: { ready: false } } }
    const keys = crypto.generateKeyPairSync("ed25519")
    publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString()
    const keyFile = path.join(directory, "signing.pem")
    fs.writeFileSync(keyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 })
    vi.stubEnv("PUBLISH_STATE_DIR", state)
    vi.stubEnv("XDG_RUNTIME_DIR", path.join(directory, "runtime"))
    vi.stubEnv("PUBLISH_GATEWAY_SCOPE", "test-gate")
    vi.stubEnv("PUBLISH_GATEWAY_OVERWRITE_CONFIRMED", "1")
    vi.stubEnv("PUBLISH_APPROVER_IDS", actor)
    vi.stubEnv("PUBLISH_SIGNING_KEY_FILE", keyFile)
    vi.stubEnv("PUBLISH_SIGNING_KEY_ID", "test-key")
    vi.stubEnv("PUBLISH_PUBLIC_KEYS", JSON.stringify({ "test-key": publicKey }))
    fault = () => {}
    saveDescriptor()
    await boot()
  })
  afterEach(async () => { vi.restoreAllMocks(); await app?.close(); vi.unstubAllEnvs() })
  const requestReview = (key = "review-key", slug = descriptor.slug) => app.inject({ method: "POST", url: url("request-review", slug), headers: { ...headers, "idempotency-key": key }, payload: { saved_revision: hashBytes(fs.readFileSync(document)) } })
  const preview = async (review: any, slug = descriptor.slug) => {
    const response = await app.inject({ url: url(`preview?${new URLSearchParams({ review_id: review.review_id, revision_id: review.revision_id })}`, slug), headers })
    expect(response.statusCode, response.body).toBe(200)
    return response.json()
  }
  const approvalInput = (review: any, view: any) => ({ review_id: review.review_id, revision_id: review.revision_id, saved_revision: view.saved_revision, preview_hash: view.preview_hash })
  const approve = (input: any, key = "approval-key", extra: Record<string, any> = {}) => app.inject({ method: "POST", url: url("approve", descriptor.slug), headers: { ...headers, "idempotency-key": key, ...extra }, payload: input })
  const prepared = async () => { const response = await requestReview(); expect(response.statusCode, response.body).toBe(201); const review = response.json(); return { review, view: await preview(review) } }
  it("이전 승인판은 현재 초안 변경·오류 뒤에도 고정한 본문·앞머리·그림과 영수증을 읽는다", async () => {
    const { review, view } = await prepared()
    const revisionUrl = url(`revisions/${view.revision_id}`)
    expect((await app.inject({ url: revisionUrl, headers })).statusCode).toBe(404)
    const approved = await approve(approvalInput(review, view))
    expect(approved.statusCode, approved.body).toBe(201)
    fs.writeFileSync(document, "현재 초안은 게시 본문 경계도 사라졌습니다")
    descriptor.frontmatter.title = "바뀐 제목"; saveDescriptor()
    const oldPreview = await app.inject({ url: url(`preview?${new URLSearchParams({ review_id: review.review_id, revision_id: review.revision_id })}`), headers })
    expect(oldPreview.statusCode, oldPreview.body).toBe(409)
    const stored = await app.inject({ url: revisionUrl, headers: { ...headers, "x-naia-actor-id": "test-gate:other" } })
    expect(stored.statusCode, stored.body).toBe(200)
    expect(stored.headers["cache-control"]).toBe("no-store")
    expect(stored.json()).toMatchObject({ revision_id: view.revision_id, preview_hash: view.preview_hash, can_approve: false, frontmatter: view.frontmatter, media_map: view.media_map, receipt: approved.json().receipt })
    expect(stored.json().previews).toEqual(view.previews)
    expect(stored.json().assets).toEqual(view.assets)
    expect(view.assets[0]).not.toHaveProperty("source_path")
    expect(stored.body).not.toContain("비공개 근거")
    expect((await app.inject({ url: stored.json().assets[0].url, headers })).rawPayload).toEqual(png)
    expect((await app.inject({ url: url(`revisions/${view.revision_id}`, "other-post"), headers })).statusCode).toBe(404)
    expect((await app.inject({ url: revisionUrl, headers: { host: headers.host } })).statusCode).toBe(401)
  })
  it("이전 승인판은 원래 출처 권한 철회와 보관 표시 자료 변조를 거절한다", async () => {
    const { review, view } = await prepared()
    expect((await approve(approvalInput(review, view))).statusCode).toBe(201)
    const revisionUrl = url(`revisions/${view.revision_id}`)
    const resolve = portal.resolveSourceBase
    const denied = vi.spyOn(portal, "resolveSourceBase").mockImplementation((...args) => args[1] === descriptor.source ? null : resolve(...args))
    expect((await app.inject({ url: revisionUrl, headers })).statusCode).toBe(403)
    denied.mockRestore()
    fs.appendFileSync(path.join(state, "objects", view.preview_hash, "previews/site-a/ko.json"), " ")
    const corrupt = await app.inject({ url: revisionUrl, headers })
    expect(corrupt.statusCode, corrupt.body).toBe(503)
    expect(corrupt.json().code).toBe("OBJECT_INVALID")
  })
  const approvedFiles = () => fs.existsSync(path.join(state, "approvals/test-post")) ? fs.readdirSync(path.join(state, "approvals/test-post")).filter((name) => !name.startsWith(".")) : []
  const barrier = () => {
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>((resolve) => { enter = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    return { entered, release, pause: async () => { enter(); await gate } }
  }
  const otherProcess = (action: string, key: string, input: any) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const worker = `
      const { createServer } = await import(process.argv[1]);
      const app = await createServer({ root: process.argv[2], port: 3175, host: '127.0.0.1' });
      app.proxySecret = ${JSON.stringify(secret)};
      const response = await app.inject({ method: 'POST', url: '/api/portal/publish/test-post/' + process.argv[3], headers: JSON.parse(process.argv[4]), payload: JSON.parse(process.argv[5]) });
      await app.close();
      process.send({ status: response.statusCode, body: response.json() });
      process.disconnect();
    `
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", worker, new URL("../src/server.ts", import.meta.url).href, root, action, JSON.stringify({ ...headers, "idempotency-key": key }), JSON.stringify(input)], { stdio: ["ignore", "ignore", "pipe", "ipc"] })
    let stderr = ""
    let result: { status: number; body: any } | undefined
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("별도 프로세스 응답 시간 초과")) }, 8000)
    child.stderr!.on("data", (chunk) => { stderr += chunk })
    child.once("message", (message) => { result = message as typeof result })
    child.once("error", (error) => { clearTimeout(timer); reject(error) })
    child.once("exit", (code) => {
      clearTimeout(timer)
      if (code === 0 && result) resolve(result)
      else reject(new Error(`별도 프로세스 요청 실패: ${stderr}`))
    })
  })

  it.each(["sample-one", "sample-two"])("합성 원고 %s는 요청·승인·수정·재요청 뒤 이전 영수증을 보존한다", async (slug) => {
    descriptor.slug = slug
    descriptor.path = `article/${slug}.md`
    descriptor.frontmatter.slug = slug
    document = path.join(root, "docs", descriptor.path)
    const original = Buffer.from(`## 본문\n\n# ${slug}\n![그림](assets/hero.png)\n\n---\n\n## 근거표\n내부 자료\n`)
    fs.writeFileSync(document, original)
    saveDescriptor()
    const requested = await requestReview(`${slug}-request`)
    expect(requested.statusCode, requested.body).toBe(201)
    const review = requested.json()
    const view = await preview(review, slug)
    const first = await approve(approvalInput(review, view), `${slug}-approval`)
    expect(first.statusCode, first.body).toBe(201)
    expect(fs.readFileSync(document)).toEqual(original)
    const changed = Buffer.concat([original, Buffer.from("수정\n")])
    fs.writeFileSync(document, changed)
    const secondRequest = await requestReview(`${slug}-request-2`)
    expect(secondRequest.statusCode, secondRequest.body).toBe(201)
    const review2 = secondRequest.json()
    const view2 = await preview(review2, slug)
    const second = await approve(approvalInput(review2, view2), `${slug}-approval-2`)
    expect(second.statusCode, second.body).toBe(201)
    expect(second.json().receipt.receipt_id).not.toBe(first.json().receipt.receipt_id)
    expect(verifyApprovalReceipt(first.json().receipt, { "test-key": publicKey })).toBe(true)
    expect(fs.readFileSync(document)).toEqual(changed)
  })

  it("A1 열기만 하고 확인 요청 후 승인해도 원고·그림 전체 바이트와 저장 요청 수가 그대로다", async () => {
    const started = performance.now()
    let documentWrites = 0
    app.addHook("onRequest", async (request) => { if (request.method === "PUT" && request.url.startsWith("/api/portal/doc")) documentWrites++ })
    const original = fs.readFileSync(document)
    const originalAsset = fs.readFileSync(path.join(root, "docs/article/assets/hero.png"))
    const opened = await app.inject({ url: "/api/portal/doc?source=adk&path=article/draft.md", headers })
    expect(opened.statusCode).toBe(200)
    const { review, view } = await prepared()
    expect(JSON.stringify(view.previews)).not.toContain("비공개 근거")
    const response = await approve(approvalInput(review, view))
    expect(response.statusCode, response.body).toBe(201)
    expect(response.json().state).toBe("approved_waiting_export")
    expect(fs.readFileSync(document)).toEqual(original)
    expect(fs.readFileSync(path.join(root, "docs/article/assets/hero.png"))).toEqual(originalAsset)
    expect(documentWrites).toBe(0)
    expect(fs.readFileSync(path.join(state, "objects", view.preview_hash, "source.bin"))).toEqual(original)
    expect(performance.now() - started).toBeLessThan(5000)
  })
  it("A2 미리보기 뒤 원고 1바이트 변경은 409이며 영수증·승인 완료 기록이 없다", async () => {
    const { review, view } = await prepared()
    fs.appendFileSync(document, " ")
    const response = await approve(approvalInput(review, view))
    expect(response.statusCode, response.body).toBe(409)
    expect(response.json().code).toBe("PREVIEW_CHANGED")
    expect(approvedFiles()).toEqual([])
  })
  it("읽기 전용 전환 뒤 상태·미리보기는 승인을 허용하지 않고 직접 승인도 403이며 이전 영수증·원고는 보존한다", async () => {
    const initial = await prepared()
    const firstApproval = await approve(approvalInput(initial.review, initial.view))
    expect(firstApproval.statusCode, firstApproval.body).toBe(201)
    const receipt = firstApproval.json().receipt
    const receiptFile = path.join(state, "approvals", descriptor.slug, initial.review.revision_id, "receipt.json")
    const originalReceiptBytes = fs.readFileSync(receiptFile)
    fs.appendFileSync(document, "새 초안")
    const requested = await requestReview("read-only-next-review")
    expect(requested.statusCode, requested.body).toBe(201)
    const review = requested.json(), writablePreview = await preview(review)
    expect(writablePreview.can_approve).toBe(true)
    const writableStatus = await app.inject({ url: url("status"), headers })
    expect(writableStatus.statusCode, writableStatus.body).toBe(200)
    expect(writableStatus.json()).toMatchObject({ can_request_review: true, can_approve: true, receipt })
    const originalDocument = fs.readFileSync(document)
    const originalAsset = fs.readFileSync(path.join(root, "docs/article/assets/hero.png"))
    const originalApprovedFiles = approvedFiles()
    // 파일·게시 경로는 실제 그대로 두고 출처 권한 해석의 읽기 전용 값만 전환한다.
    const resolve = portal.resolveSourceBase
    vi.spyOn(portal, "resolveSourceBase").mockImplementation((...args) => {
      const source = resolve(...args)
      return source ? { ...source, readOnly: true } : null
    })

    const readOnlyStatus = await app.inject({ url: url("status"), headers })
    expect(readOnlyStatus.statusCode, readOnlyStatus.body).toBe(200)
    expect(readOnlyStatus.json()).toMatchObject({ state: "pending_review", can_request_review: false, can_approve: false, receipt })
    expect((await preview(review)).can_approve).toBe(false)
    const denied = await approve(approvalInput(review, writablePreview), "read-only-approval")
    expect(denied.statusCode, denied.body).toBe(403)
    expect(denied.json().code).toBe("DOCUMENT_FORBIDDEN")
    expect(fs.readFileSync(document)).toEqual(originalDocument)
    expect(fs.readFileSync(path.join(root, "docs/article/assets/hero.png"))).toEqual(originalAsset)
    expect(fs.readFileSync(receiptFile)).toEqual(originalReceiptBytes)
    expect(verifyApprovalReceipt(receipt, { "test-key": publicKey })).toBe(true)
    expect(approvedFiles()).toEqual(originalApprovedFiles)
  })
  it("A3 미리보기 뒤 같은 경로 그림 교체는 지문을 바꾸고 승인을 409로 거절한다", async () => {
    const { review, view } = await prepared()
    fs.writeFileSync(path.join(root, "docs/article/assets/hero.png"), Buffer.concat([png, Buffer.from("changed")]))
    const response = await approve(approvalInput(review, view))
    expect(response.statusCode, response.body).toBe(409)
    const status = await app.inject({ url: url("status"), headers })
    expect(status.json().preview_hash).not.toBe(view.preview_hash)
    expect(approvedFiles()).toEqual([])
  })
  it.each(["본문 경계 삭제", "지문 명시 그림 교체", "그림 형식 파손", "필수 앞머리 삭제"])("대기판 뒤 %s는 묶음 오류보다 먼저 409로 거절한다", async (change) => {
    if (change === "지문 명시 그림 교체") {
      descriptor.media_map.ko = { ready: true, hero: { path: "assets/hero.png", sha256: hashBytes(png) }, body_images: ["assets/hero.png"] }
      saveDescriptor()
    }
    const { review, view } = await prepared()
    if (change === "본문 경계 삭제") fs.writeFileSync(document, fs.readFileSync(document, "utf8").replace("## 본문", "## 바뀐 경계"))
    if (change === "지문 명시 그림 교체") fs.writeFileSync(path.join(root, "docs/article/assets/hero.png"), Buffer.concat([png, Buffer.from("changed")]))
    if (change === "그림 형식 파손") fs.writeFileSync(path.join(root, "docs/article/assets/hero.png"), "그림 아님")
    if (change === "필수 앞머리 삭제") { delete descriptor.frontmatter.summary; saveDescriptor() }
    const response = await approve(approvalInput(review, view))
    expect(response.statusCode, response.body).toBe(409)
    const changedPreview = await app.inject({ url: url(`preview?${new URLSearchParams({ review_id: review.review_id, revision_id: review.revision_id })}`), headers })
    expect(changedPreview.statusCode, changedPreview.body).toBe(409)
    expect(approvedFiles()).toEqual([])
  })
  it("최초 자료의 본문 경계 오류는 422다", async () => {
    fs.writeFileSync(document, "본문 경계 없음")
    expect((await requestReview()).statusCode).toBe(422)
  })
  it("최초 게시 설정 JSON 구문 파손은 422 자료 오류다", async () => {
    fs.writeFileSync(path.join(state, "descriptors/test-post.json"), "{")
    const response = await requestReview()
    expect(response.statusCode, response.body).toBe(422)
    expect(response.json()).toMatchObject({ code: "DESCRIPTOR_INVALID", retryable: false, issues: [{ field: "descriptor" }] })
    expect(approvedFiles()).toEqual([])
  })
  it("대기판 뒤 게시 설정 JSON 구문 파손은 미리보기와 승인에서 409 변경이다", async () => {
    const { review, view } = await prepared()
    fs.writeFileSync(path.join(state, "descriptors/test-post.json"), "{")
    const changedPreview = await app.inject({ url: url(`preview?${new URLSearchParams({ review_id: review.review_id, revision_id: review.revision_id })}`), headers })
    expect(changedPreview.statusCode, changedPreview.body).toBe(409)
    expect(changedPreview.json().code).toBe("PREVIEW_CHANGED")
    const response = await approve(approvalInput(review, view))
    expect(response.statusCode, response.body).toBe(409)
    expect(response.json().code).toBe("PREVIEW_CHANGED")
    expect(approvedFiles()).toEqual([])
  })
  it("승인 뒤 게시 설정 JSON 구문 파손도 기존 영수증과 자료 오류를 200으로 조회한다", async () => {
    const { review, view } = await prepared()
    const approved = await approve(approvalInput(review, view))
    expect(approved.statusCode, approved.body).toBe(201)
    fs.writeFileSync(path.join(state, "descriptors/test-post.json"), "{")
    const response = await app.inject({ url: url("status"), headers })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({ state: "changed_after_approval", changed_after_approval: true, approved_revision_id: view.revision_id, receipt: approved.json().receipt, revision_id: null, can_approve: false, can_request_review: false, draft_error: { code: "DESCRIPTOR_INVALID", issues: [{ field: "descriptor" }] } })
    expect(approvedFiles()).toEqual([view.revision_id])
    const operation = await app.inject({ url: `/api/portal/publish/operations/${approved.json().operation_id}`, headers })
    expect(operation.statusCode, operation.body).toBe(200)
    expect(operation.json().result.receipt).toEqual(approved.json().receipt)
    saveDescriptor()
    expect((await app.inject({ url: url("status"), headers })).json()).toMatchObject({ state: "approved_waiting_export", receipt: approved.json().receipt, draft_error: null })
  })
  it.each(["최초", "대기판 뒤", "승인 뒤"])("%s 게시 설정의 실제 읽기 장애는 자료 오류와 구분해 503이다", async (stage) => {
    const ready = stage === "최초" ? null : await prepared()
    let receipt: any
    if (stage === "승인 뒤") {
      const approved = await approve(approvalInput(ready!.review, ready!.view))
      expect(approved.statusCode, approved.body).toBe(201)
      receipt = approved.json().receipt
    }
    const descriptorFile = path.join(state, "descriptors/test-post.json")
    const open = fs.openSync
    const failedRead = vi.spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (args[0] === descriptorFile) throw Object.assign(new Error("descriptor read I/O failure"), { code: "EIO" })
      return open(...args)
    })
    const responses = stage === "최초" ? [await requestReview()] : stage === "승인 뒤" ? [await app.inject({ url: url("status"), headers })] : [
      await app.inject({ url: url(`preview?${new URLSearchParams({ review_id: ready!.review.review_id, revision_id: ready!.review.revision_id })}`), headers }),
      await approve(approvalInput(ready!.review, ready!.view)),
    ]
    for (const response of responses) {
      expect(response.statusCode, response.body).toBe(503)
      expect(response.json()).toMatchObject({ code: "PUBLISH_UNAVAILABLE", retryable: true })
    }
    failedRead.mockRestore()
    if (stage === "승인 뒤") expect((await app.inject({ url: url("status"), headers })).json()).toMatchObject({ state: "approved_waiting_export", receipt, draft_error: null })
    else expect(approvedFiles()).toEqual([])
  })
  it.each(["원고", "그림"].flatMap(file => ["readSync EIO", "openSync EIO", "openSync EACCES"].flatMap(point => ["최초", "대기판 뒤", "승인 뒤"].map(stage => ({ file, point, stage })))))("$stage $file $point 장애는 503 재시도이며 자료 변경으로 판정하지 않는다", async ({ file, point, stage }) => {
    const ready = stage === "최초" ? null : await prepared()
    const savedRevision = hashBytes(fs.readFileSync(document))
    let receipt: any
    if (stage === "승인 뒤") {
      const response = await approve(approvalInput(ready!.review, ready!.view))
      expect(response.statusCode, response.body).toBe(201)
      receipt = response.json().receipt
    }
    const target = file === "원고" ? document : path.join(root, "docs/article/assets/hero.png")
    const [method, code] = point.split(" ")
    const open = fs.openSync, read = fs.readSync
    let targetFd: number | undefined, injections = 0
    const fail = () => { injections++; throw Object.assign(new Error("input I/O failure"), { code }) }
    const openFault = vi.spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (args[0] === target && method === "openSync") fail()
      const fd = open(...args)
      if (args[0] === target) targetFd = fd
      return fd
    })
    const readFault = vi.spyOn(fs, "readSync").mockImplementation(((...args: any[]) => {
      if (args[0] === targetFd && method === "readSync") { targetFd = undefined; fail() }
      return Reflect.apply(read, fs, args)
    }) as typeof fs.readSync)
    const reviewRequest = () => app.inject({ method: "POST", url: url("request-review"), headers: { ...headers, "idempotency-key": "io-review-key" }, payload: { saved_revision: savedRevision } })
    const approvalRequest = () => approve(approvalInput(ready!.review, ready!.view), "io-approval-key")
    const responses = stage === "최초" ? [await reviewRequest()] : [
      await app.inject({ url: url(`preview?${new URLSearchParams({ review_id: ready!.review.review_id, revision_id: ready!.review.revision_id })}`), headers }),
      await approvalRequest(),
    ]
    responses.push(await app.inject({ url: url("status"), headers }))
    for (const response of responses) {
      expect(response.statusCode, response.body).toBe(503)
      expect(response.json()).toMatchObject({ code: "PUBLISH_UNAVAILABLE", retryable: true })
      expect(response.json()).not.toHaveProperty("changed_after_approval")
      if (response.json().operation_id) expect(JSON.parse(fs.readFileSync(path.join(state, "operations", response.json().operation_id, "state.json"), "utf8"))).toMatchObject({ state: "retry_wait", code: "PUBLISH_UNAVAILABLE" })
    }
    expect(injections).toBeGreaterThanOrEqual(responses.length)
    expect(approvedFiles()).toEqual(stage === "승인 뒤" ? [ready!.view.revision_id] : [])
    readFault.mockRestore()
    openFault.mockRestore()
    const recoveredStatus = await app.inject({ url: url("status"), headers })
    expect(recoveredStatus.statusCode, recoveredStatus.body).toBe(200)
    expect(recoveredStatus.json()).toMatchObject({ state: stage === "최초" ? "draft" : stage === "대기판 뒤" ? "pending_review" : "approved_waiting_export", changed_after_approval: false, draft_error: null })
    if (stage === "승인 뒤") expect(recoveredStatus.json().receipt).toEqual(receipt)
    if (stage === "최초") expect((await reviewRequest()).statusCode).toBe(201)
    else {
      const retried = await approvalRequest()
      expect(retried.statusCode, retried.body).toBe(201)
      if (stage === "승인 뒤") expect(retried.json().receipt).toEqual(receipt)
    }
  })
  it.each([
    ["원고", "lstatSync", "EIO"], ["원고", "realpathSync.native", "EACCES"],
    ["그림 폴더", "lstatSync", "EIO"], ["그림 폴더", "realpathSync.native", "EACCES"],
    ["그림 폴더", "statSync", "EIO"], ["그림 폴더", "readdirSync", "EIO"],
  ])("%s %s %s 장애도 경로·권한 오류로 숨기지 않고 503으로 반환한다", async (file, method, code) => {
    const { review, view } = await prepared()
    const target = file === "원고" ? document : path.join(root, "docs/article/assets")
    const owner = method === "realpathSync.native" ? fs.realpathSync : fs
    const name = method === "realpathSync.native" ? "native" : method
    const original = (owner as any)[name]
    let injections = 0
    const failed = vi.spyOn(owner as any, name).mockImplementation((...args: unknown[]) => {
      if (args[0] === target) { injections++; throw Object.assign(new Error("input path I/O failure"), { code }) }
      return Reflect.apply(original, owner, args)
    })
    const responses = [
      await app.inject({ url: url(`preview?${new URLSearchParams({ review_id: review.review_id, revision_id: review.revision_id })}`), headers }),
      await approve(approvalInput(review, view)),
      await app.inject({ url: url("status"), headers }),
    ]
    for (const response of responses) {
      expect(response.statusCode, response.body).toBe(503)
      expect(response.json()).toMatchObject({ code: "PUBLISH_UNAVAILABLE", retryable: true })
      expect(response.json()).not.toHaveProperty("changed_after_approval")
    }
    expect(injections).toBeGreaterThanOrEqual(responses.length)
    expect(approvedFiles()).toEqual([])
    failed.mockRestore()
    const status = await app.inject({ url: url("status"), headers })
    expect(status.statusCode, status.body).toBe(200)
    expect(status.json()).toMatchObject({ state: "pending_review", changed_after_approval: false, draft_error: null })
  })
  it.each(["원고 삭제", "원고 이름 변경", "원고 부모가 파일", "설정 삭제"])("대기판 뒤 %s는 미리보기와 승인에서 409 변경이다", async (change) => {
    const { review, view } = await prepared()
    if (change === "원고 삭제") fs.unlinkSync(document)
    if (change === "원고 이름 변경") fs.renameSync(document, path.join(path.dirname(document), "renamed.md"))
    if (change === "원고 부모가 파일") { fs.renameSync(path.dirname(document), path.join(root, "docs/article-original")); fs.writeFileSync(path.dirname(document), "폴더 대신 파일") }
    if (change === "설정 삭제") fs.unlinkSync(path.join(state, "descriptors/test-post.json"))
    const changedPreview = await app.inject({ url: url(`preview?${new URLSearchParams({ review_id: review.review_id, revision_id: review.revision_id })}`), headers })
    expect(changedPreview.statusCode, changedPreview.body).toBe(409)
    expect(changedPreview.json().code).toBe("PREVIEW_CHANGED")
    const response = await approve(approvalInput(review, view))
    expect(response.statusCode, response.body).toBe(409)
    expect(response.json().code).toBe("PREVIEW_CHANGED")
    expect(approvedFiles()).toEqual([])
  })
  it.each(["최초", "대기판 뒤", "승인 뒤"])("%s 원고가 폴더이면 자료 오류·판 변경·기존 승인 보존으로 구분한다", async (stage) => {
    const savedRevision = hashBytes(fs.readFileSync(document))
    const ready = stage === "최초" ? null : await prepared()
    let approved: any
    if (stage === "승인 뒤") {
      const response = await approve(approvalInput(ready!.review, ready!.view))
      expect(response.statusCode, response.body).toBe(201)
      approved = response.json()
    }
    fs.renameSync(document, `${document}.original`)
    fs.mkdirSync(document)
    if (stage === "최초") {
      const response = await app.inject({ method: "POST", url: url("request-review"), headers: { ...headers, "idempotency-key": "invalid-source-key" }, payload: { saved_revision: savedRevision } })
      expect(response.statusCode, response.body).toBe(422)
      expect(response.json()).toMatchObject({ code: "DOCUMENT_INVALID", retryable: false, issues: [{ field: "source" }] })
      expect(approvedFiles()).toEqual([])
    } else if (stage === "대기판 뒤") {
      const responses = [
        await app.inject({ url: url(`preview?${new URLSearchParams({ review_id: ready!.review.review_id, revision_id: ready!.view.revision_id })}`), headers }),
        await approve(approvalInput(ready!.review, ready!.view)),
      ]
      for (const response of responses) {
        expect(response.statusCode, response.body).toBe(409)
        expect(response.json()).toMatchObject({ code: "PREVIEW_CHANGED", retryable: false })
      }
      expect(approvedFiles()).toEqual([])
    } else {
      const response = await app.inject({ url: url("status"), headers })
      expect(response.statusCode, response.body).toBe(200)
      expect(response.json()).toMatchObject({ state: "changed_after_approval", changed_after_approval: true, revision_id: null, approved_revision_id: ready!.view.revision_id, receipt: approved.receipt, can_approve: false, can_request_review: false, draft_error: { code: "DOCUMENT_INVALID", issues: [{ field: "source" }] } })
      const operation = await app.inject({ url: `/api/portal/publish/operations/${approved.operation_id}`, headers })
      expect(operation.statusCode, operation.body).toBe(200)
      expect(operation.json().result.receipt).toEqual(approved.receipt)
      expect(approvedFiles()).toEqual([ready!.view.revision_id])
    }
  })
  it.each(["출처 해제", "허용 경로 철회"])("대기판 뒤 %s는 변경과 구분해 403 접근 거절이다", async (change) => {
    const configDir = path.join(root, "data-company/test-company")
    fs.mkdirSync(configDir, { recursive: true })
    const configFile = path.join(configDir, "adk-company.json")
    const config = { schemaVersion: 1, title: "시험 회사", docs: { include: [] }, repos: [{ id: "publish-source", path: "data-company/test-company/repo", remote: "https://example.test/publish.git", docs: { include: ["article"] } }] }
    fs.cpSync(path.join(root, "docs/article"), path.join(configDir, "repo/article"), { recursive: true })
    document = path.join(configDir, "repo/article/draft.md")
    fs.writeFileSync(configFile, JSON.stringify(config))
    descriptor.source = "publish-source"; saveDescriptor()
    const { review, view } = await prepared()
    if (change === "출처 해제") config.repos = []
    else config.repos[0].docs.include = []
    fs.writeFileSync(configFile, JSON.stringify(config))
    const changedPreview = await app.inject({ url: url(`preview?${new URLSearchParams({ review_id: review.review_id, revision_id: review.revision_id })}`), headers })
    expect(changedPreview.statusCode, changedPreview.body).toBe(403)
    expect(changedPreview.json().code).toBe("DOCUMENT_FORBIDDEN")
    const response = await approve(approvalInput(review, view))
    expect(response.statusCode, response.body).toBe(403)
    expect(response.json().code).toBe("DOCUMENT_FORBIDDEN")
    expect(approvedFiles()).toEqual([])
  })
  it("원고가 폴더로 바뀌어도 실제 허용 경로 철회는 403이다", async () => {
    const configDir = path.join(root, "data-company/test-company")
    fs.mkdirSync(configDir, { recursive: true })
    const configFile = path.join(configDir, "adk-company.json")
    const config = { schemaVersion: 1, title: "시험 회사", docs: { include: [] }, repos: [{ id: "publish-source", path: "data-company/test-company/repo", remote: "https://example.test/publish.git", docs: { include: ["article"] } }] }
    fs.cpSync(path.join(root, "docs/article"), path.join(configDir, "repo/article"), { recursive: true })
    document = path.join(configDir, "repo/article/draft.md")
    fs.writeFileSync(configFile, JSON.stringify(config))
    descriptor.source = "publish-source"; saveDescriptor()
    const { review, view } = await prepared()
    const approved = await approve(approvalInput(review, view))
    expect(approved.statusCode, approved.body).toBe(201)
    fs.renameSync(document, `${document}.original`)
    fs.mkdirSync(document)
    config.repos[0].docs.include = []
    fs.writeFileSync(configFile, JSON.stringify(config))
    for (const response of [
      await app.inject({ url: url(`preview?${new URLSearchParams({ review_id: review.review_id, revision_id: view.revision_id })}`), headers }),
      await approve(approvalInput(review, view), "revoked-approval-key"),
      await app.inject({ url: url("status"), headers }),
    ]) {
      expect(response.statusCode, response.body).toBe(403)
      expect(response.json().code).toBe("DOCUMENT_FORBIDDEN")
    }
    expect(approvedFiles()).toEqual([view.revision_id])
  })
  it("최초 잠금 대기 중 같은 키의 다른 내용은 메모리 지문으로 409다", async () => {
    const waiting = barrier()
    const original = publishLock.withPublishLock
    vi.spyOn(publishLock, "withPublishLock").mockImplementation(async (fn, stateDir, waitSeconds) => {
      await waiting.pause()
      return original(fn, stateDir, waitSeconds)
    })
    const first = requestReview().then((response) => response)
    await waiting.entered
    try {
      const repeated = await requestReview()
      expect(repeated.statusCode).toBe(202)
      const conflict = await app.inject({ method: "POST", url: url("request-review"), headers: { ...headers, "idempotency-key": "review-key" }, payload: { saved_revision: "0".repeat(64) } })
      expect(conflict.statusCode, conflict.body).toBe(409)
    } finally { waiting.release() }
    expect((await first).statusCode).toBe(201)
  })
  it("이전 대기판을 다시 선택하면 상태와 할 일이 같은 현재 요청을 가리킨다", async () => {
    const original = fs.readFileSync(document)
    const first = (await requestReview("first")).json()
    fs.appendFileSync(document, "변경판")
    const second = (await requestReview("second")).json()
    fs.writeFileSync(document, original)
    const restored = await requestReview("restore")
    expect(restored.statusCode, restored.body).toBe(201)
    expect(restored.json().review_id).toBe(first.review_id)
    const status = await app.inject({ url: url("status"), headers })
    expect(status.json()).toMatchObject({ state: "pending_review", review_id: first.review_id })
    const todos = await app.inject({ url: "/api/portal/publish/review-todos", headers })
    expect(todos.json().tasks.find((task: any) => task.review_id === first.review_id).state).toBe("pending_review")
    expect(todos.json().tasks.find((task: any) => task.review_id === second.review_id).state).toBe("superseded")
    const replay = await app.inject({ method: "POST", url: url("request-review"), headers: { ...headers, "idempotency-key": "second" }, payload: { saved_revision: second.saved_revision } })
    expect(replay.statusCode).toBe(200)
    expect((await app.inject({ url: url("status"), headers })).json().review_id).toBe(first.review_id)
  })
  it("A4 같은 키 재전송·동시 요청·다른 키 동시 승인은 승인판과 영수증 하나만 만든다", async () => {
    const { review, view } = await prepared()
    const input = approvalInput(review, view)
    const concurrent = await Promise.all([approve(input), approve(input), approve(input, "other-key")])
    expect(concurrent.every((result) => [200, 201, 202].includes(result.statusCode))).toBe(true)
    const results = []
    for (const key of ["approval-key", "other-key"]) {
      const replay = await approve(input, key)
      expect([200, 201], replay.body).toContain(replay.statusCode)
      const operation = await app.inject({ url: `/api/portal/publish/operations/${replay.json().operation_id}`, headers })
      expect(operation.statusCode, operation.body).toBe(200)
      expect(operation.json().state).toBe("committed")
      expect(operation.json().result.receipt).toEqual(replay.json().receipt)
      const final = await approve(input, key)
      expect(final.statusCode).toBe(200)
      expect(final.json().receipt).toEqual(replay.json().receipt)
      results.push(final.json().receipt)
    }
    expect(results[1]).toEqual(results[0])
    expect(approvedFiles()).toHaveLength(1)
    const conflict = await approve({ ...input, saved_revision: "0".repeat(64) })
    expect(conflict.statusCode).toBe(409)
  })
  it.each([false, true])("A4 별도 프로세스 처리 중 응답과 살아 있는 소유자의 저장 장애 복구: %s", async (storageFailure) => {
    const { review, view } = await prepared()
    const input = approvalInput(review, view)
    const release = path.join(directory, "release-approval")
    const worker = `
      const fs = await import('node:fs');
      const { createServer } = await import(process.argv[1]);
      let paused = false, failed = false;
      const app = await createServer({ root: process.argv[2], port: 3175, host: '127.0.0.1', publishFault(point) {
        if (${storageFailure} && point === 'before_commit') { failed = true; throw new Error('storage unavailable'); }
        if (failed && point === 'operation_write') throw new Error('state unavailable');
        if (point !== 'record_write' || paused) return;
        paused = true;
        process.send({ event: 'pending' });
        const until = Date.now() + 8000;
        while (!fs.existsSync(process.argv[3])) {
          if (Date.now() > until) throw new Error('release timeout');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
      }});
      app.proxySecret = ${JSON.stringify(secret)};
      const response = await app.inject({ method: 'POST', url: '/api/portal/publish/test-post/approve', headers: JSON.parse(process.argv[4]), payload: JSON.parse(process.argv[5]) });
      process.send({ event: 'result', status: response.statusCode, result: response.json() });
      await app.close();
      await new Promise((resolve) => process.once('message', resolve));
      process.disconnect();
    `
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", worker, new URL("../src/server.ts", import.meta.url).href, root, release, JSON.stringify({ ...headers, "idempotency-key": "approval-key" }), JSON.stringify(input)], { stdio: ["ignore", "ignore", "pipe", "ipc"] })
    let stderr = ""
    child.stderr!.on("data", (chunk) => { stderr += chunk })
    const messages: any[] = []
    child.on("message", (message) => messages.push(message))
    const waitFor = async (event: string) => {
      const end = Date.now() + 8000
      while (!messages.some((message) => message.event === event)) {
        if (Date.now() > end || child.exitCode !== null) throw new Error(`자식 처리 실패: ${stderr}`)
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      return messages.find((message) => message.event === event)
    }
    try {
      await waitFor("pending")
      const pending = await approve(input)
      expect(pending.statusCode, pending.body).toBe(202)
      fs.writeFileSync(release, "release")
      const completed = await waitFor("result")
      expect(completed.status).toBe(storageFailure ? 503 : 201)
      expect(child.exitCode).toBeNull()
      const replay = await approve(input)
      expect(replay.statusCode, replay.body).toBe(storageFailure ? 201 : 200)
      if (!storageFailure) expect(replay.json().receipt).toEqual(completed.result.receipt)
      const final = await approve(input)
      expect(final.statusCode).toBe(200)
      expect(final.json().receipt).toEqual(replay.json().receipt)
      const operation = await app.inject({ url: `/api/portal/publish/operations/${replay.json().operation_id}`, headers })
      expect(operation.json()).toMatchObject({ state: "committed", result: { receipt: replay.json().receipt } })
      expect(approvedFiles()).toHaveLength(1)
    } finally {
      fs.writeFileSync(release, "release")
      if (child.connected) child.send("release-owner")
      if (child.exitCode === null && child.signalCode === null) {
        const exit = new Promise((resolve) => child.once("exit", resolve))
        child.kill("SIGKILL"); await exit
      }
    }
  }, 12_000)
  it("A5 다른 계정·대표님 표시명만 있는 계정은 403이고 무신원·위조·중복·미설정은 거절한다", async () => {
    const { review, view } = await prepared()
    const input = approvalInput(review, view)
    for (const account of ["test-gate:other", "test-gate:owner-lookalike"]) {
      const response = await approve(input, account, { "x-naia-actor-id": account, "x-auth-user": "대표님" })
      expect(response.statusCode).toBe(403)
    }
    for (const extra of [{ "x-naia-actor-id": "" }, { "x-naia-actor-verified": "0" }, { "x-naia-proxy-secret": "forged" }, { "x-naia-actor-id": [actor, actor] }, { "x-naia-origin-ok": "0" }, { "x-naia-peer": "203.0.113.10" }]) {
      const response = await approve(input, crypto.randomUUID(), extra)
      expect([401, 403]).toContain(response.statusCode)
    }
    vi.stubEnv("PUBLISH_APPROVER_IDS", "")
    expect((await approve(input)).statusCode).toBe(503)
    vi.stubEnv("PUBLISH_GATEWAY_SCOPE", "")
    expect((await approve(input)).statusCode).toBe(503)
    expect(approvedFiles()).toEqual([])
  })
  it("관문 덮어쓰기 확인 표시가 없으면 내부 신원이 있어도 승인은 기본 403이다", async () => {
    const { review, view } = await prepared()
    for (const flag of [undefined, "", "0", "true"]) {
      vi.stubEnv("PUBLISH_GATEWAY_OVERWRITE_CONFIRMED", flag)
      const response = await approve(approvalInput(review, view), crypto.randomUUID())
      expect(response.statusCode).toBe(403)
      expect(response.json().code).toBe("publish_gateway_unconfirmed")
    }
    expect(approvedFiles()).toEqual([])
  })
  it("정상 영수증은 검증되고 서명한 13개 칸 각각의 변조는 거절된다", async () => {
    const { review, view } = await prepared()
    const response = await approve(approvalInput(review, view))
    const receipt = response.json().receipt
    expect(Object.keys(receipt)).toHaveLength(14)
    expect(verifyApprovalReceipt(receipt, { "test-key": publicKey })).toBe(true)
    const started = performance.now()
    for (const field of Object.keys(receipt).filter((key) => key !== "signature")) expect(verifyApprovalReceipt({ ...receipt, [field]: typeof receipt[field] === "string" ? `${receipt[field]}changed` : [] }, { "test-key": publicKey })).toBe(false)
    expect(performance.now() - started).toBeLessThan(1000)
  })
  it.each(["task_write", "task_sync", "review_commit"])("할 일 %s 실패는 503이고 확인 대기판과 성공 응답을 남기지 않는다", async (point) => {
    fault = (current) => { if (current === point) throw new Error("injected failure") }
    const response = await requestReview()
    expect(response.statusCode).toBe(503)
    fault = () => {}
    const status = await app.inject({ url: url("status"), headers })
    expect(status.json().state).toBe("draft")
    const retry = await requestReview()
    expect(retry.statusCode, retry.body).toBe(201)
  })
  it("승인 디렉토리 확정 직후 별도 결과 확정 전 중단은 재시작·원고 변경 뒤 원래 영수증을 복구한다", async () => {
    const { review, view } = await prepared()
    let interruptedAtApproval = false
    fault = (point) => { if (point === "approval_commit") { interruptedAtApproval = true; throw new Error("approval committed before result") } }
    const input = approvalInput(review, view)
    const interrupted = await approve(input)
    expect(interrupted.statusCode).toBe(503)
    expect(interruptedAtApproval).toBe(true)
    expect(approvedFiles()).toHaveLength(1)
    const commit = JSON.parse(fs.readFileSync(path.join(state, "approvals/test-post", view.revision_id, "commit.json"), "utf8"))
    expect(fs.existsSync(path.join(state, "operations", commit.operation.operation_id, "result/commit.json"))).toBe(false)
    const interruptedOperation = JSON.parse(fs.readFileSync(path.join(state, "operations", commit.operation.operation_id, "state.json"), "utf8"))
    expect(interruptedOperation.state).toBe("retry_wait")
    expect(interruptedOperation.result).toBeUndefined()
    expect(commit.operation).toMatchObject({ operation_id: expect.stringMatching(/^op_/), request_hash: hashBytes(canonicalBytes(input)), scope: { actor_id: actor, slug: "test-post", action: "approve", key_hash: hashBytes("approval-key") } })
    fs.appendFileSync(document, "원고 변경")
    await app.close(); fault = () => {}; await boot()
    const replay = await approve(input)
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json().receipt).toEqual(commit.result.receipt)
    const operation = await app.inject({ url: `/api/portal/publish/operations/${commit.operation.operation_id}`, headers })
    expect(operation.json().state).toBe("committed")
    expect(operation.json().result.receipt).toEqual(commit.result.receipt)
    expect(approvedFiles()).toHaveLength(1)
  })
  it("승인 확정 직전 실패는 반쪽 승인 없이 같은 키로 재시도한다", async () => {
    const { review, view } = await prepared()
    fault = (point) => { if (point === "before_commit") throw new Error("before commit crash") }
    const input = approvalInput(review, view)
    expect((await approve(input)).statusCode).toBe(503)
    expect(approvedFiles()).toEqual([])
    await app.close(); fault = () => {}; await boot()
    expect((await approve(input)).statusCode).toBe(201)
    expect(approvedFiles()).toHaveLength(1)
  })
  it.each(["request-review", "approve"] as const)("%s 키 A의 부모 동기화 실패 뒤 키 B도 503이며 회복하면 같은 확정 기록을 재사용한다", async (action) => {
    const ready = action === "approve" ? await prepared() : null
    const input = ready ? approvalInput(ready.review, ready.view) : { saved_revision: hashBytes(fs.readFileSync(document)) }
    const post = (key: string) => app.inject({ method: "POST", url: url(action), headers: { ...headers, "idempotency-key": key }, payload: input })
    const parent = path.join(state, action === "approve" ? "approvals/test-post" : "reviews")
    let committedPath: string | undefined, failedSyncs = 0
    const rename = fs.renameSync, sync = fs.fsyncSync
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      rename(source, destination)
      if (path.dirname(String(destination)) === parent && !path.basename(String(destination)).startsWith(".")) committedPath = String(destination)
    })
    const syncSpy = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (committedPath && fs.readlinkSync(`/proc/self/fd/${fd}`) === parent) {
        failedSyncs++
        throw Object.assign(new Error("committed parent sync I/O failure"), { code: "EIO" })
      }
      sync(fd)
    })
    const failedA = await post("parent-sync-key-a")
    expect(failedA.statusCode, failedA.body).toBe(503)
    expect(failedA.json()).toMatchObject({ code: "PUBLISH_UNAVAILABLE", retryable: true })
    expect(committedPath).toBeDefined()
    const commitFile = path.join(committedPath!, "commit.json")
    const original = fs.readFileSync(commitFile)
    const commit = JSON.parse(original.toString())
    expect(commit.operation.operation_id).toBe(failedA.json().operation_id)
    expect(failedSyncs).toBe(1)
    for (const endpoint of [url("status"), "/api/portal/publish/review-todos"]) {
      const unavailable = await app.inject({ url: endpoint, headers })
      if (action === "request-review" && endpoint === url("status")) {
        expect(unavailable.statusCode, unavailable.body).toBe(200)
        expect(unavailable.json()).toMatchObject({ state: "draft", review_id: null, receipt: null })
      } else {
        expect(unavailable.statusCode, unavailable.body).toBe(503)
        expect(unavailable.json()).toMatchObject({ code: endpoint === url("status") ? "PUBLISH_UNAVAILABLE" : "REVIEW_TASK_READ_FAILED", retryable: true })
      }
    }
    expect(failedSyncs).toBe(action === "approve" ? 3 : 2)
    const queryFailures = failedSyncs
    const failedB = await post("parent-sync-key-b")
    expect(failedB.statusCode, failedB.body).toBe(503)
    expect(failedB.json()).toMatchObject({ code: "PUBLISH_UNAVAILABLE", retryable: true })
    expect(failedSyncs).toBe(queryFailures + 1)
    expect(failedB.json().operation_id).not.toBe(failedA.json().operation_id)
    for (const response of [failedA, failedB]) {
      const operationDirectory = path.join(state, "operations", response.json().operation_id)
      expect(fs.existsSync(path.join(operationDirectory, "result/commit.json"))).toBe(false)
      expect(JSON.parse(fs.readFileSync(path.join(operationDirectory, "state.json"), "utf8"))).toMatchObject({ state: "retry_wait", code: "EIO" })
    }
    expect(fs.readFileSync(commitFile)).toEqual(original)
    syncSpy.mockRestore()
    renameSpy.mockRestore()
    await app.close(); await boot()
    const durableStatus = await app.inject({ url: url("status"), headers })
    expect(durableStatus.statusCode, durableStatus.body).toBe(200)
    if (action === "approve") expect(durableStatus.json()).toMatchObject({ state: "approved_waiting_export", receipt: commit.result.receipt })
    const durableTodos = await app.inject({ url: "/api/portal/publish/review-todos", headers })
    expect(durableTodos.statusCode, durableTodos.body).toBe(200)
    expect(durableTodos.json().tasks).toHaveLength(1)
    expect(durableTodos.json().tasks[0].state).toBe(action === "approve" ? "completed" : "superseded")
    const recoveredB = await post("parent-sync-key-b")
    expect(recoveredB.statusCode, recoveredB.body).toBe(201)
    const recoveredA = await post("parent-sync-key-a")
    expect(recoveredA.statusCode, recoveredA.body).toBe(action === "approve" ? 200 : 201)
    for (const response of [recoveredA, recoveredB]) {
      if (action === "approve") expect(response.json().receipt).toEqual(commit.result.receipt)
      else expect(response.json()).toMatchObject({ review_id: commit.review_id, revision_id: commit.revision_id, task_id: commit.result.task_id })
      const operation = await app.inject({ url: `/api/portal/publish/operations/${response.json().operation_id}`, headers })
      expect(operation.statusCode, operation.body).toBe(200)
      expect(operation.json()).toMatchObject({ state: "committed", result: response.json() })
    }
    expect(fs.readFileSync(commitFile)).toEqual(original)
    expect(fs.readdirSync(parent).filter(name => !name.startsWith("."))).toEqual([path.basename(committedPath!)])
    const todos = await app.inject({ url: "/api/portal/publish/review-todos", headers })
    expect(todos.statusCode, todos.body).toBe(200)
    expect(todos.json().tasks).toHaveLength(1)
    expect(todos.json().tasks[0].state).toBe(action === "approve" ? "completed" : "pending_review")
  })
  it("할 일 조회에서 승인자 설정 오류와 권한 없는 계정을 구별한다", async () => {
    await prepared()
    const get = (who = actor) => app.inject({ url: "/api/portal/publish/review-todos", headers: { ...headers, "x-naia-actor-id": who } })
    for (const value of [undefined, "", "test-gate:owner,", "other-gate:owner"]) {
      vi.stubEnv("PUBLISH_APPROVER_IDS", value)
      const response = await get()
      expect(response.statusCode, response.body).toBe(503)
      expect(response.json()).toMatchObject({ code: "publish_approver_unavailable", retryable: true })
      expect(response.headers["cache-control"]).toBe("no-store")
    }
    vi.stubEnv("PUBLISH_APPROVER_IDS", actor)
    const denied = await get("test-gate:other")
    expect(denied.statusCode).toBe(403)
    expect(denied.json()).toMatchObject({ code: "publish_approver_required", retryable: false })
    const permitted = await get()
    expect(permitted.statusCode).toBe(200)
    expect(permitted.json().tasks).toHaveLength(1)
  })

  it("할 일과 확인 요청의 담당자·판·연결이 손상되면 빈 성공 대신 503이다", async () => {
    vi.stubEnv("PUBLISH_APPROVER_IDS", `${actor},test-gate:second`)
    const { review } = await prepared()
    const taskFile = path.join(state, "reviews", review.review_id, "task.json")
    const requestFile = path.join(state, "reviews", review.review_id, "request.json")
    const originalTasks = fs.readFileSync(taskFile)
    const originalRequest = fs.readFileSync(requestFile)
    const original = JSON.parse(originalTasks.toString())
    expect(original).toHaveLength(2)
    const cases = [
      (tasks: any[]) => tasks.splice(0, 1),
      (tasks: any[]) => { tasks[1].assignee_id = tasks[0].assignee_id },
      (tasks: any[]) => { tasks[0].assignee_id = "test-gate:unknown" },
      (tasks: any[]) => { tasks[0].review_id = `review_${"0".repeat(64)}` },
      (tasks: any[]) => { tasks[0].revision_id = `rev_${"0".repeat(64)}` },
      (tasks: any[]) => { tasks[0].slug = "other-post" },
      (tasks: any[]) => { tasks[0].saved_revision = "0".repeat(64) },
      (tasks: any[]) => { tasks[0].task_id = "task_forged" },
      (tasks: any[]) => { tasks[0].review_url = "/docs?publishReview=other" },
      (tasks: any[]) => { tasks[0].created_at = "2030-01-01T00:00:00.000Z" },
    ]
    for (const change of cases) {
      const tasks = JSON.parse(originalTasks.toString())
      change(tasks)
      fs.writeFileSync(taskFile, JSON.stringify(tasks))
      const response = await app.inject({ url: "/api/portal/publish/review-todos", headers })
      expect(response.statusCode, response.body).toBe(503)
      expect(response.json()).toMatchObject({ code: "REVIEW_TASK_READ_FAILED", retryable: true })
      expect(response.headers["cache-control"]).toBe("no-store")
    }
    fs.writeFileSync(taskFile, originalTasks)
    const request = JSON.parse(originalRequest.toString())
    request.assignees = [actor]
    fs.writeFileSync(requestFile, JSON.stringify(request))
    const mismatch = await app.inject({ url: "/api/portal/publish/review-todos", headers })
    expect(mismatch.statusCode).toBe(503)
    expect(mismatch.json().code).toBe("REVIEW_TASK_READ_FAILED")
    fs.writeFileSync(requestFile, originalRequest)
    expect((await app.inject({ url: "/api/portal/publish/review-todos", headers })).statusCode).toBe(200)
  })

  it("같은 판 재요청은 할 일 하나이며 승인에서 완료를 파생하고 조회 장애는 503이다", async () => {
    const { review, view } = await prepared()
    const retried = await requestReview("another-review-key")
    expect(retried.json().review_id).toBe(review.review_id)
    let todos = await app.inject({ url: "/api/portal/publish/review-todos", headers })
    expect(todos.json().tasks).toHaveLength(1)
    expect(todos.json().tasks[0].review_url).toContain(`publishReview=${review.review_id}`)
    expect(todos.json().tasks[0].review_url).toContain(`publishRevision=${review.revision_id}`)
    expect(new URL(review.review_url, "http://localhost").searchParams.get("publishRevision")).toBe(review.revision_id)
    await approve(approvalInput(review, view))
    todos = await app.inject({ url: "/api/portal/publish/review-todos", headers })
    expect(todos.json().tasks[0].state).toBe("completed")
    fs.writeFileSync(path.join(state, "reviews", review.review_id, "task.json"), "not json")
    expect((await app.inject({ url: "/api/portal/publish/review-todos", headers })).statusCode).toBe(503)
  })
  it("승인 뒤 공개 시각 변경은 새 확인이 필요하고 대기판 그림은 원래 바이트를 반환한다", async () => {
    const { review, view } = await prepared()
    const asset = await app.inject({ url: view.assets[0].url, headers })
    expect(asset.statusCode, asset.body).toBe(200)
    expect(asset.rawPayload).toEqual(png)
    await approve(approvalInput(review, view))
    descriptor.frontmatter.date = "2030-11-05T20:00+09:00"; saveDescriptor()
    fs.writeFileSync(path.join(root, "docs/article/assets/hero.png"), Buffer.concat([png, Buffer.from("next")]))
    const status = await app.inject({ url: url("status"), headers })
    expect(status.json()).toMatchObject({ state: "changed_after_approval", changed_after_approval: true })
    expect((await app.inject({ url: view.assets[0].url, headers })).rawPayload).toEqual(png)
  })
  it("게시 설정을 옮긴 뒤 이전 원고 경로 권한을 철회하면 보관판 그림도 403이다", async () => {
    const configDir = path.join(root, "data-company/test-company")
    fs.mkdirSync(configDir, { recursive: true })
    const configFile = path.join(configDir, "adk-company.json")
    const config = { schemaVersion: 1, title: "시험 회사", docs: { include: [] }, repos: [{ id: "publish-source", path: "data-company/test-company/repo", remote: "https://example.test/publish.git", docs: { include: ["article", "other"] } }] }
    for (const folder of ["article", "other"]) fs.cpSync(path.join(root, "docs/article"), path.join(configDir, "repo", folder), { recursive: true })
    fs.writeFileSync(configFile, JSON.stringify(config))
    document = path.join(configDir, "repo/article/draft.md")
    descriptor.source = "publish-source"; saveDescriptor()
    const { view } = await prepared()
    const oldAsset = await app.inject({ url: view.assets[0].url, headers })
    expect(oldAsset.statusCode, oldAsset.body).toBe(200)
    expect(oldAsset.rawPayload).toEqual(png)
    descriptor.path = "other/draft.md"; saveDescriptor()
    const movedAsset = await app.inject({ url: view.assets[0].url, headers })
    expect(movedAsset.statusCode, movedAsset.body).toBe(200)
    expect(movedAsset.rawPayload).toEqual(png)
    config.repos[0].docs.include = ["other"]
    fs.writeFileSync(configFile, JSON.stringify(config))
    const revokedAsset = await app.inject({ url: view.assets[0].url, headers })
    expect(revokedAsset.statusCode, revokedAsset.body).toBe(403)
    expect(revokedAsset.json().code).toBe("DOCUMENT_FORBIDDEN")
    document = path.join(configDir, "repo/other/draft.md")
    const currentReview = await requestReview("current-path-review-key")
    expect(currentReview.statusCode, currentReview.body).toBe(201)
    const currentView = await preview(currentReview.json())
    const currentAsset = await app.inject({ url: currentView.assets[0].url, headers })
    expect(currentAsset.statusCode, currentAsset.body).toBe(200)
    expect(currentAsset.rawPayload).toEqual(png)
  })
  it.each(["본문 경계 삭제", "필수 앞머리 삭제", "그림 형식 파손"])("승인 뒤 %s도 기존 승인판과 영수증·자료 오류·새 확인 필요 상태를 함께 조회한다", async (change) => {
    const { review, view } = await prepared()
    const approved = await approve(approvalInput(review, view))
    expect(approved.statusCode, approved.body).toBe(201)
    if (change === "본문 경계 삭제") fs.writeFileSync(document, fs.readFileSync(document, "utf8").replace("## 본문", "## 삭제된 경계"))
    if (change === "필수 앞머리 삭제") { delete descriptor.frontmatter.summary; saveDescriptor() }
    if (change === "그림 형식 파손") fs.writeFileSync(path.join(root, "docs/article/assets/hero.png"), "그림 아님")
    const response = await app.inject({ url: url("status"), headers })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({ state: "changed_after_approval", changed_after_approval: true, approved_revision_id: view.revision_id, receipt: approved.json().receipt, can_approve: false, can_request_review: false, draft_error: { code: "invalid_bundle", message: expect.any(String), issues: [expect.objectContaining({ field: expect.any(String) })] } })
    expect(response.json().revision_id).toBeNull()
    const operation = await app.inject({ url: `/api/portal/publish/operations/${approved.json().operation_id}`, headers })
    expect(operation.statusCode, operation.body).toBe(200)
    expect(operation.json().result.receipt).toEqual(approved.json().receipt)
    expect(approvedFiles()).toEqual([view.revision_id])
    fs.writeFileSync(document, "안내\r\n\r\n## 본문\r\n\r\n# 게시 제목\r\n\r\n본문 공백  \r\n![그림](assets/hero.png)\r\n\r\n---\r\n\r\n## 근거표\r\n비공개 근거와 대화 기록\r\n")
    descriptor.frontmatter.summary = "시험용 요약"; saveDescriptor()
    fs.writeFileSync(path.join(root, "docs/article/assets/hero.png"), png)
    const restored = await app.inject({ url: url("status"), headers })
    expect(restored.statusCode, restored.body).toBe(200)
    expect(restored.json()).toMatchObject({ state: "approved_waiting_export", changed_after_approval: false, receipt: approved.json().receipt, draft_error: null })
  })
  it("서명키·허용 공개키 불일치는 503으로 거절하고 승인 기록이 없다", async () => {
    const { review, view } = await prepared()
    vi.stubEnv("PUBLISH_PUBLIC_KEYS", "{}")
    expect((await approve(approvalInput(review, view))).statusCode).toBe(503)
    expect(approvedFiles()).toEqual([])
  })
  it("사소2·3 현재 판 승인을 우선하고 모든 묶음 요소 변경을 별도 속성과 1초 안의 상태로 판정한다", async () => {
    const { review, view } = await prepared()
    await approve(approvalInput(review, view))
    const original = fs.readFileSync(document)
    const baseline = structuredClone(descriptor)
    const changes = [
      () => fs.appendFileSync(document, " "),
      () => fs.writeFileSync(document, original.toString().replace("본문 공백", "게시 공백")),
      () => { descriptor.frontmatter.title = "새 제목" },
      () => fs.writeFileSync(path.join(root, "docs/article/assets/hero.png"), Buffer.concat([png, Buffer.from("changed")])),
      () => { descriptor.media_map.en = { ready: true, hero: "assets/hero.png", body_images: ["assets/hero.png"] } },
      () => { descriptor.frontmatter.targets = ["site-a"]; descriptor.frontmatter.languages = { "site-a": ["ko", "en"] } },
      () => { descriptor.frontmatter.languages = { "site-a": ["ko", "en", "ja"], "site-b": ["ko", "en"] }; descriptor.media_map.ja = { ready: false } },
      () => { descriptor.frontmatter.date = "2030-11-06T20:00+09:00" },
    ]
    for (const change of changes) {
      descriptor = structuredClone(baseline); fs.writeFileSync(document, original); fs.writeFileSync(path.join(root, "docs/article/assets/hero.png"), png)
      change(); saveDescriptor()
      const response = await app.inject({ url: url("status"), headers })
      expect(response.statusCode, response.body).toBe(200)
      expect(response.json()).toMatchObject({ state: "changed_after_approval", changed_after_approval: true })
      expect(response.json().elapsed_ms).toBeLessThan(1000)
      expect(response.json().elapsed_ms + response.json().max_poll_interval_ms).toBeLessThanOrEqual(5000)
    }
    descriptor = baseline; saveDescriptor(); fs.writeFileSync(document, original); fs.writeFileSync(path.join(root, "docs/article/assets/hero.png"), png)
    expect((await app.inject({ url: url("status"), headers })).json()).toMatchObject({ state: "approved_waiting_export", changed_after_approval: false })
  })
  it("다른 멱등키의 기존 승인 재사용도 결과 확정 뒤 중단되면 원고 검사 전에 복구한다", async () => {
    const { review, view } = await prepared()
    const input = approvalInput(review, view)
    const first = await approve(input)
    let resultCommitted = false
    fault = (point) => { if (point === "after_commit") resultCommitted = true; if (point === "operation_write" && resultCommitted) throw new Error("result committed") }
    expect((await approve(input, "alias-key")).statusCode).toBe(503)
    fs.appendFileSync(document, "바뀐 초안")
    await app.close(); fault = () => {}; await boot()
    const recovered = await approve(input, "alias-key")
    expect(recovered.statusCode, recovered.body).toBe(200)
    expect(recovered.json().receipt.receipt_id).toBe(first.json().receipt.receipt_id)
    expect(approvedFiles()).toHaveLength(1)
  })
  it("처리 기록은 원요청자나 요청 당시 담당자만 열고 나중에 추가된 승인자는 거절한다", async () => {
    const { review } = await prepared()
    vi.stubEnv("PUBLISH_APPROVER_IDS", `${actor},test-gate:new-owner`)
    const denied = await app.inject({ url: `/api/portal/publish/operations/${review.operation_id}`, headers: { ...headers, "x-naia-actor-id": "test-gate:new-owner" } })
    expect(denied.statusCode).toBe(403)
    const permitted = await app.inject({ url: `/api/portal/publish/operations/${review.operation_id}`, headers })
    expect(permitted.statusCode).toBe(200)
  })
  it.each([false, true])("담당자를 교체하고 재시작하면 옛 담당자의 할 일·타인 기록은 403이며 같은 키와 원요청자는 유지한다: 확정 전 실패=%s", async (failBeforeCommit) => {
    const requester = "test-gate:writer"
    const replacement = "test-gate:new-owner"
    const input = { saved_revision: hashBytes(fs.readFileSync(document)) }
    const post = () => app.inject({ method: "POST", url: url("request-review"), headers: { ...headers, "x-naia-actor-id": requester, "idempotency-key": "removed-assignee-retry" }, payload: input })
    if (failBeforeCommit) fault = (point) => { if (point === "review_commit") throw new Error("review not committed") }
    const initial = await post()
    expect(initial.statusCode, initial.body).toBe(failBeforeCommit ? 503 : 201)
    const operationId = initial.json().operation_id
    const operationFile = path.join(state, "operations", operationId, "state.json")
    expect(JSON.parse(fs.readFileSync(operationFile, "utf8"))).toMatchObject({ assignee_ids: [actor], requester_id: requester })
    vi.stubEnv("PUBLISH_APPROVER_IDS", replacement)
    await app.close(); fault = () => {}; await boot()
    const retried = await post()
    expect(retried.statusCode, retried.body).toBe(failBeforeCommit ? 201 : 200)
    const review = retried.json()
    expect(review.operation_id).toBe(operationId)
    expect(JSON.parse(fs.readFileSync(path.join(state, "reviews", review.review_id, "commit.json"), "utf8")).assignees).toEqual([actor])
    expect(JSON.parse(fs.readFileSync(path.join(state, "reviews", review.review_id, "task.json"), "utf8")).map((task: any) => task.assignee_id)).toEqual([actor])
    expect(JSON.parse(fs.readFileSync(operationFile, "utf8")).assignee_ids).toEqual([actor])
    for (const [who, expected] of [[actor, 403], [replacement, 403], [requester, 200]] as const) {
      const operation = await app.inject({ url: `/api/portal/publish/operations/${operationId}`, headers: { ...headers, "x-naia-actor-id": who } })
      expect(operation.statusCode, operation.body).toBe(expected)
      if (expected === 200) expect(operation.json()).toMatchObject({ requester_id: requester, state: "committed", assignee_ids: [actor], result: review })
    }
    const revokedTodos = await app.inject({ url: "/api/portal/publish/review-todos", headers })
    expect(revokedTodos.statusCode, revokedTodos.body).toBe(403)
    const replacementTodos = await app.inject({ url: "/api/portal/publish/review-todos", headers: { ...headers, "x-naia-actor-id": replacement } })
    expect(replacementTodos.statusCode, replacementTodos.body).toBe(200)
    expect(replacementTodos.json().tasks).toEqual([])
    const replay = await post()
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json()).toEqual(review)
  })
  it("할 일 수백 개의 조회는 확인판·선택 기록을 한 번씩 읽고 같은 부모를 한 번씩 동기화한다", async () => {
    const { review } = await prepared()
    const original = JSON.parse(fs.readFileSync(path.join(state, "reviews", review.review_id, "commit.json"), "utf8"))
    const originalTask = JSON.parse(fs.readFileSync(path.join(state, "reviews", review.review_id, "task.json"), "utf8"))[0]
    const writeRecord = (relative: string, record: unknown) => {
      const target = path.join(state, relative)
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
      fs.writeFileSync(target, JSON.stringify(record), { mode: 0o600 })
    }
    let latestReviewId = "", previousCount = 0
    for (const count of [200, 400]) {
      for (let i = previousCount; i < count; i++) {
        const revision_id = `rev_${hashBytes(Buffer.from(`historical revision ${i}`))}`
        const review_id = `review_${hashBytes(canonicalBytes({ slug: descriptor.slug, revision_id, kind: "publish_review", assignees: [actor] }))}`
        const scope = { ...original.operation.scope, key_hash: hashBytes(Buffer.from(`historical key ${i}`)) }
        const operation_id = `op_${hashBytes(canonicalBytes(scope))}`
        const operation = { ...original.operation, scope, operation_id }
        const query = new URL(original.result.review_url, "https://portal.invalid")
        query.searchParams.set("publishReview", review_id)
        query.searchParams.set("publishRevision", revision_id)
        const review_url = query.pathname + query.search
        const task_id = `task_${review_id.slice(7)}_${hashBytes(Buffer.from(actor)).slice(0, 12)}`
        const result = { ...original.result, operation_id, review_id, revision_id, review_url, task_id }
        const record = { ...original, review_id, revision_id, operation, result }
        writeRecord(`reviews/${review_id}/commit.json`, record)
        writeRecord(`reviews/${review_id}/request.json`, record)
        writeRecord(`reviews/${review_id}/task.json`, [{ ...originalTask, task_id, review_id, revision_id, review_url }])
        writeRecord(`selections/${operation_id}/commit.json`, { slug: descriptor.slug, review_id, sequence: i + 2, operation, result })
        latestReviewId = review_id
      }
      const json = vi.spyOn(PublishStore.prototype, "json")
      const sync = vi.spyOn(PublishStore.prototype, "syncDir")
      try {
        const response = await app.inject({ url: "/api/portal/publish/review-todos", headers })
        expect(response.statusCode, response.body).toBe(200)
        const tasks = response.json().tasks
        expect(tasks).toHaveLength(count + 1)
        expect(tasks.filter((task: any) => task.state === "pending_review").map((task: any) => task.review_id)).toEqual([latestReviewId])
        expect(tasks.filter((task: any) => task.state === "superseded")).toHaveLength(count)
        for (const kind of ["reviews", "selections"] as const) {
          const commits = json.mock.calls.filter(([relative]) => relative.startsWith(`${kind}/`) && relative.endsWith("/commit.json"))
          expect(commits).toHaveLength(count + 1)
          expect(new Set(commits.map(([relative]) => relative)).size).toBe(count + 1)
          expect(sync.mock.calls.filter(([directory]) => directory === path.join(state, kind))).toHaveLength(1)
        }
        expect(sync).toHaveBeenCalledTimes(2)
      } finally { json.mockRestore(); sync.mockRestore() }
      previousCount = count
    }
  })
  it("확인 요청 확정 전 실패 뒤 같은 키 재시도는 당시 담당자를 확인판·할 일·처리 기록에 함께 유지한다", async () => {
    const requester = "test-gate:writer"
    const addedActor = "test-gate:new-owner"
    const requestHeaders = { ...headers, "x-naia-actor-id": requester, "idempotency-key": "retry-review-assignees" }
    const input = { saved_revision: hashBytes(fs.readFileSync(document)) }
    const post = () => app.inject({ method: "POST", url: url("request-review"), headers: requestHeaders, payload: input })
    fault = (point) => { if (point === "review_commit") throw new Error("review not committed") }
    const failed = await post()
    expect(failed.statusCode, failed.body).toBe(503)
    const operationId = failed.json().operation_id
    const operationFile = path.join(state, "operations", operationId, "state.json")
    expect(JSON.parse(fs.readFileSync(operationFile, "utf8"))).toMatchObject({ state: "retry_wait", assignee_ids: [actor], requester_id: requester })
    expect(fs.readdirSync(path.join(state, "reviews")).filter((name) => name.startsWith("review_"))).toEqual([])
    vi.stubEnv("PUBLISH_APPROVER_IDS", `${actor},${addedActor}`)
    await app.close(); fault = () => {}; await boot()
    const retried = await post()
    expect(retried.statusCode, retried.body).toBe(201)
    expect(retried.json().operation_id).toBe(operationId)
    const review = retried.json()
    const storedReview = JSON.parse(fs.readFileSync(path.join(state, "reviews", review.review_id, "commit.json"), "utf8"))
    const storedTasks = JSON.parse(fs.readFileSync(path.join(state, "reviews", review.review_id, "task.json"), "utf8"))
    const storedOperation = JSON.parse(fs.readFileSync(operationFile, "utf8"))
    expect(storedReview.assignees).toEqual([actor])
    expect(storedReview.operation.assignee_ids).toEqual(storedReview.assignees)
    expect(storedTasks.map((task: any) => task.assignee_id)).toEqual(storedReview.assignees)
    expect(storedOperation.assignee_ids).toEqual(storedReview.assignees)
    for (const [who, expected] of [[requester, 200], [actor, 200], [addedActor, 403]] as const) {
      const operation = await app.inject({ url: `/api/portal/publish/operations/${operationId}`, headers: { ...headers, "x-naia-actor-id": who } })
      expect(operation.statusCode, operation.body).toBe(expected)
      if (expected === 200) expect(operation.json()).toMatchObject({ state: "committed", assignee_ids: [actor], result: retried.json() })
    }
    const todos = await app.inject({ url: "/api/portal/publish/review-todos", headers })
    expect(todos.statusCode, todos.body).toBe(200)
    expect(todos.json().tasks).toMatchObject([{ review_id: review.review_id, assignee_id: actor, state: "pending_review" }])
    const addedTodos = await app.inject({ url: "/api/portal/publish/review-todos", headers: { ...headers, "x-naia-actor-id": addedActor } })
    expect(addedTodos.statusCode, addedTodos.body).toBe(200)
    expect(addedTodos.json().tasks).toEqual([])
    const replay = await post()
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json()).toEqual(retried.json())
    expect(fs.readdirSync(path.join(state, "reviews")).filter((name) => name.startsWith("review_"))).toEqual([review.review_id])
    const next = await requestReview("new-review-assignees")
    expect(next.statusCode, next.body).toBe(201)
    expect(next.json().review_id).not.toBe(review.review_id)
    const nextOperation = await app.inject({ url: `/api/portal/publish/operations/${next.json().operation_id}`, headers: { ...headers, "x-naia-actor-id": addedActor } })
    expect(nextOperation.statusCode, nextOperation.body).toBe(200)
    expect(nextOperation.json().assignee_ids).toEqual([actor, addedActor].sort())
  })
  it.each(["옛 기록 먼저", "새 기록 먼저"])("같은 판 담당자 추가 뒤 처리 기록은 각 요청 당시 담당자만 열람한다: %s", async (order) => {
    const { review } = await prepared()
    let addedActor = ""
    for (let i = 0; i < 100; i++) {
      const candidate = `test-gate:added-${i}`
      const candidateId = `review_${hashBytes(canonicalBytes({ slug: descriptor.slug, revision_id: review.revision_id, kind: "publish_review", assignees: [actor, candidate].sort() }))}`
      if ((candidateId < review.review_id) === (order === "새 기록 먼저")) { addedActor = candidate; break }
    }
    expect(addedActor).not.toBe("")
    vi.stubEnv("PUBLISH_APPROVER_IDS", `${actor},${addedActor}`)
    const response = await requestReview("review-with-added-assignee")
    expect(response.statusCode, response.body).toBe(201)
    const next = response.json()
    expect(next.revision_id).toBe(review.revision_id)
    expect(next.review_id).not.toBe(review.review_id)
    expect(fs.readdirSync(path.join(state, "reviews")).filter((name) => name.startsWith("review_")).sort()).toEqual(order === "옛 기록 먼저" ? [review.review_id, next.review_id] : [next.review_id, review.review_id])
    const operation = (id: string, who = addedActor) => app.inject({ url: `/api/portal/publish/operations/${id}`, headers: { ...headers, "x-naia-actor-id": who } })
    expect((await operation(review.operation_id)).statusCode).toBe(403)
    expect((await operation(next.operation_id)).statusCode).toBe(200)
    expect((await operation(review.operation_id, actor)).statusCode).toBe(200)
    expect((await operation(next.operation_id, actor)).statusCode).toBe(200)
    const nextState = path.join(state, "operations", next.operation_id, "state.json")
    const snapshot = fs.readFileSync(nextState)
    fs.writeFileSync(nextState, JSON.stringify({ ...JSON.parse(snapshot.toString()), assignee_ids: [] }))
    expect((await operation(next.operation_id)).statusCode).toBe(403)
    expect((await operation(next.operation_id, actor)).statusCode).toBe(200)
    fs.writeFileSync(nextState, snapshot)
    // Older operation records without a snapshot must use exact operation/review links.
    const alias = await requestReview("review-with-added-assignee-alias")
    expect(alias.statusCode, alias.body).toBe(201)
    expect(alias.json().review_id).toBe(next.review_id)
    for (const id of [review.operation_id, next.operation_id, alias.json().operation_id]) {
      const file = path.join(state, "operations", id, "state.json")
      const stored = JSON.parse(fs.readFileSync(file, "utf8"))
      expect(stored.assignee_ids).toEqual(id === review.operation_id ? [actor] : [actor, addedActor].sort())
      delete stored.assignee_ids
      fs.writeFileSync(file, JSON.stringify(stored))
    }
    expect((await operation(review.operation_id)).statusCode).toBe(403)
    expect((await operation(next.operation_id)).statusCode).toBe(200)
    expect((await operation(alias.json().operation_id)).statusCode).toBe(200)
    for (const id of [review.operation_id, next.operation_id, alias.json().operation_id]) {
      const file = path.join(state, "operations", id, "result/commit.json")
      const stored = JSON.parse(fs.readFileSync(file, "utf8"))
      delete stored.result.review_id
      fs.writeFileSync(file, JSON.stringify(stored))
    }
    expect((await operation(review.operation_id)).statusCode).toBe(403)
    expect((await operation(review.operation_id, actor)).statusCode).toBe(200)
    expect((await operation(next.operation_id)).statusCode).toBe(200)
    expect((await operation(alias.json().operation_id)).statusCode).toBe(403)
  })
  it("문서 저장과 승인 경쟁은 변경을 거절한다", async () => {
    const { review, view } = await prepared()
    await app.close()
    let entered!: () => void, release!: () => void
    const writing = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    await boot(async () => { entered(); await gate })
    const content = fs.readFileSync(document, "utf8") + "\n변경\n"
    const save = app.inject({ method: "PUT", url: "/api/portal/doc?source=adk&path=article/draft.md", headers, payload: { content, baseHash: view.saved_revision } })
    const savePromise = save.then((result) => result)
    await writing
    const approvalPromise = approve(approvalInput(review, view)).then((result) => result)
    release()
    expect((await savePromise).statusCode).toBe(200)
    const attempted = await approvalPromise
    const finalApproval = attempted.statusCode === 202 ? await approve(approvalInput(review, view)) : attempted
    expect(finalApproval.statusCode).toBe(409)
    expect(approvedFiles()).toEqual([])
  })
})
