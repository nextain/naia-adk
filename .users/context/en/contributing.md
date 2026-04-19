<!-- Copyright 2026 Nextain Inc. All rights reserved. -->

# Naia OS Contributing Guide

Human-readable guide for `.agents/context/contributing.yaml`.

## Purpose

How AI agents (and humans using AI tools) should contribute to the Naia OS project.

---

## Getting Started: Context Reading Order

New contributors (including AI agents) must read these files in order:

1. `.agents/context/agents-rules.json` — Project rules (SoT)
2. `.agents/context/ai-work-index.yaml` — Work type index
3. `.agents/context/project-index.yaml` — Submodule entry points
4. `.agents/context/philosophy.yaml` — Core philosophy

**Submodule rule**: When working in a submodule, read its `rulesEntrypoint` first.

---

## Code Contribution Rules

### Development Process

```
PLAN → CHECK → BUILD (TDD) → VERIFY → CLEAN → COMMIT
```

Details: `.agents/workflows/development-cycle.yaml`

### Key Rules

| Rule | Description |
|------|-------------|
| TDD | Write test first (RED) → minimal code (GREEN) → refactor |
| VERIFY | Actually run the app — type-check alone is insufficient |
| Logger | No `console.log/warn/error` — use structured Logger only |
| Biome | Follow Biome for linting and formatting |
| Minimal change | Only modify what's needed — no over-engineering |

---

## Context Contribution Rules

### License

AI context files are licensed under **CC-BY-SA 4.0**.

### SPDX Headers Required

| File Type | Header Format |
|-----------|---------------|
| YAML (.yaml) | `# SPDX-License-Identifier: CC-BY-SA-4.0` |
| JSON (.json) | `"_license": "CC-BY-SA-4.0 \| Copyright 2026 Nextain"` |
| Markdown (.md) | `<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->` |

### Mirroring Principle

- **SoT** (Source of Truth) lives in `.agents/`
- `.users/` is the human-readable mirror
- Korean mirror: `.users/context/{file}.md`
- English mirror: `.users/context/en/{file}.md`
- When modifying, **always** update mirrors too

### Cascade Rules

Propagation order when modifying context: self → parent → siblings → children → mirror

---

## Philosophy Compliance

Principles that must be preserved in contributions:

- **AI Sovereignty** — no vendor lock-in
- **Privacy First** — local execution by default
- **Transparency** — open source, no hidden behavior

Extensions are welcome:
- Add new principles that don't conflict with existing ones
- Add new skills, workflows, and integrations

---

## Skill Contribution

- **Format**: Claude Code skill format (`SKILL.md` with YAML frontmatter)
- **Location**: `.agents/skills/{skill-name}/SKILL.md`
- **Mirror**: `.users/skills/{skill-name}/SKILL.md` (symlink or copy)
- **Naming**: kebab-case, no prefix (e.g. `review-pass`, `merge-worktree`)
- **Registration**: After adding a skill, run `/manage-skills` to register it in CLAUDE.md
- **Testing**: Invoke the skill via `/skill-name` in a real session to verify

---

## PR Guidelines

### Title Format

```
type(scope): description
```

**Types**: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`

### Checklist

- [ ] Tests pass (`npm test` / `pytest`)
- [ ] VERIFY step completed (app actually runs)
- [ ] Context files updated if architecture changed
- [ ] No `console.log/warn/error` left in code
- [ ] Work log entry if significant change

---

## Language Rules

| Target | Language |
|--------|----------|
| Code and context | English |
| AI responses and logs | Korean |
| Commit messages | English |

---

## Related Files

- **SoT**: `.agents/context/contributing.yaml`
- **Korean mirror**: `.users/context/contributing.md`
