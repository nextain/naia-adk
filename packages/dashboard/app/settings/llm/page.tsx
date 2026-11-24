import React from "react"
import type { Metadata } from "next"
import { loadWorkspaceSettingsSnapshot } from "../settings-data.ts"
import { LLMSettingsView } from "./llm-settings-view.tsx"
import { getRequestLocale } from "../../i18n/server"

export const metadata: Metadata = { title: "LLM Settings — Naia ADK" }

export default async function LLMSettingsPage() {
  const [snapshot, locale] = await Promise.all([
    loadWorkspaceSettingsSnapshot(),
    getRequestLocale(),
  ])
  return <LLMSettingsView snapshot={snapshot} locale={locale} />
}
