# Naia ADK

AI Development Kit — an open-source framework for personal and business AI operations.
Fork, configure, connect to your AI tools. [`nextain/naia-adk`](https://github.com/nextain/naia-adk)

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

**On-demand (read when entering Plan or Review phases):**

4. `.agents/requirements/_index.yaml` — Product requirements index
5. `.agents/context/skills-index.yaml` — Skill trigger/summary index

## Project Structure

### Workspace Directories

| Directory | Tier | Purpose |
|-----------|------|---------|
| `data-company/` | T2 | Company general data (gitignored, per-fork) |
| `data-business/` | T3 | Company sensitive data (gitignored, per-fork) |
| `data-private/` | T3 | Personal data (gitignored, per-fork) |
| `projects/` | T2 | Project repos (gitignored, per-fork) |
| `projects/refs/` | T2 | Reference repos (gitignored, per-fork) |
| `skills/` | T1 | AI skills |
| `packages/` | T1 | Runtime packages (future) |
| `scripts/` | T1 | Utility scripts, tools |
| `templates/` | T1 | Document templates |
| `docs/` | T1 | Architecture, specs |

### Fork Customization

After forking, create a `FORK.md` in the fork root with:

- Organization/user info
- Project list (submodules in `projects/`)
- Data submodules (`data-company/`, `data-business/`)
- Default language for `.users/` mirror
- Any fork-specific conventions

## Development Process

### Feature Development (default) — Issue-Driven Development

For feature-level work (new features, broad bug fixes). **14 phases:**

1. **Issue** — Create or receive GitHub Issue (English)
2. **Understand** — Summarize understanding, get user confirmation (gate)
3. **Scope** — Define investigation scope/depth, user approval (gate)
4. **Investigate** — Code-centric investigation within confirmed scope
5. **Plan** — Comprehensive plan based on ALL findings, user approval (gate)
6. **Build** — Implement according to approved plan
7. **Review** — Iterative review (repeat until TWO consecutive clean passes) → run `/verify-implementation`
8. **E2E Test** — Run actual app/server, targeted tests first then full suite
9. **Post-test Review** — Re-review after tests pass (repeat until TWO consecutive clean passes) → run `/verify-implementation`
10. **Sync** — Update `.agents/` + `.users/` context → run `/manage-skills` → user confirmation (gate)
11. **Sync Verify** — Verify context accuracy (repeat until TWO consecutive clean passes)
12. **Report** — Summarize results to user
13. **Commit** — If in worktree: use `/merge-worktree`. Otherwise: commit referencing Issue number, create PR
14. **Close** — Phase-by-phase completion report to issue comments + user confirmation (gate)

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

AI assistant skills. **SoT: `.agents/skills/`** — `.claude/skills/` is symlinks.

### Base Skills

| Skill | Description | Management |
|-------|-------------|------------|
| `review-pass` | Multi-agent cross-validation review (4 stages) | Auto (phase 7, 9) |
| `verify-implementation` | Run all `verify-*` skills, generate unified report | Auto (phase 7, 9) |
| `manage-skills` | Analyze changes, create/update `verify-*` skills | Auto (phase 10) |
| `merge-worktree` | Squash-merge worktree → main with semantic commits | Manual (phase 13) |
| `read-doc` | Extract text from HWP/PDF/DOCX/XLSX/PPTX | Manual |
| `webapp-testing` | Playwright E2E testing for local web apps | Manual |
| `doc-coauthoring` | Structured document co-authoring (3-step) | Manual |

### Business Extension Skills

Available in `naia-business-adk`:

| Skill | Description | Management |
|-------|-------------|------------|
| `payroll` | Payroll PDF generation + email dispatch | Manual |
| `press-release` | Press release writing, outreach, distribution | Manual |
| `patent-draft` | KIPO-format patent specification drafting | Manual |
| `patent-pipeline` | AI patent discovery, evaluation, and filing | Manual |
| `copyright-reg` | Copyright registration document generation | Manual |
| `weekly-report` | Weekly work report from git commits | Manual |
| `email` | Email composition and dispatch | Manual |
| `sms` | SMS notification sending | Manual |
| `channel-management` | Multi-channel communication management | Manual |
| `service-management` | Service monitoring and management | Manual |
| `web-monitoring` | Web content monitoring and alerting | Manual |
| `document-generation` | Automated document generation | Manual |

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
└── skills/                 # Symlinks → .agents/skills/
```

## Core Principles

1. **1:1 Mirroring**: `.users/` mirrors `.agents/` structure exactly
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
