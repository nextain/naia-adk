---
id: naia-adk:gstack_comparison
title: "gstack 비교 분석 — 섹션 1-8 + 강점"
tags: [gstack, completeness, code-review, scope, error-handling, shadow-path, verification, strengths]
related: [naia-adk:gstack_hooks, naia-adk:gstack_priority]
updated_at: "2026-03-22"
source: gstack-analysis.md (migrated)
---

# gstack 분석 + 우리 하네스 비교
# 작성: 2026-03-22
# 출처: https://github.com/garrytan/gstack (Garry Tan / YC)

## 분석 방법
- gstack CLAUDE.md, skills/review.md, skills/plan-ceo-review.md, skills/ship.md 전체 읽기
- 우리 agents-rules.json, issue-driven-development.yaml, review-pass/SKILL.md 전체 읽기
- 항목별 1:1 비교

---

## 비교 결과

### 1. Completeness Principle ("Boil the Lake")

**gstack 정의**:
> AI-assisted coding makes marginal cost of completeness near-zero.
> If Option A is complete (all edge cases, 100% coverage) and Option B saves modest effort → always recommend A.

압축비율:
- Boilerplate: 2 days → 15min (~100x)
- Tests: 1 day → 15min (~50x)
- Features: 1 week → 30min (~30x)
- Bug fix + regression: 4 hours → 15min (~20x)

Lake vs Ocean:
- Lake = boilable: 100% coverage for a module, all edge cases
- Ocean = not boilable: entire system rewrites, external deps

**우리 상태**: 없음. `minimal_modification` 원칙은 있지만 upstream 기반 작업 전용 (naia-os Bazzite 포크).

**충돌 여부**: 없음 — 대상이 다름.
- `minimal_modification`: upstream 코드에서 얼마나 벗어나느냐
- `completeness_principle`: 구현 품질 (테스트/에러/엣지케이스)

**적용 방향**: agents-rules.json `ai_workflow`에 `completeness_principle` 섹션 추가. upstream 작업과 구현 품질을 명확히 구분하여 기술.

---

### 2. Two-Pass Code Review (CRITICAL / INFORMATIONAL)

**gstack 구조**:
- Pass 1 CRITICAL: SQL/data safety, race conditions, LLM trust boundaries, enum completeness, silent failures
- Pass 2 INFORMATIONAL: magic numbers, dead code, conditional side effects, test gaps, prompt quality

**우리 상태**: review-pass에 3렌즈 (정확성/완전성/일관성) 있음. 심각도 구분 없음.

겹치는 부분:
- 렌즈1(정확성) = CRITICAL 일부 (잘못된 로직, 잘못된 값)
- 렌즈2(완전성) = INFO 일부 (누락된 항목, 미처리 엣지케이스)

진짜 빠진 것:
- 렌즈에 silent failures, race conditions, LLM trust boundaries, enum completeness 미명시
- CRITICAL 발견 시 "즉시 블로킹"과 INFO "판단 맡김" 구분 없음

**적용 방향**: 렌즈 교체 아님. 각 렌즈 프롬프트에 CRITICAL 항목 명시 추가 + 심각도 표시:
```
[CRITICAL] path:line — 문제 설명
[INFO] path:line — 문제 설명
```

---

### 3. 4-Mode Scope Planning

**gstack 구조**:
- EXPANSION: Greenfield / "go big" → 야심차게
- SELECTIVE EXPANSION: Feature enhancement → 기준선 고수, 가치있는 것만 추가
- HOLD SCOPE: Bug fix / hotfix → 절대 scope 늘리지 마
- SCOPE REDUCTION: Overbuilt → ruthlessly cut

자동 감지 기준:
- `bug`, `hotfix`, `fix` → HOLD SCOPE
- `refactor`, `cleanup` → SCOPE REDUCTION
- `feat`, `feature`, `enhancement` → SELECTIVE EXPANSION
- `new`, `greenfield`, `rfc` → EXPANSION

**우리 상태**: 완전히 없음. scope는 L1/L2/L3 (어디 볼지)만 있고 AI 행동 calibration 없음.

**적용 방향**: issue-driven-development.yaml `plan` 단계에 scope_mode 선택 단계 추가.

