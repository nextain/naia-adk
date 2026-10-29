# `naia-adk` v0.2.0 통합 추상화 규칙 카탈로그 (`rules/`)

범위: 공통 (`naia-adk` 표준 규칙 카탈로그 — 이 저장소를 포크한 워크스페이스에서 검증·정립된 11대 핵심 개발·검수·운영·조직 채널 규칙의 범용 정본)

---

## 1. 개요

> 층 번호는 아래에서 위로 센다: 1층 센서 · 2층 실행·검수 · 3층 조정 세션 · 4층 자문(2026-10-20 개편). 파일·스크립트 이름의 `layer4`·`l4` 는 옛 번호 시절 이름이다. 전체 구조는 [`docs/guides/adk-2.0-structure.md`](../docs/guides/adk-2.0-structure.md).

이 디렉토리(`rules/`)는 개발 워크스페이스 운영 과정에서 실측·정립된 규칙, 검증 게이트, 1층 센서 루프, QA 절차, 다중 계정 관리, 그리고 에이전트 중심 4종 ADK(`user`/`group`[구 `org` 읽기 호환 별칭]/`agent`/`project`)와 일정(`schedule`), 사내 메신저 채널·담당 표(`channel-roles-gen.mjs`) 아키텍처를 특정 개인·회사의 비밀값이나 로컬 경로 없이 범용 표준으로 추상화한 정본 카탈로그다.

---

## 2. 핵심 개선 축과 규칙 문서 매핑

| 축 번호 | 핵심 개선 축 | 정본 규칙 문서 (`rules/`) | 워크스페이스 적용·강제 스크립트 및 설정 |
|---|---|---|---|
| **축 1** | **광범위 문제해결 위임 & 모듈 리팩토링 권한** (파일·줄 제한 폐지, 거대 파일 방지) | [`refactoring-and-broad-problem-solving.md`](refactoring-and-broad-problem-solving.md) | [`../.agents/context/agents-rules.json`](../.agents/context/agents-rules.json) (`instruction_is_short`, `split_independent_items`); [개발 문서 작성 기준](../docs/guides/dev-docs-writing.md) |
| **축 2** | **결정론적 코드 복잡도 게이트 (`USR-012`)** (500줄/80KB 경고, 800줄/160KB·+250줄 `REFACTOR_REQUIRED`, 1,200줄/300KB 차단) | [`refactoring-and-broad-problem-solving.md`](refactoring-and-broad-problem-solving.md) | 저장소 안 `USR-012` 요구사항 파일 대상 없음; [복잡도 측정기](../.agents/skills/review-pass/scripts/measure-complexity.mjs), [리뷰 사전 검사](../.agents/skills/review-pass/scripts/review-preflight.mjs) |
| **축 3** | **상시 문맥 예산 게이트 (`<= 20,000B` / 총합 `<= 60,000B`)** (1줄 규칙 + `detail` 분리) | [`refactoring-and-broad-problem-solving.md`](refactoring-and-broad-problem-solving.md) | [`../.agents/context/context-budget.json`](../.agents/context/context-budget.json), [`../scripts/check-context-budget.mjs`](../scripts/check-context-budget.mjs), [`../.agents/hooks/core/agents-rules-load.js`](../.agents/hooks/core/agents-rules-load.js) |
| **축 4** | **서브에이전트 무응답 방지 주기적 워치독 의무** (호출 시 타이머 동시 설정, 진도율 감시) | [`layer4-sensor-and-memo-loop.md`](layer4-sensor-and-memo-loop.md) | [`../.agents/context/agents-rules.json`](../.agents/context/agents-rules.json) (`delegate_exploration`, `subagent_watchdog_and_layer4_sensor`); 저장소 안 `orchestration-watch.mjs` 대상 없음 |
| **축 5** | **1층(Tier-1) 교차 센서 아키텍처** (메신저 + 서브에이전트 완료/정체 + 미소비 깨움 파일 + 시간 예약 틱) | [`layer4-sensor-and-memo-loop.md`](layer4-sensor-and-memo-loop.md) | 저장소 안 작업 문서와 센서 스크립트 대상 없음 |
| **축 6** | **작업 문서 드래그 메모 (`doc-notes`) ⇄ 1층 센서 ⇄ 문서 수정·커밋 루프** | [`layer4-sensor-and-memo-loop.md`](layer4-sensor-and-memo-loop.md) | 저장소 안 작업 문서와 센서 스크립트 대상 없음 |
| **축 7** | **사용자 원문 무손실 보존 (`00-USER-REQUESTS`) & 계획 승인 게이트 (`approval-plan.mjs`)** | [`evidence-driven-process.md`](evidence-driven-process.md) | 저장소 안 계획 승인 스크립트, 리뷰 실행기, 개발 절차 문서 대상 없음 |
| **축 8** | **양방향 스펙 체인 (`PC → SP/UC → RQ → FE → [UT/IT/E2E] → QC`) & 역할별 모델 분리** (구현 모델 / 다른 계열의 독립 검수 모델) | [`evidence-driven-process.md`](evidence-driven-process.md) | 저장소 최상위 `scripts/`에는 검사기가 없음; 템플릿 검사기 [`templates/project-skeleton/scripts/validate-spec-chain.mjs`](../templates/project-skeleton/scripts/validate-spec-chain.mjs); `FORK.md`와 개발 절차 문서는 저장소 안 대상 없음 |
| **축 9** | **실패 우선 검증 (Failure-First Validation 25개 절차) & 기본 구조화 디버그 로깅 (`D47` + 링버퍼/스냅샷)** | [`qa-and-debug-logging.md`](qa-and-debug-logging.md) | 저장소 안 failure-first 가이드는 없음; 디버그 로깅은 [`docs/guides/debug-logging.md`](../docs/guides/debug-logging.md) |
| **축 10** | **Claude 4계층 다중 계정 관리 (격리·지문 미러링·무토큰 사용량·95% 자동 전환) & 멀티 CLI 프로파일 라우팅** | [`multi-cli-account-management.md`](multi-cli-account-management.md) | 해당 스크립트와 가이드의 저장소 내 대상 없음 |
| **축 11** | **에이전트 중심 4종 ADK(`SetWorkspace` 루트=에이전트 ADK) · 조직 자리(`agents/<이름>/`) 환경변수 키 주입 · 업무 장부 분리 · 설정 우선순위 · 채널·담당 표 생성기(`channel-roles-gen.mjs`)** | [`discord-channel-roles-and-org-adk.md`](discord-channel-roles-and-org-adk.md) | [`../schemas/adk-manifest.schema.json`](../schemas/adk-manifest.schema.json), [`../schemas/channels.schema.json`](../schemas/channels.schema.json), [`../scripts/channel-roles-gen.mjs`](../scripts/channel-roles-gen.mjs), [`../scripts/adk-link.mjs`](../scripts/adk-link.mjs), [`../templates/org-channels/`](../templates/org-channels/) |

