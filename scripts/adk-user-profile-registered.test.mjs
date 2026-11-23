import { test, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"
import { run, parseArgs } from "./adk-user-profile.mjs"
import { execFileSync, spawnSync } from "node:child_process"
import { loadRegisteredDeployHooks } from "./lib/registered-deploy-hooks.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
if (process.platform === "win32") {
  test("registered deploy hook installation requires a POSIX host", { skip: true }, () => {})
} else {
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "adk-registered-profile-"))
after(() => fs.rmSync(scratch, { recursive: true, force: true }))
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex")

function fixture() {
  const dir = fs.mkdtempSync(path.join(scratch, "case-")), home = path.join(dir, "home"), instance = path.join(dir, "instance")
  fs.mkdirSync(path.join(home, ".claude/cost-guard"), { recursive: true })
  fs.mkdirSync(path.join(instance, ".claude"), { recursive: true })
  fs.writeFileSync(path.join(home, ".claude/cost-guard/policy.json"), JSON.stringify({ configDir: path.join(home, ".claude"), expectedEmail: "profile@example.invalid" }))
  fs.copyFileSync(path.join(root, "templates/claude-user-profile/subagent-model.policy.example.json"), path.join(home, ".claude/subagent-model-policy.json"))
  const settings = path.join(home, ".claude/settings.json"), project = path.join(instance, ".claude/settings.json")
  fs.writeFileSync(settings, '{"model":"preserve-user"}\n')
  fs.writeFileSync(project, '{"model":"preserve-project"}\n')
  return { dir, home, instance, settings, project, args: { mode: "apply", target: "claude", home, adkRoot: root, instanceRoot: instance } }
}

// This before-feature regression is independent of the eventual trusted entry
// argv: an optional typed installation input can never be silently ignored.
test("registered profile rejects unknown descriptor before either settings file is written", () => {
  const f = fixture(), file = path.join(f.dir, "registered.json")
  const bytes = Buffer.from('{"schema":"unknown-registered-profile/v999"}\n')
  fs.writeFileSync(file, bytes)
  const userBefore = fs.readFileSync(f.settings), projectBefore = fs.readFileSync(f.project)
  assert.throws(() => run({ ...f.args, registeredDeployHooks: file, registeredDeployHooksSha256: hash(bytes) }), /registered.*descriptor|descriptor.*schema/i)
  assert.deepEqual(fs.readFileSync(f.settings), userBefore)
  assert.deepEqual(fs.readFileSync(f.project), projectBefore)
})

test("registered profile rejects absent paired digest before settings writes", () => {
  const f = fixture(), file = path.join(f.dir, "registered.json")
  fs.writeFileSync(file, '{}\n')
  const userBefore = fs.readFileSync(f.settings), projectBefore = fs.readFileSync(f.project)
  assert.throws(() => run({ ...f.args, registeredDeployHooks: file }), /registered.*sha256|paired|digest/i)
  assert.deepEqual(fs.readFileSync(f.settings), userBefore)
  assert.deepEqual(fs.readFileSync(f.project), projectBefore)
})

