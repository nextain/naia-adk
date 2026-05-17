---
id: naia-adk:gstack_priority
title: "gstack 분석 기반 우선순위 (P0-P3)"
tags: [gstack, priority, review-pass, agents-rules, idd, verify-implementation]
related: [naia-adk:gstack_comparison, naia-adk:gstack_hooks]
updated_at: "2026-03-22"
source: gstack-analysis.md (migrated)
---

## 수정된 우선순위

### P0 (즉시, 블로킹 품질 이슈)
1. **verify-* 스킬 최소 1개 생성** — verify-implementation이 현재 no-op. `/manage-skills` 실행해서 기본 verify 스킬 생성 필요
2. **review-pass 렌즈1에 silent failures 추가** — `catch (e) {}`, 로깅 없는 catch, void return on error 탐지

### P1 (agents-rules.json + IDD 수정)
3. **Completeness Principle** — upstream/구현품질/자율성 3가지 원칙 명확 구분하여 추가
4. **AskUserQuestion 표준** — completeness score + CC/인간 시간 추가
5. **4-Mode Scope** — IDD plan 단계에 scope_mode 선택 추가

### P2 (review-pass + IDD 수정)
6. **review-pass CRITICAL 항목** — race conditions, LLM trust boundaries, enum completeness 렌즈에 명시
7. **Error & Rescue Map** — IDD plan 단계에 구조화된 양식 추가
8. **Shadow Path Tracing** — IDD investigate + plan에 4경로 요구사항 추가
9. **ASCII 다이어그램 (조건부 필수)** — 필수 2개 + 조건부 3개

### P3 (신규 스킬)
10. **verify-plan 스킬** — Phase 5 전용 검증
