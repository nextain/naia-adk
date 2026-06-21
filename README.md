[English](README.md) | [한국어](docs/README.ko.md)

# Naia ADK

**Workspace scaffold + governance baseline for AI-assisted work.**

An open-source framework that provides a structured workspace scaffold for AI coding tools (opencode, Claude Code, Codex, Naia OS) and a built-in dashboard for managing it.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

## What is Naia ADK?

Naia ADK is a **workspace scaffold** — a pre-configured directory structure, skills, context files, and data tiers that AI coding agents use as their working environment. It also includes a **dashboard** for monitoring and configuring the workspace itself.

It is also the **minimum governance baseline** for solo AI collaboration:

- It separates `read`, `write`, `execute`, and `publish` as different concerns.
- It gives AI tools a shared vocabulary for disclosure levels and approval-gated actions.
- It provides a common place to encode context discipline before workspaces scale into teams or companies.

```
naia-adk = Workspace Scaffold + Dashboard

┌─────────────────────────────────────────────┐
│  naia-adk                                    │
│                                              │
│  Scaffold (워크스페이스 스캐폴드)             │
│  ├── .agents/    skills/  scripts/           │
│  ├── data-company/  data-teams/              │
│  ├── data-private/  projects/                │
│  └── context files (agents-rules.json, etc.) │
│                                              │
│  Dashboard (대시보드)                         │
│  ├── Workspace viewer                        │
│  ├── Skills catalog                          │
│  └── Settings & monitoring                   │
│                                              │
└──────────┬───────────────────────────────────┘
           │
     ┌─────┼─────┬──────────┐
     ▼     ▼     ▼          ▼
 opencode  Claude  Codex   Naia OS
           Code            (Desktop)
```

**Workflow clients** (opencode, Claude Code, Codex, Naia OS) use naia-adk as their workspace. The dashboard is for *managing* the workspace — not for doing work.

