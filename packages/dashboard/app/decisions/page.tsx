"use client"

import React, { useEffect, useState, type FormEvent } from "react"
import { DecisionList } from "./DecisionList"
import { parseDecisionSection, type DecisionConfig } from "./decisions"
import { useLocale, useT } from "../i18n/provider.tsx"
import type { TranslationKey } from "../i18n/types.ts"

const KEY = "naia.decision-document.v1"
const EMPTY: DecisionConfig = { source: "", path: "", pendingHeading: "", doneHeading: "" }

type DecisionError = { key: TranslationKey } | { text: string } | null

export default function DecisionsPage() {
  const locale = useLocale()
  const t = useT()
  const [form, setForm] = useState<DecisionConfig>(EMPTY)
  const [config, setConfig] = useState<DecisionConfig | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<DecisionError>(null)
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState(true)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    try {
      const value = JSON.parse(localStorage.getItem(KEY) || "null")
      if (value && Object.keys(EMPTY).every((key) => typeof value[key] === "string" && value[key].trim())) {
        setForm(value); setConfig(value); setEditing(false)
      }
    } catch {
      setError({ key: "dec.errStored" })
    }
  }, [])

  useEffect(() => {
    if (!config) return
    const controller = new AbortController()
    setLoading(true); setError(null); setContent(null)
    const params = new URLSearchParams({ source: config.source, path: config.path })
    fetch(`/api/portal/text?${params}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(t("dec.errLoad"))
        const data = await response.json()
        if (typeof data.content !== "string" || data.truncated) throw new Error(t("dec.errTooLong"))
        parseDecisionSection(data.content, config.pendingHeading)
        parseDecisionSection(data.content, config.doneHeading)
        setContent(data.content)
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? { text: err.message } : { key: "dec.errLoadGeneric" })
        }
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [config, reload, t])

  function save(event: FormEvent) {
    event.preventDefault()
    const next = Object.fromEntries(Object.entries(form).map(([key, value]) => [key, value.trim()])) as unknown as DecisionConfig
    if (Object.values(next).some((value) => !value)) { setError({ key: "dec.errIncomplete" }); return }
    if (next.pendingHeading === next.doneHeading) { setError({ key: "dec.errSameHeading" }); return }
    try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { setError({ key: "dec.errStore" }); return }
    setError(null); setConfig(next); setEditing(false)
  }

  const errorText = error ? ("key" in error ? t(error.key) : error.text) : ""

  return <main className="mx-auto max-w-3xl px-4 py-8 text-neutral-100">
    <h1 className="mb-4 text-2xl font-bold">{t("dec.title")}</h1>
    <button type="button" className="mb-4 text-sm text-blue-400 underline" onClick={() => setEditing(!editing)}>{editing ? t("dec.settingsToggleClose") : t("dec.settingsToggleOpen")}</button>
    {editing && <form onSubmit={save} className="mb-6 space-y-3 rounded-lg border border-neutral-700 p-4">
      <p className="text-sm text-neutral-400">{t("dec.formDesc")}</p>
      {([ ["source", t("dec.source")], ["path", t("dec.path")], ["pendingHeading", t("dec.pendingHeading")], ["doneHeading", t("dec.doneHeading")] ] as const).map(([key, label]) => <label key={key} className="block text-sm">{label}<input required value={form[key]} onChange={(event) => setForm({ ...form, [key]: event.target.value })} className="mt-1 block w-full rounded border border-neutral-600 bg-neutral-900 p-2" /></label>)}
      <button className="rounded bg-blue-700 px-4 py-2" type="submit">{t("dec.save")}</button>
    </form>}
    {loading && <p>{t("dec.loading")}</p>}
    {errorText && <div role="alert" className="mb-4 text-red-300">{errorText} {config && <button className="underline" onClick={() => setReload((n) => n + 1)}>{t("dec.retry")}</button>}</div>}
    {!config && !editing && <p>{t("dec.noConfig")}</p>}
    {content !== null && config && <DecisionList markdown={content} config={config} locale={locale} />}
  </main>
}
