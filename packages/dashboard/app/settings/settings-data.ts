import {
  resolveAdkWorkspaceRoot,
  inspectWorkspaceSettings,
  type WorkspaceSettingsSnapshot,
  type WorkspaceRunnerStatus,
  type WorkspaceTierProfileStatus,
  type WorkspaceReviewModelsStatus,
  type WorkspaceLLMStatus,
  type WorkspaceLLMProviderStatus,
  type WorkspaceLLMRoleSlotStatus,
  type WorkspaceConfigFileItem,
  type InspectWorkspaceSettingsOptions,
} from "@naia-adk/core/src/workspace-settings"
import { apiBase } from "../api-base.ts"

export {
  inspectWorkspaceSettings,
  type WorkspaceSettingsSnapshot,
  type WorkspaceRunnerStatus,
  type WorkspaceTierProfileStatus,
  type WorkspaceReviewModelsStatus,
  type WorkspaceLLMStatus,
  type WorkspaceLLMProviderStatus,
  type WorkspaceLLMRoleSlotStatus,
  type WorkspaceConfigFileItem,
  type InspectWorkspaceSettingsOptions,
}

export interface ServerHealthSnapshot {
  status: string
  root?: string
  timestamp?: string
}

export function resolveWorkspaceRoot(startDir: string = process.cwd()): string {
  return resolveAdkWorkspaceRoot(startDir)
}

export async function loadWorkspaceSettingsSnapshot(
  fallbackRoot?: string,
): Promise<WorkspaceSettingsSnapshot> {
  try {
    const res = await fetch(`${apiBase()}/api/workspace/settings`, { cache: "no-store" })
    if (res.ok) {
      return (await res.json()) as WorkspaceSettingsSnapshot
    }
  } catch {
    // Fall back to direct read-only workspace inspection when API server is offline
  }
  return inspectWorkspaceSettings(resolveWorkspaceRoot(fallbackRoot))
}

export async function getServerHealth(): Promise<ServerHealthSnapshot | null> {
  try {
    const res = await fetch(`${apiBase()}/api/health`, { cache: "no-store" })
    if (res.ok) {
      return (await res.json()) as ServerHealthSnapshot
    }
  } catch {
    // Offline
  }
  return null
}
