---
id: naia-adk:gstack_hooks
title: "gstack 훅 시스템 분석 + 심층 발견 (A-E, F1-F10)"
tags: [gstack, hooks, harness, cascade-check, pr-guard, design-doc-guard, findings]
related: [naia-adk:gstack_comparison, naia-adk:gstack_priority]
updated_at: "2026-03-22"
source: gstack-analysis.md (migrated)
---

## 훅 시스템 전체 분석 (3차 읽기, 2026-03-22)

### 7개 훅 목록 및 역할

| 훅 | 트리거 | 방식 | 역할 |
|----|--------|------|------|
| pr-guard.js | PreToolUse(Bash) | **BLOCK** | gh pr create 차단 (Luke = 메인테이너) |
| destructive-git-guard.js | PreToolUse(Bash) | **BLOCK** | git checkout --, reset --hard, clean -f 차단 |
| design-doc-guard.js | PreToolUse(Edit\|Write) | **BLOCK** | 설계문서 편집 차단 (unlock 파일로 bypass 가능) |
| session-inject.js | UserPromptSubmit | inject | 매 메시지 progress 상태 주입 (anti-compact) |
| sync-entry-points.js | PostToolUse(Edit\|Write) | auto-sync | CLAUDE.md = AGENTS.md = GEMINI.md 자동 동기화 |
| cascade-check.js | PostToolUse(Edit\|Write) | remind | .agents/context 편집 시 .users/ 미러 업데이트 알림 |
| commit-guard.js | PostToolUse(Bash) | **WARN** (not block) | sync_verify 전 커밋 경고 |

### 핵심 발견

**commit-guard는 경고만, 차단 아님**
pr-guard, destructive-git-guard는 `decision: "block"`. commit-guard는 `hookSpecificOutput`만 출력 — AI가 무시 가능.

**cascade-check는 알림만, 검증 아님**
agents-rules.json 편집 시 "미러 업데이트하세요" 알림. 실제 동기화 확인 없음. AI 무시 시 drift 발생.

**design-doc-guard의 unlock 메커니즘**
`.claude/design-doc-unlock` 파일 생성 시 bypass. AI가 사용자에게 먼저 보고 → 승인 → unlock 파일 생성 → 편집 → 파일 삭제.

**두 강제 레이어의 비대칭**
- 구조적 레이어 (훅): 강함. gstack에 없는 우리만의 강점.
- 품질 레이어: 거의 없음. gstack의 핵심.

### 추가 갭 발견

**development-cycle.yaml에 리뷰 단계 없음**
비기능 변경(typos, config values)에 리뷰 없음. "config values"나 "simple directives"도 impact 클 수 있음.

**개선 후보 (아직 결정 안 됨)**
- commit-guard WARN → BLOCK 전환 검토
- development-cycle에 single-pass 리뷰 추가 검토
- cascade-check에 mirror diff 확인 추가 검토

---

## 심층 분석 추가 발견 (2차 읽기, 2026-03-22)

### 발견 A: verify-implementation이 빈 껍데기 (CRITICAL)

verify-implementation/SKILL.md + manage-skills/SKILL.md 모두:
```
(아직 등록된 검증 스킬이 없습니다)
```

**의미**: Phase 7(Review)과 Phase 9(Post-test Review)에서 `/verify-implementation` 호출이 현재 아무것도 안 함. 인프라는 완벽하지만 내용이 없음.

gstack: 15개 완성 스킬 즉시 작동.
우리: 인프라만, 실제 검증 내용 0개.

→ `/manage-skills`가 한 번도 실행된 적 없거나, 실행됐어도 verify-* 스킬이 생성 안 됨.

### 발견 B: review-pass에 silent failures 탐지 없음

현재 3렌즈:
- 렌즈1(정확성): 계획 대비 불일치, 잘못된 로직, 잘못된 값
- 렌즈2(완전성): 빠진 항목, 미처리 엣지케이스, 누락된 파일
- 렌즈3(일관성): 다른 파일과 충돌, 사이드이펙트

