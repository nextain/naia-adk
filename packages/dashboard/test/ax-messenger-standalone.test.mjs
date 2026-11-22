import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"

const sourceDashboard = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
import { test } from "node:test"

// Run after the production build, with TMPDIR outside the workspace tree.
test("standalone carries the guarded dashboard and a loadable Matrix client", async () => {
  const output = path.join(sourceDashboard, ".next/standalone")
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ax-standalone-"))
  const copy = path.join(temporary, "standalone")
  try {
    fs.cpSync(output, copy, { recursive: true, verbatimSymlinks: true })
    const dashboard = path.join(copy, "packages/dashboard")
    const entry = path.join(dashboard, "server.mjs")
    assert.ok(fs.existsSync(entry), "standalone must include the custom guarded server")
    const sdkLink = path.join(copy, "packages/ax-messenger/node_modules/matrix-js-sdk")
    assert.ok(fs.lstatSync(sdkLink).isSymbolicLink(), "standalone must preserve pnpm symlink for matrix-js-sdk")
    const localRequire = createRequire(pathToFileURL(entry))
    const messenger = await import(pathToFileURL(localRequire.resolve("@naia-adk/ax-messenger")))
    assert.equal(typeof messenger.AxMessengerClient.login, "function")
    const gateSecretFile = path.join(temporary, "gate-secret")
    const gateSecret = "synthetic-gate-secret-".padEnd(64, "x")
    fs.writeFileSync(gateSecretFile, gateSecret, { mode: 0o600 })
    const stubMatrix = http.createServer((_req, res) => {
      res.statusCode = 403
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ errcode: "M_FORBIDDEN", error: "Invalid credentials" }))
    })
    await new Promise(resolve => stubMatrix.listen(0, "127.0.0.1", resolve))
    const instanceConfigFile = path.join(temporary, "instance.json")
    fs.writeFileSync(instanceConfigFile, JSON.stringify({
      features: {
        messenger: {
          enabled: true,
          backend: "matrix",
          homeserverUrl: `http://127.0.0.1:${stubMatrix.address().port}`,
          roles: { writer: ["read", "write"] },
          accounts: { "account-a": { roles: ["writer"], matrixUserId: "@account-a:example.invalid" } },
        },
      },
    }))
    const previousNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = "production"
    try {
      const { startServer } = await import(pathToFileURL(entry))
      const disabledServer = await startServer(["-p", "0", "-H", "127.0.0.1"], { NODE_ENV: "production" })
      try {
        const base = `http://127.0.0.1:${disabledServer.address().port}`
        const response = await fetch(`${base}/ax/messenger`)
        assert.equal(response.status, 404, "disabled feature must be guarded by the standalone server")
        const home = await fetch(base)
        assert.equal(home.status, 200, "the actual Next server must start in the copied output")
      } finally { await new Promise(resolve => disabledServer.close(resolve)) }

      const enabledServer = await startServer(["-p", "0", "-H", "127.0.0.1"], {
        NODE_ENV: "production",
        NAIA_GATE_SECRET_FILE: gateSecretFile,
        NAIA_INSTANCE_CONFIG: instanceConfigFile,
      })
      try {
        const base = `http://127.0.0.1:${enabledServer.address().port}`
        const loginRes = await fetch(`${base}/api/ax-messenger/login`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: base,
            "x-naia-gate-secret": gateSecret,
            "x-ax-account-key": "account-a",
          },
          body: JSON.stringify({ user: "@account-a:example.invalid", password: "wrong-password" }),
        })
        assert.equal(loginRes.status, 401, "standalone login must load @naia-adk/ax-messenger and return 401 instead of 502")
      } finally { await new Promise(resolve => enabledServer.close(resolve)) }
    } finally {
      await new Promise(resolve => stubMatrix.close(resolve))
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previousNodeEnv
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
})

// Exercise the entry point normally shipped by Next, including its actual HTTP guard.
test("standalone server.js starts the guarded server", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ax-launcher-"))
  try {
    const copy = path.join(temporary, "standalone")
    fs.cpSync(path.join(sourceDashboard, ".next/standalone"), copy, { recursive: true, verbatimSymlinks: true })
    const dashboard = path.join(copy, "packages/dashboard")
    const reserver = net.createServer()
    await new Promise(resolve => reserver.listen(0, "127.0.0.1", resolve))
    const port = reserver.address().port
    await new Promise(resolve => reserver.close(resolve))
    const code = `
      import http from "node:http"
      const original = http.createServer
      let finish
      const listening = new Promise(resolve => { finish = resolve })
      http.createServer = (...args) => {
        const server = original(...args)
        server.once("listening", () => finish(server))
        return server
      }
      await import(${JSON.stringify(pathToFileURL(path.join(dashboard, "server.js")).href)})
      const server = await listening
      const response = await fetch("http://127.0.0.1:${port}/ax/messenger")
      console.log("GUARDED_STATUS=" + response.status)
      await response.text()
      await new Promise(resolve => server.close(resolve))
    `
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      cwd: dashboard, encoding: "utf8", env: { ...process.env, NODE_ENV: "production", PORT: String(port), HOSTNAME: "127.0.0.1", NAIA_DASHBOARD_PORT: String(port), NAIA_DASHBOARD_HOST: "127.0.0.1", NAIA_INSTANCE_CONFIG: "" },
    })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /GUARDED_STATUS=404/)
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
})
