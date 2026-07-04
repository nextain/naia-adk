[한국어](AGENTS.md) | [English](AGENTS.en.md)

# Naia ADK

AI Development Kit — 1인 개발자를 위한 개인용 AI 개발 인프라.
포크하고, 설정하고, 본인의 AI 도구에 연결하세요. [`nextain/naia-adk`](https://github.com/nextain/naia-adk)

**범위(Scope)**: `naia-adk` = 개인 / 1인. 팀 협업 → [`naia-business-adk`](https://nextain.io/adk).

## 포크 체인 (Fork Chain)

```
naia-adk                  ← Base (public, Apache 2.0)
  └── {org}-adk           ← Organization fork: company data + business submodules
        └── {user}-adk    ← Personal fork: personal data + project submodules
```

GitHub에서 포크한 뒤, 주기적으로 upstream을 동기화하세요: `git fetch upstream && git merge upstream/main`

## 필수 읽기 (Mandatory Reads)

**모든 세션 시작 시 다음 파일들을 읽으세요:**

1. `.agents/context/agents-rules.json` — 프로젝트 규칙 (SoT)
2. `.agents/context/ai-work-index.yaml` — 작업 유형 → 워크플로우 색인
3. `.agents/context/project-index.yaml` — 컨텍스트 색인 + 진입점
4. `.agents/context/terminology.yaml` — 용어 및 소통 정책 (신조어 금지, 기본 평이한 한국어, 학술어/약어는 괄호 병기)

**필요 시(Plan 또는 Review 단계 진입 시 읽기):**

4. `.agents/requirements/_index.yaml` — 제품 요구사항 색인
5. `.agents/context/skills-index.yaml` — 스킬 트리거/요약 색인

**ctx 온디맨드 섹션 (필요한 것만 로드 — 절대 파일 전체를 로드하지 말 것):**

`project-index.yaml` → `on_demand_loading`이 사용 가능한 섹션 ID 목록을 제공합니다. 주제별로 로드하세요:

| 필요 | 로드 |
|------|------|
| repo 구조 / SDLC / RBAC / 포크 커스터마이징 | `.agents/context/repo-structure-standard.yaml` |
| 워크플로우 / IDD / 리뷰 교훈 | `.agents/context/lessons-workflow.yaml` |
| upstream / 포크 / 기여 교훈 | `.agents/context/lessons-upstream.yaml` |
| 플랫폼 / CI / vLLM / Bazzite 교훈 | `.agents/context/lessons-platform.yaml` |
| React / IndexedDB / GitHub API 교훈 | `.agents/context/lessons-frontend.yaml` |
| 문서 추출 (HWP/DOCX/PPTX) | `.agents/context/lessons-documents.yaml` |
| gstack 비교 (섹션 1-8) | `.agents/context/gstack-comparison.md` |
| gstack 훅 발견사항 (A-E, F1-F10) | `.agents/context/gstack-hooks.md` |
| gstack 우선순위 목록 (P0-P3) | `.agents/context/gstack-priority.md` |
| push 게이팅 (research/dev/service) | `.agents/context/push-policy.yaml` |

검색용 색인: `.agents/context/.ctx-index.json` (훅이 자동 재생성, gitignore 대상)

## 프로젝트 구조 (Project Structure)

### 워크스페이스 디렉터리

| 디렉터리 | 계층(Tier) | 용도 |
|-----------|------|---------|
| `data-company/` | T2 | 회사 일반 데이터 (gitignore, 포크별) |
| `data-teams/` | T2 | 팀별 데이터 — 전략, 회계 (gitignore, 포크별) |
| `data-private/` | T3 | 개인 데이터, env 파일 (gitignore, 포크별) |
| `projects/` | T2 | 프로젝트 레포 (gitignore, 포크별) |
| `ref-*/` | T2 | 레퍼런스 레포 — 워크스페이스 루트에 `ref-cline`, `ref-opencode` 등으로 둠 (gitignore, 포크별. `project-index.yaml` 참조) |
| `skills/` | T1 | 운영/런타임 스킬 (대시보드 API로 제공) |
| `packages/` | T1 | 런타임 패키지 (pnpm workspace — 10개 활성) |
| `scripts/` | T1 | 유틸리티 스크립트, 도구 |
| `templates/` | T1 | 문서 템플릿 |
| `docs/` | T1 | 아키텍처, 스펙 |

**`packages/` (10개):** `core`·`server`·`dashboard`·`skill-spec`·`skills-builtin`·`openclaw-compat`·`persona`·`process`·`naia-anyllm`·`artifacts-spec` (권한(RBAC)·개발 수명주기(SDLC) 산출물 표준 스키마 — 15종 산출물을 JSON Schema로 정의).

### 포크 커스터마이징 (Fork Customization)

포크한 뒤, 포크 루트에 다음 내용을 담은 `FORK.md`를 생성하세요:

- 조직/사용자 정보
- 프로젝트 목록 (`projects/`의 서브모듈)
- 데이터 서브모듈 (`data-company/`, `data-teams/`)
- `.users/` 미러의 기본 언어
- 포크별 컨벤션

## 개발 프로세스 (Development Process)

### 기능 개발 (기본) — 이슈 기반 개발 (Issue-Driven Development)

기능 단위 작업(신규 기능, 광범위한 버그 수정)용. **14단계:**

1. **Issue** — GitHub 이슈 생성 또는 수령 (영어)
2. **Understand** — 이해 내용 요약, 사용자 확인 (게이트)
3. **Scope** — 조사 범위/깊이 정의, 사용자 승인 (게이트)
4. **Investigate** — 확정된 범위 내 코드 중심 조사
5. **Plan** — 모든 발견사항 기반 종합 계획, 사용자 승인 (게이트)
6. **Build** — 승인된 계획에 따라 구현
7. **Review** — 반복 리뷰 (연속 2회 무결 통과까지 반복) → `/verify-implementation` 실행
8. **E2E Test** — 실제 앱/서버 실행, 타깃 테스트 먼저 후 전체 스위트
9. **Post-test Review** — 테스트 통과 후 재리뷰 (연속 2회 무결 통과까지 반복) → `/verify-implementation` 실행
10. **Sync** — `.agents/` + `.users/` 컨텍스트 업데이트 → `/manage-skills` 실행 → 사용자 확인 (게이트)
11. **Sync Verify** — 컨텍스트 정확성 검증 (연속 2회 무결 통과까지 반복)
12. **Report** — 결과를 사용자에게 요약
13. **Commit** — 워크트리 작업 시: `/merge-worktree` 사용. 그 외: 이슈 번호를 참조한 커밋, PR 생성
14. **Close** — 단계별 완료 보고를 이슈 코멘트로 + 사용자 확인 (게이트)

**반복 리뷰는 5개 지점에 적용됩니다:** Plan 이후, 각 Build 단계 이후, 모든 Build 단계 이후, E2E Test 이후, Sync 이후.

**원칙:** upstream 코드를 먼저 읽기. 최소한의 수정. 동작하는 코드를 절대 깨뜨리지 말 것. 개선은 제안하되, 단독으로 결정하지 말 것.

**진행 파일 (필수):** 모든 단계 전환 시점에 `.agents/progress/{issue-slug}.json`을 작성/갱신하세요.

### 모든 세션 종료 시 (필수)

세션을 종료하기 전에 항상:
1. 새 지식으로 컨텍스트 파일 업데이트 (.agents/ ↔ .users/ ↔ 진입점 파일)
2. 정정이나 실수가 있었다면 교훈(lessons-learned) 기록
3. 모든 변경사항 커밋 및 푸시

이로써 당신의 학습이 다음 AI 세션으로 전달됩니다.

### 간단한 변경 (경량 사이클)

기능이 아닌 변경: 오타, 설정값, 단순 지시.

## 스킬 (Skills)

디스크에는 **두 개의 스킬 트리**가 있으며, 각기 다른 SoT와 소비자를 가집니다:

| 트리 | SoT 대상 | 소비 주체 | 색인 |
|------|---------|-------------|-------|
| `.agents/skills/` | AI 보조 / 워크플로우 스킬 | Claude Code (`.claude/skills/` 포인터 경유) | `.agents/context/skills-index.yaml` |
| `skills/` | 운영 / 런타임 스킬 | 대시보드 API (`core.discoverSkills()`가 `skills/**/SKILL.md` 스캔) | `/api/skills`로 제공 |

`skills-index.yaml`은 `.agents/skills/` 트리에 대한 사람/AI 요약 색인입니다.

### `.agents/skills/` (Claude Code SoT — `.claude/skills/`의 포인터가 여기를 가리킴)

| 스킬 | 설명 | 관리 |
|-------|-------------|------------|
| `review-pass` | 멀티 에이전트 상호검증 리뷰 (4단계) | 자동 (단계 7, 9) |
| `verify-implementation` | 모든 `verify-*` 스킬 실행, 통합 리포트 생성 | 자동 (단계 7, 9) |
| `verify-contract-conformance` | 선언된 API/인터페이스 계약 vs 구현 검증 | 자동 |
| `manage-skills` | 변경 분석, `verify-*` 스킬 생성/업데이트 | 자동 (단계 10) |
| `merge-worktree` | 시맨틱 커밋으로 워크트리 → main 스쿼시 머지 | 수동 (단계 13) |
| `read-doc` | HWP/PDF/DOCX/XLSX/PPTX 텍스트 추출 | 수동 |
| `webapp-testing` | 로컬 웹 앱 Playwright E2E 테스트 | 수동 |
| `doc-coauthoring` | 구조화 문서 공동작성 (3단계) | 수동 |
| `project-create` | 템플릿으로부터 신규 프로젝트 레포 scaffold | 수동 |
| `project-migration` | 디렉터리를 자체 레포로 분리 / 하네스 강화 | 수동 |
| `migrate-ctx` | 컨텍스트 파일을 현재 표준으로 마이그레이션 | 수동 |
| `payroll` | 급여명세서 PDF + 이메일 발송 | 수동 |
| `press-release` | 보도자료 작성, 아웃리치, 배포 | 수동 |
| `patent-draft` | KIPO 양식 특허 명세서 초안 작성 | 수동 |
| `patent-pipeline` | AI 특허 발굴, 평가, 출원 | 수동 |
| `copyright-reg` | 저작권 등록 서류 생성 | 수동 |
| `weekly-report` | git 커밋 기반 주간 업무 보고 | 수동 |
| `finetune-persona` | 페르소나 fine-tune 자산 준비 | 수동 |
| `secret-vault` | age 암호화 시크릿 볼트 열기/수정/재잠금 | 수동 |
| `youtube-upload` | YouTube Data API v3로 영상 업로드 (자막·썸네일 포함) | 수동 |

### `skills/` (운영 트리 — 대시보드 API가 스캔)

| 스킬 | 설명 |
|-------|-------------|
| `email` | SMTP 어댑터 기반 이메일 발송 (템플릿 지원) |
| `sms` | 게이트웨이 어댑터 기반 SMS / 알림톡 발송 |
| `notify` | 채널 비종속 알림 발송 |
| `channel-management` | Discord/Slack 채널 관리 — 생성, 보관, 알림, 요약 |
| `service-management` | 배포 서비스 모니터링 — 가동시간, 비용, 장애 대응 |
| `web-monitoring` | 웹 프레즌스 모니터링 — SEO, 가동시간, 애널리틱스 |
| `document-generation` | 브랜드 PDF 생성 (계약서, 결의서, 급여명세서) |
| `read-doc` | HWP/HWPX/PDF/DOCX/XLSX/PPTX 텍스트 추출 |
| `doc-coauthoring` | 구조화 문서 공동작성 (3단계) |
| `review-pass` | 멀티 에이전트 상호검증 리뷰 (4단계) |
| `config` | 설정값 읽기 또는 업데이트 |
| `cron` | 반복 / 1회성 스킬 호출 스케줄링 |
| `diagnostics` | 시스템 진단 — 헬스, 리소스, 네트워크 |
| `system-status` | 상위 수준 OS / 런타임 상태 |
| `sessions` | 과거 대화 세션 조회/요약 (읽기 전용) |
| `memo` | 장기 기억에 메모 작성 |
| `skill-manager` | 스킬 카탈로그 관리 — 목록, 신뢰 레포에서 설치 |
| `time` | 임의 타임존의 현재 시각 조회 |
| `weather` | 특정 위치의 현재 날씨 또는 예보 조회 |

> `read-doc`, `doc-coauthoring`, `review-pass`는 **양쪽** 트리에 모두 존재합니다. 대시보드
> API는 `skills/` 쪽 사본만 인식합니다(그 glob은 `.agents/` 안으로 내려가지 않음).

비즈니스/조직 레이어(`naia-business-adk`)는 이들을 팀 소유권, 위임 승인,
조직별 추가 스킬로 확장합니다 — 다만 위에 나열된 스킬들은 본 베이스 레포에 포함되어
제공됩니다.

## 레포지토리 구조 표준 (Repository Structure Standard)

레포별 문서화, SDLC 산출물 라이프사이클, RBAC 계층, 멀티 프로젝트 관리, 포크 커스터마이징 규칙.

**SoT**: `.agents/context/repo-structure-standard.yaml`
**사람용 미러 (한국어)**: `.users/context/repo-structure-standard.md`

다루는 범위: 레포 유형(`workspace_adk` / `runtime_library` / `app_os`) · 미러 패턴(dual/triple/split) · 하네스 동기화 · `.agents/progress/` 라이프사이클 · T0~T3 RBAC 계층 + `naia-business-adk` 확장 지점 · 멀티 프로젝트 블로킹 규칙 · 포크 오버라이드 메커니즘.

**포크 커스터마이징**: 포크 루트에 `overrides:` 섹션을 담은 `FORK.md`를 생성. 우선순위: naia-adk 기본값 → naia-business-adk 추가 → {org}-adk FORK.md → {user}-adk FORK.md (최우선).

---

## 디렉터리 구조 (이중 디렉터리 아키텍처)

```
.agents/                    # AI-optimized (English, token-efficient)
├── context/
│   ├── agents-rules.json   # Main rules (SoT) ← mandatory read
│   └── ai-work-index.yaml  # Work index ← mandatory read
├── workflows/              # Development workflows
├── skills/                 # Skill definitions (SoT)
├── hooks/                  # AI session hooks
└── requirements/           # Product requirements

.users/                     # Human-readable mirror
├── context/                # .agents/ mirror in Markdown
├── workflows/
└── skills/                 # .agents/skills/ mirror

.claude/                    # Claude Code configuration
├── settings.json           # Hooks registration
├── hooks/                  # PostToolUse hooks
└── skills/                 # Pointers → .agents/skills/
```

## 핵심 원칙 (Core Principles)

1. **부분 미러링**: `.users/`는 사람이 읽어야 할 핵심 문서를 `.agents/`에서 미러합니다(전체 복제가 아니며, 스킬 등 일부는 `.agents/` 쪽만 있습니다)
2. **SoT**: `.agents/context/agents-rules.json`이 단일 진실 공급원입니다
3. **응답 언어**: 기여자가 선호하는 언어

## 캐스케이드 규칙 (컨텍스트 전파)

컨텍스트가 변경되면 관련 모듈로 전파하세요.

| 트리거 | 전파 대상 |
|---------|-------------|
| 규칙 파일 변경 | `.users/` 미러 |
| 진입점 파일 변경 | `AGENTS.md` ↔ `CLAUDE.md` ↔ `GEMINI.md` (동일하게 유지) |

**순서**: self → parent → siblings → children → mirror

## 컨벤션 (Conventions)

- **개발**: 이슈 기반 개발 (기본). 적용 가능한 곳에서는 TDD.
- **언어**: Git/공유(커밋, 이슈, PR) → 영어. 개인 메모 → 어떤 언어든.
- **라이선스**: Apache 2.0

## 라이선스 (License)

```
Copyright 2026 Nextain Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```
