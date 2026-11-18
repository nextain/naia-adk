import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { handlePersonalScheduleRequest, normalizeScheduleUser } from "./personal-schedule"
import { stripUntrustedIdentityHeaders } from "../../identity-header-guard.mjs"

const secret = "s".repeat(48)
function gated(user: string, env: Record<string, string | undefined>): Headers {
  const req = { headers: { "x-user": user, "x-naia-gate-secret": secret }, socket: { remoteAddress: "127.0.0.1" } }
  stripUntrustedIdentityHeaders(req, env)
  return new Headers(req.headers)
}
function makeRequest(method: string, headers: Headers, body?: object) {
  if (!headers.has("host")) headers.set("host", "localhost")
  if (body) headers.set("content-type", "application/json")
  return new Request("http://localhost/schedule-personal", { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) })
}
type Options = { env: Record<string, string | undefined>; dir: string }
async function revisionHeaders(headers: Headers, opts: Options): Promise<Headers> {
  const res = await handlePersonalScheduleRequest(makeRequest("GET", new Headers(headers)), opts)
  assert.equal(res.status, 200)
  const updated = new Headers(headers)
  updated.set("if-match", (await res.json()).revision)
  return updated
}

test("personal API isolates users, supports edits, and refuses warned files without changing bytes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-api-"))
  const data = path.join(root, "data")
  const key = path.join(root, "gate-key")
  fs.writeFileSync(key, secret, { mode: 0o600 })
  const env = { NAIA_GATE_SECRET_FILE: key, NAIA_SCHEDULE_USER_HEADER: "x-user" }
  const opts = { env, dir: data }
  try {
    let res = await handlePersonalScheduleRequest(makeRequest("GET", new Headers({ "x-user": "person-a" })), opts)
    assert.equal(res.status, 403)
    res = await handlePersonalScheduleRequest(makeRequest("POST", await revisionHeaders(gated("person-a", env), opts), { title: "First", start: "2026-11-11" }), opts)
    assert.equal(res.status, 201)
    const created = await res.json()
    assert.equal(created.items.length, 1)
    const id = created.items[0].id
    res = await handlePersonalScheduleRequest(makeRequest("GET", gated("person-b", env)), opts)
    assert.deepEqual((await res.json()).items, [])
    res = await handlePersonalScheduleRequest(makeRequest("DELETE", await revisionHeaders(gated("person-b", env), opts), { id }), opts)
    assert.equal(res.status, 404)
    res = await handlePersonalScheduleRequest(makeRequest("PATCH", await revisionHeaders(gated("person-a", env), opts), { id, title: "Changed" }), opts)
    assert.equal((await res.json()).items[0].title, "Changed")
    const file = path.join(data, "person-a.yaml")
    fs.appendFileSync(file, "unknown: keep this\n")
    const before = fs.readFileSync(file)
    res = await handlePersonalScheduleRequest(makeRequest("DELETE", await revisionHeaders(gated("person-a", env), opts), { id }), opts)
    assert.equal(res.status, 409)
    assert.deepEqual(fs.readFileSync(file), before)
    assert.equal(normalizeScheduleUser("%2e%2e%2fother"), null)
    assert.equal(normalizeScheduleUser("broken%"), null)
    assert.equal(normalizeScheduleUser("Person-a"), null)
    assert.equal(normalizeScheduleUser("사용자A"), null)
    res = await handlePersonalScheduleRequest(makeRequest("GET", gated("Person-a", env)), opts)
    assert.equal(res.status, 403)
    const cross = gated("person-a", env); cross.set("origin", "https://foreign.invalid")
    res = await handlePersonalScheduleRequest(makeRequest("POST", cross, { title: "x", start: "2026-11-11" }), opts)
    assert.equal(res.status, 403)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test("a revision from one user's missing file cannot create another user's schedule", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-user-revision-"))
  const key = path.join(root, "gate-key")
  fs.writeFileSync(key, secret, { mode: 0o600 })
  const env = { NAIA_GATE_SECRET_FILE: key, NAIA_SCHEDULE_USER_HEADER: "x-user" }
  const opts = { env, dir: path.join(root, "data") }
  try {
    const a = await revisionHeaders(gated("person-a", env), opts)
    const b = await revisionHeaders(gated("person-b", env), opts)
    assert.notEqual(a.get("if-match"), b.get("if-match"))
    const switched = gated("person-b", env)
    switched.set("if-match", a.get("if-match")!)
    const rejected = await handlePersonalScheduleRequest(makeRequest("POST", switched, { title: "Private", start: "2026-11-11" }), opts)
    assert.equal(rejected.status, 409)
    assert.equal((await rejected.json()).error, "personal-schedule-conflict")
    assert.equal(fs.existsSync(path.join(opts.dir, "person-b.yaml")), false)
    const accepted = await handlePersonalScheduleRequest(makeRequest("POST", b, { title: "Own", start: "2026-11-11" }), opts)
    assert.equal(accepted.status, 201)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test("a configured gate ignores the single-user fallback when the identity header is missing or misnamed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-gate-single-"))
  const key = path.join(root, "gate-key")
  fs.writeFileSync(key, secret, { mode: 0o600 })
  try {
    for (const header of [undefined, "x-wrong"]) {
      const env = { NAIA_GATE_SECRET_FILE: key, NAIA_SCHEDULE_SINGLE_USER: "person-a", NAIA_SCHEDULE_USER_HEADER: header }
      const opts = { env, dir: path.join(root, "data") }
      for (const method of ["GET", "POST"]) {
        const res = await handlePersonalScheduleRequest(makeRequest(method, gated("person-b", env), method === "POST" ? { title: "X", start: "2026-11-11" } : undefined), opts)
        assert.equal(res.status, 403)
        assert.equal((await res.json()).error, "personal-schedule-identity-required")
      }
      assert.equal(fs.existsSync(path.join(root, "data", "person-a.yaml")), false)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("stale revisions cannot update, delete, or add over another client's changes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-revision-"))
  const file = path.join(root, "person-a.yaml")
  const opts = { env: { NAIA_SCHEDULE_SINGLE_USER: "person-a" }, dir: root }
  try {
    const missing = await handlePersonalScheduleRequest(makeRequest("POST", new Headers(), { title: "First", start: "2026-11-11" }), opts)
    assert.equal(missing.status, 428)
    const initial = await revisionHeaders(new Headers(), opts)
    const created = await handlePersonalScheduleRequest(makeRequest("POST", new Headers(initial), { title: "First", start: "2026-11-11" }), opts)
    assert.equal(created.status, 201)
    const id = (await created.json()).items[0].id
    const staleAdd = await handlePersonalScheduleRequest(makeRequest("POST", new Headers(initial), { title: "Old", start: "2026-11-11" }), opts)
    assert.equal(staleAdd.status, 409)
    const old = await revisionHeaders(new Headers(), opts)
    const updated = await handlePersonalScheduleRequest(makeRequest("PATCH", new Headers(old), { id, title: "Updated" }), opts)
    assert.equal(updated.status, 200)
    const after = fs.readFileSync(file)
    for (const method of ["PUT", "DELETE"]) {
      const stale = await handlePersonalScheduleRequest(makeRequest(method, new Headers(old), { id, title: "Stale", start: "2026-11-11" }), opts)
      assert.equal(stale.status, 409)
      assert.equal((await stale.json()).error, "personal-schedule-conflict")
      assert.deepEqual(fs.readFileSync(file), after)
    }
    const fresh = await revisionHeaders(new Headers(), opts)
    assert.equal((await handlePersonalScheduleRequest(makeRequest("DELETE", fresh, { id }), opts)).status, 200)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test("mutation origin matches validated request Host, including configured HTTPS gateway", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-origin-"))
  const payload = { title: "Test", start: "2026-11-11" }
  const check = async (host: string, origin: string, external?: string) => {
    const headers = new Headers({ host, origin })
    const env: Record<string, string> = { NAIA_SCHEDULE_SINGLE_USER: "person-a" }
    if (external) env.NAIA_SCHEDULE_PUBLIC_ORIGIN = external
    const opts = { env, dir: root }
    return handlePersonalScheduleRequest(makeRequest("POST", await revisionHeaders(headers, opts), payload), opts)
  }
  try {
    assert.equal((await check("127.0.0.1:3142", "http://127.0.0.1:3142")).status, 201)
    assert.equal((await check("127.0.0.1:3142", "http://127.0.0.1:3143")).status, 403)
    assert.equal((await check("127.0.0.1:3142", "http://foreign.invalid:3142")).status, 403)
    assert.equal((await check("foreign.invalid", "http://foreign.invalid")).status, 403)
    assert.equal((await check("127.0.0.1:3142, foreign.invalid", "http://127.0.0.1:3142")).status, 403)
    assert.equal((await check("127.0.0.1:3142", "https://127.0.0.1:3142")).status, 403)
    assert.equal((await check("localhost", "https://localhost", "https://localhost")).status, 201)
    assert.equal((await check("localhost", "http://localhost", "https://localhost")).status, 403)
    assert.equal((await check("127.0.0.1", "https://127.0.0.1", "https://localhost")).status, 403)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test("external file change before replacement returns conflict and preserves external bytes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-conflict-"))
  const file = path.join(root, "person-a.yaml")
  const env = { NAIA_SCHEDULE_SINGLE_USER: "person-a" }
  const opts = { env, dir: root }
  try {
    const payload = { title: "First", start: "2026-11-11" }
    const first = await handlePersonalScheduleRequest(makeRequest("POST", await revisionHeaders(new Headers(), opts), payload), opts)
    assert.equal(first.status, 201)
    const before = fs.readFileSync(file, "utf8")
    const headers = await revisionHeaders(new Headers(), opts)
    const originalWrite = fs.writeFileSync.bind(fs)
    let changed = false
    t.mock.method(fs, "writeFileSync", ((target: any, ...args: any[]) => {
      const result = (originalWrite as any)(target, ...args)
      if (typeof target === "number" && !changed) {
        changed = true
        fs.appendFileSync(file, "# external edit\n")
      }
      return result
    }) as typeof fs.writeFileSync)
    const result = await handlePersonalScheduleRequest(makeRequest("POST", headers, { title: "Second", start: "2026-11-12" }), opts)
    assert.equal(result.status, 409)
    assert.equal((await result.json()).error, "personal-schedule-conflict")
    assert.equal(fs.readFileSync(file, "utf8"), before + "# external edit\n")
    assert.deepEqual(fs.readdirSync(root).sort(), ["person-a.yaml"])
  } finally { t.mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }) }
})

test("external change during the initial snapshot is detected without writing", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-read-race-"))
  const file = path.join(root, "person-a.yaml")
  const original = 'user: person-a\nitems: []\n'
  fs.writeFileSync(file, original)
  try {
    const opts = { env: { NAIA_SCHEDULE_SINGLE_USER: "person-a" }, dir: root }
    const headers = await revisionHeaders(new Headers(), opts)
    const originalRead = fs.readSync.bind(fs)
    let changed = false
    t.mock.method(fs, "readSync", ((...args: any[]) => {
      const result = (originalRead as any)(...args)
      if (!changed) { changed = true; fs.appendFileSync(file, "# external edit\n") }
      return result
    }) as typeof fs.readSync)
    const result = await handlePersonalScheduleRequest(makeRequest("POST", headers, { title: "Test", start: "2026-11-11" }), opts)
    assert.equal(result.status, 409)
    assert.equal((await result.json()).error, "personal-schedule-conflict")
    assert.equal(fs.readFileSync(file, "utf8"), original + "# external edit\n")
    assert.deepEqual(fs.readdirSync(root).sort(), ["person-a.yaml"])
  } finally { t.mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }) }
})

test("a commented YAML file is not rewritten by dashboard mutations", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-comment-"))
  const file = path.join(root, "person-a.yaml")
  const original = '# keep this comment\nuser: person-a\nitems: []\n'
  fs.writeFileSync(file, original)
  try {
    const opts = { env: { NAIA_SCHEDULE_SINGLE_USER: "person-a" }, dir: root }
    const result = await handlePersonalScheduleRequest(makeRequest("POST", await revisionHeaders(new Headers(), opts), { title: "Test", start: "2026-11-11" }), opts)
    assert.equal(result.status, 409)
    assert.equal((await result.json()).error, "personal-schedule-has-warnings")
    assert.equal(fs.readFileSync(file, "utf8"), original)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
