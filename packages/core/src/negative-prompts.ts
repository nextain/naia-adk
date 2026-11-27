/**
 * Config-driven negative-prompt governance for ADK harnesses.
 *
 * A "negative prompt" entry tells the model what it must NOT say or do.
 * Entries are grouped into named scopes (for example `internal` for
 * inward-facing tone rules, `external` for outward-facing disclosure rules,
 * or `legal_and_tos` for refusal-policy boundaries). Scope *names* are part
 * of the generic contract; scope *contents* are always instance-supplied, so
 * this module contains no instance, company, role, channel, or domain
 * literals — only the schema, validator, and deterministic renderer.
 */

/** Reserved scope names recognised by the renderer ordering. Custom scope names are also allowed. */
export const RESERVED_NEGATIVE_PROMPT_SCOPES = ["internal", "external", "legal_and_tos"] as const

export type ReservedNegativePromptScope = (typeof RESERVED_NEGATIVE_PROMPT_SCOPES)[number]

/**
 * One negative-prompt scope. Every list is optional, but a scope must define
 * at least one non-empty list to be valid.
 */
export interface NegativePromptScopeConfig {
  /** Phrases the model must never emit when this scope is active. */
  banned_phrases?: string[]
  /** Behavioral rules ("do not ...", "require ...") for this scope. */
  rules?: string[]
  /** Topics/facts that must never be disclosed when this scope is active. */
  forbidden_disclosures?: string[]
  /** Hard boundaries that always hold for this scope. */
  boundaries?: string[]
}

/** Policy for explicitly mentioning another agent when referencing it. */
export interface MentionPolicyConfig {
  /** When true, any reference to (or action request of) another agent must include its explicit mention. */
  require_explicit_mention_on_reference: boolean
  /**
   * Mention template. Must contain the `{target}` placeholder, which the
   * harness replaces with the referenced agent's address (for example
   * `"<@{target}>"`). Kept generic: no concrete address lives here.
   */
  mention_format?: string
  /** Additional mention-behavior rules. */
  rules?: string[]
}

/** Top-level negative-prompts governance config. */
export interface NegativePromptsConfig {
  schemaVersion: 1
  /** Named scopes; reserved names plus any custom scope names. */
  scopes: Record<string, NegativePromptScopeConfig>
  /** Optional mention policy. */
  mention_policy?: MentionPolicyConfig
  /**
   * Default subset of `scopes` to render. When omitted, all defined scopes
   * are active. Every entry must name a scope defined in `scopes`.
   */
  enabled_scopes?: string[]
}

export const NEGATIVE_PROMPTS_CONFIG_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "ADK Negative Prompts Configuration",
  type: "object",
  required: ["schemaVersion", "scopes"],
  properties: {
    schemaVersion: { type: "integer", const: 1, description: "Schema version, must be 1" },
    scopes: {
      type: "object",
      description: "Named negative-prompt scopes (reserved: internal, external, legal_and_tos; custom scopes allowed)",
      minProperties: 1,
      additionalProperties: {
        type: "object",
        properties: {
          banned_phrases: { type: "array", items: { type: "string" } },
          rules: { type: "array", items: { type: "string" } },
          forbidden_disclosures: { type: "array", items: { type: "string" } },
          boundaries: { type: "array", items: { type: "string" } },
        },
      },
    },
    mention_policy: {
      type: "object",
      description: "Explicit-mention policy for references to other agents",
      required: ["require_explicit_mention_on_reference"],
      properties: {
        require_explicit_mention_on_reference: { type: "boolean" },
        mention_format: { type: "string", description: "Mention template containing the {target} placeholder" },
        rules: { type: "array", items: { type: "string" } },
      },
    },
    enabled_scopes: {
      type: "array",
      items: { type: "string" },
      description: "Default subset of scopes to render; omitted means all scopes",
    },
  },
} as const

const SCOPE_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/
const MAX_ENTRY_CHARS = 500
const MENTION_TARGET_TOKEN = "{target}"
const SCOPE_LIST_KEYS = ["banned_phrases", "rules", "forbidden_disclosures", "boundaries"] as const

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function checkStringList(
  value: unknown,
  where: string,
): { ok: true; items: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: `${where} must be an array of strings` }
  if (value.length === 0) return { ok: false, error: `${where} must not be empty when present` }
  for (let i = 0; i < value.length; i++) {
    const item = value[i]
    if (!isNonEmptyString(item)) {
      return { ok: false, error: `${where}[${i}] must be a non-empty string` }
    }
    if (item.length > MAX_ENTRY_CHARS) {
      return { ok: false, error: `${where}[${i}] exceeds ${MAX_ENTRY_CHARS} characters` }
    }
  }
  return { ok: true, items: value as string[] }
}