---

### 4. Error & Rescue Map

**gstack 구조**: 모든 실패 가능 메서드에 대해:
1. 실패 모드 (네트워크 타임아웃, 잘못된 JSON, 인증 만료)
2. 구체적 예외 클래스 (NetworkTimeoutError, not generic Error)
3. 복구 액션 (재시도/다이얼로그/캐시 반환/degrade gracefully)
4. 사용자 가시성 (YES/NO — NO면 CRITICAL)

**우리 상태**: plan 단계에 "adversarial pre-mortem top-3 failure scenarios" 있음. 구조화 안 됨.
review.checklist에 `type_safety` 항목 있음.

**적용 방향**: plan 단계 loop에 Error & Rescue Map 생성 요구사항 추가. NO visibility → CRITICAL 플래그 규칙.

---

### 5. Shadow Path Tracing

**gstack 구조**: 모든 데이터 흐름 4경로:
1. Happy: 정상 입력 → 정상 처리
2. Nil: 입력 없음 (undefined/null)
3. Empty: 있지만 비어있음 ("", [])
4. Error: 상위 호출 실패

**우리 상태**: 없음. `investigate`에 "READ ALL code" 있고, checklist에 `unused_code` 있지만 4경로 프레임워크 없음.

**적용 방향**: investigate + plan 단계에 shadow path 체크 요구사항 추가.

---

### 6. AskUserQuestion 4-Part Standard

**gstack 구조**:
1. Re-ground (1-2문장): 프로젝트 + 브랜치 + 현재 태스크
2. Simplify (평이한 언어, 기술용어 금지)
3. Recommend (명시적 추천, completeness score, 인간시간/CC시간 둘 다)
4. Options (lettered, 각각 effort + completeness score)

**우리 상태**: gate prompt 몇 줄만 있음. 구조화된 형식 없음.

**적용 방향**: agents-rules.json `ai_workflow`에 `ask_user_question_format` 추가.

---

### 7. ASCII 다이어그램

**gstack**: 6개 필수 (아키텍처, 데이터플로우, 상태머신, 에러플로우, 배포시퀀스, 롤백)

**우리 상태**: 없음.

**적용 방향**: 모든 이슈 필수는 과함. 조건부 필수로:
- **필수 (모든 이슈)**: 아키텍처 다이어그램, 데이터 플로우
- **조건부**: 상태 3개 이상 → 상태머신 / 에러 경로 복잡 → 에러플로우 / 배포/마이그레이션 포함 → 배포시퀀스

---

### 8. Verification 기준 강화

**gstack 원칙**: "Likely/probably" 금지 — 직접 확인하거나 unknown으로 표시. 모든 클레임 파일:라인 인용.

**우리 상태**: lessons-learned에 두 건 있음:
- 2026-03-04: "reviewed at section granularity, not line granularity"
- 2026-03-18: "declared clean pass after checklist-style verification instead of genuinely re-reading"

review-pass SKILL.md에 출력 형식에 파일:줄 인용 요구함. 하지만 "수정 후 해당 섹션만 재검증" 방지 규칙 없음.

**적용 방향**: agents-rules.json에 verification 강도 규칙 추가:
- 클레임은 파일+라인 인용 필수
- 수정 발생 시 해당 섹션 처음부터 재검증 (수정 부분만 보는 것 금지)
- "보인다/같다" 금지 — 확인 또는 unknown

---

## 우리한테 있고 gstack에 없는 것 (강점, 유지)

| 우리 강점 | 설명 |
|-----------|------|
| 1:1 미러 아키텍처 | .agents/ ↔ .users/ 구조, gstack 없음 |
| Cascade rules | 자동 컨텍스트 전파 |
| 13단계 워크플로우 | gstack보다 훨씬 세밀한 단계 |
| Lessons-learned 누적 | 세션 간 학습 이전 |
| Design doc permission model | code vs 설계문서 명확 분리, escalation path |
| Anti-compact strategy | progress 파일 + GitHub 이슈 코멘트 |
| Headless subagent review | 우리도 있음, 잘 구현됨 |
| Contribution fork policy | 외부 기여 상세 규칙 |
