# Naia Ecosystem Architecture

> naia-adk is the personal base. Higher layers extend it for organizational governance and concrete company/member instances.

## Overview

```
            naia-adk (OSS — this repo, public)
            ┌─────────────────────────────┐
            │  Personal Base              │
            │  - workspace scaffold       │
            │  - tool-agnostic format     │
            │  - base skills              │
            │  - solo governance baseline │
            └────────────┬────────────────┘
                         │ business upstream
                         ▼
              naia-business-adk (private)
              ┌─────────────────────────────┐
              │  Organizational Extension   │
              │  - assets / process /       │
              │    permissions governance   │
              │  - team ownership           │
              │  - delegated approval       │
              │  - business workflows       │
              └────────────┬────────────────┘
                           │ instantiate
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        nextain-adk   onmam-adk    {company}-adk
        (company)     (company)    (company)
        .agents/      .agents/      .agents/
        data-company/ data-company/ data-company/
        data-business/ data-business/ data-business/
        data-private/  data-private/  data-private/
```

## Disclosure Levels

| Level | Meaning | Strategy | Examples |
|------|---------|----------|---------|
| `public` | Safe for public repos and websites | open repo / public docs | skills, packages, templates, docs |
| `controlled` | Shareable externally with review | approved external sharing only | vetted partner material, approved brand assets |
| `internal` | Workspace or company internal | private repo / limited audience | `.agents/`, `data-company/`, internal documents |
| `confidential` | Sensitive operational or customer-bound material | private repo or outside git, need-to-know handling | `data-business/`, `data-private/`, `.env`, certificates, API keys |

Levels also imply different expectations for AI behavior:

- `public`: may be summarized and published
- `controlled`: may be shared externally only with intent and review
- `internal`: may be read and worked on, but not publicly published by default
- `confidential`: stronger need-to-know handling, caution for memory promotion, never treated as normal publishable context

## Model: Personal Base + Organizational Extension + Instances

| Layer | What | For Who |
|-------|------|---------|
| **naia-adk** | Personal base: scaffold + format + minimum solo governance | Individuals using AI-assisted workspaces |
| **naia-business-adk** | Organizational extension: assets / process / permissions governance | Teams and companies |
| **{company}-adk** | Company instance with real products, teams, and policy | Specific organization's AI operations |
| **{member}-adk** | Company-linked personal instance | Members working within company context |

## Solo Governance Baseline

The base layer should define a minimum collaboration model even for one person:

- `read`, `write`, `execute`, and `publish` are not the same action
- public, internal, confidential, and secret are not just storage tiers but disclosure semantics
- production mutation, secret handling, and public claims require stronger gates than local edits
- session-local context should not be promoted into persistent/shared context without intent

This belongs in `naia-adk` because solo AI collaboration can fail before any company layer exists.

## naia-adk Base Skills (9 — Individual)

| Skill | Description |
|-------|-------------|
| `review-pass` | 4-stage multi-AI cross-validation review |
| `email` | SMTP email with templates |
| `sms` | SMS/알림톡 |
| `read-doc` | HWP/PDF/DOCX/XLSX text extraction |
| `doc-coauthoring` | Structured document co-authoring |
| `document-generation` | PDF generation (contract/resolution/payroll) |
| `channel-management` | Discord/Slack channel management |
| `web-monitoring` | SEO, uptime, analytics |
| `service-management` | Service monitoring, incident response |

## naia-business-adk Skills (11 — Business)

| Skill | Description |
|-------|-------------|
| `payroll` | 급여명세서 PDF + 이메일 발송 |
| `contract` | 근로계약서 (근로기준법) + 디지털 서명 |
| `expense` | 지출결의서 + 영수증 OCR |
| `accounting` | 장부 기록, 월마감, 세무 |
| `crm` | 파일 기반 경량 CRM |
| `client-communication` | 고객 소통 관리 |
| `copyright-reg` | 어문저작권 등록 서류 |
| `patent-draft` | 특허 명세서 초안 |
| `patent-pipeline` | 특허 발굴·평가·출원 |
| `press-release` | 보도자료 작성·발송 |
| `weekly-report` | 주간 업무 결과 |

## Organizational Governance Extension

