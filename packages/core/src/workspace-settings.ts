import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"

export type RunnerId = "agy" | "muse" | "claude" | "codex" | "opencode" | "naia-os"

export interface WorkspaceRunnerStatus {
  id: RunnerId
  label: string
  binary: string
  available: boolean
  profileHooksSupported: boolean
  roles: string[]
  configDetected: boolean
}

export interface TierSummaryItem {
  tier: string
  purpose?: string
  candidateCount: number
  clis: string[]
}

export interface WorkspaceTierProfileStatus {
  status: "configured" | "missing" | "invalid"
  path: "config/tier-profile.json"
  examplePath: "config/tier-profile.example.json"
  exampleExists: boolean
  error?: string
  priority: string[]
  workerSteps: string[]
  tiers: TierSummaryItem[]
}

export interface ReviewModelOverrideItem {
  key: string
  runner: string | null
  effort: string | null
}

export interface WorkspaceReviewModelsStatus {
  readOnly: true
  approvalGate: "CFG-"
  supportedRunners: Array<"agy" | "muse" | "codex" | "claude">
  deployConfigPath: ".claude/deploy/config.json"
  deployConfigExists: boolean
  overrideCount: number
  overrides: ReviewModelOverrideItem[]
  reviewConfigPath: "naia-settings/review.json"
  reviewConfigExists: boolean
  reviewerSlots: string[]
  reviewerCount: number
}

export type LLMProviderSlotId = "naia" | "any-llm" | "openai" | "anthropic" | "google"

export interface WorkspaceLLMProviderStatus {
  id: LLMProviderSlotId
  name: string
  configured: boolean
  source?: string
  note: string
}

export interface WorkspaceLLMRoleSlotStatus {
  role: "main" | "sub" | "embedded"
  configured: boolean
  provider: string | null
}

export interface WorkspaceLLMStatus {
  yamlPath: ".agents/context/llm-config.yaml"
  yamlExists: boolean
  jsonPath: "naia-settings/llm.json"
  jsonExists: boolean
  defaultProvider: string | null
  gatewayUrlConfigured: boolean
  roleSlots: WorkspaceLLMRoleSlotStatus[]
  providers: WorkspaceLLMProviderStatus[]
}

export interface WorkspaceConfigFileItem {
  name: string
  path: string
  exists: boolean
}

export interface WorkspaceSettingsSnapshot {
  runners: WorkspaceRunnerStatus[]
  tierProfile: WorkspaceTierProfileStatus
  reviewModels: WorkspaceReviewModelsStatus
  llm: WorkspaceLLMStatus
  configFiles: WorkspaceConfigFileItem[]
}

export interface InspectWorkspaceSettingsOptions {
  pathEnv?: string
  homeDir?: string
  env?: Record<string, string | undefined>
}

const PLACEHOLDER_RE = /<[A-Z0-9_][^>]*>|\{\{[^}]*\}\}|^(?:MODEL_ID|CLI_ID)$/i
const SAFE_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/i
const SECRET_LIKE_RE = /^(?:sk-|AIza|gh[pousr]_|AKIA|xox[baprs]-|eyJ)/i

function isValidTierToken(val: unknown): val is string {
  if (typeof val !== "string") return false
  const s = val.trim()
  return s.length > 0 && !/[\0\r\n]/.test(val) && val === s && !PLACEHOLDER_RE.test(s)
}

function isSafeNonSecretIdentifier(val: unknown): val is string {
  if (typeof val !== "string") return false
  const trimmed = val.trim()
  return (
    trimmed.length > 0 &&
    trimmed.length <= 64 &&
    SAFE_ID_RE.test(trimmed) &&
    !SECRET_LIKE_RE.test(trimmed) &&
    !/secret|token|password|apikey|api_key/i.test(trimmed)
  )
}

export function isBinaryAvailableOnPath(binary: string, pathEnv?: string): boolean {
  if (!binary || /[/\\]/.test(binary)) return false
  const rawPath = pathEnv !== undefined ? pathEnv : (process.env.PATH ?? "")
  if (!rawPath) return false
  const segments = rawPath.split(path.delimiter).filter(Boolean)
  for (const dir of segments) {
    const candidate = path.join(dir, binary)
    try {
      const st = fs.statSync(candidate)
      if (!st.isFile()) continue
      fs.accessSync(candidate, fs.constants.X_OK)
      return true
    } catch {
      // Ignore inaccessible or missing PATH entries
    }
  }
  return false
}

function anyPathExists(paths: string[]): boolean {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) return true
    } catch {
      // Ignore permission errors
    }
  }
  return false
}

