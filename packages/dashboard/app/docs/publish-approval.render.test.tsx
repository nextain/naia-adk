import assert from "node:assert/strict"
import test from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { DocsView } from "./DocsView"
import { PublishReceiptView, PublishRequestAction, PublishReview, PublishStatusNotice, publishAssetUrl } from "./PublishReview"
import { PublishClientError, PublishMutation, getPublishPreview, getPublishStatus, publishErrorMessage, publishPollInterval, watchPublishStatus,
  type PublishPreviewResponse, type PublishReviewResult, type PublishStatus } from "./publish-client"
import { publishReviewHref, useDocumentPublish, type DocumentPublishOptions } from "./use-publish-document"

const hash = "a".repeat(64), rev = `rev_${hash}`, review = `review_${hash}`, operation = `op_${hash}`
const receipt = { receipt_id: "receipt-test", revision_id: rev, approved_at: "2030-11-01T01:00:00Z", approved_hash: hash }
const result: PublishReviewResult = { ok: true, state: "pending_review", review_id: review, revision_id: rev, saved_revision: hash, operation_id: operation, review_url: `/docs?source=adk&path=article.md&publishReview=${review}`, task_id: "task-test" }
const status: PublishStatus = { ok: true, state: "pending_review", saved_revision: hash, revision_id: rev, preview_hash: hash, pending_revision_id: rev, review_id: review, approved_revision_id: null,
  receipt: null, changed_after_approval: false, can_request_review: true, can_approve: true, draft_error: null, elapsed_ms: 10, max_poll_interval_ms: 4740, change_display_budget_ms: 5000 }
const display = { site: "site-a", language: "ko", title: "서버 제목", summary: "서버 요약", body: "본문 첫째\n\n![첫 그림](assets/one.png)\n\n둘째\n\n![둘째 그림](assets/two.png)", hero: "assets/one.png", frontmatter: { title: "서버 제목" }, media_map: {}, targets: ["site-a", "site-b"], languages: { "site-a": ["ko", "en"], "site-b": ["ko"] }, date: "2030-11-04T20:00+09:00" }
const preview: PublishPreviewResponse = { ok: true, slug: "test-post", review_id: review, revision_id: rev, saved_revision: hash, preview_hash: hash,
  previews: { "site-a": { ko: display }, "site-b": { ko: { ...display, site: "site-b", title: "두 번째 사이트 표시 제목" } } }, frontmatter: { title: "서버 앞머리" }, media_map: { ko: { ready: true, hero: "assets/one.png" }, en: { ready: false } },
  assets: ["one", "two"].map((name, index) => ({ path: `assets/${name}.png`, sha256: String(index + 1).repeat(64), url: `/api/portal/publish/test-post/revisions/${rev}/assets/${String(index + 1).repeat(64)}` })), issues: [], can_approve: true }
const noop = () => {}
const reviewProps = { preview, view: "site-a:ko", onChangeView: noop, onReload: noop, onClose: noop, onApprove: noop }
const flush = async () => { for (let count = 0; count < 20; count++) await Promise.resolve() }

test("설계 7-3-01 · SP-03 제목 옆 요청과 가운데 확인 화면은 기존 세 칸 안에 있다", () => {
  const html = renderToStaticMarkup(<DocsView activeTab="common" sources={[{ id: "adk", title: "문서", tree: [] }]} tabSections={[]} currentSource="adk" currentPath="article.md" viewMode="doc"
    docContent="# 원래 본문" docBaseHash={hash} onStartEdit={noop} publishActions={<PublishRequestAction onRequest={noop} />} publishNotice={<p>게시 상태</p>} publishReview={<PublishReview {...reviewProps} />} />)
  assert.match(html, /data-testid="doc-title-row"/)
  assert.ok(html.indexOf(">편집<") < html.indexOf('data-testid="publish-request-review"'))
  assert.ok(html.indexOf('data-testid="doc-body-shell"') < html.indexOf('data-testid="publish-review"'))
  assert.doesNotMatch(html, /<h1[^>]*>원래 본문/)
  assert.match(html, /flex-wrap/)
  assert.match(html, /min-w-0/)
})

test("설계 7-3-02 · 미저장 변경과 그림 업로드 대기는 요청을 비활성화한다", () => {
  for (const blocked of ["저장하지 않은 변경이 있습니다", "그림을 올리는 중입니다"]) {
    const html = renderToStaticMarkup(<PublishRequestAction blocked={blocked} onRequest={() => assert.fail("차단 중 호출") } />)
    assert.match(html, /disabled=""/); assert.ok(html.includes(blocked))
  }
})

test("설계 7-3-01 · 확인 화면의 편집은 같은 자리에 편집기를 열고 취소 뒤 확인 화면을 보인다", () => {
  const props = { activeTab: "common" as const, sources: [{ id: "adk", title: "문서", tree: [] }], tabSections: [], currentSource: "adk", currentPath: "article.md", viewMode: "doc" as const,
    docContent: "# 원래 본문", docBaseHash: hash,  onStartEdit: noop, onCancelEdit: noop, publishReview: <PublishReview {...reviewProps} /> }
  const editing = renderToStaticMarkup(<DocsView {...props} isEditing />)
  assert.match(editing, /<textarea/); assert.ok(editing.includes("취소"))
  assert.doesNotMatch(editing, /data-testid="publish-review"/)
  assert.match(renderToStaticMarkup(<DocsView {...props} isEditing={false} />), /data-testid="publish-review"/)
})

test("설계 7-3-04 · 서버 요청 주소에 정확한 요청판을 보존한다", () => {
  const url = new URL(publishReviewHref(result), "https://dashboard.test")
  assert.equal(url.pathname, "/docs")
  assert.equal(url.searchParams.get("publishReview"), review)
  assert.equal(url.searchParams.get("publishRevision"), rev)
  assert.equal(url.searchParams.get("path"), "article.md")
})