`naia-business-adk` should not be described as a premium skill bundle only.

It is the organizational extension that adds:

- team ownership
- delegated approval
- need-to-know handling for customer/legal/finance data
- audit-ready workflow expectations
- business workflow classes and policy

Skills are one output of that extension, not the whole product.

## {company}-adk (Company Workspace)

At the organizational layer, `naia-business-adk` scaffolding creates:

```
{name}-adk/
├── .agents/                   ← AAIF standard
│   ├── context/               ← Company info, rules, config
│   ├── skills/                ← Company-specific skills (if needed)
│   ├── workflows/             ← Workflow definitions
│   ├── commands/              ← Slash commands
│   └── hooks/                 ← Lifecycle hooks
├── .users/                    ← Human-readable mirror (Korean)
├── .claude/                   ← Claude Code settings
├── data-company/              ← T2: Company general data
│   ├── docs-{company}/        ← Company docs (submodule)
│   ├── docs-work-logs/        ← Work logs (submodule)
│   └── caretive/              ← Reference data
├── data-business/             ← T3: Company sensitive data
│   ├── docs-business/         ← Business docs (submodule)
│   ├── accounting/            ← Accounting (submodule)
│   └── documents/             ← Generated documents (submodule)
├── data-private/              ← T3: Personal data
│   ├── envs/                  ← .env, key files
│   ├── personal/              ← Personal documents
│   └── memo/                  ← Personal memos
├── projects/                  ← Project repos (submodules)
│   └── refs/                  ← Reference repos (read-only)
├── skills/                    ← base + organization/company-specific extensions
├── packages/                  ← Runtime packages
├── scripts/                   ← PDF/sign engine, tools
├── templates/                 ← Document templates
├── docs/                      ← Architecture, specs
├── AGENTS.md
└── .gitignore
```

## naia-os Integration

The active ADK instance serves as the **skill backend** for the naia-os desktop app:

```
naia-os (Desktop App, Tauri 2)
  └─ agent ──WebSocket/MCP──> {active-adk} Runtime
                                  ├─ Base skill execution
                                  ├─ Document generation (when provided by the active instance)
                                  ├─ Approval / org workflows (only in business/company layers)
                                  └─ MCP Server → expose skills to naia-os
```

Integration paths (phased):
1. **MCP**: naia-adk runs MCP Server → naia-os connects as MCP Client
2. **Gateway**: naia-adk implements `GatewayAdapter` → naia-os agent calls directly
3. **Shared SDK**: Extract `@naia/skill-sdk` from common interfaces

## Real Examples

### nextain-adk (= company instance)

```
nextain-adk/                     ← company workspace root
├── .agents/                      ← AAIF (context, skills, workflows)
├── .users/                       ← Korean mirror
├── .claude/                      ← Claude Code settings
├── data-company/
│   ├── docs-nextain/             ← submodule: nextain/docs-nextain
│   ├── docs-work-logs/           ← submodule: nextain/docs-work-logs
│   └── caretive/                 ← Reference data
├── data-business/
│   ├── docs-business/            ← submodule: nextain/docs-business
│   ├── accounting/               ← submodule: nextain/nextain-accounting
│   └── documents/                ← submodule: nextain/nextain-documents
├── data-private/                 ← submodule: nextain/luke-private
├── projects/
│   ├── naia-os/                  ← submodule: nextain/naia-os
│   ├── about.nextain.io/         ← submodule
│   ├── naia.nextain.io/          ← submodule
│   ├── 9router/                  ← submodule
│   └── refs/                     ← read-only upstream tracking
├── skills/                       ← base + business skills
├── packages/                     ← runtime engine (future)
├── scripts/                      ← triage, PDF, tools
├── templates/                    ← document templates
└── docs/                         ← architecture, specs
```

### alpha-adk (= company-linked personal instance)

`alpha-adk` is not a generic personal fork. It is a member instance that inherits company context while preserving local working memory and experiments.

### onmam-adk (= company instance)

```
onmam-adk/
├── .agents/
│   └── context/                  ← Onmam company info
├── data-company/
│   └── docs-onmam/               ← Onmam docs
├── data-business/
│   └── documents/                ← Onmam documents
└── projects/
    └── home.onmam.com/           ← Onmam project
```
