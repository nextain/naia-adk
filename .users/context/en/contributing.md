<!-- Copyright 2026 Nextain Inc. All rights reserved. -->

# Naia ADK Contribution Guide

A human-readable guide to `.agents/context/contributing.yaml`.

## Purpose

Explains how AI agents (and people using AI tools) should contribute correctly to the Naia OS project.

---

## Getting Started: Context Reading Order

New contributors (including AI agents) must read the following files in order:

1. `.agents/context/agents-rules.json` — Core project rules (SoT)
2. `.agents/context/ai-work-index.yaml` — Workflow index by task type
3. `.agents/context/project-index.yaml` — Entry point index by submodule
4. `.agents/context/philosophy.yaml` — Core philosophy

**Submodule rule**: When working in a submodule, read that submodule's `rulesEntrypoint` first.

---

## Code Contribution Rules

### Development Process

```
PLAN → CHECK → BUILD (TDD) → VERIFY → CLEAN → COMMIT
```

Details: `.agents/workflows/development-cycle.yaml`

### Core Rules

| Rule | Description |
|-----|------|
| TDD | Tests first (RED) → minimal implementation (GREEN) → refactor |
| VERIFY | Run the actual app to verify — type-checking alone is insufficient |
| Logger | `console.log/warn/error` prohibited — use only the structured Logger |
| Biome | Follow Biome for linting and formatting |
| Minimal changes | Modify only what is necessary — no excessive refactoring |

---

## Context Contribution Rules

### License

AI context files are licensed under **CC-BY-SA 4.0**.

### SPDX Header Required

| File type | Header format |
|----------|----------|
| YAML (.yaml) | `# SPDX-License-Identifier: CC-BY-SA-4.0` |
| JSON (.json) | `"_license": "CC-BY-SA-4.0 \| Copyright 2026 Nextain"` |
| Markdown (.md) | `<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->` |

### Mirroring Principles

- **SoT** (Source of Truth) is in `.agents/`
- `.users/` is a human-readable mirror
- Korean mirror: `.users/context/{파일}.md`
- English mirror: `.users/context/en/{파일}.md`
- When changes are made, the mirror must also be updated

### Propagation Rules

When context changes, propagate in this order: self → parent → siblings → children → mirror

---

## Compliance with the Philosophy

The following principles must be preserved when contributing:

- **AI sovereignty** — No vendor lock-in
- **Privacy-first** — Local execution by default
- **Transparency** — Open source, with no hidden behavior

Extensions are allowed:

- Adding new principles that do not conflict with existing principles
- Adding new skills, workflows, and integrations

---

## Skill Contributions

- **Format**: Claude Code skill format (`SKILL.md` with YAML frontmatter)
- **Location**: `.agents/skills/{스킬명}/SKILL.md`
- **Mirror**: `.users/skills/{스킬명}/SKILL.md` (symlink or copy)
- **Naming**: kebab-case, without a prefix (for example, `review-pass`, `merge-worktree`)
- **Registration**: Run `/manage-skills` after adding a skill to register it in `CLAUDE.md`
- **Testing**: Invoke it directly with `/스킬명` in an actual session to verify it

---

## PR Guidelines

### Title Format

```
type(scope): description
```

**Types**: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`

### Checklist

- [ ] Tests pass (`npm test` / `pytest`)
- [ ] VERIFY stage completed (the app actually ran)
- [ ] Context files updated when the architecture changes
- [ ] No remaining `console.log/warn/error`
- [ ] Work log recorded for significant changes

---

## Language Rules

| Target | Language |
|-----|------|
| Code and context | English |
| AI responses and logs | Korean |
| Commit messages | English |

---

## Related Files

- **SoT**: `.agents/context/contributing.yaml`
- **English mirror**: `.users/context/en/contributing.md`
