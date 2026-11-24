import React from "react"
import { getServerHealth, loadWorkspaceSettingsSnapshot } from "./settings-data.ts"
import { SettingsView } from "./settings-view.tsx"

export default async function SettingsPage() {
  const [snapshot, health] = await Promise.all([
    loadWorkspaceSettingsSnapshot(),
    getServerHealth(),
  ])

  return <SettingsView snapshot={snapshot} health={health} />
}