**없는 것**: `catch (e) {}` 같은 silent failures 탐지 지시.
lessons-learned 2026-03-18 항목에 이미 언급됐으나 렌즈에 반영 안 됨.

### 발견 C: 4-Mode Scope 부재의 실제 영향

IDD scope 단계: L1/L2/L3 = 어디 볼지 (조사 깊이)
gstack SCOPE MODE = AI가 어떻게 행동할지 (행동 calibration)

현재 버그픽스와 신규 기능이 동일하게 처리됨. HOLD SCOPE("확장 금지") 없으니 버그픽스 중 AI가 관련 없는 개선을 제안하거나 계획 scope 밖으로 나가는 상황 발생 가능.

### 발견 D: Completeness vs minimal_modification 정확한 관계

충돌처럼 보이지만 대상이 완전히 다름:
- `minimal_modification` = upstream 코드에서 얼마나 이탈하느냐 (naia-os fork)
- `completeness_principle` = 구현할 때 얼마나 완전하게 (구현 품질)
- `no_autonomous_development` = 뭘 만들지는 사용자 결정

정리:
- 뭘 만들지: `no_autonomous_development` 적용
- upstream 기반으로 만들 때 얼마나 이탈할지: `minimal_modification` 적용
- 만들기로 결정한 것의 품질: `completeness_principle` 적용

추가 시 이 3개 원칙의 적용 대상을 명확히 구분해서 기술 필요.

### 발견 E: AskUserQuestion에 판단 근거 없음

현재 gate prompts:
- "Is my understanding correct?"
- "I propose investigating scope... Does this look right?"
- "Here is my implementation plan. Shall I proceed?"

gstack 표준:
- 각 옵션에 completeness score (1-10)
- 인간 시간 / CC 시간 둘 다 명시
- 명시적 추천 ("RECOMMENDATION: A")

현재는 사용자가 판단 근거 없이 결정해야 하는 상황.

---

## 6차 분석 추가 발견 (2026-03-22)

### 발견 F1: review-pass 렌즈2에 LLM 프롬프트 품질 체크 누락 (P2)

**현황**: 렌즈2(완전성) 체크 항목: "빠진 항목, 처리되지 않은 엣지케이스, 누락된 파일"

**gstack 연결**: P2 INFORMATIONAL — "prompt quality" 항목 있음

**문제**: naia-os는 LLM 의존 앱(프롬프트 → LLM → 응답 파이프라인). 현재 review-pass에 프롬프트 자체의 품질 리뷰 항목이 없음.
- hallucination 유도 여지 있는 지시
- AI 역할 혼동 (user/assistant/system 구분 모호)
- 탈출 불가능한 루프 지시
- LLM 응답을 그대로 신뢰하는 코드 (sanitize 없음)

**적용 방향**: 렌즈2(완전성)에 항목 추가: "LLM을 호출하는 코드라면: 프롬프트 품질(역할 혼동/탈출 불가/hallucination 유도) + LLM 응답 신뢰 수준(그대로 사용 vs sanitize)"

---

## 7차 분석 추가 발견 (2026-03-22)

### 발견 F2: IDD commit 단계 ↔ agents-rules.json git_workflow 충돌 (P2)

**현황**:
- IDD `commit` 단계: "create PR linked to Issue"
- agents-rules.json `git_workflow.maintainer_rule`: "NEVER create PRs for Nextain repos — commit and push directly. PRs are for external contributors only."

**문제**: AI가 IDD를 따르면 Nextain 레포에서도 PR 생성을 시도함. pr-guard 훅이 실제로 차단하지만:
1. AI가 PR 생성 → 훅 차단 → 오류 → 당황 → 대안 탐색 패턴 발생 가능
2. lessons-learned 2026-03-07 "doc-contradiction" 교훈: "다른 audience를 위한 두 문서가 충돌하면 AI가 모순된 답을 줌" — 이 케이스가 정확히 해당

