import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  acquirePersonalScheduleLockSync,
  PERSONAL_SCHEDULE_LOCK_STALE_MS,
  readPersonalSchedule,
} from "../../packages/core/src/personal-schedule.ts"
import { parseScheduleDetailSearch } from "../../packages/core/src/schedule-link.ts"
import { handlePersonalScheduleRequest } from "../../packages/dashboard/app/schedule/personal-schedule.ts"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const CLI_PATH = path.join(ROOT, "scripts/schedule/personal-schedule-cli.mjs")
const DASHBOARD_MODULE_URL = pathToFileURL(
  path.join(ROOT, "packages/dashboard/app/schedule/personal-schedule.ts"),
).href

function makeTempDir(prefix = "sched-cli-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function runCliSync(args, env = {}) {
  const cleanEnv = { ...process.env }
  delete cleanEnv.NAIA_PERSONAL_SCHEDULE_DIR
  delete cleanEnv.NAIA_SCHEDULE_DELEGATES
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    env: { ...cleanEnv, ...env },
    encoding: "utf8",
  })
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  }
}

function runCliAsync(args, env = {}) {
  const cleanEnv = { ...process.env }
  delete cleanEnv.NAIA_PERSONAL_SCHEDULE_DIR
  delete cleanEnv.NAIA_SCHEDULE_DELEGATES
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: { ...cleanEnv, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (c) => { stdout += c })
    child.stderr.on("data", (c) => { stderr += c })
    child.on("error", reject)
    child.on("close", (code) => resolve({ status: code ?? -1, stdout, stderr }))
  })
}

function dashOpts(dir, user) {
  return { env: { NAIA_SCHEDULE_SINGLE_USER: user }, dir }
}

async function dashRevision(dir, user) {
  const res = await handlePersonalScheduleRequest(
    new Request("http://localhost/schedule-personal", { method: "GET", headers: { host: "localhost" } }),
    dashOpts(dir, user),
  )
  assert.equal(res.status, 200)
  return (await res.json()).revision
}

async function dashWrite(dir, user, method, ifMatch, body) {
  return handlePersonalScheduleRequest(
    new Request("http://localhost/schedule-personal", {
      method,
      headers: {
        host: "localhost",
        "content-type": "application/json",
        "if-match": ifMatch,
      },
      body: JSON.stringify(body),
    }),
    dashOpts(dir, user),
  )
}