test("설계 7-3-05 · 사이트별 표시와 원고 보기는 서버 자료와 고정 그림 순서를 사용한다", () => {
  const html = renderToStaticMarkup(<PublishReview {...reviewProps} />)
  for (const value of ["서버 제목", "서버 요약", "site-a · ko", "site-b · ko", "2030-11-04T20:00+09:00", "준비됨", "준비 안 됨", "대표 그림 있음", "영상 없음", "원고 보기"]) assert.ok(html.includes(value), value)
  const body = html.slice(html.indexOf('data-testid="publish-preview-body"'))
  assert.ok(body.indexOf('alt="첫 그림"') < body.indexOf('alt="둘째 그림"'))
  assert.ok(body.includes(preview.assets[0].url))
  assert.doesNotMatch(html, /\/api\/portal\/asset\?/)
  const other = renderToStaticMarkup(<PublishReview {...reviewProps} view="site-b:ko" />)
  assert.ok(other.includes("두 번째 사이트 표시 제목"))
  const source = renderToStaticMarkup(<PublishReview {...reviewProps} view="source" />)
  assert.match(source, /data-testid="publish-source-preview"/)
  assert.equal(publishAssetUrl(preview, "https://untrusted.test/a.png"), undefined)
  assert.equal(publishAssetUrl({ ...preview, assets: [{ ...preview.assets[0], url: "https://untrusted.test/a.png" }] }, "assets/one.png"), undefined)
  const raw = renderToStaticMarkup(<PublishReview {...reviewProps} preview={{ ...preview, previews: { "site-a": { ko: { ...display, body: '앞\n\n<img src="assets/two.png" alt="원시 그림" onerror="alert(1)">\n\n<!-- <img src="assets/one.png"> -->\n\n뒤' } } } }} />)
  assert.ok(raw.includes('alt="원시 그림"'))
  assert.ok(raw.includes(preview.assets[1].url))
  assert.doesNotMatch(raw, /onerror|alert\(1\)/)
})

test("설계 7-3-05 · 한글 파일명의 본문·참조식 그림도 서버가 고정한 그림으로 표시한다", () => {
  const unicode = { ...preview, assets: [{ ...preview.assets[0], path: "assets/한글-그림.png" }],
    previews: { "site-a": { ko: { ...display, hero: "assets/한글-그림.png", body: '![본문 그림](assets/한글-그림.png)\n\n![참조 그림][그림]\n\n[그림]: assets/한글-그림.png\n\n<img src="assets/한글-그림.png" alt="원시 그림">' } } } }
  const html = renderToStaticMarkup(<PublishReview {...reviewProps} preview={unicode} />)
  for (const alt of ["본문 그림", "참조 그림", "원시 그림"]) assert.ok(html.includes(`src="${preview.assets[0].url}" alt="${alt}"`), alt)
  assert.ok(!html.includes("고정된 그림을 확인하지 못했습니다"))
  assert.equal(publishAssetUrl(unicode, "assets/한글-그림.png"), preview.assets[0].url)
  assert.equal(publishAssetUrl(unicode, "assets/%ED%95%9C%EA%B8%80-%EA%B7%B8%EB%A6%BC.png"), preview.assets[0].url)
  for (const path of ["https://outside.test/assets/한글-그림.png", "assets/%invalid.png", "assets/%25ED%2595%259C%25EA%25B8%2580-%25EA%25B7%25B8%25EB%25A6%25BC.png"]) assert.equal(publishAssetUrl(unicode, path), undefined)
  assert.equal(publishAssetUrl({ ...unicode, assets: [{ ...unicode.assets[0], url: "https://outside.test/image.png" }] }, "assets/한글-그림.png"), undefined)
})

test("설계 7-3-06 · 서버 can_approve=false 계정은 승인 단추가 없다", () => {
  const html = renderToStaticMarkup(<PublishReview {...reviewProps} preview={{ ...preview, can_approve: false }} />)
  assert.doesNotMatch(html, /data-testid="publish-approve"/)
  assert.ok(html.includes("승인 담당 계정"))
  const retry = renderToStaticMarkup(<PublishReview {...reviewProps} preview={{ ...preview, can_approve: false }} approvalError={new PublishClientError(0, "NETWORK_ERROR", "응답 유실", true)} canRetryApproval={false} />)
  assert.doesNotMatch(retry, /data-testid="publish-approve-retry"/)
})

test("설계 7-3-07 · 409·422·403 미리보기 실패에는 일치·승인 표시가 없다", () => {
  for (const error of [new PublishClientError(409, "PREVIEW_CHANGED", "변경"), new PublishClientError(422, "ASSET_INVALID", "그림 오류", false, [{ field: "body.image", image_index: 2, path: "assets/missing.png" }]), new PublishClientError(403, "DOCUMENT_FORBIDDEN", "거절")]) {
    const html = renderToStaticMarkup(<PublishReview {...reviewProps} preview={null} error={error} />)
    assert.doesNotMatch(html, /data-testid="publish-approve"|data-testid="publish-preview-match"/)
    assert.match(html, /role="alert"/)
    if (error.status === 422) {
      assert.ok(html.includes("그림 2"))
      assert.ok(!html.includes("assets/missing.png"), "파일 경로는 사용자 안내에 포함하지 않는다")
    }
  }
})

