Reading additional input from stdin...
OpenAI Codex v0.130.0
--------
workdir: /var/home/luke/alpha-adk
model: gpt-5.4
provider: openai
approval: never
sandbox: workspace-write [workdir, /tmp, /var/home/luke/.codex/memories]
reasoning effort: medium
reasoning summaries: none
session id: 019e3119-a46b-7a81-9a98-0f05b891b62d
--------
user
# 크로스 리뷰 요청 — Agent Service Builder 아키텍처 설계 (DRAFT v1)

당신은 nextain Naia 4-repo 생태계의 아키텍처 리뷰어입니다. 아래 설계 문서를
**판정**하세요. 칭찬·요약 금지. 결함·모순·누락만. 한국어로.

## 검토 대상 (반드시 읽을 것)
- 설계: `/var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md`

## baseline (수정 불가 — 위배 시 critical)
- 4-repo Part A: `/var/home/luke/alpha-adk/.agents/progress/naia-4repo-migration-plan.md` (특히 §A.1~A.13. F07 = Part A 수정 금지)
- naia-agent 매트릭스: `/var/home/luke/alpha-adk/projects/naia-agent/.agents/progress/ref-adoption-matrix.md` (특히 B19 LangChain core 거부 / B20 LangGraph StateGraph reducer 거부 / D44 Vercel AI SDK / R5 LOCKED)
- naia-agent F-rules: `/var/home/luke/alpha-adk/projects/naia-agent/.agents/context/agents-rules.json` (F01 스켈레톤 게이트 / F06 D1~D8 / F07 Part A / F08 OPEN P0)
- #31 진입점: `/var/home/luke/alpha-adk/projects/naia-agent/.agents/progress/issue-draft-agent-eval-framework.md`

## 공격 포인트 (각각 PASS/FAIL + 근거)
1. **Part A.3 불변식** — 설계의 RAGProvider/OrchestrationPolicy/service-manifest 신규 계약이 zero-runtime-dep + interface-not-dependency + 계약↔구현 의존방향(A.3)을 깨지 않는가? naia-agent 가 alpha-memory/naia-adk 를 import 하게 되는 경로가 숨어있지 않은가?
2. **매트릭스 B19/B20 정면충돌** — §3 LangGraph 해소안 A(자체 OrchestrationPolicy + 경량 stream-first DAG executor)가 *정말* B20(StateGraph reducer ↔ D1 stream-first 충돌)을 회피하는가, 아니면 이름만 바꾼 동일 위배인가? §D 신규로 정당화 가능한가?
3. **레포 경계 모순** — 축1(런타임 의존)/축2(fork chain) 직교 모델이 자기모순 없는가? service manifest 스키마 SoT=naia-adk vs 런타임 계약 SoT=naia-agent 의 소유권 경계가 A.6 와 충돌하지 않는가? Fork chain 4단계 정정이 A.11(공개계약 canonical)과 정합하는가?
4. **개인/비즈니스 경계** — naia-business-adk "구현만, 계약 미수정"(A.11) 이 RBAC/SDLC/멀티테넌시 governance 를 정말 계약 수정 없이 얹을 수 있는가? 개인 layer 자족성(외부 데모 = 개인 layer 동작) 주장이 현실적인가?
5. **누락** — Part A 에 있어야 하는데 설계가 회피한 원칙/소유권/경계? observability emit 의무(A.5/A.11), ErrorEvent 계약, security/audit 소유(A.6), regression gate(A.11) 가 빌더 layer 에 어떻게 적용되는지 누락 아닌가?
6. **외부 데모 MVP 현실성** — Phase1 SB-1~SB-4 (manifest→RAG+memory+persona+qwen3.6-27b e2e+평가) 가 R5 LOCKED + F01/F08 게이트 상태에서 슬라이스 순서·의존이 실행 가능한가? 비현실적 낙관 없는가?
7. **karpathy 위배** — 설계가 요청 안 된 유연성/추상화를 넣었는가(Simplicity First)? 가정이 불명확한데 침묵한 곳?

## 출력 형식
```
VERDICT: CLEAN | ISSUES_FOUND
[CRITICAL] <항목>: <근거 파일:섹션> — <왜 baseline 위배인지>
[MAJOR] ...
[MINOR] ...
[누락] ...
종합 1문단: 이 설계로 개발 착수해도 되는가 (조건부 가능/불가 + 핵심 1~2개)
```
critical = Part A/매트릭스/F-rule 정면 위배. 그것만 엄격히. Part B/C(구현중 결정 보류)를 "미해결"로 잡지 말 것.