function validateScopeConfig(
  raw: unknown,
  scopeName: string,
): { valid: true; data: NegativePromptScopeConfig } | { valid: false; error: string } {
  const where = `scopes.${scopeName}`
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { valid: false, error: `${where} must be an object` }
  }
  const obj = raw as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    if (!(SCOPE_LIST_KEYS as readonly string[]).includes(key)) {
      return { valid: false, error: `${where}.${key} is not a known scope field` }
    }
  }
  const out: NegativePromptScopeConfig = {}
  let defined = 0
  for (const key of SCOPE_LIST_KEYS) {
    const value = obj[key]
    if (value === undefined) continue
    const checked = checkStringList(value, `${where}.${key}`)
    if (!checked.ok) return { valid: false, error: checked.error }
    out[key] = checked.items
    defined++
  }
  if (defined === 0) {
    return { valid: false, error: `${where} must define at least one of: ${SCOPE_LIST_KEYS.join(", ")}` }
  }
  return { valid: true, data: out }
}

function validateMentionPolicy(
  raw: unknown,
): { valid: true; data: MentionPolicyConfig } | { valid: false; error: string } {
  const where = "mention_policy"
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { valid: false, error: `${where} must be an object` }
  }
  const obj = raw as Record<string, unknown>
  if (typeof obj.require_explicit_mention_on_reference !== "boolean") {
    return { valid: false, error: `${where}.require_explicit_mention_on_reference must be a boolean` }
  }
  const out: MentionPolicyConfig = {
    require_explicit_mention_on_reference: obj.require_explicit_mention_on_reference,
  }
  if (obj.mention_format !== undefined) {
    if (!isNonEmptyString(obj.mention_format)) {
      return { valid: false, error: `${where}.mention_format must be a non-empty string` }
    }
    if (!obj.mention_format.includes(MENTION_TARGET_TOKEN)) {
      return {
        valid: false,
        error: `${where}.mention_format must contain the ${MENTION_TARGET_TOKEN} placeholder`,
      }
    }
    out.mention_format = obj.mention_format
  }
  if (obj.rules !== undefined) {
    const checked = checkStringList(obj.rules, `${where}.rules`)
    if (!checked.ok) return { valid: false, error: checked.error }
    out.rules = checked.items
  }
  return { valid: true, data: out }
}

export function validateNegativePromptsConfig(
  raw: unknown,
): { valid: true; data: NegativePromptsConfig } | { valid: false; error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { valid: false, error: "negative-prompts config: must be a JSON object" }
  }
  const obj = raw as Record<string, unknown>
  if (obj.schemaVersion !== 1) {
    return { valid: false, error: "negative-prompts config: schemaVersion must be 1" }
  }
  if (typeof obj.scopes !== "object" || obj.scopes === null || Array.isArray(obj.scopes)) {
    return { valid: false, error: "negative-prompts config: scopes must be an object" }
  }
  const scopesRaw = obj.scopes as Record<string, unknown>
  const scopeNames = Object.keys(scopesRaw)
  if (scopeNames.length === 0) {
    return { valid: false, error: "negative-prompts config: scopes must define at least one scope" }
  }
  const scopes: Record<string, NegativePromptScopeConfig> = {}
  for (const name of scopeNames) {
    if (!SCOPE_NAME_RE.test(name)) {
      return {
        valid: false,
        error: `negative-prompts config: scope name "${name}" must match ${SCOPE_NAME_RE}`,
      }
    }
    const checked = validateScopeConfig(scopesRaw[name], name)
    if (!checked.valid) return checked
    scopes[name] = checked.data
  }
  const out: NegativePromptsConfig = { schemaVersion: 1, scopes }
  if (obj.mention_policy !== undefined) {
    const checked = validateMentionPolicy(obj.mention_policy)
    if (!checked.valid) return checked
    out.mention_policy = checked.data
  }
  if (obj.enabled_scopes !== undefined) {
    if (!Array.isArray(obj.enabled_scopes) || obj.enabled_scopes.length === 0) {
      return { valid: false, error: "negative-prompts config: enabled_scopes must be a non-empty array when present" }
    }
    for (let i = 0; i < obj.enabled_scopes.length; i++) {
      const entry = obj.enabled_scopes[i]
      if (!isNonEmptyString(entry)) {
        return { valid: false, error: `negative-prompts config: enabled_scopes[${i}] must be a non-empty string` }
      }
      if (!Object.hasOwn(scopes, entry)) {
        return {
          valid: false,
          error: `negative-prompts config: enabled_scopes[${i}] "${entry}" is not a defined scope`,
        }
      }
    }
    out.enabled_scopes = [...new Set(obj.enabled_scopes as string[])]
  }
  return { valid: true, data: out }
}

