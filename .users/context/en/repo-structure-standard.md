# Repo Structure Standard

> **Language**: English (this file) · [한국어](../repo-structure-standard.md)
> **AI SoT**: `.agents/context/repo-structure-standard.yaml`
> **Version**: 1.0 (2026-05-27)
> **Lineages**: direct personal fork from naia-adk, or the optional organization lineage (naia-business-adk → {org}-adk → {user}-adk)

---

## Language Defaults / Overrides

Default: Public OSS repositories use English as the primary documentation language. A maintainer or
user fork may choose its maintainer's language for human-facing guides.

**Public `naia-adk` baseline (2026-06-22)**:

- `README.md` is Korean and `README.en.md` is English.
- `AGENTS.md` is the English canonical index; `CLAUDE.md` and `GEMINI.md` are one-line `@AGENTS.md` imports.
- `.users/context/` contains Korean human guides; `.users/context/en/` contains English human guides.

`naia-memory` follows its own repository rules and is outside this standard's override.

---

## Overview

The standard for **document structure · SDLC deliverables · RBAC** across all repositories in the naia-adk ecosystem.
This file is the English mirror of the `.agents/context/repo-structure-standard.yaml` SoT.

Fork customization: Create `FORK.md` at the fork root → override through the `overrides:` section.

---

## 1. Repository Types

| Type | Representative repositories | Description |
|------|-----------------------------|-------------|
| `workspace_adk` | naia-adk, naia-business-adk, {org}-adk, {user}-adk | Top-level workspace where developers work |
| `runtime_library` | naia-agent, naia-memory | Runtime/library packages used by hosts |
| `app_os` | naia-os | User-facing full app/OS with community contributors |

### Required directories for workspace_adk

```
.agents/context/       ← AI SoT (agents-rules.json + project-index.yaml required)
.users/context/        ← Korean human guide
.users/context/en/     ← English human guide
```

### Required directories for runtime_library

```
.agents/context/       ← AI SoT
docs/                  ← English SoT (primary human documentation)
.users/docs/ko/        ← Korean mirror
```

### Required directories for app_os

```
.agents/context/
.users/context/        ← English mirror (primary)
.users/context/ko/     ← Korean mirror
```

---

## 2. Mirror Patterns

| Pattern | Applies to | Layers |
|---------|------------|--------|
| **dual** | workspace_adk (private fork) | `.agents/context/` (AI) ↔ `.users/context/` (human) |
| **triple** | app_os | `.agents/` ↔ `.users/context/` (English) ↔ `.users/context/ko/` (Korean) |
| **public_workspace_adk** | public workspace_adk baseline (naia-adk) | `.agents/context/` (English machine source) ↔ `.users/context/` (Korean) ↔ `.users/context/en/` (English) |
| **split** | runtime_library (naia-agent pattern) | `.agents/` ↔ `docs/` (English SoT) ↔ `.users/docs/ko/` (Korean) |

**Rule (split pattern)**: Always modify the English source (`docs/`) first, then synchronize the Korean mirror.

---

## 3. Multi-tool Harness

`AGENTS.md` (canonical) = `CLAUDE.md` = `GEMINI.md`

- Edit only `AGENTS.md`. The rest are synchronized by `scripts/sync-harness-mirrors.sh` or the pre-commit hook.
- Check with `node .claude/hooks/sync-entry-points.js --check`.
- Synchronize supported mirrors with `node .claude/hooks/sync-entry-points.js`.

---

## 4. SDLC Deliverable Lifecycle

### `.agents/progress/` — Work Progress Records

| Status | Location | Condition |
|--------|----------|-----------|
| In progress | `.agents/progress/` | Work is in progress |
| Complete | `.agents/progress/archive/YYYY-MM/` | At least two objective signals (PR merge + issue close + deploy, etc.) |

- gitignored (session-local, not committed)
- File format: `{issue-slug}-{YYYY-MM-DD}.md` + `.json` pair
- **AI self-declaration of completion prohibited** — objective external signals are required
- No updates for 30 days: user decision

### `work-logs/{username}/` — Developer Personal Records

- gitignored, language unrestricted

### `.agents/work/` — Temporary Work Files

- gitignored; after 30 days, user decides whether to keep, archive, or delete

---

## 5. RBAC Tiers

### naia-adk default (T0–T3)

| Tier | Name | Example directories |
|------|------|---------------------|
| T0 | public | `skills/`, `scripts/`, `docs/`, `.agents/context/` |
| T1 | org-general | `data-company/`, `projects/` |
| T2 | org-sensitive | `data-teams/` |
| T3 | private | `data-private/` |

T1–T3 are gitignored (fork-specific data, not committed upstream).

### naia-business-adk extensions

| Addition | Tier | Directory |
|----------|------|-----------|
| Team documents | T2 | `data-teams/` |
| Business skills | T1 | `skills/business/` |

---

## 6. Multi-project Management

When managing multiple subproject repositories under `projects/` in a `{user}-adk` / `{org}-adk` workspace:

- **Required reading before entry**: Before entering `projects/<name>/`, the project's `AGENTS.md` must be read (blocking rule)
- **Switching during a session**: When switching subprojects, rerun the new project's mandatory reads
- **Root CLAUDE.md cannot substitute**: Root context does not replace the subproject context
- `projects/refs/` — read-only upstream references; editing prohibited
- Index: `.agents/context/project-index.yaml` (managed per fork)

---

## 7. Fork Customization

`FORK.md` (created at the fork root):

```markdown
# FORK.md
org_name: ...
default_lang: ko      # Default language for the .users/ mirror
fork_type: user-adk   # org-adk | user-adk

overrides:
  rbac_tiers:
    T2:
      dirs: [data-teams/, data-finance/]  # Additional directories
```

Direct personal forks use the `naia-adk` defaults without an organization layer. The organization layers are added only when that lineage is selected.

**Priority** (higher takes precedence):

```
{user}-adk FORK.md (highest priority)
{org}-adk FORK.md
naia-business-adk additional definitions
naia-adk defaults (this file)
```

---
