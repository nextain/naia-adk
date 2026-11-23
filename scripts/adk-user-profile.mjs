#!/usr/bin/env node
// Apply the shared ADK user profile (templates/claude-user-profile and
// templates/muse-user-profile) to a user's ~/.claude and ~/.config/muse:
// env keys, absolute-path hooks for role sessions, and the compaction summary
// rule block in ~/.claude/CLAUDE.md. Idempotent; existing settings are kept.
//
//   node scripts/adk-user-profile.mjs apply [--home <dir>] [--adk-root <dir>] [--instance-root <dir>] [--target all|claude|codex|muse] [--registered-deploy-hooks <file> --registered-deploy-hooks-sha256 <hex>]
//   node scripts/adk-user-profile.mjs check [--home <dir>] [--adk-root <dir>] [--instance-root <dir>] [--target all|claude|codex|muse] [--registered-deploy-hooks <file> --registered-deploy-hooks-sha256 <hex>]
import fs from "node:fs"
import os from "node:os"
import { HANDOFF_CONTEXT_TOKENS, roleWorkspace } from "./work-ledger/role-handoff.mjs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { loadRegisteredDeployHooks, registeredHookSettings, registeredCodexHookSettings, validateRegisteredSettingsTarget, assertRegisteredInstallNotHeld, writeRegisteredHookPair } from "./lib/registered-deploy-hooks.mjs"

const BEGIN = "<!-- naia-adk claude-user-profile: begin -->"
const END = "<!-- naia-adk claude-user-profile: end -->"
const HOOK = ".claude/hooks/role-compact-brief.js"
const MUSE_ADAPTER = ".agents/hooks/muse-pretooluse-adapter.cjs"
const VALID_TARGETS = new Set(["all", "claude", "codex", "muse"])
const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(import.meta.url)

export function parseArgs(raw) {
  const args = { mode: raw[0], home: os.homedir(), homeExplicit: false, adkRoot: scriptRoot, instanceRoot: null, target: "all" }
  const descriptorFlags = {
    "--registered-deploy-hooks": "registeredDeployHooks",
    "--registered-deploy-hooks-sha256": "registeredDeployHooksSha256",
    "--previous-registered-deploy-hooks": "previousRegisteredDeployHooks",
    "--previous-registered-deploy-hooks-sha256": "previousRegisteredDeployHooksSha256",
    "--previous-registration-file": "previousRegistrationFile",
  }
  for (let i = 1; i < raw.length; i++) {
    if (raw[i] === "--home") { args.home = raw[++i]; args.homeExplicit = true }
    else if (raw[i] === "--adk-root") args.adkRoot = raw[++i]
    else if (raw[i] === "--instance-root") args.instanceRoot = raw[++i]
    else if (raw[i] === "--target") args.target = raw[++i]
    else if (Object.hasOwn(descriptorFlags, raw[i])) {
      const key = descriptorFlags[raw[i]]
      if (Object.hasOwn(args, key) || !raw[i + 1] || raw[i + 1].startsWith("--")) throw new Error("registered deploy descriptor: missing or duplicate argument")
      args[key] = raw[++i]
    }
    else if (raw[i] === "--muse-only") args.target = "muse"
    else if (raw[i] === "--claude-only") args.target = "claude"
    else throw new Error(`unknown argument: ${raw[i]}`)
  }
  if (!["apply", "check"].includes(args.mode) || !VALID_TARGETS.has(args.target)) {
    throw new Error("usage: adk-user-profile.mjs apply|check [--home <dir>] [--adk-root <dir>] [--instance-root <dir>] [--target all|claude|codex|muse] [--registered-deploy-hooks <file> --registered-deploy-hooks-sha256 <hex>]")
  }
  if (Object.hasOwn(args, "registeredDeployHooks") || Object.hasOwn(args, "registeredDeployHooksSha256")) {
    if (!args.registeredDeployHooks || !/^[a-f0-9]{64}$/.test(args.registeredDeployHooksSha256 ?? "") || !["claude", "codex"].includes(args.target)) throw new Error("registered deploy descriptor: paired file/SHA256 and explicit --target claude or codex required")
  }
  if (["previousRegisteredDeployHooks", "previousRegisteredDeployHooksSha256", "previousRegistrationFile"].some(key => Object.hasOwn(args, key)) && (!args.previousRegisteredDeployHooks || !/^[a-f0-9]{64}$/.test(args.previousRegisteredDeployHooksSha256 ?? "") || !args.previousRegistrationFile || !args.registeredDeployHooks || args.target !== "codex")) throw new Error("registered deploy descriptor: previous descriptor, SHA256 and registration backup require explicit native rotation")
  args.home = path.resolve(args.home)
  args.adkRoot = path.resolve(args.adkRoot)
  // Hook code runs from the ADK root; hooks read instance settings (deploy, gcs, identity) from NAIA_ADK_ROOT.
  args.instanceRoot = path.resolve(args.instanceRoot ?? args.adkRoot)
  if (args.target !== "codex" && !fs.existsSync(path.join(args.instanceRoot, ".claude"))) throw new Error(`missing instance .claude: ${args.instanceRoot}`)
  const xdgConfig = !args.homeExplicit && process.env.XDG_CONFIG_HOME
    ? path.resolve(process.env.XDG_CONFIG_HOME)
    : path.join(args.home, ".config")
  args.museSettingsFile = path.join(xdgConfig, "muse", "settings.json")
  const codexDir = (!args.homeExplicit && process.env.CODEX_HOME) || path.join(args.home, ".codex")
  args.codexHooksFile = path.resolve(codexDir, "hooks.json")
  return args
}