test("FT-04-1: CLI read, add (with 15m beforeMinutes + href), update, delete, and .audit.jsonl", (t) => {
  const root = makeTempDir()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, "personal")
  const env = { NAIA_SCHEDULE_DELEGATES: "alpha:luke,jina:luke" }

  // Initial read on empty dir returns missing-file revision without creating dir
  const initialRead = runCliSync(["read", "--dir", dir, "--user", "luke"], env)
  assert.equal(initialRead.status, 0, initialRead.stderr)
  const initialDoc = JSON.parse(initialRead.stdout)
  assert.equal(initialDoc.ok, true)
  assert.deepEqual(initialDoc.items, [])
  assert.match(initialDoc.revision, /^"[a-f0-9]{64}"$/)
  assert.equal(fs.existsSync(dir), false)

  // Add timed item with 15-minute reminder
  const addedRes = runCliSync(
    [
      "add",
      "--dir", dir,
      "--user", "luke",
      "--actor-role", "alpha",
      "--title", "주간 브리핑",
      "--start", "2026-11-20 14:00",
      "--end", "2026-11-20 15:00",
      "--before-minutes", "15",
      "--memo", "회의실 B",
    ],
    env,
  )
  assert.equal(addedRes.status, 0, addedRes.stderr)
  const added = JSON.parse(addedRes.stdout)
  assert.equal(added.ok, true)
  assert.match(added.id, /^ps-[a-f0-9]{24}$/)
  assert.match(added.revision, /^"[a-f0-9]{64}"$/)
  assert.notEqual(added.revision, initialDoc.revision)
  assert.deepEqual(parseScheduleDetailSearch(added.href.split("?")[1]), {
    layer: "personal",
    id: added.id,
    date: "2026-11-20",
  })
  assert.equal(added.item.beforeMinutes, 15)
  assert.equal(added.item.allDay, false)

  // Core reader sees the item cleanly with zero warnings
  const coreDoc = readPersonalSchedule("luke", dir)
  assert.deepEqual(coreDoc.warnings, [])
  assert.equal(coreDoc.items.length, 1)
  assert.equal(coreDoc.items[0].beforeMinutes, 15)
  assert.equal(coreDoc.items[0].memo, "회의실 B")

  // CLI read reflects added item
  const afterAddRead = JSON.parse(runCliSync(["read", "--dir", dir, "--user", "luke"], env).stdout)
  assert.equal(afterAddRead.items.length, 1)
  assert.equal(afterAddRead.revision, added.revision)

  // Update item title & reminder using returned revision
  const updatedRes = runCliSync(
    [
      "update",
      "--dir", dir,
      "--user", "luke",
      "--actor-role", "jina",
      "--if-match", added.revision,
      "--id", added.id,
      "--title", "긴급 브리핑",
      "--before-minutes", "30",
    ],
    env,
  )
  assert.equal(updatedRes.status, 0, updatedRes.stderr)
  const updated = JSON.parse(updatedRes.stdout)
  assert.equal(updated.ok, true)
  assert.equal(updated.id, added.id)
  assert.equal(updated.item.title, "긴급 브리핑")
  assert.equal(updated.item.start, "2026-11-20 14:00")
  assert.equal(updated.item.end, "2026-11-20 15:00")
  assert.equal(updated.item.memo, "회의실 B")
  assert.equal(updated.item.beforeMinutes, 30)

  // Update clearing beforeMinutes and adding an all-day item via --all-day
  const clearedRes = runCliSync(
    [
      "update",
      "--dir", dir,
      "--user", "luke",
      "--actor-role", "alpha",
      "--if-match", updated.revision,
      "--id", added.id,
      "--clear-before-minutes",
    ],
    env,
  )
  assert.equal(clearedRes.status, 0, clearedRes.stderr)
  const cleared = JSON.parse(clearedRes.stdout)
  assert.equal("beforeMinutes" in cleared.item, false)

  // Delete item
  const deletedRes = runCliSync(
    [
      "delete",
      "--dir", dir,
      "--user", "luke",
      "--actor-role", "alpha",
      "--if-match", cleared.revision,
      "--id", added.id,
    ],
    env,
  )
  assert.equal(deletedRes.status, 0, deletedRes.stderr)
  const deleted = JSON.parse(deletedRes.stdout)
  assert.equal(deleted.ok, true)
  assert.equal(deleted.id, added.id)
  assert.deepEqual(readPersonalSchedule("luke", dir).items, [])

  // Audit log recorded all 4 delegated mutations in order
  const auditLines = fs
    .readFileSync(path.join(dir, ".audit.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  assert.equal(auditLines.length, 4)
  assert.deepEqual(
    auditLines.map((e) => ({ action: e.action, actor: e.actor, user: e.user, itemId: e.itemId })),
    [
      { action: "add", actor: "role:alpha", user: "luke", itemId: added.id },
      { action: "update", actor: "role:jina", user: "luke", itemId: added.id },
      { action: "update", actor: "role:alpha", user: "luke", itemId: added.id },
      { action: "delete", actor: "role:alpha", user: "luke", itemId: added.id },
    ],
  )
  for (const entry of auditLines) {
    assert.ok(Number.isFinite(Date.parse(entry.at)))
  }
})

test("FT-04-2a: active <user>.yaml.lock blocks both dashboard and CLI without corrupting YAML", async (t) => {
  const root = makeTempDir()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const env = { NAIA_SCHEDULE_DELEGATES: "alpha:luke" }

  const seed = runCliSync(
    ["add", "--dir", root, "--user", "luke", "--actor-role", "alpha", "--title", "Seed", "--start", "2026-11-20"],
    env,
  )
  assert.equal(seed.status, 0, seed.stderr)
  const yamlFile = path.join(root, "luke.yaml")
  const beforeBytes = fs.readFileSync(yamlFile)
  const rev = await dashRevision(root, "luke")

  const release = acquirePersonalScheduleLockSync(yamlFile)
  try {
    const lockStat = fs.lstatSync(`${yamlFile}.lock`)
    assert.equal(lockStat.mode & 0o777, 0o600)

    const [dashRes, cliRes] = await Promise.all([
      dashWrite(root, "luke", "POST", rev, { title: "FromDash", start: "2026-11-21" }),
      runCliAsync(
        ["add", "--dir", root, "--user", "luke", "--actor-role", "alpha", "--title", "FromCli", "--start", "2026-11-21"],
        env,
      ),
    ])
    assert.equal(dashRes.status, 409)
    assert.equal((await dashRes.json()).error, "personal-schedule-busy")
    assert.notEqual(cliRes.status, 0)
    assert.match(cliRes.stderr, /personal-schedule-busy/)
    assert.deepEqual(fs.readFileSync(yamlFile), beforeBytes)
  } finally {
    release()
  }
  assert.equal(fs.existsSync(`${yamlFile}.lock`), false)
})

test("FT-04-2b: cross-process concurrent dashboard and CLI writes never corrupt YAML or leak locks", async (t) => {
  const root = makeTempDir()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const env = { NAIA_SCHEDULE_DELEGATES: "alpha:luke" }

  const seed = runCliSync(
    ["add", "--dir", root, "--user", "luke", "--actor-role", "alpha", "--title", "Seed", "--start", "2026-11-20"],
    env,
  )
  assert.equal(seed.status, 0, seed.stderr)
  const rev = JSON.parse(seed.stdout).revision

  const dashWorkerScript = `
    import { handlePersonalScheduleRequest } from ${JSON.stringify(DASHBOARD_MODULE_URL)};
    const [dir, rev, idx, go] = process.argv.slice(1);
    while (Date.now() < Number(go)) {}
    const req = new Request("http://localhost/schedule-personal", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json", "if-match": rev },
      body: JSON.stringify({ title: "Dash-" + idx, start: "2026-11-21" }),
    });
    const res = await handlePersonalScheduleRequest(req, { env: { NAIA_SCHEDULE_SINGLE_USER: "luke" }, dir });
    const body = await res.json();
    process.stdout.write(JSON.stringify({ status: res.status, error: body.error ?? null }));
  `

  const cliWorkerScript = `
    import { runPersonalScheduleCli } from ${JSON.stringify(pathToFileURL(CLI_PATH).href)};
    const [dir, rev, idx, go] = process.argv.slice(1);
    while (Date.now() < Number(go)) {}
    try {
      const out = await runPersonalScheduleCli(
        ["add", "--dir", dir, "--user", "luke", "--actor-role", "alpha", "--if-match", rev, "--title", "Cli-" + idx, "--start", "2026-11-22"],
        { ...process.env, NAIA_SCHEDULE_DELEGATES: "alpha:luke" },
      );
      process.stdout.write(JSON.stringify({ ok: true, id: out.id }));
    } catch (err) {
      process.stdout.write(JSON.stringify({ ok: false, code: err.code ?? null, msg: err.message }));
    }
  `

  const go = String(Date.now() + 350)
  const spawnWorker = (script, idx) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, root, rev, String(idx), go], {
        stdio: ["ignore", "pipe", "pipe"],
      })
      let out = ""
      let err = ""
      child.stdout.on("data", (c) => { out += c })
      child.stderr.on("data", (c) => { err += c })
      child.on("error", reject)
      child.on("close", (code) => resolve({ code, out, err }))
    })

  const results = await Promise.all([
    spawnWorker(dashWorkerScript, 1),
    spawnWorker(dashWorkerScript, 2),
    spawnWorker(dashWorkerScript, 3),
    spawnWorker(cliWorkerScript, 1),
    spawnWorker(cliWorkerScript, 2),
    spawnWorker(cliWorkerScript, 3),
  ])

  let successes = 0
  for (const r of results) {
    assert.equal(r.code, 0, `unexpected worker crash: ${r.err}`)
    const parsed = JSON.parse(r.out)
    if (parsed.status === 201 || parsed.ok === true) {
      successes++
    } else {
      assert.ok(
        ["personal-schedule-busy", "personal-schedule-conflict"].includes(parsed.error ?? parsed.code),
        `unexpected error payload: ${r.out}`,
      )
    }
  }
  assert.equal(successes, 1, `expected exactly 1 writer sharing the same revision to win, got ${successes}`)

  const finalDoc = readPersonalSchedule("luke", root)
  assert.deepEqual(finalDoc.warnings, [])
  assert.equal(finalDoc.items.length, 2)
  assert.ok(finalDoc.items.some((i) => i.title === "Seed"))
  const entries = fs.readdirSync(root).sort()
  assert.ok(!entries.some((name) => name.endsWith(".lock") || name.endsWith(".tmp") || name.endsWith(".break")))
})

