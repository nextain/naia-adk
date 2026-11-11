"use client"

import React from "react"
import Link from "next/link"
import { MSG_PUBLISH_REVIEW_TODOS_FAILED, PUBLISH_REVIEW_STATE_LABEL, type PublishReviewTask } from "../components/publish-review-todos"

export function PublishReviewTodos({ tasks, state, onRetry }: { tasks: PublishReviewTask[]; state: "loading" | "ready" | "error"; onRetry: () => void }) {
  return <main className="mx-auto max-w-3xl px-4 py-8 text-neutral-100">
    <h1 className="mb-4 text-2xl font-bold">게시 확인 할 일</h1>
    {state === "loading" && <p role="status">게시 확인 할 일을 불러오는 중입니다.</p>}
    {state === "error" && <div role="alert" className="space-y-2 text-amber-300"><p>{MSG_PUBLISH_REVIEW_TODOS_FAILED}</p>
      <button type="button" onClick={onRetry} className="underline">다시 시도</button></div>}
    {state === "ready" && tasks.length === 0 && <p>게시 확인 할 일이 없습니다.</p>}
    {state === "ready" && tasks.length > 0 && <ul className="space-y-3">
      {tasks.map((task) => <li key={task.task_id} data-testid="publish-review-task" data-state={task.state} className="rounded-lg border border-neutral-700 p-4">
        <p className="font-medium break-words">{task.title}</p>
        <p className="mt-1 text-sm text-neutral-400">{PUBLISH_REVIEW_STATE_LABEL[task.state]}</p>
        <Link href={task.review_url} className="mt-2 inline-block text-sm text-blue-300 underline">요청판 열기</Link>
      </li>)}
    </ul>}
  </main>
}