test("설계 7-3-08 · 승인판·시각·영수증과 내보내기 대기를 표시한다", () => {
  const html = renderToStaticMarkup(<PublishReview {...reviewProps} receipt={receipt} />)
  for (const value of ["승인 완료·내보내기 대기", "저장된 판", receipt.approved_at]) assert.ok(html.includes(value))
  assert.ok(html.includes(`data-revision-id="${rev}"`), "내부 판 번호는 기능을 위해 data 속성에 남는다")
  const visibleText = html.replace(/<[^>]*>/g, " ")
  assert.doesNotMatch(visibleText, /rev_[a-f0-9]{64}|review_[a-f0-9]{64}|op_[a-f0-9]{64}|receipt-test/)
  assert.doesNotMatch(visibleText, /\{|\}|\"|sha256|assets\/|\.yaml|pnpm|JSON/i)
  assert.doesNotMatch(html, /data-testid="publish-approve"/)
})

test("게시 확인 화면에는 내부 번호·원시 자료·파일 경로·설정 명령이 보이지 않는다", () => {
  const html = renderToStaticMarkup(<PublishReview {...reviewProps} receipt={receipt} />)
  const visibleText = html.replace(/<[^>]*>/g, " ")
  assert.ok(html.includes(`data-revision-id="${rev}"`), "내부 판 번호는 기능용 data 속성에 유지한다")
  assert.doesNotMatch(visibleText, /rev_[a-f0-9]{64}|review_[a-f0-9]{64}|op_[a-f0-9]{64}|receipt-test/)
  assert.doesNotMatch(visibleText, /\{|\}|sha256|assets\/|\.yaml|pnpm|JSON/i)
  assert.ok(visibleText.includes("요청한 판"))
  assert.ok(visibleText.includes("저장된 판"))
})

test("설계 7-3-09 · 변경과 조회 실패는 이전 승인 영수증을 보존하며 일치 표시를 지운다", () => {
  for (const props of [{ status: { ...status, state: "changed_after_approval" as const, changed_after_approval: true, receipt } }, { status: null, error: new Error("중단"), previousReceipt: receipt }]) {
    const html = renderToStaticMarkup(<PublishStatusNotice {...props} />)
    assert.doesNotMatch(html, /data-testid="publish-approved-matches"/)
    assert.ok(html.includes("저장된 판"))
    assert.ok(html.includes(props.status ? "새 게시 확인이 필요합니다" : "현재 판 일치 여부를 확인하지 못했습니다"))
  }
})

test("설계 7-3-03·10 · 요청·미리보기·승인에는 문서 저장 요청이 없다", async () => {
  const calls: { url: string; method: string }[] = []
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" })
    return Response.json(String(url).endsWith("approve") ? { ok: true, state: "approved_waiting_export", revision_id: rev, operation_id: operation, receipt }
      : String(url).endsWith("request-review") ? result : String(url).endsWith("status") ? status : preview)
  }) as typeof fetch
  const mutation = new PublishMutation(() => "key-test")
  await getPublishStatus("test-post", fetchFn)
  assert.deepEqual(await mutation.execute("test-post", "request-review", { saved_revision: hash }, fetchFn), result)
  await getPublishPreview("test-post", review, rev, fetchFn)
  await mutation.execute("test-post", "approve", { review_id: review, revision_id: rev, saved_revision: hash, preview_hash: hash }, fetchFn)
  assert.equal(calls.length, 4)
  assert.ok(calls.every((call) => call.url.startsWith("/api/portal/publish/")))
  assert.ok(calls.every((call) => call.method !== "PUT"))
})

for (const failure of ["503", "응답 유실"] as const) test(`설계 7-3-10 · ${failure} 재시도는 멱등키와 원래 본문을 유지한다`, async () => {
  let attempt = 0, keys = 0
  const sent: RequestInit[] = []
  const fetchFn = (async (_url: string, init: RequestInit) => {
    sent.push(init)
    if (attempt++ === 0) {
      if (failure === "응답 유실") throw new Error("서버 확정 후 연결 유실")
      return Response.json({ ok: false, code: "REVIEW_TASK_WRITE_FAILED", message: "실패", retryable: true }, { status: 503 })
    }
    return Response.json(result)
  }) as typeof fetch
  const mutation = new PublishMutation(() => `key-${++keys}`)
  await assert.rejects(mutation.execute("test-post", "request-review", { saved_revision: hash }, fetchFn), PublishClientError)
  assert.deepEqual(await mutation.execute("test-post", "request-review", { saved_revision: hash }, fetchFn), result)
  assert.equal(keys, 1); assert.deepEqual(sent[0].headers, sent[1].headers); assert.equal(sent[0].body, sent[1].body)
  await mutation.execute("test-post", "request-review", { saved_revision: "b".repeat(64) }, fetchFn)
  assert.equal(keys, 2, "새 저장판에는 새 작업 키를 쓴다")
})

test("설계 7-3-10 · 201의 비거나 잘린 응답 본문도 같은 키와 본문으로 재시도한다", async () => {
  for (const lostBody of ["", '{"ok":true']) {
    const sent: RequestInit[] = []
    let created = 0
    const fetchFn = (async (_url: string, init: RequestInit) => {
      sent.push(init)
      return sent.length === 1 ? new Response(lostBody, { status: 201 }) : Response.json(result)
    }) as typeof fetch
    const mutation = new PublishMutation(() => `key-${++created}`)
    await assert.rejects(mutation.execute("test-post", "request-review", { saved_revision: hash }, fetchFn), (error: unknown) =>
      error instanceof PublishClientError && error.code === "PUBLISH_RESPONSE_INVALID" && error.retryable)
    assert.deepEqual(await mutation.execute("test-post", "request-review", { saved_revision: hash }, fetchFn), result)
    assert.equal(created, 1); assert.deepEqual(sent[0].headers, sent[1].headers); assert.equal(sent[0].body, sent[1].body)
  }
})

test("설계 7-3-10 · 202 처리 조회 뒤에도 같은 요청을 재전송하고 확정 결과를 읽는다", async () => {
  const urls: string[] = [], keys: string[] = []
  let poll = 0
  const fetchFn = (async (url: string, init?: RequestInit) => {
    urls.push(url)
    if (init?.method === "POST") { keys.push((init.headers as Record<string, string>)["Idempotency-Key"]); return Response.json({ ok: true, state: "processing", operation_id: operation }, { status: 202 }) }
    return Response.json(poll++ === 0 ? { ok: true, state: "processing", operation_id: operation } : { ok: true, state: "committed", operation_id: operation, result })
  }) as typeof fetch
  const mutation = new PublishMutation(() => "same-key")
  assert.equal((await mutation.execute("test-post", "request-review", { saved_revision: hash }, fetchFn)).state, "processing")
  assert.deepEqual(await mutation.execute("test-post", "request-review", { saved_revision: hash }, fetchFn), result)
  assert.deepEqual(keys, ["same-key", "same-key"])
  assert.equal(urls.filter((url) => url.includes("/operations/")).length, 2)
})

for (const acknowledgement of [200, 201, 202]) test(`설계 7-3-09·10 · ${acknowledgement} 성공 확인 뒤 같은 저장판의 새 의도에는 새 키를 쓴다`, async () => {
  const keys: string[] = []
  let created = 0
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      keys.push((init.headers as Record<string, string>)["Idempotency-Key"])
      return acknowledgement === 202 ? Response.json({ ok: true, state: "processing", operation_id: operation }, { status: 202 }) : Response.json(result, { status: acknowledgement })
    }
    return Response.json({ ok: true, state: "committed", operation_id: operation, result })
  }) as typeof fetch
  const mutation = new PublishMutation(() => `key-${++created}`)
  for (let attempt = 0; attempt < 2; attempt++) assert.deepEqual(await mutation.execute("test-post", "request-review", { saved_revision: hash }, fetchFn), result)
  assert.deepEqual(keys, ["key-1", "key-2"])
})

