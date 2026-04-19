<!-- Copyright 2026 Nextain Inc. All rights reserved. -->

# Harness 검증 체크리스트

`.agents/context/harness.yaml`에 대한 사람이 읽을 수 있는 가이드입니다.

## 목적

훅(hooks), 규칙(rules), 워크플로우를 추가/수정할 때 하네스의 올바름을 검증하기 위한 체크리스트입니다.

---

## 검증 항목

### H1 — False Positive 테스트
막으면 안 되는 것을 막고 있지는 않은가?
- 테스트 케이스 5개: 통과 3개 + 차단 2개
- `echo '<json>' | node .claude/hooks/<hook>.js`로 직접 검증
- **주의**: 인용 문자열 내 패턴 오탐, 경로 패턴 과도한 매칭

### H2 — 근본 원인 vs 증상 억제
훅이 증상을 억제하고 있는가, 근본 원인을 해결하고 있는가?
- "이 훅이 방지하는 행동은 무엇인가?"
- "다른 경로로 같은 결과가 생길 수 있는가?" → 있으면 증상 억제

| 구분 | 예시 |
|------|------|
| 증상 억제 | `git reset --hard` 차단 (되돌리기 어려운 행동) |
| 근본 원인 | 되돌리기 어려운 행동 전 사용자 확인 체크포인트 추가 |

### H3 — 스코프 확인
훅 시점(PreToolUse vs PostToolUse)이 의도와 맞는가?
- **되돌릴 수 없는 행동을 방지하는 훅**: 반드시 PreToolUse
- PostToolUse는 이미 실행된 후 → 되돌릴 수 없는 행동에는 너무 늦음

### H4 — 프로세스 제약 + 행동 제약 쌍
모든 "X 하면 안 된다" 규칙에 "대신 Y를 해라"가 함께 있는가?
- 없으면 규칙이 불완전

| 구분 | 예시 |
|------|------|
| 불완전 | "설계 결정을 절대 변경하지 말 것" |
| 완전 | "설계 결정을 절대 변경하지 말 것. 설계-구현 괴리 발견 시 → 에스컬레이션 경로 따를 것" |

### H5 — 권한 모델 커버리지
AI의 역할(구현자 vs 리뷰어)이 파일 유형별로 명확히 정의되어 있는가?
- `agents-rules.json` permission_model 확인
- design_doc_paths 최신 상태 확인
- design-doc-guard.js가 `docs/design/` 편집을 차단하는지 테스트

### H6 — 에스컬레이션 경로 정의
"멈추고 보고" 규칙마다 에스컬레이션 경로가 명시되어 있는가?
- 경로: **발견 → 보고 → 대기** (발견 → 조용히 수정 금지)
- 커버 대상: `design_gap_found_during_build`, `design_flaw_found_during_review`

### H7 — 리뷰 품질
반복 리뷰가 `/review-pass` 스킬로 적대적 프레임과 함께 실행되는가?
- IDD workflow review/post_test_review 단계 확인
- `/review-pass` 스킬 파일 존재 확인
- 연속 2회 클린패스 규칙 적용 확인

---

## 기존 훅 소급 검증 결과

| 훅 | 유형 | H1 | H2 | H3 | H4 | 검증일 |
|----|------|----|----|----|----|--------|
| `destructive-git-guard.js` | PreToolUse | PASS | PASS | PASS | PASS | 2026-03-20 |
| `design-doc-guard.js` | PreToolUse | PASS | PASS | PASS | PASS | 2026-03-21 |
| `pr-guard.js` | PreToolUse | PASS | PASS | PASS | PASS | 2026-03-22 |
| `commit-guard.js` | PreToolUse | PASS | PASS | PASS | PASS | 2026-03-22 |
| `cascade-check.js` | PostToolUse | PASS | INFO | PASS | PASS | 2026-03-22 |
| `session-inject.js` | UserPromptSubmit | PASS | PASS | PASS | PASS | 2026-03-22 |

**참고:**
- `pr-guard.js` H1: regex `(?:^|[;&|])\s*gh\s+pr\s+create\b` (2026-03-22). 체인 명령 catch + echo/body 인자 안의 텍스트 false positive 방지. T6-T10 5/5 PASS.
- `commit-guard.js`: PostToolUse → PreToolUse 전환 (2026-03-22). regex `(?:^|[;&|])\s*git\s+commit\b`. echo 인자 안 텍스트 false positive 방지. T1-T5 5/5 PASS.
- `cascade-check.js` H2 INFO: PostToolUse 알림이 차단이 아님 — 미러 업데이트는 AI 책임, 자동화 아님. 허용된 설계.
- `session-inject.js` H4: design-doc-unlock 파일 활성화 시 경고 출력 기능 추가 (2026-03-22).

---

## 업데이트 방법

1. `.agents/context/harness.yaml` 수정
2. 이 파일도 동기화 업데이트
