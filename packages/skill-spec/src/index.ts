/**
 * @naia-adk/skill-spec — Tool-agnostic skill format spec.
 *
 * Zero runtime deps. Defines the contracts every AI coding tool needs to
 * read/write naia-adk skills: `SkillDescriptor`, `SkillInput`, `SkillOutput`,
 * `SkillLoader`.
 *
 * Consumed by claude-code, opencode, codex, naia-agent, and any future
 * AI coding tool that understands the naia-adk workspace format.
 *
 * Tier types are defined here (not imported from @nextain/agent-types) so
 * skill-spec remains tool-agnostic — it does not depend on the Naia runtime.
 * Values are intentionally identical to @nextain/agent-types TierLevel.
 */

/**
 * Security tier for a skill. Matches @nextain/agent-types TierLevel values
 * but is defined independently to keep skill-spec zero-dep and tool-agnostic.
 */
export type SkillTier = "T0" | "T1" | "T2" | "T3";

/** Metadata parsed from SKILL.md front-matter. */
export interface SkillDescriptor {
  /** Unique within a workspace. Kebab-case recommended. */
  name: string;
  description: string;
  /** Semver. */
  version: string;
  tier: SkillTier;
  /** JSON Schema for skill input. Shape is opaque here. */
  inputSchema: Record<string, unknown>;
  /** Where the skill definition lives (relative path from workspace root). */
  sourcePath?: string;
  /** Skill author / maintainer. */
  author?: string;
  /** Optional tags for discovery / categorization. */
  tags?: string[];
}

export interface SkillInput {
  args: unknown;
  /** Host-supplied context (sessionId, project, user, ...). */
  context?: Record<string, string>;
}

export interface SkillOutput {
  content: string;
  /** Optional structured data alongside the text blob. */
  data?: unknown;
  isError?: boolean;
}

export interface SkillLoader {
  /** Enumerate all discoverable skills in the workspace. */
  list(): Promise<SkillDescriptor[]>;
  /** Fetch a descriptor by name. Returns null if not found. */
  get(name: string): Promise<SkillDescriptor | null>;
  /** Execute a skill. Implementations route to the appropriate runtime. */
  invoke(name: string, input: SkillInput): Promise<SkillOutput>;
}

/** SKILL.md front-matter YAML schema (documented separately; this is the
 *  type-level shape a loader expects after YAML parse + validation). */
export interface SkillManifest {
  name: string;
  description: string;
  version?: string;
  tier?: SkillTier;
  input_schema?: Record<string, unknown>;
  author?: string;
  tags?: string[];
}