test("설계 7-3-13 · 확인표시가 꺼진 403은 친절한 안내와 승인 불가를 표시한다", () => {
  const error = new PublishClientError(403, "publish_gateway_unconfirmed", "계정 덮어쓰기 확인 필요")
  assert.match(publishErrorMessage(error), /^승인 기능이 아직 켜지지 않았습니다/)
  const html = renderToStaticMarkup(<PublishReview {...reviewProps} preview={null} error={error} />)
  assert.doesNotMatch(html, /data-testid="publish-approve"/)
  assert.ok(html.includes("계정 연결"))
})

function clock() {
  let now = 0, id = 0
  const jobs = new Map<number, { at: number; run: () => void }>()
  return {
    timing: { setTimeout: ((run: () => void, delay: number) => { const token = ++id; jobs.set(token, { at: now + delay, run }); return token }) as unknown as typeof setTimeout,
      clearTimeout: ((token: number) => jobs.delete(token)) as unknown as typeof clearTimeout },
    async advance(ms: number) {
      const target = now + ms
      while (true) { const next = [...jobs.entries()].sort((a, b) => a[1].at - b[1].at).find(([, job]) => job.at <= target); if (!next) break; now = next[1].at; jobs.delete(next[0]); next[1].run(); await flush() }
      now = target; await flush()
    },
  }
}

test("설계 7-3-09 · 기본 타이머는 브라우저 전역 수신자로 조회·갱신·종료를 실행한다", async (context) => {
  const time = clock(), states: (PublishStatus | null)[] = []
  context.mock.method(globalThis, "setTimeout", function (this: unknown, ...args: Parameters<typeof setTimeout>) {
    assert.equal(this, globalThis, "브라우저 setTimeout은 전역 객체를 수신자로 받아야 한다")
    return time.timing.setTimeout(...args)
  })
  context.mock.method(globalThis, "clearTimeout", function (this: unknown, ...args: Parameters<typeof clearTimeout>) {
    assert.equal(this, globalThis, "브라우저 clearTimeout은 전역 객체를 수신자로 받아야 한다")
    return time.timing.clearTimeout(...args)
  })
  let calls = 0
  const fetchFn = (async () => Response.json(calls++ === 0 ? status : { ...status, state: "changed_after_approval", changed_after_approval: true })) as typeof fetch
  const watcher = watchPublishStatus("test-post", (next) => states.push(next), fetchFn)
  context.after(() => watcher.stop())
  await flush(); assert.equal(calls, 1); assert.deepEqual(states.at(-1), status)
  await time.advance(2000); assert.equal(calls, 2); assert.equal(states.at(-1)?.state, "changed_after_approval")
  watcher.stop(); const count = states.length
  await time.advance(10000); assert.equal(calls, 2); assert.equal(states.length, count)
})

test("설계 7-3-09 · 2초 갱신과 서버 상한을 지키고 외부 변경을 5초 이내 표시한다", async () => {
  const time = clock(), states: (PublishStatus | null)[] = []
  let calls = 0
  const fetchFn = (async () => Response.json(calls++ === 0 ? { ...status, state: "approved_waiting_export", receipt } : { ...status, state: "changed_after_approval", changed_after_approval: true, receipt })) as typeof fetch
  const watcher = watchPublishStatus("test-post", (next) => states.push(next), fetchFn, time.timing)
  await flush(); assert.equal(states[0]?.state, "approved_waiting_export")
  await time.advance(1999); assert.equal(calls, 1)
  await time.advance(1); assert.equal(states.at(-1)?.state, "changed_after_approval")
  assert.equal(publishPollInterval({ ...status, max_poll_interval_ms: 100 }), 100)
  watcher.stop()
})

test("설계 7-3-09·10 · 조회 중단·503은 일치를 제거하고 늦은 응답을 무시한다", async () => {
  const time = clock(), states: (PublishStatus | null)[] = []
  let calls = 0, late!: (value: Response) => void
  const fetchFn = (() => {
    calls++
    if (calls === 1) return Promise.resolve(Response.json(status))
    if (calls === 2) return new Promise<Response>((resolve) => { late = resolve })
    return Promise.resolve(Response.json({ ok: false, code: "PUBLISH_UNAVAILABLE", message: "장애" }, { status: 503 }))
  }) as typeof fetch
  const watcher = watchPublishStatus("test-post", (next) => states.push(next), fetchFn, time.timing)
  await flush(); await time.advance(4750)
  assert.equal(states.at(-1), null, "이전 성공으로부터 5초가 되기 전에 불확실 표시")
  await time.advance(2000); assert.equal(calls, 3, "abort를 무시하는 요청도 다음 재시도를 막지 않는다")
  late(Response.json(status)); await flush(); assert.equal(states.at(-1), null)
  watcher.stop(); const count = states.length
  await time.advance(10000); assert.equal(states.length, count)
})

test("설계 7-3-09 · 연속 복귀 재조회도 마지막 성공 뒤 5초의 불확실 표시를 미루지 않는다", async () => {
  const time = clock(), states: (PublishStatus | null)[] = []
  let calls = 0, finish!: (response: Response) => void
  const fetchFn = (() => ++calls === 1 ? Promise.resolve(Response.json(status)) : new Promise<Response>((resolve) => { finish = resolve })) as typeof fetch
  const watcher = watchPublishStatus("test-post", (next) => states.push(next), fetchFn, time.timing)
  await flush(); assert.deepEqual(states.at(-1), status)
  await time.advance(3000); void watcher.refresh(); await flush()
  await time.advance(1000); void watcher.refresh(); await flush()
  await time.advance(749); assert.equal(states.at(-1)?.revision_id, rev)
  await time.advance(1); assert.equal(states.at(-1), null, "복귀가 기존 요청의 제한 시간을 초기화해도 마지막 성공은 만료된다")
  finish(Response.json({ ...status, can_approve: false })); await flush()
  assert.equal(states.at(-1)?.can_approve, false, "새 성공 응답은 다시 상태를 확정한다")
  watcher.stop(); const count = states.length
  await time.advance(10000); assert.equal(states.length, count, "종료 뒤에는 유효 시간 타이머도 남지 않는다")
})

