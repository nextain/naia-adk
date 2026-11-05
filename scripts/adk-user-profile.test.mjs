import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { loadProfile, mergeRule, mergeSettings, parseArgs, PROFILE_HOOKS, run, validateProfileHooks } from "./adk-user-profile.mjs"
import "../.claude/hooks/profile-role-guards.test.cjs"
import "../.claude/hooks/profile-user-guards.test.cjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const tmpHome = () => { const base = path.join(path.dirname(root), "tmp-codex-profile"); fs.mkdirSync(base, { recursive: true }); return fs.mkdtempSync(path.join(base, "adk-user-profile-")) }
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"))
const costFile = (home) => path.join(home, ".claude/cost-guard/policy.json")
const modelFile = (home) => path.join(home, ".claude/subagent-model-policy.json")
const writeReadyPolicies = (home) => {
  fs.mkdirSync(path.dirname(costFile(home)), { recursive: true })
  fs.writeFileSync(costFile(home), JSON.stringify({ configDir: path.join(home, ".claude"), expectedEmail: "account@example.invalid" }))
  fs.copyFileSync(path.join(root, "templates/claude-user-profile/subagent-model.policy.example.json"), modelFile(home))
}
const readyHome = () => { const home = tmpHome(); writeReadyPolicies(home); return home }

const nodeProcess = (args, options = {}) => new Promise((resolve, reject) => {
  // Regular descriptors preserve actual stdin JSON on hosts whose sandbox
  // does not support Node's subprocess pipe transport.
  const io = tmpHome()
  const input = path.join(io, "stdin"), output = path.join(io, "stdout"), errorFile = path.join(io, "stderr")
  fs.writeFileSync(input, options.input ?? "")
  const descriptors = [fs.openSync(input, "r"), fs.openSync(output, "w"), fs.openSync(errorFile, "w")]
  let child
  try { child = spawn(process.execPath, args, { ...options, stdio: descriptors }) }
  finally { descriptors.forEach((fd) => fs.closeSync(fd)) }
  const timer = setTimeout(() => { child.kill(); reject(new Error("Node subprocess timed out")) }, 10000)
  child.on("error", (error) => { clearTimeout(timer); reject(error) })
  child.on("close", (status) => {
    clearTimeout(timer)
    try { resolve({ status, stdout: fs.readFileSync(output, "utf8"), stderr: fs.readFileSync(errorFile, "utf8") }) }
    catch (error) { reject(error) }
    finally { fs.rmSync(io, { recursive: true, force: true }) }
  })
})
const hookOutput = async (args, options) => {
  const result = await nodeProcess(args, options)
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

test("apply adds env, absolute hooks and the rule block, keeping existing settings", () => {
  const home = readyHome()
  const existing = { model: "opus", env: { KEEP: "1" }, hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "gate" }] }] } }
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify(existing))
  fs.writeFileSync(path.join(home, ".claude", "CLAUDE.md"), "# mine\n")
  const result = run({ mode: "apply", home, adkRoot: root }, new Date("2026-11-05T06:00:00Z"))
  assert.equal(result.changed.length, 2)
  const s = read(path.join(home, ".claude", "settings.json"))
  assert.equal(s.model, "opus")
  assert.equal(s.env.KEEP, "1")
  assert.equal(s.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "200000")
  assert.equal(s.env.NAIA_ADK_ROOT, root)
  assert.equal(s.env.NAIA_COST_GUARD_POLICY, path.join(home, ".claude/cost-guard/policy.json"))
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, "gate")
  assert.match(s.hooks.SessionStart[0].hooks[0].command, new RegExp(`${root}/\\.claude/hooks/role-compact-brief\\.js`))
  assert.equal(s.hooks.PostCompact, undefined)
  const rule = fs.readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf8")
  assert.ok(rule.startsWith("# mine\n"))
  assert.match(rule, /naia-adk claude-user-profile: begin/)
  assert.ok(fs.existsSync(path.join(home, ".claude", "settings.json.bak-20261105T060000")))
})

test("instance root sets NAIA_ADK_ROOT while hook commands stay on the ADK root", () => {
  const home = readyHome()
  const instance = path.join(home, "instance")
  fs.mkdirSync(path.join(instance, ".claude"), { recursive: true })
  run({ mode: "apply", home, adkRoot: root, instanceRoot: instance }, new Date("2026-11-05T06:00:00Z"))
  const s = read(path.join(home, ".claude", "settings.json"))
  assert.equal(s.env.NAIA_ADK_ROOT, instance)
  assert.match(s.hooks.PreToolUse[0].hooks[0].command, new RegExp(`${root}/\\.claude/hooks/`))
  assert.deepEqual(run({ mode: "check", home, adkRoot: root, instanceRoot: instance }).drift, [])
  assert.deepEqual(run({ mode: "check", home, adkRoot: root }).drift, [path.join(home, ".claude", "settings.json")])
})