> **Scope**: `naia-adk` is for **solo / personal** use. Team collaboration, RBAC, and shared knowledge belong in [`naia-business-adk`](https://nextain.io/adk).

### Interfaces, not dependencies

naia-adk is a **tool-agnostic workspace format**. It does not depend on any specific AI tool, and AI tools do not have to depend on naia-adk's runtime either:

- **The format is the contract** — directory layout (`.agents/`, `.users/`, `skills/`, `data-*/`), file schemas (`agents-rules.json`, SKILL.md), and conventions. Any AI coding tool that can read these can consume a naia-adk workspace.
- **No runtime coupling** — Claude Code, OpenCode, Codex, and naia-agent all read the same format independently. None of them embed naia-adk's code.
- **Swap freely** — switch tools, fork the workspace for a new org, or mix tools within the same project. The workspace keeps working.

This is part of the broader Naia ecosystem philosophy: repos are coupled through **published interfaces and formats**, not runtime dependencies. See the [naia-agent README](https://github.com/nextain/naia-agent) for the full picture.

**Plugin-adaptive**: The scaffold adapts to what you plug in. Skills, data directories, project submodules, and AI tool connections are all pluggable — add what you need, ignore what you don't.

```
Plugin-Adaptive Structure

naia-adk (core scaffold)
│
├── Plugins (plug in what you need)
│   ├── Skills/              ← Skill plugins (SKILL.md)
│   ├── Data submodules      ← data-company/, data-teams/
│   ├── Project submodules   ← projects/your-project
│   ├── AI tool configs      ← .claude/, .agents/
│   └── Custom workflows     ← .agents/workflows/
│
├── Adapters (adapt to your environment)
│   ├── AI tool adapter      ← opencode / Claude Code / Codex / Naia OS
│   ├── Data source adapter  ← local filesystem / cloud / git
│   └── Language adapter     ← .users/ mirror in any language
│
└── Ports (connect from anywhere)
    ├── REST API             ← Any HTTP client
    ├── WebSocket            ← Real-time events
    ├── Direct filesystem    ← CLI tools
    └── Tauri IPC            ← Naia OS native
```

### Context Knowledge Management (Planned)

The current file-based context system (`.agents/context/*.yaml`) requires loading entire files to find any piece of information — wasting tokens and injecting unrelated noise into LLM context.

The planned evolution:

```
Current:  Grep files → load entire file (~4000 tokens) → 50x waste
Planned:  query atom → get exact knowledge unit (~80 tokens)
```

**Knowledge atoms** — the smallest meaningful knowledge unit, tagged and linked:

```json
{
  "id": "naia-os:gateway_health_cmd",
  "title": "gateway_health Tauri Command",
  "tags": ["tauri", "rust", "health-check"],
  "related": ["naia-os:naia_agent_lifecycle"],
  "content": "...",
  "updated": "2026-05-17"
}
```

**AI-agnostic access** via CLI or MCP — works with Claude Code, Codex, naia-agent, or any tool with shell access. No runtime lock-in.

`naia-business-adk` extends this with shared team knowledge, RBAC, and conflict resolution.

### Minimum Governance Baseline

Even a single-user workspace needs governance once AI and automation are involved.

- **Disclosure levels** — `public`, `controlled`, `internal`, `confidential`
- **Action vocabulary** — `read`, `write`, `execute`, `publish`, `approve`, `administer`
- **Approval-gated actions** — production mutation, secret handling, and public-facing claims are separate from normal local edits
- **Context discipline** — session-local context should not be promoted into persistent/shared context without intent

`naia-adk` is the personal base. Company-specific org charts, tenant rules, and approval chains belong in higher layers.

### The Fork Chain

```
naia-adk                  ← Personal base (public, Apache 2.0)
  ├─ naia-business-adk   ← Business upstream (private)
  │    └── {org}-adk     ← Company instance: org data + projects + policy
  │          └── {user}-adk  ← Company-linked personal instance
  └── {user}-adk         ← Direct personal instance
```

Example — Nextain's chain:

```
naia-adk → naia-business-adk → nextain-adk → alpha-adk
```

Fork from any layer. Individuals can fork `naia-adk` directly. Organizations go through `naia-business-adk`, then instantiate company and member workspaces from there.

### Business Extension

**[Naia Business ADK](https://nextain.io/adk)** — organizational extension of `naia-adk`:

- Extends the baseline with **assets / process / permissions** governance
- Adds team ownership, delegated approval, and business workflow expectations
- May include organizational skills and templates, but those are outputs of the governance layer rather than the product definition
- Supports private company instances and member instances

[Contact us](https://nextain.io/contact) for licensing.

## What's Inside

| Directory | Purpose |
|-----------|---------|
| `.agents/` | AI-optimized context (English, JSON/YAML) |
| `.users/` | Human-readable mirror (Korean, Markdown) |
| `.claude/` | Claude Code configuration, hooks, skills |
| `skills/` | Reusable AI skills (review, email, SMS, docs, etc.) |
| `scripts/` | Utility scripts (monitoring, triage, etc.) |
| `templates/` | Document templates |
| `docs/` | Architecture docs, design specs |
| `packages/` | Runtime packages (pnpm workspace) — see below |

**`packages/` (9 active):** `core` (workspace/skill parsing engine) · `server` (Fastify REST/WS API) · `dashboard` (Next.js UI) · `skill-spec` (tool-agnostic skill format contracts) · `skills-builtin` (generic skills catalog) · `openclaw-compat` (OpenClaw → naia skill migration) · `persona` (system-prompt convention spec) · `process` (workflow pattern spec) · `naia-anyllm` (LLM adapter for any-llm gateway / direct providers).

### Data Directories (gitignored — managed per fork)

| Directory | Scope | Content |
|-----------|-------|---------|
| `data-company/` | Company | Company-wide docs, shared resources |
| `data-teams/` | Team | Team-specific documents (strategy, accounting) |
| `data-private/` | Personal | Personal data, env files, private docs |
| `projects/` | Personal | Project repos (submodules) |

## Skills

naia-adk ships with **two skill trees** (see [AGENTS.md](AGENTS.md#skills) for the full list):

- **`.agents/skills/`** — AI-assistant / workflow skills, used by Claude Code via `.claude/skills/` symlinks. Indexed by `.agents/context/skills-index.yaml`.
- **`skills/`** — operational / runtime skills, discovered by the dashboard API (`discoverSkills()` scans `skills/**/SKILL.md`) and served at `/api/skills`.

Workflow skills (`.agents/skills/`):

| Skill | Description |
|-------|-------------|
| `review-pass` | Multi-agent cross-validation review (4 stages) |
| `verify-implementation` | Run all verification skills, generate unified report |
| `verify-contract-conformance` | Verify declared API/interface contracts vs implementation |
| `manage-skills` | Auto-detect and update verification skills |
| `merge-worktree` | Squash-merge worktree branches with semantic commits |
| `read-doc` | Extract text from HWP/PDF/DOCX/XLSX/PPTX |
| `webapp-testing` | Playwright E2E testing for local web apps |
| `doc-coauthoring` | Structured document co-authoring (3-step) |
| `project-create` · `project-migration` · `migrate-ctx` | Scaffold / extract / migrate workspace repos & context |
| `payroll` · `press-release` · `patent-draft` · `patent-pipeline` · `copyright-reg` · `weekly-report` | Document & business-workflow skills (also present in this base repo) |

Operational skills (`skills/`):

| Skill | Description |
|-------|-------------|
| `email` | Send emails via SMTP adapter with template support |
| `sms` | SMS / Korean business messages (알림톡) via gateway adapter |
| `notify` | Send a notification to a channel (channel-agnostic) |
| `channel-management` | Discord/Slack channel management |
| `service-management` | Service monitoring, cost tracking, incident response |
| `web-monitoring` | SEO, uptime, analytics monitoring |
| `document-generation` | Branded PDF generation (contracts, resolutions, payroll) |
| `config` · `cron` · `diagnostics` · `system-status` · `sessions` · `memo` · `skill-manager` · `time` · `weather` | Runtime utilities |

> **Note:** Organizational layers ([Naia Business ADK](#business-extension)) extend these with team ownership, delegated approval, and additional org-specific skills.

## Architecture

Naia ADK is a **workspace scaffold with its own API** — tool-agnostic by design:

```
naia-adk
├── Scaffold (workspace structure)
│   ├── .agents/  .users/  .claude/  skills/  scripts/
│   ├── data-company/  data-teams/  data-private/
│   └── projects/
│
├── API Server (Fastify)
│   ├── /api/workspace   ← Workspace metadata, file tree, classification
│   ├── /api/skills      ← Skill catalog and content
│   ├── /api/files       ← File read/write
│   └── /api/ws          ← WebSocket (file change events)
│
└── Dashboard (Next.js)
    ├── /                ← Overview
    ├── /workspace       ← Projects, submodules, visibility
    ├── /skills          ← Skill catalog viewer
    └── /settings        ← Server config, client status, data dirs
```

Any AI tool can connect — not limited to Claude Code, Codex, or Naia OS:

| Client | Connection | Role |
|--------|-----------|------|
| opencode | Direct filesystem | TUI coding agent |
| Claude Code | Direct filesystem + hooks | CLI coding agent |
| pi | Direct filesystem + extension | CLI coding agent |
| Codex | REST API | CLI coding agent |
| Naia OS | REST API + WebSocket | Desktop app |
| Browser | Dashboard | Monitoring & settings |

The enforcement harness is **tool-agnostic**: a host-neutral core
(`.agents/hooks/core/`) + policies (`.agents/hooks/policies/`) drive both
the Claude Code hooks (`.claude/hooks/`) and the pi extension
(`.pi/extensions/naia-harness.ts`) — the same guards run on either host
with zero core change.

### LLM Connection

naia-adk includes **naia-anyllm** — a built-in LLM adapter that connects to [any-llm](https://github.com/nextain/any-llm) gateway or directly to LLM providers:

```
naia-adk
└── packages/
    └── naia-anyllm/        ← LLM adapter (plugin)
        ├── Any-LLM Gateway ← nextain/any-llm (credits, auth, routing)
        ├── Direct providers ← OpenAI, Anthropic, Google, etc.
        └── Config           ← .agents/context/llm-config.yaml (optional)
```

Config is **optional** — `naia-anyllm` ships sensible defaults (any-llm gateway + OpenAI / Anthropic / Google direct providers). To override them, copy [`.agents/context/llm-config.yaml.example`](.agents/context/llm-config.yaml.example) to `.agents/context/llm-config.yaml`. API keys live in env vars (see [`.env.example`](.env.example)), never in the config file.

CLI tools (opencode, Claude Code, Codex) use their own LLM connections. naia-os connects through naia-anyllm to the any-llm gateway.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for full details.

## Quick Start

### Run the dashboard & API

Requires **Node ≥ 22** and **pnpm ≥ 9**.

```bash
pnpm install          # install workspace deps
pnpm dev              # start API (:3141) + dashboard (:3142) together
# or run them separately:
pnpm dev:server       # API only  → http://localhost:3141
pnpm dev:dashboard    # dashboard → http://localhost:3142
```

Convenience launchers are also provided: `./start.sh` (Linux/macOS) and `start.bat` (Windows), both of which run `pnpm dev`. The server CLI accepts `--port`, `--host`, and `--root` (e.g. `pnpm serve -- --root /path/to/workspace`).

| Service | Default URL | Source |
|---------|-------------|--------|
| API server (Fastify) | `http://localhost:3141` | `packages/server` |
| Dashboard (Next.js) | `http://localhost:3142` | `packages/dashboard` |

The dashboard proxies `/api/*` to the API server on port 3141.

### For Individuals

1. **Private fork** — Fork `naia-adk` to your account (uncheck "Public fork" if available, or fork then change to private in Settings)
2. **Clone** — `git clone https://github.com/YOUR-USER/your-adk.git && cd your-adk`
3. **Add upstream** — `git remote add upstream https://github.com/nextain/naia-adk.git`
4. **Create data dirs** — `mkdir -p data-private projects`
5. **Start working** — Add projects, configure `.agents/`, use skills
6. **Sync upstream** — Periodically: `git fetch upstream && git merge upstream/main`

### For Organizations

1. **Get Naia Business ADK** — [Contact us](https://nextain.io/contact) for `naia-business-adk` access
2. **Private fork** — Fork `naia-business-adk` to your org as private
3. **Clone** — `git clone https://github.com/YOUR-ORG/your-org-adk.git && cd your-org-adk`
4. **Add upstream** — `git remote add upstream https://github.com/nextain/naia-business-adk.git`
5. **Add company data** — `mkdir -p data-company data-business projects`
6. **Add submodules** — `git submodule add <repo> projects/<name>`
7. **Team onboarding** — Each member forks the org ADK for their personal workspace
8. **Sync upstream** — Periodically: `git fetch upstream && git merge upstream/main`

### Connect to Naia OS (optional)

If you use [Naia OS](https://github.com/nextain/naia-os), point its workspace path to your ADK directory. Skills and data are served via MCP/WebSocket.

## Disclosure Levels

| Level | Meaning | Example |
|------|---------|---------|
| `public` | Safe for public website, public README, public repo context | Open-source code, public docs |
| `controlled` | Shareable externally with review, but not fully public by default | Approved brand assets, vetted partner material |
| `internal` | Company or workspace internal | Shared docs, internal resources |
| `confidential` | Sensitive, customer-bound, financial, credential, or production-critical | Contracts, credentials, personal data |

Credentials and secret material usually live outside git, but they still belong to the `confidential` disclosure level.

## Development Process

### Issue-Driven Development (default)

14-phase workflow for feature-level work:

Issue → Understand → Scope → Investigate → Plan → Build → Review → E2E Test → Post-test Review → Sync → Sync Verify → Report → Commit → Close

Gates (user confirmation required): Understand, Scope, Plan, Sync, Close.

### Simple Changes

For typos, config values, simple directives — lightweight cycle without full phase flow.

See [`.agents/workflows/issue-driven-development.yaml`](.agents/workflows/issue-driven-development.yaml) for details.

## Context Structure

Dual-directory architecture optimized for both AI and human consumption:

```
.agents/                    # AI-optimized (English, token-efficient)
├── context/                # Project rules, work index, requirements
├── workflows/              # Development workflows
├── skills/                 # Skill definitions (SoT)
├── hooks/                  # AI session hooks
├── progress/               # Session handoff files (gitignored)
└── requirements/           # Product requirements (REQ-001 ~)

.users/                     # Human-readable mirror (Korean, detailed)
├── context/                # .agents/ mirror in Markdown
├── workflows/              # Workflow docs
└── skills/                 # Skill docs
```

## Contributing

**Any language is welcome.** Issues, PRs, discussions can be in your native language — AI bridges communication.

Git records (commits, context, shared artifacts) in English.

1. **Issue first** — Create or pick a GitHub Issue before coding
2. **Fork + Branch** — Work on `issue-{N}-{desc}` branch
3. **Test** — Write tests, verify before PR
4. **One PR** — Code + tests + context in a single PR

10 contribution types: Translation, Skill, Feature, Bug Report, Code/PR, Documentation, Testing, Design/UX, Security Report, Context.

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

## Links

- **Naia OS** — [github.com/nextain/naia-os](https://github.com/nextain/naia-os)
- **Nextain** — [nextain.io](https://nextain.io)
- **Naia Dashboard** — [naia.nextain.io](https://naia.nextain.io)