export function loadProfile(adkRoot, home = os.homedir(), instanceRoot = adkRoot) {
  const dir = path.join(adkRoot, "templates", "claude-user-profile")
  if (!fs.existsSync(path.join(adkRoot, HOOK))) throw new Error(`missing hook: ${path.join(adkRoot, HOOK)}`)
  const text = fs.readFileSync(path.join(dir, "settings.json"), "utf8").replaceAll("{{INSTANCE_ROOT}}", instanceRoot.replace(/\\/g, "/")).replaceAll("{{ADK_ROOT}}", adkRoot.replace(/\\/g, "/")).replaceAll("{{NODE}}", process.execPath.replace(/\\/g, "/")).replaceAll("{{USER_HOME}}", home.replace(/\\/g, "/"))
  const settings = JSON.parse(text)
  validateProfileHooks(settings)
  for (const groups of Object.values(settings.hooks ?? {})) for (const command of commandsOf(groups)) {
    const match = command.match(/"([^"]+\.(?:js|cjs))"/)
    if (match && !fs.existsSync(match[1])) throw new Error(`missing hook: ${match[1]}`)
  }
  return { settings, rule: fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8").trim() }
}

const commandsOf = (groups) => (groups ?? []).flatMap((g) => (g.hooks ?? []).map((h) => h.command))
export const PROFILE_HOOKS = ["role-compact-brief.js", "destructive-git-guard.js", "catastrophic-delete-guard.js", "git-push-guard.js", "email-send-guard.js", "commit-guard.js", "deploy-guard.js", "remote-identity-gate.js", "gcs-guard.js", "prod-gateway-guard.js", "subagent-spawn-guard.js", "lead-write-guard.js", "plan-review-write-guard.js", "cost-guard.cjs", "guard-runpod-create.cjs", "subagent-model-guard.cjs"]
export const MUSE_PROFILE_HOOKS = [...PROFILE_HOOKS]
const ownHook = (command) => typeof command === "string" && PROFILE_HOOKS.some((name) => command.includes(name))
const ownMuseHook = (command) => typeof command === "string" && command.includes("muse-pretooluse-adapter.cjs")
export function validateProfileHooks(settings) {
  const names = new Set(Object.values(settings.hooks ?? {}).flatMap(commandsOf).map((command) => {
    const match = command.match(/"([^"\n]+\.(?:js|cjs))"/)
    if (!match) throw new Error("profile hook command must name an absolute script")
    return path.basename(match[1])
  }))
  if (names.size !== PROFILE_HOOKS.length || PROFILE_HOOKS.some((name) => !names.has(name))) throw new Error("PROFILE_HOOKS and settings.json disagree")
}

