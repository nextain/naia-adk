import React from "react"
import type { Metadata } from "next"
import { loadWorkspaceSettingsSnapshot } from "../settings-data.ts"
import { LLMSettingsView } from "./llm-settings-view.tsx"

export const metadata: Metadata = { title: "LLM Settings — Naia ADK" }

export default async function LLMSettingsPage() {
  const snapshot = await loadWorkspaceSettingsSnapshot()
  return <LLMSettingsView snapshot={snapshot} />
}
