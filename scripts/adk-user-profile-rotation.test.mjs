import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { run, parseArgs } from "./adk-user-profile.mjs"
import { loadRegisteredDeployHooks } from "./lib/registered-deploy-hooks.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex")
const write = (file, data) => { fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 }); return hash(fs.readFileSync(file)) }
const read = file => JSON.parse(fs.readFileSync(file))
const hooks = data => Object.values(data.hooks ?? {}).flatMap(groups => groups.flatMap(group => group.hooks))

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "registered-rotation-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const home = path.join(dir, "home"), instance = path.join(dir, "instance"), engine = path.join(dir, "engine"), common = path.join(dir, "common")
  for (const p of [path.join(home, ".codex"), path.join(instance, ".codex"), path.join(instance, ".claude/deploy"), path.join(engine, ".agents/scripts"), common]) fs.mkdirSync(p, { recursive: true })
  const entry = path.join(engine, ".agents/scripts/approval-plan.mjs")
  fs.writeFileSync(entry, "// Disposable installer identity; no runtime invocation.\n")
  const git = args => execFileSync("/usr/bin/git", ["-C", engine, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  git(["init", "-q"]); git(["add", "."])
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "Disposable installer runtime"])
  const registration = path.join(instance, ".claude/deploy/registered-gate.json")
  const data = { schema: "registered-gate/v2", planRoot: instance, engine: { root: engine, commit: git(["rev-parse", "HEAD"]), files: [] }, instance: { files: [{ file: "config/deploy-gate.json", sha256: hash("original policy") }] }, profiles: [{ id: "baseline", scope: "global", root: common }, { id: "organization", scope: "project", root: instance }] }
  write(registration, data)
  const oldRecord = path.join(dir, "registration.before.json")
  fs.copyFileSync(registration, oldRecord)
  const envelope = { schema: "adk-registered-deploy-hooks/v1", home, instanceRoot: instance, engine: { root: engine, commit: data.engine.commit, entrySha256: hash(fs.readFileSync(entry)) }, registration: { file: registration, sha256: hash(fs.readFileSync(registration)) }, entries: data.profiles }
  const oldDescriptor = path.join(dir, "descriptor.before.json"), oldDescriptorSha = write(oldDescriptor, envelope)
  const user = path.join(home, ".codex/hooks.json"), project = path.join(instance, ".codex/hooks.json")
  const existing = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: Array.from({ length: 7 }, (_, i) => ({ type: "command", command: `printf existing-pre-${i}` })) }], PostToolUse: [{ hooks: Array.from({ length: 18 }, (_, i) => ({ type: "command", command: `printf existing-post-${i}` })) }] } }
  write(project, existing); fs.chmodSync(project, 0o640)
  const oldArgs = { mode: "apply", target: "codex", home, instanceRoot: instance, adkRoot: ROOT, registeredDeployHooks: oldDescriptor, registeredDeployHooksSha256: oldDescriptorSha }
  run(oldArgs, new Date("2025-01-01T00:00:00Z"))
  const originalSettings = [user, project].map(f => fs.readFileSync(f))
  data.instance.files[0].sha256 = hash("changed service policy")
  write(registration, data)
  const newEnvelope = structuredClone(envelope)
  newEnvelope.registration.sha256 = hash(fs.readFileSync(registration))
  const descriptor = path.join(dir, "descriptor.next.json"), descriptorSha = write(descriptor, newEnvelope)
  const args = { ...oldArgs, registeredDeployHooks: descriptor, registeredDeployHooksSha256: descriptorSha, previousRegisteredDeployHooks: oldDescriptor, previousRegisteredDeployHooksSha256: oldDescriptorSha, previousRegistrationFile: oldRecord }
  return { dir, home, instance, engine, registration, data, envelope, newEnvelope, oldRecord, oldDescriptor, oldDescriptorSha, oldArgs, descriptor, descriptorSha, user, project, existing, originalSettings, args }
}