function inspectRunners(root: string, opts?: InspectWorkspaceSettingsOptions): WorkspaceRunnerStatus[] {
  const pathEnv = opts?.pathEnv
  const homeDir = opts?.homeDir

  const specs: Array<{
    id: RunnerId
    label: string
    binary: string
    profileHooksSupported: boolean
    roles: string[]
    markers: string[]
  }> = [
    {
      id: "agy",
      label: "agy",
      binary: "agy",
      profileHooksSupported: false,
      roles: ["tier-worker", "independent-reviewer", "sandbox"],
      markers: [
        path.join(root, "GEMINI.md"),
        ...(homeDir
          ? [
              path.join(homeDir, ".gemini", "antigravity-cli"),
              path.join(homeDir, ".config", "agy"),
            ]
          : []),
      ],
    },
    {
      id: "muse",
      label: "muse",
      binary: "muse",
      profileHooksSupported: true,
      roles: ["tier-worker", "independent-reviewer", "profile-hooks"],
      markers: [
        path.join(root, "templates", "muse-user-profile", "settings.json"),
        path.join(root, ".agents", "hooks", "muse-pretooluse-adapter.cjs"),
        ...(homeDir ? [path.join(homeDir, ".config", "muse", "settings.json")] : []),
      ],
    },
    {
      id: "claude",
      label: "Claude Code",
      binary: "claude",
      profileHooksSupported: true,
      roles: ["tier-worker", "independent-reviewer", "profile-hooks"],
      markers: [
        path.join(root, ".claude"),
        path.join(root, "CLAUDE.md"),
        ...(homeDir ? [path.join(homeDir, ".claude", "settings.json")] : []),
      ],
    },
    {
      id: "codex",
      label: "Codex",
      binary: "codex",
      profileHooksSupported: true,
      roles: ["tier-worker", "independent-reviewer", "profile-hooks"],
      markers: [
        path.join(root, ".codex"),
        ...(homeDir
          ? [path.join(homeDir, ".codex", "hooks.json"), path.join(homeDir, ".codex", "config.toml")]
          : []),
      ],
    },
    {
      id: "opencode",
      label: "opencode",
      binary: "opencode",
      profileHooksSupported: false,
      roles: ["workspace-client", "tier-worker"],
      markers: [
        path.join(root, "opencode.json"),
        path.join(root, ".opencode"),
        ...(homeDir ? [path.join(homeDir, ".config", "opencode")] : []),
      ],
    },
    {
      id: "naia-os",
      label: "naia-os",
      binary: "naia-os",
      profileHooksSupported: false,
      roles: ["desktop-runtime", "local-agent"],
      markers: [
        path.join(root, "naia-os"),
        path.join(root, "naia-settings"),
        ...(homeDir ? [path.join(homeDir, ".config", "naia-os")] : []),
      ],
    },
  ]

  return specs.map((spec) => ({
    id: spec.id,
    label: spec.label,
    binary: spec.binary,
    available: isBinaryAvailableOnPath(spec.binary, pathEnv),
    profileHooksSupported: spec.profileHooksSupported,
    roles: spec.roles,
    configDetected: anyPathExists(spec.markers),
  }))
}