function registeredFixture(ids = ["baseline", "organization"]) {
  const f = fixture(), engine = path.join(f.dir, "engine literal 'quoted' $x"), common = path.join(f.dir, "policy")
  fs.mkdirSync(path.join(engine, ".agents/scripts"), { recursive: true })
  fs.mkdirSync(common)
  const entry = path.join(engine, ".agents/scripts/approval-plan.mjs")
  fs.writeFileSync(entry, 'import fs from "node:fs"; process.stdout.write(JSON.stringify({argv:process.argv.slice(2),stdin:fs.readFileSync(0,"utf8")}))\n')
  const git = args => execFileSync("git", ["-C", engine, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  git(["init", "--quiet"])
  git(["add", "."])
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture runtime"])
  const commit = git(["rev-parse", "HEAD"])
  const registrationFile = path.join(f.instance, ".claude/deploy/registered-gate.json")
  fs.mkdirSync(path.dirname(registrationFile), { recursive: true })
  const registration = { schema: "registered-gate/v2", planRoot: f.instance, engine: { root: engine, commit, files: [] }, profiles: [{ id: ids[0], scope: "global", root: common }, { id: ids[1], scope: "project", root: f.instance }] }
  fs.writeFileSync(registrationFile, JSON.stringify(registration))
  const descriptor = {
    schema: "adk-registered-deploy-hooks/v1", home: f.home, instanceRoot: f.instance,
    engine: { root: engine, commit, entrySha256: hash(fs.readFileSync(entry)) },
    registration: { file: registrationFile, sha256: hash(fs.readFileSync(registrationFile)) },
    entries: [{ id: ids[0], scope: "global", root: common }, { id: ids[1], scope: "project", root: f.instance }],
  }
  const descriptorFile = path.join(f.dir, "profile-registration.json")
  const save = () => { fs.writeFileSync(descriptorFile, JSON.stringify(descriptor)); return { ...f.args, registeredDeployHooks: descriptorFile, registeredDeployHooksSha256: hash(fs.readFileSync(descriptorFile)) } }
  fs.writeFileSync(f.settings, JSON.stringify({ model: "preserve-user", env: { KEEP: "yes" }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: '"/usr/bin/node" "/previous/.claude/hooks/deploy-guard.js"' }, { type: "command", command: "unrelated-user-hook" }] }] } }))
  fs.writeFileSync(f.project, JSON.stringify({ model: "preserve-project", env: { KEEP_PROJECT: "yes" }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/deploy-guard.js"' }, { type: "command", command: "unrelated-project-hook" }] }] } }))
  return { ...f, engine, entry, registrationFile, registration, descriptor, descriptorFile, save, args: save(), ids }
}
const commands = settings => Object.values(settings.hooks ?? {}).flatMap(groups => groups.flatMap(group => (group.hooks ?? []).map(hook => hook.command)))

test("registered apply updates both slots preserving unrelated values, file identities and idempotence", () => {
  const f = registeredFixture(), userBefore = fs.readFileSync(f.settings), projectBefore = fs.readFileSync(f.project)
  fs.chmodSync(f.settings, 0o640)
  fs.chmodSync(f.project, 0o664)
  const beforeIdentity = [f.settings, f.project].map(file => { const s = fs.statSync(file); return [s.uid, s.gid, s.mode & 0o777] })
  const initial = run({ ...f.args, mode: "check" })
  assert.ok(initial.drift.includes(f.settings))
  assert.ok(initial.drift.includes(f.project))
  assert.deepEqual(fs.readFileSync(f.settings), userBefore)
  assert.deepEqual(fs.readFileSync(f.project), projectBefore)
  const result = run(f.args, new Date("2026-11-23T17:00:00Z")), bound = loadRegisteredDeployHooks(f.args)
  assert.ok(result.changed.includes(f.settings))
  assert.ok(result.changed.includes(f.project))
  const user = JSON.parse(fs.readFileSync(f.settings)), project = JSON.parse(fs.readFileSync(f.project))
  assert.equal(user.model, "preserve-user")
  assert.equal(user.env.KEEP, "yes")
  assert.equal(project.model, "preserve-project")
  assert.deepEqual(project.env, { KEEP_PROJECT: "yes" })
  assert.ok(commands(user).includes("unrelated-user-hook"))
  assert.ok(commands(project).includes("unrelated-project-hook"))
  assert.equal(commands(user).filter(command => command === bound.global).length, 1)
  assert.equal(commands(project).filter(command => command === bound.project).length, 1)
  assert.equal(commands(user).some(command => command.includes("deploy-guard.js")), false)
  assert.equal(commands(project).some(command => command.includes("deploy-guard.js")), false)
  assert.deepEqual([f.settings, f.project].map(file => { const s = fs.statSync(file); return [s.uid, s.gid, s.mode & 0o777] }), beforeIdentity)
  for (const [file, bytes] of [[f.settings, userBefore], [f.project, projectBefore]]) assert.deepEqual(fs.readFileSync(`${file}.bak-20261123T170000`), bytes)
  assert.deepEqual(run({ ...f.args, mode: "check" }).drift, [])
  assert.deepEqual(run(f.args).changed, [])
})

test("actual rendered commands preserve literal argv, registered arbitrary IDs and stdin", () => {
  const f = registeredFixture(["first_site", "second-site"]), bound = loadRegisteredDeployHooks(f.args)
  for (const [command, id] of [[bound.global, f.ids[0]], [bound.project, f.ids[1]]]) {
    const child = spawnSync("/bin/sh", ["-c", command], { input: '{"command":"literal; $x"}', encoding: "utf8", env: { ...process.env, ADMISSION_PROFILE: "foreign" }, timeout: 10000 })
    assert.equal(child.status, 0, child.stderr)
    assert.deepEqual(JSON.parse(child.stdout), { argv: ["hook", "--registration", f.registrationFile, "--sha256", f.descriptor.registration.sha256, "--profile", id], stdin: '{"command":"literal; $x"}' })
  }
})

test("registered installation refuses a later default legacy apply instead of rollback", () => {
  const f = registeredFixture()
  run(f.args)
  const before = [fs.readFileSync(f.settings), fs.readFileSync(f.project)]
  assert.throws(() => run({ ...f.args, registeredDeployHooks: undefined, registeredDeployHooksSha256: undefined }), /descriptor.*rollback refused/)
  assert.deepEqual([fs.readFileSync(f.settings), fs.readFileSync(f.project)], before)
})

for (const [name, mutate] of [
  ["unknown descriptor field", f => { f.descriptor.command = "arbitrary"; f.args = f.save() }],
  ["unknown schema", f => { f.descriptor.schema = "unknown/v3"; f.args = f.save() }],
  ["foreign instance", f => { f.descriptor.instanceRoot = f.home; f.args = f.save() }],
  ["wrong digest", f => { f.args.registeredDeployHooksSha256 = "0".repeat(64) }],
  ["duplicate profile", f => { f.descriptor.entries[1].id = f.ids[0]; f.args = f.save() }],
  ["duplicate scope", f => { f.descriptor.entries[1].scope = "global"; f.args = f.save() }],
  ["profile root disagreement", f => { f.descriptor.entries[0].root = f.home; f.args = f.save() }],
  ["changed runtime entry", f => fs.appendFileSync(f.entry, "// changed\n")],
  ["changed registration", f => fs.appendFileSync(f.registrationFile, "\n")],
  ["foreign engine commit", f => { f.descriptor.engine.commit = "0".repeat(40); f.args = f.save() }],
  ["unknown registered target", f => { f.args.target = "all" }],
  ["ambiguous project deploy command", f => fs.writeFileSync(f.project, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/deploy-guard.js" extra' }] }] } }))],
]) test(`registered profile rejects ${name} before settings writes`, () => {
  const f = registeredFixture()
  mutate(f)
  const before = [fs.readFileSync(f.settings), fs.readFileSync(f.project)]
  assert.throws(() => run(f.args), /registered deploy descriptor/)
  assert.deepEqual([fs.readFileSync(f.settings), fs.readFileSync(f.project)], before)
})

test("registered CLI accepts paired typed options and rejects missing, duplicate, foreign-target inputs", () => {
  const f = registeredFixture(), tail = ["--home", f.home, "--instance-root", f.instance, "--adk-root", root]
  const args = parseArgs(["check", "--target", "claude", "--registered-deploy-hooks", f.descriptorFile, "--registered-deploy-hooks-sha256", f.args.registeredDeployHooksSha256, ...tail])
  assert.equal(args.registeredDeployHooks, f.descriptorFile)
  assert.deepEqual(run(args).drift.sort(), run({ ...f.args, mode: "check" }).drift.sort())
  for (const flags of [
    ["--registered-deploy-hooks"],
    ["--registered-deploy-hooks", f.descriptorFile],
    ["--registered-deploy-hooks-sha256", f.args.registeredDeployHooksSha256],
    ["--registered-deploy-hooks", f.descriptorFile, "--registered-deploy-hooks", f.descriptorFile],
    ["--registered-deploy-hooks", f.descriptorFile, "--registered-deploy-hooks-sha256", f.args.registeredDeployHooksSha256, "--target", "all"],
  ]) assert.throws(() => parseArgs(["check", "--target", "claude", ...flags, ...tail]), /registered deploy descriptor/)
})

test("legacy no-descriptor profile preserves the project file and original 16 logical hooks", () => {
  const f = fixture(), projectBefore = fs.readFileSync(f.project)
  const result = run(f.args)
  assert.equal(result.changed.includes(f.project), false)
  assert.deepEqual(fs.readFileSync(f.project), projectBefore)
  assert.ok(commands(JSON.parse(fs.readFileSync(f.settings))).some(command => command.endsWith('/.claude/hooks/deploy-guard.js"')))
  assert.deepEqual(run(f.args).changed, [])
})

test("registered slots reject duplicate or wrong-location hooks and symlinked installation inputs", () => {
  for (const mutate of [
    f => { const s = JSON.parse(fs.readFileSync(f.project)); s.hooks.PreToolUse[0].hooks.unshift({ ...s.hooks.PreToolUse[0].hooks[0] }); fs.writeFileSync(f.project, JSON.stringify(s)) },
    f => { const s = JSON.parse(fs.readFileSync(f.project)); s.hooks.PreToolUse[0].matcher = "Edit"; fs.writeFileSync(f.project, JSON.stringify(s)) },
    f => { const copy = f.descriptorFile + ".real"; fs.renameSync(f.descriptorFile, copy); fs.symlinkSync(copy, f.descriptorFile) },
    f => { const copy = f.project + ".real"; fs.renameSync(f.project, copy); fs.symlinkSync(copy, f.project) },
  ]) {
    const f = registeredFixture()
    mutate(f)
    const before = [fs.readFileSync(f.settings), fs.readFileSync(f.project)]
    assert.throws(() => run(f.args), /registered deploy descriptor/)
    assert.deepEqual([fs.readFileSync(f.settings), fs.readFileSync(f.project)], before)
  }
})

test("failure replacing the project slot restores the user slot bytes and identity", t => {
  const f = registeredFixture()
  fs.chmodSync(f.settings, 0o640)
  fs.chmodSync(f.project, 0o664)
  const before = [f.settings, f.project].map(file => { const s = fs.statSync(file); return { bytes: fs.readFileSync(file), uid: s.uid, gid: s.gid, mode: s.mode & 0o777 } })
  const rename = fs.renameSync
  let failed = false
  t.mock.method(fs, "renameSync", (from, to) => {
    if (to === f.project && !failed) { failed = true; throw Object.assign(new Error("fixture project rename EIO"), { code: "EIO" }) }
    return rename(from, to)
  })
  assert.throws(() => run(f.args), /fixture project rename EIO/)
  assert.equal(failed, true)
  assert.deepEqual([f.settings, f.project].map(file => { const s = fs.statSync(file); return { bytes: fs.readFileSync(file), uid: s.uid, gid: s.gid, mode: s.mode & 0o777 } }), before)
})

test("both settings stage before the first rename and a stage failure leaves both untouched", t => {
  const f = registeredFixture(), before = [fs.readFileSync(f.settings), fs.readFileSync(f.project)]
  const open = fs.openSync, rename = fs.renameSync
  let renames = 0
  t.mock.method(fs, "openSync", (file, ...args) => {
    if (typeof file === "string" && file.startsWith(f.project + ".registered-") && file.endsWith("-next")) throw Object.assign(new Error("fixture stage EACCES"), { code: "EACCES" })
    return open(file, ...args)
  })
  t.mock.method(fs, "renameSync", (...args) => { renames++; return rename(...args) })
  assert.throws(() => run(f.args), /fixture stage EACCES/)
  assert.equal(renames, 0)
  assert.deepEqual([fs.readFileSync(f.settings), fs.readFileSync(f.project)], before)
  assert.equal(fs.existsSync(path.join(f.home, ".claude/.registered-deploy-hooks.install.lock")), false)
})

test("foreign project owner is rejected before any setting write for an ordinary operator", { skip: process.getuid() === 0 }, t => {
  const f = registeredFixture(), before = [fs.readFileSync(f.settings), fs.readFileSync(f.project)], lstat = fs.lstatSync
  let renames = 0
  t.mock.method(fs, "lstatSync", (file, ...args) => {
    const stat = lstat(file, ...args)
    return file === f.project ? new Proxy(stat, { get: (target, key) => key === "uid" ? process.getuid() + 1 : Reflect.get(target, key) }) : stat
  })
  t.mock.method(fs, "renameSync", () => { renames++; throw new Error("unexpected rename") })
  assert.throws(() => run(f.args), /settings target owner/)
  assert.equal(renames, 0)
  assert.deepEqual([fs.readFileSync(f.settings), fs.readFileSync(f.project)], before)
})

test("operator lock prevents concurrent registered check and ordinary legacy apply", () => {
  const f = registeredFixture(), lock = path.join(f.home, ".claude/.registered-deploy-hooks.install.lock")
  fs.writeFileSync(lock, "fixture other operator\n")
  const before = [fs.readFileSync(f.settings), fs.readFileSync(f.project)]
  assert.throws(() => run({ ...f.args, mode: "check" }), /operator lock is held/)
  assert.throws(() => run({ ...f.args, registeredDeployHooks: undefined, registeredDeployHooksSha256: undefined }), /operator lock is held/)
  assert.deepEqual([fs.readFileSync(f.settings), fs.readFileSync(f.project)], before)
  assert.equal(fs.readFileSync(lock, "utf8"), "fixture other operator\n")
})

test("root operator preserves two foreign owners through a paired rollback", { skip: process.getuid() !== 0 }, t => {
  const f = registeredFixture()
  fs.chownSync(f.settings, 10001, 10001)
  fs.chownSync(f.project, 10002, 10002)
  fs.chmodSync(f.settings, 0o640)
  fs.chmodSync(f.project, 0o600)
  const inspect = file => { const stat = fs.statSync(file); return { bytes: fs.readFileSync(file), uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 } }
  const before = [f.settings, f.project].map(inspect), rename = fs.renameSync
  let failed = false
  t.mock.method(fs, "renameSync", (from, to) => {
    if (to === f.project && !failed) { failed = true; throw new Error("fixture mixed-owner rename EIO") }
    return rename(from, to)
  })
  assert.throws(() => run(f.args, new Date("2026-11-23T17:10:00Z")), /fixture mixed-owner rename EIO/)
  assert.deepEqual([f.settings, f.project].map(inspect), before)
  assert.deepEqual([f.settings, f.project].map(file => inspect(`${file}.bak-20261123T171000`)), before)
})

test("legacy user-only install keeps its prior behavior when unrelated project settings are unreadable", t => {
  const f = fixture(), read = fs.readFileSync
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (file === f.project) throw Object.assign(new Error("fixture unrelated project EACCES"), { code: "EACCES" })
    return read(file, ...args)
  })
  assert.ok(run(f.args).changed.includes(f.settings))
  assert.equal(JSON.parse(read(f.project)).model, "preserve-project")
})

test("pinned registration v2 identity rejects foreign schema, engine and slot scope", () => {
  for (const mutate of [
    r => { r.schema = "registered-gate/v999" },
    (r, f) => { r.engine.root = f.home },
    r => { r.engine.commit = "0".repeat(40) },
    r => { r.profiles[0].scope = "project" },
    r => { r.profiles[0].id = "unselected" },
  ]) {
    const f = registeredFixture()
    mutate(f.registration, f)
    fs.writeFileSync(f.registrationFile, JSON.stringify(f.registration))
    f.descriptor.registration.sha256 = hash(fs.readFileSync(f.registrationFile))
    f.args = f.save()
    const before = [fs.readFileSync(f.settings), fs.readFileSync(f.project)]
    assert.throws(() => run(f.args), /registered deploy descriptor/)
    assert.deepEqual([fs.readFileSync(f.settings), fs.readFileSync(f.project)], before)
  }
})

test("two installer slots select their registered IDs without limiting the runtime profile set", () => {
  const f = registeredFixture(), third = path.join(f.dir, "third-site")
  fs.mkdirSync(third)
  f.registration.profiles.push({ id: "third-site", scope: "global", root: third })
  fs.writeFileSync(f.registrationFile, JSON.stringify(f.registration))
  f.descriptor.registration.sha256 = hash(fs.readFileSync(f.registrationFile))
  const bound = loadRegisteredDeployHooks(f.save())
  assert.ok(bound.global.endsWith("'baseline'"))
  assert.ok(bound.project.endsWith("'organization'"))
})

test("a dead installer lock is inspected read-only by check and recovered by registered apply", () => {
  const f = registeredFixture(), lock = path.join(f.home, ".claude/.registered-deploy-hooks.install.lock")
  const bytes = JSON.stringify({ pid: 2147483647, purpose: "registered-profile-pair" }) + "\n"
  fs.writeFileSync(lock, bytes)
  assert.ok(run({ ...f.args, mode: "check" }).drift.includes(f.settings))
  assert.equal(fs.readFileSync(lock, "utf8"), bytes)
  assert.ok(run(f.args).changed.includes(f.project))
  assert.equal(fs.existsSync(lock), false)
})

test("a recycled PID lock recovers without treating an old live unverified PID as dead", () => {
  const f = registeredFixture(), lock = path.join(f.home, ".claude/.registered-deploy-hooks.install.lock")
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, start: "0" }) + "\n")
  assert.ok(run(f.args).changed.includes(f.project))
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }) + "\n")
  fs.utimesSync(lock, new Date("2000-01-01"), new Date("2000-01-01"))
  const before = fs.readFileSync(lock)
  assert.throws(() => run({ ...f.args, mode: "check" }), /operator lock is held/)
  assert.deepEqual(fs.readFileSync(lock), before)
})

