import assert from "node:assert/strict"
import { test } from "node:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createServer } from "../../../server/src/server.ts"
import board from "./WorkBoard.tsx"
const { WorkBoard } = board

test("CLI export feeds the API and filtered role board", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "board-contract-"))
  let app
  try {
    const sourceDir = path.join(root, "source"), outputDir = path.join(root, "exports")
    fs.mkdirSync(sourceDir); fs.mkdirSync(outputDir); fs.mkdirSync(path.join(root, "config"))
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456", email = "private@example.com"
    const row = (id, status, due) => ({ id, status, title: `${secret} ${email}`, public_title: `공개 ${id} ${email} ${secret}`, due, checked_at: null, from: { channel: "100", msg_id: "200", quote: secret }, note: email, worker: null })
    const ledger = { version: 1, role: "lead", report: { every_min: 60, channel: "100", last_msg_id: null, last_at: null }, items: [row("one", "open", "2020-01-01T00:00:00Z"), row("two", "escalated_human", "2099-01-01T00:00:00Z"), row("done", "done", "2099-01-01T00:00:00Z")] }
    const source = path.join(sourceDir, "lead.json"), config = path.join(root, "export.json")
    fs.writeFileSync(source, JSON.stringify(ledger))
    const otherSource = path.join(sourceDir, "assistant.json")
    fs.writeFileSync(otherSource, JSON.stringify({ ...ledger, role: "assistant", items: [row("other", "waiting_human", "2099-01-01T00:00:00Z")] }))
    fs.writeFileSync(config, JSON.stringify({ outputDir, sources: [{ role: "lead", path: source }, { role: "assistant", path: otherSource }] }))
    const cli = fileURLToPath(new URL("../../../../scripts/work-ledger/export.mjs", import.meta.url))
    execFileSync(process.execPath, [cli, "--config", config, "--role", "lead", "--role", "assistant"])
    const exported = path.join(outputDir, "lead.json"), content = fs.readFileSync(exported, "utf8")
    assert.equal(fs.statSync(exported).mode & 0o777, 0o644)
    assert.ok(!content.includes(secret) && !content.includes(email))
    assert.equal(JSON.parse(content).items.length, 2)
    fs.writeFileSync(path.join(root, "config/work-board.json"), JSON.stringify({ exportDir: "../exports", roles: ["lead", "assistant", "empty"] }))
    app = await createServer({ root, port: 3141, host: "127.0.0.1" })
    const proxySecret = "deadbeef".repeat(8)
    ;app.proxySecret = proxySecret
    const res = await app.inject({ method: "GET", url: "/api/portal/ledger?view=board", headers: { host: "localhost:3141", "x-naia-proxy-secret": proxySecret, "x-naia-peer": "127.0.0.1", "x-naia-local": "127.0.0.1" } })
    assert.equal(res.statusCode, 200)
    const payload = res.json()
    assert.equal(payload.items.length, 3)
    const render = (query = "") => renderToStaticMarkup(React.createElement(WorkBoard, { status: "ready", ledger: payload, hasBoard: false, initialQuery: query }))
    const html = render()
    assert.match(html, /전체 역할 \(3\)/)
    assert.match(html, /열린 작업 2 · 기한 넘음 1/)
    assert.match(html, /data-testid="role-column-empty"/)
    const matching = render("one")
    assert.match(matching, /전체 역할 \(1\)/)
    assert.match(matching, /열린 작업 1 · 기한 넘음 1/)
    assert.ok(!matching.includes('data-testid="ledger-card-other"'))
    const filtered = render("no-such-card")
    assert.match(filtered, /전체 역할 \(0\)/)
    assert.match(filtered, /열린 작업 0 · 기한 넘음 0/)
    assert.ok(!filtered.includes('data-testid="ledger-card-one"'))
  } finally {
    await app?.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
