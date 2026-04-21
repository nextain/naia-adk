<!-- Thank you for contributing to naia-adk! -->

## Summary

<!-- 1–3 sentences. What and why. -->

## Format / skill impact

naia-adk is a **tool-agnostic workspace format**. Format changes are visible
to every AI coding tool that consumes the workspace (Claude Code, OpenCode,
Codex, naia-agent, …). Handle accordingly.

- [ ] Changes `@naia-adk/skill-spec` shape (published contract — **MAJOR** if breaking)
- [ ] Changes SKILL.md format / workspace directory layout
- [ ] Changes `agents-rules.json` schema
- [ ] Internal / docs / tooling only — no external consumer impact

For contract-visible changes: did you verify that at least one non-naia-agent
tool (Claude Code or OpenCode) still reads the workspace?

## Test

- [ ] `pnpm build` green

## Issue

<!-- Closes #NNN -->
