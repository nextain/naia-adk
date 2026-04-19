<!-- Copyright 2026 Nextain Inc. All rights reserved. -->

# Naia OS 규칙 가이드

`.agents/context/agents-rules.json`에 대한 사람이 읽을 수 있는 가이드입니다.

## 목적

`agents-rules.json` 파일은 AI 에이전트 규칙의 **단일 진실 소스(SoT)**입니다.
이 문서는 개발자를 위해 규칙을 자세히 설명합니다.

---

## 프로젝트 개요

### Naia OS

Luke의 개발 워크스페이스 (`nextain/member-luke`, private). 주력 오픈소스 프로젝트인 Naia OS를 중심으로 관련 서비스를 관리합니다.

**조직**: nextain

---

## 로컬 프로젝트

| 프로젝트 | 용도 | 레포 | 공개 |
|---------|------|------|:---:|
| `naia-os` | Naia OS 데스크톱 앱 (Tauri 2 + React + Three.js + Node.js agent) | `nextain/naia-os` | public |
| `issue-desk` | IssueDesk — naia-os용 standalone Vite+React 패널. 이슈/PR 트리아지, 커뮤니티 어시스턴트, 알림 트리아지 | `nextain/issue-desk` | private |
| `about.nextain.io` | Nextain 회사 소개 사이트 (Next.js 14 + next-intl) | `nextain/about.nextain.io` | public |
| `naia.nextain.io` | Naia 웹앱 / Lab 포털 (Next.js + BFF) | `nextain/naia.nextain.io` | private |
| `aiedu.nextain.io` | AI 교육 플랫폼 — 커리큘럼 기반 AI 선생님 (Next.js + Monaco + Pyodide + any-llm) | `nextain/aiedu.nextain.io` | private |
| `admin.nextain.io` | Nextain B2B 어드민 제어판 (라이선스 키 관리, 토큰 추적, 클라이언트 관리) | `nextain/admin.nextain.io` | private |

---

## 인프라 (공유 게이트웨이)

### any-llm 게이트웨이

naia, aiedu, admin 모두 동일한 any-llm 게이트웨이를 사용합니다.

| 환경 | URL | Key |
|------|-----|-----|
| **prod** | `https://naia-gateway-181404717065.asia-northeast3.run.app` | `GATEWAY_MASTER_KEY` 환경변수 |
| **dev** | `https://naia-gateway-dev-181404717065.asia-northeast3.run.app` | `qliT3Q4SC128rtR5o2dwud0vP25tu4usuvyFAP1oGAE` |

**DB**: `cafelua-db` (Cloud SQL PostgreSQL 15, asia-northeast3-a)
- prod: `any_llm_gateway`
- dev: `any_llm_gateway_dev` (동일 인스턴스, 별도 DB)

**규칙**
- `.env.local` → **dev** 게이트웨이 사용
- `.env.production.local` → **prod** 게이트웨이 사용
- `.env.local`에 prod 크레덴셜 절대 금지 → `prod-gateway-guard.js` 훅이 차단
- prod→dev 동기화: `project-any-llm/scripts/sync-prod-to-dev.sh` (수동, "yes" 확인 필요, dev 데이터 전체 덮어씀)

### GitHub Actions 셀프호스트 러너

| 항목 | 값 |
|------|----|
| **러너명** | `luke-bazzite` |
| **호스트** | 이 Bazzite PC (`/opt/actions-runner`) |
| **적용 범위** | nextain org **프라이빗 레포 전용** |
| **레이블** | `self-hosted, linux, x64, bazzite` |
| **systemd 서비스** | `actions.runner.nextain.luke-bazzite.service` |

**워크플로우 사용법**: `runs-on: [self-hosted, linux, x64]`

**주의사항**
- 퍼블릭 레포에 셀프호스트 러너 절대 금지 (fork PR 보안 위협)
- 재설치 시 `/var/home`은 SELinux exec 차단 → 반드시 `/opt/` 하위에 설치

---

## 서브모듈 구조