export function validateMuseProfileHooks(settings) {
  const names = new Set()
  for (const group of settings.hooks?.PreToolUse ?? []) {
    if (group.matcher !== undefined) {
      throw new Error("muse profile PreToolUse groups must be catch-all (no enumerated matcher)")
    }
  }
  for (const command of Object.values(settings.hooks ?? {}).flatMap(commandsOf)) {
    const scripts = [...command.matchAll(/"([^"\n]+\.(?:js|cjs))"/g)].map((m) => m[1])
    if (!scripts.some((s) => path.basename(s) === "muse-pretooluse-adapter.cjs")) {
      throw new Error("muse profile hook command must invoke muse-pretooluse-adapter.cjs")
    }
    for (const s of scripts) {
      if (path.basename(s) !== "muse-pretooluse-adapter.cjs") names.add(path.basename(s))
    }
  }
  if (names.size !== MUSE_PROFILE_HOOKS.length || MUSE_PROFILE_HOOKS.some((name) => !names.has(name))) {
    throw new Error("MUSE_PROFILE_HOOKS and templates/muse-user-profile/settings.json disagree")
  }
}

export function loadMuseProfile(adkRoot, home = os.homedir(), instanceRoot = adkRoot) {
  const adapter = path.join(adkRoot, MUSE_ADAPTER)
  if (!fs.existsSync(adapter)) throw new Error(`missing hook: ${adapter}`)
  const file = path.join(adkRoot, "templates", "muse-user-profile", "settings.json")
  const text = fs.readFileSync(file, "utf8")
    .replaceAll("{{INSTANCE_ROOT}}", instanceRoot.replace(/\\/g, "/"))
    .replaceAll("{{ADK_ROOT}}", adkRoot.replace(/\\/g, "/"))
    .replaceAll("{{NODE}}", process.execPath.replace(/\\/g, "/"))
    .replaceAll("{{USER_HOME}}", home.replace(/\\/g, "/"))
  const settings = JSON.parse(text)
  validateMuseProfileHooks(settings)
  for (const groups of Object.values(settings.hooks ?? {})) {
    for (const command of commandsOf(groups)) {
      for (const m of command.matchAll(/"([^"\n]+\.(?:js|cjs))"/g)) {
        if (!fs.existsSync(m[1])) throw new Error(`missing hook: ${m[1]}`)
      }
    }
  }
  return { settings }
}

const POLICIES = [
  ["cost-guard.policy.example.json", "cost-guard/policy.json"],
  ["subagent-model.policy.example.json", "subagent-model-policy.json"],
]

function placeholderKeys(value, prefix = "") {
  if (typeof value === "string") return value.includes("{{") ? [prefix] : []
  if (!value || typeof value !== "object") return []
  return Object.entries(value).flatMap(([key, child]) => placeholderKeys(child, prefix ? `${prefix}.${key}` : key))
}

