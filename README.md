[English](README.md) | [한국어](docs/README.ko.md)

# Naia ADK

**AI Development Kit for personal and business operations.**

An open-source framework that connects AI agents, skills, data, and workflows into a unified workspace. Fork it, configure it, make it yours.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

## What is Naia ADK?

Naia ADK is the foundation for AI-driven operations — a structured workspace that any individual or organization can fork and customize:

- **For individuals** — Personal AI workspace with skills, automation, and project management
- **For businesses** — Fork, inject company data and submodules, deploy across your team
- **For products** — Connects to [Naia OS](https://github.com/nextain/naia-os) as the skill and data backend via MCP/WebSocket

### The Fork Chain

```
naia-adk                  ← Base framework (public, Apache 2.0)
  ├─ naia-business-adk   ← Business extension (paid): payroll, HR, compliance
  │    └── {org}-adk     ← Organization fork: company data + submodules
  │          └── {user}-adk  ← Personal fork: personal data + projects
  └── {user}-adk         ← Direct fork: for individual use
```

Example — Nextain's chain:

```
naia-adk → naia-business-adk → nextain-adk → alpha-adk
```

Fork from any layer. Individuals can fork `naia-adk` directly. Organizations go through the business extension.

### Business Extension

**[Naia Business ADK](https://nextain.io/adk)** — paid extension for organizations:

- Pre-built business skills (payroll, accounting, HR document generation)
- Multi-tenant team management
- Priority support and SLA
- Compliance-ready templates (GDPR, PIPA)

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
| `packages/` | Runtime packages (future) |

### Data Directories (gitignored — managed per fork)

| Directory | Scope | Content |
|-----------|-------|---------|
| `data-company/` | Business | Company-wide docs, shared resources |
| `data-business/` | Business | Sensitive business data (accounting, contracts) |
| `data-private/` | Personal | Personal data, env files, private docs |
| `projects/` | Personal | Project repos (submodules) |

## Skills

Built-in skills for AI-assisted operations:

| Skill | Description |
|-------|-------------|
| `review-pass` | Multi-agent cross-validation review (4 stages) |
| `verify-implementation` | Run all verification skills, generate unified report |
| `manage-skills` | Auto-detect and update verification skills |
| `merge-worktree` | Squash-merge worktree branches with semantic commits |
| `read-doc` | Extract text from HWP/PDF/DOCX/XLSX/PPTX |
| `webapp-testing` | Playwright E2E testing for local web apps |
| `doc-coauthoring` | Structured document co-authoring (3-step) |

### Business Extension Skills

Additional skills available in [Naia Business ADK](#business-extension):

| Skill | Description |
|-------|-------------|
| `payroll` | Payroll statement PDF generation + email dispatch |
| `press-release` | Press release writing, journalist outreach, distribution |
| `patent-draft` | KIPO-format patent specification drafting |
| `patent-pipeline` | AI-powered patent discovery, evaluation, and filing |
| `copyright-reg` | Copyright registration document generation |
| `weekly-report` | Weekly work report generation from git commits |
| `email` | Email composition and dispatch |
| `sms` | SMS notification sending |
| `channel-management` | Multi-channel communication management |
| `service-management` | Service monitoring and management |
| `web-monitoring` | Web content monitoring and alerting |
| `document-generation` | Automated document generation |

## Architecture

Naia ADK follows a **Base + Extension** model:

```
┌─────────────────────────────────────────┐
│  naia-adk (Base)                        │
│  ┌─────────────────────────────────────┐│
│  │  .agents/  .users/  .claude/        ││
│  │  skills/   scripts/  templates/     ││
│  │  docs/     packages/               ││
│  └─────────────────────────────────────┘│
│  + data-company/  (fork: business)      │
│  + data-business/ (fork: business)      │
│  + data-private/  (fork: personal)      │
│  + projects/      (fork: personal)      │
└─────────────────────────────────────────┘
         │ MCP / WebSocket
         ▼
┌─────────────────────────────────────────┐
│  Naia OS (Desktop App)                  │
│  Tauri 2 + React + Node.js Agent        │
└─────────────────────────────────────────┘
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for full details.

## Quick Start

### For Individuals

1. **Private fork** — Fork `naia-adk` to your account (uncheck "Public fork" if available, or fork then change to private in Settings)
2. **Clone** — `git clone https://github.com/YOUR-USER/your-adk.git && cd your-adk`
3. **Add upstream** — `git remote add upstream https://github.com/nextain/naia-adk.git`
4. **Create data dirs** — `mkdir -p data-private projects`
5. **Start working** — Add projects, configure `.agents/`, use skills
6. **Sync upstream** — Periodically: `git fetch upstream && git merge upstream/main`

### For Organizations

1. **Get Business Pack** — [Contact us](https://nextain.io/contact) for `naia-business-adk` access
2. **Private fork** — Fork `naia-business-adk` to your org as private
3. **Clone** — `git clone https://github.com/YOUR-ORG/your-org-adk.git && cd your-org-adk`
4. **Add upstream** — `git remote add upstream https://github.com/nextain/naia-business-adk.git`
5. **Add company data** — `mkdir -p data-company data-business projects`
6. **Add submodules** — `git submodule add <repo> projects/<name>`
7. **Team onboarding** — Each member forks the org ADK for their personal workspace
8. **Sync upstream** — Periodically: `git fetch upstream && git merge upstream/main`

### Connect to Naia OS (optional)

If you use [Naia OS](https://github.com/nextain/naia-os), point its workspace path to your ADK directory. Skills and data are served via MCP/WebSocket.

## Security Tiers

| Tier | Level | Example |
|------|-------|---------|
| T1 | Public | Open-source code, public docs |
| T2 | Company | Internal docs, shared resources |
| T3 | Confidential | Accounting, contracts, personal data |
| T4 | Secret | API keys, credentials (`.env`, never committed) |

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
