<!-- Thank you for contributing to naia-adk! -->

## Summary

<!-- 1–3 sentences. What and why. -->

## Architecture Fit (상위 구조 적합)

<!--
  Required by architecture-fit-before-fix & review-pass (planning / development).
  Validated with the shared deploy-plan architectureFitProblems rules; blank, template
  placeholders (<...>), or single-server / single-file-only answers block CLEAN review.
-->

- **original_request** (최초 요구 원문): `<누가 무엇을 바랐는지 원문 요지 / 출처, 최소 10자>`
- **parent_structure** (붙는 상위 구조): `<플랫폼 · ADK 업스트림 · 제품 공통 계층/표준, 최소 8자 — 특정 서버·IP·단일 파일만 적지 말 것>`
- **acceptance_rationale** (상위 구조가 받아들이는 방식): `<기존 계층 확장 vs 새 공통 층 추가, 단발 땜빵이 아닌 이유, 최소 10자>`

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
