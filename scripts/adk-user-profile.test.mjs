import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { mergeRule, mergeSettings, run } from "./adk-user-profile.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "adk-user-profile-"))
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"))

test("apply adds env, absolute hooks and the rule block, keeping existing settings", () => {
  const home = tmpHome()
  fs.mkdirSync(path.join(home, ".claude"))
  const existing = { model: "opus", env: { KEEP: "1" }, hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "gate" }] }] } }
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify(existing))
  fs.writeFileSync(path.join(home, ".claude", "CLAUDE.md"), "# mine\n")
  const result = run({ mode: "apply", home, adkRoot: root }, new Date("2026-11-05T06:00:00Z"))
  assert.equal(result.changed.length, 2)
  const s = read(path.join(home, ".claude", "settings.json"))
  assert.equal(s.model, "opus")
  assert.equal(s.env.KEEP, "1")
  assert.equal(s.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "200000")
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, "gate")
  assert.match(s.hooks.PostCompact[0].hooks[0].command, new RegExp(`${root}/\\.claude/hooks/role-compact-brief\\.js`))
  const rule = fs.readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf8")
  assert.ok(rule.startsWith("# mine\n"))
  assert.match(rule, /naia-adk claude-user-profile: begin/)
  assert.ok(fs.existsSync(path.join(home, ".claude", "settings.json.bak-20261105T060000")))
})

test("apply twice is a no-op and check then reports no drift", () => {
  const home = tmpHome()
  run({ mode: "apply", home, adkRoot: root })
  const again = run({ mode: "apply", home, adkRoot: root })
  assert.deepEqual(again.changed, [])
  assert.deepEqual(run({ mode: "check", home, adkRoot: root }).drift, [])
})

test("check reports drift when a profile env value is changed", () => {
  const home = tmpHome()
  run({ mode: "apply", home, adkRoot: root })
  const f = path.join(home, ".claude", "settings.json")
  const s = read(f)
  s.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = "1000000"
  fs.writeFileSync(f, JSON.stringify(s))
  assert.deepEqual(run({ mode: "check", home, adkRoot: root }).drift, [f])
})

test("mergeRule replaces only the marked block", () => {
  const once = mergeRule("a\n", "rule v1")
  const twice = mergeRule(`${once}tail\n`, "rule v2")
  assert.match(twice, /rule v2/)
  assert.doesNotMatch(twice, /rule v1/)
  assert.ok(twice.startsWith("a\n") && twice.endsWith("tail\n"))
})

test("mergeSettings does not duplicate a hook already present", () => {
  const profile = { env: {}, hooks: { PostCompact: [{ hooks: [{ type: "command", command: "x" }] }] } }
  const merged = mergeSettings(mergeSettings({}, profile), profile)
  assert.equal(merged.hooks.PostCompact.length, 1)
})

test("role-compact-brief lists only existing absolute paths from .naia-role.json", () => {
  const cwd = tmpHome()
  const mission = path.join(cwd, "mission.md")
  fs.writeFileSync(mission, "secret text")
  fs.writeFileSync(path.join(cwd, ".naia-role.json"), JSON.stringify({ role: "dev", read: [mission, "/no/such/file", "relative.md"] }))
  const out = JSON.parse(execFileSync("node", [path.join(root, ".claude/hooks/role-compact-brief.js"), "PostCompact"], { input: JSON.stringify({ cwd }) }).toString())
  assert.match(out.additionalContext, /역할: dev/)
  assert.ok(out.additionalContext.includes(mission))
  assert.doesNotMatch(out.additionalContext, /no\/such|relative\.md|secret text/)
  const start = JSON.parse(execFileSync("node", [path.join(root, ".claude/hooks/role-compact-brief.js"), "SessionStart"], { input: JSON.stringify({ cwd }) }).toString())
  assert.equal(start.hookSpecificOutput.hookEventName, "SessionStart")
})

test("role-compact-brief is silent without a role file", () => {
  const cwd = tmpHome()
  const out = execFileSync("node", [path.join(root, ".claude/hooks/role-compact-brief.js"), "PostCompact"], { input: JSON.stringify({ cwd }) }).toString()
  assert.equal(out, "")
  const require = createRequire(import.meta.url)
  assert.equal(require(path.join(root, ".claude/hooks/role-compact-brief.js")).brief(cwd, "PostCompact"), null)
})
