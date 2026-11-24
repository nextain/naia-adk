import fs from "node:fs"
import path from "node:path"

const args = process.argv.slice(2)
const valueAfter = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined }
const root = path.resolve(valueAfter("--root") ?? process.cwd())
const cliProfile = valueAfter("--profile")
const envProfile = process.env.NAIA_ADK_TIER_PROFILE
const requested = cliProfile ?? (typeof envProfile === "string" && envProfile.trim() ? envProfile.trim() : undefined) ?? "config/tier-profile.json"
const wasOverride = cliProfile !== undefined || (typeof envProfile === "string" && envProfile.trim() !== "")
const absolute = path.resolve(root, requested)
const relative = path.relative(root, absolute)
const sourcePath = (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) ? relative : (path.basename(requested) || "tier-profile.json")
const sourceKind = wasOverride ? "env-override" : "workspace-default"
const SECRET_PREFIX_RE = /^(?:sk-|AIza|gh[pousr]_|AKIA|xox[baprs]-|eyJ)/i
const SECRET_WORD_RE = /secret|token|password|apikey|api_key/i
const safe = (value) => typeof value === "string" && value.length > 0 && value.length <= 64 && !/[\0\r\n]/.test(value) && !/<[A-Z0-9_][^>]*>/i.test(value) && !/^(?:MODEL_ID|CLI_ID)$/i.test(value) && !SECRET_PREFIX_RE.test(value) && !SECRET_WORD_RE.test(value.trim())
const safeId = (value) => safe(value) && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/.test(value.trim())
try {
  const file = path.resolve(root, requested)
  const document = JSON.parse(fs.readFileSync(file, "utf8"))
  if (!document || document.schema !== "tier-profile/v1" || !document.tiers || typeof document.tiers !== "object") throw new Error("invalid tier profile schema")
  const tiers = Object.entries(document.tiers).map(([tier, value]) => {
    if (!value || typeof value !== "object" || !Array.isArray(value.candidates) || !value.candidates.length) throw new Error(`tiers.${tier}.candidates is required`)
    const candidates = value.candidates.map((candidate, index) => {
      if (!candidate || typeof candidate !== "object") throw new Error(`tiers.${tier}.candidates[${index}] is invalid`)
      if (!safe(candidate.cli)) throw new Error(`tiers.${tier}.candidates[${index}] contains an unsafe identifier`)
      if (candidate.model !== undefined && !safe(candidate.model)) throw new Error(`tiers.${tier}.candidates[${index}] contains an unsafe identifier`)
      if (candidate.effort !== undefined && !safe(candidate.effort)) throw new Error(`tiers.${tier}.candidates[${index}] contains an unsafe identifier`)
      const roles = Array.isArray(candidate.roles) ? candidate.roles.filter((r) => safeId(r)) : []
      return {
        id: safeId(candidate.id) ? candidate.id : `candidate-${index + 1}`,
        cli: candidate.cli,
        ...(typeof candidate.model === "string" ? { model: candidate.model } : {}),
        ...(typeof candidate.effort === "string" ? { effort: candidate.effort } : {}),
        ...(typeof candidate.weight === "number" && Number.isFinite(candidate.weight) ? { weight: candidate.weight } : {}),
        ...(roles.length ? { roles } : {}),
        ...(candidate.default === true ? { isDefault: true } : { isDefault: false }),
      }
    })
    return {
      tier,
      ...(typeof value.mode === "string" && safe(value.mode) ? { mode: value.mode } : {}),
      ...(typeof value.max_parallel === "number" && Number.isFinite(value.max_parallel) ? { maxParallel: value.max_parallel } : {}),
      candidates,
    }
  })
  const tier3 = tiers.find((t) => t.tier === "3")
  const roleBindings = []
  let fallbackSummary
  if (tier3) {
    const steps = document.worker_steps && typeof document.worker_steps === "object" && !Array.isArray(document.worker_steps) ? document.worker_steps : {}
    const defaults = tier3.candidates.find((c) => c.isDefault) ?? tier3.candidates[0]
    for (const role of Object.keys(steps)) {
      const step = steps[role] && typeof steps[role] === "object" ? steps[role] : {}
      const matched = tier3.candidates.find((c) => c.id === step.candidate || (c.roles ?? []).includes(role))
      const chosen = matched ?? defaults
      if (chosen) roleBindings.push({
        role, tier: "3",
        ...(matched ? { configuredCli: matched.cli, ...(matched.model ? { configuredModel: matched.model } : {}), ...(matched.effort ? { configuredEffort: matched.effort } : {}) } : {}),
        effectiveCli: chosen.cli,
        ...(chosen.model ? { effectiveModel: chosen.model } : {}),
        ...(chosen.effort ? { effectiveEffort: chosen.effort } : {}),
        fallbackActive: false,
        source: matched ? "role-match" : "default",
      })
    }
    const rawTier = document.tiers["3"]
    const fallback = rawTier && typeof rawTier === "object" && rawTier.fallback && typeof rawTier.fallback === "object" && !Array.isArray(rawTier.fallback) ? rawTier.fallback : undefined
    if (fallback) {
      const fallbackTo = safeId(fallback.to) ? tier3.candidates.find((c) => c.id === fallback.to) : undefined
      const marker = typeof process.env.NAIA_ADK_FALLBACK_STATE_DIR === "string" && process.env.NAIA_ADK_FALLBACK_STATE_DIR
        ? process.env.NAIA_ADK_FALLBACK_STATE_DIR
        : ".agents/state/tier3-fallback"
      if (fs.existsSync(path.resolve(root, marker))) {
        for (const binding of roleBindings) {
          binding.fallbackActive = true
          binding.source = "fallback"
          if (fallbackTo) {
            binding.effectiveCli = fallbackTo.cli
            if (fallbackTo.model !== undefined) binding.effectiveModel = fallbackTo.model
            else delete binding.effectiveModel
            if (fallbackTo.effort !== undefined) binding.effectiveEffort = fallbackTo.effort
            else delete binding.effectiveEffort
          }
        }
      }
      const accountValues = [
        ...(Array.isArray(fallback.accountNames) ? fallback.accountNames : []),
        ...(Array.isArray(fallback.accounts) ? fallback.accounts.map((a) => typeof a === "string" ? a : a && typeof a === "object" ? a.name : undefined) : []),
      ]
      const accountNames = [...new Set(accountValues.filter((a) => safeId(a)))]
      const q = fallback.quota_policy && typeof fallback.quota_policy === "object" ? fallback.quota_policy : undefined
      const quotaPolicy = q ? { ...(typeof q.min_remaining_pct === "number" ? { minRemainingPct: q.min_remaining_pct } : {}), ...(typeof q.switch_threshold_pct === "number" ? { switchThresholdPct: q.switch_threshold_pct } : {}), ...(typeof q.recovery_check_interval_sec === "number" ? { recoveryCheckIntervalSec: q.recovery_check_interval_sec } : {}) } : undefined
      const recoverySignals = fallback.recovery && typeof fallback.recovery === "object" && Array.isArray(fallback.recovery.accept_any_of) ? fallback.recovery.accept_any_of.filter((s) => safeId(s)) : undefined
      fallbackSummary = {
        ...(typeof fallback.when === "string" && safe(fallback.when) ? { when: fallback.when } : {}),
        ...(safeId(fallback.to) ? { to: fallback.to } : {}),
        accountNames,
        ...(quotaPolicy && Object.keys(quotaPolicy).length ? { quotaPolicy } : {}),
        ...(recoverySignals?.length ? { recoverySignals: [...new Set(recoverySignals)] } : {}),
      }
    }
  }
  const displayName = (() => {
    const env = process.env.NAIA_ADK_DISPLAY_NAME
    if (typeof env === "string" && env.trim()) return env.trim()
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(root, "adk.json"), "utf8"))
      if (parsed && typeof parsed === "object" && typeof parsed.name === "string" && parsed.name.trim()) return parsed.name.trim()
    } catch { /* fall through to default */ }
    return undefined
  })() ?? "Naia ADK"
  const safeName = typeof displayName === "string" && displayName.length <= 80 && !/[\0\r\n]/.test(displayName) ? displayName : "Naia ADK"
  const result = { workspaceDisplayName: safeName, tierProfile: { status: "configured", sourcePath, sourceKind, tiers, ...(fallbackSummary ? { fallbackSummary } : {}) }, roleBindings }
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(`Workspace: ${safeName}`)
    console.log(`Profile: ${sourcePath} (${sourceKind})`)
    for (const tier of tiers) {
      const head = `Tier ${tier.tier}${tier.mode ? ` [${tier.mode}` : " [default"} · ${tier.maxParallel ?? "-"} parallel]`
      const cands = tier.candidates.map((c) => [c.id, [c.cli, c.model, c.effort].filter(Boolean).join(" / "), c.weight !== undefined ? `w=${c.weight}` : "", (c.roles ?? []).length ? `roles=${c.roles.join(",")}` : ""].filter(Boolean).join(" · ")).join("; ")
      console.log(`${head}: ${cands}`)
    }
    for (const b of roleBindings) console.log(`Role ${b.role}: ${b.configuredCli ?? "default"} -> ${b.effectiveCli ?? "-"} (${b.source}${b.fallbackActive ? ", fallback-active" : ""})`)
    if (fallbackSummary) console.log(`Fallback: ${fallbackSummary.when ?? "-"} -> ${fallbackSummary.to ?? "-"} (accounts: ${fallbackSummary.accountNames.join(", ") || "-"})`)
  }
} catch (error) { console.error(`Unable to inspect tier profile: ${error instanceof Error ? error.message : "invalid configuration"}`); process.exitCode = 1 }