test("CLI usage includes both paired registered installation options", () => {
  assert.throws(() => parseArgs(["invalid-mode"]), error => /--registered-deploy-hooks /.test(error.message) && /--registered-deploy-hooks-sha256 /.test(error.message))
})

test("legacy profile keeps unrelated malformed project JSON byte-identical", () => {
  const f = fixture(), bytes = Buffer.from('{"invalid-project":')
  fs.writeFileSync(f.project, bytes)
  assert.ok(run(f.args).changed.includes(f.settings))
  assert.deepEqual(fs.readFileSync(f.project), bytes)
})


function withInstallerEnvironment(values, action) {
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  try { for (const [key, value] of Object.entries(values)) process.env[key] = value; return action() }
  finally { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } }
}
function forgedGit(f) {
  const bin = path.join(f.dir, "fake-bin"), log = path.join(f.dir, "fake-git-called")
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, "git"), `#!/usr/bin/node\nimport('node:fs').then(fs=>{fs.writeFileSync(${JSON.stringify(log)},'called');const a=process.argv.slice(2);process.stdout.write(a.includes('--show-toplevel')?${JSON.stringify(f.engine)}+'\\n':a.includes('HEAD')?${JSON.stringify(f.descriptor.engine.commit)}+'\\n':'')})\n`, { mode: 0o755 })
  return { PATH: bin, log }
}
function dirtyTrackedFixture() {
  const f = registeredFixture(), file = path.join(f.engine, "tracked.txt")
  fs.writeFileSync(file, "committed\n")
  const git = args => execFileSync("/usr/bin/git", ["-C", f.engine, ...args], { encoding: "utf8" }).trim()
  git(["add", "tracked.txt"])
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture tracked input"])
  f.descriptor.engine.commit = f.registration.engine.commit = git(["rev-parse", "HEAD"])
  fs.writeFileSync(f.registrationFile, JSON.stringify(f.registration))
  f.descriptor.registration.sha256 = hash(fs.readFileSync(f.registrationFile)); f.args = f.save()
  return { ...f, file }
}