| 서브모듈 | 용도 | 레포 | 공개 |
|---------|------|------|:---:|
| `docs-work-logs` | 개발자 작업 로그 | `nextain/docs-work-logs` | private |
| `docs-nextain` | 내부 문서함 (온보딩, 회의록, 디자인) | `nextain/docs-nextain` | private |
| `docs-business` | 사업 문서 (제안서, 전략, IR) | `nextain/docs-business` | private |
| `cafelua.com` | Cafelua 개인 웹사이트 | `luke-n-alpha/cafelua-private` | private |
| `project-any-llm` | Any-LLM SDK + FastAPI Gateway | `nextain/any-llm` | public |

### 참조용 서브모듈 (Read-Only)

| 서브모듈 | 용도 | 소스 |
|---------|------|------|
| `ref-cline` | Cline 업스트림 참조 | [cline/cline](https://github.com/cline/cline) |
| `ref-opencode` | OpenCode 참조 | [anomalyco/opencode](https://github.com/anomalyco/opencode) |
| `ref-nanoclaw` | NanoClaw 참조 | [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) |
| `ref-moltbot` | Moltbot 참조 | [moltbot/moltbot](https://github.com/moltbot/moltbot) |
| `ref-project-airi` | AIRI 참조 | [moeru-ai/airi](https://github.com/moeru-ai/airi) |
| `ref-jikime-adk` | Jikime ADK 참조 | [jikime/jikime-adk](https://github.com/jikime/jikime-adk) |
| `ref-jikime-mem` | Jikime Memory 참조 | [jikime/jikime-mem](https://github.com/jikime/jikime-mem) |

**중요**: 서브모듈에서 작업할 때는 해당 서브모듈의 진입점 파일을 먼저 읽어야 합니다.

---

## 수정 레벨

### L1 - 독립 (자유롭게 수정 가능)
- `docs-work-logs` (개인 폴더)

### L2 - 조건부 (제약 있음)
- `docs-nextain`
- `docs-business`
- `cafelua.com`
- `project-any-llm`

---

## 스킬

### read-doc

> **문서 파일을 읽어야 할 때 반드시 사용**

| 항목 | 내용 |
|------|------|
| **실행 조건** | `.hwp` `.hwpx` `.pdf` `.docx` `.xlsx` `.pptx` 파일을 읽거나 분석해야 할 때 |
| **명령** | `/read-doc <파일경로>` |
| **규칙** | **"파일을 읽을 수 없다"는 말 절대 금지** — 항상 `/read-doc`으로 읽을 수 있음 |
| **사이드카** | `docs-business` HWP/HWPX 파일은 `.txt` 사이드카가 있으면 자동으로 먼저 사용 |

**활용 예시**:
- `docs-business` 제안서/사업계획서 분석
- 발표 자료(PPTX) 내용 파악
- 이력서(DOCX) 검토
- 정부과제 제출서류 검토

### webapp-testing

> **로컬 웹 앱 테스트 시 반드시 사용 — 사용자에게 수동 테스트 시키지 말 것**

| 항목 | 내용 |
|------|------|
| **실행 조건** | E2E 테스트, UI 동작 검증, 스크린샷 캡처, 콘솔 로그 확인 (로컬 웹 앱 대상) |
| **명령** | `/webapp-testing` |
| **규칙** | 사용자에게 직접 확인 요청 금지. Playwright Python 스크립트로 AI가 직접 검증 |

**활용 예시**:
- Next.js 앱 E2E 테스트 (naia.nextain.io, about.nextain.io, aiedu.nextain.io)
- UI 동작 검증 (버튼 클릭, 폼 제출 등)
- 스크린샷 캡처 및 콘솔 로그/에러 확인

### doc-coauthoring

> **구조화된 문서 작성 요청 시 반드시 사용**

| 항목 | 내용 |
|------|------|
| **실행 조건** | 기술 스펙, 제안서, RFC, 설계 문서, PRD, 결정 기록 등 비코드 문서 작성 요청 시 |
| **명령** | `/doc-coauthoring` |
| **워크플로우** | 3단계: 컨텍스트 수집 → 구조화 작성 → 독자 테스트 |

**활용 예시**:
- 기술 스펙 / RFC 작성
- 제안서 / IR 문서
- GitHub Issue 기반 기능 설계 스펙

---

## AI 워크플로우 원칙

### 지식 동등 원칙
```
AI 지식 = 개발자 지식 (1:1 동등)
```

### 기본 워크플로우
- **기능 단위 작업 (기본값)**: `issue-driven-development.yaml` — 이해 확인 → 범위 확인 → 조사 → plan 확인 → 구현 → 리뷰 → E2E → 동기화 → 커밋
- **단순 변경 지시**: `development-cycle.yaml` — 기능 변경이 아닌 오타, 설정값 등

### 권한 모델

| 파일 유형 | AI 역할 | 허용 |
|-----------|---------|------|
| 코드 파일 | 구현자 | 읽기·수정·생성·삭제 자유 |
| 설계 문서 | 리뷰어 | 오타/내부모순/깨진링크만. 나머지는 사용자에게 먼저 보고 |

**설계 문서 경로**: `docs/design/`, `design/`, `spec/` 디렉토리 내 `.md/.txt/.yaml/.json` 파일

**설계-구현 괴리 발견 시 에스컬레이션:**
1. 설계 문서 수정 금지
2. 구현을 조용히 맞추는 것도 금지
3. 사용자에게 보고: "설계는 X, 구현은 Y — 선택지: A) 설계 업데이트, B) 구현 수정, C) 의도적 차이로 수용"
4. 사용자 결정 대기

**리뷰 클린패스 정의:**
- 코드 리뷰: 수정사항 없음
- 설계 문서 리뷰: 새 발견사항 없음 (구현과 비교는 허용되지 않는 발견사항)

### 필수 사전 점검
1. `agents-rules.json` 먼저 읽기
2. 서브모듈에서 작업 시 해당 진입점 파일 읽기
3. 기능 단위 작업 시: issue-driven-development.yaml 게이트 준수 (이해 → 범위 → plan 확인 필수)
4. 최소 변경 원칙 적용
5. `.hwp/.hwpx/.pdf/.docx/.xlsx/.pptx` 파일 → `/read-doc` 스킬 먼저 실행
6. **설계 문서** (`docs/design/`, `design/`, `spec/`) + 확장자 `.md/.txt/.yaml/.json`: 위 권한 모델 참조. 훅이 편집 시 경고 — 근거 유형을 사용자에게 먼저 보고할 것.
7. **파괴적 git 명령**(`git checkout --`, `git reset --hard`, `git clean -f`) 실행 전: 무엇이 삭제되는지 명시하며 반드시 사용자 확인 먼저. 예외 없음.

### 반복 리뷰 — /review-pass 스킬 사용

코드 리뷰는 `/review-pass` 스킬로 실행 (4단계 멀티 AI 상호검증):
- `stage=planning|development|test|integration`: 단계별 렌즈·리뷰어·수렴 기준 차등 적용
- REQ-ID 추적: 기능 수준 작업에서 요구사항→코드→테스트 추적 (lightweight cycle 제외)
- **수렴**: development/integration 2연속 clean, planning/test 1연속 clean
- 적용 범위: Build→Review(development), E2E→Post-test(test+integration)

### 완전성 원칙 (Completeness Principle)

AI 한계비용 ≈ 0 → 승인된 작업은 완전하게 구현한다 (엣지케이스, 에러 처리, 테스트 포함).

**3가지 원칙의 적용 대상 구분:**

| 원칙 | 적용 대상 | 설명 |
|------|---------|------|
| `no_autonomous_development` | **무엇을** 만들지 | 사용자 결정. 묻지 않고 기능 추가 금지 |
| `minimal_modification` | **얼마나** upstream에서 이탈할지 | fork 기반 작업에서 최소 변경 유지 |
| `completeness` | 승인된 것의 **품질** | 만들기로 결정됐으면 완전하게. A(완전) vs B(부분) → A 추천 |

**Boilable Lake 규칙**: 범위가 유한한 모듈은 완전히 구현한다. AI에게 추가 비용이 거의 없을 때 부분 구현을 선택하지 않는다.

### AskUserQuestion 표준 형식

사용자 결정이 필요한 질문(게이트, 옵션 선택, 범위 결정)의 표준 구조:

1. **Re-ground** (1-2문장): 프로젝트 + 현재 단계 + 질문 대상을 평이하게 서술
2. **Simplify**: 기술 용어 없이, 비개발자도 이해할 수 있도록 질문
3. **Recommend**: 명시적 추천 + 완전성 점수(1-10) + AI 소요시간 + 검토 소요시간
4. **Options**: A/B/C 레터링, 각각 노력 + 완전성 점수 + 한 줄 트레이드오프

```
RECOMMENDATION: A (완전성 9/10 | AI: ~30분 | 검토: ~10분)
A) 전체 구현 — 엣지케이스 모두 처리 [완전성 9/10]
B) 최소 구현 — 빨리 출시, 나중에 재방문 [완전성 5/10]
```

### 세션 종료 규칙
모든 세션 종료 시: 컨텍스트 업데이트 → 교훈 기록 → MEMORY.md 업데이트 → 커밋 & 푸시.
목적: 다음 세션의 AI가 이번 세션의 학습을 물려받게 하는 것.

### 컨텍스트 생존 (Anti-Compact)
중요한 결정/교정은 대화에 의존하지 말고 파일/Issue에 즉시 기록.
대화 컨텍스트 압축 시 휘발 방지.

### 서브모듈 규칙
각 서브모듈은 자체 규칙이 있습니다. 수정 전 `entry_point`를 읽으세요.

### Git 워크플로우 규칙
- **메인테이너 직접 커밋**: Luke는 모든 Nextain 레포의 메인테이너. Nextain 레포에 PR 생성 절대 금지 — main(또는 해당 브랜치)에 직접 커밋 & 푸시.
- **PR은 외부 기여자 전용**: `gh pr create`는 pr-guard 훅이 자동 차단.

---

## 컨벤션

| 항목 | 규칙 |
|-----|------|
| 응답 언어 | 한국어로 응답 |
| 개발 접근법 | Issue-driven development (기본값). TDD는 해당 시 적용 |
| 테스트 코드 리뷰 | 테스트 작성 후 결과 맹신 금지. 테스트 로직 자체를 반복 리뷰(연속 2회 클린 패스) 후 실행. 무효 테스트 징후: 항상 통과하는 단언, 실제 동작과 괴리된 mock, 음성 케이스 누락 |
| 작업 로그 | 명시적 요청 없이 수정하지 않음 |

### 외부 레포 대응 정책

**원칙: 정보 수집 먼저 → 내부 검증 → 사용자 허락 → 외부 커뮤니케이션**

1. **커뮤니티 컨텍스트 수집 우선** — 레포, Discord, Slack, 포럼 등 어떤 커뮤니티든 활동 전에:
   - **말투** — 격식체/구어체, 간결함/상세함, 영어 수준
   - **규칙** — CoC, PR/이슈 템플릿, 라벨링 컨벤션
   - **성향** — 무엇을 중요하게 여기는지, 무엇을 거부하는지, 외부인에게 어떻게 반응하는지, 영향력 있는 멤버가 누구인지, 과거 유사 상호작용 사례
2. 외부 레포의 CONTRIBUTING.md / 가이드 먼저 읽기
3. 기존 이슈/PR 검색 (중복 방지)
4. 코드 패턴 및 컨벤션 파악
5. 내부에서 충분히 프로토타입/검증
6. 이슈/PR 초안 작성 후 사용자에게 검토 요청
7. 사용자 명시적 승인 후에만 외부에 게시

**외부 레포에 이슈/PR/코멘트를 사용자 허락 없이 올리지 않는다.**

**분위기 맞추기**: 기술 이슈/PR도 사람이 읽는다. 커뮤니티 분위기에 맞는 글을 쓴다 — RFC 스타일의 커뮤니티라면 간결한 기술적 문체, 친근한 커뮤니티라면 그에 맞는 톤. 기술적으로 옳은 것만큼 문화적으로도 적절해야 한다.

**AI 작성 명시 + 연락처**: 외부 레포에 AI 보조로 작성한 내용을 게시할 때는 반드시 (1) AI 작성 명시, (2) 문제 있을 시 개발자에게 연락 요청을 함께 적는다.
예: `🤖 Written with AI assistance. If anything looks off, please ping @luke-n-alpha or open a discussion.`
투명성과 책임 모두 필요.

### 기여 Fork 정책

upstream에 기여하기 위한 fork 레포 관리 규칙.

| 항목 | 규칙 |
|------|------|
| **계정** | `nextain` 조직 — 개인 기여가 아닌 Nextain 공식 기여 |
| **레포명** | upstream과 동일 이름 (prefix 없음) |
| **main 브랜치** | upstream main + AGENTS.md (AI 컨텍스트, 여기서 버전 관리) |
| **feature 브랜치** | upstream main 기준, 코드 변경만 — AGENTS.md 절대 포함 금지 |
| **PR** | feature 브랜치 → upstream. AGENTS.md는 main에만 있으므로 PR diff에 자동 제외 |
| **main 동기화** | upstream main과 항상 동기화 유지 (정기적으로 rebase/merge) |
| **수명** | upstream PR 머지 후 아카이브 또는 삭제 |

**README 필수 기재 항목** (기여 fork임을 명확히):
1. 이 레포는 기여 fork임 (hard fork 아님)
2. upstream 레포 링크
3. 기여하는 기능/수정 내용
4. 현재 상태 (진행 중 / PR 제출 / 머지 완료)
5. 연락처: @luke-n-alpha

**GitHub 레포 설명**: `Contribution fork — [feature] upstream PR in progress. See [upstream url]`

---

## 컨텍스트 전파 규칙 (Cascade Rules)

컨텍스트가 변경되면 관련 상위/하위/형제 모듈의 컨텍스트도 함께 업데이트해야 합니다.

### 1. 서브모듈 추가 시 (onSubmoduleAdd)

**전파 대상**: parent (상위 모듈)

**필요 작업**:
- `parent/.gitmodules`에 서브모듈 항목 추가
- `parent/.agents/context/agents-rules.json`의 `submodules`에 항목 추가
- `parent/CLAUDE.md`의 서브모듈 테이블 업데이트
- `parent/.agents/context/ai-work-index.yaml`에 카테고리 추가 (필요 시)

### 2. 서브모듈 제거 시 (onSubmoduleRemove)

**전파 대상**: parent (상위 모듈)

**필요 작업**:
- `parent/.gitmodules`에서 제거
- `parent/.agents/context/agents-rules.json`의 `submodules`에서 제거
- `parent/CLAUDE.md`의 서브모듈 테이블에서 제거

### 3. 규칙 파일 변경 시 (onRulesChange)

**전파 대상**: mirror (`.users/` 미러)

**필요 작업**:
- `.users/context/agents-rules.md` 동기화 업데이트 (1:1 미러링 원칙)

### 전파 순서

1. **자기 자신 (self)** 변경 완료
2. **부모 (parent)** 컨텍스트 업데이트
3. **형제 (siblings)** 중 참조하는 모듈 업데이트
4. **자식 (children)** 중 참조하는 모듈 업데이트
5. **미러 (.users/)** 동기화

---

## 서브모듈 초기화

```bash
git submodule update --init --recursive
```

---

## 업데이트 방법

1. `.agents/context/agents-rules.json`에서 AI 규칙 수정
2. 이 파일을 업데이트하여 사람을 위한 변경 사항 설명
3. 두 파일을 항상 동기화 유지