function policyKeys(example, file, content, adkRoot) {
  let value
  try { value = JSON.parse(content) } catch { return ["JSON"] }
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["policy"]
  const placeholders = placeholderKeys(value)
  if (placeholders.length) return placeholders
  const hookDir = path.join(adkRoot, "templates/claude-user-profile/hooks")
  if (example.startsWith("cost-guard")) {
    const { loadPolicy, DEFAULT_LIMITS } = require(path.join(hookDir, "cost-guard.cjs"))
    if (loadPolicy(file).status === "known") return []
    const keys = []
    if (typeof value.configDir !== "string" || !path.isAbsolute(value.configDir) || !fs.existsSync(value.configDir)) keys.push("configDir")
    if (typeof value.expectedEmail !== "string" || !value.expectedEmail.includes("@")) keys.push("expectedEmail")
    for (const [key, limit] of Object.entries({ ...DEFAULT_LIMITS, ...value.limits })) {
      if (!Number.isFinite(limit) || limit <= 0 || key === "quotaUtilization" && limit > 100 || ["responsesPerTurn", "responsesPerHour", "maxContextTokens", "processingTokensPerTenMinutes"].includes(key) && !Number.isSafeInteger(limit)) keys.push(`limits.${key}`)
    }
    if (value.quotaFreshSeconds !== undefined && (!Number.isFinite(value.quotaFreshSeconds) || value.quotaFreshSeconds <= 0 || value.quotaFreshSeconds > 180)) keys.push("quotaFreshSeconds")
    return keys.length ? keys : ["policy"]
  }
  const { readPolicy, normalizePolicy } = require(path.join(hookDir, "subagent-model-guard.cjs"))
  if (!readPolicy({ env: { NAIA_SUBAGENT_MODEL_POLICY: file } }).invalid) return []
  const keys = []
  if (!Array.isArray(value.allowedModels) || !value.allowedModels.length || value.allowedModels.some(model => typeof model !== "string" || !model.trim())) keys.push("allowedModels")
  for (const key of ["requireExplicitModel", "requireBrief"]) if (typeof value[key] !== "boolean") keys.push(key)
  if (typeof value.overrideFile !== "string" || normalizePolicy(value).overrideFile !== value.overrideFile) keys.push("overrideFile")
  if (!Number.isFinite(value.maxOverrideHours) || value.maxOverrideHours <= 0 || value.maxOverrideHours * 3_600_000 > 8.64e15) keys.push("maxOverrideHours")
  return keys.length ? keys : ["policy"]
}

// Drop every earlier profile hook (old ADK path, old PostCompact entry) so a
// re-apply replaces it instead of injecting twice.
function withoutOwnHooks(hooks, isOwn = ownHook) {
  const out = {}
  for (const [event, groups] of Object.entries(hooks ?? {})) {
    const kept = (groups ?? [])
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOwn(h.command)) }))
      .filter((g) => g.hooks.length)
    if (kept.length) out[event] = kept
  }
  return out
}

function mergeHookGroups(currentHooks, profileHooks, isOwn) {
  // Reconcile the event and matcher as well as the executable path.
  const next = withoutOwnHooks(currentHooks, isOwn)
  for (const [event, groups] of Object.entries(profileHooks ?? {})) {
    const have = new Set(commandsOf(next[event]))
    const missing = groups.filter((g) => commandsOf([g]).some((c) => !have.has(c)))
    if (missing.length) next[event] = [...(next[event] ?? []), ...missing]
  }
  return next
}

export function mergeSettings(current, profile) {
  const next = structuredClone(current ?? {})
  next.env = { ...(next.env ?? {}), ...profile.env }
  next.hooks = mergeHookGroups(next.hooks, profile.hooks, ownHook)
  return next
}

export function mergeMuseSettings(current, profile) {
  const next = structuredClone(current ?? {})
  if (next.schema_version === undefined) next.schema_version = profile.schema_version ?? 1
  next.hooks = mergeHookGroups(next.hooks, profile.hooks, ownMuseHook)
  return next
}

