import React from "react"
import type { Metadata } from "next"
import { loadWorkspaceSettingsSnapshot } from "../settings-data.ts"
import { getWorkspaceDisplayName, resolveAdkWorkspaceRoot } from "@naia-adk/core/src/workspace-settings"
import { LLMSettingsView } from "./llm-settings-view.tsx"
import { getRequestLocale } from "../../i18n/server"

export async function generateMetadata(): Promise<Metadata> {
  return { title: `LLM Settings — ${getWorkspaceDisplayName(resolveAdkWorkspaceRoot(process.cwd()))}` }
}

export default async function LLMSettingsPage() {
  const [snapshot, locale] = await Promise.all([
    loadWorkspaceSettingsSnapshot(),
    getRequestLocale(),
  ])
  return <LLMSettingsView snapshot={snapshot} locale={locale} />
}
