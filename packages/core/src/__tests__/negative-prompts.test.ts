import { describe, it, expect } from "vitest"
import {
  validateNegativePromptsConfig,
  renderNegativePromptSections,
  renderMentionPolicySection,
  getActiveScopes,
  orderScopeNames,
} from "../negative-prompts.js"

const VALID_CONFIG = {
  schemaVersion: 1,
  scopes: {
    internal: {
      banned_phrases: ["phrase alpha", "phrase beta"],
      rules: ["Report dryly and factually."],
    },
    external: {
      banned_phrases: ["phrase gamma"],
      rules: ["Do not speculate beyond sources."],
      forbidden_disclosures: ["internal system details"],
    },
    legal_and_tos: {
      rules: ["Do not issue reflexive refusals on unverified speculation."],
      boundaries: ["Evaluation use only."],
    },
  },
  mention_policy: {
    require_explicit_mention_on_reference: true,
    mention_format: "<@{target}>",
    rules: ["Always mention the referenced agent."],
  },
}

describe("validateNegativePromptsConfig", () => {
  it("accepts a fully valid config with reserved and custom scopes", () => {
    const raw = {
      ...VALID_CONFIG,
      scopes: { ...VALID_CONFIG.scopes, custom_tone: { rules: ["Stay neutral."] } },
    }
    const res = validateNegativePromptsConfig(raw)
    expect(res.valid).toBe(true)
    if (res.valid) expect(Object.keys(res.data.scopes)).toHaveLength(4)
  })

  it("accepts a config without mention_policy", () => {
    const { mention_policy: _ignored, ...rest } = VALID_CONFIG
    expect(validateNegativePromptsConfig(rest).valid).toBe(true)
  })

  it("rejects non-objects and wrong schemaVersion", () => {
    expect(validateNegativePromptsConfig(null).valid).toBe(false)
    expect(validateNegativePromptsConfig([]).valid).toBe(false)
    expect(validateNegativePromptsConfig("x").valid).toBe(false)
    expect(validateNegativePromptsConfig({ ...VALID_CONFIG, schemaVersion: 2 }).valid).toBe(false)
  })

  it("rejects missing or empty scopes", () => {
    expect(validateNegativePromptsConfig({ schemaVersion: 1 }).valid).toBe(false)
    expect(validateNegativePromptsConfig({ schemaVersion: 1, scopes: {} }).valid).toBe(false)
  })

  it("rejects invalid scope names", () => {
    for (const bad of ["", "Has Space", "UPPER", "has-dash", "9leading"]) {
      const res = validateNegativePromptsConfig({ schemaVersion: 1, scopes: { [bad]: { rules: ["r."] } } })
      expect(res.valid).toBe(false)
    }
  })

  it("rejects scopes with no lists, unknown fields, or empty/invalid entries", () => {
    expect(
      validateNegativePromptsConfig({ schemaVersion: 1, scopes: { internal: {} } }).valid,
    ).toBe(false)
    expect(
      validateNegativePromptsConfig({ schemaVersion: 1, scopes: { internal: { unknown_field: ["x"] } } }).valid,
    ).toBe(false)
    expect(
      validateNegativePromptsConfig({ schemaVersion: 1, scopes: { internal: { rules: [] } } }).valid,
    ).toBe(false)
    expect(
      validateNegativePromptsConfig({ schemaVersion: 1, scopes: { internal: { rules: ["   "] } } }).valid,
    ).toBe(false)
    expect(
      validateNegativePromptsConfig({ schemaVersion: 1, scopes: { internal: { rules: [42] } } }).valid,
    ).toBe(false)
  })

  it("rejects malformed mention_policy", () => {
    const badFlag = { ...VALID_CONFIG, mention_policy: { require_explicit_mention_on_reference: "yes" } }
    expect(validateNegativePromptsConfig(badFlag).valid).toBe(false)
    const badFormat = {
      ...VALID_CONFIG,
      mention_policy: { require_explicit_mention_on_reference: true, mention_format: "<@noid>" },
    }
    expect(validateNegativePromptsConfig(badFormat).valid).toBe(false)
  })

  it("rejects enabled_scopes naming undefined scopes", () => {
    const res = validateNegativePromptsConfig({ ...VALID_CONFIG, enabled_scopes: ["internal", "ghost"] })
    expect(res.valid).toBe(false)
    const ok = validateNegativePromptsConfig({ ...VALID_CONFIG, enabled_scopes: ["external", "internal"] })
    expect(ok.valid).toBe(true)
  })
})

