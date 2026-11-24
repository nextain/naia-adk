import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "vitest"
import { inspectWorkspaceSettings } from "../workspace-settings.js"

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-visibility-"))
  fs.mkdirSync(path.join(root, "config"), { recursive: true })
  fs.writeFileSync(path.join(root, "adk.json"), JSON.stringify({ name: "Acme Workspace" }))
  fs.writeFileSync(
    path.join(root, "config", "tier-profile.json"),
    JSON.stringify({
      schema: "tier-profile/v1",
      worker_steps: { implementation: { tier: 3, candidate: "primary" }, review: { tier: 3 } },
      tiers: {
        "3": {
          mode: "balanced",
          max_parallel: 3,
          candidates: [
            { id: "primary", cli: "runner-a", model: "model-primary", effort: "high", weight: 2, roles: ["implementation"] },
            { id: "default", cli: "runner-b", model: "model-default", default: true },
          ],
          fallback: { when: "unavailable", to: "default", accountNames: ["backup-account"] },
        },
      },
    }),
  )
  return root
}

describe("workspace profile visibility", () => {
  it("exposes safe candidates, role bindings, source metadata, and display name", () => {
    const root = fixture()
    try {
      const result = inspectWorkspaceSettings(root, { env: {} })
      assert.equal(result.workspaceDisplayName, "Acme Workspace")
      assert.equal(result.tierProfile.sourcePath, "config/tier-profile.json")
      assert.equal(result.tierProfile.sourceKind, "workspace-default")
      assert.equal(result.tierProfile.tiers[0].mode, "balanced")
      assert.equal(result.tierProfile.tiers[0].maxParallel, 3)
      assert.deepEqual(result.tierProfile.tiers[0].candidates[0], {
        id: "primary", cli: "runner-a", model: "model-primary", effort: "high", weight: 2, roles: ["implementation"], isDefault: false,
      })
      assert.equal(result.roleBindings.find((item) => item.role === "implementation")?.source, "role-match")
      assert.equal(result.roleBindings.find((item) => item.role === "review")?.source, "default")
      assert.deepEqual(result.tierProfile.fallbackSummary, {
        when: "unavailable", to: "default", accountNames: ["backup-account"],
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("uses safe env display/profile overrides and the default display name", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-visibility-empty-"))
    try {
      const result = inspectWorkspaceSettings(root, { env: { NAIA_ADK_DISPLAY_NAME: "Acme Workspace", NAIA_ADK_TIER_PROFILE: "config/custom.json" } })
      assert.equal(result.workspaceDisplayName, "Acme Workspace")
      assert.equal(result.tierProfile.sourcePath, "config/custom.json")
      assert.equal(result.tierProfile.sourceKind, "env-override")
      assert.equal(inspectWorkspaceSettings(root, { env: {} }).workspaceDisplayName, "Naia ADK")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
