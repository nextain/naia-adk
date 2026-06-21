[English](../README.md) | 한국어

# Naia ADK

**AI 협업 작업을 위한 워크스페이스 스캐폴드 + 거버넌스 베이스라인.**

AI 코딩 도구(opencode, Claude Code, Codex, Naia OS)를 위한 구조화된 워크스페이스 스캐폴드와, 그것을 관리하는 내장 대시보드를 제공하는 오픈소스 프레임워크입니다.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](../LICENSE)

## Naia ADK란?

Naia ADK는 **워크스페이스 스캐폴드**입니다 — AI 코딩 에이전트가 작업 환경으로 사용하는, 사전 구성된 디렉터리 구조·스킬·컨텍스트 파일·데이터 계층의 묶음입니다. 또한 워크스페이스 자체를 모니터링하고 설정하는 **대시보드**를 포함합니다.

동시에 1인 AI 협업을 위한 **최소 거버넌스 베이스라인**이기도 합니다:

- `read`, `write`, `execute`, `publish`를 서로 다른 관심사로 분리합니다.
- AI 도구에 공개 등급과 승인 게이트 액션을 위한 공통 어휘를 제공합니다.
- 워크스페이스가 팀이나 회사 규모로 커지기 전에 컨텍스트 규율을 명문화할 공통 장소를 제공합니다.

```
naia-adk = Workspace Scaffold + Dashboard

┌─────────────────────────────────────────────┐
│  naia-adk                                    │
│                                              │
│  Scaffold (워크스페이스 스캐폴드)             │
│  ├── .agents/    skills/  scripts/           │
│  ├── data-company/  data-teams/              │
│  ├── data-private/  projects/                │
│  └── context files (agents-rules.json, etc.) │
│                                              │
│  Dashboard (대시보드)                         │
│  ├── Workspace viewer                        │
│  ├── Skills catalog                          │
│  └── Settings & monitoring                   │
│                                              │
└──────────┬───────────────────────────────────┘
           │
     ┌─────┼─────┬──────────┐
     ▼     ▼     ▼          ▼
 opencode  Claude  Codex   Naia OS
           Code            (Desktop)
```

**워크플로우 클라이언트**(opencode, Claude Code, Codex, Naia OS)는 naia-adk를 워크스페이스로 사용합니다. 대시보드는 워크스페이스를 *관리*하기 위한 것이지, 작업을 수행하기 위한 것이 아닙니다.

### 의존이 아닌 인터페이스

naia-adk는 **도구 비종속(tool-agnostic) 워크스페이스 포맷**입니다. 특정 AI 도구에 의존하지 않으며, AI 도구도 naia-adk의 런타임에 의존할 필요가 없습니다:

- **포맷이 곧 계약** — 디렉터리 레이아웃(`.agents/`, `.users/`, `skills/`, `data-*/`), 파일 스키마(`agents-rules.json`, SKILL.md), 그리고 컨벤션. 이것들을 읽을 수 있는 AI 코딩 도구라면 무엇이든 naia-adk 워크스페이스를 소비할 수 있습니다.
- **런타임 결합 없음** — Claude Code, OpenCode, Codex, naia-agent 모두 동일한 포맷을 각자 독립적으로 읽습니다. 어느 것도 naia-adk의 코드를 내장하지 않습니다.
- **자유로운 교체** — 도구를 바꾸거나, 새 조직을 위해 워크스페이스를 포크하거나, 같은 프로젝트 안에서 여러 도구를 섞어 써도 워크스페이스는 그대로 동작합니다.