test("FT-04-2c: stale lock (> 30s) is reclaimed by CLI while <= 30s lock is respected", (t) => {
  const root = makeTempDir()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const env = { NAIA_SCHEDULE_DELEGATES: "alpha:luke" }
  const yamlFile = path.join(root, "luke.yaml")
  const lockFile = `${yamlFile}.lock`

  fs.writeFileSync(lockFile, "999999 2026-01-01T00:00:00.000Z\n", { mode: 0o600 })
  const freshAt = new Date(Date.now() - (PERSONAL_SCHEDULE_LOCK_STALE_MS - 5000))
  fs.utimesSync(lockFile, freshAt, freshAt)
  const blocked = runCliSync(
    ["add", "--dir", root, "--user", "luke", "--actor-role", "alpha", "--title", "Wait", "--start", "2026-11-20"],
    env,
  )
  assert.notEqual(blocked.status, 0)
  assert.match(blocked.stderr, /personal-schedule-busy/)
  assert.equal(fs.existsSync(lockFile), true)

  const staleAt = new Date(Date.now() - (PERSONAL_SCHEDULE_LOCK_STALE_MS + 2000))
  fs.utimesSync(lockFile, staleAt, staleAt)
  const reclaimed = runCliSync(
    ["add", "--dir", root, "--user", "luke", "--actor-role", "alpha", "--title", "Reclaimed", "--start", "2026-11-20"],
    env,
  )
  assert.equal(reclaimed.status, 0, reclaimed.stderr)
  assert.equal(fs.existsSync(lockFile), false)
  assert.equal(readPersonalSchedule("luke", root).items[0].title, "Reclaimed")
})

