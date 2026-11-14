"use client"

import { useEffect, useState, type FormEvent } from "react"
import { DecisionList } from "./DecisionList"
import { parseDecisionSection, type DecisionConfig } from "./decisions"

const KEY = "naia.decision-document.v1"
const EMPTY: DecisionConfig = { source: "", path: "", pendingHeading: "", doneHeading: "" }

export default function DecisionsPage() {
  const [form, setForm] = useState<DecisionConfig>(EMPTY)
  const [config, setConfig] = useState<DecisionConfig | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState(true)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    try {
      const value = JSON.parse(localStorage.getItem(KEY) || "null")
      if (value && Object.keys(EMPTY).every((key) => typeof value[key] === "string" && value[key].trim())) {
        setForm(value); setConfig(value); setEditing(false)
      }
    } catch { setError("저장된 설정을 읽지 못했습니다. 다시 설정해 주세요.") }
  }, [])

  useEffect(() => {
    if (!config) return
    const controller = new AbortController()
    setLoading(true); setError(""); setContent(null)
    const params = new URLSearchParams({ source: config.source, path: config.path })
    fetch(`/api/portal/text?${params}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("문서를 불러오지 못했습니다. 출처와 권한을 확인해 주세요.")
        const data = await response.json()
        if (typeof data.content !== "string" || data.truncated) throw new Error("문서가 없거나 너무 깁니다.")
        parseDecisionSection(data.content, config.pendingHeading)
        parseDecisionSection(data.content, config.doneHeading)
        setContent(data.content)
      })
      .catch((err) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "문서를 불러오지 못했습니다.") })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [config, reload])

  function save(event: FormEvent) {
    event.preventDefault()
    const next = Object.fromEntries(Object.entries(form).map(([key, value]) => [key, value.trim()])) as unknown as DecisionConfig
    if (Object.values(next).some((value) => !value)) { setError("설정 항목을 모두 입력해 주세요."); return }
    if (next.pendingHeading === next.doneHeading) { setError("대기 제목과 완료 제목은 달라야 합니다."); return }
    try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { setError("브라우저에 설정을 저장하지 못했습니다."); return }
    setError(""); setConfig(next); setEditing(false)
  }

  return <main className="mx-auto max-w-3xl px-4 py-8 text-neutral-100">
    <h1 className="mb-4 text-2xl font-bold">결정 목록</h1>
    <button type="button" className="mb-4 text-sm text-blue-400 underline" onClick={() => setEditing(!editing)}>{editing ? "설정 닫기" : "문서 설정"}</button>
    {editing && <form onSubmit={save} className="mb-6 space-y-3 rounded-lg border border-neutral-700 p-4">
      <p className="text-sm text-neutral-400">문서 출처와 경로, 표가 있는 두 제목을 입력합니다. 설정은 이 브라우저에 저장됩니다.</p>
      {([ ["source", "문서 출처"], ["path", "문서 경로"], ["pendingHeading", "대기 제목"], ["doneHeading", "완료 제목"] ] as const).map(([key, label]) => <label key={key} className="block text-sm">{label}<input required value={form[key]} onChange={(event) => setForm({ ...form, [key]: event.target.value })} className="mt-1 block w-full rounded border border-neutral-600 bg-neutral-900 p-2" /></label>)}
      <button className="rounded bg-blue-700 px-4 py-2" type="submit">저장하고 불러오기</button>
    </form>}
    {loading && <p>결정 목록을 불러오는 중입니다.</p>}
    {error && <div role="alert" className="mb-4 text-red-300">{error} {config && <button className="underline" onClick={() => setReload((n) => n + 1)}>다시 시도</button>}</div>}
    {!config && !editing && <p>문서 설정을 입력해 주세요.</p>}
    {content !== null && config && <DecisionList markdown={content} config={config} />}
  </main>
}