**적용 방향**: IDD `commit` 단계에 repo 유형별 분기 명시:
```
- "If Nextain repo: follow agents-rules.json git_workflow (push directly, no PR)"
- "If external contribution fork: PR to upstream"
- "If external repo: PR per contributing guide"
```

---

## 8차 분석 추가 발견 (2026-03-22)

### 발견 F3: IDD ↔ /doc-coauthoring 연결 누락 (P3)

**현황**: `/doc-coauthoring` 스킬은 agents-rules.json `skills` 섹션에 MANDATORY 트리거("구조화된 문서 작성 시 반드시 사용")로 등록됨.

**문제**: IDD `plan` 단계에 설계 스펙이 필요한 경우 `/doc-coauthoring`을 사용한다는 명시적 연결이 없음. skills 섹션의 MANDATORY 트리거는 일반 규칙이고, IDD plan 단계의 context에서 AI가 이를 적용할지는 판단에 의존함.

**적용 방향**: IDD `plan.steps`에 한 줄 추가: "설계 스펙/RFC 문서가 계획의 일부인 경우 → /doc-coauthoring 사용"

---

## 9차 분석 추가 발견 (2026-03-22)

### 발견 F4: review-pass 렌즈3에 프로젝트 코딩 컨벤션 체크 누락 (P2)

**현황**: 렌즈3(일관성) 체크 항목: "다른 파일과 충돌, 사이드이펙트, 의도하지 않은 변경"

**문제**: `contributing.yaml`에 명시된 프로젝트 규칙 — "No console.log/warn/error", "follow Biome" — 이 review-pass 렌즈에 반영 안 됨. 리뷰 시 이 규칙 위반을 자동으로 잡지 못함.

**적용 방향**: 렌즈3에 항목 추가: "프로젝트 코딩 컨벤션 준수 (contributing.yaml rules — no console.log/warn/error, Biome 준수)"

---

## 10차 분석 추가 발견 (2026-03-22)

### 발견 F5: .users/skills/ mirror drift + cascade-check 감시 범위 누락 (P2)

**현황**:
- `.agents/skills/`: `review-pass, manage-skills, verify-implementation, merge-worktree, doc-coauthoring, webapp-testing, read-doc, weekly-report` (8개)
- `.users/skills/`: `review-pass, doc-coauthoring, webapp-testing, read-doc, weekly-report` (5개)
- **누락 3개**: `manage-skills`, `verify-implementation`, `merge-worktree`

**근본 원인**: `cascade-check.js` Pattern 1~4가 `.agents/context/` 변경만 감시. `.agents/skills/` 변경 시 훅이 발동하지 않아 AI가 `.users/skills/` 업데이트를 놓침.

**SKILL_TEMPLATE.md**: "Mirroring Policy: 이 파일 수정 시 `.users/skills/[skill-name]/SKILL.md`도 동일하게 업데이트" — 규칙은 있지만 강제 없음.

**적용 방향**:
1. `cascade-check.js`에 Pattern 5 추가: `.agents/skills/` 변경 시 `.users/skills/` 동기화 알림
2. `.users/skills/`에 누락 3개 스킬 추가

---

## 11차 분석 추가 발견 (2026-03-22)

### 발견 F6: commit-guard가 PostToolUse라서 구조적으로 차단 불가 (P2)

**현황**: `commit-guard.js`는 PostToolUse 훅 → `git commit` 실행 **후** 경고.

**문제**: WARN→BLOCK output만 바꿔도 커밋은 이미 완료된 상태. 진짜 차단(blocking)은 `PreToolUse`여야 함. 현재 설계로는 어떤 output 값도 커밋을 되돌릴 수 없음.

**비교**: `destructive-git-guard.js`, `pr-guard.js` = PreToolUse → 실제 차단. `commit-guard.js` = PostToolUse → 구조적 차단 불가.

