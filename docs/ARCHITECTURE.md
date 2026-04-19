# Naia Ecosystem Architecture

> naia-adk is the foundation. Everything else is an example of how it's used.

## Overview

```
            naia-adk (OSS — this repo, public)
            ┌─────────────────────────────┐
            │  Base Skills (9)            │
            │  review-pass, email         │
            │  sms, read-doc              │
            │  doc-coauthoring            │
            │  document-generation        │
            │  channel-management         │
            │  web-monitoring             │
            │  service-management         │
            │                             │
            │  + Runtime Engine (TS)      │
            │  + Skill Spec & SDK         │
            │  + Templates & Docs         │
            └────────────┬────────────────┘
                         │ naia install business
                         ▼
              naia-adk-business-pack (private)
              ┌─────────────────────────────┐
              │  + Business Skills (11)     │
              │  payroll, contract          │
              │  expense, accounting        │
              │  CRM, patent, PR            │
              │  + CLI, Docgen, PDF         │
              └────────────┬────────────────┘
                           │ install into workspace
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        nextain-adk   onmam-adk    {company}-adk
        (CEO Luke)    (Onmam CTO)  (any company)
        .agents/      .agents/      .agents/
        data-company/ data-company/ data-company/
        data-business/ data-business/ data-business/
        data-private/  data-private/  data-private/
```

## Security Tiers

| Tier | Name | Strategy | Examples |
|------|------|----------|---------|
| T1 | Public | naia-adk public repo | skills, packages, templates, docs |
| T2 | Internal | private subrepo | `.agents/`, `data-company/`, `documents/` |
| T3 | Confidential | private subrepo (git-crypt optional) | `data-business/`, `data-private/` |
| T4 | Secret | `.gitignore` (outside git) | `.env`, certificates, API keys |

## Model: Base + Extension Pack + Config

| Layer | What | For Who |
|-------|------|---------|
| **naia-adk** | Base runtime + individual skills (9) | All individuals — developers, creators, freelancers |
| **naia-adk-business-pack** | + Business skills (11) + CLI + Docgen | Super-individuals running a company / small teams |
| **{company}-adk** | Workspace with company data | Specific company's AI operations environment |

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

## naia-adk-business-pack Skills (11 — Business)

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

## {company}-adk (Company Workspace)

`naia init {name}` creates:

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
├── skills/                    ← naia-adk + business pack skills
├── packages/                  ← Runtime packages
├── scripts/                   ← PDF/sign engine, tools
├── templates/                 ← Document templates
├── docs/                      ← Architecture, specs
├── AGENTS.md
└── .gitignore
```

## naia-os Integration

naia-adk serves as the **skill backend** for the naia-os desktop app:

```
naia-os (Desktop App, Tauri 2)
  └─ agent ──WebSocket/MCP──> naia-adk Runtime
                                  ├─ Business skill execution
                                  ├─ Document generation (PDF)
                                  ├─ Approval workflows
                                  └─ MCP Server → expose skills to naia-os
```

Integration paths (phased):
1. **MCP**: naia-adk runs MCP Server → naia-os connects as MCP Client
2. **Gateway**: naia-adk implements `GatewayAdapter` → naia-os agent calls directly
3. **Shared SDK**: Extract `@naia/skill-sdk` from common interfaces

## Real Examples

### nextain-adk (= Luke's workspace)

```
D:\naia-adk                       ← this repo = nextain workspace
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

### onmam-adk (= Onmam team workspace)

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