function inspectTierProfile(root: string): WorkspaceTierProfileStatus {
  const relPath = "config/tier-profile.json" as const
  const exampleRelPath = "config/tier-profile.example.json" as const
  const targetPath = path.join(root, relPath)
  const exampleExists = fs.existsSync(path.join(root, exampleRelPath))

  const baseMissing = (): WorkspaceTierProfileStatus => ({
    status: "missing",
    path: relPath,
    examplePath: exampleRelPath,
    exampleExists,
    priority: [],
    workerSteps: [],
    tiers: [],
  })

  const invalid = (error: string): WorkspaceTierProfileStatus => ({
    status: "invalid",
    path: relPath,
    examplePath: exampleRelPath,
    exampleExists,
    error,
    priority: [],
    workerSteps: [],
    tiers: [],
  })

  let raw: string
  try {
    const st = fs.statSync(targetPath)
    if (!st.isFile() || st.size > 1 << 20) {
      return invalid("config/tier-profile.json must be a regular file under 1MB")
    }
    raw = fs.readFileSync(targetPath, "utf-8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return baseMissing()
    }
    return invalid("Failed to read config/tier-profile.json")
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return invalid("Invalid JSON in config/tier-profile.json")
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return invalid("Root of config/tier-profile.json must be a JSON object")
  }

  const doc = parsed as Record<string, unknown>
  if (doc.schema !== "tier-profile/v1") {
    return invalid('Unsupported or missing schema (expected "tier-profile/v1")')
  }

  let priority: string[] = []
  if (doc.priority !== undefined) {
    if (!Array.isArray(doc.priority) || doc.priority.length === 0 || !doc.priority.every(isValidTierToken)) {
      return invalid("priority must be a non-empty array of concrete CLI tokens without placeholders")
    }
    priority = doc.priority.map((s) => s.trim())
  }

  if (!doc.tiers || typeof doc.tiers !== "object" || Array.isArray(doc.tiers)) {
    return invalid("tiers object is required")
  }

  const tiersObj = doc.tiers as Record<string, unknown>
  const tierEntries = Object.entries(tiersObj)
  if (tierEntries.length === 0) {
    return invalid("tiers object must declare at least one tier")
  }

  const summaries: TierSummaryItem[] = []
  for (const [tierKey, tierVal] of tierEntries) {
    if (!tierVal || typeof tierVal !== "object" || Array.isArray(tierVal)) {
      return invalid(`tiers.${tierKey} must be an object`)
    }
    const tierRecord = tierVal as Record<string, unknown>
    const candidates = tierRecord.candidates
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return invalid(`tiers.${tierKey}.candidates must be a non-empty array`)
    }
    const clis: string[] = []
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i]
      if (!c || typeof c !== "object" || Array.isArray(c)) {
        return invalid(`tiers.${tierKey}.candidates[${i}] must be an object`)
      }
      const cand = c as Record<string, unknown>
      if (!isValidTierToken(cand.cli)) {
        return invalid(`tiers.${tierKey}.candidates[${i}].cli is missing or contains an unreplaced placeholder`)
      }
      if (!isValidTierToken(cand.model)) {
        return invalid(`tiers.${tierKey}.candidates[${i}].model is missing or contains an unreplaced placeholder`)
      }
      if (cand.effort !== undefined && !isValidTierToken(cand.effort)) {
        return invalid(`tiers.${tierKey}.candidates[${i}].effort is invalid or contains an unreplaced placeholder`)
      }
      if (cand.family !== undefined && !isValidTierToken(cand.family)) {
        return invalid(`tiers.${tierKey}.candidates[${i}].family is invalid or contains an unreplaced placeholder`)
      }
      if (cand.argv !== undefined) {
        if (!Array.isArray(cand.argv) || cand.argv.length === 0 || !cand.argv.every(isValidTierToken)) {
          return invalid(`tiers.${tierKey}.candidates[${i}].argv is invalid`)
        }
      }
      if (cand.command_template !== undefined) {
        if (
          typeof cand.command_template !== "string" ||
          !cand.command_template.trim() ||
          PLACEHOLDER_RE.test(cand.command_template)
        ) {
          return invalid(`tiers.${tierKey}.candidates[${i}].command_template is invalid`)
        }
      }
      if (!clis.includes(cand.cli)) {
        clis.push(cand.cli)
      }
    }
    const purpose = typeof tierRecord.purpose === "string" && tierRecord.purpose.trim() ? tierRecord.purpose.trim() : undefined
    summaries.push({
      tier: tierKey,
      ...(purpose ? { purpose } : {}),
      candidateCount: candidates.length,
      clis,
    })
  }

  let workerSteps: string[] = []
  if (doc.worker_steps && typeof doc.worker_steps === "object" && !Array.isArray(doc.worker_steps)) {
    workerSteps = Object.keys(doc.worker_steps as Record<string, unknown>)
  }

  return {
    status: "configured",
    path: relPath,
    examplePath: exampleRelPath,
    exampleExists,
    priority,
    workerSteps,
    tiers: summaries,
  }
}

