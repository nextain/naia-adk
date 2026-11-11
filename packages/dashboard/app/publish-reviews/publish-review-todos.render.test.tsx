import assert from "node:assert/strict"
import test from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { loadPublishReviewTodos, MSG_PUBLISH_REVIEW_TODOS_FAILED, PUBLISH_REVIEW_STATE_LABEL, PUBLISH_REVIEW_TODOS_URL, type PublishReviewTask } from "../components/publish-review-todos"
import { PublishReviewTodos } from "./PublishReviewTodos"

const task = (state: PublishReviewTask["state"] = "pending_review"): PublishReviewTask => ({
  task_id: `task-${state}`, kind: "publish_review", title: "게시 확인: 시험 원고", assignee_id: "test:user-one", slug: "test-post",
  review_id: "review_requested", revision_id: "rev_requested", saved_revision: "saved-original", created_at: "2030-11-01T06:00:00.000Z",
  review_url: "/docs?source=adk&path=article.md&publishReview=review_requested&publishRevision=rev_requested", state,
})
const fetchResponse = (body: unknown, status = 200) => (async () => Response.json(body, { status })) as typeof fetch

test("담당자별 응답의 요청판을 그대로 보여주고 상태를 서버 기준으로 표시한다", async () => {
  const tasks = [task(), task("superseded"), task("completed")]
  const fetchFn = (async (url, init) => { assert.equal(url, PUBLISH_REVIEW_TODOS_URL); assert.deepEqual(init, { cache: "no-store" }); return Response.json({ ok: true, tasks }) }) as typeof fetch
  const result = await loadPublishReviewTodos(fetchFn)
  assert.deepEqual(result, tasks)
  const html = renderToStaticMarkup(<PublishReviewTodos tasks={result} state="ready" onRetry={() => {}} />)
  for (const item of tasks) {
    assert.match(html, new RegExp(`data-state="${item.state}"`))
    assert.ok(html.includes(PUBLISH_REVIEW_STATE_LABEL[item.state]))
    assert.ok(html.includes(item.review_url.replaceAll("&", "&amp;")))
  }
  assert.doesNotMatch(html, /승인하기|완료 처리/)
})

test("실패·손상된 항목은 빈 성공이나 낙관적 완료로 바꾸지 않으며 재시도를 표시한다", async () => {
  const good = task()
  const invalid = [null, {}, { ok: false, tasks: [] }, { ok: true }, { ok: true, tasks: {} },
    { ok: true, tasks: [{ ...good, state: "approved" }] },
    { ok: true, tasks: [{ ...good, created_at: "invalid" }] },
    { ok: true, tasks: [{ ...good, review_url: "https://outside.test/docs?source=adk&path=a&publishReview=review_requested&publishRevision=rev_requested" }] },
    ...["source", "path", "publishReview", "publishRevision"].map((key) => {
      const url = new URL(good.review_url, "https://portal.invalid"); url.searchParams.append(key, "other")
      return { ok: true, tasks: [{ ...good, review_url: url.pathname + url.search }] }
    }),
    ...["publishReview", "publishRevision"].map((key) => {
      const url = new URL(good.review_url, "https://portal.invalid"); url.searchParams.set(key, "other")
      return { ok: true, tasks: [{ ...good, review_url: url.pathname + url.search }] }
    }),
    { ok: true, tasks: [{ ...good, review_url: good.review_url.replace("&path=article.md", "") }] },
    { ok: true, tasks: [{ ...good, review_url: `${good.review_url}#fragment` }] },
    { ok: true, tasks: [good, good] },
  ]
  for (const body of invalid) await assert.rejects(loadPublishReviewTodos(fetchResponse(body)), { message: MSG_PUBLISH_REVIEW_TODOS_FAILED })
  for (const status of [401, 403, 503]) await assert.rejects(loadPublishReviewTodos(fetchResponse({ ok: false }, status)))
  await assert.rejects(loadPublishReviewTodos((async () => { throw new Error("network") }) as typeof fetch))
  assert.deepEqual(await loadPublishReviewTodos(fetchResponse({ ok: true, tasks: [] })), [])
  const html = renderToStaticMarkup(<PublishReviewTodos tasks={[good]} state="error" onRetry={() => {}} />)
  assert.ok(html.includes(MSG_PUBLISH_REVIEW_TODOS_FAILED)); assert.ok(html.includes("다시 시도")); assert.ok(!html.includes(good.title))
})
