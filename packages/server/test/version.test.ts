import { readFileSync } from "node:fs"
import { expect, it } from "vitest"
import { createServer } from "../src/server.js"

it("returns the installed ADK VERSION through workspace metadata", async () => {
  const app = await createServer({ root: process.cwd(), host: "localhost", port: 3141 })
  try {
    const response = await app.inject({ method: "GET", url: "/api/workspace/meta", headers: { host: "localhost:3141" } })
    expect(response.statusCode).toBe(200)
    expect(response.json().version).toBe(readFileSync(new URL("../../../VERSION", import.meta.url), "utf8").trim())
  } finally {
    await app.close()
  }
})