// 기존 render 시험처럼 React의 디스패처만 대체한다. 효과·비동기 요청·사용자 콜백은 실제 훅을 실행한다.
function renderHarness<Props, Output>(initial: Props, component: (props: Props) => Output) {
  let options = initial, cursor = 0, output!: Output, dirty = true
  const slots: any[] = [], effects: (() => void)[] = []
  const equal = (a?: unknown[], b?: unknown[]) => !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const render = () => {
    const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE, previous = internals.H
    cursor = 0; dirty = false
    internals.H = {
      useState(initial: unknown) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial; return [slots[index], (next: any) => { const value = typeof next === "function" ? next(slots[index]) : next; if (!Object.is(value, slots[index])) { slots[index] = value; dirty = true } }] },
      useRef(initial: unknown) { const index = cursor++; return slots[index] ??= { current: initial } },
      useEffect(effect: () => any, deps: unknown[]) { const index = cursor++, previous = slots[index]; if (!equal(previous?.deps, deps)) { slots[index] = { deps, cleanup: previous?.cleanup }; effects.push(() => { slots[index].cleanup?.(); slots[index].cleanup = effect() }) } },
    }
    try { output = component(options) } finally { internals.H = previous }
    while (effects.length) effects.shift()!()
  }
  return { async settle() { for (let count = 0; count < 20; count++) { if (dirty) render(); await flush() } return output }, update(next: Partial<Props>) { options = { ...options, ...next }; dirty = true }, stop() { for (const slot of slots) slot?.cleanup?.() } }
}
const hookHarness = (initial: DocumentPublishOptions) => renderHarness(initial, useDocumentPublish)

test("게시 기능이 명시적으로 미설정일 때만 숨기고 설정 오류는 표시한다", async (context) => {
  browserGlobals(context)
  for (const configured of [false, true, undefined]) {
    let calls = 0
    const fetchFn = (async () => { calls++; return Response.json({ ok: false, code: "publish_gateway_unconfirmed", message: "관문 오류" }, { status: 403 }) }) as typeof fetch
    const hook = hookHarness({ ...hookOptions(fetchFn), configured }); context.after(() => hook.stop())
    const ui = await hook.settle()
    if (configured === false) {
      assert.equal(calls, 0); assert.equal(ui.notice, null); assert.equal(ui.actions, null); assert.equal(ui.review, null)
    } else {
      assert.equal(calls, 1); assert.match(renderToStaticMarkup(ui.notice), /승인 기능이 아직 켜지지 않았습니다/)
    }
  }
})

test("신원·권한 실패는 이전 영수증을 지우고 503은 마지막 영수증을 보존한다", async (context) => {
  browserGlobals(context)
  for (const authStatus of [401, 403]) {
    let mode = 200
    const fetchFn = (async (url: string) => {
      if (url.includes("/document?")) return Response.json({ ok: true, slug: "test-post", can_request_review: true })
      if (url.endsWith("/status")) return mode === 200
        ? Response.json({ ...status, state: "approved_waiting_export", approved_revision_id: rev, receipt })
        : Response.json({ ok: false, code: "PUBLISH_UNAVAILABLE", message: "실패" }, { status: mode })
      throw new Error("unexpected request")
    }) as typeof fetch
    const hook = hookHarness({ ...hookOptions(fetchFn), reviewId: null, revisionId: null })
    let ui = await hook.settle()
    assert.match(renderToStaticMarkup(ui.notice), /data-testid="publish-receipt"/)
    mode = 503; window.dispatchEvent(new Event("focus")); ui = await hook.settle()
    assert.match(renderToStaticMarkup(ui.notice), /data-testid="publish-receipt"/, "일시 장애는 영수증 보존")
    mode = authStatus; window.dispatchEvent(new Event("focus")); ui = await hook.settle()
    assert.doesNotMatch(renderToStaticMarkup(ui.notice), /data-testid="publish-receipt"|승인판·영수증 보기/)
    mode = 503; window.dispatchEvent(new Event("focus")); ui = await hook.settle()
    assert.doesNotMatch(renderToStaticMarkup(ui.notice), /data-testid="publish-receipt"/, "권한 실패 뒤 장애로 이전 영수증이 되살아나지 않는다")
    hook.stop()
  }
  for (const code of [401, 403]) {
    const html = renderToStaticMarkup(<PublishStatusNotice status={{ ...status, receipt }} previousReceipt={receipt} error={new PublishClientError(code, "denied", "권한 없음")} />)
    assert.doesNotMatch(html, /data-testid="publish-receipt"/)
  }
})

test("설계 5-3 · 이전 승인 영수증에서 현재 초안과 별도로 승인판 실제 내용을 읽는다", async (context) => {
  const calls: string[] = []
  const fetchFn = (async (url: string) => {
    calls.push(String(url))
    return Response.json({ ...preview, can_approve: false, receipt })
  }) as typeof fetch
  const harness = renderHarness({ receipt, slug: "test-post", fetchFn }, PublishReceiptView)
  context.after(() => harness.stop())
  let ui = await harness.settle()
  const button = React.Children.toArray(ui.props.children).find((child) => React.isValidElement<any>(child) && child.props["data-testid"] === "publish-open-approved-revision") as React.ReactElement<any>
  button.props.onClick(); ui = await harness.settle()
  assert.deepEqual(calls, [`/api/portal/publish/test-post/revisions/${rev}`])
  const html = renderToStaticMarkup(ui)
  assert.match(html, /data-testid="publish-approved-revision"/)
  for (const text of ["서버 제목", "서버 요약", "본문 첫째", "site-a · ko", "site-b · ko"]) assert.ok(html.includes(text), text)
  assert.ok(html.includes(preview.assets[0].url))
  assert.doesNotMatch(html, /data-testid="publish-approve"|data-testid="publish-preview-match"/)
  const panel = React.Children.toArray(ui.props.children).find((child) => React.isValidElement<any>(child) && child.props["data-testid"] === "publish-approved-revision") as React.ReactElement<any>
  const details = React.Children.toArray(panel.props.children).find((child) => React.isValidElement<{ preview?: PublishPreviewResponse }>(child) && child.props.preview) as React.ReactElement<any>
  details.props.onChangeView("source"); ui = await harness.settle()
  assert.ok(!renderToStaticMarkup(ui).includes("서버 앞머리"), "내부 앞머리 데이터는 게시 원고 화면에 JSON으로 노출하지 않는다")
})