[profile: ARCHITECT/MATRIX — Part A 불변식·B19/B20 매트릭스 정합·F-rule 위배에 집중. 파일 경로는 Read 도구로 직접 읽어라.]
codex
요청은 설계 문서의 결함 판정이며, baseline 불변식과 매트릭스 충돌 여부를 기준으로만 보겠습니다. 먼저 세션 필수 컨텍스트와 검토 대상 문서를 읽고, 그다음 공격 포인트 7개에 맞춰 위배 여부를 교차 대조하겠습니다.
exec
/bin/bash -lc "sed -n '1,220p' .agents/context/agents-rules.json" in /var/home/luke/alpha-adk
 succeeded in 0ms:
{
  "_copyright": "Copyright 2026 Nextain Inc. All rights reserved.",
  "project_identity": {
    "name": "Alpha ADK",
    "nature": "Luke's personal multi-project ADK workspace (fork of nextain-adk)",
    "philosophy": "단일 워크스페이스에서 Naia OS, OnMam, any-llm 등 여러 프로젝트를 관리",
    "org": "nextain",
    "repo": "nextain/alpha-adk"
  },
  "local_projects": {
    "naia-os": {
      "purpose": "Naia OS desktop app (Tauri 2 + React + Three.js + Node.js agent)",
      "repo": "nextain/naia-os",
      "visibility": "public",
      "entry_point": "naia-os/AGENTS.md"
    },
    "issue-desk": {
      "purpose": "IssueDesk — standalone Vite+React panel for naia-os. GitHub issue/PR triage, community assistant, notification triage.",
      "repo": "nextain/issue-desk",
      "visibility": "private",
      "entry_point": "issue-desk/panel.json",
      "notes": "Standalone git repo, not a submodule. Design doc: naia-os/docs/design/issue-desk.ko.md"
    },
    "about.nextain.io": {
      "purpose": "Nextain corporate website (Next.js 14 + next-intl)",
      "repo": "nextain/about.nextain.io",
      "visibility": "public",
      "entry_point": "about.nextain.io/README.md"
    },
    "naia.nextain.io": {
      "purpose": "Naia web app / Lab portal (Next.js + BFF for gateway)",
      "repo": "nextain/naia.nextain.io",
      "visibility": "private",
      "entry_point": "naia.nextain.io/AGENTS.md"
    },
    "aiedu.nextain.io": {
      "purpose": "AI education platform — curriculum-driven AI teacher (Next.js + Monaco + Pyodide + any-llm)",
      "repo": "nextain/aiedu.nextain.io",
      "visibility": "private",
      "entry_point": "aiedu.nextain.io/AGENTS.md",
      "notes": "B2B commercial product. Dual-mirror context. Curriculum as plugin. Depends on any-llm B2B extension."
    },
    "admin.nextain.io": {
      "purpose": "Nextain B2B admin control plane (license key mgmt, token tracking, client mgmt)",
      "repo": "nextain/admin.nextain.io",
      "visibility": "private",
      "entry_point": "admin.nextain.io/AGENTS.md",
      "notes": "Internal tool. Manages aiedu.nextain.io and future B2B products."
    }
  },
  "infrastructure": {
    "onmam_production_db": {
      "host": "34.64.97.164",
      "database": "onmam",
      "guard": "CRITICAL — 운영 DB. SELECT만 자유. INSERT/UPDATE/DELETE/DDL 쓰기 작업 및 쓰기 스크립트 작성은 사용자의 명시적 승인 필수. 승인 없이 실행하거나 스크립트를 작성하면 안 됨. dev 전용 DB(onmam_dev) 사용 권장."
    },
    "gateway": {
      "prod": {
        "url": "https://naia-gateway-181404717065.asia-northeast3.run.app",
        "key_env": "GATEWAY_MASTER_KEY",
        "db": "any_llm_gateway (cafelua-db, Cloud SQL PostgreSQL 15, asia-northeast3-a)"
      },
      "dev": {
        "url": "https://naia-gateway-dev-181404717065.asia-northeast3.run.app",
        "key": "5bwp-Jd07YSMAqY6yrYvjCJ2UPo5Sb72MLgyGWZ0_f8",
        "db": "any_llm_gateway_dev (same cafelua-db instance, separate DB)",
        "min_instances": 0
      },
      "env_rule": ".env.local → dev gateway. .env.production.local → prod gateway. NEVER write prod credentials to .env.local.",
      "guard_hook": ".claude/hooks/prod-gateway-guard.js — blocks prod credentials in .env.local at Edit|Write time",
      "sync_script": "project-any-llm/scripts/sync-prod-to-dev.sh — manual only, requires 'yes' confirmation, OVERWRITES all dev data"
    },
    "ci_runners": {
      "self_hosted": {
        "name": "luke-bazzite",
        "host": "this Bazzite PC (/opt/actions-runner)",
        "scope": "nextain org — private repos only (public repos use free GitHub-hosted runners)",
        "labels": [
          "self-hosted",
          "linux",
          "x64",
          "bazzite"
        ],
        "service": "actions.runner.nextain.luke-bazzite.service",
        "note": "DO NOT attach self-hosted runners to public repos — fork PR security risk",
        "install_note": "/var/home causes SELinux exec block; always install under /opt/"
      },
      "workflow_usage": "runs-on: [self-hosted, linux, x64]"
    },
    "aihub": {
      "purpose": "AI Hub (aihub.or.kr) 한국어 데이터 다운로드 — 음성/이미지/텍스트 등 공개 데이터셋",
      "cli_path": "/var/home/luke/alpha-adk/projects/naia-sing/aihubshell",
      "api_key_env_file": "/var/home/luke/dev/my-envs/aihub.env",
      "api_key_env_var": "AIHUB_API_KEY",
      "data_root": "/var/home/luke/data/aihub/",
      "usage": [
        "list datasets:    bash $CLI -aihubapikey $AIHUB_API_KEY -mode l",
        "list files:       bash $CLI -aihubapikey $AIHUB_API_KEY -mode l -datasetkey {ID}",
        "download dataset: bash $CLI -aihubapikey $AIHUB_API_KEY -mode d -datasetkey {ID} [-filekey {N1,N2}]",
        "package list/dl:  -mode pl / -mode pd -datapckagekey {ID}"
      ],
      "preconditions": "데이터셋별 사전 승인 필요 (https://aihub.or.kr 에서 신청 → 승인 완료 후 다운로드 가능)",
      "owned_datasets": [
        {"key": 123, "name": "한국어 음성 (KsponSpeech)", "path": "/var/home/luke/data/aihub/10.한국어음성/", "size": "약 1,000h (KsponSpeech_01~05 + eval + scripts)"}
      ],
      "tts_relevant_dataset_keys": {
        "542": "다화자 음성합성 데이터 (TTS 가장 직접)",
        "485": "문학작품 낭송·낭독 음성 (스튜디오 품질)",
        "466": "감성 및 발화 스타일별 음성합성",
        "71349": "감성 및 발화스타일 동시 고려 음성합성",
        "463": "방송 콘텐츠 대화체 음성인식 (깨끗한 다화자)",
        "537": "화자 인식용 음성 데이터",
        "109": "자유대화 음성(일반남여)",
        "130": "한국인 대화음성"
      }
    }
  },
  "submodules": {
    "nextain-docs": {
      "purpose": "Company-wide docs (onboarding, meetings, design)",
      "repo": "nextain/nextain-docs",
      "visibility": "private",
      "entry_point": "data-company/nextain-docs/AGENTS.md"
    },
    "nextain-team-strategy": {
      "purpose": "Strategy team documents (proposals, strategy, IR)",
      "repo": "nextain/nextain-team-strategy",
      "visibility": "private",
      "entry_point": "data-teams/nextain-team-strategy/README.md"
    },
    "nextain-team-accounting": {
      "purpose": "Accounting team documents",
      "repo": "nextain/nextain-team-accounting",
      "visibility": "private",
      "entry_point": "data-teams/nextain-team-accounting/README.md"
    },
    "cafelua.com": {
      "purpose": "Cafelua personal website",
      "repo": "luke-n-alpha/cafelua-private",
      "visibility": "private",
      "entry_point": "cafelua.com/AGENTS.md"
    },
    "www.onmam.com": {
      "purpose": "OnMam website — CI+WP church homepage service (PHP 7.4 + CodeIgniter + MySQL 8.0 + Apache)",
      "repo": "nextain/www.onmam.com",
      "visibility": "private",
      "entry_point": "onmam-dev/AGENTS.md",
      "notes": "로컬 클론 없음. Alpha: *.onmampick.org, Staging: *.onmam.net, Prod: *.onmam.com. Remote dev on onmam-dev GCE."
    },
    "onmam-dev": {
      "purpose": "OnMam remote dev environment context — AI agent entrypoint for onmam-dev GCE VM",
      "repo": "onmam-com/onmam-dev",
      "visibility": "private",
      "entry_point": "onmam-dev/AGENTS.md",
      "notes": "Source SoT is on onmam-dev server (/opt/onmam/luke/). Local clone is reference-only."
    },
    "alpha-memory": {
      "purpose": "Alpha memory system",
      "repo": "nextain/alpha-memory",
      "visibility": "private",
      "entry_point": "alpha-memory/AGENTS.md"
    },
    "onmam-adk": {
      "purpose": "OnMam ADK workspace — fork of naia-business-adk with onmam-specific skills (channel-mgmt, service-mgmt, web-monitoring, deploy-alpha/staging)",
      "repo": "onmam-com/onmam-adk",
      "visibility": "private",
      "entry_point": "onmam-adk/AGENTS.md"
    },
    "naia-adk": {
      "purpose": "Naia ADK workspace",
      "repo": "nextain/naia-adk",
      "visibility": "private",
      "entry_point": "naia-adk/AGENTS.md"
    },
    "naia-business-adk": {
      "purpose": "Naia Business ADK workspace",
      "repo": "nextain/naia-business-adk",
      "visibility": "private",
      "entry_point": "naia-business-adk/AGENTS.md"
    },
    "project-any-llm": {
      "purpose": "Any-LLM SDK + FastAPI gateway (LLM proxy, credits, auth, usage tracking)",
      "repo": "nextain/any-llm",
      "visibility": "public",
      "entry_point": "project-any-llm/README.md"
    }
  },
  "reference_submodules": {
    "_description": "Reference repos for upstream tracking (read-only, periodic sync)",
    "ref-cline": {
      "purpose": "Cline upstream reference (VS Code AI extension)",
      "source": "https://github.com/cline/cline",
      "usage": "Architecture/pattern reference"
    },
    "ref-opencode": {
      "purpose": "OpenCode reference (TUI-based AI coding agent)",
      "source": "https://github.com/anomalyco/opencode",
      "usage": "Architecture/pattern reference for CLI features"
    },
    "ref-nanoclaw": {
      "purpose": "NanoClaw reference (lightweight AI agent framework)",
      "source": "https://github.com/qwibitai/nanoclaw",
      "usage": "Agent framework reference"
    },
    "ref-moltbot": {
      "purpose": "Moltbot reference",
      "source": "https://github.com/moltbot/moltbot",
      "usage": "Bot framework reference"
    },
    "ref-project-airi": {
      "purpose": "AIRI reference (AI character project)",
      "source": "https://github.com/moeru-ai/airi",
      "usage": "AI character/avatar reference"
    },
    "ref-jikime-adk": {
      "purpose": "Jikime ADK reference (Agent Development Kit)",
      "source": "https://github.com/jikime/jikime-adk",
      "usage": "Agent development reference"
    },
    "ref-jikime-mem": {

exec
/bin/bash -lc "sed -n '1,220p' .agents/context/ai-work-index.yaml" in /var/home/luke/alpha-adk
 succeeded in 0ms:
# Copyright 2026 Nextain Inc. All rights reserved.
version: 1
categories:
  - name: "submodule-management"
    keywords: ["submodule", "init", "update", "sync"]
    quick_ref: "git submodule update --init --recursive"
    workflows: []
  - name: "documentation"
    keywords: ["docs", "document", "proposal", "business", "hwp", "hwpx", "pdf", "docx", "xlsx", "pptx", "발표", "제안서", "사업계획서", "이력서"]
    quick_ref: "See docs-business/AGENTS.md. Use /read-doc skill for any HWP/HWPX/PDF/DOCX/XLSX/PPTX file."
    skill: "read-doc"
    skill_trigger: "Any time a non-code document (.hwp/.hwpx/.pdf/.docx/.xlsx/.pptx) needs to be read or analyzed — run /read-doc <file> FIRST before attempting to answer questions about the document."
    workflows: []

  - name: "onmam-development"
    keywords: ["온맘", "onmam", "교회홈피", "빌더", "홈피", "kcp", "결제", "channel", " Lynx"]
    quick_ref: "See projects/onmam-dev/AGENTS.md. Source: github.com/nextain/www.onmam.com (no local clone). Remote dev on onmam-dev GCE via SSH."
    workflows:
      - ".agents/workflows/development-cycle.yaml"
  - name: "cafelua-service"
    keywords: ["cafelua", "service", "gateway", "credit", "auth", "proxy", "any-llm", "lab"]
    quick_ref: "See project-any-llm/README.md"
    workflows:
      - ".agents/workflows/development-cycle.yaml"
  - name: "infra"
    keywords: ["gcp", "cloud-run", "cloud-sql", "docker", "deploy", "domain"]
    quick_ref: "GCP project: cafelua-prod, Cloud Run + Cloud SQL (asia-northeast3)"
    workflows: []
  - name: "demo-video"
    keywords: ["demo", "video", "recording", "tts", "narration", "playwright", "ffmpeg"]
    quick_ref: "See naia-os/.agents/context/demo-video.yaml"
    workflows: []
  - name: "patent"
    keywords: ["특허", "patent", "출원", "명세서", "청구항", "kipo", "발명"]
    quick_ref: "See docs-business/05. 특허/patent-history.json. Use /patent-draft skill."
    skill: "patent-draft"
    skill_trigger: "특허 초안 생성, 특허 명세서 작성, 출원 문서 작성 요청 시 반드시 사용."
    workflows: []
  - name: "issue-driven-development"
    keywords: ["feature", "feature development", "upstream", "investigate", "plan", "review", "bug fix"]
    quick_ref: "Feature-level work (default, 13 phases). ISSUE → UNDERSTAND → SCOPE → INVESTIGATE → PLAN → BUILD → REVIEW → E2E TEST → POST-TEST REVIEW → SYNC → SYNC VERIFY → REPORT → COMMIT"
    workflows:
      - ".agents/workflows/issue-driven-development.yaml"
notes:
  - "Each submodule has its own entry point - read it before modifications"
  - "Add workflow files to .agents/workflows/ as needed"
  - "Workflows are loaded on demand, not all at once"
  - "Default for feature-level work (new features, broad bug fixes): issue-driven-development.yaml"
  - "For non-feature changes (typos, config values, simple directives): development-cycle.yaml"

exec
/bin/bash -lc "sed -n '1,260p' .agents/context/project-index.yaml" in /var/home/luke/alpha-adk
 succeeded in 0ms:
# Copyright 2026 Nextain Inc. All rights reserved.
#
# Naia OS 워크스페이스 인덱스
# AI가 서브모듈별 규칙과 진입점을 찾는 데 사용
version: "2.0"

workspace:
  type: personal
  name: alpha-adk
  owner: luke
  org: nextain
  repo: nextain/alpha-adk
  visibility: private

# 서브모듈 정의
submodules:
  # === 문서 ===
  nextain-docs:
    path: ./data-company/nextain-docs
    type: docs
    description: "Company-wide docs (onboarding, meetings, design)"
    repo: nextain/nextain-docs
    visibility: private
    rulesEntrypoint: AGENTS.md
    status: active

  nextain-team-strategy:
    path: ./data-teams/nextain-team-strategy
    type: docs
    description: "Strategy team documents (proposals, strategy, IR)"
    repo: nextain/nextain-team-strategy
    visibility: private
    rulesEntrypoint: README.md
    status: active

  nextain-team-accounting:
    path: ./data-teams/nextain-team-accounting
    type: docs
    description: "Accounting team documents"
    repo: nextain/nextain-team-accounting
    visibility: private
    rulesEntrypoint: README.md
    status: active

  # === 프로젝트 ===
  cafelua.com:
    path: ./cafelua.com
    type: project
    description: "Cafelua personal website"
    repo: luke-n-alpha/cafelua-private
    visibility: private
    rulesEntrypoint: README.md
    status: active

  project-any-llm:
    path: ./project-any-llm
    type: lib
    description: "Naia AnyLLM SDK + FastAPI gateway (LLM proxy, credits, auth, usage tracking)"
    repo: nextain/naia-anyllm
    visibility: public
    rulesEntrypoint: README.md
    status: active

  www.onmam.com:
    type: project
    description: "OnMam website — CI+WP church homepage service (PHP 7.4 + CodeIgniter + MySQL 8.0 + Apache)"
    repo: nextain/www.onmam.com
    visibility: private
    rulesEntrypoint: projects/onmam-dev/AGENTS.md  # 로컬 클론 없음 — onmam-dev 경유
    status: active
    notes: "no-local-clone. Alpha: *.onmampick.org, Staging: *.onmam.net, Prod: *.onmam.com. Remote dev on onmam-dev GCE."

  onmam-dev:
    path: ./projects/onmam-dev
    type: project
    description: "OnMam remote dev environment context — AI agent entrypoint for onmam-dev GCE VM"
    repo: onmam-com/onmam-dev
    visibility: private
    rulesEntrypoint: AGENTS.md
    status: active
    notes: "Source SoT is on onmam-dev server (/opt/onmam/luke/). Local clone is reference-only."

  naia-memory:
    path: ./projects/naia-memory
    type: project
    description: "Naia Memory cognitive memory system (formerly alpha-memory)"
    repo: nextain/naia-memory
    visibility: private
    rulesEntrypoint: GEMINI.md
    status: active

  onmam-adk:
    path: ./projects/onmam-adk
    type: project
    description: "OnMam ADK workspace — fork of naia-business-adk with onmam-specific skills"
    repo: onmam-com/onmam-adk
    visibility: private
    rulesEntrypoint: AGENTS.md
    status: active

  naia-adk:
    path: ./projects/naia-adk
    type: project
    description: "Naia ADK workspace"
    repo: nextain/naia-adk
    visibility: private
    rulesEntrypoint: AGENTS.md
    status: active

  naia-business-adk:
    path: ./projects/naia-business-adk
    type: project
    description: "Naia Business ADK workspace"
    repo: nextain/naia-business-adk
    visibility: private
    rulesEntrypoint: AGENTS.md
    status: active

  # === 참조용 (Upstream Tracking, Read-Only) ===
  ref-cline:
    path: ./ref-cline
    type: reference
    description: "Cline upstream reference (VS Code AI extension)"
    source: https://github.com/cline/cline
    visibility: public  # external
    status: active

  ref-opencode:
    path: ./ref-opencode
    type: reference
    description: "OpenCode reference (TUI-based AI coding agent)"
    source: https://github.com/anomalyco/opencode
    visibility: public  # external
    status: active

  ref-nanoclaw:
    path: ./ref-nanoclaw
    type: reference
    description: "NanoClaw reference (lightweight AI agent framework)"
    source: https://github.com/qwibitai/nanoclaw
    visibility: public  # external
    status: active

  ref-moltbot:
    path: ./ref-moltbot
    type: reference
    description: "Moltbot reference"
    source: https://github.com/moltbot/moltbot
    visibility: public  # external
    status: active

  ref-project-airi:
    path: ./ref-project-airi
    type: reference
    description: "AIRI reference (AI character project)"
    source: https://github.com/moeru-ai/airi
    visibility: public  # external
    status: active

  ref-jikime-adk:
    path: ./ref-jikime-adk
    type: reference
    description: "Jikime ADK reference (Agent Development Kit)"
    source: https://github.com/jikime/jikime-adk
    visibility: public  # external
    status: active

  ref-jikime-mem:
    path: ./ref-jikime-mem
    type: reference
    description: "Jikime Memory reference"
    source: https://github.com/jikime/jikime-mem
    visibility: public  # external
    status: active

  ref-cc:
    path: ./projects/refs/ref-cc
    type: reference
    description: "Claude Code CLI reference (AI coding agent, TypeScript, 1884 files)"
    source: "Extracted from Claude Code CLI (Anthropic)"
    visibility: private  # internal analysis
    rulesEntrypoint: AGENTS.md
    status: active
    notes: "Dual-mirror context (.agents/ + .users/). Naia OS adoption analysis in .agents/context/naia-os-adoption.yaml"

# 로컬 프로젝트 (서브모듈 아님)
local_projects:
  naia-os:
    path: ./naia-os
    type: project
    description: "Naia OS desktop app (Tauri 2 + React + Three.js + Node.js agent)"
    repo: nextain/naia-os
    visibility: public
    rulesEntrypoint: AGENTS.md
    status: active

  about.nextain.io:
    path: ./about.nextain.io
    type: project
    description: "Nextain corporate website (Next.js 14 + next-intl)"
    repo: nextain/about.nextain.io
    visibility: public
    rulesEntrypoint: README.md
    status: active

  naia.nextain.io:
    path: ./naia.nextain.io
    type: project
    description: "Naia web app / Lab portal (Next.js + BFF for gateway)"
    repo: nextain/naia.nextain.io
    visibility: private
    rulesEntrypoint: AGENTS.md
    status: active

  aiedu.nextain.io:
    path: ./aiedu.nextain.io
    type: project
    description: "AI education platform — curriculum-driven AI teacher (Next.js + Monaco + Pyodide + any-llm)"
    repo: nextain/aiedu.nextain.io
    visibility: private
    rulesEntrypoint: AGENTS.md
    status: active
    notes: "B2B commercial product. Dual-mirror context. Curriculum as plugin. Depends on any-llm B2B extension."

  admin.nextain.io:
    path: ./admin.nextain.io
    type: project
    description: "Nextain B2B admin control plane (license key mgmt, token tracking, client mgmt)"
    repo: nextain/admin.nextain.io
    visibility: private
    rulesEntrypoint: AGENTS.md
    status: active
    notes: "Internal tool. Manages aiedu.nextain.io and future B2B products."

  9router:
    path: ./9router
    type: project
    description: "9Router — Free AI Router dashboard (Next.js). Auto-routes Claude Code, Cursor, Cline, etc. to 40+ AI providers & 100+ models."
    repo: decolua/9router
    visibility: public
    rulesEntrypoint: README.md
    status: active
    notes: "Standalone git repo (not a submodule). External open-source project maintained by luke."

  issue-desk:
    path: ./issue-desk
    type: project
    description: "IssueDesk — standalone Vite+React panel for naia-os. GitHub issue/PR triage, community assistant, notification triage."
    repo: nextain/issue-desk
    visibility: private
    rulesEntrypoint: README.md
    status: active
    notes: "Standalone git repo (not a submodule). Served as panel.json + index.html from naia-os shell. Design doc: naia-os/docs/design/issue-desk.ko.md"

# GitHub-only repos (not in workspace)
github_only_repos:
  titanoboa:
    type: tool
    description: "Naia OS Live ISO builder (fork of ublue-os/titanoboa)"
    repo: nextain/titanoboa

exec
/bin/bash -lc "sed -n '1,220p' /var/home/luke/alpha-adk/.agents/skills/review-pass/SKILL.md" in /var/home/luke/alpha-adk
 succeeded in 0ms:
---
name: review-pass
version: "3.0"
description: >
  Stage-gated multi-AI cross-validation review with optional REQ-ID traceability.
  4 stages (planning, development, test, integration) with configurable reviewers,
  finding consensus, and convergence loop. Fully project-agnostic and distributable.
triggers:
  - "/review-pass"
  - "review pass"
  - "리뷰 패스"
input_schema:
  stage:
    type: enum
    values: [planning, development, test, integration]
    required: true
    description: "Review stage — determines lenses, reviewers, and convergence"
  files:
    type: "string[]"
    required: true
    description: "File paths to review"
  context:
    type: string
    required: false
    description: "What was implemented/changed, which issue it addresses"
  req_ids:
    type: "string[]"
    required: false
    description: "REQ-IDs to validate coverage against"
  deferred_req_ids:
    type: "string[]"
    required: false
    description: "REQ-IDs intentionally deferred (won't block convergence)"
  reviewers:
    type: "string[]"
    required: false
    description: "Override default reviewers (e.g. gemini,opencode,codex,claude)"
  "--light":
    type: boolean
    required: false
    description: "Reduce convergence to 1 clean round, skip non-essential lenses"
output:
  documents: []
  records:
    - name: "review_log"
      path: "configurable via review-pass.yaml, default: review-log.json"
  side_effects:
    - description: "Auto-fixes CONFIRMED findings (with safety guard)"
      adapter: "file_system"
steps:
  - id: "validate_inputs"
    action: "Check CLI tools available, load profile, resolve reviewers"
  - id: "round_loop"
    action: "Run review rounds until convergence"
    gate: false
  - id: "report"
    action: "Output final report"
failure_policy:
  retry: true
  rollback: true
  on_failure: "abort"
idempotency: false
---

# Review Pass v3 — Stage-Gated Multi-AI Cross-Validation

## Purpose

Multi-AI cross-validation review that adapts review power, perspective, and
convergence criteria to the current development stage. Optional REQ-ID
traceability for requirements-driven projects.

**Core principles:**
- **Project-agnostic**: No hardcoded paths, tools, or conventions. All configurable.
- **Multi-AI**: Independent reviewers via CLI tools reduce single-model blind spots
- **Stage-aware**: Planning, development, test, and integration have different needs
- **Convergent**: Automated loop until N consecutive clean rounds
- **Traceable**: REQ-ID coverage validated at every stage (when applicable, optional)
- **Safe**: Auto-fix with diff preview, rollback, and safety guard

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `stage` | **yes** | `planning` / `development` / `test` / `integration` |
| `files` | **yes** | Comma-separated file paths to review |
| `context` | recommended | What was implemented/changed, issue reference |
| `req_ids` | optional | Comma-separated REQ-IDs to validate coverage |
| `deferred_req_ids` | optional | Comma-separated REQ-IDs intentionally deferred |
| `reviewers` | optional | Override default reviewers from profile |
| `--light` | optional | 1 clean round, reduced lens set |

## When to Run

| Development Phase | Review Stage | Purpose |
|-------------------|-------------|---------|
| After Plan, before Build | `planning` | Requirements ↔ Design alignment |
| After each Build phase | `development` | Code ↔ Plan alignment + REQ coverage |
| After E2E Test | `test` | Test quality + REQ-to-test mapping |
| Before Commit/Sync | `integration` | Full E2E traceability audit |

## Core Rules

> **The orchestrator AI does NOT report intermediate results to the user.**
> **CONFIRMED findings are auto-fixed with diff preview (see section 6.6).**
> **CONTESTED findings at R=2 trigger inline user prompt, then loop resumes.**
> **Only the final report is shown after convergence.**

---

## 1. Stage Profiles (defaults, overridable via config)

Each lens includes actionable checks for headless reviewers.

### planning
- **Reviewers**: 2 (configurable)
- **Convergence**: 1 consecutive clean round
- **Arbiter**: none (CONTESTED → inline user prompt, loop resumes)
- **Lenses (with REQ-IDs)**:
  1. `req_completeness` — Check: every requirement from the issue has a REQ-ID; no orphan REQ-IDs; acceptance criteria are testable
  2. `design_coherence` — Check: no internal contradictions between sections; dependencies are identified; scope is bounded
  3. `feasibility` — Check: technical approach is realistic; no assumed-but-unverified capabilities; effort estimate matches scope
  4. `traceability_setup` — Check: each REQ-ID has acceptance criteria; each criterion is independently verifiable; test method is stated
- **Lenses (without REQ-IDs)**:
  1. `completeness` — Check: all stated goals have implementation steps; no missing sections; edge cases identified
  2. `design_coherence` — (same as above)
  3. `feasibility` — (same as above)
  4. `clarity` — Check: unambiguous language; no undefined terms; a new team member could implement from this plan

### development
- **Reviewers**: 3 (configurable)
- **Convergence**: 2 consecutive clean rounds (1 in --light)
- **Arbiter**: separate tool from reviewer set (configurable, must not be in reviewer pool)
- **Lenses (with REQ-IDs)**:
  1. `correctness` — Check: logic matches intent; null checks on external inputs; off-by-one in loops; error paths handled; no silent failures
  2. `completeness` — Check: all planned items implemented; all REQ-IDs have code mappings; no TODO stubs in production paths
  3. `consistency` — Check: naming matches project conventions; import paths correct; no conflicts with existing code; no unintended side effects
  4. `pattern_compliance` — Check: same patterns as similar files in project; not inventing novel approaches alone; read 2-3 similar files to compare
  5. `req_to_code` — Check: each REQ-ID maps to specific code (file + symbol); acceptance criteria traceable to implementation
- **Lenses (without REQ-IDs)**:
  1. `correctness` — (same as above)
  2. `completeness` — Check: all planned items implemented; no missing files; no TODO stubs
  3. `consistency` — (same as above)
  4. `pattern_compliance` — (same as above)

### test
- **Reviewers**: 2 (configurable)
- **Convergence**: 1 consecutive clean round
- **Arbiter**: none (CONTESTED → inline user prompt, loop resumes)
- **Lenses (with REQ-IDs)**:
  1. `test_validity` — Check: tests import and call the changed code; assertions execute after the code under test runs; mocks don't replace the actual logic being tested
  2. `coverage` — Check: all REQ-IDs have corresponding test cases; negative cases exist; edge cases tested
  3. `assertion_quality` — Check: assertions check specific values not just "not null"; no assertions that always pass; error messages are meaningful
  4. `req_to_test` — Check: each REQ-ID maps to specific test file + test name; test names reflect the requirement
- **Lenses (without REQ-IDs)**:
  1. `test_validity` — (same as above)
  2. `coverage` — Check: all changed code paths are tested; negative cases exist; edge cases tested
  3. `assertion_quality` — (same as above)

### integration
- **Reviewers**: 3 (configurable)
- **Convergence**: 2 consecutive clean rounds (1 in --light)
- **Arbiter**: separate tool from reviewer set (configurable, must not be in reviewer pool)
- **Lenses (with REQ-IDs)**:
  1. `req_trace_e2e` — Check: every REQ-ID traceable issue→plan→code→test; no orphan REQ-IDs at any stage; full chain for each
  2. `cross_stage_consistency` — Check: plan description matches code; code matches tests; no contradictions between any two stages
  3. `regression_risk` — Check: existing tests still pass; no breaking API changes; config changes are backward-compatible
  4. `drift_detection` — Check: implementation matches plan intent (not just letter); no scope creep; no missing pieces from original plan
- **Lenses (without REQ-IDs)**:
  1. `completeness_e2e` — Check: all planned changes are implemented and tested; nothing dropped silently
  2. `cross_stage_consistency` — (same as above)
  3. `regression_risk` — (same as above)
  4. `drift_detection` — (same as above)

---

## 2. CLI Invocation Protocol

### 2.1 Encoding Setup

Set UTF-8 encoding before any CLI invocation:

**PowerShell (Windows):**
```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
```

**Bash (Linux/macOS):**
```bash
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8
```

### 2.2 Prompt Delivery

Write prompt to a temporary file, then pipe via stdin. Never inline large
prompts in command arguments (encoding/length issues).

**PowerShell:**
```powershell
$promptFile = [System.IO.Path]::GetTempFileName()
Set-Content -Path $promptFile -Value $prompt -Encoding UTF8
Get-Content $promptFile -Raw | & $toolCommand
```

**Bash:**
```bash
promptFile=$(mktemp)
echo "$prompt" > "$promptFile"
cat "$promptFile" | $toolCommand
```

### 2.3 Reviewer Invocation

Each reviewer is invoked as a headless CLI process. Commands are configurable
via the tools section of the profile. Standard patterns:

| Tool | Headless Command | Read-Only | Notes |
|------|-----------------|-----------|-------|

codex
이제 baseline과 설계 본문을 같은 축으로 읽어 충돌 지점을 잡겠습니다. 특히 Part A 불변식, B19/B20, F-rule, #31 진입점 사이에서 계약 소유권과 런타임 의존 방향이 일관적인지만 보겠습니다.
exec
/bin/bash -lc "rg -n '"'^#|''^##|''^###|A'"\\.3|A\\.5|A\\.6|A\\.11|A\\.13|F07|Part A|observability|ErrorEvent|security|audit|regression|manifest|RAGProvider|OrchestrationPolicy|service-manifest' .agents/progress/naia-4repo-migration-plan.md" in /var/home/luke/alpha-adk
 succeeded in 0ms:
1:# Naia 4-Repo Migration Plan — v7
3:**Status**: v7.2 — **audit mode**. Phase 1 + X1 의 "완료 ✅" 판정은 self-review + smoke-only 근거였음이 드러남 (2026-04-22 audit). 이 버전은 해당 실태를 정직히 demote하고 TDD rewind 계획을 반영한 것.
7:**Changes from v7.1 (this version)**: 테스트 커버리지 감사 반영. Phase 1 ✅ 전체를 🟡로 demote. X1 ✅ → 🟡. Audit doc `.agents/progress/naia-test-coverage-audit-2026-04-22.md` 링크. Meta issue `nextain/naia-agent#1` 등록. "PASS" 정의를 "unit test green + cross-review 2 consecutive clean"으로 상향.
11:## §Z Execution Log (v7 신규)
13:### Phase 0 (재분류 후) — 완료 또는 해결
17:| S1 alpha-memory audit | ✅ | `naia-agent/docs/memory-provider-audit.md` |
18:| S1b mem0 dual audit | ✅ | 같은 문서 §6 — façade 변경 불필요 확인 |
30:### MVM #1-#5 — 완료
41:### Phase 1 — 구현만 완료, **테스트·리뷰 미달** (v0.1.0 freeze 2026-04-21, audit 2026-04-22)
48:| T4 `@nextain/agent-observability` 0.1.0 | ✅ | 🔴 | 🔴 | 🟡 3 class untested |
55:**실태 (audit 2026-04-22)**: 라운드 모두 self-review. cross-review 0회. 단위 테스트 0개. 7 smoke는 `throw new Error()` 기반 happy-path only.
58:### Phase 2 X1 — 구현 완료, 테스트·리뷰 일부만 (audit demote 2026-04-22)
66:- 의존성: `@nextain/agent-providers` + `@nextain/agent-types`를 `agent/vendor/*.tgz`로 vendoring. `pnpm.overrides`로 내부 `workspace:*` 참조 해소 (A.3 불변식 유지, registry publish 독립).
83:### Scope rename 기록
88:### E 결정 재정리
97:### Open blockers (Phase 2 진입 전)
102:### 알려진 debt
106:- **테스트 커버리지 전면 부족** — Phase 1 + X1 전체가 smoke/self-review 근거. `nextain/naia-agent#1` + audit doc `.agents/progress/naia-test-coverage-audit-2026-04-22.md` 참조.
108:### §Y TDD Rewind — 우선순위 (audit v2, 2026-04-22 cross-review 반영)
114:| B | trust boundaries (`SkillToolExecutor.filter`, `CompositeToolExecutor` shadow/order, `GatedToolExecutor` tier, Agent halt + skip-encode) | security/permission 경계 |
116:| E | MCP 라이프사이클, observability (InMemoryMeter 카운터 등) | 범위 좁은 보강 |
124:## Part A — 확정 사항 (리뷰 대상)
128:## Part A — 확정 사항 (리뷰 대상)
132:### A.1 철학
138:### A.2 레포 역할
147:### A.3 의존 방향 (불변식)
155:core, runtime, providers, messengers, observability
168:### A.4 패키지 (역할 단위 — 수는 실행 중 조정)
171:- 구현 N: `core` · `runtime` · `providers` · `messengers` · `observability` · (옵션) `tts`/`cli`/`testing`
173:- 축소 허용: 작업 편의에 따라 merge/split. 단 A.3 의존 방향 유지.
176:### A.5 계약 정의 (shape 원칙)
184:**`ErrorEvent`** — 실패 전파 계약. `error_code`(i18n-ready), `severity`(info/warn/error/fatal), `retryable: boolean`. 예외는 runtime 내부 용도, 경계 넘는 실패는 ErrorEvent로. (용어 분리: `tier`는 권한 T0-T3 전용, `severity`는 실패 심각도 전용.)
185:**`Logger` / `Tracer` / `Meter`** — observability 계약. `observability` 패키지는 이 계약의 기본 구현체. 계약 자체는 `types`.
187:**`SessionLifecycle` 상태 전이** — `created → active → paused → resumed → closed | failed`. `fatal` severity ErrorEvent 발생 시 `failed` 전이. `naia-agent/core`가 로직 소유, `alpha-memory`는 저장만.
196:### A.6 소유권 (누가 무엇을)
227:### A.7 Enforcement (1인 개발자 현실)
237:### A.8 Release 정책
245:### A.9 Strangler Fig 원칙
253:- **Abort 조건 원칙**: MVM 실패 OR A.3 의존 방향이 실제 코드에서 성립 불가 판명 OR 다수의 해결 불가 블로커 발생. 이 중 하나면 계획 전체 재설계.
257:### A.10 MVM (최소 증명)
272:- 1~2단계에서 A.3 의존 방향 성립 불가 발견 → 계획 재설계
277:**MVM 첫 PR 위치 원칙**: 검증 대상 repo 자체. #1 "알파메모리 실체 확인" → 첫 PR은 `alpha-memory` 또는 `naia-agent/docs/` 내 audit 문서.
281:### A.11 교차 관심사 원칙 (5·6라운드 반영)
283:- **Observability emit 의무**: 모든 구현은 주요 상태 전이에서 Event emit. 로그 없음 = 계약 위반 (A.5에서 재강조).
284:- **Error 전파**: 경계 간 실패는 `ErrorEvent` shape으로. 예외(throw)는 내부 전용. runtime은 `error_code`만 emit, 사람이 읽는 번역은 shell 전용.
289:- **Regression 금지**: 공개 릴리스 전 유의미한 품질·latency regression 발견 시 release block. 측정 범위: memory benchmark, tool-call 성공률, stream TTFB. 구체 임계치는 운영 정책.
294:### A.12 비기능 원칙 블록 (6라운드 Gap Hunter 반영)
300:  - `ErrorEvent.retryable` 필드가 계층 판단의 hint.
304:- **Public API 안정성**: `@nextain/agent-types`·`@naia-agent/protocol`·`@naia-adk/skill-spec`은 **외부 소비자 대상 공개 계약**. v1.0 이후 MAJOR 변경은 A.11 communication 원칙 적용.
307:### A.13 보안 패치 원칙
310:- 패치 후 공개 보안 공지(CHANGELOG security 섹션) 의무.
312:## Part B — 구현 중 결정 (리뷰 대상 제외)
332:이 항목들은 실행 시점에 결정되며, 결정과 동시에 이 문서 Part A로 승격되거나 구현 PR의 ADR로 남김.
336:## Part C — 실행 중 발견 (미지수 인정)
350:## Part D — 리스크 원칙 (구체 수치 없음)
354:| 런타임 순환 의존 | 계약/구현 패키지 분리 (A.3) |
363:## Part E — Open Decisions (Part A에 속함, 지금 답 필요)
374:## 리뷰어 지침
376:- **Part A만 judgement**. 원칙·계약·경계·소유권의 **논리 일관성**만 검토.
379:  - Part A 내부 자기모순
380:  - Part A에 있어야 하는데 Part B/C로 회피된 것
386:- clean 기준: Part A에 논리 모순·누락 원칙·오배정 소유권 없음.

exec
/bin/bash -lc "rg -n '"'^#|''^##|''^###|B19|B20|D44|R5|LOCKED|LangChain|LangGraph|StateGraph|reducer|Vercel AI SDK'"' projects/naia-agent/.agents/progress/ref-adoption-matrix.md" in /var/home/luke/alpha-adk
 succeeded in 0ms:
1:# Ref Adoption Matrix — naia-agent R0
10:## A. 이미 채택된 결정 (코드/문서로 pin됨)
38:| **A25** | Bash skill (T1, execFile + DANGEROUS pre-filter + timeout) | 자체 (Slice 2) | `packages/runtime/src/skills/bash.ts` | 12 unit (bash-skill.test.ts) — 실 shell 실행 + BLOCKED + 타임아웃 |
48:## B. 명시적으로 거부된 결정
70:| **B19** | LangChain `@langchain/core` 직접 의존 | langgraphjs | B09와 동일 — zero-runtime-dep 위배 + ecosystem lock-in |
71:| **B20** | LangGraph StateGraph 채널 reducer (정적 schema) | langgraphjs | D1 stream-first 결정과 모델 충돌 |
72:| ~~B21~~ | ~~Vercel `@ai-sdk/<provider>` 50개 직접 의존 + React hooks~~ — **DEMOTED by D44 (2026-04-29), refined by 5.x.6 cross-review P0-3 (2026-04-29)**. 실제 적용 형태: `@nextain/agent-providers`가 5개 default 번들 (`@ai-sdk/anthropic`/`@ai-sdk/google`/`@ai-sdk/openai-compatible`/`zhipu-ai-provider`/`ai-sdk-provider-claude-code`) 만 `optionalDependencies` 로 자동설치, 나머지 50개는 host가 peer로 opt-in 설치. (1) 50-provider sprawl 회피 (5개로 한정), (2) `@ai-sdk/react` hooks는 별도 패키지 — naia-agent는 headless로 import 안 함. zero-runtime-dep 정신 완전 보존은 아니지만 **사용자 directive ("자동설치")** 와 정합 + 50-provider sprawl 우려는 해소 | vercel-ai-sdk | demoted (5-provider default bundle, host opts into more) |
78:## C. 이연 (Deferred) — 트리거 조건 명시
107:## D. 신규 채택 권고 (R0에서 추가, P0~P2 라벨)
120:| **D10** | Tool 메타 (`description`/`inputSchema`/`contextSchema?`/`isConcurrencySafe?`/`isDestructive?`) | cc 분석 + Vercel AI SDK + Mastra | **P0** | S (1h) | Slice 1b — Tool 정의 정식 확장 |
133:| ~~D23~~ | ~~**Vercel AI SDK 보류** — any-llm으로 충분 (multi-provider routing은 원격 gateway). 외부 distribution 시 재검토~~ — **SUPERSEDED by D44 (2026-04-29)**. D23 근거의 결함: any-llm gateway는 원격 naia 계정 한정이고, 사용자 자체 키 환경에서는 multi-provider 확보 못함. 5개 자체 provider는 이전 naia-os/agent에서 carry-over일 뿐 실질 신규 abstraction 아님 | R4 (any-llm = naia 자체 fork, naia-anyllm) | ~~P2~~ | — | superseded |
144:| **D43** | **naia-agent의 STT/TTS provider abstraction** (Vercel AI SDK 패턴, omni audio_delta 호환) — naia-os는 device IO만 (mic/speaker via Tauri Rust cpal) | R4 Phase 4 cross-review 사용자 통찰 — "tts/stt naia-shell 처리 시 omni 곤란" | P1 | M | naia-agent에 audio provider layer (Vercel `experimental_generateSpeech` / `experimental_transcribe` 패턴) — Phase 5+ |
145:| **D44** | **Vercel AI SDK 로컬 LLM 단일 abstraction 채택** (D23 supersede) — `ai` core를 peer dep, `@ai-sdk/<provider>`도 optional peer dep. 50+ provider 즉시 호환. 자체 5개(`anthropic`/`anthropic-vertex`/`gemini`/`openai-compat`/`claude-cli`) → `VercelClient` adapter 1개로 대체. CLI 구독 path는 community provider (`ai-sdk-provider-claude-code`/`-codex-cli`/`-gemini-cli`/`-opencode-sdk`)로 흡수. **lab-proxy / lab-proxy-live는 보존** (naiaKey 보호 + WebSocket Live API, Vercel 영역 밖). vllm-omni 텍스트 mode = `@ai-sdk/openai-compatible`로 즉시 호환, audio_delta realtime은 D43 자체 layer 유지 | 사용자 directive 2026-04-29 — D23 silent drift 정정. 토큰 부족 → multi-provider 확보 절실. RunPod naia 계정 통합은 별도 (D45 후보) | **P0** | L (Phase 5.x slices) | packages/providers/src/vercel-client.ts (adapter) + 5개 자체 provider deprecate → 제거 (slice 시퀀스). bin / examples / fixture-replay 갱신 |
149:## E. Drift 위험 — 적혔지만 코드/테스트로 pin 안 됨
164:## F. 결정 누락 — 분석은 있는데 정식 결정문 없음
176:## G. ref별 채택 점수표 (한눈 요약)
190:| **langgraphjs** | ★★★ | Checkpoint 패턴 (C05 후보), interrupt/resume (C12 인접), Send sub-agent (C02 인접) | LangChain core 의존 (B19), StateGraph reducer (B20), Python parity 우선 |
194:## H. 매트릭스 사용 가이드
205:## 참고 — ref별 review 파일 경로
223:## I. v2 변경 이력 (2026-04-25 R1 cross-review 적용)
228:- **§B 신규 6건** (B17~B22) — Mastra monorepo / Mastra Studio / LangChain core / StateGraph reducer / Vercel multi-provider / cleanroom 라인 복붙
231:- **§G 점수표** — Mastra/LangGraph/Vercel 3 ref 추가
237:## J. R4 변경 이력 (2026-04-26 Hybrid Wrapper Pivot)
243:- **§D 신규 7건** (D18~D24) — Hybrid wrapper / 단일 대화 + 정직 보고 / NaiaStreamChunk multi-modal / Real-time interrupt / vllm-omni adapter / Vercel AI SDK 보류 / Sub-agent supervisor
280:## K. R5 변경 이력 (2026-04-29 Vercel AI SDK 채택 정정)
284:**배경**: D23 (Vercel AI SDK 보류, R4 lock)이 사용자 원래 의사 ("로컬은 vercel꺼 쓰면 다 해결")와 정반대로 기록되어 silent drift. R3~R4에서 만든 7개 자체 provider 중 5개가 이전 naia-os/agent에서 carry-over일 뿐 실질 신규 abstraction 아니고, registry/factory layer는 오히려 후퇴.
288:- **§D 신규 1건** (D44) — Vercel AI SDK 로컬 LLM 단일 abstraction 채택, peer-dep 패턴
289:- **§D supersede** — D23 → D44 (strikethrough + supersede 명시)

exec
/bin/bash -lc "rg -n 'F01|F06|F07|F08|D1|D2|D3|D4|D5|D6|D7|D8|OPEN P0|skeleton|gate|Part A' projects/naia-agent/.agents/context/agents-rules.json" in /var/home/luke/alpha-adk
 succeeded in 0ms:
6:  "phase": "R5 LOCKED (Vercel AI SDK adoption — Slices 5.x.0~5.x.6 complete; R6 candidates = Tier B 8건 + D53 RunPod)",
26:      "id": "F01",
27:      "rule": "no_code_change_without_skeleton",
30:      "exemption": "보안 패치(CVE-worthy) — F01 차단 면제. 단 단위 테스트 동시 도입 강제. 4-repo plan A.13 보안 패치 lockstep 면제 원칙 적용"
57:      "id": "F06",
59:      "description": "docs/agent-loop-design.md D1~D8 결정 수정 금지. 신규 결정만 ref-adoption-matrix.md §D에 추가",
63:      "id": "F07",
65:      "description": "alpha-adk/.agents/progress/naia-4repo-migration-plan.md Part A 수정 금지. 본 레포 R0는 실행 시퀀싱만 변경",
69:      "id": "F08",
71:      "description": "OPEN P0 sub-issue 1건이라도 있으면 R1 plan 작성 차단",

exec
/bin/bash -lc "rg -n '"'^#|''^##|''^###|REQ|Phase|SB-|gate|skeleton|R5|LOCKED|manifest|evaluation|eval|memory|persona|qwen3.6-27b'"' projects/naia-agent/.agents/progress/issue-draft-agent-eval-framework.md" in /var/home/luke/alpha-adk
 succeeded in 0ms:
7:     ※ 이 파일이 issue-draft-minicpm-rag-memory-agent-benchmark.md 를 대체
10:# [R6 candidate] naia-agent AI 에이전트 성능 평가 프레임웍
13:> minicpm(음성)·RAG·naia-memory 는 그 프레임웍이 *평가하는 구성요소*이지
14:> 헤드라인이 아님. (이전 draft `issue-draft-minicpm-rag-memory-agent-
17:## 0. 다음 세션 시작 가이드 (먼저 읽을 것 — BLOCKING)
31:   ko-serve = serving + 계약 + 자기 gateway (이미 제공). 상호 import X.
33:## 1. 목적 (헤드라인)
36:프레임웍을 구축한다.** 즉: 에이전트가 (RAG + naia-memory 컨텍스트를
41:## 2. 왜 지금 / minicpm 트랙은 왜 멈췄나 (정직)
49:  GPU/ko-serve worker 필요(Phase 2).
51:## 3. 연결 계약 (ko-serve 제공, 확정됨)
55:  이벤트). vLLM 미경유 — ko-serve gateway 직결.
56:- **RAG/memory 주입점 = `session.update.session.context`** (§7) →
57:  ko-serve gateway 가 `context+"\n"+instructions` 단순 prepend (검색·판단
62:- ko-serve `/v1/realtime` 라이브 검증 미완(gateway 재시작=GPU 단계).
64:## 4. 스코프
68:   0ce5f16)를 **agent-flow 레벨로 확장** — RAG+memory+backend end-to-end
74:3. **RAG + naia-memory context 조립**: 기존 `@nextain/naia-memory` v6.0
75:   (examples/naia-memory-host.ts, hardened-sqlite-host.ts, MemoryProvider
79:## 5. 비-스코프
87:## 6. 프로세스 위치 / 게이트 (정직)
89:- naia-agent phase = **R5 LOCKED**. 이 작업 = **R6 candidate**. 신규
91:  flow eval) → AGENTS 규칙 #4: ref-adoption-matrix **§D 항목 신설 +
96:## 7. 할 일 — GPU 유무 분리
98:### Phase 1 — GPU 불요 (다음 세션 바로 가능)
103:- [ ] RAG+memory→context 조립 flow 설계
106:### Phase 2 — GPU 필요 (ko-serve worker, 별도)
107:- [ ] ko-serve worker+gateway 재시작 → `/v1/realtime` 라이브 e2e (G3 context / G1 telemetry 실검증)
108:- [ ] 실 backend 통합 검증(S03) — agent+RAG+memory+minicpm 라이브
111:## 8. Acceptance (slice success criterion)
113:S01 새 실행 명령 · S02 unit test 1+ · S03 통합검증(Phase1 fixture-replay
114:/ Phase2 실 backend) · S04 README·CHANGELOG · matrix §D ID 인용.
116:## 9. Cross-ref

exec
/bin/bash -lc "rg -n '"'^#|''^##|''^###|RAGProvider|OrchestrationPolicy|service-manifest|manifest|LangGraph|StateGraph|reducer|RBAC|SDLC|multiten|audit|observability|ErrorEvent|security|governance|SB-|Phase|fork chain|Part A|A'"\\.3|A\\.11|qwen3.6-27b|personal|business|demo|MVP' projects/naia-adk/.agents/progress/agent-service-builder-architecture.md" in /var/home/luke/alpha-adk
 succeeded in 0ms:
2:     SoT 경계: 4-repo Part A(alpha-adk, F07 수정금지) 위에 얹는 확장.
6:# Agent Service Builder — 아키텍처 설계 (DRAFT v1)
10:> 개인(naia-os) / 비즈니스(naia-business-adk) 2-layer 로 구축.
16:## 0. 범위 / 비범위
20:| **In** | 레포 관계 정합 · 에이전트 서비스 빌더 layer 설계 · 개인/비즈니스 경계 · backend-agnostic(qwen3.6-27b-dense / minicpm) · 구체 구현계획(slice) |
21:| **Out** | Part A 원칙 수정(F07) · agent-loop D1~D8 수정(F06) · ko-serve 모델/serving(별 repo, v2 계약 제공) · 실제 코드 착수(합의 게이트 전) |
25:## 1. 레포 관계 — 직교 2축 (사용자 "잘 설명" 핵심)
29:### 축 1 — 런타임 의존 (Part A.3 불변식, 변경 불가)
32:naia-os (host)            Tauri shell · 3D avatar · OS image · 승인 UI · audit · identity
45:### 축 2 — 워크스페이스 Fork Chain (거버넌스 상속)
48:naia-adk            personal base   (public, Apache 2.0) — 워크스페이스 포맷·스킬·persona·process
49:   └── naia-business-adk   business upstream — 조직 거버넌스(assets/process/permissions·RBAC·SDLC)
51:               └── {member}-adk   company-linked personal   (예: alpha-adk)
53:- **공개 계약 canonical 원칙(A.11)**: 유료/하류 fork 는 공개 계약을 **구현만**.
55:- **License 검증 소유(A.6)** = naia-business-adk (다운스트림).
57:### ⚠️ 정정 필요 — Fork chain 문서 불일치 (본 설계가 해소)
61:| `naia-adk/AGENTS.md` §Fork Chain | `naia-adk → {org}-adk → {user}-adk` (3단계, business 누락) | **outdated** — generic |
62:| `naia-business-adk/README` | `naia-adk → naia-business-adk → {company}-adk → {member}-adk` | **canonical** (business upstream 명시) |
64:→ 본 설계 채택 = **4단계 (business upstream 명시)**. naia-adk/AGENTS.md Fork Chain
67:### 두 축의 결합점
72:host(개인=naia-os / 비즈니스=naia-business-adk 다운스트림)가 "어디서(배포·권한·과금)" 운영
77:## 2. 에이전트 서비스 빌더 — layer 구조
81:**naia-adk 워크스페이스 manifest** 로 정의하고, naia-agent 런타임이 실행한다.
85:│  service.manifest:  persona(packages/persona) + skills(skill-spec) │
89:                            │ naia-agent 가 manifest 소비 (계약 주입)
92:│  + [신규] RAGProvider 계약 · OrchestrationPolicy 계약              │
97:│  비즈니스: naia-business-adk 다운스트림 (RBAC·멀티테넌시·과금·audit) │
101:### 평가 프레임웍(#31)의 위치 — 우산의 하위
103:#31 = "검증 가능한 agent-flow 성능 평가". 본 빌더의 **하위 검증 layer**:
104:서비스 manifest 의 `eval.fixtures` 가 #31 하니스 입력. 빌더가 헤드라인,
107:### 풀셋 매핑 (사용자 "LLM + persona/system prompt + naia-memory + RAG + langraph")
111:| LLM | naia-agent providers | D44 Vercel AI SDK adapter (qwen3.6-27b-dense via `@ai-sdk/openai-compatible` → naia-model-infra vllm-coding / minicpm via lab-proxy-live `/v1/realtime`) |
112:| persona / system prompt | naia-adk `packages/persona` | manifest `persona` 필드 → Agent system 조립 |
114:| **RAG** | **신규 — naia-agent `RAGProvider` 계약** | host 주입. retrieval→context. matrix **§D 신규** |
115:| **orchestration (LangGraph)** | **신규 — `OrchestrationPolicy` 계약** | ⚠️ §3 제약 참조 |
119:## 3. ⚠️ LangGraph 제약 — 매트릭스 충돌 해소 (크로스리뷰 핵심 공격점)
123:- **B20**: LangGraph StateGraph 채널 reducer 거부 (D1 stream-first 모델 충돌)
126:**그러므로 "LangGraph 직접 채택" 은 Part A.3 / 매트릭스 위배.** 해소안 (택1, 크로스리뷰 판정):
130:| **A (권고)** | `OrchestrationPolicy` 자체 계약(zero-runtime-dep) + naia-agent 내 경량 graph executor (stream-first 보존). LangGraph 는 *패턴 참조*만 | §D 신규 (B20 의 "reducer 모델 충돌" 회피 설계 명시) |
131:| B | host opt-in peer-dep (`@langchain/langgraph` 를 host 가 설치, naia-agent 는 adapter 계약만) — D44 의 peer-dep 선례 | §D 신규 + B19 demote 논거 필요 |
132:| C | LangGraph 전면 채택 | **거부** — B19/B20 정면 위배, Part A.3 깨짐 |
139:## 4. 개인 vs 비즈니스 경계 (사용자 "경계 적절히, 개인도 필요부분")
141:| 관심사 | 개인 (naia-adk + naia-os) | 비즈니스 (naia-business-adk 다운스트림) |
143:| 워크스페이스 manifest | ✅ 정의·실행 | ✅ 상속 + governance 래핑 |
145:| 실행 host | naia-os (단일 사용자, Tauri) | 서버/멀티테넌시 (naia-business-adk 운영) |
146:| 권한 | 단일 사용자 (T0~T3 self) | **RBAC** (author/reviewer/approver/releaser/auditor) |
148:| audit / SDLC artifact | naia-os audit log | **SDLC tracking** (req/design/decision/review/release/postmortem) |
149:| License / 과금 | 없음 (Apache 2.0) | naia-business-adk License 검증 (A.6) |
153:비즈니스 layer = 개인 base 의 **상위 래핑**(거버넌스 추가), 계약 수정 X (A.11).
155:### naia-adk ↔ naia-business-adk 경계 (구체)
157:- `naia-adk` = personal base. 워크스페이스 포맷·service manifest 스키마·기본 스킬·persona/process packages. **service manifest 스키마 SoT 여기**.
158:- `naia-business-adk` = business upstream. README 가 명시: "not just premium skill bundle. Skills are one output of the model, not the whole product." → governance 모델(assets/process/permissions, RBAC, SDLC)이 본체. 현재 **거의 백지(README only) = 본 설계의 신규 구축 대상**.
159:- 경계선: **manifest 스키마·런타임 계약 = naia-adk(canonical). governance 확장 = naia-business-adk(구현만, 스키마 미수정).**
163:## 5. 구체적 구현 계획 (사용자 "구현계획 구체적으로")
168:### Phase 0 — 합의 게이트 (코드 0줄)
172:- [ ] matrix §D 신규 항목 초안: `D-SB1 RAGProvider 계약`, `D-SB2 OrchestrationPolicy(LangGraph 회피 설계)`, `D-SB3 service manifest 스키마`
174:### Phase 1 — qwen3.6-27b-dense backend (GPU 경량, fixture 우선)
177:- **Slice SB-1** `service manifest 스키마 + loader`
178:  - 산출: `naia-adk/packages/skill-spec` 인접 `service-manifest` 스키마 + naia-agent `ServiceManifestLoader` 계약
179:  - S01 `pnpm exec naia-agent --service <manifest>` / S02 unit(스키마 검증) / S03 fixture-replay / S04 CHANGELOG / §D-SB3
180:- **Slice SB-2** `RAGProvider 계약 + naia-memory 결합`
181:  - 산출: `@nextain/agent-types` `RAGProvider`(zero-runtime-dep) + alpha-memory 결합 어댑터(host 주입) + turn-전 context 조립
183:- **Slice SB-3** `OrchestrationPolicy (stream-first DAG, LangGraph 회피)`
184:  - 산출: `OrchestrationPolicy` 계약 + 경량 executor(§3-A). B20 충돌 회피 설계 docs
186:- **Slice SB-4** `qwen3.6-27b-dense 통합 + agent-flow 평가(#31 결합)`
190:### Phase 2 — minicpm backend (GPU/ko-serve, 별 트랙 의존)
191:- **Slice SB-5** `minicpm /v1/realtime connector` (v2 계약 `localmodel-realtime-v2.md` rev2.1 준수, lab-proxy-live)
192:- **Slice SB-6** `라이브 e2e` (ko-serve worker GPU 단계 — ko-serve 트랙 PAUSED 해제 의존)
194:### Phase 3 — 비즈니스 layer
195:- **Slice SB-7** `naia-business-adk governance 스캐폴드` (RBAC roles + SDLC artifact 스키마 + manifest governance 래퍼 — 계약 미수정 A.11)
196:- **Slice SB-8** `멀티테넌시·License·audit 운영 경계 문서 + 데모`
198:### 외부 데모 최소 동작선 (MVP)
199:Phase 1 SB-1~SB-4 = **개인 layer 로 qwen3.6-27b-dense 기반 에이전트 서비스
200:1개가 manifest → RAG+memory+persona → 응답 → 평가수치까지 e2e**.
205:## 6. 가정 / 미해결 (karpathy #1 — 크로스리뷰가 때릴 지점)
207:1. **(가정)** "LangGraph" = orchestration *패턴* 요구지 라이브러리 강제 아님 → §3-A. 틀리면 §3-B 재검토.
208:2. **(가정)** service manifest 스키마 SoT = naia-adk (워크스페이스 소유 A.6). naia-agent 는 loader 계약만.
216:## 7. 크로스리뷰 대상 + 합의 게이트
218:- **리뷰 프로파일**: (a) architect — 레포 경계·불변식 일관성 (b) reference/matrix — B19/B20/Part A 위배·§D 정합 (c) paranoid — 누락·외부데모 리스크·F-rule
219:- **clean 기준**: Part A 불변식 위배 0 · 매트릭스 정면충돌 0 · 경계 모순 0 · 누락 원칙 0
220:- **합의 게이트(사용자 명시)**: 크로스리뷰 2x clean → 사용자 보고 → **합의 후에만** 코드(Slice SB-1) 착수.
224:## 변경 이력
225:- DRAFT v1 (2026-05-16): 초안. mandatory reads(4-repo Part A·matrix·slice-spine·dev-process·design-recheck·gap·direction) + naia-adk/business-adk 구조 기반. 크로스리뷰 대기.

codex
설계 초안의 자체 주장만 보면 안 되므로, 본문이 인용한 fork chain·소유권 문구도 원문으로 확인하겠습니다. 이 단계에서 실제 문서와 초안의 해석이 어긋나면 그 자체가 결함입니다.
exec
/bin/bash -lc "sed -n '140,310p' .agents/progress/naia-4repo-migration-plan.md" in /var/home/luke/alpha-adk
 succeeded in 0ms:
| 레포 | 역할 | 공개 |
|---|---|:---:|
| `naia-os` | Host (Tauri shell + OS image) | ✓ |
| `naia-agent` | Runtime 엔진 + 공개 인터페이스 SoT | ✓ |
| `naia-adk` | 워크스페이스 포맷 + 스킬 표준 | ✓ |
| `alpha-memory` | MemoryProvider 레퍼런스 구현 | ✓ |

### A.3 의존 방향 (불변식)

```
types, protocol, skill-spec   ← 모두 zero-runtime-dep
      ▲       ▲       ▲
      │       │       │
     type-only imports
      │       │       │
core, runtime, providers, messengers, observability
      ▲
      │  embeds
      │
   naia-os shell / CLI host
```

**규칙**:
- `@nextain/agent-types`·`@naia-agent/protocol`·`@naia-adk/skill-spec`는 zero-runtime-dep
- 이 셋은 서로 **type-only import** 가능 (컴파일 타임만, 런타임 의존 아님). 결과: 계약 간 의미적 결합은 용인, 런타임 순환은 금지.
- 구현 패키지(core/runtime/...)는 계약 패키지를 자유롭게 import
- 계약 패키지는 구현 패키지를 **절대** import 안 함

### A.4 패키지 (역할 단위 — 수는 실행 중 조정)

- 계약 3: `types`, `protocol`, `skill-spec`
- 구현 N: `core` · `runtime` · `providers` · `messengers` · `observability` · (옵션) `tts`/`cli`/`testing`
- **Capability 인터페이스는 `@nextain/agent-types` 소속** (zero-runtime-dep 유지).
- 축소 허용: 작업 편의에 따라 merge/split. 단 A.3 의존 방향 유지.
- **CLI 소유 = `naia-agent` 레포** (독립 패키지든 core binary 겸용이든 구현 선택이나, 소유 레포는 확정).

### A.5 계약 정의 (shape 원칙)

**`LLMClient`** — 스트리밍·툴콜·프롬프트 캐시 포함.
**`MemoryProvider`** — 최소 메소드 (`encode`/`recall`/`consolidate`/`close`) + **선택 Capability 인터페이스** (`BackupCapable`, `EmbeddingCapable`, `KnowledgeGraphCapable`, `ImportanceCapable`, `ReconsolidationCapable`, `TemporalCapable`). 구현체가 지원하는 capability만 implements. 소비자는 `if (isCapable(x, KnowledgeGraphCapable))`로 확인.
**`ToolExecutor`** — tier 기반 권한. `#198` CommandExecutor 승계.
**`SkillLoader`** — `@naia-adk/skill-spec`에 정의. agentskills.io 준수.
**`HostContext`** — 필수 최소(llm, memory, logger)와 확장 capability 분리. `HostContext.Core`, `HostContext.Full` 서브셋 허용.
**`Event`** — `trace_id`, `span_id` 포함. optional `viseme?` 필드.
**`ErrorEvent`** — 실패 전파 계약. `error_code`(i18n-ready), `severity`(info/warn/error/fatal), `retryable: boolean`. 예외는 runtime 내부 용도, 경계 넘는 실패는 ErrorEvent로. (용어 분리: `tier`는 권한 T0-T3 전용, `severity`는 실패 심각도 전용.)
**`Logger` / `Tracer` / `Meter`** — observability 계약. `observability` 패키지는 이 계약의 기본 구현체. 계약 자체는 `types`.
**`TierLevel` (T0|T1|T2|T3) + semantic** — 각 tier의 의미(허용 행위·승인 주체·로깅 요구)는 `types` 소속. 구현체는 이 의미를 준수.
**`SessionLifecycle` 상태 전이** — `created → active → paused → resumed → closed | failed`. `fatal` severity ErrorEvent 발생 시 `failed` 전이. `naia-agent/core`가 로직 소유, `alpha-memory`는 저장만.
**`ApprovalFlow` 상태기계** — `requested → pending → {approved|denied|timeout}`. 전이 trigger는 shell이 `ApprovalBroker.decide()` 호출. Timeout 정책은 `types`의 기본 상수(구현은 오버라이드 가능). shell이 UI 소유, runtime이 state 보유.

shape은 고정, 필드는 추가 허용 (additive). 삭제/타입변경은 MAJOR.

**Capability 확장 거버넌스**: 새 Capability는 `@nextain/agent-types` PR로 추가 (additive). 구현체는 지원 capability를 명시적 implement. 거부·deprecation은 MAJOR 사유. **Capability 조합 의미론**은 각 Capability 정의 문서에서 명시 (예: `KnowledgeGraphCapable + TemporalCapable` 조합 규칙은 `TemporalCapable` 문서에 명시).

**Observability 의무 메타 원칙**: 모든 구현 패키지는 **주요 상태 전이**에서 `Event` emit 의무. "주요 상태 전이" = 상태 변경, 경계 교차 호출, 에러 발생. 로그 없음 = 계약 위반.

### A.6 소유권 (누가 무엇을)

| 관심사 | 소유 레포/패키지 |
|---|---|
| Device identity (Ed25519) | shell stronghold |
| LLM API keys | shell stronghold → providers에 주입 |
| Discord bot token, OAuth tokens | shell stronghold → messengers에 주입 |
| Tier T0-T3 승인 UI/결정 | shell |
| Tier enforcement | `runtime.ToolExecutor` |
| Credits counter/dashboard | shell |
| Credits usage emission | providers (via `HostContext.meter`) |
| Skill 정의 포맷 | `naia-adk/skill-spec` |
| Skill 실행 | `naia-agent/runtime` |
| Workspace 파일 구조 | naia-adk |
| 세션/장기 메모리 저장 | alpha-memory (MemoryProvider 구현체) |
| Tauri plugin (native Rust) — stt, shell, store | shell 잔류 |
| `src-tauri/src/*.rs` 백엔드 | **shell 잔류**. spawn 로직만 naia-agent CLI entry로 리타깃. Rust 내부 로직 이주 없음. |
| 3D 아바타 렌더링 (`three`, `@pixiv/three-vrm`) | shell |
| BlueBuild OS 이미지 | shell (recipes/, config/) |
| Flatpak/NSIS/MSI packaging | shell |
| naia-os-specific verify skills (`.claude/skills/verify-*`) | naia-os 잔류 |
| cross-review / review-pass 메타 스킬 | naia-adk (공통) |
| **Skill 소유 판정 기본 규칙** | naia-adk 기본값. **naia-os-specific API**(Tauri plugin, BlueBuild, hardware tier, VRM 등)를 참조하는 skill만 naia-os |
| **Voice I/O (TTS/STT) 소유권 원칙** | 공개 I/O 계약(`VoiceEvent` — `audio_chunk`, `viseme`, `transcript`)은 `@nextain/agent-types` 소속. 실행 layer(어디서 돌리는가)는 Part B |
| Telemetry · crash reporting · auto-update | shell (OS 레이어) |
| Audit log 저장·보존 정책 | shell (tamper-evident, 최소 30일) |
| License 검증 (business-adk 유료 영역) | naia-business-adk (다운스트림) |
| i18n 번역 리소스 (`.users/` 미러) | 각 repo 자체 소유 |
| Error message 번역 | shell (error_code → 지역화 문자열) |
| Downstream fork 업스트림 merge | 각 포크 본인 책임 (alpha-adk는 nextain-adk 트래킹) |

### A.7 Enforcement (1인 개발자 현실)

`#227` freeze는 1인 구조에서 branch protection이 형식뿐이라는 한계를 인정. 대신:
- **`migration/*` branch prefix 규칙**: migration 관련 PR은 이 prefix 필수. 다른 브랜치에서 `naia-os/agent/**` 수정 금지 (self-discipline + PR 템플릿 체크리스트).
- **Label `migration-phase`**: 정보 제공용 태깅 (강제 아님).
- **자기 리뷰 규약**: PR 머지 전 24h 대기 + checkout 후 E2E 1회 실행.
- **Freeze 유효 기간**: MVM 착수 시점부터 Phase 3 O1 완료(shell에서 agent/ 디렉터리 제거)까지. 이후엔 해당 경로 자체 부재로 자연 종료.

Branch protection + CODEOWNERS는 시도하되 "실패 시 허용" (1인 현실 인정).

### A.8 Release 정책

- 각 repo 독립 semver. 공통 버전 동기화 안 함.
- `@nextain/agent-types` MAJOR = shape 파괴. MINOR = 추가. PATCH = 내부.
- `@naia-agent/protocol` 별도 semver. wire 변경 ≠ types MAJOR.
- `@naia-adk/skill-spec` 별도 semver. naia-adk 태그와 **lockstep 아님** — 독립 릴리스 OK, 대신 호환 테이블 문서화.
- alpha-adk 서브모듈 pointer = X-item merge 배치 업데이트.

### A.9 Strangler Fig 원칙

- Big-bang 추출 금지. 각 패키지 추출 → 즉시 shell 연결 → CI green → Flatpak 스모크.
- **Lockstep merge 순서 원칙**: agent repo PR 선행 merge → shell repo PR이 새 버전 import하며 merge. shell이 먼저면 연결 대상 없음.
- **Lockstep = self-discipline** (A.7과 동급). branch protection 강제 불가 인정.
- **MVM 단계는 Lockstep 예외**: MVM 완료 전까지는 naia-agent가 부분 스캐폴드 상태이므로 lockstep 적용 제외. Phase 0 이후부터 발효.
- 롤백: PR 단위 revert. 양 repo 순차 revert (agent → shell 역순).
- **롤백 임계점 원칙**: 지속적 복구 불가 CI 실패 OR E2E 기능 동일성 미달 OR Flatpak build break. (구체 관찰 기간은 운영 정책 문서.)
- **Abort 조건 원칙**: MVM 실패 OR A.3 의존 방향이 실제 코드에서 성립 불가 판명 OR 다수의 해결 불가 블로커 발생. 이 중 하나면 계획 전체 재설계.
- 진행 중이던 기능 이슈(#213, #220 등)는 `naia-os/agent/**` 제외 영역에서 계속 병행 가능.
- **X5 flip-day는 예외가 아님** — strangler 경로에서 이미 구축된 v2 프로토콜로 switchover이지 신규 이주 아님.

### A.10 MVM (최소 증명)

**착수 순서** (원칙):
1. 알파메모리 실체 확인 + MemoryProvider 기본 4메소드 매핑 초안
2. `@nextain/agent-types` 초기 shape + `LLMClient` 계약 공개
3. Anthropic 1종 `LLMClient` 구현 + shell에서 실제 호출
4. Flatpak 빌드 1회 green
5. `migration/*` branch prefix 규약 시행 + PR 템플릿

**선행 조건**: MVM 착수 전 각 active repo(`naia-os`, `naia-agent`, `naia-adk`, `alpha-memory`)에 최소 CI skeleton 보유. 없으면 #1 착수와 동시에 S7 CI template 생성 PR.

**성공 기준**: shell이 `@naia-agent/*` 1개 패키지라도 실제 소비 + 사용자에게 기능 동일.

**실패 기준** (Abort 트리거): 
- 합리적 관찰 기간 내 성공 기준 미달 → 계획 재설계
- 1~2단계에서 A.3 의존 방향 성립 불가 발견 → 계획 재설계
- 3단계에서 Anthropic SDK + pnpm/npm 통합 기술적 불가 → 기술 선택 재검토

**MVM ↔ 본 계획 전이 게이트 원칙**: MVM 성공은 본 계획 **재검토 입력**. 자동 승격 아님. 본 계획 Phase 0 재평가 후 진입.

**MVM 첫 PR 위치 원칙**: 검증 대상 repo 자체. #1 "알파메모리 실체 확인" → 첫 PR은 `alpha-memory` 또는 `naia-agent/docs/` 내 audit 문서.

---

### A.11 교차 관심사 원칙 (5·6라운드 반영)

- **Observability emit 의무**: 모든 구현은 주요 상태 전이에서 Event emit. 로그 없음 = 계약 위반 (A.5에서 재강조).
- **Error 전파**: 경계 간 실패는 `ErrorEvent` shape으로. 예외(throw)는 내부 전용. runtime은 `error_code`만 emit, 사람이 읽는 번역은 shell 전용.
- **Audit**: shell 소유. tamper-evident. 법적/운영 최소 기간 보존(구체 일수는 운영 정책 문서). tier T2+ 행위는 필수 기록.
- **i18n**: `.users/` 미러는 각 repo 소유. Error message는 `error_code` 기반, 번역은 shell에서.
- **라이선스 경계**: 공개 4 repo Apache 2.0. 유료 확장(`naia-business-adk`)은 공개 계약 **구현만** 허용, 계약 수정 금지. **공개 4 repo의 계약만 canonical** — private fork의 계약 변종은 비공식.
- **외부 소비자 호환**: `naia-adk/skill-spec`은 agentskills.io MAJOR 하위 호환 유지. claude-code/opencode/codex 등 외부 도구가 소비하는 포맷 안정성 보장.
- **Regression 금지**: 공개 릴리스 전 유의미한 품질·latency regression 발견 시 release block. 측정 범위: memory benchmark, tool-call 성공률, stream TTFB. 구체 임계치는 운영 정책.
- **Communication**: 공개 릴리스 이후 MAJOR breaking change는 합리적 사전 공지 + CHANGELOG + 4 repo 간 cross-link. MVM/Phase 0 내부는 면제.
- **Graceful degradation**: Capability 부재는 에러가 아닌 "기능 없음". 소비자는 Capability 확인 후 사용.
- **Observability "주요 상태 전이" 정의자**: Event emit 범위는 각 계약 문서에서 명시 (`Session` 문서에 Session 전이, `ToolCall` 문서에 tool 전이).

### A.12 비기능 원칙 블록 (6라운드 Gap Hunter 반영)

- **Configuration 오버라이드 체인**: CLI flag > env var > config file > defaults. 4 repo 공통.
- **Retry/backoff 책임 분할**:
  - **Transport 실패** (network, rate-limit) → `providers` 계층 책임
  - **Business 실패** (tool timeout, approval denied) → `runtime` 계층 책임
  - `ErrorEvent.retryable` 필드가 계층 판단의 hint.
- **데이터 이식성**: `MemoryProvider`는 `ExportCapable` 옵션 인터페이스 보유 권장. 포터블 포맷 (JSON lines 기본) 지원 시 다른 구현체로 이식 가능.
- **성능 SLO 입장**: 성능은 **구현 의무**이며 계약의 일부 아님. 단, 공개 릴리스는 baseline SLO 문서화 필요.
- **동시성 원칙**: 단일 `HostContext` = 단일 session. 다중 session 필요 시 다중 HostContext (호스트가 관리). runtime은 세션 간 격리 보장.
- **Public API 안정성**: `@nextain/agent-types`·`@naia-agent/protocol`·`@naia-adk/skill-spec`은 **외부 소비자 대상 공개 계약**. v1.0 이후 MAJOR 변경은 A.11 communication 원칙 적용.
- **버전 지원 기간**: 직전 MAJOR는 신규 MAJOR 배포 후 최소 1 릴리스 사이클 co-maintain.

### A.13 보안 패치 원칙

- 취약점(CVE-worthy)은 **lockstep 면제**. 즉시 패치 배포 허용.
- 패치 후 공개 보안 공지(CHANGELOG security 섹션) 의무.

exec
/bin/bash -lc "sed -n '1,220p' projects/naia-adk/.agents/progress/agent-service-builder-architecture.md" in /var/home/luke/alpha-adk
 succeeded in 0ms:
<!-- 설계 문서 (DRAFT v1) — 크로스 리뷰 전. 사용자 합의 게이트 전 코드 착수 금지.
     SoT 경계: 4-repo Part A(alpha-adk, F07 수정금지) 위에 얹는 확장.
     신규 런타임 패턴 = naia-agent ref-adoption-matrix §D 신설 + sub-issue.
     cross-ref: nextain/naia-agent#31 (평가 프레임웍 = 본 우산의 하위 검증 layer). -->

# Agent Service Builder — 아키텍처 설계 (DRAFT v1)

> **목적**: naia-agent 풀셋(LLM + persona/system-prompt + naia-memory + RAG +
> orchestration)으로 **다양한 에이전트 서비스를 정의·운영·평가**하는 기반을
> 개인(naia-os) / 비즈니스(naia-business-adk) 2-layer 로 구축.
> **계기**: 외부 에이전트 개발 의뢰 — 데모 제출 예정 (실전 가치 우선).
> **워크플로 (사용자 directive)**: 설계 → **크로스 리뷰 필수** → **합의·보고** → 개발.

---

## 0. 범위 / 비범위

| | |
|---|---|
| **In** | 레포 관계 정합 · 에이전트 서비스 빌더 layer 설계 · 개인/비즈니스 경계 · backend-agnostic(qwen3.6-27b-dense / minicpm) · 구체 구현계획(slice) |
| **Out** | Part A 원칙 수정(F07) · agent-loop D1~D8 수정(F06) · ko-serve 모델/serving(별 repo, v2 계약 제공) · 실제 코드 착수(합의 게이트 전) |

---

## 1. 레포 관계 — 직교 2축 (사용자 "잘 설명" 핵심)

레포 관계는 **하나의 트리가 아니라 직교하는 2축**이다. 이걸 섞으면 혼란이 생긴다.

### 축 1 — 런타임 의존 (Part A.3 불변식, 변경 불가)

```
naia-os (host)            Tauri shell · 3D avatar · OS image · 승인 UI · audit · identity
   │  embeds  (interface, NOT dependency — host 가 구현체 주입)
   ▼
naia-agent (Runtime SoT)  Agent loop · 공개 계약(LLMClient/MemoryProvider/
   │                       ToolExecutor/SkillLoader/HostContext) · CLI 소유
   │  contracts injected by host:
   ├── alpha-memory (= naia-memory)   MemoryProvider 레퍼런스 구현
   └── @naia-adk/skill-spec           스킬 표준 (zero-runtime-dep 계약)
```
- **불변식**: 4 repo 런타임 결합 금지. `naia-agent` 는 alpha-memory·naia-adk 를
  import 안 함. 계약 3개(types/protocol/skill-spec) = zero-runtime-dep.
- LLM provider = D44 (Vercel AI SDK 단일 abstraction) + naia-anyllm gateway 경유 가용성.

### 축 2 — 워크스페이스 Fork Chain (거버넌스 상속)

```
naia-adk            personal base   (public, Apache 2.0) — 워크스페이스 포맷·스킬·persona·process
   └── naia-business-adk   business upstream — 조직 거버넌스(assets/process/permissions·RBAC·SDLC)
         └── {company}-adk        company instance   (예: nextain-adk)
               └── {member}-adk   company-linked personal   (예: alpha-adk)
```
- **공개 계약 canonical 원칙(A.11)**: 유료/하류 fork 는 공개 계약을 **구현만**.
  계약 수정 금지. private fork 의 계약 변종은 비공식.
- **License 검증 소유(A.6)** = naia-business-adk (다운스트림).

### ⚠️ 정정 필요 — Fork chain 문서 불일치 (본 설계가 해소)

| 출처 | 현재 표기 | 판정 |
|---|---|---|
| `naia-adk/AGENTS.md` §Fork Chain | `naia-adk → {org}-adk → {user}-adk` (3단계, business 누락) | **outdated** — generic |
| `naia-business-adk/README` | `naia-adk → naia-business-adk → {company}-adk → {member}-adk` | **canonical** (business upstream 명시) |

→ 본 설계 채택 = **4단계 (business upstream 명시)**. naia-adk/AGENTS.md Fork Chain
섹션을 canonical 로 정합 (Sync phase, Cascade rule 적용 — AGENTS↔CLAUDE↔GEMINI).

### 두 축의 결합점

```
워크스페이스(축2)가 "무엇을(persona/skill/RAG/memory 바인딩)" 정의 →
런타임(축1) naia-agent 가 "어떻게(loop/계약/주입)" 실행 →
host(개인=naia-os / 비즈니스=naia-business-adk 다운스트림)가 "어디서(배포·권한·과금)" 운영
```

---

## 2. 에이전트 서비스 빌더 — layer 구조

**핵심 명제**: "에이전트 서비스" = (persona + skill set + RAG source + memory
binding + LLM backend + orchestration policy) 의 선언적 묶음. 이 묶음을
**naia-adk 워크스페이스 manifest** 로 정의하고, naia-agent 런타임이 실행한다.

```
┌─ Service Definition (naia-adk 워크스페이스 = 작업 폴더) ───────────┐
│  service.manifest:  persona(packages/persona) + skills(skill-spec) │
│                      + rag.sources + memory.binding + llm.backend  │
│                      + orchestration(graph) + eval.fixtures        │
└───────────────────────────┬───────────────────────────────────────┘
                            │ naia-agent 가 manifest 소비 (계약 주입)
┌─ Runtime (naia-agent, SoT) ▼ ─────────────────────────────────────┐
│  Agent loop · LLMClient(D44) · MemoryProvider · ToolExecutor       │
│  + [신규] RAGProvider 계약 · OrchestrationPolicy 계약              │
└───────────────────────────┬───────────────────────────────────────┘
                            │ host 주입·운영
┌─ Operate ──────────────────▼──────────────────────────────────────┐
│  개인:   naia-os (Tauri host, 단일 사용자)                          │
│  비즈니스: naia-business-adk 다운스트림 (RBAC·멀티테넌시·과금·audit) │
└───────────────────────────────────────────────────────────────────┘
```

### 평가 프레임웍(#31)의 위치 — 우산의 하위

#31 = "검증 가능한 agent-flow 성능 평가". 본 빌더의 **하위 검증 layer**:
서비스 manifest 의 `eval.fixtures` 가 #31 하니스 입력. 빌더가 헤드라인,
평가는 그 품질 게이트. → **#31 보강** (신규 이슈 아님; 우산 sub-issue 추가).

### 풀셋 매핑 (사용자 "LLM + persona/system prompt + naia-memory + RAG + langraph")

| 요소 | 소유 | 계약/구현 |
|---|---|---|
| LLM | naia-agent providers | D44 Vercel AI SDK adapter (qwen3.6-27b-dense via `@ai-sdk/openai-compatible` → naia-model-infra vllm-coding / minicpm via lab-proxy-live `/v1/realtime`) |
| persona / system prompt | naia-adk `packages/persona` | manifest `persona` 필드 → Agent system 조립 |
| memory | alpha-memory(naia-memory) | MemoryProvider 계약 (기존) |
| **RAG** | **신규 — naia-agent `RAGProvider` 계약** | host 주입. retrieval→context. matrix **§D 신규** |
| **orchestration (LangGraph)** | **신규 — `OrchestrationPolicy` 계약** | ⚠️ §3 제약 참조 |

---

## 3. ⚠️ LangGraph 제약 — 매트릭스 충돌 해소 (크로스리뷰 핵심 공격점)

naia-agent ref-adoption-matrix 에서 **이미 거부됨**:
- **B19**: LangChain `@langchain/core` 직접 의존 거부 (zero-runtime-dep 위배)
- **B20**: LangGraph StateGraph 채널 reducer 거부 (D1 stream-first 모델 충돌)
- C05: Checkpoint 패턴 = 이연(후보)

**그러므로 "LangGraph 직접 채택" 은 Part A.3 / 매트릭스 위배.** 해소안 (택1, 크로스리뷰 판정):

| 안 | 내용 | 매트릭스 영향 |
|---|---|---|
| **A (권고)** | `OrchestrationPolicy` 자체 계약(zero-runtime-dep) + naia-agent 내 경량 graph executor (stream-first 보존). LangGraph 는 *패턴 참조*만 | §D 신규 (B20 의 "reducer 모델 충돌" 회피 설계 명시) |
| B | host opt-in peer-dep (`@langchain/langgraph` 를 host 가 설치, naia-agent 는 adapter 계약만) — D44 의 peer-dep 선례 | §D 신규 + B19 demote 논거 필요 |
| C | LangGraph 전면 채택 | **거부** — B19/B20 정면 위배, Part A.3 깨짐 |

→ **A 채택 제안**. orchestration = stream-first AsyncGenerator 위 DAG step.
크로스리뷰가 "A 가 정말 B20 충돌을 피하는가" 를 검증.

---

## 4. 개인 vs 비즈니스 경계 (사용자 "경계 적절히, 개인도 필요부분")

| 관심사 | 개인 (naia-adk + naia-os) | 비즈니스 (naia-business-adk 다운스트림) |
|---|---|---|
| 워크스페이스 manifest | ✅ 정의·실행 | ✅ 상속 + governance 래핑 |
| persona / skill / RAG / memory | ✅ 전부 | ✅ + 조직 자산 바인딩(assets) |
| 실행 host | naia-os (단일 사용자, Tauri) | 서버/멀티테넌시 (naia-business-adk 운영) |
| 권한 | 단일 사용자 (T0~T3 self) | **RBAC** (author/reviewer/approver/releaser/auditor) |
| 승인 | naia-os ApprovalBroker | 위임 승인 체인 (delegated) |
| audit / SDLC artifact | naia-os audit log | **SDLC tracking** (req/design/decision/review/release/postmortem) |
| License / 과금 | 없음 (Apache 2.0) | naia-business-adk License 검증 (A.6) |
| disclosure 경계 | 개인 자율 | 조직 disclosure boundary |

**원칙**: 개인 layer 가 완전 자족(외부 데모 = 개인 layer 로 동작 가능해야).
비즈니스 layer = 개인 base 의 **상위 래핑**(거버넌스 추가), 계약 수정 X (A.11).

### naia-adk ↔ naia-business-adk 경계 (구체)

- `naia-adk` = personal base. 워크스페이스 포맷·service manifest 스키마·기본 스킬·persona/process packages. **service manifest 스키마 SoT 여기**.
- `naia-business-adk` = business upstream. README 가 명시: "not just premium skill bundle. Skills are one output of the model, not the whole product." → governance 모델(assets/process/permissions, RBAC, SDLC)이 본체. 현재 **거의 백지(README only) = 본 설계의 신규 구축 대상**.
- 경계선: **manifest 스키마·런타임 계약 = naia-adk(canonical). governance 확장 = naia-business-adk(구현만, 스키마 미수정).**

---

## 5. 구체적 구현 계획 (사용자 "구현계획 구체적으로")

naia-agent dev-process 준수: slice 단위 · F-rule · matrix §D ID 인용 ·
karpathy 4원칙 · cross-review 2 consecutive clean. **#31 우산 sub-issue.**

### Phase 0 — 합의 게이트 (코드 0줄)
- [ ] 본 설계 크로스 리뷰 (Codex + Gemini, different-profile 2x clean)
- [ ] 리뷰 종합 → 사용자 보고 → **합의** (사용자 명시 게이트)
- [ ] #31 보강(우산 재프레이밍) + sub-issue 등록 (외부 push = 사용자 승인)
- [ ] matrix §D 신규 항목 초안: `D-SB1 RAGProvider 계약`, `D-SB2 OrchestrationPolicy(LangGraph 회피 설계)`, `D-SB3 service manifest 스키마`

### Phase 1 — qwen3.6-27b-dense backend (GPU 경량, fixture 우선)
> qwen = 표준 chat API → fixture-replay 단순 → **1차 backend**.

- **Slice SB-1** `service manifest 스키마 + loader`
  - 산출: `naia-adk/packages/skill-spec` 인접 `service-manifest` 스키마 + naia-agent `ServiceManifestLoader` 계약
  - S01 `pnpm exec naia-agent --service <manifest>` / S02 unit(스키마 검증) / S03 fixture-replay / S04 CHANGELOG / §D-SB3
- **Slice SB-2** `RAGProvider 계약 + naia-memory 결합`
  - 산출: `@nextain/agent-types` `RAGProvider`(zero-runtime-dep) + alpha-memory 결합 어댑터(host 주입) + turn-전 context 조립
  - S01 `--rag <source>` / S02 unit(retrieval merge) / S03 실 alpha-memory 호출 / S04 / §D-SB1
- **Slice SB-3** `OrchestrationPolicy (stream-first DAG, LangGraph 회피)`
  - 산출: `OrchestrationPolicy` 계약 + 경량 executor(§3-A). B20 충돌 회피 설계 docs
  - S01 `--graph <policy>` / S02 unit(step 순서·중단) / S03 fixture multi-step / S04 / §D-SB2
- **Slice SB-4** `qwen3.6-27b-dense 통합 + agent-flow 평가(#31 결합)`
  - 산출: D44 `@ai-sdk/openai-compatible` → naia-model-infra vllm-coding(8000) 어댑터 + #31 하니스로 e2e 품질 측정(fixture-replay 우선, G15)
  - S01 `--backend qwen` / S02 unit / S03 fixture e2e(RAG+memory+persona+qwen) / S04 / §D + #31 cross-ref

### Phase 2 — minicpm backend (GPU/ko-serve, 별 트랙 의존)
- **Slice SB-5** `minicpm /v1/realtime connector` (v2 계약 `localmodel-realtime-v2.md` rev2.1 준수, lab-proxy-live)
- **Slice SB-6** `라이브 e2e` (ko-serve worker GPU 단계 — ko-serve 트랙 PAUSED 해제 의존)

### Phase 3 — 비즈니스 layer
- **Slice SB-7** `naia-business-adk governance 스캐폴드` (RBAC roles + SDLC artifact 스키마 + manifest governance 래퍼 — 계약 미수정 A.11)
- **Slice SB-8** `멀티테넌시·License·audit 운영 경계 문서 + 데모`

### 외부 데모 최소 동작선 (MVP)
Phase 1 SB-1~SB-4 = **개인 layer 로 qwen3.6-27b-dense 기반 에이전트 서비스
1개가 manifest → RAG+memory+persona → 응답 → 평가수치까지 e2e**.
이게 외부 의뢰 데모의 최소 제출선.

---

## 6. 가정 / 미해결 (karpathy #1 — 크로스리뷰가 때릴 지점)

1. **(가정)** "LangGraph" = orchestration *패턴* 요구지 라이브러리 강제 아님 → §3-A. 틀리면 §3-B 재검토.
2. **(가정)** service manifest 스키마 SoT = naia-adk (워크스페이스 소유 A.6). naia-agent 는 loader 계약만.
3. **(미해결)** RAG source 추상화 범위 (벡터스토어/파일/웹 — 어디까지 1차). 크로스리뷰 + 사용자.
4. **(미해결)** 외부 데모 시한·평가 기준(무엇을 "보여드릴" 성공으로 볼지) → 사용자 확인 필요.
5. **(제약)** naia-agent R5 LOCKED → 본건 R6. F01(스켈레톤 게이트)·F06·F07·F08(OPEN P0) 상태 재확인 필요(슬라이스 착수 전).
6. **(정정)** Fork chain 4단계로 문서 정합 (§1.3).

---

## 7. 크로스리뷰 대상 + 합의 게이트

- **리뷰 프로파일**: (a) architect — 레포 경계·불변식 일관성 (b) reference/matrix — B19/B20/Part A 위배·§D 정합 (c) paranoid — 누락·외부데모 리스크·F-rule
- **clean 기준**: Part A 불변식 위배 0 · 매트릭스 정면충돌 0 · 경계 모순 0 · 누락 원칙 0
- **합의 게이트(사용자 명시)**: 크로스리뷰 2x clean → 사용자 보고 → **합의 후에만** 코드(Slice SB-1) 착수.

exec
/bin/bash -lc "sed -n '1,140p' projects/naia-adk/AGENTS.md" in /var/home/luke/alpha-adk
 succeeded in 0ms:
# Naia ADK

AI Development Kit — an open-source framework for personal and business AI operations.
Fork, configure, connect to your AI tools. [`nextain/naia-adk`](https://github.com/nextain/naia-adk)

## Fork Chain

```
naia-adk                  ← Base (public, Apache 2.0)
  └── {org}-adk           ← Organization fork: company data + business submodules
        └── {user}-adk    ← Personal fork: personal data + project submodules
```

Fork on GitHub, then periodically sync upstream: `git fetch upstream && git merge upstream/main`

## Mandatory Reads

**Read these files at the start of every session:**

1. `.agents/context/agents-rules.json` — Project rules (SoT)
2. `.agents/context/ai-work-index.yaml` — Work type → workflow index
3. `.agents/context/project-index.yaml` — Context index + entry points

**On-demand (read when entering Plan or Review phases):**

4. `.agents/requirements/_index.yaml` — Product requirements index
5. `.agents/context/skills-index.yaml` — Skill trigger/summary index

## Project Structure

### Workspace Directories

| Directory | Tier | Purpose |
|-----------|------|---------|
| `data-company/` | T2 | Company general data (gitignored, per-fork) |
| `data-business/` | T3 | Company sensitive data (gitignored, per-fork) |
| `data-private/` | T3 | Personal data (gitignored, per-fork) |
| `projects/` | T2 | Project repos (gitignored, per-fork) |
| `projects/refs/` | T2 | Reference repos (gitignored, per-fork) |
| `skills/` | T1 | AI skills |
| `packages/` | T1 | Runtime packages (future) |
| `scripts/` | T1 | Utility scripts, tools |
| `templates/` | T1 | Document templates |
| `docs/` | T1 | Architecture, specs |

### Fork Customization

After forking, create a `FORK.md` in the fork root with:

- Organization/user info
- Project list (submodules in `projects/`)
- Data submodules (`data-company/`, `data-teams/`)
- Default language for `.users/` mirror
- Any fork-specific conventions

## Development Process

### Feature Development (default) — Issue-Driven Development

For feature-level work (new features, broad bug fixes). **14 phases:**

1. **Issue** — Create or receive GitHub Issue (English)
2. **Understand** — Summarize understanding, get user confirmation (gate)
3. **Scope** — Define investigation scope/depth, user approval (gate)
4. **Investigate** — Code-centric investigation within confirmed scope
5. **Plan** — Comprehensive plan based on ALL findings, user approval (gate)
6. **Build** — Implement according to approved plan
7. **Review** — Iterative review (repeat until TWO consecutive clean passes) → run `/verify-implementation`
8. **E2E Test** — Run actual app/server, targeted tests first then full suite
9. **Post-test Review** — Re-review after tests pass (repeat until TWO consecutive clean passes) → run `/verify-implementation`
10. **Sync** — Update `.agents/` + `.users/` context → run `/manage-skills` → user confirmation (gate)
11. **Sync Verify** — Verify context accuracy (repeat until TWO consecutive clean passes)
12. **Report** — Summarize results to user
13. **Commit** — If in worktree: use `/merge-worktree`. Otherwise: commit referencing Issue number, create PR
14. **Close** — Phase-by-phase completion report to issue comments + user confirmation (gate)

**Iterative review applies at 5 points:** After Plan, after each Build phase, after all Build phases, after E2E Test, after Sync.

**Principles:** Read upstream code first. Minimal modification. Never break working code. Propose improvements, never decide autonomously.

**Progress file (MANDATORY):** At every phase transition, write/update `.agents/progress/{issue-slug}.json`.

### End of EVERY session (mandatory)

Before ending any session, ALWAYS:
1. Update context files with new knowledge (.agents/ ↔ .users/ ↔ entry point files)
2. Record lessons-learned if corrections or mistakes occurred
3. Commit and push all changes

This transfers your learning to the next AI session.

### Simple Changes (lightweight cycle)

For non-feature changes: typos, config values, simple directives.

## Skills

AI assistant skills. **SoT: `.agents/skills/`** — `.claude/skills/` is symlinks.

### Base Skills

| Skill | Description | Management |
|-------|-------------|------------|
| `review-pass` | Multi-agent cross-validation review (4 stages) | Auto (phase 7, 9) |
| `verify-implementation` | Run all `verify-*` skills, generate unified report | Auto (phase 7, 9) |
| `manage-skills` | Analyze changes, create/update `verify-*` skills | Auto (phase 10) |
| `merge-worktree` | Squash-merge worktree → main with semantic commits | Manual (phase 13) |
| `read-doc` | Extract text from HWP/PDF/DOCX/XLSX/PPTX | Manual |
| `webapp-testing` | Playwright E2E testing for local web apps | Manual |
| `doc-coauthoring` | Structured document co-authoring (3-step) | Manual |

### Business Extension Skills

Available in `naia-business-adk`:

| Skill | Description | Management |
|-------|-------------|------------|
| `payroll` | Payroll PDF generation + email dispatch | Manual |
| `press-release` | Press release writing, outreach, distribution | Manual |
| `patent-draft` | KIPO-format patent specification drafting | Manual |
| `patent-pipeline` | AI patent discovery, evaluation, and filing | Manual |
| `copyright-reg` | Copyright registration document generation | Manual |
| `weekly-report` | Weekly work report from git commits | Manual |
| `email` | Email composition and dispatch | Manual |
| `sms` | SMS notification sending | Manual |
| `channel-management` | Multi-channel communication management | Manual |
| `service-management` | Service monitoring and management | Manual |
| `web-monitoring` | Web content monitoring and alerting | Manual |
| `document-generation` | Automated document generation | Manual |

## Directory Structure (Dual-directory Architecture)

```
.agents/                    # AI-optimized (English, token-efficient)
├── context/
│   ├── agents-rules.json   # Main rules (SoT) ← mandatory read
│   └── ai-work-index.yaml  # Work index ← mandatory read
├── workflows/              # Development workflows
├── skills/                 # Skill definitions (SoT)
├── hooks/                  # AI session hooks

exec
/bin/bash -lc "sed -n '1,180p' projects/naia-business-adk/README.md" in /var/home/luke/alpha-adk
 succeeded in 0ms:
[English](README.md)

# Naia Business ADK

**Organizational AI operating system extension for Naia workspaces.**

Naia Business ADK is the business upstream of `naia-adk`.
It extends the personal base with organizational governance for:

- **assets** — repos, documents, secrets, customer data, brand assets
- **process** — workflows, approvals, publishing, deployment, review
- **permissions** — team ownership, delegated approval, disclosure boundaries

For business use, this should explicitly include:

- **RBAC** — author, reviewer, approver, releaser, auditor roles
- **SDLC artifact tracking** — requirements, design docs, decision records, plans, reviews, tests, release artifacts, postmortems

This is not just a premium skill bundle. Skills are one output of the model, not the whole product.

## Position in the Fork Chain

```text
naia-adk
  → personal base
naia-business-adk
  → business upstream
{company}-adk
  → company instance
{member}-adk
  → company-linked personal instance
```

Examples:

```text
naia-adk → naia-business-adk → nextain-adk → alpha-adk
naia-adk → naia-business-adk → onmam-adk
```

## What It Adds

Compared to `naia-adk`, `naia-business-adk` adds organizational concerns:

- team ownership and role boundaries
- approval-gated operations
- RBAC and delegated approval
- SDLC deliverable ownership and retention
- customer / legal / finance sensitivity handling
- business workflow expectations and templates
- company instance and member instance operating patterns

## What Stays Out

`naia-business-adk` is still an upstream layer. It should not become:

- a single company's source of truth
- a single member's workspace
- a dump of customer-specific internal rules

Those belong in company instances such as `nextain-adk`, and in member instances such as `alpha-adk`.

## Public vs Private Description

It is valid to publicly describe:

- that `naia-business-adk` exists
- that it is the organizational extension of `naia-adk`
- that it governs assets, process, and permissions for AI operations

It is not necessary to publicly expose by default:

- internal repo topology
- customer-specific workflow internals
- production approval chains

## Status

This repository is the business upstream. Company-specific products, data, and policy should be layered in downstream company instances.

codex
B20 판단은 결국 D1 stream-first 의미를 어떻게 해석하느냐에 달려 있으니, agent-loop 설계의 원문도 확인하겠습니다. 이름만 바꾼 reducer면 그대로 위배입니다.
exec
/bin/bash -lc "rg -n '"'^#|''^##|''^###|D1|D2|D3|D4|D5|D6|D7|D8|stream-first|reducer|StateGraph|AsyncGenerator|graph|orchestration'"' projects/naia-agent/docs/agent-loop-design.md" in /var/home/luke/alpha-adk
exec
/bin/bash -lc "sed -n '1,220p' projects/naia-agent/docs/agent-loop-design.md" in /var/home/luke/alpha-adk
 succeeded in 0ms:
1:# Agent Loop Design — references and decisions
6:## References surveyed
15:## Decisions
17:### D1. Stream-first API, `send()` as drain wrapper
20:Agent.sendStream(userText, signal?): AsyncGenerator<AgentStreamEvent>
30:### D2. Compaction delegated to MemoryProvider via `CompactableCapable`
47:### D3. Compaction policy constants (agent-side)
58:### D4. Tool-hop loop bounded by `maxToolHops` (default 10)
64:### D5. Tool execution delegated via `HostContext.tools` + `tierForTool` resolver
78:### D6. Memory `encode` at turn end, `recall` at turn start
91:### D7. Session lifecycle owned by Agent
101:### D8. `AgentStreamEvent` union surfaces every observable
123:## Alpha-memory integration roadmap
132:## Deferred / follow-up
140:## Testing surface

 succeeded in 0ms:
# Agent Loop Design — references and decisions

Design doc for `packages/core/src/agent.ts` (Phase 2 X3 scaffold).
Captures why each choice was made, with reference to source material.

## References surveyed

| Source | Location | Strength | Weakness |
|---|---|---|---|
| **careti** (via naia-os/agent) | `naia-os/agent/src/index.ts` | Battle-tested streaming, `MAX_TOOL_ITERATIONS` loop, tool partitioning (concurrent vs sequential), tier-based approval via `pendingApprovals` Map, token budget pre-flight (warn-only), MCP cleanup | Budget check warns but does not compact — compaction TODO'd to #185 Phase 2 |
| **opencode session/compaction** | `refs/ref-opencode/packages/opencode/src/session/{session,compaction,processor}.ts` | Formal compaction policy: `PRUNE_MINIMUM`, `PRUNE_PROTECT`, `preserveRecent`, turn-unit granularity. DB-backed persistence. | Effect + SQL makes it heavy for an embeddable runtime library. Overkill for our zero-runtime-dep + DI-first posture. |
| **claude-code** (analysis) | `.agents/progress/11-ref-cc-analysis.json` + naia-os README quote | Automatic compaction, `CLAUDE.md`-based memory layer with subagent spawning | Memory is file-system and single-directional — no bidirectional real-time memory update |
| **alpha-memory** | `projects/alpha-memory/src/memory/index.ts` | 4-store architecture, background consolidation (30-min default), reconsolidation (contradiction detection), Ebbinghaus decay, `consolidateNow(force)` for manual trigger | Current `consolidate()` is background; real-time stream compaction is a future capability (discussed separately) |

## Decisions

### D1. Stream-first API, `send()` as drain wrapper

```
Agent.sendStream(userText, signal?): AsyncGenerator<AgentStreamEvent>
Agent.send(userText, signal?): Promise<string>  // drains sendStream
```

**Why**: streaming is the only shape compatible with alpha-memory's
planned real-time compaction (it wants to observe generation as it
happens). `send()` as a convenience wrapper keeps the simple case simple.

Ref: careti (stream-based) > opencode (also stream, via Effect).

### D2. Compaction delegated to MemoryProvider via `CompactableCapable`

```ts
// @nextain/agent-types/memory.ts
export interface CompactableCapable {
  compact(input: CompactionInput): Promise<CompactionResult>;
}
```

**Why**:
- **Alpha-memory integration target** — memory already owns consolidation; compaction is a natural extension.
- **Real-time future** — alpha-memory can evolve `compact()` from on-demand to pre-computed (maintain rolling summary during `encode()` calls). Agent code does not change.
- **Graceful degradation** — if `memory` does not implement the capability, Agent falls back to simple sliding-window truncation (keep tail N, drop head).

Ref: opencode formalized compaction but tied it to its own DB; we abstract
to a capability interface so any memory can plug in.

### D3. Compaction policy constants (agent-side)

| Param | Default | Why |
|---|---:|---|
| `contextBudget` | 80_000 tokens | Safe for most 128K+ context models |
| `compactionKeepTail` | 6 messages | ~3 turns; matches opencode `DEFAULT_TAIL_TURNS = 2` (bit more generous) |
| `estimateTokens` | chars/4 heuristic | Host injects provider-accurate tokenizer when available |

Triggered before every LLM call (inside the tool-hop loop), so long
tool-use chains eventually compact themselves instead of exploding.

### D4. Tool-hop loop bounded by `maxToolHops` (default 10)

**Why**: matches careti's `MAX_TOOL_ITERATIONS = 10`. Prevents
runaway loops, surfaces the condition via `turn.ended` with stub text
`[agent stopped — reached max tool-hop budget]`. Logger emits warning.

### D5. Tool execution delegated via `HostContext.tools` + `tierForTool` resolver

Agent does not implement approval, tier policy, or actual execution. It
constructs a `ToolInvocation` with tier from the caller-provided resolver
and delegates to `HostContext.tools.execute()`. Wrap with
`GatedToolExecutor` (from `@nextain/agent-runtime`) for tier-based
approval flow, or a plain executor for tests.

**Why**: matches plan A.6 — tier enforcement lives in runtime's
`ToolExecutor` impl, shell owns approval UI via `ApprovalBroker`.

Ref: careti's `needsApproval(call.name)` → `waitForApproval(...)` pattern,
but factored behind an interface rather than inlined.

### D6. Memory `encode` at turn end, `recall` at turn start

- Turn start: `recall(userText, { topK: 5 })` — injects memory hits into system prompt
- Turn end: `encode(userText, "user")` + `encode(assistantText, "assistant")`

**Why**: minimum viable bidirectional flow. Advanced hooks (mid-stream
encoding, selective tool-result encoding) are deferred to a future
iteration. The contract allows them — any memory that wants stream-level
granularity can add a sub-capability.

Note: `encode()` errors are caught and logged but do not fail the turn —
memory is non-critical to the user-visible response.

### D7. Session lifecycle owned by Agent

Agent owns a `Session` object, transitions it through `ALLOWED_TRANSITIONS`
from `@nextain/agent-types/session.ts`. Emits `session.{created,active,...}`
events via Logger. `close()` transitions to `closed` and calls
`memory.close()`.

**Why**: plan A.5 — `naia-agent/core` owns session transition logic;
storage lives elsewhere.

### D8. `AgentStreamEvent` union surfaces every observable

```ts
type AgentStreamEvent =
  | { type: "session.started"; session }
  | { type: "turn.started"; userText; recalled }
  | { type: "llm.chunk"; chunk }
  | { type: "tool.started"; invocation }
  | { type: "tool.ended"; invocation; result }
  | { type: "compaction"; droppedCount; realtime }
  | { type: "usage"; usage }
  | { type: "turn.ended"; assistantText }
  | { type: "session.ended"; state };
```

**Why**: lets hosts (TUI, web UI, logging) observe internal transitions
without bolting event listeners. `llm.chunk` forwards the raw
`LLMStreamChunk` for low-level cases (token-by-token rendering).

Ref: opencode's BusEvent is more elaborate (publish-subscribe across
services); we use a yielded union for a simpler embedded story.

## Alpha-memory integration roadmap

| Now (v0.1) | Next | Future |
|---|---|---|
| `encode`/`recall`/`consolidate`/`close` | `compact()` via `CompactableCapable` | Real-time compaction hook: memory observes LLM stream, maintains rolling summary, `compact()` returns instantly |
| Background consolidation (30 min) | On-demand `consolidateNow()` triggered by agent | Per-turn micro-consolidation (light, predictable) |
| Recall via vector search | Recall biased by current session | Attention-aware recall (what was just said) |
| — | Sub-capabilities discoverable via `isCapable()` | Capability registry auto-populated |

## Deferred / follow-up

- Real tokenizer integration (provider-accurate counts). Currently chars/4
- `sub-agent` spawning (claude-code pattern). Agent is single-level today
- MCP bridge via runtime (X4, continuation of #200)
- Prompt caching strategy — passthrough today, opinionated policy pending
- Multi-session concurrency within a host — one HostContext = one Session (plan A.12)

## Testing surface

Current: `scripts/smoke-anthropic.ts` exercises `AnthropicClient` directly
(not `Agent`). An `Agent`-level smoke (InMemoryMemory + Mock LLM + Mock
Tools) lands in a follow-up commit once bash is available to run builds.

codex
이제 인용 라인 번호를 고정하겠습니다. 결론은 문구가 아니라 파일:라인 기준으로 적겠습니다.
exec
/bin/bash -lc "nl -ba projects/naia-adk/.agents/progress/agent-service-builder-architecture.md | sed -n '25,220p'" in /var/home/luke/alpha-adk
 succeeded in 0ms:
    25	## 1. 레포 관계 — 직교 2축 (사용자 "잘 설명" 핵심)
    26	
    27	레포 관계는 **하나의 트리가 아니라 직교하는 2축**이다. 이걸 섞으면 혼란이 생긴다.
    28	
    29	### 축 1 — 런타임 의존 (Part A.3 불변식, 변경 불가)
    30	
    31	```
    32	naia-os (host)            Tauri shell · 3D avatar · OS image · 승인 UI · audit · identity
    33	   │  embeds  (interface, NOT dependency — host 가 구현체 주입)
    34	   ▼
    35	naia-agent (Runtime SoT)  Agent loop · 공개 계약(LLMClient/MemoryProvider/
    36	   │                       ToolExecutor/SkillLoader/HostContext) · CLI 소유
    37	   │  contracts injected by host:
    38	   ├── alpha-memory (= naia-memory)   MemoryProvider 레퍼런스 구현
    39	   └── @naia-adk/skill-spec           스킬 표준 (zero-runtime-dep 계약)
    40	```
    41	- **불변식**: 4 repo 런타임 결합 금지. `naia-agent` 는 alpha-memory·naia-adk 를
    42	  import 안 함. 계약 3개(types/protocol/skill-spec) = zero-runtime-dep.
    43	- LLM provider = D44 (Vercel AI SDK 단일 abstraction) + naia-anyllm gateway 경유 가용성.
    44	
    45	### 축 2 — 워크스페이스 Fork Chain (거버넌스 상속)
    46	
    47	```
    48	naia-adk            personal base   (public, Apache 2.0) — 워크스페이스 포맷·스킬·persona·process
    49	   └── naia-business-adk   business upstream — 조직 거버넌스(assets/process/permissions·RBAC·SDLC)
    50	         └── {company}-adk        company instance   (예: nextain-adk)
    51	               └── {member}-adk   company-linked personal   (예: alpha-adk)
    52	```
    53	- **공개 계약 canonical 원칙(A.11)**: 유료/하류 fork 는 공개 계약을 **구현만**.
    54	  계약 수정 금지. private fork 의 계약 변종은 비공식.
    55	- **License 검증 소유(A.6)** = naia-business-adk (다운스트림).
    56	
    57	### ⚠️ 정정 필요 — Fork chain 문서 불일치 (본 설계가 해소)
    58	
    59	| 출처 | 현재 표기 | 판정 |
    60	|---|---|---|
    61	| `naia-adk/AGENTS.md` §Fork Chain | `naia-adk → {org}-adk → {user}-adk` (3단계, business 누락) | **outdated** — generic |
    62	| `naia-business-adk/README` | `naia-adk → naia-business-adk → {company}-adk → {member}-adk` | **canonical** (business upstream 명시) |
    63	
    64	→ 본 설계 채택 = **4단계 (business upstream 명시)**. naia-adk/AGENTS.md Fork Chain
    65	섹션을 canonical 로 정합 (Sync phase, Cascade rule 적용 — AGENTS↔CLAUDE↔GEMINI).
    66	
    67	### 두 축의 결합점
    68	
    69	```
    70	워크스페이스(축2)가 "무엇을(persona/skill/RAG/memory 바인딩)" 정의 →
    71	런타임(축1) naia-agent 가 "어떻게(loop/계약/주입)" 실행 →
    72	host(개인=naia-os / 비즈니스=naia-business-adk 다운스트림)가 "어디서(배포·권한·과금)" 운영
    73	```
    74	
    75	---
    76	
    77	## 2. 에이전트 서비스 빌더 — layer 구조
    78	
    79	**핵심 명제**: "에이전트 서비스" = (persona + skill set + RAG source + memory
    80	binding + LLM backend + orchestration policy) 의 선언적 묶음. 이 묶음을
    81	**naia-adk 워크스페이스 manifest** 로 정의하고, naia-agent 런타임이 실행한다.
    82	
    83	```
    84	┌─ Service Definition (naia-adk 워크스페이스 = 작업 폴더) ───────────┐
    85	│  service.manifest:  persona(packages/persona) + skills(skill-spec) │
    86	│                      + rag.sources + memory.binding + llm.backend  │
    87	│                      + orchestration(graph) + eval.fixtures        │
    88	└───────────────────────────┬───────────────────────────────────────┘
    89	                            │ naia-agent 가 manifest 소비 (계약 주입)
    90	┌─ Runtime (naia-agent, SoT) ▼ ─────────────────────────────────────┐
    91	│  Agent loop · LLMClient(D44) · MemoryProvider · ToolExecutor       │
    92	│  + [신규] RAGProvider 계약 · OrchestrationPolicy 계약              │
    93	└───────────────────────────┬───────────────────────────────────────┘
    94	                            │ host 주입·운영
    95	┌─ Operate ──────────────────▼──────────────────────────────────────┐
    96	│  개인:   naia-os (Tauri host, 단일 사용자)                          │
    97	│  비즈니스: naia-business-adk 다운스트림 (RBAC·멀티테넌시·과금·audit) │
    98	└───────────────────────────────────────────────────────────────────┘
    99	```
   100	
   101	### 평가 프레임웍(#31)의 위치 — 우산의 하위
   102	
   103	#31 = "검증 가능한 agent-flow 성능 평가". 본 빌더의 **하위 검증 layer**:
   104	서비스 manifest 의 `eval.fixtures` 가 #31 하니스 입력. 빌더가 헤드라인,
   105	평가는 그 품질 게이트. → **#31 보강** (신규 이슈 아님; 우산 sub-issue 추가).
   106	
   107	### 풀셋 매핑 (사용자 "LLM + persona/system prompt + naia-memory + RAG + langraph")
   108	
   109	| 요소 | 소유 | 계약/구현 |
   110	|---|---|---|
   111	| LLM | naia-agent providers | D44 Vercel AI SDK adapter (qwen3.6-27b-dense via `@ai-sdk/openai-compatible` → naia-model-infra vllm-coding / minicpm via lab-proxy-live `/v1/realtime`) |
   112	| persona / system prompt | naia-adk `packages/persona` | manifest `persona` 필드 → Agent system 조립 |
   113	| memory | alpha-memory(naia-memory) | MemoryProvider 계약 (기존) |
   114	| **RAG** | **신규 — naia-agent `RAGProvider` 계약** | host 주입. retrieval→context. matrix **§D 신규** |
   115	| **orchestration (LangGraph)** | **신규 — `OrchestrationPolicy` 계약** | ⚠️ §3 제약 참조 |
   116	
   117	---
   118	
   119	## 3. ⚠️ LangGraph 제약 — 매트릭스 충돌 해소 (크로스리뷰 핵심 공격점)
   120	
   121	naia-agent ref-adoption-matrix 에서 **이미 거부됨**:
   122	- **B19**: LangChain `@langchain/core` 직접 의존 거부 (zero-runtime-dep 위배)
   123	- **B20**: LangGraph StateGraph 채널 reducer 거부 (D1 stream-first 모델 충돌)
   124	- C05: Checkpoint 패턴 = 이연(후보)
   125	
   126	**그러므로 "LangGraph 직접 채택" 은 Part A.3 / 매트릭스 위배.** 해소안 (택1, 크로스리뷰 판정):
   127	
   128	| 안 | 내용 | 매트릭스 영향 |
   129	|---|---|---|
   130	| **A (권고)** | `OrchestrationPolicy` 자체 계약(zero-runtime-dep) + naia-agent 내 경량 graph executor (stream-first 보존). LangGraph 는 *패턴 참조*만 | §D 신규 (B20 의 "reducer 모델 충돌" 회피 설계 명시) |
   131	| B | host opt-in peer-dep (`@langchain/langgraph` 를 host 가 설치, naia-agent 는 adapter 계약만) — D44 의 peer-dep 선례 | §D 신규 + B19 demote 논거 필요 |
   132	| C | LangGraph 전면 채택 | **거부** — B19/B20 정면 위배, Part A.3 깨짐 |
   133	
   134	→ **A 채택 제안**. orchestration = stream-first AsyncGenerator 위 DAG step.
   135	크로스리뷰가 "A 가 정말 B20 충돌을 피하는가" 를 검증.
   136	
   137	---
   138	
   139	## 4. 개인 vs 비즈니스 경계 (사용자 "경계 적절히, 개인도 필요부분")
   140	
   141	| 관심사 | 개인 (naia-adk + naia-os) | 비즈니스 (naia-business-adk 다운스트림) |
   142	|---|---|---|
   143	| 워크스페이스 manifest | ✅ 정의·실행 | ✅ 상속 + governance 래핑 |
   144	| persona / skill / RAG / memory | ✅ 전부 | ✅ + 조직 자산 바인딩(assets) |
   145	| 실행 host | naia-os (단일 사용자, Tauri) | 서버/멀티테넌시 (naia-business-adk 운영) |
   146	| 권한 | 단일 사용자 (T0~T3 self) | **RBAC** (author/reviewer/approver/releaser/auditor) |
   147	| 승인 | naia-os ApprovalBroker | 위임 승인 체인 (delegated) |
   148	| audit / SDLC artifact | naia-os audit log | **SDLC tracking** (req/design/decision/review/release/postmortem) |
   149	| License / 과금 | 없음 (Apache 2.0) | naia-business-adk License 검증 (A.6) |
   150	| disclosure 경계 | 개인 자율 | 조직 disclosure boundary |
   151	
   152	**원칙**: 개인 layer 가 완전 자족(외부 데모 = 개인 layer 로 동작 가능해야).
   153	비즈니스 layer = 개인 base 의 **상위 래핑**(거버넌스 추가), 계약 수정 X (A.11).
   154	
   155	### naia-adk ↔ naia-business-adk 경계 (구체)
   156	
   157	- `naia-adk` = personal base. 워크스페이스 포맷·service manifest 스키마·기본 스킬·persona/process packages. **service manifest 스키마 SoT 여기**.
   158	- `naia-business-adk` = business upstream. README 가 명시: "not just premium skill bundle. Skills are one output of the model, not the whole product." → governance 모델(assets/process/permissions, RBAC, SDLC)이 본체. 현재 **거의 백지(README only) = 본 설계의 신규 구축 대상**.
   159	- 경계선: **manifest 스키마·런타임 계약 = naia-adk(canonical). governance 확장 = naia-business-adk(구현만, 스키마 미수정).**
   160	
   161	---
   162	
   163	## 5. 구체적 구현 계획 (사용자 "구현계획 구체적으로")
   164	
   165	naia-agent dev-process 준수: slice 단위 · F-rule · matrix §D ID 인용 ·
   166	karpathy 4원칙 · cross-review 2 consecutive clean. **#31 우산 sub-issue.**
   167	
   168	### Phase 0 — 합의 게이트 (코드 0줄)
   169	- [ ] 본 설계 크로스 리뷰 (Codex + Gemini, different-profile 2x clean)
   170	- [ ] 리뷰 종합 → 사용자 보고 → **합의** (사용자 명시 게이트)
   171	- [ ] #31 보강(우산 재프레이밍) + sub-issue 등록 (외부 push = 사용자 승인)
   172	- [ ] matrix §D 신규 항목 초안: `D-SB1 RAGProvider 계약`, `D-SB2 OrchestrationPolicy(LangGraph 회피 설계)`, `D-SB3 service manifest 스키마`
   173	
   174	### Phase 1 — qwen3.6-27b-dense backend (GPU 경량, fixture 우선)
   175	> qwen = 표준 chat API → fixture-replay 단순 → **1차 backend**.
   176	
   177	- **Slice SB-1** `service manifest 스키마 + loader`
   178	  - 산출: `naia-adk/packages/skill-spec` 인접 `service-manifest` 스키마 + naia-agent `ServiceManifestLoader` 계약
   179	  - S01 `pnpm exec naia-agent --service <manifest>` / S02 unit(스키마 검증) / S03 fixture-replay / S04 CHANGELOG / §D-SB3
   180	- **Slice SB-2** `RAGProvider 계약 + naia-memory 결합`
   181	  - 산출: `@nextain/agent-types` `RAGProvider`(zero-runtime-dep) + alpha-memory 결합 어댑터(host 주입) + turn-전 context 조립
   182	  - S01 `--rag <source>` / S02 unit(retrieval merge) / S03 실 alpha-memory 호출 / S04 / §D-SB1
   183	- **Slice SB-3** `OrchestrationPolicy (stream-first DAG, LangGraph 회피)`
   184	  - 산출: `OrchestrationPolicy` 계약 + 경량 executor(§3-A). B20 충돌 회피 설계 docs
   185	  - S01 `--graph <policy>` / S02 unit(step 순서·중단) / S03 fixture multi-step / S04 / §D-SB2
   186	- **Slice SB-4** `qwen3.6-27b-dense 통합 + agent-flow 평가(#31 결합)`
   187	  - 산출: D44 `@ai-sdk/openai-compatible` → naia-model-infra vllm-coding(8000) 어댑터 + #31 하니스로 e2e 품질 측정(fixture-replay 우선, G15)
   188	  - S01 `--backend qwen` / S02 unit / S03 fixture e2e(RAG+memory+persona+qwen) / S04 / §D + #31 cross-ref
   189	
   190	### Phase 2 — minicpm backend (GPU/ko-serve, 별 트랙 의존)
   191	- **Slice SB-5** `minicpm /v1/realtime connector` (v2 계약 `localmodel-realtime-v2.md` rev2.1 준수, lab-proxy-live)
   192	- **Slice SB-6** `라이브 e2e` (ko-serve worker GPU 단계 — ko-serve 트랙 PAUSED 해제 의존)
   193	
   194	### Phase 3 — 비즈니스 layer
   195	- **Slice SB-7** `naia-business-adk governance 스캐폴드` (RBAC roles + SDLC artifact 스키마 + manifest governance 래퍼 — 계약 미수정 A.11)
   196	- **Slice SB-8** `멀티테넌시·License·audit 운영 경계 문서 + 데모`
   197	
   198	### 외부 데모 최소 동작선 (MVP)
   199	Phase 1 SB-1~SB-4 = **개인 layer 로 qwen3.6-27b-dense 기반 에이전트 서비스
   200	1개가 manifest → RAG+memory+persona → 응답 → 평가수치까지 e2e**.
   201	이게 외부 의뢰 데모의 최소 제출선.
   202	
   203	---
   204	
   205	## 6. 가정 / 미해결 (karpathy #1 — 크로스리뷰가 때릴 지점)
   206	
   207	1. **(가정)** "LangGraph" = orchestration *패턴* 요구지 라이브러리 강제 아님 → §3-A. 틀리면 §3-B 재검토.
   208	2. **(가정)** service manifest 스키마 SoT = naia-adk (워크스페이스 소유 A.6). naia-agent 는 loader 계약만.
   209	3. **(미해결)** RAG source 추상화 범위 (벡터스토어/파일/웹 — 어디까지 1차). 크로스리뷰 + 사용자.
   210	4. **(미해결)** 외부 데모 시한·평가 기준(무엇을 "보여드릴" 성공으로 볼지) → 사용자 확인 필요.
   211	5. **(제약)** naia-agent R5 LOCKED → 본건 R6. F01(스켈레톤 게이트)·F06·F07·F08(OPEN P0) 상태 재확인 필요(슬라이스 착수 전).
   212	6. **(정정)** Fork chain 4단계로 문서 정합 (§1.3).
   213	
   214	---
   215	
   216	## 7. 크로스리뷰 대상 + 합의 게이트
   217	
   218	- **리뷰 프로파일**: (a) architect — 레포 경계·불변식 일관성 (b) reference/matrix — B19/B20/Part A 위배·§D 정합 (c) paranoid — 누락·외부데모 리스크·F-rule
   219	- **clean 기준**: Part A 불변식 위배 0 · 매트릭스 정면충돌 0 · 경계 모순 0 · 누락 원칙 0
   220	- **합의 게이트(사용자 명시)**: 크로스리뷰 2x clean → 사용자 보고 → **합의 후에만** 코드(Slice SB-1) 착수.

exec
/bin/bash -lc "nl -ba .agents/progress/naia-4repo-migration-plan.md | sed -n '147,310p'" in /var/home/luke/alpha-adk
 succeeded in 0ms:
   147	### A.3 의존 방향 (불변식)
   148	
   149	```
   150	types, protocol, skill-spec   ← 모두 zero-runtime-dep
   151	      ▲       ▲       ▲
   152	      │       │       │
   153	     type-only imports
   154	      │       │       │
   155	core, runtime, providers, messengers, observability
   156	      ▲
   157	      │  embeds
   158	      │
   159	   naia-os shell / CLI host
   160	```
   161	
   162	**규칙**:
   163	- `@nextain/agent-types`·`@naia-agent/protocol`·`@naia-adk/skill-spec`는 zero-runtime-dep
   164	- 이 셋은 서로 **type-only import** 가능 (컴파일 타임만, 런타임 의존 아님). 결과: 계약 간 의미적 결합은 용인, 런타임 순환은 금지.
   165	- 구현 패키지(core/runtime/...)는 계약 패키지를 자유롭게 import
   166	- 계약 패키지는 구현 패키지를 **절대** import 안 함
   167	
   168	### A.4 패키지 (역할 단위 — 수는 실행 중 조정)
   169	
   170	- 계약 3: `types`, `protocol`, `skill-spec`
   171	- 구현 N: `core` · `runtime` · `providers` · `messengers` · `observability` · (옵션) `tts`/`cli`/`testing`
   172	- **Capability 인터페이스는 `@nextain/agent-types` 소속** (zero-runtime-dep 유지).
   173	- 축소 허용: 작업 편의에 따라 merge/split. 단 A.3 의존 방향 유지.
   174	- **CLI 소유 = `naia-agent` 레포** (독립 패키지든 core binary 겸용이든 구현 선택이나, 소유 레포는 확정).
   175	
   176	### A.5 계약 정의 (shape 원칙)
   177	
   178	**`LLMClient`** — 스트리밍·툴콜·프롬프트 캐시 포함.
   179	**`MemoryProvider`** — 최소 메소드 (`encode`/`recall`/`consolidate`/`close`) + **선택 Capability 인터페이스** (`BackupCapable`, `EmbeddingCapable`, `KnowledgeGraphCapable`, `ImportanceCapable`, `ReconsolidationCapable`, `TemporalCapable`). 구현체가 지원하는 capability만 implements. 소비자는 `if (isCapable(x, KnowledgeGraphCapable))`로 확인.
   180	**`ToolExecutor`** — tier 기반 권한. `#198` CommandExecutor 승계.
   181	**`SkillLoader`** — `@naia-adk/skill-spec`에 정의. agentskills.io 준수.
   182	**`HostContext`** — 필수 최소(llm, memory, logger)와 확장 capability 분리. `HostContext.Core`, `HostContext.Full` 서브셋 허용.
   183	**`Event`** — `trace_id`, `span_id` 포함. optional `viseme?` 필드.
   184	**`ErrorEvent`** — 실패 전파 계약. `error_code`(i18n-ready), `severity`(info/warn/error/fatal), `retryable: boolean`. 예외는 runtime 내부 용도, 경계 넘는 실패는 ErrorEvent로. (용어 분리: `tier`는 권한 T0-T3 전용, `severity`는 실패 심각도 전용.)
   185	**`Logger` / `Tracer` / `Meter`** — observability 계약. `observability` 패키지는 이 계약의 기본 구현체. 계약 자체는 `types`.
   186	**`TierLevel` (T0|T1|T2|T3) + semantic** — 각 tier의 의미(허용 행위·승인 주체·로깅 요구)는 `types` 소속. 구현체는 이 의미를 준수.
   187	**`SessionLifecycle` 상태 전이** — `created → active → paused → resumed → closed | failed`. `fatal` severity ErrorEvent 발생 시 `failed` 전이. `naia-agent/core`가 로직 소유, `alpha-memory`는 저장만.
   188	**`ApprovalFlow` 상태기계** — `requested → pending → {approved|denied|timeout}`. 전이 trigger는 shell이 `ApprovalBroker.decide()` 호출. Timeout 정책은 `types`의 기본 상수(구현은 오버라이드 가능). shell이 UI 소유, runtime이 state 보유.
   189	
   190	shape은 고정, 필드는 추가 허용 (additive). 삭제/타입변경은 MAJOR.
   191	
   192	**Capability 확장 거버넌스**: 새 Capability는 `@nextain/agent-types` PR로 추가 (additive). 구현체는 지원 capability를 명시적 implement. 거부·deprecation은 MAJOR 사유. **Capability 조합 의미론**은 각 Capability 정의 문서에서 명시 (예: `KnowledgeGraphCapable + TemporalCapable` 조합 규칙은 `TemporalCapable` 문서에 명시).
   193	
   194	**Observability 의무 메타 원칙**: 모든 구현 패키지는 **주요 상태 전이**에서 `Event` emit 의무. "주요 상태 전이" = 상태 변경, 경계 교차 호출, 에러 발생. 로그 없음 = 계약 위반.
   195	
   196	### A.6 소유권 (누가 무엇을)
   197	
   198	| 관심사 | 소유 레포/패키지 |
   199	|---|---|
   200	| Device identity (Ed25519) | shell stronghold |
   201	| LLM API keys | shell stronghold → providers에 주입 |
   202	| Discord bot token, OAuth tokens | shell stronghold → messengers에 주입 |
   203	| Tier T0-T3 승인 UI/결정 | shell |
   204	| Tier enforcement | `runtime.ToolExecutor` |
   205	| Credits counter/dashboard | shell |
   206	| Credits usage emission | providers (via `HostContext.meter`) |
   207	| Skill 정의 포맷 | `naia-adk/skill-spec` |
   208	| Skill 실행 | `naia-agent/runtime` |
   209	| Workspace 파일 구조 | naia-adk |
   210	| 세션/장기 메모리 저장 | alpha-memory (MemoryProvider 구현체) |
   211	| Tauri plugin (native Rust) — stt, shell, store | shell 잔류 |
   212	| `src-tauri/src/*.rs` 백엔드 | **shell 잔류**. spawn 로직만 naia-agent CLI entry로 리타깃. Rust 내부 로직 이주 없음. |
   213	| 3D 아바타 렌더링 (`three`, `@pixiv/three-vrm`) | shell |
   214	| BlueBuild OS 이미지 | shell (recipes/, config/) |
   215	| Flatpak/NSIS/MSI packaging | shell |
   216	| naia-os-specific verify skills (`.claude/skills/verify-*`) | naia-os 잔류 |
   217	| cross-review / review-pass 메타 스킬 | naia-adk (공통) |
   218	| **Skill 소유 판정 기본 규칙** | naia-adk 기본값. **naia-os-specific API**(Tauri plugin, BlueBuild, hardware tier, VRM 등)를 참조하는 skill만 naia-os |
   219	| **Voice I/O (TTS/STT) 소유권 원칙** | 공개 I/O 계약(`VoiceEvent` — `audio_chunk`, `viseme`, `transcript`)은 `@nextain/agent-types` 소속. 실행 layer(어디서 돌리는가)는 Part B |
   220	| Telemetry · crash reporting · auto-update | shell (OS 레이어) |
   221	| Audit log 저장·보존 정책 | shell (tamper-evident, 최소 30일) |
   222	| License 검증 (business-adk 유료 영역) | naia-business-adk (다운스트림) |
   223	| i18n 번역 리소스 (`.users/` 미러) | 각 repo 자체 소유 |
   224	| Error message 번역 | shell (error_code → 지역화 문자열) |
   225	| Downstream fork 업스트림 merge | 각 포크 본인 책임 (alpha-adk는 nextain-adk 트래킹) |
   226	
   227	### A.7 Enforcement (1인 개발자 현실)
   228	
   229	`#227` freeze는 1인 구조에서 branch protection이 형식뿐이라는 한계를 인정. 대신:
   230	- **`migration/*` branch prefix 규칙**: migration 관련 PR은 이 prefix 필수. 다른 브랜치에서 `naia-os/agent/**` 수정 금지 (self-discipline + PR 템플릿 체크리스트).
   231	- **Label `migration-phase`**: 정보 제공용 태깅 (강제 아님).
   232	- **자기 리뷰 규약**: PR 머지 전 24h 대기 + checkout 후 E2E 1회 실행.
   233	- **Freeze 유효 기간**: MVM 착수 시점부터 Phase 3 O1 완료(shell에서 agent/ 디렉터리 제거)까지. 이후엔 해당 경로 자체 부재로 자연 종료.
   234	
   235	Branch protection + CODEOWNERS는 시도하되 "실패 시 허용" (1인 현실 인정).
   236	
   237	### A.8 Release 정책
   238	
   239	- 각 repo 독립 semver. 공통 버전 동기화 안 함.
   240	- `@nextain/agent-types` MAJOR = shape 파괴. MINOR = 추가. PATCH = 내부.
   241	- `@naia-agent/protocol` 별도 semver. wire 변경 ≠ types MAJOR.
   242	- `@naia-adk/skill-spec` 별도 semver. naia-adk 태그와 **lockstep 아님** — 독립 릴리스 OK, 대신 호환 테이블 문서화.
   243	- alpha-adk 서브모듈 pointer = X-item merge 배치 업데이트.
   244	
   245	### A.9 Strangler Fig 원칙
   246	
   247	- Big-bang 추출 금지. 각 패키지 추출 → 즉시 shell 연결 → CI green → Flatpak 스모크.
   248	- **Lockstep merge 순서 원칙**: agent repo PR 선행 merge → shell repo PR이 새 버전 import하며 merge. shell이 먼저면 연결 대상 없음.
   249	- **Lockstep = self-discipline** (A.7과 동급). branch protection 강제 불가 인정.
   250	- **MVM 단계는 Lockstep 예외**: MVM 완료 전까지는 naia-agent가 부분 스캐폴드 상태이므로 lockstep 적용 제외. Phase 0 이후부터 발효.
   251	- 롤백: PR 단위 revert. 양 repo 순차 revert (agent → shell 역순).
   252	- **롤백 임계점 원칙**: 지속적 복구 불가 CI 실패 OR E2E 기능 동일성 미달 OR Flatpak build break. (구체 관찰 기간은 운영 정책 문서.)
   253	- **Abort 조건 원칙**: MVM 실패 OR A.3 의존 방향이 실제 코드에서 성립 불가 판명 OR 다수의 해결 불가 블로커 발생. 이 중 하나면 계획 전체 재설계.
   254	- 진행 중이던 기능 이슈(#213, #220 등)는 `naia-os/agent/**` 제외 영역에서 계속 병행 가능.
   255	- **X5 flip-day는 예외가 아님** — strangler 경로에서 이미 구축된 v2 프로토콜로 switchover이지 신규 이주 아님.
   256	
   257	### A.10 MVM (최소 증명)
   258	
   259	**착수 순서** (원칙):
   260	1. 알파메모리 실체 확인 + MemoryProvider 기본 4메소드 매핑 초안
   261	2. `@nextain/agent-types` 초기 shape + `LLMClient` 계약 공개
   262	3. Anthropic 1종 `LLMClient` 구현 + shell에서 실제 호출
   263	4. Flatpak 빌드 1회 green
   264	5. `migration/*` branch prefix 규약 시행 + PR 템플릿
   265	
   266	**선행 조건**: MVM 착수 전 각 active repo(`naia-os`, `naia-agent`, `naia-adk`, `alpha-memory`)에 최소 CI skeleton 보유. 없으면 #1 착수와 동시에 S7 CI template 생성 PR.
   267	
   268	**성공 기준**: shell이 `@naia-agent/*` 1개 패키지라도 실제 소비 + 사용자에게 기능 동일.
   269	
   270	**실패 기준** (Abort 트리거): 
   271	- 합리적 관찰 기간 내 성공 기준 미달 → 계획 재설계
   272	- 1~2단계에서 A.3 의존 방향 성립 불가 발견 → 계획 재설계
   273	- 3단계에서 Anthropic SDK + pnpm/npm 통합 기술적 불가 → 기술 선택 재검토
   274	
   275	**MVM ↔ 본 계획 전이 게이트 원칙**: MVM 성공은 본 계획 **재검토 입력**. 자동 승격 아님. 본 계획 Phase 0 재평가 후 진입.
   276	
   277	**MVM 첫 PR 위치 원칙**: 검증 대상 repo 자체. #1 "알파메모리 실체 확인" → 첫 PR은 `alpha-memory` 또는 `naia-agent/docs/` 내 audit 문서.
   278	
   279	---
   280	
   281	### A.11 교차 관심사 원칙 (5·6라운드 반영)
   282	
   283	- **Observability emit 의무**: 모든 구현은 주요 상태 전이에서 Event emit. 로그 없음 = 계약 위반 (A.5에서 재강조).
   284	- **Error 전파**: 경계 간 실패는 `ErrorEvent` shape으로. 예외(throw)는 내부 전용. runtime은 `error_code`만 emit, 사람이 읽는 번역은 shell 전용.
   285	- **Audit**: shell 소유. tamper-evident. 법적/운영 최소 기간 보존(구체 일수는 운영 정책 문서). tier T2+ 행위는 필수 기록.
   286	- **i18n**: `.users/` 미러는 각 repo 소유. Error message는 `error_code` 기반, 번역은 shell에서.
   287	- **라이선스 경계**: 공개 4 repo Apache 2.0. 유료 확장(`naia-business-adk`)은 공개 계약 **구현만** 허용, 계약 수정 금지. **공개 4 repo의 계약만 canonical** — private fork의 계약 변종은 비공식.
   288	- **외부 소비자 호환**: `naia-adk/skill-spec`은 agentskills.io MAJOR 하위 호환 유지. claude-code/opencode/codex 등 외부 도구가 소비하는 포맷 안정성 보장.
   289	- **Regression 금지**: 공개 릴리스 전 유의미한 품질·latency regression 발견 시 release block. 측정 범위: memory benchmark, tool-call 성공률, stream TTFB. 구체 임계치는 운영 정책.
   290	- **Communication**: 공개 릴리스 이후 MAJOR breaking change는 합리적 사전 공지 + CHANGELOG + 4 repo 간 cross-link. MVM/Phase 0 내부는 면제.
   291	- **Graceful degradation**: Capability 부재는 에러가 아닌 "기능 없음". 소비자는 Capability 확인 후 사용.
   292	- **Observability "주요 상태 전이" 정의자**: Event emit 범위는 각 계약 문서에서 명시 (`Session` 문서에 Session 전이, `ToolCall` 문서에 tool 전이).
   293	
   294	### A.12 비기능 원칙 블록 (6라운드 Gap Hunter 반영)
   295	
   296	- **Configuration 오버라이드 체인**: CLI flag > env var > config file > defaults. 4 repo 공통.
   297	- **Retry/backoff 책임 분할**:
   298	  - **Transport 실패** (network, rate-limit) → `providers` 계층 책임
   299	  - **Business 실패** (tool timeout, approval denied) → `runtime` 계층 책임
   300	  - `ErrorEvent.retryable` 필드가 계층 판단의 hint.
   301	- **데이터 이식성**: `MemoryProvider`는 `ExportCapable` 옵션 인터페이스 보유 권장. 포터블 포맷 (JSON lines 기본) 지원 시 다른 구현체로 이식 가능.
   302	- **성능 SLO 입장**: 성능은 **구현 의무**이며 계약의 일부 아님. 단, 공개 릴리스는 baseline SLO 문서화 필요.
   303	- **동시성 원칙**: 단일 `HostContext` = 단일 session. 다중 session 필요 시 다중 HostContext (호스트가 관리). runtime은 세션 간 격리 보장.
   304	- **Public API 안정성**: `@nextain/agent-types`·`@naia-agent/protocol`·`@naia-adk/skill-spec`은 **외부 소비자 대상 공개 계약**. v1.0 이후 MAJOR 변경은 A.11 communication 원칙 적용.
   305	- **버전 지원 기간**: 직전 MAJOR는 신규 MAJOR 배포 후 최소 1 릴리스 사이클 co-maintain.
   306	
   307	### A.13 보안 패치 원칙
   308	
   309	- 취약점(CVE-worthy)은 **lockstep 면제**. 즉시 패치 배포 허용.
   310	- 패치 후 공개 보안 공지(CHANGELOG security 섹션) 의무.

exec
/bin/bash -lc "nl -ba projects/naia-agent/.agents/progress/ref-adoption-matrix.md | sed -n '66,150p'" in /var/home/luke/alpha-adk
 succeeded in 0ms:
    66	| B15 | jikime-mem MemoryProvider 재사용 | jikime-mem | 모놀리식 + Claude Code 플러그인 강결합 + Chroma 고정 의존 |
    67	| B16 | moltbot 999K LOC gateway 전체 | moltbot/openclaw | 경량 임베드 런타임과 양립 불가 |
    68	| **B17** | Mastra 28-package monorepo 강결합 | mastra | 4-repo 분리 + zero-runtime-dep 위배 (B13 재확정) |
    69	| **B18** | Mastra Studio web IDE | mastra | host(naia-os) 책임 분리 — UI는 host |
    70	| **B19** | LangChain `@langchain/core` 직접 의존 | langgraphjs | B09와 동일 — zero-runtime-dep 위배 + ecosystem lock-in |
    71	| **B20** | LangGraph StateGraph 채널 reducer (정적 schema) | langgraphjs | D1 stream-first 결정과 모델 충돌 |
    72	| ~~B21~~ | ~~Vercel `@ai-sdk/<provider>` 50개 직접 의존 + React hooks~~ — **DEMOTED by D44 (2026-04-29), refined by 5.x.6 cross-review P0-3 (2026-04-29)**. 실제 적용 형태: `@nextain/agent-providers`가 5개 default 번들 (`@ai-sdk/anthropic`/`@ai-sdk/google`/`@ai-sdk/openai-compatible`/`zhipu-ai-provider`/`ai-sdk-provider-claude-code`) 만 `optionalDependencies` 로 자동설치, 나머지 50개는 host가 peer로 opt-in 설치. (1) 50-provider sprawl 회피 (5개로 한정), (2) `@ai-sdk/react` hooks는 별도 패키지 — naia-agent는 headless로 import 안 함. zero-runtime-dep 정신 완전 보존은 아니지만 **사용자 directive ("자동설치")** 와 정합 + 50-provider sprawl 우려는 해소 | vercel-ai-sdk | demoted (5-provider default bundle, host opts into more) |
    73	| **B22** | cleanroom 코드 라인 직접 복붙 (8 파일) | cleanroom-cc deep-audit F1~F12 | F4 강화 — 패턴 idea만 차용, 라인 복붙 금지 (LLM 환각 silent drift 위험) |
    74	| **B23** | naia-agent를 claude-code/opencode 수준 자체 build (provider 50+, MCP, SQL session, compaction 정교, tool 본체 풀스택) | R4 1인 환경 평가 | 1인 70k+ LOC 1년+ 무리. Hybrid wrapper(D18)가 현실 path. wrapper layer ~2,150 LOC로 사용자 가치 80% 달성 가능 |
    75	
    76	---
    77	
    78	## C. 이연 (Deferred) — 트리거 조건 명시
    79	
    80	| # | 항목 | 출처 | 트리거 조건 |
    81	|---|---|---|---|
    82	| C01 | Real tokenizer 통합 | agent-loop-design 한계 | provider-accurate tokenizer 제공 시 |
    83	| C02 | Sub-agent spawning | claude-code 분석 + agent-loop-design | claude-code 패턴 정식 도입 시 (Phase 2+) |
    84	| C03 | MCP bridge via runtime | agent-loop-design + opencode | X4 MCP 통합 진입 |
    85	| ~~C04~~ | ~~Prompt caching opinionated 정책~~ — **§D16으로 격상 (Vercel 영향, 2026-04-25 R1 v2)** | ~~agent-loop-design~~ | ~~passthrough → 정책 정의 (Phase 2)~~ |
    86	| C05 | Multi-session concurrency | A.12 | 1 HostContext = 1 Session 한계 해소 시 |
    87	| C06 | TTS 추출 (Phase 2 X7) | voice-pipeline-audit | S6 결정 후 |
    88	| C07 | ClawHub 호환 (backward-compat) | openclaw issue-201 | Phase 4 B-D 완료 후 |
    89	| C08 | Flatpak dual-path (S3) | 4-repo plan §Z | Phase 2 CI |
    90	| C09 | Tauri bundling matrix (S10) | 4-repo plan §Z | Phase 2 X1 진입 |
    91	| C10 | Memory 로깅 패턴 (cline 5분 주기) | cline | compaction trigger or observability 검토 시 |
    92	| C11 | Hook 쉘 escape 규칙 | cline | hook 설계 확정 후 (A.5 이후) |
    93	| C12 | AuthManager 이벤트 기반 토큰 갱신 | cleanroom-cc adopt-cc-02 | daemon gateway 도입 시 |
    94	| C13 | Command Registry 카테고리 + availability 필터 | cleanroom-cc adopt-cc-04 | 명령어 수 50개 도달 시 |
    95	| C14 | ErrorCategory enum (단순화 버전) | cleanroom-cc adopt-cc-05 | nice-to-have, P2 |
    96	| C15 | Engagement 정확도 (engage_mode + fan-out) | nanoclaw v2 | ExtensionPack 설계 시 (Phase 4) |
    97	| C16 | Per-agent fan-out session 격리 | nanoclaw | Phase 4 후기 (multi-tenant 모델 후) |
    98	| C17 | OneCLI Vault credential injection | nanoclaw v2 | Phase 2 (자체 실행 엔진) 권고 |
    99	| C18 | Universal Speech Transformer segmentation | project-airi | Phase 2 X7 TTS 성능 평가 시 |
   100	| C19 | Character card v3 호환 | project-airi | Phase 1 T5 character metadata 스키마 후 |
   101	| C20 | Dual Orchestrator (J.A.R.V.I.S./F.R.I.D.A.Y.) | jikime-adk | Phase 2 이후 specialized agent 필요 시 |
   102	| C21 | Fixture-replay E2E (StreamRecorder/Player) | opencode 갭 | R3+ Slice 단위로 도입 |
   103	| C22 | DI 컨테이너 패턴 (단순화) | opencode | service factory 함수 + host 명시 주입 — 우리 구조에 부합 |
   104	
   105	---
   106	
   107	## D. 신규 채택 권고 (R0에서 추가, P0~P2 라벨)
   108	
   109	| # | 패턴 | 출처 ref | 우선순위 | 예상 공수 | 슬라이스 후보 |
   110	|---|---|---|---|---|---|
   111	| D01 | DANGEROUS_COMMANDS regex (Bash 보안 필터) | cleanroom-cc adopt-cc-01 | **P0** | S (1h) | bash skill / ToolExecutor wrapper |
   112	| D02 | Path normalization (directory traversal 방지) | cleanroom-cc adopt-cc-03 | **P0** | S (30m) | fileops native helper |
   113	| D03 | wLipSync AEIOU viseme vocabulary + 2-stage 알고리즘 | project-airi | P1 | M | Phase 2 X7 TTS extraction |
   114	| D04 | Narrative stripping 휴리스틱 (TTS 입력 정규화) | project-airi | P2 | S | Phase 2 X7 |
   115	| D05 | Tool context 패턴 (sessionID/directory/ask 권한 전달) | opencode | P1 | S | D5 보강 |
   116	| D06 | Logger.tag() + timestamp 편의 | opencode | P1 | S | Logger 확장 |
   117	| D07 | Compaction overflow + 동적 preserveRecent (D3 구체화) | opencode | P1 | M | Agent.maybeCompact 보강 |
   118	| D08 | ChannelPlugin adapter 패턴 | moltbot | P2 | M | naia-os messenger layer |
   119	| **D09** | Workspace sentinel (`path.resolve` + `startsWith(root + sep)` throw) | cleanroom-cc deep-audit F3/F10 fix | **P0** | S (30m) | Slice 1b — D02와 묶음 |
   120	| **D10** | Tool 메타 (`description`/`inputSchema`/`contextSchema?`/`isConcurrencySafe?`/`isDestructive?`) | cc 분석 + Vercel AI SDK + Mastra | **P0** | S (1h) | Slice 1b — Tool 정의 정식 확장 |
   121	| **D11** | Tool context schema (sessionId/dir/abort/ask) — D05 보강 | opencode + Vercel `ToolExecutionOptions` | P1 | S | Slice 1b → 2 보강 |
   122	| **D12** | onStepFinish/onChunk callback 표준 — Logger event 보강 | Vercel `onStepFinish` + Mastra hook | P1 | S | Slice 2 |
   123	| **D13** | Compaction 3중 방어 (overflow + onstep + abort signal) — D07 강화 | Mastra + cleanroom F11 silent drop 회피 | P1 | M | Slice 4 (D07과 통합) |
   124	| **D14** | Eval scorers framework (MastraScorer interface) | Mastra | P1 | M | Slice 5 또는 R3+ |
   125	| **D15** | Memory 3-tier blueprint (history/working/observational) | Mastra | P2 | M | alpha-memory R3+ spec only |
   126	| **D16** | Prompt cache opinionated 정책 (passthrough → 정책) — **C04 격상** | Vercel `cache_control` + Anthropic provider 자동 처리 | P1 | S | Slice 2 이후 |
   127	| **D17** | Provider fallback array (`model: [{...}, {...}]`) | Mastra + Vercel | P2 | S | Slice 2 이후 백로그 (multi-provider 진입 전) |
   128	| **D18** | **Hybrid wrapper path (B)** — opencode + claude-code SDK를 sub-agent로 wrap, naia-agent는 thin supervisor | R4 (사용자 본질 고민 — 1인 70k+ LOC 풀 build 불가) | **P0** | XL (Phase 1~4) | apps/cli + adapters/{opencode,claude-code,shell} |
   129	| **D19** | **단일 대화 + workspace 가시성 + 자동 verification + 수치 정직 보고** | R4 (사용자 vision — 보고 ≠ 실제 낭패 해소) | **P0** | L | apps/cli/repl + workspace/{watcher,diff} + verification/* + report/formatter |
   130	| **D20** | **NaiaStreamChunk multi-modal protocol** (text/audio/image/tool/workspace/session/verification/report/interrupt) | R4 (omni-voice 시대 vllm-omni / GPT-4o realtime) | **P0** | M | packages/types/src/stream.ts + core/stream-merger |
   131	| **D21** | **Real-time interrupt + pause/resume** (음성 "중지중지" / Ctrl+C / 카드 [중지]) | R4 (사용자 통제권) | **P0** | M | core/interrupt + adapter cancel/pause/resume contract |
   132	| **D22** | **vllm-omni adapter** (omni audio output, audio_delta passthrough) | R4 + 사용자 자체 fork (nextain/vllm-omni MiniCPM-o 4.5) | P1 | L | adapters/vllm-omni (Phase 4+) |
   133	| ~~D23~~ | ~~**Vercel AI SDK 보류** — any-llm으로 충분 (multi-provider routing은 원격 gateway). 외부 distribution 시 재검토~~ — **SUPERSEDED by D44 (2026-04-29)**. D23 근거의 결함: any-llm gateway는 원격 naia 계정 한정이고, 사용자 자체 키 환경에서는 multi-provider 확보 못함. 5개 자체 provider는 이전 naia-os/agent에서 carry-over일 뿐 실질 신규 abstraction 아님 | R4 (any-llm = naia 자체 fork, naia-anyllm) | ~~P2~~ | — | superseded |
   134	| **D24** | **Sub-agent supervisor pattern** (ACP/Claude SDK adapter + 다중 session orchestration + audit trail) | R4 (사용자 다중 터미널 워크플로우 자동화) | **P0** | L | core/supervisor + adapters/{opencode,claude-code} + observability audit |
   135	| **D25** | **Tool context schema 정형화** (sessionId/workingDir/ask/tier) — SpawnContext.toolContext | R4 cross-review (opencode + Vercel) | **P0** | S | adapters/* — `ToolExecutionContext` interface (adapter-contract.md §2) |
   136	| **D26** | **onSessionEnd hook → session_aggregated chunk** (supervisor가 stats/verification aggregate 후 emit, report 전 단계) | R4 cross-review (Mastra + Vercel onStepFinish, D12 보강) | **P0** | S | core/supervisor + stream-protocol.md §5b 신규 |
   137	| **D27** | **Verification 3중 방어** (abort signal + memory limit + wall-clock timeout) | R4 cross-review (Mastra D13 + cleanroom F11 회피) | **P0** | M | verification/orchestrator + architecture-hybrid.md §6b |
   138	| **D28** | **Memory 3-tier blueprint** (D15 구체화 — history/working/observational) | R4 cross-review (Mastra) | P1 | M | alpha-memory adapter Phase 3 진입 시 정식화 |
   139	| **D29** | **viseme vocabulary spec** (AEIOU + lipsync 알고리즘, NaiaStreamChunk audio_delta 확장) | R4 cross-review (project-airi D03) | P1 | M | stream-protocol.md audio_delta + Phase 4 X7 (TTS extraction) |
   140	| **D30** | **Verification 3중 방어 재근거화** (cleanroom 단독 의존 해제 → OWASP/Mastra 출처 cross-reference) | R4 Week 0 2차 cross-review (Reference) | P1 | S | docs/verification-audit.md 신설 (Phase 4 verification pkg 완료 후) — F09 강제 |
   141	| **D31** | **onSessionEnd hook 정형화** (D26 구체화 — supervisor pseudo-code 예시) | R4 Week 0 2차 cross-review (Reference) | P1 | S | stream-protocol.md §5b 명시화 (현 docs에 이미 일부 있음) — Phase 2 supervisor 구현 시 |
   142	| **D32** | **bash/file-ops dev-only marker** (R3 250 PASS test 보존 정책 명시) | R4 Week 0 2차 cross-review (Reference + Paranoid R3-R4) | **P0** | S | runtime/skills/README.md 신설 + bash/file-ops test에 `describe.skip(production)` marker — Day 1 진행 중 |
   143	| **D33** | **opencode `run --format json` JSON event protocol** (Phase 1 채택, ACP는 Phase 2) | R4 Week 0 spike 2026-04-26 | **P0** | S | adapters/opencode-cli/ — Phase 1 정식 path. JSON event NDJSON parse → NaiaStreamChunk 변환 |
   144	| **D43** | **naia-agent의 STT/TTS provider abstraction** (Vercel AI SDK 패턴, omni audio_delta 호환) — naia-os는 device IO만 (mic/speaker via Tauri Rust cpal) | R4 Phase 4 cross-review 사용자 통찰 — "tts/stt naia-shell 처리 시 omni 곤란" | P1 | M | naia-agent에 audio provider layer (Vercel `experimental_generateSpeech` / `experimental_transcribe` 패턴) — Phase 5+ |
   145	| **D44** | **Vercel AI SDK 로컬 LLM 단일 abstraction 채택** (D23 supersede) — `ai` core를 peer dep, `@ai-sdk/<provider>`도 optional peer dep. 50+ provider 즉시 호환. 자체 5개(`anthropic`/`anthropic-vertex`/`gemini`/`openai-compat`/`claude-cli`) → `VercelClient` adapter 1개로 대체. CLI 구독 path는 community provider (`ai-sdk-provider-claude-code`/`-codex-cli`/`-gemini-cli`/`-opencode-sdk`)로 흡수. **lab-proxy / lab-proxy-live는 보존** (naiaKey 보호 + WebSocket Live API, Vercel 영역 밖). vllm-omni 텍스트 mode = `@ai-sdk/openai-compatible`로 즉시 호환, audio_delta realtime은 D43 자체 layer 유지 | 사용자 directive 2026-04-29 — D23 silent drift 정정. 토큰 부족 → multi-provider 확보 절실. RunPod naia 계정 통합은 별도 (D45 후보) | **P0** | L (Phase 5.x slices) | packages/providers/src/vercel-client.ts (adapter) + 5개 자체 provider deprecate → 제거 (slice 시퀀스). bin / examples / fixture-replay 갱신 |
   146	
   147	---
   148	
   149	## E. Drift 위험 — 적혔지만 코드/테스트로 pin 안 됨
   150	

exec
/bin/bash -lc "nl -ba projects/naia-agent/.agents/context/agents-rules.json | sed -n '1,100p'" in /var/home/luke/alpha-adk
 succeeded in 0ms:
     1	{
     2	  "$schema": "https://schemas.nextain.com/agents-rules-v1.json",
     3	  "project": "naia-agent",
     4	  "version": "0.1.0",
     5	  "updated": "2026-04-29",
     6	  "phase": "R5 LOCKED (Vercel AI SDK adoption — Slices 5.x.0~5.x.6 complete; R6 candidates = Tier B 8건 + D53 RunPod)",
     7	  "mandatory_reads": [
     8	    "AGENTS.md",
     9	    ".agents/progress/design-recheck-2026-04-25.md",
    10	    ".agents/progress/ref-adoption-matrix.md",
    11	    ".agents/progress/runnable-testable-gap.md",
    12	    ".agents/progress/r1-slice-spine-2026-04-25.md",
    13	    ".agents/progress/dev-framework-and-process.md",
    14	    ".agents/progress/multi-tool-harness.md"
    15	  ],
    16	  "supplementary_reads_security": [
    17	    ".agents/progress/refs/cc-cleanroom-security-audit-2026-04-25.md",
    18	    ".agents/progress/refs/cc-cleanroom-deep-audit-2026-04-25.md"
    19	  ],
    20	  "mandatory_reads_upstream": [
    21	    "../../alpha-adk/.agents/progress/naia-4repo-migration-plan.md",
    22	    "../../alpha-adk/.agents/progress/direction-2026-04-25.md"
    23	  ],
    24	  "forbidden_actions": [
    25	    {
    26	      "id": "F01",
    27	      "rule": "no_code_change_without_skeleton",
    28	      "description": "bin/naia-agent 진입점 미존재 시 packages/core/src/agent.ts 수정 금지, packages/runtime/src/ 신규 파일 추가 금지(테스트 제외), examples/ 외 위치에 새 host 코드 작성 금지",
    29	      "release_condition": "issue #3 (G01 bin/naia-agent) close",
    30	      "exemption": "보안 패치(CVE-worthy) — F01 차단 면제. 단 단위 테스트 동시 도입 강제. 4-repo plan A.13 보안 패치 lockstep 면제 원칙 적용"
    31	    },
    32	    {
    33	      "id": "F02",
    34	      "rule": "no_phase_d_branch_modification",
    35	      "description": "migration/phase-d 브랜치(Phase B + C.2 = 189 unit test) 절대 push/merge 금지. PAUSED 상태 보존",
    36	      "release_condition": "사용자 명시 directive (재개)"
    37	    },
    38	    {
    39	      "id": "F03",
    40	      "rule": "no_ref_modification",
    41	      "description": "projects/refs/ref-* 하위 모든 파일 수정·삭제 금지. submodule clean 유지",
    42	      "release_condition": "never (영구 read-only)"
    43	    },
    44	    {
    45	      "id": "F04",
    46	      "rule": "no_cleanroom_redistribution",
    47	      "description": "projects/refs/ref-cc-cleanroom (ghuntley) 코드 복붙·재배포 금지. 패턴 reference로만",
    48	      "release_condition": "never"
    49	    },
    50	    {
    51	      "id": "F05",
    52	      "rule": "no_cc_source_reextract_without_consent",
    53	      "description": "projects/refs/ref-cc (nextain private) 원본 source 재추출 시도 시 사용자 승인 필요",
    54	      "release_condition": "사용자 승인"
    55	    },
    56	    {
    57	      "id": "F06",
    58	      "rule": "no_d_decisions_modification",
    59	      "description": "docs/agent-loop-design.md D1~D8 결정 수정 금지. 신규 결정만 ref-adoption-matrix.md §D에 추가",
    60	      "release_condition": "never (보존)"
    61	    },
    62	    {
    63	      "id": "F07",
    64	      "rule": "no_part_a_modification",
    65	      "description": "alpha-adk/.agents/progress/naia-4repo-migration-plan.md Part A 수정 금지. 본 레포 R0는 실행 시퀀싱만 변경",
    66	      "release_condition": "새 plan 버전 + 사용자 승인"
    67	    },
    68	    {
    69	      "id": "F08",
    70	      "rule": "no_r1_plan_with_open_p0",
    71	      "description": "OPEN P0 sub-issue 1건이라도 있으면 R1 plan 작성 차단",
    72	      "release_condition": "P0 sub-issue 모두 close (#3, #4, #5, #6)"
    73	    },
    74	    {
    75	      "id": "F09",
    76	      "rule": "no_cleanroom_sole_dependency",
    77	      "description": "ref-cc-cleanroom (ghuntley) 단독 의존 금지. D01(DANGEROUS_COMMANDS regex) / D02(Path normalize) 같은 패턴 차용 시 OWASP/RFC/Anthropic 1차 spec 출처 docs 1건 이상 cross-reference 강제. cleanroom 코드 라인 직접 복붙 금지(B22). 근거: cc-cleanroom-deep-audit F1~F12 LLM 환각/silent drift + repo archived 2025-03 + 2 commits only",
    78	      "release_condition": "never (영구 강제)",
    79	      "enforcement": "PR description에 'OWASP/RFC 출처 명시' 체크박스 추가 (Slice 2 진입 시 PR template 신설)"
    80	    },
    81	    {
    82	      "id": "F11",
    83	      "rule": "anthropic_sdk_minor_bump_requires_fixture_replay",
    84	      "description": "@anthropic-ai/sdk minor 이상 버전 bump PR은 fixture-replay 재녹화 + StreamPlayer 재생 검증 의무. SDK breaking change 사전 감지",
    85	      "release_condition": "Slice 5 fixture-replay framework 정식 도입 후 자동화 가능"
    86	    }
    87	  ],
    88	  "required_actions_for_slice_pr": [
    89	    {
    90	      "id": "S01",
    91	      "rule": "new_runnable_command",
    92	      "description": "슬라이스 PR은 새 실행 가능 명령 1+ 도입 필수 (예: pnpm exec naia-agent ...)"
    93	    },
    94	    {
    95	      "id": "S02",
    96	      "rule": "unit_test_1_plus",
    97	      "description": "vitest 단위 테스트 1+ 도입"
    98	    },
    99	    {
   100	      "id": "S03",

exec
/bin/bash -lc "nl -ba projects/naia-agent/.agents/progress/issue-draft-agent-eval-framework.md | sed -n '85,120p'" in /var/home/luke/alpha-adk
 succeeded in 0ms:
    85	- D1~D8(F06) / 4repo plan Part A(F07) 수정.
    86	
    87	## 6. 프로세스 위치 / 게이트 (정직)
    88	
    89	- naia-agent phase = **R5 LOCKED**. 이 작업 = **R6 candidate**. 신규
    90	  패턴(omni-localmodel-as-non-LLMClient backend + context 주입 + agent-
    91	  flow eval) → AGENTS 규칙 #4: ref-adoption-matrix **§D 항목 신설 +
    92	  sub-issue** 필요. 다음 세션이 mandatory reads 후 §D/슬라이스 확정.
    93	- 코드 착수 게이트: F01(스켈레톤/슬라이스), slice S01~S04, matrix ID
    94	  citation, karpathy 4원칙. 이 문서는 *계획* 산출물(코드 아님).
    95	
    96	## 7. 할 일 — GPU 유무 분리
    97	
    98	### Phase 1 — GPU 불요 (다음 세션 바로 가능)
    99	- [ ] mandatory reads 완독 → ref-adoption-matrix §D 항목 + sub-issue(#2 하위) 등록
   100	- [ ] agent-flow 평가 하니스 설계 (지표·fixture-replay 스키마·G15)
   101	- [ ] v2 계약 → TS 인터페이스 타입 초안 (`@nextain/agent-types` 영향 검토)
   102	- [ ] minicpm connector 설계 (이벤트 매핑, context 주입 시점, §4/§5 한계 반영)
   103	- [ ] RAG+memory→context 조립 flow 설계
   104	- [ ] (F01/slice 충족 시) `examples/minicpm-realtime-host.ts` + fixture + unit test 스켈레톤
   105	
   106	### Phase 2 — GPU 필요 (ko-serve worker, 별도)
   107	- [ ] ko-serve worker+gateway 재시작 → `/v1/realtime` 라이브 e2e (G3 context / G1 telemetry 실검증)
   108	- [ ] 실 backend 통합 검증(S03) — agent+RAG+memory+minicpm 라이브
   109	- [ ] agent-flow 벤치 실측 → 품질 baseline
   110	
   111	## 8. Acceptance (slice success criterion)
   112	
   113	S01 새 실행 명령 · S02 unit test 1+ · S03 통합검증(Phase1 fixture-replay
   114	/ Phase2 실 backend) · S04 README·CHANGELOG · matrix §D ID 인용.
   115	
   116	## 9. Cross-ref
   117	
   118	- ko-serve(`nextain/naia-minicpm-ko-serve`) = PAUSED. agent-flow 평가
   119	  프레임웍은 **여기(naia-agent)** 책임. ko-serve `current.json` 에 본
   120	  문서로의 포인터 기록됨(cross-ref).

exec
/bin/bash -lc "nl -ba projects/naia-agent/docs/agent-loop-design.md | sed -n '15,120p'" in /var/home/luke/alpha-adk
 succeeded in 0ms:
    15	## Decisions
    16	
    17	### D1. Stream-first API, `send()` as drain wrapper
    18	
    19	```
    20	Agent.sendStream(userText, signal?): AsyncGenerator<AgentStreamEvent>
    21	Agent.send(userText, signal?): Promise<string>  // drains sendStream
    22	```
    23	
    24	**Why**: streaming is the only shape compatible with alpha-memory's
    25	planned real-time compaction (it wants to observe generation as it
    26	happens). `send()` as a convenience wrapper keeps the simple case simple.
    27	
    28	Ref: careti (stream-based) > opencode (also stream, via Effect).
    29	
    30	### D2. Compaction delegated to MemoryProvider via `CompactableCapable`
    31	
    32	```ts
    33	// @nextain/agent-types/memory.ts
    34	export interface CompactableCapable {
    35	  compact(input: CompactionInput): Promise<CompactionResult>;
    36	}
    37	```
    38	
    39	**Why**:
    40	- **Alpha-memory integration target** — memory already owns consolidation; compaction is a natural extension.
    41	- **Real-time future** — alpha-memory can evolve `compact()` from on-demand to pre-computed (maintain rolling summary during `encode()` calls). Agent code does not change.
    42	- **Graceful degradation** — if `memory` does not implement the capability, Agent falls back to simple sliding-window truncation (keep tail N, drop head).
    43	
    44	Ref: opencode formalized compaction but tied it to its own DB; we abstract
    45	to a capability interface so any memory can plug in.
    46	
    47	### D3. Compaction policy constants (agent-side)
    48	
    49	| Param | Default | Why |
    50	|---|---:|---|
    51	| `contextBudget` | 80_000 tokens | Safe for most 128K+ context models |
    52	| `compactionKeepTail` | 6 messages | ~3 turns; matches opencode `DEFAULT_TAIL_TURNS = 2` (bit more generous) |
    53	| `estimateTokens` | chars/4 heuristic | Host injects provider-accurate tokenizer when available |
    54	
    55	Triggered before every LLM call (inside the tool-hop loop), so long
    56	tool-use chains eventually compact themselves instead of exploding.
    57	
    58	### D4. Tool-hop loop bounded by `maxToolHops` (default 10)
    59	
    60	**Why**: matches careti's `MAX_TOOL_ITERATIONS = 10`. Prevents
    61	runaway loops, surfaces the condition via `turn.ended` with stub text
    62	`[agent stopped — reached max tool-hop budget]`. Logger emits warning.
    63	
    64	### D5. Tool execution delegated via `HostContext.tools` + `tierForTool` resolver
    65	
    66	Agent does not implement approval, tier policy, or actual execution. It
    67	constructs a `ToolInvocation` with tier from the caller-provided resolver
    68	and delegates to `HostContext.tools.execute()`. Wrap with
    69	`GatedToolExecutor` (from `@nextain/agent-runtime`) for tier-based
    70	approval flow, or a plain executor for tests.
    71	
    72	**Why**: matches plan A.6 — tier enforcement lives in runtime's
    73	`ToolExecutor` impl, shell owns approval UI via `ApprovalBroker`.
    74	
    75	Ref: careti's `needsApproval(call.name)` → `waitForApproval(...)` pattern,
    76	but factored behind an interface rather than inlined.
    77	
    78	### D6. Memory `encode` at turn end, `recall` at turn start
    79	
    80	- Turn start: `recall(userText, { topK: 5 })` — injects memory hits into system prompt
    81	- Turn end: `encode(userText, "user")` + `encode(assistantText, "assistant")`
    82	
    83	**Why**: minimum viable bidirectional flow. Advanced hooks (mid-stream
    84	encoding, selective tool-result encoding) are deferred to a future
    85	iteration. The contract allows them — any memory that wants stream-level
    86	granularity can add a sub-capability.
    87	
    88	Note: `encode()` errors are caught and logged but do not fail the turn —
    89	memory is non-critical to the user-visible response.
    90	
    91	### D7. Session lifecycle owned by Agent
    92	
    93	Agent owns a `Session` object, transitions it through `ALLOWED_TRANSITIONS`
    94	from `@nextain/agent-types/session.ts`. Emits `session.{created,active,...}`
    95	events via Logger. `close()` transitions to `closed` and calls
    96	`memory.close()`.
    97	
    98	**Why**: plan A.5 — `naia-agent/core` owns session transition logic;
    99	storage lives elsewhere.
   100	
   101	### D8. `AgentStreamEvent` union surfaces every observable
   102	
   103	```ts
   104	type AgentStreamEvent =
   105	  | { type: "session.started"; session }
   106	  | { type: "turn.started"; userText; recalled }
   107	  | { type: "llm.chunk"; chunk }
   108	  | { type: "tool.started"; invocation }
   109	  | { type: "tool.ended"; invocation; result }
   110	  | { type: "compaction"; droppedCount; realtime }
   111	  | { type: "usage"; usage }
   112	  | { type: "turn.ended"; assistantText }
   113	  | { type: "session.ended"; state };
   114	```
   115	
   116	**Why**: lets hosts (TUI, web UI, logging) observe internal transitions
   117	without bolting event listeners. `llm.chunk` forwards the raw
   118	`LLMStreamChunk` for low-level cases (token-by-token rendering).
   119	
   120	Ref: opencode's BusEvent is more elaborate (publish-subscribe across

exec
/bin/bash -lc "nl -ba projects/naia-adk/AGENTS.md | sed -n '1,40p'" in /var/home/luke/alpha-adk
exec
/bin/bash -lc "nl -ba projects/naia-business-adk/README.md | sed -n '1,80p'" in /var/home/luke/alpha-adk
 succeeded in 0ms:
     1	# Naia ADK
     2	
     3	AI Development Kit — an open-source framework for personal and business AI operations.
     4	Fork, configure, connect to your AI tools. [`nextain/naia-adk`](https://github.com/nextain/naia-adk)
     5	
     6	## Fork Chain
     7	
     8	```
     9	naia-adk                  ← Base (public, Apache 2.0)
    10	  └── {org}-adk           ← Organization fork: company data + business submodules
    11	        └── {user}-adk    ← Personal fork: personal data + project submodules
    12	```
    13	
    14	Fork on GitHub, then periodically sync upstream: `git fetch upstream && git merge upstream/main`
    15	
    16	## Mandatory Reads
    17	
    18	**Read these files at the start of every session:**
    19	
    20	1. `.agents/context/agents-rules.json` — Project rules (SoT)
    21	2. `.agents/context/ai-work-index.yaml` — Work type → workflow index
    22	3. `.agents/context/project-index.yaml` — Context index + entry points
    23	
    24	**On-demand (read when entering Plan or Review phases):**
    25	
    26	4. `.agents/requirements/_index.yaml` — Product requirements index
    27	5. `.agents/context/skills-index.yaml` — Skill trigger/summary index
    28	
    29	## Project Structure
    30	
    31	### Workspace Directories
    32	
    33	| Directory | Tier | Purpose |
    34	|-----------|------|---------|
    35	| `data-company/` | T2 | Company general data (gitignored, per-fork) |
    36	| `data-business/` | T3 | Company sensitive data (gitignored, per-fork) |
    37	| `data-private/` | T3 | Personal data (gitignored, per-fork) |
    38	| `projects/` | T2 | Project repos (gitignored, per-fork) |
    39	| `projects/refs/` | T2 | Reference repos (gitignored, per-fork) |
    40	| `skills/` | T1 | AI skills |

 succeeded in 0ms:
     1	[English](README.md)
     2	
     3	# Naia Business ADK
     4	
     5	**Organizational AI operating system extension for Naia workspaces.**
     6	
     7	Naia Business ADK is the business upstream of `naia-adk`.
     8	It extends the personal base with organizational governance for:
     9	
    10	- **assets** — repos, documents, secrets, customer data, brand assets
    11	- **process** — workflows, approvals, publishing, deployment, review
    12	- **permissions** — team ownership, delegated approval, disclosure boundaries
    13	
    14	For business use, this should explicitly include:
    15	
    16	- **RBAC** — author, reviewer, approver, releaser, auditor roles
    17	- **SDLC artifact tracking** — requirements, design docs, decision records, plans, reviews, tests, release artifacts, postmortems
    18	
    19	This is not just a premium skill bundle. Skills are one output of the model, not the whole product.
    20	
    21	## Position in the Fork Chain
    22	
    23	```text
    24	naia-adk
    25	  → personal base
    26	naia-business-adk
    27	  → business upstream
    28	{company}-adk
    29	  → company instance
    30	{member}-adk
    31	  → company-linked personal instance
    32	```
    33	
    34	Examples:
    35	
    36	```text
    37	naia-adk → naia-business-adk → nextain-adk → alpha-adk
    38	naia-adk → naia-business-adk → onmam-adk
    39	```
    40	
    41	## What It Adds
    42	
    43	Compared to `naia-adk`, `naia-business-adk` adds organizational concerns:
    44	
    45	- team ownership and role boundaries
    46	- approval-gated operations
    47	- RBAC and delegated approval
    48	- SDLC deliverable ownership and retention
    49	- customer / legal / finance sensitivity handling
    50	- business workflow expectations and templates
    51	- company instance and member instance operating patterns
    52	
    53	## What Stays Out
    54	
    55	`naia-business-adk` is still an upstream layer. It should not become:
    56	
    57	- a single company's source of truth
    58	- a single member's workspace
    59	- a dump of customer-specific internal rules
    60	
    61	Those belong in company instances such as `nextain-adk`, and in member instances such as `alpha-adk`.
    62	
    63	## Public vs Private Description
    64	
    65	It is valid to publicly describe:
    66	
    67	- that `naia-business-adk` exists
    68	- that it is the organizational extension of `naia-adk`
    69	- that it governs assets, process, and permissions for AI operations
    70	
    71	It is not necessary to publicly expose by default:
    72	
    73	- internal repo topology
    74	- customer-specific workflow internals
    75	- production approval chains
    76	
    77	## Status
    78	
    79	This repository is the business upstream. Company-specific products, data, and policy should be layered in downstream company instances.

codex
VERDICT: ISSUES_FOUND

[CRITICAL] 공격점1 FAIL: `service.manifest`를 `naia-adk` SoT로 두면서 `rag.sources`·`memory.binding`·`llm.backend`·`orchestration(graph)`를 담게 했고, SB-1에서도 `service-manifest 스키마 + loader`를 별 계약처럼 취급한다. 그런데 Part A는 zero-runtime-dep 계약을 `types`·`protocol`·`skill-spec` 3개로만 고정하고, capability 인터페이스는 `@nextain/agent-types` 소속이라고 못박는다. 신규 계약을 독립 패키지로 두면 A.4/A.11 밖의 “제4 계약”이 되고, `skill-spec` 내부로 접어 넣어도 런타임 taxonomy를 `naia-adk`가 소유하게 되어 A.3/A.6 소유 경계가 흐려진다. 현재 문서에는 이 충돌 해소가 없다. 근거: [agent-service-builder-architecture.md:79-92](</var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:79>), [agent-service-builder-architecture.md:157-159](</var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:157>), [agent-service-builder-architecture.md:177-179](</var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:177>), [naia-4repo-migration-plan.md:149-174](</var/home/luke/alpha-adk/.agents/progress/naia-4repo-migration-plan.md:149>), [naia-4repo-migration-plan.md:304](</var/home/luke/alpha-adk/.agents/progress/naia-4repo-migration-plan.md:304>)

[CRITICAL] 공격점6 FAIL: 이 문서는 R6용 구체 slice 계획과 MVP 순서를 이미 써놓았는데, naia-agent F08은 OPEN P0가 하나라도 있으면 R1 plan 작성 자체를 차단한다. #31도 R6 candidate로서 먼저 `§D 항목 + sub-issue`를 세우고, F01/slice 조건이 맞아야 skeleton에 들어가라고 적는다. 초안은 이를 “착수 전 재확인”으로만 미루고 Phase 1 SB-1~SB-4를 실행 가능한 순서처럼 제시한다. baseline gate를 우회한 낙관이다. 근거: [agent-service-builder-architecture.md:163-201](</var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:163>), [agent-service-builder-architecture.md:211](</var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:211>), [agents-rules.json:69-72](</var/home/luke/alpha-adk/projects/naia-agent/.agents/context/agents-rules.json:69>), [issue-draft-agent-eval-framework.md:89-105](</var/home/luke/alpha-adk/projects/naia-agent/.agents/progress/issue-draft-agent-eval-framework.md:89>)

[MAJOR] 공격점2 FAIL: LangGraph 해소안 A는 아직 “이름만 바꾼 graph” 수준이다. B20이 거부한 것은 단순히 라이브러리명이 아니라 reducer 중심 상태모델이고, D1/D8은 `AsyncGenerator<AgentStreamEvent>` 기반 stream-first를 고정한다. 그런데 초안은 `OrchestrationPolicy + 경량 graph executor`라고만 쓰고, 분기 병합 시 상태 합성 규칙, concurrent branch의 chunk interleave, cancellation/backpressure, tool/result가 step state로 들어갈 때의 non-reducer 모델을 전혀 정의하지 않았다. 이 상태로는 reducer를 숨겨 재도입하거나, 반대로 실제로는 직렬 step executor로 축소될 가능성이 크다. 근거: [ref-adoption-matrix.md:70-71](</var/home/luke/alpha-adk/projects/naia-agent/.agents/progress/ref-adoption-matrix.md:70>), [agent-loop-design.md:17-28](</var/home/luke/alpha-adk/projects/naia-agent/docs/agent-loop-design.md:17>), [agent-loop-design.md:101-118](</var/home/luke/alpha-adk/projects/naia-agent/docs/agent-loop-design.md:101>), [agent-service-builder-architecture.md:126-135](</var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:126>), [agent-service-builder-architecture.md:183-185](</var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:183>)

[MAJOR] 공격점3 FAIL: fork chain 4단계 설명 자체보다 “무엇이 canonical인가”의 소유권 선언이 모순이다. 초안은 `naia-business-adk/README`를 canonical로 두고 `naia-adk/AGENTS.md`를 이에 맞춰 정합하겠다고 쓰지만, Part A.11은 private fork 변종을 비공식으로 두고 공개 4 repo 계약만 canonical이라 못박는다. 더구나 `service manifest`는 `naia-adk` SoT라고 주장하면서도 A.6/A.11에는 그 포맷이 public contract인지 internal workspace file인지 전혀 승격되어 있지 않다. 즉 축1/축2 직교 모델 설명은 있어도, public canonical 소스와 runtime-facing schema ownership은 정합되지 않는다. 근거: [agent-service-builder-architecture.md:53-65](</var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:53>), [agent-service-builder-architecture.md:157-159](</var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:157>), [naia-4repo-migration-plan.md:207-209](</var/home/luke/alpha-adk/.agents/progress/naia-4repo-migration-plan.md:207>), [naia-4repo-migration-plan.md:287-288](</var/home/luke/alpha-adk/.agents/progress/naia-4repo-migration-plan.md:287>), [naia-adk/AGENTS.md:6-12](</var/home/luke/alpha-adk/projects/naia-adk/AGENTS.md:6>)

[MAJOR] 공격점4 FAIL: “naia-business-adk는 구현만, 계약 미수정”이라는 선언으로는 README가 요구하는 RBAC·approval-gated ops·SDLC artifact tracking·retention·sensitivity handling을 얹을 수 있는지 입증되지 않는다. 이 정보가 manifest 밖의 wrapper에만 있으면 서비스 정의의 portable/reproducible 성질이 깨지고, manifest 안에 들어가면 스키마 확장 없이 불가능하다. 초안은 `manifest governance 래퍼`라는 말만 있고 role binding, tenant boundary, approval chain, retention policy의 위치와 enforce 주체를 지정하지 않았다. 근거: [agent-service-builder-architecture.md:141-159](</var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:141>), [agent-service-builder-architecture.md:195-196](</var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:195>), [naia-business-adk/README.md:14-18](</var/home/luke/alpha-adk/projects/naia-business-adk/README.md:14>), [naia-business-adk/README.md:43-51](</var/home/luke/alpha-adk/projects/naia-business-adk/README.md:43>)

[누락] 공격점5 FAIL: builder layer에 A.11 교차 관심사가 어떻게 적용되는지 빠져 있다. `ServiceManifestLoader`, `RAGProvider`, `OrchestrationPolicy`가 어떤 상태 전이에서 `Event`를 emit하는지, manifest parse/retrieval/policy step 실패를 어떤 `ErrorEvent` shape으로 경계 밖에 내보내는지, shell audit 소유와 tier T2+ 필수 기록이 service 빌드/실행 흐름에 어떻게 연결되는지, regression gate를 어떤 baseline으로 측정할지 문서에 없다. 근거: [agent-service-builder-architecture.md:177-188](</var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:177>), [agent-service-builder-architecture.md:198-201](</var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:198>), [naia-4repo-migration-plan.md:183-185](</var/home/luke/alpha-adk/.agents/progress/naia-4repo-migration-plan.md:183>), [naia-4repo-migration-plan.md:283-292](</var/home/luke/alpha-adk/.agents/progress/naia-4repo-migration-plan.md:283>)

[MINOR] 공격점7 FAIL: 첫 데모 전에 `service.manifest`, `ServiceManifestLoader`, `RAGProvider`, `OrchestrationPolicy`, `eval.fixtures`, business governance wrapper까지 한 번에 세운다. 이는 “한 서비스가 실제로 돈다”는 최소 증명보다 추상화 선행이다. 게다가 핵심 가정 둘, 즉 “LangGraph는 패턴 요구일 뿐”과 “service manifest SoT는 naia-adk”가 아직 검증되지 않았는데도 아키텍처의 축으로 사용한다. karpathy식 단순화보다 선행 추상화가 많다. 근거: [agent-service-builder-architecture.md:79-97](</var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:79>), [agent-service-builder-architecture.md:177-196](</var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:177>), [agent-service-builder-architecture.md:205-212](</var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:205>)

종합 1문단: 개발 착수 불가다. 핵심은 둘이다. 첫째, `service.manifest`의 소유권과 계약 지위가 Part A의 3계약 체계와 정합되지 않아 A.3/A.11 경계를 이미 흔든다. 둘째, R6 slice/MVP 순서가 F08·#31 gate를 “나중에 재확인”으로 밀어 baseline 절차를 어겼다. 최소한 `service.manifest`를 public contract가 아닌 내부 workspace format으로 둘지, 아니면 Part A 승격 없이는 금지할지 먼저 닫고, OPEN P0 및 `§D + sub-issue` 게이트를 선행 폐쇄하기 전에는 이 설계로 착수하면 안 된다.
tokens used
76,423
VERDICT: ISSUES_FOUND

[CRITICAL] 공격점1 FAIL: `service.manifest`를 `naia-adk` SoT로 두면서 `rag.sources`·`memory.binding`·`llm.backend`·`orchestration(graph)`를 담게 했고, SB-1에서도 `service-manifest 스키마 + loader`를 별 계약처럼 취급한다. 그런데 Part A는 zero-runtime-dep 계약을 `types`·`protocol`·`skill-spec` 3개로만 고정하고, capability 인터페이스는 `@nextain/agent-types` 소속이라고 못박는다. 신규 계약을 독립 패키지로 두면 A.4/A.11 밖의 “제4 계약”이 되고, `skill-spec` 내부로 접어 넣어도 런타임 taxonomy를 `naia-adk`가 소유하게 되어 A.3/A.6 소유 경계가 흐려진다. 현재 문서에는 이 충돌 해소가 없다. 근거: [agent-service-builder-architecture.md:79-92](</var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:79>), [agent-service-builder-architecture.md:157-159](</var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:157>), [agent-service-builder-architecture.md:177-179](</var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:177>), [naia-4repo-migration-plan.md:149-174](</var/home/luke/alpha-adk/.agents/progress/naia-4repo-migration-plan.md:149>), [naia-4repo-migration-plan.md:304](</var/home/luke/alpha-adk/.agents/progress/naia-4repo-migration-plan.md:304>)

[CRITICAL] 공격점6 FAIL: 이 문서는 R6용 구체 slice 계획과 MVP 순서를 이미 써놓았는데, naia-agent F08은 OPEN P0가 하나라도 있으면 R1 plan 작성 자체를 차단한다. #31도 R6 candidate로서 먼저 `§D 항목 + sub-issue`를 세우고, F01/slice 조건이 맞아야 skeleton에 들어가라고 적는다. 초안은 이를 “착수 전 재확인”으로만 미루고 Phase 1 SB-1~SB-4를 실행 가능한 순서처럼 제시한다. baseline gate를 우회한 낙관이다. 근거: [agent-service-builder-architecture.md:163-201](</var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:163>), [agent-service-builder-architecture.md:211](</var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:211>), [agents-rules.json:69-72](</var/home/luke/alpha-adk/projects/naia-agent/.agents/context/agents-rules.json:69>), [issue-draft-agent-eval-framework.md:89-105](</var/home/luke/alpha-adk/projects/naia-agent/.agents/progress/issue-draft-agent-eval-framework.md:89>)

[MAJOR] 공격점2 FAIL: LangGraph 해소안 A는 아직 “이름만 바꾼 graph” 수준이다. B20이 거부한 것은 단순히 라이브러리명이 아니라 reducer 중심 상태모델이고, D1/D8은 `AsyncGenerator<AgentStreamEvent>` 기반 stream-first를 고정한다. 그런데 초안은 `OrchestrationPolicy + 경량 graph executor`라고만 쓰고, 분기 병합 시 상태 합성 규칙, concurrent branch의 chunk interleave, cancellation/backpressure, tool/result가 step state로 들어갈 때의 non-reducer 모델을 전혀 정의하지 않았다. 이 상태로는 reducer를 숨겨 재도입하거나, 반대로 실제로는 직렬 step executor로 축소될 가능성이 크다. 근거: [ref-adoption-matrix.md:70-71](</var/home/luke/alpha-adk/projects/naia-agent/.agents/progress/ref-adoption-matrix.md:70>), [agent-loop-design.md:17-28](</var/home/luke/alpha-adk/projects/naia-agent/docs/agent-loop-design.md:17>), [agent-loop-design.md:101-118](</var/home/luke/alpha-adk/projects/naia-agent/docs/agent-loop-design.md:101>), [agent-service-builder-architecture.md:126-135](</var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:126>), [agent-service-builder-architecture.md:183-185](</var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:183>)

[MAJOR] 공격점3 FAIL: fork chain 4단계 설명 자체보다 “무엇이 canonical인가”의 소유권 선언이 모순이다. 초안은 `naia-business-adk/README`를 canonical로 두고 `naia-adk/AGENTS.md`를 이에 맞춰 정합하겠다고 쓰지만, Part A.11은 private fork 변종을 비공식으로 두고 공개 4 repo 계약만 canonical이라 못박는다. 더구나 `service manifest`는 `naia-adk` SoT라고 주장하면서도 A.6/A.11에는 그 포맷이 public contract인지 internal workspace file인지 전혀 승격되어 있지 않다. 즉 축1/축2 직교 모델 설명은 있어도, public canonical 소스와 runtime-facing schema ownership은 정합되지 않는다. 근거: [agent-service-builder-architecture.md:53-65](</var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:53>), [agent-service-builder-architecture.md:157-159](</var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:157>), [naia-4repo-migration-plan.md:207-209](</var/home/luke/alpha-adk/.agents/progress/naia-4repo-migration-plan.md:207>), [naia-4repo-migration-plan.md:287-288](</var/home/luke/alpha-adk/.agents/progress/naia-4repo-migration-plan.md:287>), [naia-adk/AGENTS.md:6-12](</var/home/luke/alpha-adk/projects/naia-adk/AGENTS.md:6>)

[MAJOR] 공격점4 FAIL: “naia-business-adk는 구현만, 계약 미수정”이라는 선언으로는 README가 요구하는 RBAC·approval-gated ops·SDLC artifact tracking·retention·sensitivity handling을 얹을 수 있는지 입증되지 않는다. 이 정보가 manifest 밖의 wrapper에만 있으면 서비스 정의의 portable/reproducible 성질이 깨지고, manifest 안에 들어가면 스키마 확장 없이 불가능하다. 초안은 `manifest governance 래퍼`라는 말만 있고 role binding, tenant boundary, approval chain, retention policy의 위치와 enforce 주체를 지정하지 않았다. 근거: [agent-service-builder-architecture.md:141-159](</var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:141>), [agent-service-builder-architecture.md:195-196](</var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:195>), [naia-business-adk/README.md:14-18](</var/home/luke/alpha-adk/projects/naia-business-adk/README.md:14>), [naia-business-adk/README.md:43-51](</var/home/luke/alpha-adk/projects/naia-business-adk/README.md:43>)

[누락] 공격점5 FAIL: builder layer에 A.11 교차 관심사가 어떻게 적용되는지 빠져 있다. `ServiceManifestLoader`, `RAGProvider`, `OrchestrationPolicy`가 어떤 상태 전이에서 `Event`를 emit하는지, manifest parse/retrieval/policy step 실패를 어떤 `ErrorEvent` shape으로 경계 밖에 내보내는지, shell audit 소유와 tier T2+ 필수 기록이 service 빌드/실행 흐름에 어떻게 연결되는지, regression gate를 어떤 baseline으로 측정할지 문서에 없다. 근거: [agent-service-builder-architecture.md:177-188](</var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:177>), [agent-service-builder-architecture.md:198-201](</var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:198>), [naia-4repo-migration-plan.md:183-185](</var/home/luke/alpha-adk/.agents/progress/naia-4repo-migration-plan.md:183>), [naia-4repo-migration-plan.md:283-292](</var/home/luke/alpha-adk/.agents/progress/naia-4repo-migration-plan.md:283>)

[MINOR] 공격점7 FAIL: 첫 데모 전에 `service.manifest`, `ServiceManifestLoader`, `RAGProvider`, `OrchestrationPolicy`, `eval.fixtures`, business governance wrapper까지 한 번에 세운다. 이는 “한 서비스가 실제로 돈다”는 최소 증명보다 추상화 선행이다. 게다가 핵심 가정 둘, 즉 “LangGraph는 패턴 요구일 뿐”과 “service manifest SoT는 naia-adk”가 아직 검증되지 않았는데도 아키텍처의 축으로 사용한다. karpathy식 단순화보다 선행 추상화가 많다. 근거: [agent-service-builder-architecture.md:79-97](</var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:79>), [agent-service-builder-architecture.md:177-196](</var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:177>), [agent-service-builder-architecture.md:205-212](</var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:205>)

종합 1문단: 개발 착수 불가다. 핵심은 둘이다. 첫째, `service.manifest`의 소유권과 계약 지위가 Part A의 3계약 체계와 정합되지 않아 A.3/A.11 경계를 이미 흔든다. 둘째, R6 slice/MVP 순서가 F08·#31 gate를 “나중에 재확인”으로 밀어 baseline 절차를 어겼다. 최소한 `service.manifest`를 public contract가 아닌 내부 workspace format으로 둘지, 아니면 Part A 승격 없이는 금지할지 먼저 닫고, OPEN P0 및 `§D + sub-issue` 게이트를 선행 폐쇄하기 전에는 이 설계로 착수하면 안 된다.