function inspectReviewModels(root: string): WorkspaceReviewModelsStatus {
  const deployConfigRel = ".claude/deploy/config.json" as const
  const reviewConfigRel = "naia-settings/review.json" as const
  const deployConfigPath = path.join(root, deployConfigRel)
  const reviewConfigPath = path.join(root, reviewConfigRel)

  const deployConfigExists = fs.existsSync(deployConfigPath)
  const overrides: ReviewModelOverrideItem[] = []

  if (deployConfigExists) {
    try {
      const parsed = JSON.parse(fs.readFileSync(deployConfigPath, "utf-8"))
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const rm = (parsed as Record<string, unknown>).review_models
        if (rm && typeof rm === "object" && !Array.isArray(rm)) {
          for (const [key, val] of Object.entries(rm as Record<string, unknown>)) {
            if (key === "_comment" || !isSafeNonSecretIdentifier(key)) continue
            if (!val || typeof val !== "object" || Array.isArray(val)) continue
            const entry = val as Record<string, unknown>
            const runner = isSafeNonSecretIdentifier(entry.runner) ? entry.runner : null
            const effort = isSafeNonSecretIdentifier(entry.effort) ? entry.effort : null
            overrides.push({ key, runner, effort })
          }
        }
      }
    } catch {
      // Read-only inspector tolerates malformed files without throwing
    }
  }

  const reviewConfigExists = fs.existsSync(reviewConfigPath)
  const reviewerSlots: string[] = []
  if (reviewConfigExists) {
    try {
      const parsed = JSON.parse(fs.readFileSync(reviewConfigPath, "utf-8"))
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const reviewers = (parsed as Record<string, unknown>).reviewers
        if (Array.isArray(reviewers)) {
          for (const item of reviewers) {
            if (typeof item === "string" && isSafeNonSecretIdentifier(item)) {
              reviewerSlots.push(item)
            } else if (item && typeof item === "object" && !Array.isArray(item)) {
              const id = (item as Record<string, unknown>).id
              if (isSafeNonSecretIdentifier(id)) {
                reviewerSlots.push(id)
              }
            }
          }
        }
      }
    } catch {
      // Ignore parse errors in optional review.json
    }
  }

  return {
    readOnly: true,
    approvalGate: "CFG-",
    supportedRunners: ["agy", "muse", "codex", "claude"],
    deployConfigPath: deployConfigRel,
    deployConfigExists,
    overrideCount: overrides.length,
    overrides,
    reviewConfigPath: reviewConfigRel,
    reviewConfigExists,
    reviewerSlots,
    reviewerCount: reviewerSlots.length,
  }
}

function inspectLLMSettings(root: string, opts?: InspectWorkspaceSettingsOptions): WorkspaceLLMStatus {
  const yamlRel = ".agents/context/llm-config.yaml" as const
  const jsonRel = "naia-settings/llm.json" as const
  const yamlAbs = path.join(root, yamlRel)
  const jsonAbs = path.join(root, jsonRel)

  const yamlExists = fs.existsSync(yamlAbs)
  const jsonExists = fs.existsSync(jsonAbs)
  const env = opts?.env ?? process.env
  const gatewayUrlConfigured = Boolean(typeof env.GATEWAY_URL === "string" && env.GATEWAY_URL.trim().length > 0)

  let defaultProvider: string | null = null
  const yamlConfiguredProviders = new Set<string>()

  if (yamlExists) {
    try {
      const parsed = YAML.parse(fs.readFileSync(yamlAbs, "utf-8"))
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const doc = parsed as Record<string, unknown>
        if (isSafeNonSecretIdentifier(doc.defaultProvider)) {
          defaultProvider = doc.defaultProvider
        }
        if (doc.providers && typeof doc.providers === "object" && !Array.isArray(doc.providers)) {
          for (const [provKey, provVal] of Object.entries(doc.providers as Record<string, unknown>)) {
            if (isSafeNonSecretIdentifier(provKey) && provVal && typeof provVal === "object") {
              yamlConfiguredProviders.add(provKey.toLowerCase())
            }
          }
        }
      }
    } catch {
      // Ignore malformed YAML
    }
  }

  const roleNames: Array<"main" | "sub" | "embedded"> = ["main", "sub", "embedded"]
  const roleSlots: WorkspaceLLMRoleSlotStatus[] = []
  const jsonConfiguredProviders = new Set<string>()

  if (jsonExists) {
    try {
      const parsed = JSON.parse(fs.readFileSync(jsonAbs, "utf-8"))
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const doc = parsed as Record<string, unknown>
        for (const role of roleNames) {
          const slot = doc[role]
          if (slot && typeof slot === "object" && !Array.isArray(slot)) {
            const rawProv = (slot as Record<string, unknown>).provider
            const provider = isSafeNonSecretIdentifier(rawProv) ? rawProv : null
            if (provider) jsonConfiguredProviders.add(provider.toLowerCase())
            roleSlots.push({ role, configured: true, provider })
          } else {
            roleSlots.push({ role, configured: false, provider: null })
          }
        }
        if (doc.providers && typeof doc.providers === "object" && !Array.isArray(doc.providers)) {
          for (const [provKey, provVal] of Object.entries(doc.providers as Record<string, unknown>)) {
            if (isSafeNonSecretIdentifier(provKey) && provVal && typeof provVal === "object") {
              jsonConfiguredProviders.add(provKey.toLowerCase())
            }
          }
        }
      }
    } catch {
      // Ignore malformed JSON
    }
  }

  if (roleSlots.length === 0) {
    for (const role of roleNames) {
      roleSlots.push({ role, configured: false, provider: null })
    }
  }

  const slotDefs: Array<{ id: LLMProviderSlotId; name: string; note: string }> = [
    {
      id: "naia",
      name: "Naia Account",
      note: "Workspace gateway provider slot (configured via .agents/context/llm-config.yaml)",
    },
    {
      id: "any-llm",
      name: "Any-LLM Gateway",
      note: "Unified proxy gateway slot (GATEWAY_URL or .agents/context/llm-config.yaml)",
    },
    {
      id: "openai",
      name: "OpenAI",
      note: "Direct provider slot (model-agnostic; bind via llm-config.yaml or tier-profile.json)",
    },
    {
      id: "anthropic",
      name: "Anthropic",
      note: "Direct provider slot (model-agnostic; bind via llm-config.yaml or tier-profile.json)",
    },
    {
      id: "google",
      name: "Google",
      note: "Direct provider slot (model-agnostic; bind via llm-config.yaml or tier-profile.json)",
    },
  ]

  const providers: WorkspaceLLMProviderStatus[] = slotDefs.map((slot) => {
    const inYaml = yamlConfiguredProviders.has(slot.id)
    const inJson = jsonConfiguredProviders.has(slot.id)
    const viaEnv = slot.id === "any-llm" && gatewayUrlConfigured
    const configured = inYaml || inJson || viaEnv
    const source = inYaml
      ? yamlRel
      : inJson
        ? jsonRel
        : viaEnv
          ? "GATEWAY_URL"
          : undefined
    return {
      id: slot.id,
      name: slot.name,
      configured,
      ...(source ? { source } : {}),
      note: slot.note,
    }
  })

  return {
    yamlPath: yamlRel,
    yamlExists,
    jsonPath: jsonRel,
    jsonExists,
    defaultProvider,
    gatewayUrlConfigured,
    roleSlots,
    providers,
  }
}

