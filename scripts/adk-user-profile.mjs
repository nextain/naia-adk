#!/usr/bin/env node
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

const BEGIN = "<!-- naia-adk claude-user-profile: begin -->"
const END = "<!-- naia-adk claude-user-profile: end -->"
const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

export function parseArgs(raw) {
  const args = { mode: raw[0], home: os.homedir(), adkRoot: scriptRoot }
  for (let i = 1; i < raw.length; i++) {
    if (raw[i] === "--home") args.home = raw[++i]
    else if (raw[i] === "--adk-root") args.adkRoot = raw[++i]
    else throw new Error(`unknown argument: ${raw[i]}`)
  }
  if (!["apply", "check"].includes(args.mode)) throw new Error("usage: adk-user-profile.mjs apply|check [--home <dir>] [--adk-root <dir>]")
  args.home = path.resolve(args.home)
  args.adkRoot = path.resolve(args.adkRoot)
  return args
}

export function loadProfile(adkRoot) {
  const dir = path.join(adkRoot, "templates", "claude-user-profile")
  const text = fs.readFileSync(path.join(dir, "settings.json"), "utf8").replaceAll("{{ADK_ROOT}}", adkRoot.replace(/\\/g, "/"))
  return { settings: JSON.parse(text), rule: fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8").trim() }
}

const commandsOf = (groups) => (groups ?? []).flatMap((g) => (g.hooks ?? []).map((h) => h.command))

export function mergeSettings(current, profile) {
  const next = structuredClone(current ?? {})
  next.env = { ...(next.env ?? {}), ...profile.env }
  next.hooks = next.hooks ?? {}
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
  const profile = loadProfile(args.adkRoot)
  const settingsFile = path.join(args.home, ".claude", "settings.json")
  const ruleFile = path.join(args.home, ".claude", "CLAUDE.md")
  const currentSettings = readOptional(settingsFile)
  const nextSettings = `${JSON.stringify(mergeSettings(currentSettings ? JSON.parse(currentSettings) : {}, profile.settings), null, 2)}\n`
  const nextRule = mergeRule(readOptional(ruleFile), profile.rule)
  const drift = []
  if (currentSettings === null || JSON.stringify(JSON.parse(currentSettings)) !== JSON.stringify(JSON.parse(nextSettings))) drift.push(settingsFile)
  if (readOptional(ruleFile) !== nextRule) drift.push(ruleFile)
  if (args.mode === "check") return { drift }
  const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 15)
  const changed = []
  if (drift.includes(settingsFile) && writeWithBackup(settingsFile, nextSettings, stamp)) changed.push(settingsFile)
  if (drift.includes(ruleFile) && writeWithBackup(ruleFile, nextRule, stamp)) changed.push(ruleFile)
  return { drift, changed }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2))
    const result = run(args)
    if (args.mode === "check") {
      for (const f of result.drift) console.log(`drift: ${f}`)
      process.exit(result.drift.length ? 1 : 0)
    }
    for (const f of result.changed) console.log(`updated: ${f}`)
    if (!result.changed.length) console.log("already up to date")
  } catch (e) {
    console.error(e.message)
    process.exit(2)
  }
}