/**
 * Canonical deterministic scope order: reserved scopes first
 * (`internal`, `external`, `legal_and_tos`), then custom scopes alphabetically.
 */
export function orderScopeNames(names: string[]): string[] {
  const reserved = RESERVED_NEGATIVE_PROMPT_SCOPES as readonly string[]
  return [...names].sort((a, b) => {
    const ai = reserved.indexOf(a)
    const bi = reserved.indexOf(b)
    if (ai !== -1 || bi !== -1) return (ai === -1 ? reserved.length : ai) - (bi === -1 ? reserved.length : bi)
    return a < b ? -1 : a > b ? 1 : 0
  })
}

/**
 * Resolve which scopes are active. An explicit `requested` list overrides the
 * config's `enabled_scopes`; omitted means the config default (or all scopes).
 * Unknown names throw — fail closed rather than silently dropping a scope.
 */
export function getActiveScopes(config: NegativePromptsConfig, requested?: string[]): string[] {
  const base = requested ?? config.enabled_scopes ?? Object.keys(config.scopes)
  const seen = new Set<string>()
  const active: string[] = []
  for (const name of base) {
    if (!Object.hasOwn(config.scopes, name)) {
      throw new Error(`unknown negative-prompt scope: "${name}"`)
    }
    if (!seen.has(name)) {
      seen.add(name)
      active.push(name)
    }
  }
  return orderScopeNames(active)
}

export interface RenderNegativePromptsOptions {
  /** Override the active scope set (must name defined scopes). */
  scopes?: string[]
  /** Top-level heading for the rendered block. Defaults to a generic title. */
  heading?: string
}

function renderList(title: string, items: string[] | undefined, lines: string[]): void {
  if (!items || items.length === 0) return
  lines.push(`- ${title}:`)
  for (const item of items) lines.push(`  - ${item}`)
}

/**
 * Deterministic renderer: formats the active scopes as clean prompt sections
 * suitable for embedding in a system/role prompt block. Output depends only on
 * the config (plus options), so the same input always yields the same text.
 */
export function renderNegativePromptSections(
  config: NegativePromptsConfig,
  options?: RenderNegativePromptsOptions,
): string {
  const heading = options?.heading?.trim() ? (options.heading as string).trim() : "Negative prompts (must never do the following)"
  const active = getActiveScopes(config, options?.scopes)
  const lines: string[] = [`## ${heading}`]
  for (const name of active) {
    const scope = config.scopes[name]
    lines.push(`### Scope: ${name}`)
    renderList("Banned phrases", scope.banned_phrases, lines)
    renderList("Rules", scope.rules, lines)
    renderList("Forbidden disclosures", scope.forbidden_disclosures, lines)
    renderList("Boundaries", scope.boundaries, lines)
  }
  return lines.join("\n")
}

/**
 * Renders the mention-policy section, or null when no mention policy (or no
 * requirement/rules to render) is configured.
 */
export function renderMentionPolicySection(config: NegativePromptsConfig): string | null {
  const policy = config.mention_policy
  if (!policy) return null
  const lines: string[] = ["## Mention policy"]
  lines.push(
    policy.require_explicit_mention_on_reference
      ? "- When referring to or requesting action from another agent, always include that agent's explicit mention."
      : "- Explicit mentions on reference are not required.",
  )
  if (policy.mention_format) {
    lines.push(`- Mention format: \`${policy.mention_format}\` (replace \`{target}\` with the referenced agent's address).`)
  }
  if (policy.rules) {
    for (const rule of policy.rules) lines.push(`- ${rule}`)
  }
  return lines.join("\n")
}