test("설계 5-4 · 응답 유실 뒤 일반 계정은 재시도를 숨기고 담당자 복귀 뒤 원래 키와 본문으로 복구한다", async (context) => {
  browserGlobals(context)
  let owner = true, committed = false
  const sent: RequestInit[] = []
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (url.includes("/document?")) return Response.json({ ok: true, slug: preview.slug, can_request_review: true })
    if (url.endsWith("/review-todos")) return owner
      ? Response.json({ ok: true, tasks: [{ slug: preview.slug, review_id: review, revision_id: rev, state: committed ? "completed" : "pending_review" }] })
      : Response.json({ ok: false, code: "APPROVER_REQUIRED", message: "권한 없음" }, { status: 403 })
    if (init?.method === "POST") {
      sent.push(init); committed = true
      if (sent.length === 1) throw new Error("승인 확정 뒤 응답 유실")
      return Response.json({ ok: true, state: "approved_waiting_export", revision_id: rev, operation_id: operation, receipt })
    }
    if (url.endsWith("/status")) return Response.json(committed ? { ...status, state: "approved_waiting_export", pending_revision_id: null, review_id: null, approved_revision_id: rev, can_approve: false, receipt } : { ...status, can_approve: owner })
    return Response.json({ ...preview, can_approve: owner })
  }) as typeof fetch
  const hook = hookHarness(hookOptions(fetchFn)); context.after(() => hook.stop())
  let ui = await hook.settle(); (ui.review as React.ReactElement<any>).props.onApprove(); ui = await hook.settle()
  assert.match(renderToStaticMarkup(ui.review), /data-testid="publish-approve-retry"/)
  owner = false; window.dispatchEvent(new Event("focus")); ui = await hook.settle()
  assert.doesNotMatch(renderToStaticMarkup(ui.review), /data-testid="publish-approve(?:-retry)?"/)
  ;(ui.review as React.ReactElement<any>).props.onApprove(); ui = await hook.settle()
  assert.equal(sent.length, 1, "직접 콜백을 실행해도 일반 계정으로 승인 요청하지 않는다")
  owner = true; window.dispatchEvent(new Event("focus")); ui = await hook.settle()
  assert.match(renderToStaticMarkup(ui.review), /data-testid="publish-approve-retry"/)
  ;(ui.review as React.ReactElement<any>).props.onApprove(); ui = await hook.settle()
  assert.equal(sent.length, 2)
  assert.deepEqual(sent[0].headers, sent[1].headers); assert.equal(sent[0].body, sent[1].body)
  assert.ok(renderToStaticMarkup(ui.review).includes("승인 완료·내보내기 대기"))
})

test("승인 담당 재조회 503·연결 유실은 단추를 유지하고 401·403·목록 누락은 숨긴다", async (context) => {
  browserGlobals(context)
  let todoStatus = 200, missing = false, posts = 0
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (url.includes("/document?")) return Response.json({ ok: true, slug: preview.slug, can_request_review: true })
    if (url.endsWith("/review-todos")) {
      if (todoStatus === 0) throw new Error("연결 유실")
      if (todoStatus !== 200) return Response.json({ ok: false }, { status: todoStatus })
      return Response.json({ ok: true, tasks: missing ? [] : [{ slug: preview.slug, review_id: review, revision_id: rev }] })
    }
    if (init?.method === "POST") { posts++; throw new Error("응답 유실") }
    if (url.endsWith("/status")) return Response.json(status)
    return Response.json(preview)
  }) as typeof fetch
  const hook = hookHarness(hookOptions(fetchFn)); context.after(() => hook.stop())
  let ui = await hook.settle(); (ui.review as React.ReactElement<any>).props.onApprove(); ui = await hook.settle()
  const visible = () => /data-testid="publish-approve-retry"/.test(renderToStaticMarkup(ui.review))
  assert.equal(visible(), true)
  for (const code of [503, 0]) {
    todoStatus = code; window.dispatchEvent(new Event("focus")); ui = await hook.settle()
    assert.equal(visible(), true, `재조회 ${code}`)
    ;(ui.review as React.ReactElement<any>).props.onApprove(); ui = await hook.settle()
    assert.equal(visible(), true, `재시도 선행 조회 ${code}`); assert.equal(posts, 1)
  }
  for (const code of [403, 401, 200]) {
    todoStatus = 200; missing = false; window.dispatchEvent(new Event("focus")); ui = await hook.settle()
    assert.equal(visible(), true)
    todoStatus = code; missing = code === 200; window.dispatchEvent(new Event("focus")); ui = await hook.settle()
    assert.equal(visible(), false, `거절 또는 목록 누락 ${code}`)
  }
  todoStatus = 200; missing = false; window.dispatchEvent(new Event("focus")); ui = await hook.settle()
  assert.equal(visible(), true)
  todoStatus = 403; (ui.review as React.ReactElement<any>).props.onApprove(); ui = await hook.settle()
  assert.equal(visible(), false, "재시도 선행 조회의 권한 거절"); assert.equal(posts, 1)
})

test("계정 전환으로 화면을 떠난 즉시 단추를 숨기고 이전 담당 조회 응답은 무시한다", async (context) => {
  browserGlobals(context)
  let hold = false, finish!: (response: Response) => void
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (url.includes("/document?")) return Response.json({ ok: true, slug: preview.slug, can_request_review: true })
    if (url.endsWith("/review-todos")) return hold ? new Promise<Response>(resolve => { finish = resolve }) : Response.json({ ok: true, tasks: [{ slug: preview.slug, review_id: review, revision_id: rev }] })
    if (init?.method === "POST") throw new Error("응답 유실")
    if (url.endsWith("/status")) return Response.json(status)
    return Response.json(preview)
  }) as typeof fetch
  const hook = hookHarness(hookOptions(fetchFn)); context.after(() => hook.stop())
  let ui = await hook.settle(); (ui.review as React.ReactElement<any>).props.onApprove(); ui = await hook.settle()
  assert.match(renderToStaticMarkup(ui.review), /data-testid="publish-approve-retry"/)
  hold = true; window.dispatchEvent(new Event("focus")); await hook.settle()
  window.dispatchEvent(new Event("blur")); ui = await hook.settle()
  assert.doesNotMatch(renderToStaticMarkup(ui.review), /data-testid="publish-approve-retry"/)
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new Event("visibilitychange")); ui = await hook.settle()
  assert.doesNotMatch(renderToStaticMarkup(ui.review), /data-testid="publish-approve-retry"/)
  finish(Response.json({ ok: true, tasks: [{ slug: preview.slug, review_id: review, revision_id: rev }] })); ui = await hook.settle()
  assert.doesNotMatch(renderToStaticMarkup(ui.review), /data-testid="publish-approve-retry"/)
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); document.dispatchEvent(new Event("visibilitychange")); ui = await hook.settle()
  assert.doesNotMatch(renderToStaticMarkup(ui.review), /data-testid="publish-approve-retry"/)
  finish(Response.json({ ok: false }, { status: 403 })); ui = await hook.settle()
  assert.doesNotMatch(renderToStaticMarkup(ui.review), /data-testid="publish-approve-retry"/)
})

