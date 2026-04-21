# Changelog — `@naia-adk/skill-spec`

Independent semver. Not lockstep with the `naia-adk` repo tag (plan A.8).

## 0.1.0 — 2026-04-21 — Phase 1 freeze

First stable-shape release. Additive-only rule active from here
(plan A.5 freeze; removals/type changes require MAJOR bump + 4-week
advance notice per plan A.11).

### Contents

- `SkillDescriptor` — name, description, version, tier, inputSchema, sourcePath, author, tags
- `SkillInput` — args + optional context
- `SkillOutput` — content, optional data, isError
- `SkillLoader` — `list()` / `get(name)` / `invoke(name, input)`
- `SkillManifest` — SKILL.md front-matter type shape
- `SkillTier` — "T0" | "T1" | "T2" | "T3" (independently defined; identical values to `@nextain/agent-types` TierLevel, kept separate to preserve tool-agnostic zero-dep guarantee)

### Tool-agnostic guarantee

Zero runtime dependencies. No import from `@nextain/*`. Any AI coding
tool (Claude Code, OpenCode, Codex, naia-agent, future) can depend on
this package without pulling the Naia runtime.