test("typed installer cannot use a PATH substitute to accept a dirty engine", () => {
  const f = registeredFixture(), fake = forgedGit(f), before = [fs.readFileSync(f.settings), fs.readFileSync(f.project)]
  fs.writeFileSync(path.join(f.engine, "untracked-input.txt"), "unreviewed\n")
  withInstallerEnvironment({ PATH: fake.PATH }, () => assert.throws(() => run(f.args), /clean checkout/))
  assert.equal(fs.existsSync(fake.log), false)
  assert.deepEqual([fs.readFileSync(f.settings), fs.readFileSync(f.project)], before)
})

test("typed installer ignores inherited Git directory, worktree and alternate-index overrides", () => {
  const f = dirtyTrackedFixture(), alternate = path.join(f.dir, "alternate.git")
  fs.cpSync(path.join(f.engine, ".git"), alternate, { recursive: true })
  execFileSync("/usr/bin/git", ["--git-dir", alternate, "--work-tree", f.engine, "update-index", "--assume-unchanged", "tracked.txt"])
  fs.writeFileSync(f.file, "unreviewed\n")
  const env = { GIT_DIR: alternate, GIT_WORK_TREE: f.engine, GIT_INDEX_FILE: path.join(alternate, "index"), GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "status.showUntrackedFiles", GIT_CONFIG_VALUE_0: "no" }
  const before = [fs.readFileSync(f.settings), fs.readFileSync(f.project)]
  withInstallerEnvironment(env, () => assert.throws(() => run(f.args), /clean checkout/))
  assert.deepEqual([fs.readFileSync(f.settings), fs.readFileSync(f.project)], before)
})