이는 더 넓은 Naia 생태계 철학의 일부입니다: 레포는 런타임 의존이 아니라 **공개된 인터페이스와 포맷**으로 연결됩니다. 전체 그림은 [naia-agent README](https://github.com/nextain/naia-agent)를 참고하세요.

**플러그인 적응형(Plugin-adaptive)**: 스캐폴드는 꽂는 것에 맞춰 적응합니다. 스킬, 데이터 디렉터리, 프로젝트 서브모듈, AI 도구 연결이 모두 플러그형입니다 — 필요한 것은 추가하고, 필요 없는 것은 무시하세요.

```
Plugin-Adaptive Structure

naia-adk (core scaffold)
│
├── Plugins (plug in what you need)
│   ├── Skills/              ← Skill plugins (SKILL.md)
│   ├── Data submodules      ← data-company/, data-teams/
│   ├── Project submodules   ← projects/your-project
│   ├── AI tool configs      ← .claude/, .agents/
│   └── Custom workflows     ← .agents/workflows/
│
├── Adapters (adapt to your environment)
│   ├── AI tool adapter      ← opencode / Claude Code / Codex / Naia OS
│   ├── Data source adapter  ← local filesystem / cloud / git
│   └── Language adapter     ← .users/ mirror in any language
│
└── Ports (connect from anywhere)
    ├── REST API             ← Any HTTP client
    ├── WebSocket            ← Real-time events
    ├── Direct filesystem    ← CLI tools
    └── Tauri IPC            ← Naia OS native
```

### 최소 거버넌스 베이스라인

1인 워크스페이스라도 AI와 자동화가 개입되는 순간 거버넌스가 필요합니다.

- **공개 등급(Disclosure levels)** — `public`, `controlled`, `internal`, `confidential`
- **액션 어휘** — `read`, `write`, `execute`, `publish`, `approve`, `administer`
- **승인 게이트 액션** — 프로덕션 변경, 시크릿 취급, 대외 공개 주장은 일반 로컬 편집과 분리됩니다
- **컨텍스트 규율** — 세션 로컬 컨텍스트는 의도 없이 영속/공유 컨텍스트로 승격되어서는 안 됩니다

`naia-adk`는 개인용 베이스입니다. 회사별 조직도, 테넌트 규칙, 승인 체인은 상위 레이어에 속합니다.

### 포크 체인

```
naia-adk                  ← Personal base (public, Apache 2.0)
  ├─ naia-business-adk   ← Business upstream (private)
  │    └── {org}-adk     ← Company instance: org data + projects + policy
  │          └── {user}-adk  ← Company-linked personal instance
  └── {user}-adk         ← Direct personal instance
```

예시 — Nextain의 체인:

```
naia-adk → naia-business-adk → nextain-adk → alpha-adk
```

어느 레이어에서든 포크할 수 있습니다. 개인은 `naia-adk`를 직접 포크할 수 있습니다. 조직은 `naia-business-adk`를 거친 뒤, 거기서 회사 및 멤버 워크스페이스를 인스턴스화합니다.

### 비즈니스 확장

**[Naia Business ADK](https://nextain.io/adk)** — `naia-adk`의 조직용 확장:

- 베이스라인을 **자산 / 프로세스 / 권한** 거버넌스로 확장
- 팀 소유권, 위임 승인, 비즈니스 워크플로우 기대치 추가
- 조직용 스킬과 템플릿을 포함할 수 있으나, 이는 제품 정의가 아니라 거버넌스 레이어의 산출물입니다
- 비공개 회사 인스턴스 및 멤버 인스턴스 지원

라이선스 문의는 [Contact us](https://nextain.io/contact).

## 구성

| 디렉터리 | 용도 |
|-----------|---------|
| `.agents/` | AI 최적화 컨텍스트 (영어, JSON/YAML) |
| `.users/` | 사람이 읽는 미러 (한국어, Markdown) |
| `.claude/` | Claude Code 설정, 훅, 스킬 |
| `skills/` | 재사용 가능한 AI 스킬 (review, email, SMS, docs 등) |
| `scripts/` | 유틸리티 스크립트 (모니터링, 트리아지 등) |
| `templates/` | 문서 템플릿 |
| `docs/` | 아키텍처 문서, 설계 스펙 |
| `packages/` | 런타임 패키지 (pnpm workspace — 9개 활성) |

**`packages/` (9개 활성):** `core` (워크스페이스/스킬 파싱 엔진) · `server` (Fastify REST/WS API) · `dashboard` (Next.js UI) · `skill-spec` (도구 비종속 스킬 포맷 계약) · `skills-builtin` (일반 스킬 카탈로그) · `openclaw-compat` (OpenClaw → naia 스킬 마이그레이션) · `persona` (시스템 프롬프트 컨벤션 스펙) · `process` (워크플로우 패턴 스펙) · `naia-anyllm` (any-llm 게이트웨이 / 직접 프로바이더 LLM 어댑터).

### 데이터 디렉터리 (gitignore — 포크별 관리)

| 디렉터리 | 범위 | 내용 |
|-----------|-------|---------|
| `data-company/` | 회사 | 회사 전체 문서, 공유 리소스 |
| `data-teams/` | 팀 | 팀별 문서 (전략, 회계) |
| `data-private/` | 개인 | 개인 데이터, env 파일, 비공개 문서 |
| `projects/` | 개인 | 프로젝트 레포 (서브모듈) |

## 스킬

naia-adk에는 **두 개의 스킬 트리**가 있습니다(전체 목록은 [AGENTS.md](../AGENTS.md#skills) 참고):

- **`.agents/skills/`** — AI 보조 / 워크플로우 스킬. `.claude/skills/` 심링크를 통해 Claude Code가 사용. `.agents/context/skills-index.yaml`이 색인.
- **`skills/`** — 운영 / 런타임 스킬. 대시보드 API(`discoverSkills()`가 `skills/**/SKILL.md` 스캔)가 발견해 `/api/skills`로 제공.

워크플로우 스킬 (`.agents/skills/`):

| 스킬 | 설명 |
|-------|-------------|
| `review-pass` | 멀티 에이전트 상호검증 리뷰 (4단계) |
| `verify-implementation` | 모든 검증 스킬 실행, 통합 리포트 생성 |
| `verify-contract-conformance` | 선언된 API/인터페이스 계약 vs 구현 검증 |
| `manage-skills` | 검증 스킬 자동 감지·업데이트 |
| `merge-worktree` | 시맨틱 커밋으로 워크트리 브랜치 스쿼시 머지 |
| `read-doc` | HWP/PDF/DOCX/XLSX/PPTX 텍스트 추출 |
| `webapp-testing` | 로컬 웹 앱 Playwright E2E 테스트 |
| `doc-coauthoring` | 구조화 문서 공동작성 (3단계) |
| `project-create` · `project-migration` · `migrate-ctx` | 프로젝트 레포 scaffold / 분리 / 컨텍스트 마이그레이션 |
| `payroll` · `press-release` · `patent-draft` · `patent-pipeline` · `copyright-reg` · `weekly-report` | 문서·비즈니스 워크플로우 스킬 (본 베이스 레포에도 포함) |

운영 스킬 (`skills/`):

| 스킬 | 설명 |
|-------|-------------|
| `email` | SMTP 어댑터 기반 이메일 발송 (템플릿 지원) |
| `sms` | 게이트웨이 어댑터 기반 SMS / 알림톡 발송 |
| `notify` | 채널 비종속 알림 발송 |
| `channel-management` | Discord/Slack 채널 관리 |
| `service-management` | 서비스 모니터링, 비용 추적, 장애 대응 |
| `web-monitoring` | SEO·가동시간·애널리틱스 모니터링 |
| `document-generation` | 브랜드 PDF 생성 (계약서, 결의서, 급여명세서) |
| `config` · `cron` · `diagnostics` · `system-status` · `sessions` · `memo` · `skill-manager` · `time` · `weather` | 런타임 유틸리티 |

> **참고:** 조직 레이어([Naia Business ADK](#비즈니스-확장))는 팀 소유권·위임 승인·조직 전용 스킬로 위 스킬들을 확장합니다.

## 아키텍처

Naia ADK는 **자체 API를 가진 워크스페이스 스캐폴드**입니다 — 설계상 도구 비종속:

```
naia-adk
├── Scaffold (workspace structure)
│   ├── .agents/  .users/  .claude/  skills/  scripts/
│   ├── data-company/  data-teams/  data-private/
│   └── projects/
│
├── API Server (Fastify)
│   ├── /api/workspace   ← Workspace metadata, file tree, classification
│   ├── /api/skills      ← Skill catalog and content
│   ├── /api/files       ← File read/write
│   └── /api/ws          ← WebSocket (file change events)
│
└── Dashboard (Next.js)
    ├── /                ← Overview
    ├── /workspace       ← Projects, submodules, visibility
    ├── /skills          ← Skill catalog viewer
    └── /settings        ← Server config, client status, data dirs
```

어떤 AI 도구든 연결할 수 있습니다 — Claude Code, Codex, Naia OS에 한정되지 않습니다:

| 클라이언트 | 연결 방식 | 역할 |
|--------|-----------|------|
| opencode | 직접 파일시스템 | TUI 코딩 에이전트 |
| Claude Code | 직접 파일시스템 + 훅 | CLI 코딩 에이전트 |
| pi | 직접 파일시스템 + 익스텐션 | CLI 코딩 에이전트 |
| Codex | REST API | CLI 코딩 에이전트 |
| Naia OS | REST API + WebSocket | 데스크톱 앱 |
| 브라우저 | 대시보드 | 모니터링 & 설정 |

엔포스먼트 하네스는 **도구 비종속**입니다: 호스트 중립 코어(`.agents/hooks/core/`) + 정책(`.agents/hooks/policies/`)이 Claude Code 훅(`.claude/hooks/`)과 pi 익스텐션(`.pi/extensions/naia-harness.ts`) 양쪽을 구동합니다 — 동일한 가드가 코어 변경 없이 어느 호스트에서나 실행됩니다.

### LLM 연결

naia-adk는 **naia-anyllm**을 포함합니다 — [any-llm](https://github.com/nextain/any-llm) 게이트웨이 또는 LLM 프로바이더에 직접 연결하는 내장 LLM 어댑터입니다:

```
naia-adk
└── packages/
    └── naia-anyllm/        ← LLM adapter (plugin)
        ├── Any-LLM Gateway ← nextain/any-llm (credits, auth, routing)
        ├── Direct providers ← OpenAI, Anthropic, Google, etc.
        └── Config           ← .agents/context/llm-config.yaml (선택)
```

설정은 **선택 사항**입니다 — `naia-anyllm`은 기본값(any-llm 게이트웨이 + OpenAI / Anthropic / Google 직접 프로바이더)을 내장합니다. 재정의하려면 [`.agents/context/llm-config.yaml.example`](../.agents/context/llm-config.yaml.example)을 `.agents/context/llm-config.yaml`로 복사하세요. API 키는 설정 파일이 아니라 환경 변수에 둡니다([`.env.example`](../.env.example) 참고).

CLI 도구(opencode, Claude Code, Codex)는 자체 LLM 연결을 사용합니다. naia-os는 naia-anyllm을 통해 any-llm 게이트웨이에 연결합니다.

자세한 내용은 [docs/ARCHITECTURE.md](ARCHITECTURE.md)를 참고하세요.

## 시작하기

### 대시보드 & API 실행

**Node ≥ 22**, **pnpm ≥ 9** 필요.

```bash
pnpm install          # 워크스페이스 의존성 설치
pnpm dev              # API(:3141) + 대시보드(:3142) 동시 실행
# 또는 개별 실행:
pnpm dev:server       # API 만   → http://localhost:3141
pnpm dev:dashboard    # 대시보드 → http://localhost:3142
```

런처도 제공됩니다: `./start.sh`(Linux/macOS), `start.bat`(Windows) — 둘 다 `pnpm dev` 실행. 서버 CLI는 `--port`, `--host`, `--root` 옵션을 받습니다.

| 서비스 | 기본 URL | 소스 |
|--------|----------|------|
| API 서버 (Fastify) | `http://localhost:3141` | `packages/server` |
| 대시보드 (Next.js) | `http://localhost:3142` | `packages/dashboard` |

대시보드는 `/api/*`를 3141 포트의 API 서버로 프록시합니다.

### 개인용

1. **비공개 포크** — `naia-adk`를 본인 계정으로 포크 (가능하면 "Public fork" 체크 해제, 또는 포크 후 Settings에서 private으로 변경)
2. **클론** — `git clone https://github.com/YOUR-USER/your-adk.git && cd your-adk`
3. **upstream 추가** — `git remote add upstream https://github.com/nextain/naia-adk.git`
4. **데이터 디렉터리 생성** — `mkdir -p data-private projects`
5. **작업 시작** — 프로젝트 추가, `.agents/` 설정, 스킬 사용
6. **upstream 동기화** — 주기적으로: `git fetch upstream && git merge upstream/main`

### 기업용

1. **Naia Business ADK 발급** — `naia-business-adk` 접근을 위해 [Contact us](https://nextain.io/contact)
2. **비공개 포크** — `naia-business-adk`를 조직 계정으로 private 포크
3. **클론** — `git clone https://github.com/YOUR-ORG/your-org-adk.git && cd your-org-adk`
4. **upstream 추가** — `git remote add upstream https://github.com/nextain/naia-business-adk.git`
5. **회사 데이터 추가** — `mkdir -p data-company data-business projects`
6. **서브모듈 추가** — `git submodule add <repo> projects/<name>`
7. **팀 온보딩** — 각 멤버는 조직 ADK를 포크해 개인 워크스페이스로 사용
8. **upstream 동기화** — 주기적으로: `git fetch upstream && git merge upstream/main`

### Naia OS 연동 (선택)

[Naia OS](https://github.com/nextain/naia-os)를 사용한다면, 워크스페이스 경로를 본인의 ADK 디렉터리로 지정하세요. 스킬과 데이터는 MCP/WebSocket으로 제공됩니다.

## 공개 등급 (Disclosure Levels)

| 등급 | 의미 | 예시 |
|------|---------|---------|
| `public` | 공개 웹사이트, 공개 README, 공개 레포 컨텍스트에 안전 | 오픈소스 코드, 공개 문서 |
| `controlled` | 검토를 거치면 외부 공유 가능하나 기본 완전 공개는 아님 | 승인된 브랜드 자산, 검증된 파트너 자료 |
| `internal` | 회사 또는 워크스페이스 내부 | 공유 문서, 내부 리소스 |
| `confidential` | 민감·고객 귀속·재무·크리덴셜·프로덕션 핵심 | 계약서, 크리덴셜, 개인정보 |

크리덴셜과 시크릿 자료는 보통 git 밖에 두지만, 여전히 `confidential` 공개 등급에 속합니다.

## 개발 프로세스

### 이슈 기반 개발 (기본)

기능 단위 작업을 위한 14단계 워크플로우:

Issue → Understand → Scope → Investigate → Plan → Build → Review → E2E Test → Post-test Review → Sync → Sync Verify → Report → Commit → Close

게이트 (사용자 확인 필요): Understand, Scope, Plan, Sync, Close.

### 간단한 변경

오타, 설정값, 단순 지시 — 전체 단계 흐름 없는 경량 사이클.

자세한 내용은 [`.agents/workflows/issue-driven-development.yaml`](../.agents/workflows/issue-driven-development.yaml) 참고.

## 컨텍스트 구조

AI와 사람 양쪽 소비에 최적화된 이중 디렉터리 아키텍처:

```
.agents/                    # AI-optimized (English, token-efficient)
├── context/                # Project rules, work index, requirements
├── workflows/              # Development workflows
├── skills/                 # Skill definitions (SoT)
├── hooks/                  # AI session hooks
├── progress/               # Session handoff files (gitignored)
└── requirements/           # Product requirements (REQ-001 ~)

.users/                     # Human-readable mirror (Korean, detailed)
├── context/                # .agents/ mirror in Markdown
├── workflows/              # Workflow docs
└── skills/                 # Skill docs
```

## 기여

**어떤 언어든 환영합니다.** 이슈, PR, 토론은 모국어로 작성해도 됩니다 — AI가 소통을 중개합니다.

Git 기록(커밋, 컨텍스트, 공유 산출물)은 영어로 남깁니다.

1. **이슈 먼저** — 코딩 전에 GitHub 이슈를 생성하거나 선택
2. **포크 + 브랜치** — `issue-{N}-{desc}` 브랜치에서 작업
3. **테스트** — 테스트 작성, PR 전 검증
4. **단일 PR** — 코드 + 테스트 + 컨텍스트를 하나의 PR로

10가지 기여 유형: 번역(Translation), 스킬(Skill), 기능(Feature), 버그 리포트(Bug Report), 코드/PR(Code/PR), 문서(Documentation), 테스트(Testing), 디자인/UX(Design/UX), 보안 리포트(Security Report), 컨텍스트(Context).

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
