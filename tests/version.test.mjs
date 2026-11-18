import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"

const root = new URL("../", import.meta.url)
const read = (path) => readFileSync(new URL(path, root), "utf8")

test("workspace package versions and adk metadata match VERSION", () => {
  const version = read("VERSION").trim()
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
  const packages = readdirSync(new URL("packages/", root), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}/package.json`)
  for (const file of ["package.json", ...packages]) {
    assert.equal(JSON.parse(read(file)).version, version, file)
  }
  assert.equal(JSON.parse(read("adk.json")).adk_version, version, "adk.json")
})
