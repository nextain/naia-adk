import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import { clearGateSecretCache, GATE_SECRET_HEADER } from "./gate-secret.mjs"
import { applyMessengerIdentity, MESSENGER_GATE_MARK_HEADER, verifyMessengerGate } from "./messenger-gate.mjs"
import { createRequestHandler } from "./server.mjs"

const SECRET = "gate-secret-".padEnd(64, "x")
const CHANNELS = "/api/portal/messenger/channels"
const socket = { remoteAddress: "127.0.0.1" }
const prevEnv = {}
const ENV_KEYS = ["NAIA_GATE_SECRET_FILE", "NAIA_API_PORT", "NAIA_NOTE_USER_HEADER"]
let dir

function gateRequest(extra = {}) {
  return {
    url: CHANNELS,
    socket,
    headers: { [GATE_SECRET_HEADER]: SECRET, "x-ax-account-key": "kim", "x-ax-user": "%EA%B9%80", ...extra },
  }
}

function forwarded(req, env) {
  const out = { ...req.headers }
  verifyMessengerGate(req, env)
  applyMessengerIdentity(out, req, env)
  return out
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    prevEnv[key] = process.env[key]
    delete process.env[key]
  }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "messenger-gate-"))
  clearGateSecretCache()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (prevEnv[key] === undefined) delete process.env[key]
    else process.env[key] = prevEnv[key]
  }
  fs.rmSync(dir, { recursive: true, force: true })
  clearGateSecretCache()
})

function secretEnv(mode = 0o600) {
  const file = path.join(dir, "gate-secret")
  fs.writeFileSync(file, SECRET, { mode })
  fs.chmodSync(file, mode)
  return { NAIA_GATE_SECRET_FILE: file }
}

describe("메신저 게이트 확인", () => {
  it("비밀이 맞으면 계정·표시 이름과 표시를 넘긴다", () => {
    const out = forwarded(gateRequest(), secretEnv())
    assert.equal(out["x-ax-account-key"], "kim")
    assert.equal(out["x-ax-user"], "%EA%B9%80")
    assert.equal(out[MESSENGER_GATE_MARK_HEADER], "1")
  })

  it("비밀이 설정되지 않았으면 사람 신원을 모두 지운다", () => {
    const out = forwarded(gateRequest(), {})
    assert.equal(out["x-ax-account-key"], undefined)
    assert.equal(out["x-ax-user"], undefined)
    assert.equal(out[MESSENGER_GATE_MARK_HEADER], undefined)
  })

  it("비밀 파일 권한이 0600 이 아니면 비밀이 없는 것으로 본다", () => {
    const out = forwarded(gateRequest(), secretEnv(0o640))
    assert.equal(out[MESSENGER_GATE_MARK_HEADER], undefined)
    assert.equal(out["x-ax-user"], undefined)
  })

  it("비밀이 틀리거나 없거나 두 번 오거나, 믿지 않는 출처면 지운다", () => {
    const env = secretEnv()
    const cases = [
      gateRequest({ [GATE_SECRET_HEADER]: "wrong".padEnd(64, "y") }),
      (({ [GATE_SECRET_HEADER]: _s, ...headers }) => ({ url: CHANNELS, socket, headers }))(gateRequest().headers),
      { ...gateRequest(), rawHeaders: [GATE_SECRET_HEADER, SECRET, GATE_SECRET_HEADER, SECRET] },
      { ...gateRequest(), socket: { remoteAddress: "10.0.0.9" } },
    ]
    for (const req of cases) {
      const out = forwarded(req, env)
      assert.equal(out[MESSENGER_GATE_MARK_HEADER], undefined)
      assert.equal(out["x-ax-account-key"], undefined)
      assert.equal(out["x-ax-user"], undefined)
    }
  })

  it("계정 머리글이 없거나 모양이 틀리면 지운다", () => {
    const env = secretEnv()
    for (const account of [undefined, "Kim", "a", "김", "a,b"]) {
      const req = gateRequest({ "x-ax-account-key": account })
      if (account === undefined) delete req.headers["x-ax-account-key"]
      const out = forwarded(req, env)
      assert.equal(out[MESSENGER_GATE_MARK_HEADER], undefined)
      assert.equal(out["x-ax-user"], undefined)
    }
  })

  it("확인된 요청이라도 표시 이름 머리글이 두 번 오면 표시 이름은 넘기지 않는다", () => {
    const req = { ...gateRequest(), rawHeaders: ["x-ax-user", "%EB%B0%95", "x-ax-user", "%EA%B9%80"] }
    const out = forwarded(req, secretEnv())
    assert.equal(out[MESSENGER_GATE_MARK_HEADER], "1")
    assert.equal(out["x-ax-account-key"], "kim")
    assert.equal(out["x-ax-user"], undefined)
  })

  it("요청이 꾸민 표시는 믿지 않는다", () => {
    const out = forwarded(gateRequest({ [GATE_SECRET_HEADER]: "no", [MESSENGER_GATE_MARK_HEADER]: "1" }), secretEnv())
    // 프록시가 x-naia-* 를 먼저 지운다. 여기서는 표시를 새로 붙이지 않는지만 본다.
    assert.equal(out["x-ax-user"], undefined)
    assert.equal(out["x-ax-account-key"], undefined)
  })

  it("NAIA_NOTE_USER_HEADER 로 바꾼 표시 이름 머리글도 지운다", () => {
    const out = forwarded(gateRequest({ "x-custom-user": "kim" }), { NAIA_NOTE_USER_HEADER: "X-Custom-User" })
    assert.equal(out["x-custom-user"], undefined)
  })

  it("메신저가 아닌 길은 그대로 둔다", () => {
    for (const url of ["/api/portal", "/api/portal/messengerx", "/api/portal/notes"]) {
      const req = { ...gateRequest(), url }
      const out = forwarded(req, {})
      assert.equal(out["x-ax-user"], "%EA%B9%80")
      assert.equal(out["x-ax-account-key"], "kim")
      assert.equal(out[MESSENGER_GATE_MARK_HEADER], undefined)
    }
  })
})

