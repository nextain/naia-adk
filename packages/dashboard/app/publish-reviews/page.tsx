"use client"

import React, { useEffect, useRef, useState } from "react"
import { loadPublishReviewTodos, PUBLISH_REVIEW_CHANGED_EVENT, type PublishReviewTask } from "../components/publish-review-todos"
import { PublishReviewTodos } from "./PublishReviewTodos"

export default function PublishReviewsPage() {
  const [tasks, setTasks] = useState<PublishReviewTask[]>([])
  const [state, setState] = useState<"loading" | "ready" | "error">("loading")
  const [reload, setReload] = useState(0)
  const pending = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    pending.current = controller
    setTasks([]); setState("loading")
    void loadPublishReviewTodos(fetch, controller.signal).then((result) => {
      if (!controller.signal.aborted) { setTasks(result); setState("ready") }
    }).catch(() => { if (!controller.signal.aborted) setState("error") })
    return () => { controller.abort(); if (pending.current === controller) pending.current = null }
  }, [reload])

  useEffect(() => {
    const refresh = () => setReload((n) => n + 1)
    const hide = () => { pending.current?.abort(); setTasks([]); setState("loading") }
    const visibility = () => { if (document.visibilityState === "visible") refresh(); else hide() }
    window.addEventListener("focus", refresh)
    window.addEventListener("blur", hide)
    window.addEventListener(PUBLISH_REVIEW_CHANGED_EVENT, refresh)
    document.addEventListener("visibilitychange", visibility)
    return () => { window.removeEventListener("focus", refresh); window.removeEventListener("blur", hide); window.removeEventListener(PUBLISH_REVIEW_CHANGED_EVENT, refresh); document.removeEventListener("visibilitychange", visibility) }
  }, [])

  return <PublishReviewTodos tasks={tasks} state={state} onRetry={() => setReload((n) => n + 1)} />
}
