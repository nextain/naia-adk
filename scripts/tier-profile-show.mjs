import fs from "node:fs"
import path from "node:path"

const args = process.argv.slice(2)
const valueAfter = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined }
const root = path.resolve(valueAfter("--root") ?? process.cwd())
const requested = valueAfter("--profile") ?? process.env.NAIA_ADK_TIER_PROFILE ?? "config/tier-profile.json"
const sourcePath = path.relative(root, path.resolve(root, requested)) || path.basename(requested)
const safe = (value) => typeof value === "string" && value.length > 0 && value.length <= 64 && !/[\0\r\n]/.test(value) && !/<[A-Z0-9_][^>]*>/i.test(value) && !/^(?:MODEL_ID|CLI_ID)$/i.test(value)
try {
  const file = path.resolve(root, requested)
  const document = JSON.parse(fs.readFileSync(file, "utf8"))
  if (!document || document.schema !== "tier-profile/v1" || !document.tiers) throw new Error("invalid tier profile schema")
  const tiers = Object.entries(document.tiers).map(([tier, value]) => {
    if (!value || !Array.isArray(value.candidates) || !value.candidates.length) throw new Error(`tiers.${tier}.candidates is required`)
    const candidates = value.candidates.map((candidate, index) => {
      if (!safe(candidate.cli) || (candidate.model !== undefined && !safe(candidate.model))) throw new Error(`tiers.${tier}.candidates[${index}] contains an unsafe identifier`)
      return { id: safe(candidate.id) ? candidate.id : `candidate-${index + 1}`, cli: candidate.cli, ...(candidate.model ? { model: candidate.model } : {}), ...(candidate.effort ? { effort: candidate.effort } : {}) }
    })
    return { tier, candidates }
  })
  const displayName = process.env.NAIA_ADK_DISPLAY_NAME ?? (() => { try { return JSON.parse(fs.readFileSync(path.join(root, "adk.json"), "utf8")).name } catch { return undefined } })() ?? "Naia ADK"
  const result = { workspaceDisplayName: displayName, tierProfile: { status: "configured", sourcePath, sourceKind: requested === "config/tier-profile.json" ? "workspace-default" : "env-override", tiers }, roleBindings: [] }
  if (args.includes("--json")) console.log(JSON.stringify(result, null, 2))
  else { console.log(`Workspace: ${displayName}`); console.log(`Profile: ${sourcePath} (${result.tierProfile.sourceKind})`); for (const tier of tiers) console.log(`Tier ${tier.tier}: ${tier.candidates.map((c) => [c.cli, c.model, c.effort].filter(Boolean).join(" / ")).join(", ")}`) }
} catch (error) { console.error(`Unable to inspect tier profile: ${error instanceof Error ? error.message : "invalid configuration"}`); process.exitCode = 1 }
