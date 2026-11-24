import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

const target = new URL("../packages/core/src/workspace-settings.ts", import.meta.url).pathname

function annotationOf(source, name, arity) {
  const params = arity === 0 ? "\\(\\)" : "\\(error: string\\)"
  const re = new RegExp(`const ${name} = ${params}: ([^=]+?) =>`)
  const match = source.match(re)
  assert.ok(match, `${name} helper with return annotation not found`)
  return match[1].trim()
}

describe("tier profile helper return types", () => {
  it("baseMissing and invalid require roleBindings", () => {
    const source = fs.readFileSync(target, "utf-8")
    assert.ok(source.includes("inspectTierProfile"), "inspectTierProfile not found")
    const baseMissingType = annotationOf(source, "baseMissing", 0)
    const invalidType = annotationOf(source, "invalid", 1)
    for (const [name, ann] of [["baseMissing", baseMissingType], ["invalid", invalidType]]) {
      assert.ok(
        ann.includes("roleBindings: TierRoleBindingItem[]"),
        `${name} must return required roleBindings, got: ${ann}`,
      )
    }
    const resolved = path.resolve(path.dirname(target), "workspace-settings.ts")
    assert.equal(resolved, target)
  })
})
