import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { canonicalBytes, hashBytes } from "../src/publish-bundle.js"
import { PublishMutation, getPublishPreview, type PublishReviewResult } from "../../dashboard/app/docs/publish-client"
import { createPublishFixture, startPublishDashboard } from "./publish-dashboard-fixture"
import { SITE_ALPHA, SITE_BETA } from "./publish-fixtures.js"

describe("게시 승인판 내보내기 인터페이스", () => {
  let fixture: ReturnType<typeof createPublishFixture>
  let live: Awaited<ReturnType<typeof startPublishDashboard>> | undefined

  beforeEach(() => {
    fixture = createPublishFixture()
    for (const [name, value] of Object.entries(fixture.env)) vi.stubEnv(name, value)
  })

  afterEach(async () => {
    await live?.close()
    live = undefined
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  const approve = async () => {
    live = await startPublishDashboard(fixture)
    const document = fixture.documents[0]!
    const requested = await new PublishMutation().execute(document.slug, "request-review", {
      saved_revision: hashBytes(fs.readFileSync(document.file)),
    }, live.fetchFn) as PublishReviewResult
    const preview = await getPublishPreview(document.slug, requested.review_id, requested.revision_id, live.fetchFn)
    const approved = await new PublishMutation().execute(document.slug, "approve", {
      review_id: requested.review_id,
      revision_id: requested.revision_id,
      saved_revision: preview.saved_revision,
      preview_hash: preview.preview_hash,
    }, live.fetchFn)
    expect(approved.state).toBe("approved_waiting_export")
    return { document, revisionId: requested.revision_id }
  }

  const call = (path: string, method: string, key?: string, body?: unknown, credential = "test-export-service-token") => live!.fetchFn(`/api/portal/publish/export-queue${path}`, {
    method,
    headers: {
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

  it("서비스 계정 인증을 요구하고 승인 영수증 원본 바이트와 대상별 상태 칸을 내보낸다", async () => {
    const { document, revisionId } = await approve()
    const missingCredential = await call("", "GET", undefined, undefined, "")
    expect(missingCredential.status).toBe(401)
    const wrongCredential = await call("", "GET", undefined, undefined, "wrong-test-token")
    expect(wrongCredential.status).toBe(401)
    const missingIdempotencyKey = await call(`/${document.slug}/${revisionId}/${SITE_ALPHA}/ko/claim`, "POST", "")
    expect(missingIdempotencyKey.status).toBe(400)

    const response = await call("", "GET")
    expect(response.status).toBe(200)
    const queue = await response.json()
    expect(queue).toMatchObject({ ok: true, revisions: [{ slug: document.slug, revision_id: revisionId }] })
    const revision = queue.revisions[0]
    expect(revision.cells).toHaveLength(4)
    expect(revision.cells).toEqual(expect.arrayContaining([
      { site: SITE_ALPHA, language: "ko", state: "queued", sequence: 0, updated_at: expect.any(String) },
      { site: SITE_ALPHA, language: "en", state: "queued", sequence: 0, updated_at: expect.any(String) },
      { site: SITE_BETA, language: "ko", state: "queued", sequence: 0, updated_at: expect.any(String) },
      { site: SITE_BETA, language: "en", state: "queued", sequence: 0, updated_at: expect.any(String) },
    ]))

    const site = SITE_ALPHA, language = "ko"
    const cellPath = `/${document.slug}/${revisionId}/${site}/${language}`
    const receiptBytes = fs.readFileSync(path.join(fixture.state, "approvals", document.slug, revisionId, "receipt.json"))
    const claim = await call(`${cellPath}/claim`, "POST", "claim-original-bytes")
    expect(claim.status).toBe(200)
    const claimed = await claim.json()
    expect(Buffer.from(claimed.receipt_bytes_base64, "base64")).toEqual(receiptBytes)
    expect(claimed.receipt_sha256).toBe(hashBytes(receiptBytes))
    expect(claimed.cell).toMatchObject({ site, language, state: "sending", sequence: 1 })
    expect(claimed.approved_bundle).toMatchObject({
      receipt_bytes_base64: claimed.receipt_bytes_base64,
      receipt_sha256: claimed.receipt_sha256,
      manifest: { slug: document.slug },
      media_map: { ko: { ready: true } },
    })
    expect(hashBytes(canonicalBytes(claimed.approved_bundle.manifest))).toBe(revisionId.slice(4))
    expect(hashBytes(canonicalBytes(claimed.approved_bundle.media_map))).toBe(claimed.approved_bundle.manifest.media_map_hash)
    expect(claimed.approved_bundle.previews).toHaveLength(2)
    for (const item of claimed.approved_bundle.previews) {
      expect(hashBytes(canonicalBytes(item.preview))).toBe(claimed.approved_bundle.manifest.preview_hashes[item.site][item.language])
    }
    expect(claimed.approved_bundle.assets.length).toBeGreaterThan(0)
    for (const asset of claimed.approved_bundle.assets) {
      const bytes = Buffer.from(asset.bytes_base64, "base64")
      expect(bytes.length).toBe(asset.size)
      expect(hashBytes(bytes)).toBe(asset.sha256)
    }

    const replay = await call(`${cellPath}/claim`, "POST", "claim-original-bytes")
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual(claimed)
    const conflictingReplay = await call(`/${document.slug}/${revisionId}/${SITE_BETA}/ko/claim`, "POST", "claim-original-bytes")
    expect(conflictingReplay.status).toBe(409)
    expect((await conflictingReplay.json()).code).toBe("IDEMPOTENCY_CONFLICT")
  })

  it("대시보드 결과 어댑터는 사이트별 실패와 승인 권한을 보여 주고 브라우저 계정은 서비스 재시도 API를 호출할 수 없다", async () => {
    const { document, revisionId } = await approve()
    const site = SITE_ALPHA, language = "ko"
    const cellPath = `/${document.slug}/${revisionId}/${site}/${language}`
    expect((await call(`${cellPath}/claim`, "POST", "ui-claim-cell")).status).toBe(200)
    const failed = await call(`${cellPath}/status`, "PUT", "ui-fail-cell", { state: "failed", failure_code: "DESTINATION_UNAVAILABLE" })
    expect(failed.status).toBe(200)

    const resultsResponse = await live!.fetchFn("/api/portal/publish/results")
    expect(resultsResponse.status).toBe(200)
    const results = await resultsResponse.json()
    expect(results.can_retry).toBe(true)
    expect(results.revisions[0].cells).toContainEqual(expect.objectContaining({ site, language, state: "failed", failure_code: "DESTINATION_UNAVAILABLE" }))

    live!.setAccount("ordinary")
    const nonApproverResults = await live!.fetchFn("/api/portal/publish/results")
    expect(nonApproverResults.status).toBe(200)
    expect((await nonApproverResults.json()).can_retry).toBe(false)
    const browserCredential = await call(`${cellPath}/retry`, "POST", "user-interface-retry", undefined, "")
    expect(browserCredential.status).toBe(401)
    expect((await browserCredential.json()).code).toBe("publish_export_service_required")
  })

  it("실제 대시보드 claim을 게이트웨이가 검증·저장하고 같은 요청은 한 번만 반영하며 바뀐 그림을 거절한다", async () => {
    const gatewayRoot = process.env.PUBLISH_GATEWAY_TEST_ROOT
    if (!gatewayRoot) {
      console.log("게이트웨이 체크아웃 없음: 외부 게이트웨이 상호 운용 시험을 건너뜁니다 (PUBLISH_GATEWAY_TEST_ROOT 미설정)")
      return
    }
    const document = fixture.documents[0]!
    const descriptorPath = path.join(fixture.state, "descriptors", `${document.slug}.json`)
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"))
    descriptor.frontmatter.languages = { [SITE_ALPHA]: ["ko"], [SITE_BETA]: ["ko"] }
    descriptor.media_map = { ko: descriptor.media_map.ko }
    fs.writeFileSync(descriptorPath, JSON.stringify(descriptor))
    for (const [name, value] of Object.entries(fixture.env)) vi.stubEnv(name, value)
    live = await startPublishDashboard(fixture)

    const requested = await new PublishMutation().execute(document.slug, "request-review", {
      saved_revision: hashBytes(fs.readFileSync(document.file)),
    }, live.fetchFn) as PublishReviewResult
    const preview = await getPublishPreview(document.slug, requested.review_id, requested.revision_id, live.fetchFn)
    const approved = await new PublishMutation().execute(document.slug, "approve", {
      review_id: requested.review_id,
      revision_id: requested.revision_id,
      saved_revision: preview.saved_revision,
      preview_hash: preview.preview_hash,
    }, live.fetchFn)
    expect(approved.state).toBe("approved_waiting_export")

    const site = SITE_ALPHA, language = "ko", idempotencyKey = "claim-cross-stack-once"
    const cellPath = `/${document.slug}/${requested.revision_id}/${site}/${language}`
    const claimResponse = await call(`${cellPath}/claim`, "POST", idempotencyKey)
    expect(claimResponse.status).toBe(200)
    const claim = await claimResponse.json()
    expect(claim.cell).toMatchObject({ site, language, state: "sending", sequence: 1 })
    expect(claim.approved_bundle.manifest).toMatchObject({
      slug: document.slug,
      targets: [SITE_ALPHA, SITE_BETA],
      languages: { [SITE_ALPHA]: ["ko"], [SITE_BETA]: ["ko"] },
    })

    const runner = path.join(gatewayRoot, "tests/gateway/run_dashboard_claim_integration.py")
    const gatewayRun = spawnSync(process.env.PUBLISH_GATEWAY_PYTHON ?? "python3", [runner], {
      cwd: gatewayRoot,
      env: { ...process.env, PYTHONPATH: path.join(gatewayRoot, "src") },
      input: JSON.stringify({ claim, public_key_pem: fixture.publicKey, idempotency_key: idempotencyKey, site, slug: document.slug, revision_id: requested.revision_id }),
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024,
    })
    if (gatewayRun.error) throw gatewayRun.error
    expect(gatewayRun.status, gatewayRun.stderr).toBe(0)
    const gateway = JSON.parse(gatewayRun.stdout)
    expect(gateway).toMatchObject({
      first_status: 200,
      replay_status: 200,
      replay_same_result: true,
      changed_image_status: 422,
      changed_image_code: "RECEIPT_INVALID",
      counts: { revisions: 2, assets: claim.approved_bundle.assets.length * 2, ledger: 1 },
      read_status: 200,
      read_state: "saved",
      published_at: null,
    })

    const stateUpdate = await call(`${cellPath}/status`, "PUT", "gateway-saved-ack", { state: "saved" })
    expect(stateUpdate.status).toBe(200)
    expect((await stateUpdate.json()).cell).toMatchObject({ site, language, state: "saved", sequence: 2 })
    const queue = await (await call("", "GET")).json()
    expect(queue.revisions[0].cells).toContainEqual(expect.objectContaining({ site, language, state: "saved", sequence: 2 }))
  }, 30_000)

  it("완료 상태를 기록하고 실패한 칸만 멱등 재시도한다", async () => {
    const { document, revisionId } = await approve()
    const successfulCell = `/${document.slug}/${revisionId}/${SITE_ALPHA}/ko`
    const firstClaim = await call(`${successfulCell}/claim`, "POST", "success-claim")
    expect(firstClaim.status).toBe(200)
    const saved = await call(`${successfulCell}/status`, "PUT", "success-saved", { state: "saved" })
    expect((await saved.json()).cell).toMatchObject({ state: "saved", sequence: 2 })
    const published = await call(`${successfulCell}/status`, "PUT", "success-published", { state: "published" })
    expect((await published.json()).cell).toMatchObject({ state: "published", sequence: 3 })
    const cannotRetryPublished = await call(`${successfulCell}/retry`, "POST", "retry-published")
    expect(cannotRetryPublished.status).toBe(409)
    expect((await cannotRetryPublished.json()).code).toBe("EXPORT_CELL_NOT_FAILED")

    const failedCell = `/${document.slug}/${revisionId}/${SITE_BETA}/ko`
    expect((await call(`${failedCell}/claim`, "POST", "failed-claim")).status).toBe(200)
    const failed = await call(`${failedCell}/status`, "PUT", "failed-status", { state: "failed", failure_code: "DESTINATION_UNAVAILABLE" })
    expect((await failed.json()).cell).toMatchObject({ state: "failed", sequence: 2, failure_code: "DESTINATION_UNAVAILABLE" })

    const queuedRetry = await call(`/${document.slug}/${revisionId}/${SITE_BETA}/en/retry`, "POST", "retry-queued")
    expect(queuedRetry.status).toBe(409)
    const retry = await call(`${failedCell}/retry`, "POST", "retry-failed-cell")
    expect(retry.status).toBe(200)
    const retried = await retry.json()
    expect(retried.cell).toMatchObject({ state: "sending", sequence: 3 })
    const bytes = fs.readFileSync(path.join(fixture.state, "approvals", document.slug, revisionId, "receipt.json"))
    expect(Buffer.from(retried.receipt_bytes_base64, "base64")).toEqual(bytes)
    const retryReplay = await call(`${failedCell}/retry`, "POST", "retry-failed-cell")
    expect(await retryReplay.json()).toEqual(retried)

    const conflict = await call(`${failedCell}/status`, "PUT", "failed-status", { state: "failed", failure_code: "DIFFERENT_FAILURE" })
    expect(conflict.status).toBe(409)
    expect((await conflict.json()).code).toBe("IDEMPOTENCY_CONFLICT")

    const finalQueue = await (await call("", "GET")).json()
    const cells = finalQueue.revisions[0].cells
    expect(cells.find((cell: any) => cell.site === SITE_ALPHA && cell.language === "ko").state).toBe("published")
    expect(cells.find((cell: any) => cell.site === SITE_BETA && cell.language === "ko")).toMatchObject({ state: "sending", sequence: 3 })
  })
})
