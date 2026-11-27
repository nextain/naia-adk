import assert from "node:assert/strict"
import test from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ExportRevision, publishFailureReason } from "../publish-results/PublishResults"
import type { PublishExportRevision } from "./publish-client"

const hash = "a".repeat(64)
const revision: PublishExportRevision = {
  slug: "alpha-blog", revision_id: `rev_${hash}`, approved_hash: hash, approved_at: "2030-11-04T11:00:00.000Z", receipt_id: "receipt-test",
  cells: [
    { site: "site-alpha.example", language: "ko", state: "queued", sequence: 0, updated_at: "2030-11-04T11:00:00.000Z" },
    { site: "site-alpha.example", language: "en", state: "sending", sequence: 1, updated_at: "2030-11-04T11:01:00.000Z" },
    { site: "site-beta.example", language: "ko", state: "saved", sequence: 2, updated_at: "2030-11-04T11:02:00.000Z" },
    { site: "site-beta.example", language: "en", state: "published", sequence: 3, updated_at: "2030-11-04T11:03:00.000Z" },
    { site: "site-alpha.example", language: "ja", state: "failed", sequence: 2, updated_at: "2030-11-04T11:04:00.000Z", failure_code: "DESTINATION_UNAVAILABLE" },
  ],
}

test("게시 결과는 다섯 상태와 실패 이유를 표시하고 승인자에게 해당 실패 칸의 비활성 동작만 보인다", () => {
  const html = renderToStaticMarkup(<ExportRevision revision={revision} canRetry />)
  for (const label of ["저장 대기", "저장 중", "저장 완료 · 공개 예정", "공개", "실패", "대상 사이트에 연결할 수 없습니다.", "DESTINATION_UNAVAILABLE"]) assert.ok(html.includes(label), label)
  assert.equal((html.match(/data-testid="publish-results-retry"/g) ?? []).length, 1)
  assert.ok(html.includes('data-cell="site-alpha.example:ja"'))
  assert.match(html, /disabled=""/)
  assert.match(html, /게이트웨이 재전송 연결 전까지 사용할 수 없습니다/)
  assert.equal(publishFailureReason("FUTURE_ERROR_CODE"), "실패 코드: FUTURE_ERROR_CODE")
})

test("승인자가 아니면 실패 상태를 읽어도 다시 하기 버튼을 렌더링하지 않는다", () => {
  const html = renderToStaticMarkup(<ExportRevision revision={revision} canRetry={false} />)
  assert.doesNotMatch(html, /data-testid="publish-results-retry"/)
  assert.match(html, /승인 담당자만 다시 할 수 있습니다/)
})