const unchanged = f => assert.deepEqual([f.user, f.project].map(p => fs.readFileSync(p)), f.originalSettings)
const identity = f => [f.user, f.project].map(p => { const s = fs.statSync(p); return [s.uid, s.gid, s.mode & 0o777] })

test("rotation check/apply uses another engine root and changes only the exact previous pair", t => {
  const f = fixture(t), beforeIdentity = identity(f)
  assert.notEqual(f.engine, ROOT)
  assert.deepEqual(run({ ...f.args, mode: "check" }).drift.sort(), [f.user, f.project].sort())
  unchanged(f)
  assert.deepEqual(run(f.args).changed.sort(), [f.user, f.project].sort())
  const bound = loadRegisteredDeployHooks(f.args)
  for (const [file, command] of [[f.user, bound.global], [f.project, bound.project]]) assert.equal(hooks(read(file)).filter(h => h.command === command).length, 1)
  assert.deepEqual(read(f.project).hooks.PreToolUse[0], f.existing.hooks.PreToolUse[0])
  assert.deepEqual(read(f.project).hooks.PostToolUse, f.existing.hooks.PostToolUse)
  assert.deepEqual(identity(f), beforeIdentity)
  assert.deepEqual(run(f.args).changed, [])
  assert.deepEqual(run({ ...f.args, mode: "check" }).drift, [])
})

test("inverse rotation restores the exact original pair using the same validated lifecycle", t => {
  const f = fixture(t)
  run(f.args)
  const backup = path.join(f.dir, "registration.next.before.json")
  fs.copyFileSync(f.registration, backup)
  fs.copyFileSync(f.oldRecord, f.registration)
  run({ ...f.oldArgs, previousRegisteredDeployHooks: f.descriptor, previousRegisteredDeployHooksSha256: f.descriptorSha, previousRegistrationFile: backup }, new Date("2025-01-01T00:00:02Z"))
  unchanged(f)
})

test("without explicit previous inputs a different registered pair still fails closed", t => {
  const f = fixture(t)
  assert.throws(() => run({ ...f.args, previousRegisteredDeployHooks: undefined, previousRegisteredDeployHooksSha256: undefined, previousRegistrationFile: undefined }), /ambiguous existing deploy hook/)
  unchanged(f)
})

for (const [name, mutate] of [
  ["wrong previous descriptor digest", f => { f.args.previousRegisteredDeployHooksSha256 = "0".repeat(64) }],
  ["wrong previous record digest", f => fs.appendFileSync(f.oldRecord, "\n")],
  ["missing previous record", f => { f.args.previousRegistrationFile = undefined }],
  ["missing previous descriptor digest", f => { f.args.previousRegisteredDeployHooksSha256 = undefined }],
  ["symlinked previous record", f => { fs.renameSync(f.oldRecord, f.oldRecord + ".real"); fs.symlinkSync(f.oldRecord + ".real", f.oldRecord) }],
  ["oversized previous record", f => fs.writeFileSync(f.oldRecord, Buffer.alloc(2 * 1024 * 1024 + 1))],
  ["old registration profile differs", f => { const d = read(f.oldRecord); d.profiles[0].root = f.home; write(f.oldRecord, d); const e = read(f.oldDescriptor); e.registration.sha256 = hash(fs.readFileSync(f.oldRecord)); f.args.previousRegisteredDeployHooksSha256 = write(f.oldDescriptor, e) }],
  ["old envelope engine differs", f => { const e = read(f.oldDescriptor); e.engine.commit = "0".repeat(40); f.args.previousRegisteredDeployHooksSha256 = write(f.oldDescriptor, e) }],
  ["old envelope path differs", f => { const e = read(f.oldDescriptor); e.registration.file = f.oldRecord; f.args.previousRegisteredDeployHooksSha256 = write(f.oldDescriptor, e) }],
  ["old envelope has an unknown field", f => { const e = read(f.oldDescriptor); e.command = "unrequested"; f.args.previousRegisteredDeployHooksSha256 = write(f.oldDescriptor, e) }],
  ["previous slot is missing", f => { const s = read(f.user); s.hooks.PreToolUse = []; write(f.user, s); f.originalSettings[0] = fs.readFileSync(f.user) }],
  ["unexpected previous command", f => { const s = read(f.user); hooks(s)[0].command += " extra"; write(f.user, s); f.originalSettings[0] = fs.readFileSync(f.user) }],
  ["duplicate previous slot", f => { const s = read(f.user); s.hooks.PreToolUse[0].hooks.push({ ...hooks(s)[0] }); write(f.user, s); f.originalSettings[0] = fs.readFileSync(f.user) }],
]) test(`rotation rejects ${name} before either settings write`, t => {
  const f = fixture(t)
  mutate(f)
  assert.throws(() => run(f.args), /registered deploy descriptor/)
  unchanged(f)
})

