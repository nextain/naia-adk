<!-- Copyright 2026 Nextain Inc. All rights reserved. -->

# Harness 검증 체크리스트

`.agents/context/harness.yaml`에 대한 사람이 읽을 수 있는 가이드입니다.

## 목적

훅(hooks), 규칙(rules), 워크플로우를 추가/수정할 때 하네스의 올바름을 검증하기 위한 체크리스트입니다.

---

## 아키텍처 (G-OC01: 도구 비종속 하네스, 2026-05-18)

도구별 모놀리식 훅 → **도구 비종속 코어 + 정책 + 호스트 어댑터** 구조로 리팩터하고, 두 번째 호스트(pi)에서 실증.

- **core** `.agents/hooks/core/harness-core.js` — 호스트 중립 SoT(세션/anti-compact + 새니타이저). 호스트 결합 0.
- **policies** `.agents/hooks/policies/{bash,edit}.js` — 호스트 중립 가드 정책. `process.exit`·호스트 I/O 봉투 없음.
- **host adapters** — Claude(`.claude/hooks/_claude-{bash,edit}-*.js` + 얇은 어댑터, 리팩터 전과 byte-동일) / **pi**(`.pi/extensions/naia-harness.ts` — 동일 정책·코어 재사용, core 무변경).
- **fail-mode 불변식**: 가드별 **하드코딩**(데이터 아님) — pr-guard fail-CLOSED, 나머지 5 bash 가드 fail-OPEN. 양 호스트 보존(적대 검증 완료).

**상태**: part1+part2 **완료 & 적대 2-consecutive-clean(6라운드)** — 실 pi@0.74.1 런타임 게이트 20/20, Claude parity(golden 8/42/19 + E2E 64 + system 13) byte-동일. **cross-tool 목표(Claude+pi 동일 하네스, core 무변경) 달성·검증.** partB(선언적 guard_policies) = 3라운드 설계리뷰 → **DEFER 권고**(SoT-정책화에 건전한 무결성 루트 없음; 2/9 가드만 적합; cross-tool 목표 이미 달성). 상세 = `.agents/progress/g-oc01-partB-forbidden-actions-plan.md`.

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
| `session-inject.js` | UserPromptSubmit | PASS | PASS | PASS | PASS | 2026-04-26 |

**참고:**
- `pr-guard.js` H1: regex `(?:^|[;&|])\s*gh\s+pr\s+create\b` (2026-03-22). 체인 명령 catch + echo/body 인자 안의 텍스트 false positive 방지. T6-T10 5/5 PASS.
- `commit-guard.js`: PostToolUse → PreToolUse 전환 (2026-03-22). regex `(?:^|[;&|])\s*git\s+commit\b`. echo 인자 안 텍스트 false positive 방지. T1-T5 5/5 PASS.
- `cascade-check.js` H2 INFO: PostToolUse 알림이 차단이 아님 — 미러 업데이트는 AI 책임, 자동화 아님. 허용된 설계.
- `session-inject.js` H4: design-doc-unlock 파일 활성화 시 경고 출력 기능 추가 (2026-03-22).
- `session-inject.js` 동작 모델 재설계 (2026-04-26): 자동 바인딩 제거, opt-out 메커니즘 추가, `/harness` 슬래시 명령어 도입. 아래 섹션 참조.

---

## session_inject 동작 모델 (2026-04-26 개정)

**해결 우선순위 (auto-bind 없음):**
1. **P0** — progress 파일 안의 `session_id` 필드가 현재 세션 ID와 일치하는 파일 (가장 권위적, session-map 손상에도 견고)
2. **P1** — `.session-map.json[session_id]`가 가리키는 파일
3. **둘 다 없으면 SELECTION PROMPT만 inject** — 절대 추측해서 자동 바인딩하지 않음

**활성 후보 정의:** `mtime ≤ 24h` AND `current_phase != "close"` — 안내문에 후보 목록으로 표시됨.

**Opt-out (HARNESS 끔):**
- `CLAUDE_HARNESS=off` (또는 `0`/`false`/`no`) 환경변수
- `<cwd>/.claude/no-harness` 마커 파일 (내용 무관, 존재만으로 opt-out)
- 위 둘 중 하나면 hook은 매 턴 조용히 종료

**명시적 제어 — `/harness` 슬래시 명령어:**

| 명령 | 동작 |
|------|------|
| `/harness status` | 현재 바인딩 상태(P0/P1/UNBOUND) + opt-out 여부 + 활성 후보 표시 |
| `/harness off` | `<cwd>/.claude/no-harness` 생성 → opt-out |
| `/harness on` | `no-harness` 마커 제거 → HARNESS 재활성 |
| `/harness bind <file or issue#>` | 지정 progress 파일에 `session_id` 기재 (P0 anchor) |
| `/harness unbind` | session-map + progress 파일 양쪽에서 현재 세션 흔적 제거 |

명세는 `.claude/commands/harness.md` 참조.

**왜 자동 바인딩(P2-singleton)을 제거했나:** 멀티세션 워크플로우에서 새 세션이 활성 작업 1개에 자동으로 끌려가면서 cross-session context drift가 발생. 새 세션이 자유 작업이거나 다른 이슈를 다루려는 경우에도 #N HARNESS가 강제 inject됐음. 명시적 바인딩만 허용하는 모델로 전환.

**왜 atomic write인가:** 동시 세션이 `.session-map.json`을 동시에 갱신하면 JSON 손상 가능. tmp 파일에 쓴 뒤 rename으로 원자성 확보.

---

## 설계/제안 검토 질문 (design_review_questions, A.8 흡수)

> 출처: harness-books Book1 부록 A.8 (제안 검토 8문). 흡수 검토 = `.agents/progress/harness-books-integration-findings-2026-06-18.md` A절.
> H1~H7은 **우리 훅의 품질**을 점검하고, 아래 질문은 **에이전트·하네스 설계 제안 자체**를 검토한다(대상이 다름). H5(권한 모델 커버리지)는 SA2와 일부 겹친다.
> 사용 시점: 새 하네스·에이전트 설계 PR, IDD Plan 게이트, 외부 하네스 흡수 검토.

| ID | 질문 |
|----|------|
| SA1 | 어떤 행동이 프롬프트로 제약되고, 어떤 행동이 런타임으로 강제되는가? |
| SA2 | 도구 오용을 누가, 어느 레이어에서 막는가? |
| SA3 | 컨텍스트는 언제 compact되며, 이후 작업 의미(계획·스킬·핵심 파일·도구 상태)는 어떻게 복원되는가? |
| SA4 | prompt-too-long과 max-output-tokens는 서로 다르게 복구되는가? |
| SA5 | 인터럽트 후 transcript와 도구 결과의 정합성은 어떻게 유지되는가? |
| SA6 | 멀티에이전트 흐름에서 누가 synthesis를, 누가 verification을 소유하는가? |
| SA7 | 실패 복구에 circuit breaker와 무한루프 방지 가드가 있는가? |
| SA8 | 팀은 에이전트가 무엇을, 왜 했는지 어떻게 감사(audit)하는가? |

**red flag:** 답이 자주 "나중에 추가하면 된다"로 수렴하면, 런타임이 아직 제대로 설계되지 않은 것.

---

## 업데이트 방법

1. `.agents/context/harness.yaml` 수정
2. 이 파일도 동기화 업데이트
