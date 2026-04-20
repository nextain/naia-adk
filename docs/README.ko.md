[English](../README.md) | 한국어

# Naia ADK

**개인 및 기업을 위한 AI 개발 킷.**

AI 에이전트, 스킬, 데이터, 워크플로우를 하나의 워크스페이스로 통합하는 오픈소스 프레임워크입니다. 포크해서 설정하고, 당신의 것으로 만드세요.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

## Naia ADK란?

Naia ADK는 AI 기반 운영을 위한 기반 프레임워크입니다 — 개인과 조직 모두 포크하여 자신의 워크스페이스를 구성할 수 있습니다:

- **개인용** — 스킬, 자동화, 프로젝트 관리가 포함된 개인 AI 워크스페이스
- **기업용** — 포크하여 회사 데이터와 서브모듈을 추가하고 팀에 배포
- **제품 연동** — [Naia OS](https://github.com/nextain/naia-os)의 스킬·데이터 백엔드로 MCP/WebSocket 연결

### 의존이 아닌 인터페이스

naia-adk는 **툴에 종속되지 않는 워크스페이스 포맷**입니다. 특정 AI 툴에 의존하지 않으며, AI 툴들도 naia-adk의 런타임에 의존할 필요가 없습니다:

- **포맷이 곧 계약** — 디렉터리 구조(`.agents/`·`.users/`·`skills/`·`data-*/`), 파일 스키마(`agents-rules.json`·SKILL.md), 규약. 이 포맷을 읽을 수 있는 모든 AI 코딩 툴이 naia-adk 워크스페이스를 사용 가능합니다.
- **런타임 비종속** — Claude Code·OpenCode·Codex·naia-agent 모두 같은 포맷을 독립적으로 읽습니다. 어느 것도 naia-adk의 코드를 임베드하지 않아요.
- **자유로운 교체** — 툴을 바꾸거나, 새 조직을 위해 워크스페이스를 포크하거나, 한 프로젝트 안에서 여러 툴을 섞어 써도 워크스페이스는 그대로 작동합니다.

Naia 생태계의 더 큰 철학의 일부입니다: 레포들은 **런타임 의존이 아닌 공개된 인터페이스와 포맷**으로 연결됩니다. 전체 그림은 [naia-agent README](https://github.com/nextain/naia-agent) 참고.

### 포크 체인

```
naia-adk                  ← Base 프레임워크 (공개, Apache 2.0)
  ├─ naia-business-adk   ← 비즈니스 확장 (유료): 급여, HR, 컴플라이언스
  │    └── {조직}-adk     ← 조직 포크: 기업 데이터 + 서브모듈
  │          └── {사용자}-adk  ← 개인 포크: 개인 데이터 + 프로젝트
  └── {사용자}-adk         ← 직접 포크: 개인 사용
```

예시 — 넥스테인 체인:

```
naia-adk → naia-business-adk → nextain-adk → alpha-adk
```

어느 레이어에서든 포크 가능. 개인은 `naia-adk`를 직접 포크, 조직은 비즈니스 확장을 거칩니다.

### 비즈니스 확장

**[Naia Business ADK](https://nextain.io/adk)** — 조직을 위한 유료 확장:

- 사전 구축된 비즈니스 스킬 (급여, 회계, HR 문서 생성)
- 멀티테넌트 팀 관리
- 우선 지원 및 SLA
- 컴플라이언스 대응 템플릿 (GDPR, 개인정보보호법)

라이선스 문의: [contact us](https://nextain.io/contact)

## 구성

| 디렉토리 | 용도 |
|----------|------|
| `.agents/` | AI 최적화 컨텍스트 (영어, JSON/YAML) |
| `.users/` | 사용자용 미러 (한국어, Markdown) |
| `.claude/` | Claude Code 설정, 훅, 스킬 |
| `skills/` | 재사용 가능한 AI 스킬 |
| `scripts/` | 유틸리티 스크립트 (모니터링, 트리아지 등) |
| `templates/` | 문서 템플릿 |
| `docs/` | 아키텍처 문서, 설계 스펙 |
| `packages/` | 런타임 패키지 (향후) |

### 데이터 디렉토리 (gitignore — 포크별 관리)

| 디렉토리 | 범위 | 내용 |
|----------|------|------|
| `data-company/` | 기업 | 사내 문서, 공유 리소스 |
| `data-business/` | 기업 | 민감 비즈니스 데이터 (회계, 계약서) |
| `data-private/` | 개인 | 개인 데이터, 환경설정, 비공개 문서 |
| `projects/` | 개인 | 프로젝트 레포 (서브모듈) |

## 스킬

기본 제공 스킬:

| 스킬 | 설명 |
|------|------|
| `review-pass` | 4단계 멀티 AI 교차 검증 리뷰 |
| `verify-implementation` | 모든 검증 스킬 실행, 통합 보고서 생성 |
| `manage-skills` | 검증 스킬 자동 감지 및 업데이트 |
| `merge-worktree` | 워크트리 스쿼시 머지 |
| `read-doc` | HWP/PDF/DOCX/XLSX/PPTX 텍스트 추출 |
| `webapp-testing` | Playwright E2E 웹 앱 테스트 |
| `doc-coauthoring` | 구조화된 문서 공동 작성 (3단계) |

### 비즈니스 확장 스킬

[Naia Business ADK](#비즈니스-확장)에서 추가 제공:

| 스킬 | 설명 |
|------|------|
| `payroll` | 급여명세서 PDF 생성 + 이메일 발송 |
| `press-release` | 보도자료 작성, 기자 조사, 발송 |
| `patent-draft` | 특허청 전자출원 양식 기반 특허 명세서 작성 |
| `patent-pipeline` | AI 특허 발굴, 평가, 출원 자동화 |
| `copyright-reg` | 저작권 등록 서류 생성 |
| `weekly-report` | git 커밋 기반 주간 업무 보고서 생성 |
| `email` | 이메일 작성 및 발송 |
| `sms` | SMS 알림 발송 |
| `channel-management` | 멀티 채널 커뮤니케이션 관리 |
| `service-management` | 서비스 모니터링 및 관리 |
| `web-monitoring` | 웹 콘텐츠 모니터링 및 알림 |
| `document-generation` | 자동 문서 생성 |

## 아키텍처

Naia ADK는 **Base + Extension** 모델을 따릅니다:

```
┌─────────────────────────────────────────┐
│  naia-adk (Base)                        │
│  ┌─────────────────────────────────────┐│
│  │  .agents/  .users/  .claude/        ││
│  │  skills/   scripts/  templates/     ││
│  │  docs/     packages/               ││
│  └─────────────────────────────────────┘│
│  + data-company/  (포크: 기업)          │
│  + data-business/ (포크: 기업)          │
│  + data-private/  (포크: 개인)          │
│  + projects/      (포크: 개인)          │
└─────────────────────────────────────────┘
         │ MCP / WebSocket
         ▼
┌─────────────────────────────────────────┐
│  Naia OS (데스크톱 앱)                   │
│  Tauri 2 + React + Node.js Agent        │
└─────────────────────────────────────────┘
```

자세한 내용: [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)

## 시작하기

### 개인용

1. **Private fork** — GitHub에서 `naia-adk`를 포크 (비공개로 변경)
2. **클론** — `git clone https://github.com/YOUR-USER/your-adk.git && cd your-adk`
3. **upstream 추가** — `git remote add upstream https://github.com/nextain/naia-adk.git`
4. **데이터 디렉토리 생성** — `mkdir data-private projects`
5. **작업 시작** — 프로젝트 추가, `.agents/` 설정, 스킬 사용
6. **upstream 동기화** — 주기적: `git fetch upstream && git merge upstream/main`

### 기업용

1. **비즈니스 팩 문의** — [contact us](https://nextain.io/contact)에서 `naia-business-adk` 접근 권한 획득
2. **Private fork** — `naia-business-adk`를 조직에 비공개 포크
3. **클론** — `git clone https://github.com/YOUR-ORG/your-org-adk.git && cd your-org-adk`
4. **upstream 추가** — `git remote add upstream https://github.com/nextain/naia-business-adk.git`
5. **회사 데이터 추가** — `mkdir data-company data-business projects`
6. **서브모듈 추가** — `git submodule add <repo> projects/<name>`
7. **팀 온보딩** — 각 멤버가 조직 ADK를 포크하여 개인 워크스페이스 구성
8. **upstream 동기화** — 주기적: `git fetch upstream && git merge upstream/main`

### Naia OS 연동 (선택)

[Naia OS](https://github.com/nextain/naia-os)를 사용하는 경우, 워크스페이스 경로를 ADK 디렉토리로 설정하세요. 스킬과 데이터가 MCP/WebSocket으로 제공됩니다.

## 보안 등급

| 등급 | 수준 | 예시 |
|------|------|------|
| T1 | 공개 | 오픈소스 코드, 공개 문서 |
| T2 | 기업 | 사내 문서, 공유 리소스 |
| T3 | 기밀 | 회계, 계약서, 개인 데이터 |
| T4 | 비밀 | API 키, 자격증명 (`.env`, 절대 커밋 금지) |

## 개발 프로세스

### 이슈 기반 개발 (기본)

기능 수준 작업을 위한 14단계 워크플로우:

Issue → Understand → Scope → Investigate → Plan → Build → Review → E2E Test → Post-test Review → Sync → Sync Verify → Report → Commit → Close

게이트 (사용자 확인 필요): Understand, Scope, Plan, Sync, Close.

### 간단한 변경

오타, 설정값, 간단한 지시사항 — 전체 단계 없이 경량 사이클.

자세한 내용: [`.agents/workflows/issue-driven-development.yaml`](../.agents/workflows/issue-driven-development.yaml)

## 컨텍스트 구조

AI와 사용자 모두에게 최적화된 이중 디렉토리 아키텍처:

```
.agents/                    # AI 최적화 (영어, 토큰 효율)
├── context/                # 프로젝트 규칙, 작업 인덱스, 요구사항
├── workflows/              # 개발 워크플로우
├── skills/                 # 스킬 정의 (SoT)
├── hooks/                  # AI 세션 훅
├── progress/               # 세션 인계 파일 (gitignore)
└── requirements/           # 제품 요구사항 (REQ-001 ~)

.users/                     # 사용자용 미러 (한국어, 상세)
├── context/                # .agents/ 미러 (Markdown)
├── workflows/              # 워크플로우 문서
└── skills/                 # 스킬 문서
```

## 기여

**모든 언어로 기여할 수 있습니다.** 이슈, PR, 디스커션은 모국어로 작성해도 됩니다 — AI가 번역합니다.

Git 기록(커밋, 컨텍스트, 공유 산출물)은 영어로 작성합니다.

1. **이슈 먼저** — 코딩 전에 GitHub Issue 생성 또는 선택
2. **포크 + 브랜치** — `issue-{N}-{desc}` 브랜치에서 작업
3. **테스트** — PR 전에 테스트 작성 및 확인
4. **하나의 PR** — 코드 + 테스트 + 컨텍스트를 하나의 PR로

10가지 기여 유형: 번역, 스킬, 기능, 버그 리포트, 코드/PR, 문서, 테스트, 디자인/UX, 보안 리포트, 컨텍스트.

## 라이선스

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

## 링크

- **Naia OS** — [github.com/nextain/naia-os](https://github.com/nextain/naia-os)
- **Nextain** — [nextain.io](https://nextain.io)
- **Naia Dashboard** — [naia.nextain.io](https://naia.nextain.io)
