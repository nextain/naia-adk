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
const tmpHome = () => { const base = path.join(path.dirname(root), "tmp-codex-profile"); fs.mkdirSync(base, { recursive: true }); return fs.mkdtempSync(path.join(base, "adk-user-profile-")) }
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
  assert.match(s.hooks.SessionStart[0].hooks[0].command, new RegExp(`${root}/\\.claude/hooks/role-compact-brief\\.js`))
  assert.equal(s.hooks.PostCompact, undefined)
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

test("re-apply replaces a profile hook left at an old ADK path or on PostCompact", () => {
  const home = tmpHome()
  fs.mkdirSync(path.join(home, ".claude"))
  const old = 'node "/old/adk/.claude/hooks/role-compact-brief.js" SessionStart'
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: old }, { type: "command", command: "mine" }] }],
    PostCompact: [{ hooks: [{ type: "command", command: 'node "/old/adk/.claude/hooks/role-compact-brief.js" PostCompact' }] }],
  } }))
  run({ mode: "apply", home, adkRoot: root })
  const s = read(path.join(home, ".claude", "settings.json"))
  const commands = s.hooks.SessionStart.flatMap((g) => g.hooks.map((h) => h.command))
  assert.deepEqual(commands.filter((c) => c.includes("role-compact-brief")), [`"${process.execPath}" "${root}/.claude/hooks/role-compact-brief.js"`])
  assert.ok(commands.includes("mine"))
  assert.equal(s.hooks.PostCompact, undefined)
})

test("apply refuses an ADK root without the hook file", () => {
  const fake = tmpHome()
  fs.cpSync(path.join(root, "templates"), path.join(fake, "templates"), { recursive: true })
  assert.throws(() => run({ mode: "check", home: tmpHome(), adkRoot: fake }), /missing hook/)
})

test("role-compact-brief lists only existing absolute paths from .naia-role.json", () => {
  const cwd = tmpHome()
  const mission = path.join(cwd, "mission.md")
  fs.writeFileSync(mission, "secret text")
  fs.writeFileSync(path.join(cwd, ".naia-role.json"), JSON.stringify({ role: "dev", read: [mission, "/no/such/file", "relative.md"] }))
  const hook = (input) => JSON.parse(execFileSync("node", [path.join(root, ".claude/hooks/role-compact-brief.js")], { input: JSON.stringify(input) }).toString()).hookSpecificOutput
  const compact = hook({ cwd, source: "compact" })
  assert.equal(compact.hookEventName, "SessionStart")
  assert.match(compact.additionalContext, /압축됐습니다/)
  assert.match(compact.additionalContext, /역할: dev/)
  assert.ok(compact.additionalContext.includes(mission))
  assert.match(compact.additionalContext, /없는 경로: \/no\/such\/file/)
  assert.match(compact.additionalContext, /없는 경로: relative\.md/)
  assert.doesNotMatch(compact.additionalContext, /secret text/)
  assert.match(hook({ cwd, source: "startup" }).additionalContext, /세션 시작/)
})

test("role-compact-brief warns without a role file and includes mandatory reads", () => {
  const cwd = tmpHome()
  const out = execFileSync("node", [path.join(root, ".claude/hooks/role-compact-brief.js")], { input: JSON.stringify({ cwd, source: "compact" }) }).toString()
  assert.match(out, /역할 미션 파일 없음/)
  const require = createRequire(import.meta.url)
  const hook = require(path.join(root, ".claude/hooks/role-compact-brief.js"))
  const entry = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8").split("## Mandatory Reads")[1].split("When planning")[0]
  for (const item of hook.MANDATORY) { assert.ok(entry.includes(item)); assert.ok(out.includes(item)) }
  const declared = [...entry.matchAll(/`(\.agents\/context\/[^`]+)`/g)].map((m) => m[1])
  assert.deepEqual(hook.MANDATORY, declared)
})

test("duplicate headings and incomplete markers refuse writes and report check drift", () => {
  const home = tmpHome()
  fs.mkdirSync(path.join(home, ".claude"))
  const file = path.join(home, ".claude", "CLAUDE.md")
  for (const [content, error] of [["# Compact instructions\nmanual\n", /line 1/], ["<!-- naia-adk claude-user-profile: begin -->\nkeep", /unmatched/]]) {
    fs.writeFileSync(file, content)
    assert.throws(() => run({ mode: "apply", home, adkRoot: root }), error)
    assert.match(run({ mode: "check", home, adkRoot: root }).error, error)
    assert.equal(fs.readFileSync(file, "utf8"), content)
  }
})

test("overridden environment keys are reported without values", () => {
  const home = tmpHome()
  fs.mkdirSync(path.join(home, ".claude"))
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({env: {CLAUDE_CODE_AUTO_COMPACT_WINDOW: "old"}}))
  assert.deepEqual(run({ mode: "apply", home, adkRoot: root }).overridden, ["env.CLAUDE_CODE_AUTO_COMPACT_WINDOW"])
})

test("stateless safety hooks block dangerous input in a role directory", () => {
  const cwd = tmpHome()
  const cases = [["destructive-git-guard.js", "git reset --hard"], ["catastrophic-delete-guard.js", "rm -rf /"], ["git-push-guard.js", "git push --force"], ["email-send-guard.js", "node send.js send --to example"]]
  for (const [name, command] of cases) {
    const invoke = (cmd) => execFileSync(process.execPath, [path.join(root, ".claude/hooks", name)], { cwd, env: {...process.env, CLAUDE_PROJECT_DIR: cwd}, input: JSON.stringify({tool_name: "Bash", cwd, tool_input: {command: cmd}}) }).toString()
    assert.match(invoke(command), /"block"/, name)
    assert.equal(invoke("ls"), "", name)
  }
})
