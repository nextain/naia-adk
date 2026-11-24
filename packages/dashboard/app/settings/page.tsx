import React from "react"
import { getServerHealth, loadWorkspaceSettingsSnapshot } from "./settings-data.ts"
import { SettingsView } from "./settings-view.tsx"
import { getRequestLocale } from "../i18n/server"

export default async function SettingsPage() {
  const [snapshot, health, locale] = await Promise.all([
    loadWorkspaceSettingsSnapshot(),
    getServerHealth(),
    getRequestLocale(),
  ])

  return <SettingsView snapshot={snapshot} health={health} locale={locale} />
}