test("final registered identity verification also ignores substituted Git and configuration", () => {
  const f = registeredFixture(), bound = loadRegisteredDeployHooks(f.args), fake = forgedGit(f)
  fs.writeFileSync(path.join(f.engine, "untracked-input.txt"), "unreviewed\n")
  withInstallerEnvironment({ PATH: fake.PATH, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" }, () => assert.throws(() => bound.verify(), /clean checkout/))
  assert.equal(fs.existsSync(fake.log), false)
})


test("final identity verification cannot inherit an alternate Git index", () => {
  const f = dirtyTrackedFixture(), bound = loadRegisteredDeployHooks(f.args), alternate = path.join(f.dir, "alternate.git")
  fs.cpSync(path.join(f.engine, ".git"), alternate, { recursive: true })
  execFileSync("/usr/bin/git", ["--git-dir", alternate, "--work-tree", f.engine, "update-index", "--assume-unchanged", "tracked.txt"])
  fs.writeFileSync(f.file, "unreviewed\n")
  withInstallerEnvironment({ GIT_DIR: alternate, GIT_WORK_TREE: f.engine, GIT_INDEX_FILE: path.join(alternate, "index") }, () => assert.throws(() => bound.verify(), /clean checkout/))
})

test("clean typed installation remains usable with a hostile inherited Git environment", () => {
  const f = registeredFixture(), fake = forgedGit(f)
  withInstallerEnvironment({ PATH: fake.PATH, GIT_DIR: "/missing/repository", GIT_CONFIG_COUNT: "invalid", GIT_EXEC_PATH: fake.PATH, GIT_CONFIG_GLOBAL: "/missing/config" }, () => {
    assert.ok(run({ ...f.args, mode: "check" }).drift.includes(f.settings))
    loadRegisteredDeployHooks(f.args).verify()
  })
  assert.equal(fs.existsSync(fake.log), false)
})

}