test("rotation second-write failure restores both exact preimages and metadata", t => {
  const f = fixture(t), beforeIdentity = identity(f), rename = fs.renameSync
  let failed = false
  t.mock.method(fs, "renameSync", (from, to) => {
    if (to === f.project && !failed) { failed = true; throw new Error("Disposable rotation second rename") }
    return rename(from, to)
  })
  assert.throws(() => run(f.args), /Disposable rotation second rename/)
  assert.equal(failed, true)
  unchanged(f)
  assert.deepEqual(identity(f), beforeIdentity)
})

test("rotation revalidates the previous backup after reading the current pair", t => {
  const f = fixture(t), readFile = fs.readFileSync
  let changed = false
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    const result = readFile(file, ...args)
    if (file === f.user && !changed) { changed = true; fs.appendFileSync(f.oldRecord, "\n") }
    return result
  })
  assert.throws(() => run(f.args), /registered deploy descriptor/)
  assert.equal(changed, true)
  unchanged(f)
})

test("ordinary rotation rejects a foreign previous-backup owner", { skip: process.getuid() === 0 }, t => {
  const f = fixture(t), open = fs.openSync, stat = fs.fstatSync, close = fs.closeSync, targets = new Map()
  t.mock.method(fs, "openSync", (file, ...args) => { const fd = open(file, ...args); targets.set(fd, file === f.oldRecord); return fd })
  t.mock.method(fs, "closeSync", fd => { targets.delete(fd); return close(fd) })
  t.mock.method(fs, "fstatSync", (fd, ...args) => {
    const value = stat(fd, ...args)
    return targets.get(fd) ? new Proxy(value, { get(target, key) { return key === "uid" ? target.uid + (typeof target.uid === "bigint" ? 1n : 1) : Reflect.get(target, key) } }) : value
  })
  assert.throws(() => run(f.args), /invalid input file or owner/)
  unchanged(f)
})

test("CLI rotation inputs are a closed triple paired with explicit native registration", t => {
  const f = fixture(t), base = ["check", "--target", "codex", "--home", f.home, "--instance-root", f.instance, "--adk-root", ROOT, "--registered-deploy-hooks", f.descriptor, "--registered-deploy-hooks-sha256", f.descriptorSha]
  const flags = ["--previous-registered-deploy-hooks", f.oldDescriptor, "--previous-registered-deploy-hooks-sha256", f.oldDescriptorSha, "--previous-registration-file", f.oldRecord]
  const parsed = parseArgs([...base, ...flags])
  assert.equal(parsed.previousRegistrationFile, f.oldRecord)
  assert.deepEqual(run(parsed).drift.sort(), [f.user, f.project].sort())
  for (const tail of [flags.slice(0, 2), flags.slice(0, 4), [...flags, "--previous-registration-file", f.oldRecord]]) assert.throws(() => parseArgs([...base, ...tail]), /registered deploy descriptor/)
})
