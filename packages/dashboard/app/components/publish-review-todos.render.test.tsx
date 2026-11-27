import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  loadPublishReviewTodosResult,
  loadPublishReviewTodos,
  MSG_PUBLISH_REVIEW_TODOS_FAILED,
  PUBLISH_REVIEW_STATE_LABEL,
  PUBLISH_REVIEW_TODOS_URL,
  publishReviewTimelineItems,
  type PublishReviewTask,
} from "../components/publish-review-todos"

const task = (state: PublishReviewTask["state"] = "pending_review"): PublishReviewTask => ({
  task_id: `task-${state}`,
  kind: "publish_review",
  title: "게시 확인: 시험용 원고",
  assignee_id: "test-gate:owner",
  slug: "test-post",
  review_id: "review_requested-revision",
  revision_id: "rev_requested",
  saved_revision: "saved-original",
  created_at: "2026-11-01T06:00:00.000Z",
  review_url: "/docs?tab=common&source=adk&path=common%2Ftest.md&publishReview=review_requested-revision",
  state,
})

describe("게시 확인 할 일", () => {
  it("확인 요청 성공 뒤 서버 할 일이 하나 표시되며 같은 제목도 다른 판이면 합치지 않는다", async () => {
    const requests: unknown[] = []
    const fetchFn = (async (url, init) => {
      requests.push([url, init])
      return Response.json({ ok: true, tasks: [task()] })
    }) as typeof fetch
    const tasks = await loadPublishReviewTodos(fetchFn)
    assert.deepEqual(requests, [[PUBLISH_REVIEW_TODOS_URL, { cache: "no-store" }]])
    const items = publishReviewTimelineItems(tasks)
    assert.equal(items.length, 1)
    assert.equal(items[0].title, "게시 확인: 시험용 원고")
    assert.equal(items[0].by, "모름", "담당자 계정을 올린 사람으로 추측하지 않는다")
    const second = { ...task(), task_id: "task-next", review_id: "review_next", review_url: task().review_url.replace("review_requested-revision", "review_next") }
    assert.equal(new Set(publishReviewTimelineItems([task(), second]).map((item) => item.key)).size, 2)
  })

  it("할 일에서 서버가 준 정확한 요청판 주소로 이동한다", () => {
    const original = task()
    const items = publishReviewTimelineItems([original])
    assert.deepEqual(items[0].links, [{ label: "요청판 열기", href: original.review_url, external: false }])
  })

  it("서버가 확정한 완료·대체 상태만 표시한다", () => {
    for (const state of ["pending_review", "superseded", "completed"] as const) {
      const items = publishReviewTimelineItems([task(state)])
      assert.equal(items[0].publishReviewState, state)
      assert.equal(PUBLISH_REVIEW_STATE_LABEL[state], { pending_review: "게시 확인 대기", superseded: "새 요청판으로 대체됨", completed: "승인 완료·내보내기 대기" }[state])
    }
  })

  it("HTTP 오류·전송 실패·손상된 응답을 빈 성공이나 낙관적 완료로 바꾸지 않는다", async () => {
    for (const status of [401, 403, 503]) {
      await assert.rejects(loadPublishReviewTodos((async () => Response.json({ ok: false }, { status })) as typeof fetch))
    }
    await assert.rejects(loadPublishReviewTodos((async () => { throw new Error("network") }) as typeof fetch))
    const invalid = [
      null, {}, { ok: false, tasks: [] }, { ok: true }, { ok: true, tasks: {} },
      { ok: true, tasks: [{ ...task(), state: "approved" }] },
      { ok: true, tasks: [{ ...task(), state: undefined }] },
      { ok: true, tasks: [{ ...task(), created_at: "invalid" }] },
      { ok: true, tasks: [{ ...task(), review_url: "https://other.example/docs?publishReview=review_requested-revision" }] },
      { ok: true, tasks: [{ ...task(), review_url: task().review_url.replace("review_requested-revision", "review_other") }] },
      { ok: true, tasks: [{ ...task(), review_url: `${task().review_url}&publishReview=review_other` }] },
      { ok: true, tasks: [task(), task()] },
    ]
    for (const body of invalid) {
      await assert.rejects(loadPublishReviewTodos((async () => Response.json(body)) as typeof fetch), { message: MSG_PUBLISH_REVIEW_TODOS_FAILED })
    }
    await assert.rejects(loadPublishReviewTodos((async () => new Response("not json")) as typeof fetch))
    assert.deepEqual(await loadPublishReviewTodos((async () => Response.json({ ok: true, tasks: [] })) as typeof fetch), [])
  })

  it("게이트웨이 미확인 403은 오류 대신 조용한 준비 상태로 처리한다", async () => {
    const result = await loadPublishReviewTodosResult((async () => Response.json({
      ok: false, code: "publish_gateway_unconfirmed", message: "게시 기능 준비 중입니다.",
    }, { status: 403 })) as typeof fetch)
    assert.deepEqual(result, { enabled: false, tasks: [] })
  })
})
