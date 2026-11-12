// #129(메신저 게이트)와 #130(일정 신원 가드)을 합친 입구 순서 시험: 같은 로그인 게이트 요청이
// 메신저 API 쪽에는 계정과 확인 표시로, 개인 일정 쪽에는 확인된 일정 신원으로 닿아야 한다.
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { createRequestHandler } from "./server.mjs"
import { isGateVerifiedHeaders } from "./identity-header-guard.mjs"

const secret = "g".repeat(48)
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)))

describe("합친 입구: 메신저 게이트와 일정 신원 가드", () => {
  const seen = { api: null, next: null }
  let root, env, apiServer, dashServer, dashPort, savedApiPort

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "merged-identity-"))
    const key = path.join(root, "gate-key")
    fs.writeFileSync(key, secret, { mode: 0o600 })
    env = { NAIA_GATE_SECRET_FILE: key, NAIA_SCHEDULE_USER_HEADER: "x-ax-account-key" }
    apiServer = http.createServer((req, res) => { seen.api = req.headers; res.setHeader("content-type", "application/json"); res.end("[]") })
    savedApiPort = process.env.NAIA_API_PORT
    process.env.NAIA_API_PORT = String(await listen(apiServer))
    dashServer = http.createServer(createRequestHandler((req, res) => { seen.next = { ...req.headers }; res.end("ok") }, env))
    dashPort = await listen(dashServer)
  })
  after(() => {
    apiServer.close(); dashServer.close()
    if (savedApiPort === undefined) delete process.env.NAIA_API_PORT; else process.env.NAIA_API_PORT = savedApiPort
    fs.rmSync(root, { recursive: true, force: true })
  })

  const get = (pathname, headers) => new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: dashPort, path: pathname, headers: { host: `localhost:${dashPort}`, ...headers } }, (res) => {
      res.resume(); res.on("end", () => resolve(res.statusCode))
    }).on("error", reject)
  })

  it("게이트 비밀이 맞으면 메신저 API 에는 계정·확인 표시가, 일정 화면에는 확인된 신원이 간다", async () => {
    const gate = { "x-naia-gate-secret": secret, "x-ax-account-key": "viewer" }
    assert.equal(await get("/api/portal/messenger/channels", gate), 200)
    assert.equal(seen.api["x-ax-account-key"], "viewer")
    assert.equal(seen.api["x-naia-gate-verified"], "1")
    assert.equal(seen.api["x-naia-gate-secret"], undefined)
    assert.equal(await get("/schedule-personal", gate), 200)
    assert.equal(seen.next["x-ax-account-key"], "viewer")
    assert.equal(seen.next["x-naia-gate-secret"], undefined)
    assert.ok(isGateVerifiedHeaders(seen.next, env))
  })

  it("비밀 없이 계정 머리글만 꾸미면 양쪽 모두 신원이 없다", async () => {
    const forged = { "x-ax-account-key": "other", "x-naia-gate-verified": "1" }
    await get("/api/portal/messenger/channels", forged)
    assert.equal(seen.api["x-ax-account-key"], undefined)
    assert.equal(seen.api["x-naia-gate-verified"], undefined)
    await get("/schedule-personal", forged)
    assert.equal(seen.next["x-ax-account-key"], undefined)
    assert.ok(!isGateVerifiedHeaders(seen.next, env))
  })
})
