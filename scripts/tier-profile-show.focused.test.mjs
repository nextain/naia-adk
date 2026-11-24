import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

const script = new URL("./tier-profile-show.mjs", import.meta.url).pathname

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tier-show-focused-"))
  fs.mkdirSync(path.join(root, "config"), { recursive: true })
  return root
}

function writeDoc(root) {
  fs.writeFileSync(path.join(root, "adk.json"), JSON.stringify({ name: "Acme Workspace" }))
  fs.writeFileSync(
    path.join(root, "config", "tier-profile.json"),
    JSON.stringify({
      schema: "tier-profile/v1",
      worker_steps: {
        implementation: { tier: 3, candidate: "primary" },
        review: { tier: 3 },
      },
      tiers: {
        3: {
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
}

function run(args, options = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf-8",
    env: { ...process.env, ...(options.env ?? {}) },
  })
}

describe("tier-profile-show focused visibility", () => {
  it("reports mode, weights, roles, role bindings and fallback summary as JSON", () => {
    const root = makeRoot()
    try {
      writeDoc(root)
      const res = run(["--root", root, "--json"])
      assert.equal(res.status, 0, `CLI failed: ${res.stderr}`)
      const out = JSON.parse(res.stdout)
      assert.equal(out.workspaceDisplayName, "Acme Workspace")
      assert.equal(out.tierProfile.sourcePath, "config/tier-profile.json")
      assert.equal(out.tierProfile.sourceKind, "workspace-default")
      assert.equal(out.tierProfile.tiers[0].mode, "balanced")
      assert.equal(out.tierProfile.tiers[0].maxParallel, 3)
      assert.equal(out.tierProfile.tiers[0].candidates[0].weight, 2)
      assert.deepEqual(out.tierProfile.tiers[0].candidates[0].roles, ["implementation"])
      const impl = out.roleBindings.find((b) => b.role === "implementation")
      const review = out.roleBindings.find((b) => b.role === "review")
      assert.equal(impl?.source, "role-match")
      assert.equal(impl?.effectiveCli, "runner-a")
      assert.equal(review?.source, "default")
      assert.deepEqual(out.tierProfile.fallbackSummary, {
        when: "unavailable",
        to: "default",
        accountNames: ["backup-account"],
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("marks fallback active when the fallback marker exists", () => {
    const root = makeRoot()
    try {
      writeDoc(root)
      fs.mkdirSync(path.join(root, ".agents", "state", "tier3-fallback"), { recursive: true })
      const res = run(["--root", root, "--json"])
      assert.equal(res.status, 0, `CLI failed: ${res.stderr}`)
      const out = JSON.parse(res.stdout)
      assert.ok(out.roleBindings.length > 0)
      for (const b of out.roleBindings) {
        assert.equal(b.fallbackActive, true)
        assert.equal(b.source, "fallback")
        assert.equal(b.effectiveCli, "runner-b")
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("treats an explicit env profile override as env-override even for the default path", () => {
    const root = makeRoot()
    try {
      writeDoc(root)
      const res = run(["--root", root, "--json"], {
        env: { NAIA_ADK_TIER_PROFILE: "config/tier-profile.json", NAIA_ADK_DISPLAY_NAME: "Acme Workspace" },
      })
      assert.equal(res.status, 0, `CLI failed: ${res.stderr}`)
      const out = JSON.parse(res.stdout)
      assert.equal(out.tierProfile.sourceKind, "env-override")
      assert.equal(out.workspaceDisplayName, "Acme Workspace")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("fails with non-zero status for broken and missing profiles", () => {
    const root = makeRoot()
    try {
      fs.writeFileSync(path.join(root, "config", "tier-profile.json"), "{broken json")
      const broken = run(["--root", root, "--json"])
      assert.notEqual(broken.status, 0)
      assert.match(broken.stderr, /Unable to inspect tier profile/)
      const missing = run(["--root", root, "--profile", "config/does-not-exist.json", "--json"])
      assert.notEqual(missing.status, 0)
      assert.match(missing.stderr, /Unable to inspect tier profile/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("falls back to the default display name without configuration", () => {
    const root = makeRoot()
    try {
      const res = run(["--root", root, "--profile", "config/does-not-exist.json", "--json"])
      assert.notEqual(res.status, 0)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