test("parseArgs defaults the instance root to the ADK root and refuses one without .claude", () => {
  assert.equal(parseArgs(["check", "--adk-root", root]).instanceRoot, root)
  const bare = tmpHome()
  assert.throws(() => parseArgs(["check", "--adk-root", root, "--instance-root", bare]), /missing instance \.claude/)
})

test("apply twice is a no-op and check then reports no drift", () => {
  const home = readyHome()
  run({ mode: "apply", home, adkRoot: root })
  const again = run({ mode: "apply", home, adkRoot: root })
  assert.deepEqual(again.changed, [])
  assert.deepEqual(run({ mode: "check", home, adkRoot: root }).drift, [])
})

test("check reports drift when a profile env value is changed", () => {
  const home = readyHome()
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
  const home = readyHome()
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
  assert.throws(() => run({ mode: "check", home: tmpHome(), adkRoot: fake }), /missing hook/)
})

test("role-compact-brief lists only existing absolute paths from .naia-role.json", async () => {
  const cwd = tmpHome()
  const mission = path.join(cwd, "mission.md")
  fs.writeFileSync(mission, "secret text")
  fs.writeFileSync(path.join(cwd, ".naia-role.json"), JSON.stringify({ role: "dev", read: [mission, "/no/such/file", "relative.md"] }))
  const hook = async (input) => JSON.parse(await hookOutput([path.join(root, ".claude/hooks/role-compact-brief.js")], { input: JSON.stringify(input) })).hookSpecificOutput
  const compact = await hook({ cwd, source: "compact" })
  assert.equal(compact.hookEventName, "SessionStart")
  assert.match(compact.additionalContext, /압축됐습니다/)
  assert.match(compact.additionalContext, /역할: dev/)
  assert.ok(compact.additionalContext.includes(mission))
  assert.match(compact.additionalContext, /없는 경로: \/no\/such\/file/)
  assert.match(compact.additionalContext, /없는 경로: relative\.md/)
  assert.doesNotMatch(compact.additionalContext, /secret text/)
  assert.match((await hook({ cwd, source: "startup" })).additionalContext, /세션 시작/)
})

test("role-compact-brief warns without a role file and includes mandatory reads", async () => {
  const cwd = tmpHome()
  const out = await hookOutput([path.join(root, ".claude/hooks/role-compact-brief.js")], { input: JSON.stringify({ cwd, source: "compact" }) })
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
  const home = readyHome()
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({env: {CLAUDE_CODE_AUTO_COMPACT_WINDOW: "old"}}))
  assert.deepEqual(run({ mode: "apply", home, adkRoot: root }).overridden, ["env.CLAUDE_CODE_AUTO_COMPACT_WINDOW"])
})

test("stateless safety hooks block dangerous input in a role directory", async () => {
  const cwd = tmpHome()
  const cases = [["destructive-git-guard.js", "git reset --hard"], ["catastrophic-delete-guard.js", "rm -rf /"], ["git-push-guard.js", "git push --force"], ["email-send-guard.js", "node send.js send --to example"]]
  for (const [name, command] of cases) {
    const invoke = (cmd) => hookOutput([path.join(root, ".claude/hooks", name)], { cwd, env: {...process.env, CLAUDE_PROJECT_DIR: cwd}, input: JSON.stringify({tool_name: "Bash", cwd, tool_input: {command: cmd}}) })
    assert.match(await invoke(command), /"block"/, name)
    assert.equal(await invoke("ls"), "", name)
  }
})

test("PROFILE_HOOKS exactly matches settings and repository hook matchers", () => {
  const { settings } = loadProfile(root)
  validateProfileHooks(settings)
  const repository = read(path.join(root, ".claude/settings.json"))
  for (const name of PROFILE_HOOKS.filter((name) => name.endsWith(".js") && name !== "role-compact-brief.js")) {
    const matchers = (source) => source.hooks.PreToolUse.filter((group) => group.hooks.some((hook) => hook.command.includes(`/${name}`))).map((group) => group.matcher)
    assert.deepEqual(matchers(settings), matchers(repository), name)
  }
  const missing = structuredClone(settings)
  missing.hooks.SessionStart = []
  assert.throws(() => validateProfileHooks(missing), /disagree/)
  const extra = structuredClone(settings)
  extra.hooks.SessionStart.push({ hooks: [{ command: '"node" "/adk/new-guard.cjs"' }] })
  assert.throws(() => validateProfileHooks(extra), /disagree/)
})