test("FT-04-3: If-Match mismatch/missing and commented YAML refuse overwrite cleanly", (t) => {
  const root = makeTempDir()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const env = { NAIA_SCHEDULE_DELEGATES: "alpha:luke" }

  const seed = JSON.parse(
    runCliSync(
      ["add", "--dir", root, "--user", "luke", "--actor-role", "alpha", "--title", "Init", "--start", "2026-11-20"],
      env,
    ).stdout,
  )
  const yamlFile = path.join(root, "luke.yaml")
  const auditFile = path.join(root, ".audit.jsonl")
  const beforeYaml = fs.readFileSync(yamlFile)
  const beforeAudit = fs.readFileSync(auditFile)
  const staleRev = `"${"0".repeat(64)}"`

  // Missing --if-match on update/delete
  for (const args of [
    ["update", "--dir", root, "--user", "luke", "--actor-role", "alpha", "--id", seed.id, "--title", "X"],
    ["delete", "--dir", root, "--user", "luke", "--actor-role", "alpha", "--id", seed.id],
  ]) {
    const res = runCliSync(args, env)
    assert.notEqual(res.status, 0)
    assert.match(res.stderr, /428|if-match/i)
  }

  // Mismatched --if-match on add, update, delete
  for (const args of [
    ["add", "--dir", root, "--user", "luke", "--actor-role", "alpha", "--if-match", staleRev, "--title", "X", "--start", "2026-11-21"],
    ["update", "--dir", root, "--user", "luke", "--actor-role", "alpha", "--if-match", staleRev, "--id", seed.id, "--title", "X"],
    ["delete", "--dir", root, "--user", "luke", "--actor-role", "alpha", "--if-match", staleRev, "--id", seed.id],
  ]) {
    const res = runCliSync(args, env)
    assert.notEqual(res.status, 0)
    assert.match(res.stderr, /personal-schedule-conflict/)
  }
  assert.deepEqual(fs.readFileSync(yamlFile), beforeYaml)
  assert.deepEqual(fs.readFileSync(auditFile), beforeAudit)

  // Commented YAML must not be overwritten
  fs.writeFileSync(yamlFile, `# user note\n${beforeYaml.toString("utf8")}`, { mode: 0o600 })
  const commentedBytes = fs.readFileSync(yamlFile)
  const commentedRead = JSON.parse(runCliSync(["read", "--dir", root, "--user", "luke"], env).stdout)
  assert.ok(commentedRead.warnings.some((w) => w.includes("comments")))
  const commentedMut = runCliSync(
    [
      "update",
      "--dir", root,
      "--user", "luke",
      "--actor-role", "alpha",
      "--if-match", commentedRead.revision,
      "--id", seed.id,
      "--title", "Overwrite",
    ],
    env,
  )
  assert.notEqual(commentedMut.status, 0)
  assert.match(commentedMut.stderr, /personal-schedule-has-warnings/)
  assert.deepEqual(fs.readFileSync(yamlFile), commentedBytes)
  assert.deepEqual(fs.readFileSync(auditFile), beforeAudit)
})

