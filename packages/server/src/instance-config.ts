import fs from "node:fs"
import path from "node:path"

export interface InstanceConfig {
  /**
   * Read-only document instance (e.g. a public deployment whose front layer
   * blocks document writes). When true the server rejects every non-GET
   * write verb — including publish and asset uploads — with 403, and the
   * dashboard hides its edit affordances.
   */
  docsReadOnly: boolean
}

const MAX_CONFIG_FILE_BYTES = 64 * 1024

function defaults(): InstanceConfig {
  return { docsReadOnly: false }
}

function parseDashboardJson(raw: unknown): InstanceConfig {
  const config = defaults()
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return config
  const docs = (raw as Record<string, unknown>).docs
  if (docs !== undefined) {
    if (!docs || typeof docs !== "object" || Array.isArray(docs)) return config
    const readOnly = (docs as Record<string, unknown>).readOnly
    if (readOnly !== undefined) {
      if (typeof readOnly !== "boolean") return config
      config.docsReadOnly = readOnly
    }
  }
  return config
}

export function getInstanceConfigPath(adkRoot: string): string {
  return path.join(adkRoot, "config", "dashboard.json")
}

export function loadInstanceConfig(adkRoot: string): InstanceConfig {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(getInstanceConfigPath(adkRoot))
  } catch {
    return defaults()
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_FILE_BYTES) return defaults()
  try {
    return parseDashboardJson(JSON.parse(fs.readFileSync(getInstanceConfigPath(adkRoot), "utf-8")))
  } catch {
    return defaults()
  }
}