function browserGlobals(context: { after: (fn: () => void) => void }) {
  for (const [key, value] of [["window", new EventTarget()], ["document", Object.assign(new EventTarget(), { visibilityState: "visible" })]] as const) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { configurable: true, value })
    context.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key) })
  }
}

function hookOptions(fetchFn: typeof fetch): DocumentPublishOptions {
  return { source: "adk", path: "article.md", savedRevision: hash, enabled: true, canEdit: true, isDirty: false, pendingUploads: 0, reviewId: review, revisionId: rev, onNavigate: () => true, fetchFn }
}

test("설계 7-3-02·04·09 · 실제 훅은 차단·정확한 판·조회 실패의 승인 제거를 연결한다", async (context) => {
  browserGlobals(context)
  let failing = false, posts = 0
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") { posts++; return Response.json(result) }
    if (url.includes("/document?")) return Response.json({ ok: true, slug: "test-post", can_request_review: true })
    if (url.endsWith("/status")) return failing ? Response.json({ ok: false, code: "PUBLISH_UNAVAILABLE", message: "장애" }, { status: 503 }) : Response.json(status)
    assert.ok(url.includes(`review_id=${review}`) && url.includes(`revision_id=${rev}`))
    return Response.json(preview)
  }) as typeof fetch
  const hook = hookHarness(hookOptions(fetchFn)); context.after(() => hook.stop())
  let ui = await hook.settle()
  assert.match(renderToStaticMarkup(ui.review), /data-testid="publish-approve"/)
  for (const changed of [{ isDirty: true, pendingUploads: 0 }, { isDirty: false, pendingUploads: 1 }]) {
    hook.update(changed); ui = await hook.settle()
    assert.ok(ui.actions)
    await (ui.actions as React.ReactElement<any>).props.onRequest()
    assert.equal(posts, 0)
    assert.match(renderToStaticMarkup(ui.actions), /disabled=""/)
  }
  failing = true; window.dispatchEvent(new Event("focus")); ui = await hook.settle()
  const html = renderToStaticMarkup(ui.review)
  assert.doesNotMatch(html, /data-testid="publish-approve"|data-testid="publish-preview-match"/)
  assert.ok(renderToStaticMarkup(ui.notice).includes("현재 판 일치 여부를 확인하지 못했습니다"))
})

test("설계 7-3-04 · 이전 요청판을 현재 요청판으로 치환하지 않는다", async (context) => {
  browserGlobals(context)
  let previewCalls = 0
  const fetchFn = (async (url: string) => {
    if (url.includes("/document?")) return Response.json({ ok: true, slug: "test-post", can_request_review: true })
    if (url.endsWith("status")) return Response.json({ ...status, review_id: `review_${"b".repeat(64)}`, revision_id: `rev_${"b".repeat(64)}` })
    previewCalls++; return Response.json(preview)
  }) as typeof fetch
  const hook = hookHarness(hookOptions(fetchFn)); context.after(() => hook.stop())
  const ui = await hook.settle()
  assert.equal(previewCalls, 0)
  assert.doesNotMatch(renderToStaticMarkup(ui.review), /data-testid="publish-approve"/)
  assert.ok(renderToStaticMarkup(ui.review).includes("새 게시 확인"))
})

test("설계 7-3-09 · 문서 전환 뒤 이전 등록 조회의 늦은 성공은 섞이지 않는다", async (context) => {
  browserGlobals(context)
  let finish!: (value: Response) => void
  const fetchFn = (async (url: string) => url.includes("article.md") ? new Promise<Response>((resolve) => { finish = resolve }) : Response.json({ ok: true, slug: null, can_request_review: false })) as typeof fetch
  const hook = hookHarness(hookOptions(fetchFn)); context.after(() => hook.stop())
  await hook.settle(); hook.update({ path: "other.md", reviewId: null, revisionId: null }); await hook.settle()
  finish(Response.json({ ok: true, slug: "old-post", can_request_review: true }))
  const ui = await hook.settle()
  assert.equal(ui.actions, null); assert.equal(ui.notice, null); assert.equal(ui.review, null)
})

test("외부 변경 시 새 요청은 차단하고 기존 요청은 원래 키로 재시도한다", async (context) => {
  browserGlobals(context)
  const newHash = "b".repeat(64), newerHash = "c".repeat(64)
  let storedHash = hash, first = true
  const bodies: string[] = [], keys: string[] = []
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (url.includes("/document?")) return Response.json({ ok: true, slug: "test-post", can_request_review: true })
    if (init?.method === "POST") {
      bodies.push(JSON.parse(String(init.body)).saved_revision); keys.push((init.headers as Record<string, string>)["Idempotency-Key"])
      if (first) { first = false; return Response.json({ ok: false, code: "REVIEW_TASK_WRITE_FAILED", message: "할 일 장애", retryable: true }, { status: 503 }) }
      return Response.json({ ...result, saved_revision: newHash, revision_id: `rev_${newHash}` })
    }
    return Response.json({ ...status, saved_revision: storedHash, revision_id: `rev_${storedHash}`, pending_revision_id: null, review_id: null })
  }) as typeof fetch
  const hook = hookHarness({ ...hookOptions(fetchFn), reviewId: null, revisionId: null }); context.after(() => hook.stop())
  await hook.settle(); storedHash = newHash; window.dispatchEvent(new Event("focus"))
  let ui = await hook.settle()
  assert.match(renderToStaticMarkup(ui.notice), /문서가 다른 곳에서 바뀌었습니다/)
  ;(ui.actions as React.ReactElement<any>).props.onRequest(); ui = await hook.settle()
  assert.deepEqual(bodies, [], "화면과 다른 판을 새로 요청하지 않는다")
  hook.update({ savedRevision: newHash }); ui = await hook.settle()
  ;(ui.actions as React.ReactElement<any>).props.onRequest(); ui = await hook.settle()
  assert.deepEqual(bodies, [newHash])
  assert.ok(renderToStaticMarkup(ui.notice).includes("할 일을 저장하지 못했습니다"))
  storedHash = newerHash; window.dispatchEvent(new Event("focus")); ui = await hook.settle()
  ;(ui.actions as React.ReactElement<any>).props.onRequest(); ui = await hook.settle()
  assert.deepEqual(bodies, [newHash, newHash]); assert.equal(keys[0], keys[1])
  assert.ok(renderToStaticMarkup(ui.notice).includes("게시 확인을 요청했습니다"))
})