test("policies are copied once, preserved byte for byte, and checked without exposing values", () => {
  const home = tmpHome()
  const policy = costFile(home)
  assert.ok(run({ mode: "check", home, adkRoot: root }).drift.includes(policy))
  assert.throws(() => run({ mode: "apply", home, adkRoot: root }), /keys: configDir, expectedEmail/)
  assert.deepEqual(read(policy), read(path.join(root, "templates/claude-user-profile/cost-guard.policy.example.json")))
  assert.equal(fs.statSync(policy).mode & 0o777, 0o600)
  assert.equal(fs.existsSync(path.join(home, ".claude/settings.json")), false)
  assert.equal(fs.existsSync(path.join(home, ".claude/CLAUDE.md")), false)
  for (const content of ['{ "custom": "preserve formatting" }\n', '{broken']) {
    fs.writeFileSync(policy, content)
    assert.throws(() => run({ mode: "apply", home, adkRoot: root }), /policy required:/)
    assert.equal(fs.readFileSync(policy, "utf8"), content)
  }
  assert.ok(run({ mode: "check", home, adkRoot: root }).drift.includes(policy))
  writeReadyPolicies(home)
  run({ mode: "apply", home, adkRoot: root })
  assert.deepEqual(run({ mode: "check", home, adkRoot: root }).drift, [])
})