describe("대시보드 프록시를 거친 메신저 요청", () => {
  async function throughDashboard(requestHeaders, url = CHANNELS) {
    let seen
    const api = http.createServer((req, res) => {
      seen = req.headers
      res.end("{}")
    })
    await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve))
    process.env.NAIA_API_PORT = String(api.address().port)
    const dash = http.createServer(createRequestHandler(() => assert.fail("Next 로 가면 안 된다")))
    await new Promise((resolve) => dash.listen(0, "127.0.0.1", resolve))
    try {
      const res = await fetch(`http://127.0.0.1:${dash.address().port}${url}`, {
        headers: { host: `127.0.0.1:${dash.address().port}`, ...requestHeaders },
      })
      assert.equal(res.status, 200)
      return seen
    } finally {
      await new Promise((resolve) => dash.close(resolve))
      await new Promise((resolve) => api.close(resolve))
    }
  }

  it("맞는 비밀이면 표시를 붙이고 비밀 자체는 API 로 넘기지 않는다", async () => {
    process.env.NAIA_GATE_SECRET_FILE = secretEnv().NAIA_GATE_SECRET_FILE
    const seen = await throughDashboard({ [GATE_SECRET_HEADER]: SECRET, "x-ax-account-key": "kim", "x-ax-user": "kim" })
    assert.equal(seen[MESSENGER_GATE_MARK_HEADER], "1")
    assert.equal(seen["x-ax-account-key"], "kim")
    assert.equal(seen["x-ax-user"], "kim")
    assert.equal(seen[GATE_SECRET_HEADER], undefined)
  })

  it("게이트를 건너뛴 요청은 사람 신원 없이 넘어가고 꾸민 표시도 지운다", async () => {
    process.env.NAIA_GATE_SECRET_FILE = secretEnv().NAIA_GATE_SECRET_FILE
    const seen = await throughDashboard({ "x-ax-account-key": "kim", "x-ax-user": "kim", [MESSENGER_GATE_MARK_HEADER]: "1" })
    assert.equal(seen[MESSENGER_GATE_MARK_HEADER], undefined)
    assert.equal(seen["x-ax-account-key"], undefined)
    assert.equal(seen["x-ax-user"], undefined)
  })

  it("비밀이 설정되지 않은 대시보드는 맞는 값을 보내도 표시를 붙이지 않는다", async () => {
    const seen = await throughDashboard({ [GATE_SECRET_HEADER]: SECRET, "x-ax-account-key": "kim", "x-ax-user": "kim" })
    assert.equal(seen[MESSENGER_GATE_MARK_HEADER], undefined)
    assert.equal(seen["x-ax-user"], undefined)
  })

  it("메모 등 다른 길의 x-ax-user 는 비밀이 없을 때 기준선처럼 넘어간다", async () => {
    const seen = await throughDashboard({ "x-ax-user": "kim" }, "/api/portal")
    assert.equal(seen["x-ax-user"], "kim")
    assert.equal(seen[MESSENGER_GATE_MARK_HEADER], undefined)
  })
})
