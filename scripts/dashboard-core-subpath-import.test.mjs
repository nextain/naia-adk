import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const appDir = path.join(root, "packages/dashboard/app")
const fixtureFiles = [
  "packages/dashboard/app/i18n/i18n.fx2-context.test.tsx",
  "packages/dashboard/app/i18n/i18n.render.test.tsx",
  "packages/dashboard/app/settings/settings.render.test.tsx",
]

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(file)
    return /\.tsx?$/.test(entry.name) ? [file] : []
  })
}

describe("dashboard core imports and tier profile fixtures", () => {
  it("uses core subpath imports throughout the dashboard app", () => {
    for (const file of sourceFiles(appDir)) {
      const source = fs.readFileSync(file, "utf8")
      assert.doesNotMatch(
        source,
        /from\s+["']@naia-adk\/core["']|import\s+["']@naia-adk\/core["']/,
        `${path.relative(root, file)} must import a core subpath`,
      )
    }
  })

  it("keeps source metadata on every tier profile fixture", () => {
    let tierProfileCount = 0
    let sourcePathCount = 0
    let sourceKindCount = 0
    for (const relative of fixtureFiles) {
      const source = fs.readFileSync(path.join(root, relative), "utf8")
      tierProfileCount += (source.match(/tierProfile:\s*{/g) ?? []).length
      sourcePathCount += (source.match(/sourcePath:/g) ?? []).length
      sourceKindCount += (source.match(/sourceKind:/g) ?? []).length
    }
    assert.equal(tierProfileCount, 4, "expected four tierProfile fixtures")
    assert.equal(sourcePathCount, tierProfileCount, "every tierProfile fixture needs sourcePath")
    assert.equal(sourceKindCount, tierProfileCount, "every tierProfile fixture needs sourceKind")
  })
})