function inspectConfigFiles(root: string): WorkspaceConfigFileItem[] {
  const items: WorkspaceConfigFileItem[] = []
  const seen = new Set<string>()

  const contextDir = path.join(root, ".agents", "context")
  try {
    const entries = fs.readdirSync(contextDir).sort((a, b) => a.localeCompare(b))
    for (const entry of entries) {
      if (entry === ".DS_Store") continue
      const rel = `.agents/context/${entry}`
      seen.add(rel)
      items.push({ name: entry, path: rel, exists: true })
    }
  } catch {
    // .agents/context may not exist in minimal test fixtures
  }

  const keyFiles: Array<{ name: string; path: string }> = [
    { name: "tier-profile.json", path: "config/tier-profile.json" },
    { name: "tier-profile.example.json", path: "config/tier-profile.example.json" },
    { name: "llm.json", path: "naia-settings/llm.json" },
    { name: "review.json", path: "naia-settings/review.json" },
    { name: "AGENTS.md", path: "AGENTS.md" },
    { name: ".gitignore", path: ".gitignore" },
    { name: ".gitmodules", path: ".gitmodules" },
    { name: "README.md", path: "README.md" },
  ]

  for (const kf of keyFiles) {
    if (seen.has(kf.path)) continue
    seen.add(kf.path)
    items.push({
      name: kf.name,
      path: kf.path,
      exists: fs.existsSync(path.join(root, kf.path)),
    })
  }

  return items
}

export function resolveAdkWorkspaceRoot(startDir: string): string {
  let dir = startDir
  for (let i = 0; i < 10; i++) {
    const agentsMd = path.join(dir, "AGENTS.md")
    const claudeMd = path.join(dir, "CLAUDE.md")
    const rulesJson = path.join(dir, ".agents", "context", "agents-rules.json")
    if ((fs.existsSync(agentsMd) || fs.existsSync(claudeMd)) && fs.existsSync(rulesJson)) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return startDir
}

export function inspectWorkspaceSettings(
  root: string,
  opts?: InspectWorkspaceSettingsOptions,
): WorkspaceSettingsSnapshot {
  return {
    runners: inspectRunners(root, opts),
    tierProfile: inspectTierProfile(root),
    reviewModels: inspectReviewModels(root),
    llm: inspectLLMSettings(root, opts),
    configFiles: inspectConfigFiles(root),
  }
}