test("설계 7-3-09 · 요청 성공 뒤 그림만 바뀌어 저장판 지문이 같아도 새 요청판을 만든다", async (context) => {
  browserGlobals(context)
  const changedHash = "b".repeat(64), changedRev = `rev_${changedHash}`, changedReview = `review_${changedHash}`
  const keys: string[] = [], bodies: string[] = []
  let changed = false
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (url.includes("/document?")) return Response.json({ ok: true, slug: "test-post", can_request_review: true })
    if (init?.method === "POST") {
      keys.push((init.headers as Record<string, string>)["Idempotency-Key"]); bodies.push(String(init.body))
      // 실제 서버처럼 이전에 성공한 키는 당시 결과를 반환한다.
      return Response.json(changed && keys.at(-1) !== keys[0] ? { ...result, review_id: changedReview, revision_id: changedRev, review_url: `/docs?source=adk&path=article.md&publishReview=${changedReview}` } : result)
    }
    return Response.json({ ...status, revision_id: changed ? changedRev : rev, preview_hash: changed ? changedHash : hash, pending_revision_id: null, review_id: null })
  }) as typeof fetch
  const hook = hookHarness({ ...hookOptions(fetchFn), reviewId: null, revisionId: null }); context.after(() => hook.stop())
  let ui = await hook.settle(); (ui.actions as React.ReactElement<any>).props.onRequest(); ui = await hook.settle()
  assert.ok(renderToStaticMarkup(ui.notice).includes(`publishReview=${review}`))
  changed = true; window.dispatchEvent(new Event("focus")); ui = await hook.settle()
  ;(ui.actions as React.ReactElement<any>).props.onRequest(); ui = await hook.settle()
  assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1], "그림 변경은 원고의 saved_revision을 바꾸지 않는다")
  assert.notEqual(keys[0], keys[1], "성공한 이전 요청의 키를 새 판 요청에 재사용하지 않는다")
  assert.ok(renderToStaticMarkup(ui.notice).includes(`publishReview=${changedReview}`))
  assert.ok(renderToStaticMarkup(ui.notice).includes(`publishRevision=${changedRev}`))
})

test("설계 7-3-07·08·10 · 실제 훅의 승인503은 일치를 제거하고 같은키 재시도로 영수증을 얻는다", async (context) => {
  browserGlobals(context)
  const keys: string[] = []
  let approved = false
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (url.includes("/document?")) return Response.json({ ok: true, slug: "test-post", can_request_review: true })
    if (url.endsWith("/review-todos")) return Response.json({ ok: true, tasks: [{ slug: preview.slug, review_id: review, revision_id: rev }] })
    if (init?.method === "POST") {
      keys.push((init.headers as Record<string, string>)["Idempotency-Key"])
      if (keys.length === 1) return Response.json({ ok: false, code: "PUBLISH_UNAVAILABLE", message: "서명 장애", retryable: true }, { status: 503 })
      approved = true
      return Response.json({ ok: true, state: "approved_waiting_export", revision_id: rev, operation_id: operation, receipt })
    }
    if (url.endsWith("status")) return Response.json(approved ? { ...status, state: "approved_waiting_export", approved_revision_id: rev, can_approve: false, receipt } : status)
    return Response.json(preview)
  }) as typeof fetch
  const hook = hookHarness(hookOptions(fetchFn)); context.after(() => hook.stop())
  let ui = await hook.settle(); (ui.review as React.ReactElement<any>).props.onApprove(); ui = await hook.settle()
  assert.doesNotMatch(renderToStaticMarkup(ui.review), /data-testid="publish-preview-match"|data-testid="publish-approve"/)
  assert.match(renderToStaticMarkup(ui.review), /data-testid="publish-approve-retry"/)
  ;(ui.review as React.ReactElement<any>).props.onApprove(); ui = await hook.settle()
  assert.equal(keys.length, 2); assert.equal(keys[0], keys[1])
  assert.ok(renderToStaticMarkup(ui.review).includes("저장된 판"))
  assert.ok(renderToStaticMarkup(ui.review).includes("승인 완료·내보내기 대기"))
})

for (const action of ["request-review", "approve"] as const) test(`설계 7-3-02·10 · ${action} 202 뒤 편집·저장을 거쳐 같은 키로 처리를 이어 간다`, async (context) => {
  browserGlobals(context)
  const time = clock()
  context.mock.method(globalThis, "setTimeout", time.timing.setTimeout)
  context.mock.method(globalThis, "clearTimeout", time.timing.clearTimeout)
  const keys: string[] = []
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (url.includes("/document?")) return Response.json({ ok: true, slug: "test-post", can_request_review: true })
    if (url.endsWith("/review-todos")) return Response.json({ ok: true, tasks: [{ slug: preview.slug, review_id: review, revision_id: rev }] })
    if (url.includes("/operations/")) return Response.json({ ok: true, state: "processing", operation_id: operation })
    if (init?.method === "POST") {
      keys.push((init.headers as Record<string, string>)["Idempotency-Key"])
      return keys.length === 1 ? Response.json({ ok: true, state: "processing", operation_id: operation }, { status: 202 })
        : Response.json(action === "request-review" ? result : { ok: true, state: "approved_waiting_export", revision_id: rev, operation_id: operation, receipt })
    }
    return Response.json(url.endsWith("status") ? status : preview)
  }) as typeof fetch
  const hook = hookHarness(hookOptions(fetchFn)); context.after(() => hook.stop())
  let ui = await hook.settle()
  const run = (view: typeof ui) => action === "request-review" ? (view.actions as React.ReactElement<any>).props.onRequest() : (view.review as React.ReactElement<any>).props.onApprove()
  run(ui); await hook.settle()
  hook.update({ isDirty: true }); await hook.settle(); await time.advance(2000); ui = await hook.settle()
  assert.equal(keys.length, 1)
  assert.ok(renderToStaticMarkup(action === "request-review" ? ui.notice : ui.review).includes("처리가 남아 있습니다"))
  hook.update({ isDirty: false, savedRevision: "b".repeat(64) }); ui = await hook.settle()
  run(ui); ui = await hook.settle()
  assert.equal(keys.length, 2); assert.equal(keys[0], keys[1])
  assert.ok(renderToStaticMarkup(action === "request-review" ? ui.notice : ui.review).includes(action === "request-review" ? "게시 확인을 요청했습니다" : "저장된 판"))
})
