[한국어](AGENTS.md) | [English](AGENTS.en.md)

# Naia ADK

AI Development Kit — personal AI development infrastructure for solo developers.
Fork, configure, connect to your AI tools. [`nextain/naia-adk`](https://github.com/nextain/naia-adk)

**Scope**: `naia-adk` = personal / solo. Team collaboration → [`naia-business-adk`](https://nextain.io/adk).

## Fork Chain

```
naia-adk                  ← Base (public, Apache 2.0)
  └── {org}-adk           ← Organization fork: company data + business submodules
        └── {user}-adk    ← Personal fork: personal data + project submodules
```

Fork on GitHub, then periodically sync upstream: `git fetch upstream && git merge upstream/main`

## Mandatory Reads

**Read these files at the start of every session:**

1. `.agents/context/agents-rules.json` — Project rules (SoT)
2. `.agents/context/ai-work-index.yaml` — Work type → workflow index
3. `.agents/context/project-index.yaml` — Context index + entry points
4. `.agents/context/terminology.yaml` — Terminology & communication policy (no neologisms, plain Korean default, parenthesize academic/acronym)

**On-demand (read when entering Plan or Review phases):**

4. `.agents/requirements/_index.yaml` — Product requirements index
5. `.agents/context/skills-index.yaml` — Skill trigger/summary index

**ctx on-demand sections (load ONLY what you need — never load the full file):**

`project-index.yaml` → `on_demand_loading` lists available section IDs. Load by topic:

| Need | Load |
|------|------|
| repo structure / SDLC / RBAC / fork customization | `.agents/context/repo-structure-standard.yaml` |
| workflow / IDD / review lessons | `.agents/context/lessons-workflow.yaml` |
| upstream / fork / contribution lessons | `.agents/context/lessons-upstream.yaml` |
| platform / CI / vLLM / Bazzite lessons | `.agents/context/lessons-platform.yaml` |
| React / IndexedDB / GitHub API lessons | `.agents/context/lessons-frontend.yaml` |
| document extraction (HWP/DOCX/PPTX) | `.agents/context/lessons-documents.yaml` |
| gstack comparison (sections 1-8) | `.agents/context/gstack-comparison.md` |
| gstack hook findings (A-E, F1-F10) | `.agents/context/gstack-hooks.md` |
| gstack priority list (P0-P3) | `.agents/context/gstack-priority.md` |
| push gating (research/dev/service) | `.agents/context/push-policy.yaml` |

Index for search: `.agents/context/.ctx-index.json` (auto-rebuilt by hook, gitignored)

## Project Structure

### Workspace Directories

| Directory | Tier | Purpose |
|-----------|------|---------|
| `data-company/` | T2 | Company general data (gitignored, per-fork) |
| `data-teams/` | T2 | Team-specific data — strategy, accounting (gitignored, per-fork) |
| `data-private/` | T3 | Personal data, env files (gitignored, per-fork) |
| `projects/` | T2 | Project repos (gitignored, per-fork) |
| `ref-*/` | T2 | Reference repos — placed at the workspace root as `ref-cline`, `ref-opencode`, etc. (gitignored, per-fork; see `project-index.yaml`) |
| `skills/` | T1 | Operational/runtime skills (served via dashboard API) |
| `packages/` | T1 | Runtime packages (pnpm workspace — 10 active) |
| `scripts/` | T1 | Utility scripts, tools |
| `templates/` | T1 | Document templates |
| `docs/` | T1 | Architecture, specs |

**`packages/` (10):** `core`·`server`·`dashboard`·`skill-spec`·`skills-builtin`·`openclaw-compat`·`persona`·`process`·`naia-anyllm`·`artifacts-spec` (standard schema for permission (RBAC) and development-lifecycle (SDLC) artifacts — 15 artifact types defined as JSON Schema).

### Fork Customization

After forking, create a `FORK.md` in the fork root with:

- Organization/user info
- Project list (submodules in `projects/`)
- Data submodules (`data-company/`, `data-teams/`)
- Default language for `.users/` mirror
- Any fork-specific conventions

## Development Process

### Feature Development (default) — Issue-Driven Development

For feature-level work (new features, broad bug fixes). **14 phases:**

1. **Issue** — Create or receive GitHub Issue (English)
2. **Understand** — Summarize understanding and confirm it internally (gate)
3. **Scope** — Define investigation scope/depth and validate it internally (gate)
4. **Investigate** — Code-centric investigation within confirmed scope
5. **Plan** — Comprehensive plan based on ALL findings, internal validation (gate)
6. **Build** — Implement according to approved plan
7. **Review** — Iterative review (repeat until TWO consecutive clean passes) → run `/verify-implementation`
8. **E2E Test** — Run actual app/server, targeted tests first then full suite
9. **Post-test Review** — Re-review after tests pass (repeat until TWO consecutive clean passes) → run `/verify-implementation`
10. **Sync** — Update `.agents/` + `.users/` context → run `/manage-skills` → internal confirmation (gate)
11. **Sync Verify** — Verify context accuracy (repeat until TWO consecutive clean passes)
12. **Report** — Summarize results to user
13. **Commit** — If in worktree: use `/merge-worktree`. Otherwise: commit referencing Issue number, create PR
14. **Close** — Phase-by-phase completion report to issue comments + internal confirmation (gate)

**Gate authority rule:** For a bounded user request, Understand, Scope, Plan, Sync, and Close are internal execution checkpoints. Do not ask the user to reconfirm or click an approval merely because one of these phases begins. Ask only when a material unresolved choice would change the requested scope or when separate authority is required for an exception such as destructive work, cost, or external communication.

**Routine action authority:** A bounded request authorizes its normal path: read-only inspection; in-scope development, documentation, tests, and builds; non-destructive fetch, pull, merge, rebase, and commit; and non-force push. Preserve this authority in subagent and resumed-session handoffs and do not ask again for the same work. Separate authority is required only for material deletion or irrecoverable loss, force push or history rewrite, forced unrelated-history merge, unsolicited external communication, material cost, production-destructive mutation, or material scope expansion. A tool-runtime permission prompt is a platform control, not a reason to request conversational approval again.

**Iterative review applies at 5 points:** After Plan, after each Build phase, after all Build phases, after E2E Test, after Sync.

**Principles:** Read upstream code first. Minimal modification. Never break working code. Propose improvements, never decide autonomously.

**Progress file (MANDATORY):** At every phase transition, write/update `.agents/progress/{issue-slug}.json`.

### End of EVERY session (mandatory)

Before ending any session, ALWAYS:
1. Update context files with new knowledge (.agents/ ↔ .users/ ↔ entry point files)
2. Record lessons-learned if corrections or mistakes occurred
3. Commit and push all changes

This transfers your learning to the next AI session.

### Simple Changes (lightweight cycle)

For non-feature changes: typos, config values, simple directives.

## Skills

There are **two skill trees** on disk, with different SoTs and consumers:

| Tree | SoT for | Consumed by | Index |
|------|---------|-------------|-------|
| `.agents/skills/` | AI-assistant / workflow skills | Claude Code (via `.claude/skills/` pointers) | `.agents/context/skills-index.yaml` |
| `skills/` | operational / runtime skills | dashboard API (`core.discoverSkills()` scans `skills/**/SKILL.md`) | served at `/api/skills` |

`skills-index.yaml` is the human/AI summary index for the `.agents/skills/` tree.

### `.agents/skills/` (Claude Code SoT — `.claude/skills/` pointers point here)

| Skill | Description | Management |
|-------|-------------|------------|
| `review-pass` | Multi-agent cross-validation review (4 stages) | Auto (phase 7, 9) |
| `verify-implementation` | Run all `verify-*` skills, generate unified report | Auto (phase 7, 9) |
| `verify-contract-conformance` | Verify declared API/interface contracts vs implementation | Auto |
| `manage-skills` | Analyze changes, create/update `verify-*` skills | Auto (phase 10) |
| `merge-worktree` | Squash-merge worktree → main with semantic commits | Manual (phase 13) |
| `read-doc` | Extract text from HWP/PDF/DOCX/XLSX/PPTX | Manual |
| `webapp-testing` | Playwright E2E testing for local web apps | Manual |
| `doc-coauthoring` | Structured document co-authoring (3-step) | Manual |
| `project-create` | Scaffold a new project repo from the template | Manual |
| `project-migration` | Extract a directory into its own repo / harden harness | Manual |
| `migrate-ctx` | Migrate context files to the current standard | Manual |
| `payroll` | Payroll statement PDF + email dispatch | Manual |
| `press-release` | Press release writing, outreach, distribution | Manual |
| `patent-draft` | KIPO-format patent specification drafting | Manual |
| `patent-pipeline` | AI patent discovery, evaluation, and filing | Manual |
| `copyright-reg` | Copyright registration document generation | Manual |
| `weekly-report` | Weekly work report from git commits | Manual |
| `finetune-persona` | Prepare persona fine-tune assets | Manual |
| `secret-vault` | Open/edit/re-lock the age-encrypted secret vault | Manual |
| `youtube-upload` | Upload videos via YouTube Data API v3 (captions, thumbnail) | Manual |

### `skills/` (operational tree — scanned by the dashboard API)

| Skill | Description |
|-------|-------------|
| `email` | Send emails via SMTP adapter with template support |
| `sms` | Send SMS / Korean business messages (알림톡) via gateway adapter |
| `notify` | Send a notification to a channel (channel-agnostic) |
| `channel-management` | Manage Discord/Slack channels — create, archive, notify, summarize |
| `service-management` | Monitor deployed services — uptime, cost, incident response |
| `web-monitoring` | Web presence monitoring — SEO, uptime, analytics |
| `document-generation` | Generate branded PDFs (contracts, resolutions, payroll) |
| `read-doc` | Extract text from HWP/HWPX/PDF/DOCX/XLSX/PPTX |
| `doc-coauthoring` | Structured document co-authoring (3-step) |
| `review-pass` | Multi-agent cross-validation review (4 stages) |
| `config` | Read or update configuration values |
| `cron` | Schedule recurring / one-shot skill invocations |
| `diagnostics` | System diagnostics — health, resources, network |
| `system-status` | High-level OS / runtime status |
| `sessions` | List, query, or summarize past conversation sessions (read-only) |
| `memo` | Write a memo to long-term memory |
| `skill-manager` | Manage the skill catalog — list, install from trusted repos |
| `time` | Get current time in any timezone |
| `weather` | Get current weather or forecast for a location |

> `read-doc`, `doc-coauthoring`, and `review-pass` exist in **both** trees; the dashboard
> API only sees the `skills/` copies (its glob never descends into `.agents/`).

Business/organizational layers (`naia-business-adk`) extend these with team ownership,
delegated approval, and additional org-specific skills — but the skills listed above ship
in this base repo.

## Repository Structure Standard

Per-repo documentation, SDLC artifact lifecycle, RBAC tiers, multi-project management, and fork customization rules.

**SoT**: `.agents/context/repo-structure-standard.yaml`
**Human mirror (Korean)**: `.users/context/repo-structure-standard.md`

Covers: repo types (`workspace_adk` / `runtime_library` / `app_os`) · mirror patterns (dual/triple/split) · harness sync · `.agents/progress/` lifecycle · T0~T3 RBAC tiers + `naia-business-adk` extension points · multi-project blocking rules · fork override mechanism.

**Fork customization**: create `FORK.md` in fork root with `overrides:` section. Precedence: naia-adk defaults → naia-business-adk additions → {org}-adk FORK.md → {user}-adk FORK.md (highest).

---

## Directory Structure (Dual-directory Architecture)

```
.agents/                    # AI-optimized (English, token-efficient)
├── context/
│   ├── agents-rules.json   # Main rules (SoT) ← mandatory read
│   └── ai-work-index.yaml  # Work index ← mandatory read
├── workflows/              # Development workflows
├── skills/                 # Skill definitions (SoT)
├── hooks/                  # AI session hooks
└── requirements/           # Product requirements

.users/                     # Human-readable mirror
├── context/                # .agents/ mirror in Markdown
├── workflows/
└── skills/                 # .agents/skills/ mirror

.claude/                    # Claude Code configuration
├── settings.json           # Hooks registration
├── hooks/                  # PostToolUse hooks
└── skills/                 # Pointers → .agents/skills/
```

## Core Principles

1. **Partial mirroring**: `.users/` mirrors the human-facing core documents from `.agents/` (not a full copy — some things, like skills, exist only under `.agents/`)
2. **SoT**: `.agents/context/agents-rules.json` is the single source of truth
3. **Response language**: Contributor's preferred language

## Cascade Rules (Context Propagation)

When context changes, propagate to related modules.

| Trigger | Propagate To |
|---------|-------------|
| Rules file changed | `.users/` mirror |
| Entry point files changed | `AGENTS.md` ↔ `CLAUDE.md` ↔ `GEMINI.md` (keep identical) |

**Order**: self → parent → siblings → children → mirror

## Conventions

- **Development**: Issue-driven development (default). TDD where applicable.
- **Language**: Git/shared (commits, issues, PR) → English. Personal notes → any language.
- **License**: Apache 2.0

## License

```
Copyright 2026 Nextain Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```
