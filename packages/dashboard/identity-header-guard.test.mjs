import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { clearGateSecretCache, isGateVerifiedHeaders, stripUntrustedIdentityHeaders } from "./identity-header-guard.mjs"

function request(headers, remote = "127.0.0.1", rawHeaders = []) {
  return { headers, rawHeaders, socket: { remoteAddress: remote } }
}

test("gate verification removes spoofed headers and rejects duplicate secrets and untrusted peers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-gate-"))
  const secretFile = path.join(dir, "gate-key")
  const secret = "a".repeat(48)
  try {
    fs.writeFileSync(secretFile, secret, { mode: 0o600 })
    const env = { NAIA_GATE_SECRET_FILE: secretFile, NAIA_SCHEDULE_USER_HEADER: "x-user" }
    const ok = request({ "x-user": "person-a", "x-naia-gate-secret": secret, "x-naia-gate-verified": "forged" })
    stripUntrustedIdentityHeaders(ok, env)
    assert.equal(ok.headers["x-user"], "person-a")
    assert.equal(ok.headers["x-naia-gate-secret"], undefined)
    assert.equal(isGateVerifiedHeaders(ok.headers, env), true)
    const forged = request({ "x-user": "person-a", "x-naia-gate-verified": ok.headers["x-naia-gate-verified"] })
    stripUntrustedIdentityHeaders(forged, env)
    assert.equal(forged.headers["x-user"], undefined)
    assert.equal(isGateVerifiedHeaders(forged.headers, env), false)
    const remote = request({ "x-user": "person-a", "x-naia-gate-secret": secret }, "192.0.2.10")
    stripUntrustedIdentityHeaders(remote, env)
    assert.equal(remote.headers["x-user"], undefined)
    const duplicate = request({ "x-user": "person-a", "x-naia-gate-secret": secret }, "127.0.0.1", ["X-Naia-Gate-Secret", secret, "X-Naia-Gate-Secret", secret])
    stripUntrustedIdentityHeaders(duplicate, env)
    assert.equal(duplicate.headers["x-user"], undefined)
    fs.chmodSync(secretFile, 0o644)
    const wrongMode = request({ "x-user": "person-a", "x-naia-gate-secret": secret })
    stripUntrustedIdentityHeaders(wrongMode, env)
    assert.equal(isGateVerifiedHeaders(wrongMode.headers, env), false)
  } finally { clearGateSecretCache(); fs.rmSync(dir, { recursive: true, force: true }) }
})
