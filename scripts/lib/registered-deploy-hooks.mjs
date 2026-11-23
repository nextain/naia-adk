import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import registeredGitIdentity from "./registered-git-identity.cjs"
const { assertRegisteredGitIdentity } = registeredGitIdentity
import { acquirePidLockSync, inspectLockOwner, parseLockRecord } from "./pid-lock.mjs"

const ENTRY = ".agents/scripts/approval-plan.mjs"
const SCHEMA = "adk-registered-deploy-hooks/v1"
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex")
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
const fail = message => { throw new Error(`registered deploy descriptor: ${message}`) }
const gitIdentity = engine => {
  try { assertRegisteredGitIdentity(engine) }
  catch (error) { fail(error.message) }
}

function keys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== [...expected].sort().join(",")) fail(`invalid ${label} fields`)
}
function canonical(value, label) {
  if (typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value) || !path.isAbsolute(value) || path.resolve(value) !== value || fs.realpathSync(value) !== value) fail(`noncanonical ${label}`)
  return value
}
function pinned(file, expected) {
  if (!digest(expected)) fail("invalid SHA256")
  canonical(file, "input file")
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  try {
    const before = fs.fstatSync(fd, { bigint: true })
    if (!before.isFile() || before.size > 2n * 1024n * 1024n || process.getuid() !== 0 && before.uid !== BigInt(process.getuid())) fail("invalid input file or owner")
    const buffer = Buffer.alloc(Number(before.size) + 1)
    let length = 0, count
    while (length < buffer.length && (count = fs.readSync(fd, buffer, length, buffer.length - length, null))) length += count
    const bytes = buffer.subarray(0, length), after = fs.fstatSync(fd, { bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || BigInt(bytes.length) !== before.size || hash(bytes) !== expected) fail("input SHA256 changed")
    return bytes
  } finally { fs.closeSync(fd) }
}

export function loadRegisteredDeployHooks(args) {
  const file = args.registeredDeployHooks, expected = args.registeredDeployHooksSha256
  if (file === undefined && expected === undefined) return null
  if (!file || !digest(expected)) fail("registered file and SHA256 digest are paired")
  if (!["claude", "codex"].includes(args.target) || process.platform === "win32") fail("requires explicit --target claude or codex on a POSIX host")
  const bytes = pinned(file, expected), descriptor = JSON.parse(bytes.toString("utf8"))
  keys(descriptor, ["schema", "home", "instanceRoot", "engine", "registration", "entries"], "descriptor")
  if (descriptor.schema !== SCHEMA) fail("unknown descriptor schema")
  const home = canonical(descriptor.home, "home"), instance = canonical(descriptor.instanceRoot, "instance root")
  if (home !== path.resolve(args.home) || instance !== path.resolve(args.instanceRoot ?? args.adkRoot) || home === instance) fail("home/instance binding mismatch")
  if (args.target === "codex" && args.codexHooksFile && path.resolve(args.codexHooksFile) !== path.join(home, ".codex/hooks.json")) fail("Codex home binding mismatch")
  keys(descriptor.engine, ["root", "commit", "entrySha256"], "engine")
  canonical(descriptor.engine.root, "engine root")
  gitIdentity(descriptor.engine)
  fs.accessSync("/usr/bin/node", fs.constants.R_OK | fs.constants.X_OK)
  const entry = path.join(descriptor.engine.root, ENTRY)
  pinned(entry, descriptor.engine.entrySha256)
  keys(descriptor.registration, ["file", "sha256"], "registration")
  if (descriptor.registration.file !== path.join(instance, ".claude/deploy/registered-gate.json")) fail("registration path mismatch")
  const registration = JSON.parse(pinned(descriptor.registration.file, descriptor.registration.sha256).toString("utf8"))
  if (!Array.isArray(descriptor.entries) || descriptor.entries.length !== 2) fail("exactly two entries are required")
  const entries = new Map(), slots = new Map(), roots = new Set()
  for (const item of descriptor.entries) {
    keys(item, ["id", "scope", "root"], "entry")
    if (typeof item.id !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(item.id) || !["global", "project"].includes(item.scope) || entries.has(item.id) || slots.has(item.scope)) fail("invalid profile/scope")
    canonical(item.root, "profile root")
    if (roots.has(item.root)) fail("profile roots must be distinct")
    entries.set(item.id, item)
    slots.set(item.scope, item)
    roots.add(item.root)
  }
  if (slots.get("project")?.root !== instance || !slots.has("global")) fail("project profile root mismatch")
  // The official entry owns the complete registration schema and all policy
  // decisions; installation checks only this explicit identity projection.
  if (registration.schema !== "registered-gate/v2" || registration.planRoot !== instance || registration.engine?.root !== descriptor.engine.root || registration.engine?.commit !== descriptor.engine.commit || !Array.isArray(registration.profiles) || registration.profiles.length < 2) fail("registration identity mismatch")
  const seen = new Set()
  for (const profile of registration.profiles) {
    if (typeof profile.id !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(profile.id) || seen.has(profile.id) || entries.has(profile.id) && (profile.root !== entries.get(profile.id).root || profile.scope !== entries.get(profile.id).scope)) fail("registration profile mismatch")
    seen.add(profile.id)
  }
  if ([...entries.keys()].some(id => !seen.has(id))) fail("selected profile is not registered")
  const command = id => ["/usr/bin/node", entry, "hook", "--registration", descriptor.registration.file, "--sha256", descriptor.registration.sha256, "--profile", id].map(quote).join(" ")
  return {
    global: command(slots.get("global").id), project: command(slots.get("project").id),
    verify() { pinned(file, expected); pinned(entry, descriptor.engine.entrySha256); pinned(descriptor.registration.file, descriptor.registration.sha256); gitIdentity(descriptor.engine) },
  }
}

export const isRegisteredDeployCommand = command => typeof command === "string" && /(?:^|\/)approval-plan\.mjs['"]?\s+(?:'hook'|"hook"|hook)(?:\s|$)/.test(command)
const legacyProject = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/deploy-guard.js"'
const legacyDeploy = command => command === legacyProject || /^(?:"[^"\n]+\/node"|node) "[^"\n]+\/\.claude\/hooks\/deploy-guard\.js"$/.test(command)
const suspiciousDeploy = command => typeof command === "string" && (command.includes("deploy-guard.js") || isRegisteredDeployCommand(command))
const clone = value => structuredClone(value ?? {})

function rewrite(settings, expected, replace) {
  const result = clone(settings), slots = []
  for (const [event, groups] of Object.entries(result.hooks ?? {})) for (const group of groups) {
    for (let i = 0; i < (group.hooks ?? []).length; i++) {
      const hook = group.hooks[i]
      if (!suspiciousDeploy(hook.command)) continue
      if (event !== "PreToolUse" || group.matcher !== "Bash" || hook.type !== "command" || !(legacyDeploy(hook.command) || hook.command === expected)) fail("ambiguous existing deploy hook")
      slots.push({ group, index: i })
    }
  }
  if (slots.length > 1) fail("duplicate deploy hook slots")
  if (slots.length) {
    const { group, index } = slots[0]
    if (replace) group.hooks[index] = { ...group.hooks[index], command: expected }
    else group.hooks.splice(index, 1)
  } else if (replace) {
    result.hooks ??= {}
    result.hooks.PreToolUse ??= []
    result.hooks.PreToolUse.push({ matcher: "Bash", hooks: [{ type: "command", command: expected }] })
  }
  for (const [event, groups] of Object.entries(result.hooks ?? {})) {
    result.hooks[event] = groups.filter(group => group.hooks?.length)
    if (!result.hooks[event].length) delete result.hooks[event]
  }
  return result
}

export function registeredHookSettings(current, profile, project, registered) {
  if (!registered) {
    for (const settings of [current, project]) for (const groups of Object.values(settings?.hooks ?? {})) for (const group of groups) for (const hook of group.hooks ?? []) {
      if (isRegisteredDeployCommand(hook.command)) fail("registered hook requires its descriptor; legacy rollback refused")
    }
    return { current, profile, project: null }
  }
  return {
    current: rewrite(current, registered.global, false),
    profile: rewrite(profile, registered.global, true),
    project: rewrite(project, registered.project, true),
  }
}

export function registeredCodexHookSettings(user, project, registered) {
  if (!registered) fail("native Codex pair requires its registered descriptor")
  return { user: rewrite(user, registered.global, true), project: rewrite(project, registered.project, true) }
}

export function validateRegisteredSettingsTarget(file) {
  canonical(path.dirname(file), "settings directory")
  const stat = fs.lstatSync(file, { throwIfNoEntry: false })
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || process.getuid() !== 0 && stat.uid !== process.getuid())) fail("invalid settings target owner/type")
}

const installLock = (home, target = "claude") => {
  if (!["claude", "codex"].includes(target)) fail("unknown paired installer target")
  return path.join(home, `.${target}/.registered-deploy-hooks.install.lock`)
}
export function assertRegisteredInstallNotHeld(home, target = "claude") {
  const file = installLock(home, target), stat = fs.lstatSync(file, { throwIfNoEntry: false })
  if (!stat) return
  if (!stat.isFile() || stat.size > 4096) fail("installation operator lock is held; inspect and preserve the unknown lock manually")
  const status = inspectLockOwner(parseLockRecord(fs.readFileSync(file, "utf8")), stat.mtimeMs, { orphanGraceMs: Infinity, unverifiedMaxAgeMs: 0 })
  if (status.alive || !["dead-pid", "zombie-pid", "pid-recycled", "boot-mismatch"].includes(status.reason)) fail("installation operator lock is held; retry after the quiescent install window or inspect an unknown lock manually")
}

// Two concrete settings slots only. The operator keeps hook readers quiescent;
// this lock serializes installers and does not claim a cross-file atomic read.
export function writeRegisteredHookPair(home, globalFile, globalText, projectFile, projectText, stamp, target = "claude") {
  const records = [[globalFile, globalText], [projectFile, projectText]].map(([file, text]) => {
    validateRegisteredSettingsTarget(file)
    fs.accessSync(path.dirname(file), fs.constants.W_OK | fs.constants.X_OK)
    const stat = fs.statSync(file, { throwIfNoEntry: false })
    return { file, text, stat, old: stat ? fs.readFileSync(file) : null }
  })
  if (records.every(record => record.old?.equals(Buffer.from(record.text)))) return []
  const lock = installLock(home, target)
  let lockHandle
  try { lockHandle = acquirePidLockSync(lock, { createParent: false, orphanGraceMs: Infinity, unverifiedMaxAgeMs: 0 }) } catch (error) {
    if (error.code === "EEXIST") fail("installation operator lock is held")
    throw error
  }
  const staged = [], applied = [], nonce = crypto.randomUUID()
  const stage = (record, bytes, kind) => {
    const file = `${record.file}.registered-${nonce}-${kind}`
    const fd = fs.openSync(file, "wx", 0o600)
    staged.push(file)
    try {
      fs.writeFileSync(fd, bytes)
      if (record.stat) fs.fchownSync(fd, record.stat.uid, record.stat.gid)
      fs.fchmodSync(fd, record.stat ? record.stat.mode & 0o777 : 0o600)
      fs.fsyncSync(fd)
    } finally { fs.closeSync(fd) }
    return file
  }
  try {
    for (const record of records) {
      record.next = stage(record, record.text, "next")
      if (record.old !== null) {
        record.restore = stage(record, record.old, "restore")
        const backup = `${record.file}.bak-${stamp}`
        fs.copyFileSync(record.restore, backup, fs.constants.COPYFILE_EXCL)
        fs.chownSync(backup, record.stat.uid, record.stat.gid)
        fs.chmodSync(backup, record.stat.mode & 0o777)
      }
    }
    // Detect an intervening editor before either target is replaced.
    for (const record of records) {
      validateRegisteredSettingsTarget(record.file)
      const current = fs.statSync(record.file, { throwIfNoEntry: false })
      if (record.stat ? !current || current.uid !== record.stat.uid || current.gid !== record.stat.gid || current.mode !== record.stat.mode || !fs.readFileSync(record.file).equals(record.old) : current) fail("settings changed while staging")
    }
    for (const record of records) {
      if (record.old?.equals(Buffer.from(record.text))) continue
      fs.renameSync(record.next, record.file)
      applied.push(record)
    }
    return applied.map(record => record.file)
  } catch (error) {
    const failures = []
    for (const record of [...applied].reverse()) try {
      if (record.old === null) fs.unlinkSync(record.file)
      else fs.renameSync(record.restore, record.file)
    } catch (restoreError) { failures.push(restoreError) }
    if (failures.length) throw new AggregateError([error, ...failures], "registered paired install rollback incomplete; restore preserved backups")
    throw error
  } finally {
    try {
      for (const file of staged) try { fs.unlinkSync(file) } catch (error) { if (error.code !== "ENOENT") throw error }
    } finally {
      lockHandle.release()
    }
  }
}