test("cost preflight reports keys for nested placeholders and runtime-invalid values without altering settings", () => {
  const home = readyHome()
  run({ mode: "apply", home, adkRoot: root })
  const settingsFile = path.join(home, ".claude/settings.json")
  const ruleFile = path.join(home, ".claude/CLAUDE.md")
  const settings = fs.readFileSync(settingsFile, "utf8"), rule = fs.readFileSync(ruleFile, "utf8")
  const valid = read(costFile(home))
  for (const [change, key] of [
    [{ configDir: "{{USER_HOME}}/.claude" }, "configDir"],
    [{ expectedEmail: "{{ACCOUNT}}@example.invalid" }, "expectedEmail"],
    [{ extraEmails: ["{{EXTRA}}@example.invalid"] }, "extraEmails.0"],
    [{ extraConfigDirs: ["{{DIRECTORY"] }, "extraConfigDirs.0"],
    [{ limits: { maxContextTokens: -1 } }, "limits.maxContextTokens"],
    [{ quotaFreshSeconds: 181 }, "quotaFreshSeconds"],
  ]) {
    const content = JSON.stringify({ ...valid, ...change })
    fs.writeFileSync(costFile(home), content)
    let message
    assert.throws(() => run({ mode: "apply", home, adkRoot: root }), (error) => { message = error.message; return message.includes(costFile(home)) && message.includes(`keys: ${key}`) })
    assert.doesNotMatch(message, /\{\{|account@example|181|USER_HOME|EXTRA/)
    assert.ok(run({ mode: "check", home, adkRoot: root }).drift.includes(costFile(home)))
    assert.equal(fs.readFileSync(costFile(home), "utf8"), content)
    assert.equal(fs.readFileSync(settingsFile, "utf8"), settings)
    assert.equal(fs.readFileSync(ruleFile, "utf8"), rule)
  }
})

test("model policy preflight blocks invalid and placeholder policies, preserving originals", () => {
  const home = readyHome()
  const policy = modelFile(home)
  const valid = read(policy)
  for (const content of ["{", "{}", JSON.stringify({ ...valid, allowedModels: ["{{MODEL}}"] }), JSON.stringify({ ...valid, overrideFile: "{{OVERRIDE}}" }), JSON.stringify({ ...valid, requireBrief: "yes" })]) {
    fs.writeFileSync(policy, content)
    assert.throws(() => run({ mode: "apply", home, adkRoot: root }), error => error.message.includes(policy) && !error.message.includes("{{"))
    assert.ok(run({ mode: "check", home, adkRoot: root }).drift.includes(policy))
    assert.equal(fs.readFileSync(policy, "utf8"), content)
    assert.equal(fs.existsSync(path.join(home, ".claude/settings.json")), false)
  }
  fs.rmSync(policy)
  run({ mode: "apply", home, adkRoot: root })
  assert.deepEqual(read(policy), valid)
  assert.equal(fs.statSync(policy).mode & 0o777, 0o600)
  assert.deepEqual(run({ mode: "check", home, adkRoot: root }).drift, [])
})

test("check catches changed hook matchers and apply restores the declared events", () => {
  const home = readyHome()
  run({ mode: "apply", home, adkRoot: root })
  const file = path.join(home, ".claude/settings.json")
  const settings = read(file)
  settings.hooks.PreToolUse.find((group) => group.hooks.some((hook) => hook.command.includes("deploy-guard.js"))).matcher = "Read"
  const sessionHook = settings.hooks.SessionStart.pop()
  settings.hooks.PostCompact = [sessionHook]
  fs.writeFileSync(file, JSON.stringify(settings))
  assert.ok(run({ mode: "check", home, adkRoot: root }).drift.includes(file))
  run({ mode: "apply", home, adkRoot: root })
  assert.deepEqual(run({ mode: "check", home, adkRoot: root }).drift, [])
  const repaired = read(file)
  assert.equal(repaired.hooks.PreToolUse.find((group) => group.hooks.some((hook) => hook.command.includes("deploy-guard.js"))).matcher, "Bash")
  assert.equal(repaired.hooks.PostCompact, undefined)
})

test("role-compact-brief handles empty and mixed read arrays", async () => {
  const cwd = tmpHome()
  const mission = path.join(cwd, "mission.md")
  fs.writeFileSync(mission, "mission body")
  for (const entries of [[], [null, 1, {}, false, mission]]) {
    fs.writeFileSync(path.join(cwd, ".naia-role.json"), JSON.stringify({ read: entries }))
    const output = JSON.parse(await hookOutput([path.join(root, ".claude/hooks/role-compact-brief.js")], { cwd, input: JSON.stringify({ cwd }) })).hookSpecificOutput.additionalContext
    assert.ok(output.includes(path.join(root, ".agents/context/agents-rules.json")))
    if (!entries.length) assert.match(output, /역할 미션 파일 없음/)
    else assert.ok(output.includes(mission))
    assert.doesNotMatch(output, /mission body|\[object Object\]|없는 경로: (?:null|1|false)/)
  }
})

for (const manual of [false, true]) test(`CLI apply/check/apply/check preserves ${manual ? "manual summary rules" : "a prepared home"}`, async (t) => {
  const home = readyHome()
  const ruleFile = path.join(home, ".claude/CLAUDE.md")
  if (manual) {
    fs.mkdirSync(path.dirname(ruleFile), { recursive: true })
    fs.writeFileSync(ruleFile, "# My summary rules\nKeep the open task and the test results.\n")
  }
  const statuses = []
  for (const mode of ["apply", "check", "apply", "check"]) {
    const result = await nodeProcess([path.join(root, "scripts/adk-user-profile.mjs"), mode, "--home", home])
    assert.equal(result.status, 0, result.stderr || result.stdout)
    statuses.push(result.status)
    if (statuses.length === 3) assert.match(result.stdout, /already up to date/)
  }
  if (manual) assert.ok(fs.readFileSync(ruleFile, "utf8").startsWith("# My summary rules\nKeep the open task and the test results.\n"))
  t.diagnostic(`apply/check/apply/check: ${statuses.join("/")}`)
})

test("CLI empty home stops before settings, reports only policy keys, then succeeds after configuration", async (t) => {
  const home = tmpHome()
  const statuses = []
  for (const mode of ["apply", "check", "apply", "check"]) {
    const result = await nodeProcess([path.join(root, "scripts/adk-user-profile.mjs"), mode, "--home", home])
    assert.equal(result.status, mode === "apply" ? 2 : 1)
    const output = result.stderr + result.stdout
    assert.ok(output.includes(costFile(home)))
    assert.match(output, /keys: configDir/)
    assert.match(output, /expectedEmail/)
    assert.doesNotMatch(output, /\{\{|ACCOUNT_EMAIL|USER_HOME/)
    statuses.push(result.status)
    assert.equal(fs.existsSync(path.join(home, ".claude/settings.json")), false)
  }
  const policy = read(costFile(home))
  policy.configDir = path.join(home, ".claude")
  policy.expectedEmail = "account@example.invalid"
  fs.writeFileSync(costFile(home), JSON.stringify(policy))
  for (const mode of ["apply", "check", "apply", "check"]) {
    const result = await nodeProcess([path.join(root, "scripts/adk-user-profile.mjs"), mode, "--home", home])
    assert.equal(result.status, 0, result.stderr || result.stdout)
  }
  t.diagnostic(`empty apply/check/apply/check: ${statuses.join("/")}; configured: 0/0/0/0`)
})

test("CLI invalid configDir types report keys without exposing policy values", async () => {
  const home = readyHome()
  run({ mode: "apply", home, adkRoot: root })
  const settingsFile = path.join(home, ".claude/settings.json")
  const settings = fs.readFileSync(settingsFile, "utf8")
  for (const configDir of [987654321, true, ["private-value-marker"], { privateKey: "private-value-marker" }]) {
    fs.writeFileSync(costFile(home), JSON.stringify({ configDir, expectedEmail: "account@example.invalid" }))
    for (const mode of ["apply", "check"]) {
      const result = await nodeProcess([path.join(root, "scripts/adk-user-profile.mjs"), mode, "--home", home])
      assert.equal(result.status, mode === "apply" ? 2 : 1)
      const output = result.stdout + result.stderr
      assert.ok(output.includes(costFile(home)))
      assert.match(output, /keys: configDir/)
      assert.doesNotMatch(output, /987654321|private-value-marker|privateKey|Received|TypeError/)
      assert.equal(fs.readFileSync(settingsFile, "utf8"), settings)
    }
  }
})