export function mergeRule(current, rule) {
  const block = `${BEGIN}\n${rule}\n${END}`
  const text = current ?? ""
  const start = text.indexOf(BEGIN)
  const end = text.indexOf(END)
  if ((start === -1) !== (end === -1) || (start !== -1 && end < start)) throw new Error("unmatched profile marker")
  const outside = start === -1 ? text : text.slice(0, start) + text.slice(start, end + END.length).replace(/[^\n]/g, "") + text.slice(end + END.length)
  const headings = new Set(rule.split("\n").filter((line) => /^#\s+/.test(line)).map((line) => line.trim().toLowerCase()))
  const duplicate = outside.split("\n").findIndex((line) => headings.has(line.trim().toLowerCase()))
  if (duplicate !== -1) throw new Error(`duplicate profile heading at line ${duplicate + 1}`)
  if (start !== -1 && end > start) return text.slice(0, start) + block + text.slice(end + END.length)
  return text ? `${text.replace(/\s*$/, "")}\n\n${block}\n` : `${block}\n`
}

const readOptional = (file) => { try { return fs.readFileSync(file, "utf8") } catch (e) { if (e.code === "ENOENT") return null; throw e } }

function writeWithBackup(file, text, stamp, preserveIdentity = false) {
  const old = readOptional(file)
  if (old === text) return false
  if (old !== null) fs.copyFileSync(file, `${file}.bak-${stamp}`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text, { mode: 0o600 })
  if (preserveIdentity && old !== null) {
    const stat = fs.statSync(file)
    fs.chownSync(tmp, stat.uid, stat.gid)
    fs.chmodSync(tmp, stat.mode & 0o777)
  }
  fs.renameSync(tmp, file)
  return true
}

export function run(args, now = new Date()) {
  const target = args.target ?? "all"
  if (!VALID_TARGETS.has(target)) throw new Error(`invalid target: ${target}`)
  const includesClaude = target === "all" || target === "claude"
  const includesMuse = target === "all" || target === "muse"
  const instanceRoot = args.instanceRoot ?? args.adkRoot
  const registered = loadRegisteredDeployHooks(args)
  if (includesClaude) assertRegisteredInstallNotHeld(args.home)
  else if (registered && target === "codex") assertRegisteredInstallNotHeld(args.home, "codex")
  const museSettingsFile = args.museSettingsFile ?? path.join(args.home, ".config", "muse", "settings.json")

  const drift = []
  const errors = []
  const changed = []
  let overridden = []
  let settingsFile, nextSettings, ruleFile, nextRule, projectFile, nextProject
  const missingPolicies = []

  if (includesClaude) {
    const profile = loadProfile(args.adkRoot, args.home, instanceRoot)
    settingsFile = path.join(args.home, ".claude", "settings.json")
    ruleFile = path.join(args.home, ".claude", "CLAUDE.md")
    const currentSettings = readOptional(settingsFile)
    let current = currentSettings ? JSON.parse(currentSettings) : {}
    projectFile = path.join(instanceRoot, ".claude/settings.json")
    let currentProject
    try { currentProject = readOptional(projectFile) } catch (error) {
      if (registered || error.code !== "EACCES") throw error
      currentProject = null
    }
    let project = {}
    try { project = JSON.parse(currentProject ?? "{}") } catch (error) { if (registered) throw error }
    const bound = registeredHookSettings(current, profile.settings, project, registered)
    current = bound.current
    profile.settings = bound.profile
    if (registered) {
      for (const file of [settingsFile, projectFile, ruleFile]) validateRegisteredSettingsTarget(file)
      nextProject = JSON.stringify(bound.project, null, 2) + "\n"
      if (currentProject === null || JSON.stringify(JSON.parse(currentProject)) !== JSON.stringify(bound.project)) drift.push(projectFile)
    }
    overridden = Object.keys(profile.settings.env ?? {}).filter((key) => Object.hasOwn(current.env ?? {}, key) && current.env[key] !== profile.settings.env[key]).map((key) => `env.${key}`)
    nextSettings = `${JSON.stringify(mergeSettings(current, profile.settings), null, 2)}\n`
    try { nextRule = mergeRule(readOptional(ruleFile), profile.rule) } catch (e) {
      if (args.mode === "check") return { drift: [ruleFile], error: e.message }
      throw e
    }
    for (const [example, targetRel] of POLICIES) {
      const file = path.join(args.home, ".claude", targetRel)
      const content = readOptional(file)
      if (content === null) {
        drift.push(file)
        missingPolicies.push([file, fs.readFileSync(path.join(args.adkRoot, "templates/claude-user-profile", example), "utf8")])
      } else if (policyKeys(example, file, content, args.adkRoot).length) drift.push(file)
    }
    if (currentSettings === null || JSON.stringify(JSON.parse(currentSettings)) !== JSON.stringify(JSON.parse(nextSettings))) drift.push(settingsFile)
    if (readOptional(ruleFile) !== nextRule) drift.push(ruleFile)
    if (args.mode === "check") {
      for (const [example, targetRel] of POLICIES) {
        const file = path.join(args.home, ".claude", targetRel)
        const content = readOptional(file)
        if (content === null) errors.push(`policy required: ${file}; keys: policy`)
        else errors.push(...policyKeys(example, file, content, args.adkRoot).map((key) => `policy required: ${file}; keys: ${key}`))
      }
    }
  }

  const installedRoles = target === "muse" ? [] : (JSON.parse(readOptional(path.join(instanceRoot, "config", "work-ledger.json")) ?? "{}").roles ?? [])
  const localMemorySettings = new Map()
  if (includesClaude) {
    for (const role of installedRoles.filter(entry => entry.handoff)) {
      const { session, workspace, nativeDir } = roleWorkspace(instanceRoot, role)
      const otherOwner = installedRoles.some(entry => entry !== role && entry.handoff &&
        (path.resolve(instanceRoot, entry.handoff.session_dir ?? entry.handoff.workspace) === session ||
         path.resolve(instanceRoot, entry.handoff.workspace) === workspace))
      if (otherOwner) throw new Error("Claude auto memory requires a distinct workspace and session for each role")
      const file = path.join(session, ".claude", "settings.local.json")
      for (const candidate of [path.dirname(file), file]) {
        const stat = fs.lstatSync(candidate, { throwIfNoEntry: false })
        if (stat?.isSymbolicLink()) throw new Error("Claude role settings must be inside the session directory")
      }
      const current = JSON.parse(readOptional(file) ?? "{}")
      const enabled = role.handoff.claude_auto_memory === true
      const desired = { ...current, autoMemoryEnabled: enabled }
      if (enabled) desired.autoMemoryDirectory = nativeDir
      else delete desired.autoMemoryDirectory
      if (JSON.stringify(current) !== JSON.stringify(desired)) {
        localMemorySettings.set(file, JSON.stringify(desired, null, 2) + "\n")
        drift.push(file)
      }
    }
  }
  let codexFile, nextCodex, codexProjectFile, nextCodexProject
  if (target === "codex" || target === "all") {
    if (registered && target === "codex") {
      codexFile = path.join(args.home, ".codex/hooks.json")
      codexProjectFile = path.join(instanceRoot, ".codex/hooks.json")
      for (const file of [codexFile, codexProjectFile]) validateRegisteredSettingsTarget(file)
      const oldUser = readOptional(codexFile), oldProject = readOptional(codexProjectFile)
      const pair = registeredCodexHookSettings(JSON.parse(oldUser ?? "{}"), JSON.parse(oldProject ?? "{}"), registered)
      nextCodex = JSON.stringify(pair.user, null, 2) + "\n"
      nextCodexProject = JSON.stringify(pair.project, null, 2) + "\n"
      if (oldUser === null || JSON.stringify(JSON.parse(oldUser)) !== JSON.stringify(pair.user)) drift.push(codexFile)
      if (oldProject === null || JSON.stringify(JSON.parse(oldProject)) !== JSON.stringify(pair.project)) drift.push(codexProjectFile)
    } else if (target === "codex" || installedRoles.some(role => role.handoff)) {
      const hookScript = path.join(args.adkRoot, "scripts/work-ledger/role-handoff.mjs")
      if (!fs.existsSync(hookScript)) throw new Error(`missing hook: ${hookScript}`)
      codexFile = args.codexHooksFile ?? path.join(args.home, ".codex", "hooks.json")
      const current = JSON.parse(readOptional(codexFile) ?? "{}")
      const argv = [process.execPath, hookScript, "--codex-hook", instanceRoot]
      const command = argv.map(arg => "'" + arg.replaceAll("'", "'\\''") + "'").join(" ")
      const commandWindows = "& " + argv.map(arg => "'" + arg.replaceAll("'", "''") + "'").join(" ")
      const hooks = { SessionStart: [{ hooks: [{ type: "command", command, commandWindows, additionalContextLimit: HANDOFF_CONTEXT_TOKENS, statusMessage: "Restoring the role work card and memory" }] }] }
      const instanceArg = command.slice(command.lastIndexOf(" '--codex-hook'"))
      const owned = existing => typeof existing === "string" && existing.replaceAll("\\", "/").includes("/scripts/work-ledger/role-handoff.mjs") && existing.endsWith(instanceArg)
      nextCodex = JSON.stringify({ ...current, hooks: mergeHookGroups(current.hooks, hooks, owned) }, null, 2) + "\n"
      if (JSON.stringify(current) !== JSON.stringify(JSON.parse(nextCodex))) drift.push(codexFile)
    }
  }
  let nextMuseSettings
  if (includesMuse) {
    const museProfile = loadMuseProfile(args.adkRoot, args.home, instanceRoot)
    const currentMuse = readOptional(museSettingsFile)
    const current = currentMuse ? JSON.parse(currentMuse) : {}
    nextMuseSettings = `${JSON.stringify(mergeMuseSettings(current, museProfile.settings), null, 2)}\n`
    if (currentMuse === null || JSON.stringify(JSON.parse(currentMuse)) !== JSON.stringify(JSON.parse(nextMuseSettings))) drift.push(museSettingsFile)
  }

  if (args.mode === "check") {
    if (!fs.existsSync(process.execPath)) drift.push(process.execPath)
    return { drift, ...(errors.length ? { error: errors.join("\n") } : {}) }
  }

  const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 15)
  if (includesClaude) {
    for (const [file, content] of missingPolicies) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      try {
        fs.writeFileSync(file, content, { mode: 0o600, flag: "wx" })
        changed.push(file)
      } catch (error) { if (error.code !== "EEXIST") throw error }
    }
    const policyErrors = POLICIES.flatMap(([example, targetRel]) => {
      const file = path.join(args.home, ".claude", targetRel)
      const keys = policyKeys(example, file, readOptional(file), args.adkRoot)
      return keys.length ? [`policy required: ${file}; keys: ${keys.join(", ")}`] : []
    })
    if (policyErrors.length) throw new Error(policyErrors.join("\n"))
    if (registered) {
      registered.verify()
      for (const file of [settingsFile, projectFile, ruleFile]) validateRegisteredSettingsTarget(file)
    }
    if (registered) changed.push(...writeRegisteredHookPair(args.home, settingsFile, nextSettings, projectFile, nextProject, stamp))
    else if (drift.includes(settingsFile) && writeWithBackup(settingsFile, nextSettings, stamp)) changed.push(settingsFile)
    if (drift.includes(ruleFile) && writeWithBackup(ruleFile, nextRule, stamp, Boolean(registered))) changed.push(ruleFile)
  }
  for (const [file, content] of localMemorySettings) if (writeWithBackup(file, content, stamp)) changed.push(file)
  if (registered && target === "codex") {
    registered.verify()
    changed.push(...writeRegisteredHookPair(args.home, codexFile, nextCodex, codexProjectFile, nextCodexProject, stamp, "codex"))
  } else if (codexFile && drift.includes(codexFile) && writeWithBackup(codexFile, nextCodex, stamp)) changed.push(codexFile)
  if (includesMuse && drift.includes(museSettingsFile) && writeWithBackup(museSettingsFile, nextMuseSettings, stamp)) {
    changed.push(museSettingsFile)
  }
  return { drift, changed, overridden }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2))
    const result = run(args)
    if (args.mode === "check") {
      if (result.error) console.log(result.error)
      for (const f of result.drift) console.log(`drift: ${f}`)
      process.exit(result.drift.length ? 1 : 0)
    }
    for (const key of result.overridden) console.log(`overridden: ${key}`)
    for (const f of result.changed) console.log(`updated: ${f}`)
    if (result.changed.includes(args.codexHooksFile)) console.log(args.registeredDeployHooks ? "Review both exact registered deploy definitions in Codex /hooks before native execution." : "Review this ADK SessionStart hook in Codex /hooks. The CLI skips a new or changed user hook until its exact definition is trusted.")
    if (!result.changed.length) console.log("already up to date")
  } catch (e) {
    console.error(e.message)
    process.exit(2)
  }
}
