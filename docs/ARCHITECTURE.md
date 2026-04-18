# Naia Ecosystem Architecture

> naia-adk is the foundation. Everything else is an example of how it's used.

## Overview

```
                    naia-adk (OSS — this repo)
                    ┌─────────────────────────┐
                    │  Runtime Engine Spec     │
                    │  Skill Execution Contract│
                    │  Adapter Interface       │
                    │  .naia/ Directory Spec   │
                    │  Safety / Permission     │
                    └────────────┬────────────┘
                                 │
          ┌──────────────────────┼──────────────────────┐
          │                      │                      │
          ▼                      ▼                      ▼
   naia-adk-b              {company}-adk            naia-os
   (business layer)        (company workspace)      (desktop product)
   ┌──────────────┐        ┌──────────────┐        ┌──────────────┐
   │ naia-adk     │        │ naia-adk-b   │        │ naia-adk     │
   │ + CLI        │        │ + Company    │        │ + naia-shell │
   │ + Base Skills│        │   context    │        │ + Agent      │
   │ + Docgen     │        │ + Company    │        │ + Gateway    │
   │ + PDF/Sign   │        │   skills     │        │              │
   └──────────────┘        │ + Branding   │        │ = Desktop App│
                            └──────────────┘        └──────────────┘
                                   │
                          ┌────────┴────────┐
                          ▼                 ▼
                   nextain-adk         onmam-adk
                   (Nextain CEO)       (Onmam CTO)
                   개발자 워크스페이스    온맘 팀원 워크스페이스
```

## How naia-adk Is Used

### Usage 1: Business Scaffold → naia-adk-b

```
naia-adk (this repo)
  ↓ fork + extend
naia-adk-b
  CLI: naia init / skill add / adapter connect
  Base Skills: review-pass, document-generation, email
  Scripts: generate-pdf.py, sign-pdf.py
  Templates: contract, resolution, payroll
```

**Who**: Companies wanting AI business operations toolkit.

**What naia-adk provides**: Runtime engine loads skills, executes contracts, manages adapters. naia-adk-b adds ready-made business skills on top.

### Usage 2: Company Workspace → nextain-adk

```
naia-adk (this repo)
  ↓ fork → naia-adk-b → fork + init
nextain-adk
  .naia/context.yaml    ← Nextain company info (name, biz_no, branding)
  .naia/skills/payroll/  ← 급여명세서
  .naia/skills/contract/ ← 근로계약서
  .naia/skills/expense/  ← 지출결의서
  data/employees.yaml    ← git-crypt encrypted
  accounting/ hr/ documents/
```

**Who**: A specific company (Nextain) running their AI business.

**What naia-adk provides**: The runtime that loads company context, executes company skills, manages company data securely.

### Usage 3: Desktop Product → naia-os

```
naia-adk (this repo)
  ↓ consumed as runtime dependency
naia-os
  Agent (Node.js): 9 LLM providers, 20+ skills, gateway adapter
  Shell (Tauri 2 + React + Three.js): Desktop UI with VRM avatar
  Gateway (OpenClaw): System access daemon
  = Full desktop app for end users
```

**Who**: End users running Naia on their desktop.

**What naia-adk provides**: SkillRegistry, LlmProviderRegistry, SafetyPredicate, adapter interface — proven patterns extracted from naia-os's 20k+ LOC agent.

## Layer Rules

| Rule | Description |
|------|-------------|
| Each layer only **adds**, never replaces | naia-adk-b extends naia-adk, doesn't modify it |
| naia-adk is **agnostic** | No company data, no business logic, no UI |
| naia-adk-b is **generic business** | No company-specific data or branding |
| {company}-adk is **specific** | One company's context, skills, and data |
| naia-os is a **product** | Bundles runtime + UI + system access |

## Dependency Flow

```
naia-adk ──────────────────────────────────────────┐
   │ npm workspace                                  │ npm package
   ▼                                                ▼
naia-adk-b ──┐                              ┌── naia-os
   │          │                              │      │
   │ fork     │                              │      │ naia-shell
   │ + init   │                              │      │ (Tauri + React)
   ▼          │                              │      │
nextain-adk   │                              │      │
              │                              │      │
              └── skills loaded by ──────────┘──────┘
                  naia-adk runtime (skill loader)
```

## Quick Reference

| Project | = naia-adk + | Repo | Public |
|---------|-------------|------|:------:|
| naia-adk | — (base) | `nextain/naia-adk` | Yes |
| naia-adk-b | CLI + base skills + docgen | `nextain/naia-adk-b` | No |
| nextain-adk | naia-adk-b + Nextain context | TBD | No |
| naia-shell | Tauri 2 + React + VRM UI | `nextain/naia-os` (/shell) | Yes |
| naia-os | shell + agent + gateway | `nextain/naia-os` | Yes |
