[한국어](README.md) | [English](README.en.md)

# Naia ADK

**AI 코딩 에이전트가 일할 작업 공간을, 미리 정돈해 둔 스캐폴드.**

Claude Code나 Codex 같은 AI 코딩 도구를 쓰다 보면, 도구마다 규칙 파일 위치도 다르고
"이 문서는 공개해도 되는지", "스킬은 어디에 두는지"가 제각각입니다. Naia ADK는 그 뼈대를
미리 깔아 둔 워크스페이스입니다. 새 노트북에 개발 환경을 세팅하듯, AI 에이전트에게도 정돈된
책상을 먼저 내주는 셈입니다. 여기에 워크스페이스 상태를 눈으로 확인할 수 있는 대시보드가 함께
들어 있습니다.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

## 5분 만에 띄워보기

**Node 22 이상, pnpm 9 이상**이 필요합니다.

```bash
pnpm install    # 워크스페이스 의존성 설치
pnpm dev        # API 서버(:3141) + 대시보드(:3142) 동시 실행
```

브라우저에서 `http://localhost:3142`를 열면 대시보드가 뜹니다. 여기서 세 가지를 바로 볼 수 있습니다.

- **워크스페이스** — 프로젝트와 서브모듈, 파일 트리, 그리고 각 항목의 공개 등급.
- **스킬 카탈로그** — 이 워크스페이스에 등록된 스킬 목록과 내용.
- **설정 / 모니터링** — 서버 설정, 클라이언트 상태, 데이터 디렉터리.

대시보드는 `/api/*` 요청을 3141 포트의 API 서버로 넘겨줍니다. 서버만, 또는 대시보드만
띄우고 싶다면 각각 `pnpm dev:server`(→ 3141), `pnpm dev:dashboard`(→ 3142)를 쓰면 됩니다.
런처 스크립트 `./start.sh`(Linux/macOS)와 `start.bat`(Windows)도 결국 `pnpm dev`를 실행합니다.
서버 CLI는 `--port`, `--host`, `--root` 옵션을 받습니다. 예를 들어 다른 워크스페이스를
가리키려면 `pnpm serve -- --root /path/to/workspace`처럼 씁니다.

## 무엇이 들어있나

### 워크스페이스 스캐폴드

AI 에이전트가 곧바로 일할 수 있도록, 자리가 정해진 디렉터리 묶음을 제공합니다. AI가 읽을
컨텍스트는 `.agents/`(영어, JSON/YAML)에 두고, 사람이 읽을 미러는 `.users/`(한국어, Markdown)에
둡니다. 이 미러는 전체를 그대로 복제한 것이 아니라 사람이 읽어야 할 핵심 문서 위주로 두는
부분 미러입니다(예컨대 스킬은 `.agents/skills/` 쪽이 원본이고 `.users/skills/`에는 일부만
있습니다). 스킬, 데이터, 프로젝트는 모두 정해진 위치가 있어서, 어떤 도구로 열어도 같은
모양으로 보입니다.

### 대시보드와 API

워크스페이스를 눈으로 관리하는 Next.js 대시보드와, 그 뒤를 받치는 Fastify API 서버가
포함됩니다. API는 워크스페이스 메타데이터(`/api/workspace`), 스킬 카탈로그(`/api/skills`),
파일 읽기·쓰기(`/api/files`), 그리고 파일 변경을 실시간으로 알리는 WebSocket(`/api/ws`)을
제공합니다. 이 API 덕분에 대시보드뿐 아니라 다른 프로그램도 워크스페이스에 접근할 수 있습니다.

### 스킬 시스템

반복 작업을 스킬로 묶어 재사용합니다. 각 스킬은 `SKILL.md` 한 파일로 정의되고, API 서버가
`skills/` 아래를 훑어 카탈로그로 만듭니다. 이때 스킬 하나라도 규격을 어기면 카탈로그 전체가
에러를 내도록 설계했습니다(fail-closed). 깨진 스킬을 조용히 빼고 나머지만 내보내는 대신,
운영자가 그 자리에서 고치도록 만든 것입니다. 잘못된 목록을 모르고 서비스하는 사고를 막기 위한
선택입니다.