describe("orderScopeNames / getActiveScopes", () => {
  it("orders reserved scopes canonically, custom scopes alphabetically", () => {
    expect(orderScopeNames(["zeta", "external", "internal", "alpha", "legal_and_tos"])).toEqual([
      "internal",
      "external",
      "legal_and_tos",
      "alpha",
      "zeta",
    ])
  })

  it("defaults to all scopes and honors enabled_scopes", () => {
    const parsed = validateNegativePromptsConfig(VALID_CONFIG)
    expect(parsed.valid).toBe(true)
    if (!parsed.valid) return
    expect(getActiveScopes(parsed.data)).toEqual(["internal", "external", "legal_and_tos"])
    const limited = validateNegativePromptsConfig({ ...VALID_CONFIG, enabled_scopes: ["legal_and_tos"] })
    expect(limited.valid).toBe(true)
    if (!limited.valid) return
    expect(getActiveScopes(limited.data)).toEqual(["legal_and_tos"])
    expect(getActiveScopes(parsed.data, ["external"])).toEqual(["external"])
  })

  it("throws on unknown requested scopes", () => {
    const parsed = validateNegativePromptsConfig(VALID_CONFIG)
    expect(parsed.valid).toBe(true)
    if (!parsed.valid) return
    expect(() => getActiveScopes(parsed.data, ["ghost"])).toThrow()
  })
})

describe("renderNegativePromptSections", () => {
  it("renders every active scope deterministically with clean sections", () => {
    const parsed = validateNegativePromptsConfig(VALID_CONFIG)
    expect(parsed.valid).toBe(true)
    if (!parsed.valid) return
    const first = renderNegativePromptSections(parsed.data)
    const second = renderNegativePromptSections(parsed.data)
    expect(second).toBe(first)
    expect(first).toContain("### Scope: internal")
    expect(first).toContain("### Scope: external")
    expect(first).toContain("### Scope: legal_and_tos")
    expect(first.indexOf("### Scope: internal")).toBeLessThan(first.indexOf("### Scope: external"))
    expect(first.indexOf("### Scope: external")).toBeLessThan(first.indexOf("### Scope: legal_and_tos"))
    expect(first).toContain("phrase alpha")
    expect(first).toContain("Forbidden disclosures")
    expect(first).toContain("Boundaries")
  })

  it("renders only requested scopes and honors a custom heading", () => {
    const parsed = validateNegativePromptsConfig(VALID_CONFIG)
    expect(parsed.valid).toBe(true)
    if (!parsed.valid) return
    const out = renderNegativePromptSections(parsed.data, { scopes: ["external"], heading: "Custom title" })
    expect(out).toContain("## Custom title")
    expect(out).toContain("### Scope: external")
    expect(out).not.toContain("### Scope: internal")
  })
})

describe("renderMentionPolicySection", () => {
  it("renders the mention requirement and format", () => {
    const parsed = validateNegativePromptsConfig(VALID_CONFIG)
    expect(parsed.valid).toBe(true)
    if (!parsed.valid) return
    const out = renderMentionPolicySection(parsed.data)
    expect(out).not.toBeNull()
    expect(out as string).toContain("explicit mention")
    expect(out as string).toContain("<@{target}>")
  })

  it("returns null when no mention policy is configured", () => {
    const { mention_policy: _ignored, ...rest } = VALID_CONFIG
    const parsed = validateNegativePromptsConfig(rest)
    expect(parsed.valid).toBe(true)
    if (!parsed.valid) return
    expect(renderMentionPolicySection(parsed.data)).toBeNull()
  })
})
