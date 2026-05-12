# @naia-adk/openclaw-compat

OpenClaw → naia skill catalog migration tool.

Parses [OpenClaw](https://github.com/nextain/openclaw) `SKILL.md` frontmatter (`name`, `description`, `allowed-tools`) and emits `@naia-adk/skill-spec` `SkillDescriptor` objects.

Built for one-shot migration of an OpenClaw skill library into a naia-compatible catalog file. See [nextain/naia-os#275](https://github.com/nextain/naia-os/issues/275) for design.

## Quick start

### CLI

```bash
# Single catalog directory (e.g. OpenClaw container/skills/)
npx naia-openclaw-migrate /path/to/openclaw/container/skills my-catalog.ts

# OpenClaw groups system (e.g. groups/{global,main}/skills/)
npx naia-openclaw-migrate --groups /path/to/openclaw/groups my-catalog.ts
```

The output is a TypeScript module ready to drop next to `@naia-adk/skills-builtin` exports — one `<name>Descriptor` per skill + an `ALL_OPENCLAW_DESCRIPTORS` array.

### Programmatic

```ts
import { parseOpenClawCatalog, emitCatalog } from "@naia-adk/openclaw-compat";
import { writeFileSync } from "node:fs";

const skills = parseOpenClawCatalog("/path/to/openclaw/container/skills");
const tsSource = emitCatalog(skills);
writeFileSync("my-catalog.ts", tsSource);

// Or inspect:
for (const s of skills) {
  console.log(`${s.descriptor.name} → ${s.descriptor.tier} (${s.descriptor.tags?.join(",")})`);
}
```

## Mapping rules

| OpenClaw frontmatter | naia SkillDescriptor field | Notes |
|---|---|---|
| `name` | `name` (snake_case) | `agent-browser` → `agent_browser` |
| `description` | `description` | Pass-through |
| `allowed-tools` | `tags` + tier inference | `Bash(...)` → tag `subprocess` |
| `tier` (when present) | `tier` | Explicit "T0".."T3" wins |
| (body) | not used | `keepBodySnippet: true` saves first 500 chars as a tag |

Tier inference (when not explicit):

- Destructive verbs (`delete`, `remove`, `destroy`, `drop`, `wipe`, `purge`) **and** Bash/Write tool → `T2`
- Bash or Write tool → `T1`
- Read-only / no tools → `T0`

InputSchema for migrated descriptors defaults to `{ type: "object", properties: {} }` — OpenClaw skills are prompt-based and don't expose JSON schemas. After migration, tighten the schema manually if the skill takes structured args.

## What's not migrated

- **Skill body** (the markdown documentation in SKILL.md). It's the LLM prompt. naia-os exec-style skills don't use it. If you want it, pass `keepBodySnippet: true` to truncate the first 500 chars into a tag, or read the file yourself.
- **Execution code**. OpenClaw skills invoke external commands via `Bash(cmd:*)`. The migrated descriptor names the skill; you provide the `execute()` runtime separately in your agent.
- **Skill scripts** (`<skill>/scripts/*`). OpenClaw bundles supplementary scripts; copy them yourself if needed.

## Coverage

Tested against [`nextain/openclaw`](https://github.com/nextain/openclaw) `container/skills/`:

| Skill | Tier inferred | Tags |
|---|---|---|
| `agent_browser` | T1 | openclaw-port, subprocess, browser |
| `frontend_engineer` | T0 | openclaw-port |
| `self_customize` | T0 | openclaw-port |
| `slack_formatting` | T0 | openclaw-port, channel |
| `vercel_cli` | T0 | openclaw-port, deploy |
| `welcome` | T0 | openclaw-port |

`agent_browser` and `welcome` are also live in `@naia-adk/skills-builtin` (manually ported via [#274](https://github.com/nextain/naia-os/issues/274)). Use this package when you have your own OpenClaw skill library to bring across.

## License

Apache 2.0. Same as the rest of naia-adk.
