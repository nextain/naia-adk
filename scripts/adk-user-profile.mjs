#!/usr/bin/env node
import { isMain } from './lib/is-main.mjs';
// Apply the shared Claude user profile (templates/claude-user-profile) to a user's
// ~/.claude: env keys, absolute-path hooks for role sessions, and the compaction
// summary rule block in ~/.claude/CLAUDE.md. Idempotent; existing settings are kept.
//
//   node scripts/adk-user-profile.mjs apply [--home <dir>] [--adk-root <dir>]
//   node scripts/adk-user-profile.mjs check [--home <dir>] [--adk-root <dir>]   # exit 1 if drifted
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"

const BEGIN = "<!-- naia-adk claude-user-profile: begin -->"
const END = "<!-- naia-adk claude-user-profile: end -->"
const HOOK = ".claude/hooks/role-compact-brief.js"
const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(import.meta.url)

export function parseArgs(raw) {
  const args = { mode: raw[0], home: os.homedir(), adkRoot: scriptRoot, instanceRoot: null }
  for (let i = 1; i < raw.length; i++) {
    if (raw[i] === "--home") args.home = raw[++i]
    else if (raw[i] === "--adk-root") args.adkRoot = raw[++i]
    else if (raw[i] === "--instance-root") args.instanceRoot = raw[++i]
    else throw new Error(`unknown argument: ${raw[i]}`)
  }
  if (!["apply", "check"].includes(args.mode)) throw new Error("usage: adk-user-profile.mjs apply|check [--home <dir>] [--adk-root <dir>] [--instance-root <dir>]")
  args.home = path.resolve(args.home)
  args.adkRoot = path.resolve(args.adkRoot)
  // Hook code runs from the ADK root; hooks read instance settings (deploy, gcs, identity) from NAIA_ADK_ROOT.
  args.instanceRoot = path.resolve(args.instanceRoot ?? args.adkRoot)
  if (!fs.existsSync(path.join(args.instanceRoot, ".claude"))) throw new Error(`missing instance .claude: ${args.instanceRoot}`)
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
export const PROFILE_HOOKS = ["role-compact-brief.js", "destructive-git-guard.js", "catastrophic-delete-guard.js", "git-push-guard.js", "email-send-guard.js", "commit-guard.js", "deploy-guard.js", "remote-identity-gate.js", "gcs-guard.js", "prod-gateway-guard.js", "subagent-spawn-guard.js", "cost-guard.cjs", "guard-runpod-create.cjs", "subagent-model-guard.cjs"]
const ownHook = (command) => typeof command === "string" && PROFILE_HOOKS.some((name) => command.includes(name))
export function validateProfileHooks(settings) {
  const names = new Set(Object.values(settings.hooks ?? {}).flatMap(commandsOf).map((command) => {
    const match = command.match(/"([^"\n]+\.(?:js|cjs))"/)
    if (!match) throw new Error("profile hook command must name an absolute script")
    return path.basename(match[1])
  }))
  if (names.size !== PROFILE_HOOKS.length || PROFILE_HOOKS.some((name) => !names.has(name))) throw new Error("PROFILE_HOOKS and settings.json disagree")
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
function withoutOwnHooks(hooks) {
  const out = {}
  for (const [event, groups] of Object.entries(hooks ?? {})) {
    const kept = (groups ?? [])
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !ownHook(h.command)) }))
      .filter((g) => g.hooks.length)
    if (kept.length) out[event] = kept
  }
  return out
}

export function mergeSettings(current, profile) {
  const next = structuredClone(current ?? {})
  next.env = { ...(next.env ?? {}), ...profile.env }
  // Reconcile the event and matcher as well as the executable path.
  next.hooks = withoutOwnHooks(next.hooks)
  for (const [event, groups] of Object.entries(profile.hooks ?? {})) {
    const have = new Set(commandsOf(next.hooks[event]))
    const missing = groups.filter((g) => commandsOf([g]).some((c) => !have.has(c)))
    if (missing.length) next.hooks[event] = [...(next.hooks[event] ?? []), ...missing]
  }
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

function writeWithBackup(file, text, stamp) {
  const old = readOptional(file)
  if (old === text) return false
  if (old !== null) fs.copyFileSync(file, `${file}.bak-${stamp}`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text, { mode: 0o600 })
  fs.renameSync(tmp, file)
  return true
}

export function run(args, now = new Date()) {
  const profile = loadProfile(args.adkRoot, args.home, args.instanceRoot ?? args.adkRoot)
  const settingsFile = path.join(args.home, ".claude", "settings.json")
  const ruleFile = path.join(args.home, ".claude", "CLAUDE.md")
  const currentSettings = readOptional(settingsFile)
  const current = currentSettings ? JSON.parse(currentSettings) : {}
  const overridden = Object.keys(profile.settings.env ?? {}).filter((key) => Object.hasOwn(current.env ?? {}, key) && current.env[key] !== profile.settings.env[key]).map((key) => `env.${key}`)
  const nextSettings = `${JSON.stringify(mergeSettings(current, profile.settings), null, 2)}\n`
  let nextRule
  try { nextRule = mergeRule(readOptional(ruleFile), profile.rule) } catch (e) {
    if (args.mode === "check") return { drift: [ruleFile], error: e.message }
    throw e
  }
  const drift = []
  const missingPolicies = []
  for (const [example, target] of POLICIES) {
    const file = path.join(args.home, ".claude", target)
    const content = readOptional(file)
    if (content === null) {
      drift.push(file)
      missingPolicies.push([file, fs.readFileSync(path.join(args.adkRoot, "templates/claude-user-profile", example), "utf8")])
    } else if (policyKeys(example, file, content, args.adkRoot).length) drift.push(file)
  }
  if (currentSettings === null || JSON.stringify(JSON.parse(currentSettings)) !== JSON.stringify(JSON.parse(nextSettings))) drift.push(settingsFile)
  if (readOptional(ruleFile) !== nextRule) drift.push(ruleFile)
  if (args.mode === "check") {
    if (!fs.existsSync(process.execPath)) drift.push(process.execPath)
    const errors = POLICIES.flatMap(([example, target]) => {
      const file = path.join(args.home, ".claude", target)
      const content = readOptional(file)
      return content === null ? [`policy required: ${file}; keys: policy`] : policyKeys(example, file, content, args.adkRoot).map(key => `policy required: ${file}; keys: ${key}`)
    })
    return { drift, ...(errors.length ? { error: errors.join("\n") } : {}) }
  }
  const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 15)
  const changed = []
  for (const [file, content] of missingPolicies) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    try {
      fs.writeFileSync(file, content, { mode: 0o600, flag: "wx" })
      changed.push(file)
    } catch (error) { if (error.code !== "EEXIST") throw error }
  }
  const policyErrors = POLICIES.flatMap(([example, target]) => {
    const file = path.join(args.home, ".claude", target)
    const keys = policyKeys(example, file, readOptional(file), args.adkRoot)
    return keys.length ? [`policy required: ${file}; keys: ${keys.join(", ")}`] : []
  })
  if (policyErrors.length) throw new Error(policyErrors.join("\n"))
  if (drift.includes(settingsFile) && writeWithBackup(settingsFile, nextSettings, stamp)) changed.push(settingsFile)
  if (drift.includes(ruleFile) && writeWithBackup(ruleFile, nextRule, stamp)) changed.push(ruleFile)
  return { drift, changed, overridden }
}

if (isMain(import.meta.url)) {
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
    if (!result.changed.length) console.log("already up to date")
  } catch (e) {
    console.error(e.message)
    process.exit(2)
  }
}