---

## 3. 문서 목록 및 읽는 순서

1. **[`refactoring-and-broad-problem-solving.md`](refactoring-and-broad-problem-solving.md)**
   - 문제·근본 원인·목표·수용 조건 중심의 광범위 위임 원칙, 거대 파일 방지 리팩토링 권한, `USR-012` 복잡도 임계치(500 / 800 / 1,200줄) 및 면제(Waiver) 규율.
2. **[`layer4-sensor-and-memo-loop.md`](layer4-sensor-and-memo-loop.md)**
   - 서브에이전트 호출 시 주기적 워치독 타이머 의무, 1층 교차 센서의 5대 감지 신호(메신저·완료·무응답·미소비 깨움·`doc-notes`), 작업 문서 메모 답변 + 본문 수정 + `git commit` 폐루프.
3. **[`evidence-driven-process.md`](evidence-driven-process.md)**
   - 사용자 원문 추적표(`00-USER-REQUESTS-traceability.ko.md`) → 계획 승인(`approval-plan.mjs`) → `PC → SP/UC → RQ → FE → [UT/IT/E2E] → QC` 스펙 체인 검증(`validate-spec-chain.mjs`) → 구현 모델과 다른 계열의 독립 검수 모델 분리.
4. **[`qa-and-debug-logging.md`](qa-and-debug-logging.md)**
   - 실패 우선 검증 4단계와 QA 시간·비용 낭비 방지 7대 핵심 규율(25개 절차), 기본 ON 디버그 모드·구조화 JSONL 로그·메모리 링버퍼(`ring` + `snapshot()`)·주기적 정리 배치(`D47`).
5. **[`multi-cli-account-management.md`](multi-cli-account-management.md)**
   - Claude Code 4계층 다중 계정 아키텍처(슬롯 격리·실시간 지문 미러링·무토큰 OAuth 사용량 조회·95% 임계치 양방향 자동 전환) 및 6대 CLI(`claude`, `codex`, `agy`, `muse`, `grok`, `opencode`) 역할·계정 분리 표준.
6. **[`discord-channel-roles-and-org-adk.md`](discord-channel-roles-and-org-adk.md)**
   - 나이아쉘(`user` ADK 읽기) ⇄ 뇌(`agent` ADK `SetWorkspace` 루트) 분리, 에이전트 ADK(`birth`, `nva/`, `public-room/`, `memory/common/`+`memory/groups/<group>/`), 그룹(구 조직, `group` / 레거시 별칭 `org`) 실행 자리(`agents/<이름>/`)와 환경변수(`env_only`) 키 주입, 업무 장부의 에이전트 ADK 배제(`user`/`project`/`group` 보유), 설정 우선순위(`실행 인자 > 프로젝트 > 에이전트 > 유저 > 그룹 > 틀`), 그리고 채널·담당 표(`channels.yaml` + `channel-ids.json`) 생성기 `channel-roles-gen.mjs`의 7가지 결정론적 검사.

---

## 4. 결정론적 검증 명령 모음

```bash
# 1. 상시 문맥 예산 검증 (agents-rules.json <= 20,000B, 상시 사슬 합계 <= 60,000B)
node scripts/check-context-budget.mjs
node --test scripts/check-context-budget.test.mjs

# 2. 규칙 본체(agents-rules.json)와 상세(agents-rules-detail.json) 병합 무결성 검증
node .agents/hooks/core/agents-rules-load.test.js

# 3. 진입점 미러(AGENTS.md / CLAUDE.md / GEMINI.md) 동기화 검증
node .claude/hooks/sync-entry-points.js --check

# 4. 코드 복잡도 게이트(USR-012) 및 리뷰 프리플라이트 검증
node .agents/skills/review-pass/scripts/measure-complexity.mjs --files <파일...>

# 5. 채널·담당 표 생성기(channel-roles-gen.mjs) 미리보기 및 결정론적 테스트
node scripts/channel-roles-gen.mjs \
  --table templates/org-channels/channels.example.yaml \
  --ids templates/org-channels/channel-ids.example.json \
  --init-instances
node --test tests/*.test.mjs
```
