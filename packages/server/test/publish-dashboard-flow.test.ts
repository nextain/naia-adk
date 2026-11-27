import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { hashBytes } from "../src/publish-bundle.js"
import { verifyApprovalReceipt } from "../src/publish-service.js"
import { getPublishDocument, getPublishPreview, getPublishStatus, PublishClientError, PublishMutation, publishErrorMessage,
  watchPublishStatus, type PublishReviewResult, type PublishApprovalResult, type PublishPreviewResponse } from "../../dashboard/app/docs/publish-client"
import { loadPublishReviewTodos, publishReviewTimelineItems, MSG_PUBLISH_REVIEW_TODOS_FAILED } from "../../dashboard/app/components/publish-review-todos"
import { sampleFixtureDirectory, byteSnapshot, checkoutGitMarkers, createPublishFixture, fixtureActor, startPublishDashboard,
  type PublishFixtureDocument } from "./publish-dashboard-fixture"
import { SITE_ALPHA, SITE_BETA } from "./publish-fixtures.js"

describe("설계 7-3 실제 대시보드 프록시와 표본 두 원고 관통", () => {
  let fixture: ReturnType<typeof createPublishFixture>
  let live: Awaited<ReturnType<typeof startPublishDashboard>> | undefined
  let originalFixtures: Record<string, Buffer>, baseline: Record<string, Buffer>
  beforeEach(() => {
    originalFixtures = byteSnapshot(sampleFixtureDirectory)
    fixture = createPublishFixture()
    for (const [name, value] of Object.entries(fixture.env)) vi.stubEnv(name, value)
    // 지정한 두 checkout 표지만 제외한다. 사본 자체의 .git/출처 검사는 유지한다.
    const exists = fs.existsSync
    vi.spyOn(fs, "existsSync").mockImplementation(file => !checkoutGitMarkers.includes(path.resolve(String(file))) && exists(file))
    baseline = byteSnapshot(path.join(fixture.root, "docs"))
  })
  afterEach(async () => {
    try { await live?.close(); expect(byteSnapshot(sampleFixtureDirectory)).toEqual(originalFixtures) }
    finally { live = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs() }
  })
  const preserved = (document?: PublishFixtureDocument, changed?: Buffer, assetChanges: Record<string, Buffer> = {}) => {
    const expected = { ...baseline, ...assetChanges }
    if (document && changed) expected[document.path] = changed
    expect(byteSnapshot(path.join(fixture.root, "docs"))).toEqual(expected)
    expect(byteSnapshot(sampleFixtureDirectory)).toEqual(originalFixtures)
    expect(live!.observed.filter(request => request.method === "PUT" && request.url.startsWith("/api/portal/doc"))).toEqual([])
  }
  const request = async (document: PublishFixtureDocument, mutation = new PublishMutation()) => {
    const result = await mutation.execute(document.slug, "request-review", { saved_revision: hashBytes(fs.readFileSync(document.file)) }, live!.fetchFn)
    expect(result.state).toBe("pending_review")
    return result as PublishReviewResult
  }
  const approvalInput = (review: PublishReviewResult, view: PublishPreviewResponse) => ({ review_id: review.review_id, revision_id: review.revision_id, saved_revision: view.saved_revision, preview_hash: view.preview_hash })
  const prepared = async () => {
    live = await startPublishDashboard(fixture)
    const document = fixture.documents[0], review = await request(document)
    const view = await getPublishPreview(document.slug, review.review_id, review.revision_id, live.fetchFn)
    return { document, review, view }
  }

  it.each([{ index: 0, name: "sample-blog-4-stages-20261101.md" }, { index: 1, name: "sample-research-note-20261101.md" }])("7-3 A6 $name: GET만 열기→요청→정확한 할 일→두 사이트→승인→1바이트 변경 5초→새 확인·재승인", async ({ index }) => {
    live = await startPublishDashboard(fixture)
    const document = fixture.documents[index], mutation = new PublishMutation()
    const open = await live.fetchFn(`/api/portal/doc?${new URLSearchParams({ source: document.source, path: document.path })}`)
    expect(open.status).toBe(200)
    expect(await open.text()).toBe(document.original.toString("utf8"))
    preserved()
    expect(await getPublishDocument(document.source, document.path, live.fetchFn)).toMatchObject({ slug: document.slug, can_request_review: true })
    const draft = await getPublishStatus(document.slug, live.fetchFn)
    expect(draft).toMatchObject({ state: "draft", saved_revision: hashBytes(document.original) })
    preserved()
    const review = await request(document, mutation)
    preserved()
    const repeated = await request(document, mutation)
    expect(repeated).toMatchObject({ review_id: review.review_id, revision_id: review.revision_id, task_id: review.task_id, review_url: review.review_url })
    preserved()
    const tasks = await loadPublishReviewTodos(live.fetchFn)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ kind: "publish_review", title: `게시 확인: 시험 사본 ${document.slug}`, assignee_id: fixtureActor,
      review_id: review.review_id, revision_id: review.revision_id, review_url: review.review_url, state: "pending_review" })
    const target = new URL(tasks[0].review_url, live.origin)
    expect(target.pathname).toBe("/docs")
    expect(Object.fromEntries(target.searchParams)).toMatchObject({ source: document.source, path: document.path, publishReview: review.review_id, publishRevision: review.revision_id })
    const items = publishReviewTimelineItems(tasks)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: "publish_review", title: tasks[0].title, links: [{ label: "요청판 열기", href: tasks[0].review_url, external: false }] })
    preserved()
    const view = await getPublishPreview(document.slug, target.searchParams.get("publishReview")!, target.searchParams.get("publishRevision")!, live.fetchFn)
    expect(view.can_approve).toBe(true)
    expect(Object.keys(view.previews).sort()).toEqual([SITE_ALPHA, SITE_BETA])
    for (const site of [SITE_ALPHA, SITE_BETA]) {
      const display = view.previews[site].ko
      const artifact = fs.readFileSync(path.join(fixture.state, "objects", view.preview_hash, "previews", site, "ko.json"))
      expect(display).toEqual({ ...JSON.parse(artifact.toString("utf8")), sha256: hashBytes(artifact) })
      expect(display).toMatchObject({ title: document.descriptor.frontmatter.title, summary: document.descriptor.frontmatter.summary, hero: document.descriptor.frontmatter.hero })
      expect(display.body).not.toMatch(/## 근거표 \(게시 전에 뺍니다\)|## 근거 대조 \(게시 때 뺌\)/)
      expect([...display.body.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(match => match[1])).toEqual((document.descriptor.media_map.ko as { body_images: string[] }).body_images)
    }
    expect(view.assets).toHaveLength(index === 0 ? 10 : 1)
    for (const asset of view.assets) {
      const response = await live.fetchFn(asset.url)
      expect(response.status).toBe(200)
      const bytes = Buffer.from(await response.arrayBuffer())
      const originalPath = Object.entries(document.descriptor.asset_path_map).find(([, destination]) => destination === asset.path)?.[0] ?? asset.path
      expect(bytes).toEqual(fs.readFileSync(path.join(path.dirname(document.file), originalPath)))
      expect(hashBytes(bytes)).toBe(asset.sha256)
    }
    preserved()
    const first = await mutation.execute(document.slug, "approve", approvalInput(review, view), live.fetchFn) as PublishApprovalResult
    expect(first.state).toBe("approved_waiting_export")
    expect(verifyApprovalReceipt(first.receipt as any, { "dashboard-test-key": fixture.publicKey })).toBe(true)
    expect(fs.readFileSync(path.join(fixture.state, "objects", view.preview_hash, "source.bin"))).toEqual(document.original)
    preserved()
    expect(await getPublishStatus(document.slug, live.fetchFn)).toMatchObject({ state: "approved_waiting_export", receipt: first.receipt })
    expect((await loadPublishReviewTodos(live.fetchFn))[0].state).toBe("completed")
    const firstObjectPath = path.join(fixture.state, "objects", view.preview_hash), firstApprovalPath = path.join(fixture.state, "approvals", document.slug, view.revision_id)
    const firstObject = byteSnapshot(firstObjectPath), firstApproval = byteSnapshot(firstApprovalPath)
    preserved()
    const changed = Buffer.concat([document.original, Buffer.from(" ")])
    let changedAt = 0, sawApprovedBeforeChange = false
    await new Promise<void>((resolve, reject) => {
      let poller: ReturnType<typeof watchPublishStatus>
      const deadline = setTimeout(() => { poller.stop(); reject(new Error("변경 표시가 5초를 넘었습니다")) }, 5000)
      poller = watchPublishStatus(document.slug, (status, error) => {
        if (error) { clearTimeout(deadline); poller.stop(); reject(error) }
        else if (status?.state === "approved_waiting_export" && !sawApprovedBeforeChange) {
          sawApprovedBeforeChange = true
          changedAt = performance.now()
          fs.writeFileSync(document.file, changed)
        } else if (status?.state === "changed_after_approval") { clearTimeout(deadline); poller.stop(); resolve() }
      }, live!.fetchFn)
    })
    expect(sawApprovedBeforeChange).toBe(true)
    expect(performance.now() - changedAt).toBeLessThan(5000)
    preserved(document, changed)
    const next = await request(document, mutation)
    expect(next.revision_id).not.toBe(review.revision_id)
    preserved(document, changed)
    const nextView = await getPublishPreview(document.slug, next.review_id, next.revision_id, live.fetchFn)
    preserved(document, changed)
    const second = await mutation.execute(document.slug, "approve", approvalInput(next, nextView), live.fetchFn) as PublishApprovalResult
    expect(second).toMatchObject({ state: "approved_waiting_export" })
    expect(second.receipt.receipt_id).not.toBe(first.receipt.receipt_id)
    expect(await getPublishStatus(document.slug, live.fetchFn)).toMatchObject({ state: "approved_waiting_export", changed_after_approval: false, receipt: second.receipt })
    expect(fs.readFileSync(path.join(fixture.state, "objects", view.preview_hash, "source.bin"))).toEqual(document.original)
    expect(verifyApprovalReceipt(first.receipt as any, { "dashboard-test-key": fixture.publicKey })).toBe(true)
    expect(byteSnapshot(firstObjectPath)).toEqual(firstObject)
    expect(byteSnapshot(firstApprovalPath)).toEqual(firstApproval)
    expect((await loadPublishReviewTodos(live.fetchFn)).filter(task => task.state === "pending_review")).toEqual([])
    preserved(document, changed)
    expect(live.observed.filter(request => request.url.startsWith("/api/portal/publish/")).every(request => request.actor === fixtureActor && request.account === undefined)).toBe(true)
    expect(live.observed.find(request => request.url.startsWith("/api/portal/doc?"))).toMatchObject({ actor: undefined, account: undefined })
  }, 30_000)

  it("7-3 A5 확인 표시 꺼짐은 실제 proxy 전 403·담당자 안내이며 서버 호출은 0이다", async () => {
    live = await startPublishDashboard(fixture)
    for (const flag of [undefined, "", "0", "true"]) {
      live.dashboardEnv.PUBLISH_GATEWAY_OVERWRITE_CONFIRMED = flag
      const before = live.observed.length
      let failure: unknown
      try { await getPublishStatus(fixture.documents[0].slug, live.fetchFn) } catch (error) { failure = error }
      expect(failure).toBeInstanceOf(PublishClientError)
      expect(failure).toMatchObject({ status: 403, code: "publish_gateway_unconfirmed", retryable: false })
      expect(publishErrorMessage(failure)).toBe("게시 기능 준비 중입니다.")
      expect(live.observed).toHaveLength(before)
      preserved()
      await expect(new PublishMutation().execute(fixture.documents[0].slug, "approve", {
        review_id: "review_disabled", revision_id: "rev_disabled", saved_revision: "0".repeat(64), preview_hash: "0".repeat(64),
      }, live.fetchFn)).rejects.toMatchObject({ status: 403, code: "publish_gateway_unconfirmed", retryable: false })
      expect(live.observed).toHaveLength(before)
      preserved()
    }
  })

  it("7-3 그림만 바뀌어 저장판 지문이 같아도 새 확인 요청은 새 요청판·할 일 하나로 이동한다", async () => {
    live = await startPublishDashboard(fixture)
    const document = fixture.documents[0], mutation = new PublishMutation()
    const before = await getPublishStatus(document.slug, live.fetchFn), first = await request(document, mutation)
    preserved()
    const assetPath = "article/sample-blog-4-stages-20261101/thumbnail.png"
    const assetFile = path.join(fixture.root, "docs", assetPath)
    const changedAsset = Buffer.concat([fs.readFileSync(assetFile), Buffer.from(" ")])
    fs.writeFileSync(assetFile, changedAsset)
    preserved(undefined, undefined, { [assetPath]: changedAsset })
    const current = await getPublishStatus(document.slug, live.fetchFn)
    expect(current.saved_revision).toBe(before.saved_revision)
    expect(current.revision_id).not.toBe(first.revision_id)
    const second = await request(document, mutation)
    expect(second.revision_id).toBe(current.revision_id)
    expect(second.review_id).not.toBe(first.review_id)
    const tasks = await loadPublishReviewTodos(live.fetchFn)
    expect(tasks.filter(task => task.state === "pending_review")).toHaveLength(1)
    expect(tasks.find(task => task.state === "pending_review")).toMatchObject({ review_id: second.review_id, revision_id: second.revision_id, review_url: second.review_url })
    expect(tasks.find(task => task.review_id === first.review_id)?.state).toBe("superseded")
    const requests = live.observed.filter(item => item.url.endsWith("/request-review"))
    expect(requests).toHaveLength(2); expect(requests[0].key).not.toBe(requests[1].key)
    preserved(undefined, undefined, { [assetPath]: changedAsset })
  })

  it("7-3 일반 계정 미리보기는 승인 불가·직접 승인은 403이며 외부 승인자 헤더를 덮어쓴다", async () => {
    const { document, review, view } = await prepared()
    live!.setAccount("other")
    expect((await getPublishPreview(document.slug, review.review_id, review.revision_id, live!.fetchFn)).can_approve).toBe(false)
    const response = await live!.fetchFn(`/api/portal/publish/${document.slug}/approve`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "forged-owner", "x-ax-account-key": "owner", "x-naia-actor-id": fixtureActor, "x-naia-actor-verified": "1" }, body: JSON.stringify(approvalInput(review, view)) })
    expect(response.status).toBe(403)
    expect(live!.observed.at(-1)).toMatchObject({ actor: "test-gate:other", account: undefined })
    expect(fs.existsSync(path.join(fixture.state, "approvals", document.slug))).toBe(false)
    preserved()
  })

  it("7-3 미리보기 뒤 1바이트 변경은 409 안내이며 승인 완료·영수증이 없다", async () => {
    const { document, review, view } = await prepared()
    const changed = Buffer.concat([document.original, Buffer.from(" ")]); fs.writeFileSync(document.file, changed)
    let failure: unknown
    try { await new PublishMutation().execute(document.slug, "approve", approvalInput(review, view), live.fetchFn) } catch (error) { failure = error }
    expect(failure).toMatchObject({ status: 409, code: "PREVIEW_CHANGED", retryable: false })
    expect(publishErrorMessage(failure)).toContain("현재 저장판을 다시 열고 새 게시 확인")
    expect((await getPublishStatus(document.slug, live.fetchFn)).receipt).toBeNull()
    expect(fs.existsSync(path.join(fixture.state, "approvals", document.slug))).toBe(false)
    preserved(document, changed)
  })

  it("7-3 할 일 생성 실패·조회 장애·승인 응답 유실을 같은 요청으로 재시도해 하나로 복구한다", async () => {
    live = await startPublishDashboard(fixture)
    const document = fixture.documents[0], mutation = new PublishMutation()
    live.faults.point = "task_write"; live.faults.remaining = 1
    await expect(request(document, mutation)).rejects.toMatchObject({ status: 503, code: "PUBLISH_UNAVAILABLE", retryable: true })
    expect(await getPublishStatus(document.slug, live.fetchFn)).toMatchObject({ state: "draft" })
    preserved()
    const review = await request(document, mutation)
    expect((await loadPublishReviewTodos(live.fetchFn))).toHaveLength(1)
    const requests = live.observed.filter(item => item.url.endsWith("/request-review"))
    expect(requests).toHaveLength(2); expect(requests[0].key).toBe(requests[1].key)
    const taskFile = path.join(fixture.state, "reviews", review.review_id, "task.json"), taskBytes = fs.readFileSync(taskFile)
    fs.writeFileSync(taskFile, "null")
    await expect(loadPublishReviewTodos(live.fetchFn)).rejects.toThrow(MSG_PUBLISH_REVIEW_TODOS_FAILED)
    fs.writeFileSync(taskFile, taskBytes)
    expect((await loadPublishReviewTodos(live.fetchFn))).toHaveLength(1)
    preserved()
    const view = await getPublishPreview(document.slug, review.review_id, review.revision_id, live.fetchFn)
    live.dropNextApprovalResponse()
    await expect(mutation.execute(document.slug, "approve", approvalInput(review, view), live.fetchFn)).rejects.toMatchObject({ code: "NETWORK_ERROR", retryable: true })
    const recovered = await mutation.execute(document.slug, "approve", approvalInput(review, view), live.fetchFn) as PublishApprovalResult
    expect(recovered.state).toBe("approved_waiting_export")
    const approvals = live.observed.filter(item => item.url.endsWith("/approve"))
    expect(approvals).toHaveLength(2); expect(approvals[0].key).toBe(approvals[1].key)
    expect(fs.readdirSync(path.join(fixture.state, "approvals", document.slug))).toEqual([view.revision_id])
    expect((await loadPublishReviewTodos(live.fetchFn))[0].state).toBe("completed")
    preserved()
  }, 20_000)

  it("7-3 승인 성공 뒤 본문 유실은 자동 재전송 없이 실패하고 같은 키로 한 번만 복구한다", async () => {
    const { document, review, view } = await prepared(), mutation = new PublishMutation()
    live!.dropNextApprovalResponse("body-drop")
    await expect(mutation.execute(document.slug, "approve", approvalInput(review, view), live.fetchFn)).rejects.toMatchObject({ status: 201, code: "PUBLISH_RESPONSE_INVALID", retryable: true })
    expect(live!.observed.filter(item => item.url.endsWith("/approve"))).toHaveLength(1)
    const committed = await getPublishStatus(document.slug, live.fetchFn)
    expect(committed.state).toBe("approved_waiting_export")
    expect(committed.receipt).not.toBeNull()
    const recovered = await mutation.execute(document.slug, "approve", approvalInput(review, view), live.fetchFn) as PublishApprovalResult
    expect(recovered).toMatchObject({ state: "approved_waiting_export", receipt: committed.receipt })
    const approvals = live!.observed.filter(item => item.url.endsWith("/approve"))
    expect(approvals).toHaveLength(2); expect(approvals[0].key).toBe(approvals[1].key)
    expect(fs.readdirSync(path.join(fixture.state, "approvals", document.slug))).toEqual([view.revision_id])
    expect((await loadPublishReviewTodos(live!.fetchFn))[0].state).toBe("completed")
    preserved()
  })
})
