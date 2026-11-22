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
        const schedule = await fetch(`${base}/schedule`)
        assert.equal(schedule.status, 200, "the copied Next server must serve the schedule page")
        assert.match(await schedule.text(), /data-testid="schedule-calendar-section"/)
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
    const probe = path.join(temporary, "probe.mjs")
    fs.writeFileSync(probe, `
      import assert from "node:assert/strict"
      import { readFileSync } from "node:fs"
      import http from "node:http"
      const original = http.createServer
      http.createServer = (...args) => {
        const server = original(...args)
        const defaultKeepAlive = server.keepAliveTimeout
        server.once("listening", async () => {
          try {
            await new Promise(resolve => setImmediate(resolve))
            if (process.env.KEEP_ALIVE_TIMEOUT !== undefined) {
              assert.equal(server.keepAliveTimeout, Number(process.env.KEEP_ALIVE_TIMEOUT) || defaultKeepAlive, "unexpected keep-alive timeout")
            }
            assert.equal(server.address().port, ${port}, "launcher ignored requested port")
            assert.equal(server.address().address, "127.0.0.1", "launcher ignored requested hostname")
            assert.equal(process.cwd(), ${JSON.stringify(dashboard)})
            const manifest = JSON.parse(readFileSync(".next/required-server-files.json", "utf8"))
            assert.deepEqual(JSON.parse(process.env.__NEXT_PRIVATE_STANDALONE_CONFIG), manifest.config)
            const response = await fetch("http://127.0.0.1:${port}/ax/messenger")
            assert.equal(response.status, 404)
            await response.text()
            console.log("LAUNCHER_GUARDED")
          } catch (error) {
            console.error(error)
            process.exitCode = 1
          } finally { server.close() }
        })
        return server
      }
    `)
    const environment = { ...process.env, NAIA_INSTANCE_CONFIG: "" }
    delete environment.NAIA_DASHBOARD_PORT
    delete environment.NAIA_DASHBOARD_HOST
    delete environment.__NEXT_PRIVATE_STANDALONE_CONFIG
    delete environment.KEEP_ALIVE_TIMEOUT
    const cases = [
      { label: "Next environment", env: { PORT: String(port), HOSTNAME: "127.0.0.1" }, args: [] },
      { label: "ADK environment", env: { KEEP_ALIVE_TIMEOUT: "0", PORT: "1", HOSTNAME: "invalid.example", NAIA_DASHBOARD_PORT: String(port), NAIA_DASHBOARD_HOST: "127.0.0.1" }, args: [] },
      { label: "CLI flags", env: { KEEP_ALIVE_TIMEOUT: "12000", PORT: "1", HOSTNAME: "invalid.example", NAIA_DASHBOARD_PORT: "2", NAIA_DASHBOARD_HOST: "invalid.example" }, args: ["-p", String(port), "-H", "127.0.0.1"] },
    ]
    for (const scenario of cases) {
      const result = spawnSync(process.execPath, ["--import", probe, path.join(dashboard, "server.js"), ...scenario.args], {
        cwd: temporary, encoding: "utf8", timeout: 15_000, env: { ...environment, ...scenario.env },
      })
      assert.equal(result.status, 0, `${scenario.label}: ${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`)
      assert.match(result.stdout, /LAUNCHER_GUARDED/, scenario.label)
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
})