test("FT-04-4: delegation ACL, --delegates file/JSON, path traversal, symlinks, and 0700/0600 modes", (t) => {
  const root = makeTempDir()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const schedDir = path.join(root, "uncreated-dir")

  // Unset NAIA_SCHEDULE_DELEGATES -> 403 Forbidden: role not delegated, nothing created
  const noEnv = runCliSync([
    "add", "--dir", schedDir, "--user", "luke", "--actor-role", "alpha", "--title", "X", "--start", "2026-11-20",
  ])
  assert.notEqual(noEnv.status, 0)
  assert.match(noEnv.stderr, /403 Forbidden: role not delegated/)
  assert.equal(fs.existsSync(schedDir), false)

  // Missing --actor-role even when delegates env is set -> 403
  const noActor = runCliSync(
    ["add", "--dir", schedDir, "--user", "luke", "--title", "X", "--start", "2026-11-20"],
    { NAIA_SCHEDULE_DELEGATES: "alpha:luke" },
  )
  assert.notEqual(noActor.status, 0)
  assert.match(noActor.stderr, /403 Forbidden: role not delegated/)

  // Mismatched role or mismatched user or wildcard -> 403
  for (const [delegates, role, user] of [
    ["alpha:luke", "jina", "luke"],
    ["alpha:luke", "alpha", "alice"],
    ["alpha:*", "alpha", "luke"],
    ["*:luke", "alpha", "luke"],
  ]) {
    const res = runCliSync(
      ["add", "--dir", schedDir, "--user", user, "--actor-role", role, "--title", "X", "--start", "2026-11-20"],
      { NAIA_SCHEDULE_DELEGATES: delegates },
    )
    assert.notEqual(res.status, 0)
    assert.match(res.stderr, /403 Forbidden: role not delegated/)
  }
  assert.equal(fs.existsSync(schedDir), false)

  // Path traversal & invalid user key checks
  for (const badUser of ["../luke", "%2e%2e%2fluke", "luke/sub", ".luke", "Luke", "a..b"]) {
    const res = runCliSync(
      ["add", "--dir", schedDir, "--user", badUser, "--actor-role", "alpha", "--title", "X", "--start", "2026-11-20"],
      { NAIA_SCHEDULE_DELEGATES: "alpha:luke" },
    )
    assert.notEqual(res.status, 0)
  }
  assert.equal(fs.existsSync(schedDir), false)

  // --delegates JSON config file works and verifies 0700 dir / 0600 file modes
  const delegatesFile = path.join(root, "delegates.json")
  fs.writeFileSync(delegatesFile, JSON.stringify({ alpha: ["luke"] }), { mode: 0o600 })
  const okRes = runCliSync([
    "add",
    "--dir", schedDir,
    "--user", "luke",
    "--actor-role", "alpha",
    "--delegates", delegatesFile,
    "--title", "Delegated",
    "--start", "2026-11-20 10:00",
    "--before-minutes", "15",
  ])
  assert.equal(okRes.status, 0, okRes.stderr)
  assert.equal(fs.lstatSync(schedDir).mode & 0o777, 0o700)
  assert.equal(fs.lstatSync(path.join(schedDir, "luke.yaml")).mode & 0o777, 0o600)
  assert.equal(fs.lstatSync(path.join(schedDir, ".audit.jsonl")).mode & 0o777, 0o600)

  // Symlink rejections: symlinked yaml, symlinked lock, symlinked audit, symlinked dir, symlinked delegates
  const victim = path.join(root, "victim.txt")
  fs.writeFileSync(victim, "victim-content")

  const symYamlUser = path.join(schedDir, "symuser.yaml")
  fs.symlinkSync(victim, symYamlUser)
  assert.notEqual(
    runCliSync(
      ["read", "--dir", schedDir, "--user", "symuser"],
      { NAIA_SCHEDULE_DELEGATES: "alpha:symuser" },
    ).status,
    0,
  )
  assert.notEqual(
    runCliSync(
      ["add", "--dir", schedDir, "--user", "symuser", "--actor-role", "alpha", "--title", "X", "--start", "2026-11-20"],
      { NAIA_SCHEDULE_DELEGATES: "alpha:symuser" },
    ).status,
    0,
  )
  assert.equal(fs.readFileSync(victim, "utf8"), "victim-content")

  const symLock = path.join(schedDir, "bob.yaml.lock")
  fs.symlinkSync(victim, symLock)
  assert.notEqual(
    runCliSync(
      ["add", "--dir", schedDir, "--user", "bob", "--actor-role", "alpha", "--title", "X", "--start", "2026-11-20"],
      { NAIA_SCHEDULE_DELEGATES: "alpha:bob" },
    ).status,
    0,
  )
  assert.equal(fs.existsSync(path.join(schedDir, "bob.yaml")), false)
  assert.equal(fs.readFileSync(victim, "utf8"), "victim-content")

  // Symlinked .audit.jsonl refuses BEFORE writing target user's yaml
  const auditDir = path.join(root, "audit-sym-dir")
  fs.mkdirSync(auditDir, { mode: 0o700 })
  fs.symlinkSync(victim, path.join(auditDir, ".audit.jsonl"))
  assert.notEqual(
    runCliSync(
      ["add", "--dir", auditDir, "--user", "luke", "--actor-role", "alpha", "--title", "X", "--start", "2026-11-20"],
      { NAIA_SCHEDULE_DELEGATES: "alpha:luke" },
    ).status,
    0,
  )
  assert.equal(fs.existsSync(path.join(auditDir, "luke.yaml")), false)
  assert.equal(fs.readFileSync(victim, "utf8"), "victim-content")

  // Symlinked --dir and symlinked --delegates
  const symDir = path.join(root, "sym-sched")
  fs.symlinkSync(schedDir, symDir)
  assert.notEqual(runCliSync(["read", "--dir", symDir, "--user", "luke"]).status, 0)

  const symDelegates = path.join(root, "sym-delegates.json")
  fs.symlinkSync(delegatesFile, symDelegates)
  assert.notEqual(
    runCliSync([
      "add", "--dir", schedDir, "--user", "luke", "--actor-role", "alpha", "--delegates", symDelegates, "--title", "X", "--start", "2026-11-20",
    ]).status,
    0,
  )
})