### 규칙 묶음과 최소 거버넌스

혼자 쓰는 워크스페이스라도, AI와 자동화가 손을 대는 순간 최소한의 규칙이 필요합니다. Naia
ADK는 `read`, `write`, `execute`, `publish`를 서로 다른 관심사로 나눠 두고, 문서마다 공개
등급을 붙입니다. 프로덕션 변경이나 시크릿 취급, 대외 공개처럼 되돌리기 어려운 작업은 일반
로컬 편집과 분리해 승인 게이트를 거치게 합니다.

공개 등급은 네 단계입니다. `public`은 공개 웹사이트나 오픈소스 레포에 그대로 나가도 되는
것, `controlled`은 검토를 거치면 외부에 공유할 수 있는 것, `internal`은 워크스페이스 안에서만
쓰는 것, `confidential`은 계약서·크리덴셜·개인정보처럼 민감한 것입니다. 크리덴셜은 보통 git
밖에 두지만, 등급으로는 여전히 `confidential`입니다.

### LLM 어댑터 (naia-anyllm)

LLM에 연결해야 하는 기능을 위해 `naia-anyllm` 어댑터를 내장합니다. [any-llm](https://github.com/nextain/any-llm)
게이트웨이를 거치거나, OpenAI·Anthropic·Google 같은 프로바이더에 직접 붙습니다. 기본값은
Naia 계정이며, [naia.nextain.io](https://naia.nextain.io)에서 발급한 키를
`NAIA_KEY` 환경 변수에 넣으면 계정 크레딧으로 바로 사용할 수 있습니다. 키가 없으면
유료 호출 전에 오류를 냅니다. 프로바이더나 모델을 바꾸고 싶으면
[`.agents/context/llm-config.yaml.example`](.agents/context/llm-config.yaml.example)을 복사해 쓰고,
API 키는 설정 파일이 아니라 환경 변수나 운영체제 키 저장소에 둡니다. `naia-settings/llm.json`에는
키 값 대신 `apiKeyRef: "NAIA_KEY"`만 기록합니다. 개인 포크에서 장기 백업이 필요하면
`data-private/key/`의 age 암호화 볼트를 사용합니다([`.env.example`](.env.example) 참고).

지원 모델과 현재 가격 조회, 긴 PDF 번역은 `translate-doc` 스킬을 사용합니다. 모델·가격 조회는
키 없이 가능하고, 번역은 예상 비용을 먼저 제시한 뒤 중단 지점부터 재개할 수 있습니다.

## 왜 이렇게 만들었나

### 포맷이 곧 계약

Naia ADK의 핵심은 특정 도구가 아니라 **포맷**입니다. 디렉터리 레이아웃(`.agents/`, `.users/`,
`skills/`, `data-*/`)과 파일 스키마(`agents-rules.json`, `SKILL.md`)가 정해진 약속이고, 이
약속을 읽을 수 있는 도구라면 무엇이든 같은 워크스페이스를 소비할 수 있습니다. Claude Code,
opencode, Codex, naia-agent가 서로의 코드를 내장하지 않고도 같은 워크스페이스를 각자 읽습니다.
그래서 도구를 바꾸거나 여러 도구를 섞어 써도, 워크스페이스는 그대로 동작합니다.

이 규칙 강제(enforcement) 자체도 도구에 매이지 않습니다. 호스트 중립 코어(`.agents/hooks/core/`)와
정책(`.agents/hooks/policies/`)이 Claude Code 훅과 pi 익스텐션 양쪽을 같은 규칙으로 구동합니다.

### 팀으로 커지기 전의 개인용 베이스

Naia ADK는 어디까지나 1인, 개인용입니다. 회사 조직도나 테넌트 규칙, 위임 승인 체인 같은
것은 상위 레이어의 몫입니다. 대신 워크스페이스가 팀이나 회사 규모로 커지기 전에, 컨텍스트를
어떻게 다룰지에 대한 규율을 미리 한곳에 적어 둘 자리를 줍니다.

팀 협업과 공유 지식이 필요해지면 [Naia Business ADK](https://nextain.io/adk)로 확장합니다.
이 확장은 베이스라인을 자산·프로세스·권한 거버넌스로 넓히고, 팀 소유권과 위임 승인을 더합니다.

### 포크 체인

Naia ADK는 포크해서 자기 것으로 만드는 것을 전제로 합니다. 개인은 `naia-adk`를 직접 포크하고,
조직은 `naia-business-adk`를 거쳐 회사·멤버 워크스페이스를 만듭니다.

```
naia-adk                  ← 개인용 베이스 (공개, Apache 2.0)
  └── {org}-adk           ← 조직 포크: 회사 데이터 + 비즈니스 서브모듈
        └── {user}-adk    ← 개인 포크: 개인 데이터 + 프로젝트 서브모듈
```

Nextain의 실제 체인은 `naia-adk → naia-business-adk → nextain-adk → alpha-adk`처럼 이어집니다.

## 구조

저장소는 크게 런타임 코드(`packages/`), 규칙과 컨텍스트(`.agents/`, `.users/`), 스킬(`skills/`,
`.agents/skills/`), 그리고 포크마다 채워 넣는 데이터 디렉터리로 나뉩니다.

| 디렉터리 | 용도 |
|-----------|---------|
| `.agents/` | AI용 컨텍스트 (영어, JSON/YAML) — 규칙의 단일 진실 공급원 |
| `.users/` | 사람이 읽는 미러 (한국어, Markdown) |
| `.claude/` | Claude Code 설정, 훅, 스킬 심링크 |
| `skills/` | 운영/런타임 스킬 (대시보드 API가 제공) |
| `scripts/` | 유틸리티 스크립트 |
| `templates/` | 문서 템플릿 |
| `docs/` | 아키텍처 문서, 설계 스펙 |
| `packages/` | 런타임 패키지 (pnpm 워크스페이스) |

### 런타임 패키지 (packages/, 10개)

세 개는 실제로 도는 프로그램이고, 나머지는 포맷과 규격을 정의하는 얇은 패키지입니다.

- `core` — 워크스페이스와 스킬을 파싱하는 엔진.
- `server` — Fastify 기반 REST/WebSocket API.
- `dashboard` — Next.js 대시보드 UI.
- `skill-spec` — 도구 비종속 스킬 포맷 계약(`SkillDescriptor`, `SkillLoader`).
- `skills-builtin` — 일반 스킬 카탈로그.
- `openclaw-compat` — OpenClaw 스킬을 naia 포맷으로 옮기는 마이그레이션 도구.
- `persona` — 시스템 프롬프트 컨벤션 스펙.
- `process` — 워크플로우 패턴 스펙(리뷰 → 결정 → 실행, 이슈 기반 개발 등).
- `naia-anyllm` — any-llm 게이트웨이 / 직접 프로바이더 LLM 어댑터.
- `artifacts-spec` — 권한(RBAC)과 개발 수명주기(SDLC) 산출물의 표준 스키마. 15종 산출물을
  JSON Schema로 정의하고, 각 산출물이 git으로 추적되는지 세션 한정인지까지 규정합니다.

### 데이터 디렉터리 (gitignore, 포크마다 채움)

이 네 디렉터리는 저장소에 올라가지 않습니다. 포크한 사람이 자기 데이터를 넣습니다.

| 디렉터리 | 범위 | 내용 |
|-----------|-------|---------|
| `data-company/` | 회사 | 회사 전체 문서, 공유 리소스 |
| `data-teams/` | 팀 | 팀별 문서 (전략, 회계 등) |
| `data-private/` | 개인 | 개인 데이터, env 파일, 비공개 문서 |
| `projects/` | 개인 | 프로젝트 레포 (서브모듈) |

### 스킬 트리 두 개

스킬은 두 곳에 나뉘어 있고, 소비하는 주체가 다릅니다.

- `.agents/skills/` — AI 보조와 워크플로우 스킬. Claude Code가 `.claude/skills/` 심링크를
  통해 사용합니다. 리뷰(`review-pass`), 검증(`verify-implementation`), 워크트리 머지
  (`merge-worktree`), 문서 추출(`read-doc`), 특허·저작권·급여 같은 업무 스킬, 그리고
  `finetune-persona`, `secret-vault`, `youtube-upload` 등이 들어 있습니다.
- `skills/` — 운영/런타임 스킬. API 서버가 `skills/**/SKILL.md`를 훑어 대시보드에 제공합니다.
  이메일·SMS·알림 발송, 채널 관리, 서비스·웹 모니터링, 문서 생성 같은 것들이 있고,
  `skills/business/`에는 조직용 스킬(예: `press-release`)이 담깁니다.

전체 목록은 대시보드의 스킬 카탈로그에서 확인하는 것이 가장 정확합니다. 텍스트로 정리된 표는
[AGENTS.md](AGENTS.md#스킬-skills)에 있습니다.

## 시작하기

### 개인용

1. `naia-adk`를 본인 계정으로 포크합니다(가능하면 비공개로).
2. 클론합니다: `git clone https://github.com/YOUR-USER/your-adk.git && cd your-adk`
3. upstream을 추가합니다: `git remote add upstream https://github.com/nextain/naia-adk.git`
4. 데이터 디렉터리를 만듭니다: `mkdir -p data-private projects`
5. 프로젝트를 추가하고 `.agents/`를 설정한 뒤 작업을 시작합니다.
6. Naia 계정 자원을 쓸 경우 `NAIA_KEY`를 환경 변수로 설정합니다.
7. 주기적으로 동기화합니다: `git fetch upstream && git merge upstream/main`

### 기업용

1. `naia-business-adk` 접근을 위해 [문의](https://nextain.io/contact)합니다.
2. `naia-business-adk`를 조직 계정으로 비공개 포크한 뒤 클론합니다.
3. upstream을 추가합니다: `git remote add upstream https://github.com/nextain/naia-business-adk.git`
4. 회사 데이터와 프로젝트 서브모듈을 채웁니다: `mkdir -p data-company projects`,
   `git submodule add <repo> projects/<name>`
5. 각 멤버는 조직 ADK를 다시 포크해 개인 워크스페이스로 씁니다.

### Naia OS 연동 (선택)

[Naia OS](https://github.com/nextain/naia-os) 데스크톱 앱을 쓴다면 워크스페이스 경로를 본인의
ADK 디렉터리로 지정하세요. 스킬과 데이터가 API로 제공됩니다.

## 기여

이슈, PR, 토론은 편한 언어로 써도 됩니다. AI가 소통을 중개합니다. 다만 git 기록(커밋, 컨텍스트,
공유 산출물)은 영어로 남깁니다. 자세한 절차와 규칙은 [CONTRIBUTING.md](CONTRIBUTING.md)를
참고하세요. 개발 프로세스는 이슈 기반 개발을 기본으로 하며, 상세 흐름은 [AGENTS.md](AGENTS.md)와
[`.agents/workflows/`](.agents/workflows/)에 정리돼 있습니다.

## 로드맵

아래는 아직 구현되지 않은 계획으로, 현재 동작하는 기능이 아닙니다.

- **지식 원자(Knowledge atoms)** — 지금의 컨텍스트는 파일 단위라, 정보 한 조각을 찾으려 해도
  파일 전체를 로드해 토큰을 낭비합니다. 이를 의미를 가진 가장 작은 지식 단위로 쪼개고 태그와
  링크로 연결해, 필요한 조각만 정확히 꺼내 쓰는 방향을 검토 중입니다. CLI나 MCP로 접근해 도구에
  매이지 않게 하는 것이 목표입니다.

## 라이선스

Apache License 2.0. 자세한 내용은 [LICENSE](LICENSE)를 참고하세요.

```
Copyright 2026 Nextain Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0
```

## 링크

- **Naia OS** — [github.com/nextain/naia-os](https://github.com/nextain/naia-os)
- **Nextain** — [nextain.io](https://nextain.io)
- **Naia Dashboard** — [naia.nextain.io](https://naia.nextain.io)