**적용 방향**: commit-guard를 PreToolUse로 이전. `git commit` 명령을 Bash tool 실행 전 검사.

---

## 12차 분석 추가 발견 (2026-03-22)

### 발견 F7: cascade-check.js가 root workspace의 en/ 미러 감시 안 함 (P2)

**현황**: `cascade-check.js`의 변수:
```js
const usersEn = `.users/context/${baseName}.md`;    // Korean default (올바름)
const usersKo = `.users/context/ko/${baseName}.md`;  // 존재하지 않는 경로
```

**문제**: root workspace는 `.users/context/en/` 서브폴더에 English 미러가 있음 (`en/contributing.md`, `en/philosophy.md` 실제 존재). 하지만 cascade-check가 `ko/` 경로를 알려주지 `en/` 경로를 알려주지 않음.

- `.agents/context/contributing.yaml` 편집 시 → `en/contributing.md` 업데이트 알림 **누락**
- `ko/` 경로는 root workspace에 존재하지 않아 알림이 무의미함

**근본 원인**: cascade-check.js가 naia-os triple-mirror 구조(ko/ 서브폴더)로 작성됐지만 root workspace는 en/ 서브폴더를 사용.

**적용 방향**: cascade-check.js Pattern 1 수정 — `ko/` → `en/` 경로로 변경.

---

## 13차 분석 추가 발견 (2026-03-22)

### 발견 F8: pr-guard.js가 command chaining으로 bypass 가능 (P2)

**현황**: `pr-guard.js` regex:
```js
command.match(/^\s*gh\s+pr\s+create\b/)
```
`^` = 문자열 시작부터 매칭.

**bypass**: `"cd naia-os && gh pr create"` → `gh`가 문자열 시작이 아님 → regex 불매칭 → 훅 통과.

**harness.yaml H1 판정**: "PASS — only blocks gh pr create for nextain/* repos" — 체인 명령 케이스 테스트 안 됨.

**적용 방향**: regex를 `command chaining` 대응으로 변경:
```js
command.match(/\bgh\s+pr\s+create\b/)  // ^ 제거, \b로 word boundary만 체크
```
또는 명령 파싱: `&&`, `;`, `|`로 분리 후 각 부분 체크.

---

## 14차 분석 추가 발견 (2026-03-22)

### 발견 F9: design-doc-unlock 파일 자동 만료 없음 (P3)

**현황**: `design-doc-guard.js`의 bypass 메커니즘:
1. AI가 사용자 승인 받음
2. `.claude/design-doc-unlock` 파일 생성
3. 설계 문서 편집
4. 파일 삭제

**문제**: 4번이 실행 안 된 경우 — 세션 컴팩션, AI 크래시, 컨텍스트 초과 — 다음 세션에서도 unlock 파일이 존재해 설계 문서 편집이 허용됨. 새 세션 AI는 unlock 파일 존재를 모름.

**적용 방향**: `session-inject.js`에 체크 추가: `.claude/design-doc-unlock` 파일 존재 시 session inject에 "[WARNING] design-doc-unlock file exists — may be a stale unlock from a previous session" 경고 주입.

---

## 15차 분석 추가 발견 (2026-03-22)

### 발견 F10: agents-rules.md의 app.naia-corp.example visibility 오류 (P2)

**현황**: `.users/context/agents-rules.md` 로컬 프로젝트 테이블 Line 31:
```
| `app.naia-corp.example` | ... | `naia-corp/app` | public |
```

**불일치**:
- CLAUDE.md: `app.naia-corp.example` → `no` (공개 여부 = 아님)
- project-index.yaml: `visibility: private`
- agents-rules.md: `public` → **오류**

**원인**: 미러 작성 시 오기입. cascade-check가 미러 내용의 정확성을 확인하지 않음(알림만 줌).

**적용 방향**: agents-rules.md Line 31 수정 `public` → `private`.

---

## GitHub Issue

https://github.com/nextain/naia-adk/issues/6
