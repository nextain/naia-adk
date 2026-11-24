import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { loadTierProfileFile } from "./lib/tier-profile.cjs"

function profile(fallback) {
  return { schema: "tier-profile/v1", tiers: { "2": { candidates: [{ cli: "runner", model: "model", command_template: "{cli} --model {model}" }] }, "3": { candidates: [{ cli: "runner", model: "model" }], fallback } } }
}

function writeProfile(value) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tier-profile-quota-"))
  const file = path.join(dir, "tier-profile.json")
  fs.writeFileSync(file, JSON.stringify(value))
  return { dir, file }
}

describe("tier 3 fallback quota policy", () => {
  it("returns safe accounts, quota thresholds, interval, and recovery signals", () => {
    const { dir, file } = writeProfile(profile({
      accounts: [{ name: "primary", home: "/private/home" }, "backup", { name: "<ACCOUNT_1>" }, { name: "sk-secret" }, 42, ["nested"]],
      accountNames: ["backup", "third", "backup", "<ACCOUNT_2>", 42],
      quota_policy: { min_remaining_pct: 20, switch_threshold_pct: 10, recovery_check_interval_sec: 60 },
      recovery: { accept_any_of: ["quota-restored", "manual"] },
    }))
    try {
      const result = loadTierProfileFile(file)
      assert.equal(result.status, "ok")
      assert.deepEqual(result.tier3Fallback, {
        accountNames: ["primary", "backup", "third"],
        quotaPolicy: { minRemainingPct: 20, switchThresholdPct: 10, recoveryCheckIntervalSec: 60 },
        recoverySignals: ["quota-restored", "manual"],
      })
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it("fails closed for invalid quota policy", () => {
    const { dir, file } = writeProfile(profile({ quota_policy: { min_remaining_pct: 101 } }))
    try { assert.equal(loadTierProfileFile(file).status, "broken") }
    finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
