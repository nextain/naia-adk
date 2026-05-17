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
session id: 019e3126-f57d-7a93-8e15-daee12ba0d39
--------
user
# 재크로스리뷰 — Agent Service Builder 설계 v2 (1회전 ISSUES_FOUND 교정본)

당신은 nextain Naia 4-repo 아키텍처 리뷰어. v2 를 **판정**. 칭찬·요약 금지.
결함·모순·누락만. 한국어. v1 라운드에서 아래가 지적됨 — **각 해소 여부를
엄격 검증** + 신규 결함.

## v1 지적 (해소 검증 대상)
- **C1(CRITICAL)** service.manifest "제4 계약" — Part A 3-계약(types/protocol/skill-spec)+capability=agent-types 위배
- **C2(CRITICAL)** F08(OPEN P0 시 R1 plan 차단)/#31 §D·sub-issue gate 우회
- **M1** LangGraph 해소안이 "이름만 바꾼 graph" — B20(reducer) vs D1(stream-first) 미정의
- **M2** Observability(A.5 Event emit)/ErrorEvent(A.11) builder layer 누락
- **M3** canonical/License 소유권 모순 (A.11 공개4repo만 canonical / A.6 License 원문)
- **M4** business governance 위치 (manifest 안=스키마확장 / 밖=portable 깨짐)
- **m1** karpathy: 추상화 선행, 미검증 가정 축으로 사용

## 검토 대상
- 설계 v2: `/var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md` (§0 에 v1→v2 교정표)

## baseline (위배 시 critical, 수정 불가)
- 4-repo Part A: `/var/home/luke/alpha-adk/.agents/progress/naia-4repo-migration-plan.md` (A.1~A.13, F07)
- naia-agent 매트릭스: `/var/home/luke/alpha-adk/projects/naia-agent/.agents/progress/ref-adoption-matrix.md` (B19/B20/D44/§A capability 거버넌스 A.5)
- F-rules: `/var/home/luke/alpha-adk/projects/naia-agent/.agents/context/agents-rules.json` (F01/F06/F07/F08)
- agent-loop D1~D8: `/var/home/luke/alpha-adk/projects/naia-agent/docs/agent-loop-design.md`
- naia-business-adk README: `/var/home/luke/alpha-adk/projects/naia-business-adk/README.md`

## 판정 항목 (각 PASS/FAIL + 근거 file:line)
1. **C1 해소?** §2 "신규 최상위 계약 0개" + manifest=naia-adk workspace 파일포맷(A.6) + RAG=RetrievalCapable(agent-types additive, A.5 거버넌스) — 이게 정말 "제4 계약" 회피인가? agent-types additive PR 이 A.5 capability 거버넌스로 정당한가? loader=host-side 가 A.3 의존방향 안 깨나?
2. **C2 해소?** §6 Phase0 "G0-1 OPEN P0 실측·열려있으면 slice 차단(F08)" + "G0-4 §D PR+sub-issue" + "G0-1·4·5 미충족=Phase1 금지" — baseline gate 비우회 충분한가?
3. **M1 해소?** §4 1~6 (step=AsyncGenerator yield* 위임 / reducer 없음 / history append-only=D준수 / 1차 직렬만 / abort 재사용) — 이게 B20 reducer 부재 + D1 보존을 *구체 계약*으로 증명하나? 숨은 reducer/배치 위험 남았나?
4. **M2 해소?** §5 Event emit 지점·ErrorEvent shape·audit·regression — A.5/A.11 충분 적용인가?
5. **M3 해소?** §1.3 A.11 원문 준수("공개4repo 계약만 canonical, README=운영모델 아님 계약 canonical 아님") + A.6 License 원문 인용 + 개인 layer License 부재(bypass 아님) — 소유권 모순 해소됐나?
6. **M4 해소?** §3 governance=operate layer(naia-business-adk host 주입, manifest 미확장) — portable 보존 + A.11 계약미수정 둘 다 성립하나?
7. **m1 해소?** §6 MVP=SB-1~3 축소(orchestration SB-4 조건부) — karpathy Simplicity 충족하나? 남은 미검증 가정(§7)이 축으로 쓰이나?
8. **신규 결함** — v2 가 새로 만든 모순/누락 (특히 RAG=capability vs MemoryProvider 중복, manifest 비-계약인데 SB-1 에서 스키마 정의하는 위치 정합)

## 출력
```
VERDICT: CLEAN | ISSUES_FOUND
[C1~m1 해소]: PASS/FAIL 각 1줄 근거
[CRITICAL]/[MAJOR]/[MINOR]/[누락] (신규/미해소)
종합 1문단: 개발 착수 가능? (가능/조건부/불가 + 핵심)
```
critical=Part A/매트릭스/F-rule 정면위배만. Part B/C 보류를 미해결로 잡지 말 것.

[profile: ARCHITECT/MATRIX — Part A 불변식·B19/B20·F-rule·capability 거버넌스(A.5) 정합 엄격. 파일은 Read 도구로 직접 읽어라. 최종 출력만 간결히.]
codex
검토 범위는 v2 설계 문서와 지정된 baseline 간 정합성 판정입니다. 먼저 세션 필수 컨텍스트와 리뷰 스킬 지침을 읽고, 이어서 대상 문서와 baseline 원문을 대조하겠습니다.
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
이제 v2 본문과 baseline의 해당 조항만 라인 번호와 함께 대조합니다. 판정 항목별로 필요한 절만 좁혀 읽겠습니다.
exec
/bin/bash -lc "nl -ba projects/naia-adk/AGENTS.md | sed -n '1,220p'" in /var/home/luke/alpha-adk
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
    41	| `packages/` | T1 | Runtime packages (future) |
    42	| `scripts/` | T1 | Utility scripts, tools |
    43	| `templates/` | T1 | Document templates |
    44	| `docs/` | T1 | Architecture, specs |
    45	
    46	### Fork Customization
    47	
    48	After forking, create a `FORK.md` in the fork root with:
    49	
    50	- Organization/user info
    51	- Project list (submodules in `projects/`)
    52	- Data submodules (`data-company/`, `data-teams/`)
    53	- Default language for `.users/` mirror
    54	- Any fork-specific conventions
    55	
    56	## Development Process
    57	
    58	### Feature Development (default) — Issue-Driven Development
    59	
    60	For feature-level work (new features, broad bug fixes). **14 phases:**
    61	
    62	1. **Issue** — Create or receive GitHub Issue (English)
    63	2. **Understand** — Summarize understanding, get user confirmation (gate)
    64	3. **Scope** — Define investigation scope/depth, user approval (gate)
    65	4. **Investigate** — Code-centric investigation within confirmed scope
    66	5. **Plan** — Comprehensive plan based on ALL findings, user approval (gate)
    67	6. **Build** — Implement according to approved plan
    68	7. **Review** — Iterative review (repeat until TWO consecutive clean passes) → run `/verify-implementation`
    69	8. **E2E Test** — Run actual app/server, targeted tests first then full suite
    70	9. **Post-test Review** — Re-review after tests pass (repeat until TWO consecutive clean passes) → run `/verify-implementation`
    71	10. **Sync** — Update `.agents/` + `.users/` context → run `/manage-skills` → user confirmation (gate)
    72	11. **Sync Verify** — Verify context accuracy (repeat until TWO consecutive clean passes)
    73	12. **Report** — Summarize results to user
    74	13. **Commit** — If in worktree: use `/merge-worktree`. Otherwise: commit referencing Issue number, create PR
    75	14. **Close** — Phase-by-phase completion report to issue comments + user confirmation (gate)
    76	
    77	**Iterative review applies at 5 points:** After Plan, after each Build phase, after all Build phases, after E2E Test, after Sync.
    78	
    79	**Principles:** Read upstream code first. Minimal modification. Never break working code. Propose improvements, never decide autonomously.
    80	
    81	**Progress file (MANDATORY):** At every phase transition, write/update `.agents/progress/{issue-slug}.json`.
    82	
    83	### End of EVERY session (mandatory)
    84	
    85	Before ending any session, ALWAYS:
    86	1. Update context files with new knowledge (.agents/ ↔ .users/ ↔ entry point files)
    87	2. Record lessons-learned if corrections or mistakes occurred
    88	3. Commit and push all changes
    89	
    90	This transfers your learning to the next AI session.
    91	
    92	### Simple Changes (lightweight cycle)
    93	
    94	For non-feature changes: typos, config values, simple directives.
    95	
    96	## Skills
    97	
    98	AI assistant skills. **SoT: `.agents/skills/`** — `.claude/skills/` is symlinks.
    99	
   100	### Base Skills
   101	
   102	| Skill | Description | Management |
   103	|-------|-------------|------------|
   104	| `review-pass` | Multi-agent cross-validation review (4 stages) | Auto (phase 7, 9) |
   105	| `verify-implementation` | Run all `verify-*` skills, generate unified report | Auto (phase 7, 9) |
   106	| `manage-skills` | Analyze changes, create/update `verify-*` skills | Auto (phase 10) |
   107	| `merge-worktree` | Squash-merge worktree → main with semantic commits | Manual (phase 13) |
   108	| `read-doc` | Extract text from HWP/PDF/DOCX/XLSX/PPTX | Manual |
   109	| `webapp-testing` | Playwright E2E testing for local web apps | Manual |
   110	| `doc-coauthoring` | Structured document co-authoring (3-step) | Manual |
   111	
   112	### Business Extension Skills
   113	
   114	Available in `naia-business-adk`:
   115	
   116	| Skill | Description | Management |
   117	|-------|-------------|------------|
   118	| `payroll` | Payroll PDF generation + email dispatch | Manual |
   119	| `press-release` | Press release writing, outreach, distribution | Manual |
   120	| `patent-draft` | KIPO-format patent specification drafting | Manual |
   121	| `patent-pipeline` | AI patent discovery, evaluation, and filing | Manual |
   122	| `copyright-reg` | Copyright registration document generation | Manual |
   123	| `weekly-report` | Weekly work report from git commits | Manual |
   124	| `email` | Email composition and dispatch | Manual |
   125	| `sms` | SMS notification sending | Manual |
   126	| `channel-management` | Multi-channel communication management | Manual |
   127	| `service-management` | Service monitoring and management | Manual |
   128	| `web-monitoring` | Web content monitoring and alerting | Manual |
   129	| `document-generation` | Automated document generation | Manual |
   130	
   131	## Directory Structure (Dual-directory Architecture)
   132	
   133	```
   134	.agents/                    # AI-optimized (English, token-efficient)
   135	├── context/
   136	│   ├── agents-rules.json   # Main rules (SoT) ← mandatory read
   137	│   └── ai-work-index.yaml  # Work index ← mandatory read
   138	├── workflows/              # Development workflows
   139	├── skills/                 # Skill definitions (SoT)
   140	├── hooks/                  # AI session hooks
   141	└── requirements/           # Product requirements
   142	
   143	.users/                     # Human-readable mirror
   144	├── context/                # .agents/ mirror in Markdown
   145	├── workflows/
   146	└── skills/                 # .agents/skills/ mirror
   147	
   148	.claude/                    # Claude Code configuration
   149	├── settings.json           # Hooks registration
   150	├── hooks/                  # PostToolUse hooks
   151	└── skills/                 # Symlinks → .agents/skills/
   152	```
   153	
   154	## Core Principles
   155	
   156	1. **1:1 Mirroring**: `.users/` mirrors `.agents/` structure exactly
   157	2. **SoT**: `.agents/context/agents-rules.json` is the single source of truth
   158	3. **Response language**: Contributor's preferred language
   159	
   160	## Cascade Rules (Context Propagation)
   161	
   162	When context changes, propagate to related modules.
   163	
   164	| Trigger | Propagate To |
   165	|---------|-------------|
   166	| Rules file changed | `.users/` mirror |
   167	| Entry point files changed | `AGENTS.md` ↔ `CLAUDE.md` ↔ `GEMINI.md` (keep identical) |
   168	
   169	**Order**: self → parent → siblings → children → mirror
   170	
   171	## Conventions
   172	
   173	- **Development**: Issue-driven development (default). TDD where applicable.
   174	- **Language**: Git/shared (commits, issues, PR) → English. Personal notes → any language.
   175	- **License**: Apache 2.0
   176	
   177	## License
   178	
   179	```
   180	Copyright 2026 Nextain Inc.
   181	
   182	Licensed under the Apache License, Version 2.0 (the "License");
   183	you may not use this file except in compliance with the License.
   184	You may obtain a copy of the License at
   185	
   186	    http://www.apache.org/licenses/LICENSE-2.0
   187	
   188	Unless required by applicable law or agreed to in writing, software
   189	distributed under the License is distributed on an "AS IS" BASIS,
   190	WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   191	See the License for the specific language governing permissions and
   192	limitations under the License.
   193	```

exec
/bin/bash -lc "nl -ba projects/naia-adk/.agents/progress/agent-service-builder-architecture.md | sed -n '1,260p'" in /var/home/luke/alpha-adk
 succeeded in 0ms:
     1	<!-- 설계 문서 v2 — 크로스리뷰 1회전(codex+gemini ISSUES_FOUND) 반영 전면 재작성.
     2	     v1 의 CRITICAL 2 / MAJOR 4 / 누락 2 해소. 재크로스리뷰 대기.
     3	     사용자 합의 게이트 전 코드 착수 금지.
     4	     SoT 경계: 4-repo Part A(alpha-adk, F07 수정금지) 위에 얹는 확장.
     5	     리뷰 산출물: .agents/reviews/agent-service-builder-{codex,gemini}.md (v1 라운드) -->
     6	
     7	# Agent Service Builder — 아키텍처 설계 v2
     8	
     9	> **목적**: naia-agent 풀셋(LLM + persona/system-prompt + naia-memory + RAG +
    10	> orchestration)으로 **다양한 에이전트 서비스를 정의·운영·평가**하는 기반을
    11	> 개인(naia-os) / 비즈니스(naia-business-adk) 2-layer 로.
    12	> **계기**: 외부 에이전트 개발 의뢰 — 데모 제출 예정.
    13	> **워크플로**: 설계 → 크로스리뷰(2x clean) → 합의·보고 → 개발.
    14	
    15	---
    16	
    17	## 0. v1 → v2 교정 요약 (크로스리뷰 반영)
    18	
    19	| 결함(v1) | v2 교정 |
    20	|---|---|
    21	| C1 service.manifest "제4 계약" (Part A 3-계약 위배) | **신규 최상위 계약 0개 원칙** (§2). manifest = naia-adk *workspace 파일 포맷*(A.6), public contract 아님. loader = host-side 조립 코드 |
    22	| C2 F08/#31 gate 우회 | **Phase 0 = gate 폐쇄가 deliverable** (§6). 미폐쇄 시 slice 차단 (F08 준수 명문화) |
    23	| M1 B20/D1 stream-first 미정의 | **§4 orchestration 계약 구체화** — yield* 위임, reducer 없음, history append-only(D준수), interleave/cancel 규칙 |
    24	| M2 Observability/ErrorEvent 누락 | **§5 교차관심사** — Event emit 지점 + ErrorEvent shape + audit/regression 명문 |
    25	| M3 canonical/License 소유권 모순 | **§1.3** A.11 원문 준수 (공개4repo 계약만 canonical), A.6 License 원문 인용 정정 |
    26	| M4 business governance 위치 | **§3** governance = operate layer (naia-business-adk host 주입), manifest 미확장 |
    27	| m1 추상화 선행(karpathy) | **§6 MVP 축소** — "한 서비스가 실제 돈다" 최소증명 우선, orchestration/business 후속 |
    28	
    29	---
    30	
    31	## 1. 레포 관계 — 직교 2축
    32	
    33	### 축1 — 런타임 의존 (Part A.3, 불변·변경 불가)
    34	
    35	```
    36	naia-os (host)  ──embeds(interface)──▶  naia-agent (Runtime SoT)
    37	                                          │ 기존 계약(주입): LLMClient ·
    38	                                          │ MemoryProvider · ToolExecutor ·
    39	                                          │ SkillLoader · HostContext
    40	                                          ├─ alpha-memory : MemoryProvider 구현
    41	                                          └─ @naia-adk/skill-spec : 스킬 계약
    42	```
    43	- 계약 3개 = `@nextain/agent-types` · `@naia-agent/protocol` · `@naia-adk/skill-spec`
    44	  (zero-runtime-dep). **본 설계는 이 3개 외 신규 계약 패키지를 만들지 않는다**(§2).
    45	
    46	### 축2 — 워크스페이스 fork chain (거버넌스 상속, 문서 일관성 수준)
    47	
    48	```
    49	naia-adk (personal base, public Apache2.0) → naia-business-adk (business upstream)
    50	   → {company}-adk → {member}-adk
    51	```
    52	- 이 chain 은 **fork/submodule 운영 모델**이지 *공개 계약의 canonical 선언이 아니다*.
    53	
    54	### 1.3 canonical / License — Part A 원문 준수 (M3 교정)
    55	
    56	- **A.11 원문**: "공개 4 repo(naia-os/naia-agent/naia-adk/alpha-memory)의 계약만
    57	  canonical. private fork 의 계약 변종은 비공식." → 본 설계는 이 문구를 **수정·재해석하지
    58	  않는다**. naia-business-adk/README 의 fork chain 은 *운영 모델 설명*이지 계약 canonical 이 아님.
    59	- **Fork chain 문서 불일치**(naia-adk/AGENTS.md 3단계 vs README 4단계)는
    60	  **계약 문제가 아니라 문서 일관성 문제**. 해소 = AGENTS.md 의 chain 설명을
    61	  README 와 일치(문서 동기, Cascade rule). canonical 권위 부여 아님. (Sync phase)
    62	- **License 검증 소유 — A.6 원문 인용**: Part A.6 표의 행 "License 검증
    63	  (business-adk 유료 영역) = naia-business-adk (다운스트림)". → v1 이 "A.6"
    64	  로만 적어 모호했던 것을 **이 행 원문으로 고정**. 개인 layer(naia-os)는
    65	  License 검증 자체가 **부재**(Apache2.0 무과금) — bypass/mock 이 아니라
    66	  "비즈니스 layer 에서만 존재하는 관심사". 개인 데모는 License 코드 경로를
    67	  타지 않음(존재 안 함). gemini M-License 의 "충돌"은 *layer 분리로 비충돌*.
    68	
    69	---
    70	
    71	## 2. 핵심 원칙 — 신규 최상위 계약 0개 (C1 교정)
    72	
    73	v1 의 치명 결함 = service.manifest / RAGProvider / OrchestrationPolicy 를
    74	신규 계약처럼 다뤄 Part A 의 "계약 3개 고정 + capability=agent-types 소속"
    75	(A.4/A.5/A.6) 위배. **v2 는 신규 패키지·신규 최상위 계약을 만들지 않는다.**
    76	요소별 정착처:
    77	
    78	| 요소 | v2 정착처 (Part A 정합 근거) |
    79	|---|---|
    80	| **service manifest** | naia-adk **workspace 파일 포맷** (A.6 "Workspace 파일 구조 = naia-adk"). public 런타임 contract 아님. 스키마 = naia-adk docs, 버전은 naia-adk semver |
    81	| **manifest loader** | **host-side 코드** (naia-os / naia-business-adk host). manifest 를 읽어 *기존* HostContext(llm/memory/tools/persona-as-systemprompt) 를 조립. naia-agent 런타임 계약 무변경 |
    82	| **persona / system prompt** | manifest 필드 → host 가 Agent 의 기존 system message 로 주입. 신규 계약 0 |
    83	| **RAG** | **`RetrievalCapable` capability** — `@nextain/agent-types` 에 **additive PR**(A.5 capability 거버넌스: "새 Capability 는 agent-types PR 로 추가, 구현체가 implement, 소비자가 isCapable 확인"). 신규 패키지 아님. MemoryProvider 와 동급 capability |
    84	| **orchestration** | §4 — agent-loop D1~D8(F06 불변) 위 **host-side step 조합**. 신규 계약이 꼭 필요하면 capability additive(A.5), 아니면 manifest 선언 + host 해석 |
    85	| **LLM backend** | D44 Vercel AI SDK adapter (기존 §A 채택). qwen3.6-27b-dense = `@ai-sdk/openai-compatible`, minicpm = lab-proxy-live |
    86	
    87	→ **결과**: Part A 계약 3개 불변, 의존방향(A.3) 불변, capability 거버넌스(A.5)
    88	경유 = "제4 계약" 없음. RAG 만 agent-types additive PR(별 매트릭스 §D + sub-issue).
    89	
    90	---
    91	
    92	## 3. 개인 / 비즈니스 경계 (M4 교정 — governance = operate layer)
    93	
    94	**원칙**: manifest 는 *서비스 정의*만 담는다(portable/reproducible). 거버넌스는
    95	manifest 에 넣지 않는다(스키마 확장 불필요 → A.11 계약 미수정 보존). 거버넌스는
    96	**operate layer = host 가 manifest 실행 시 주입·강제**.
    97	
    98	| 관심사 | 위치 / enforce 주체 |
    99	|---|---|
   100	| service 정의(persona/skill/rag/memory/llm) | manifest (naia-adk workspace 포맷) |
   101	| 개인 실행 | naia-os host. 단일 사용자 T0~T3 self. 승인=ApprovalBroker(기존) |
   102	| RBAC(author/reviewer/approver/releaser/auditor) | **naia-business-adk host** 가 manifest 실행 래핑 시 강제. manifest 미확장 |
   103	| tenant boundary / approval chain / retention | naia-business-adk **operate layer 정책 파일**(manifest 와 별도, naia-business-adk 소유) |
   104	| License 검증 | naia-business-adk (A.6 원문). 개인 layer 부재 |
   105	| audit / SDLC artifact | shell audit(A.6, 기존) + naia-business-adk SDLC 정책 |
   106	
   107	**개인 자족성**: 외부 데모 = 개인 layer(naia-os host + manifest + 기존 계약)만으로
   108	end-to-end 동작. 비즈니스 거버넌스 코드 경로 부재(존재 안 함, bypass 아님).
   109	
   110	---
   111	
   112	## 4. Orchestration — D1 stream-first 보존 계약 (M1/C-B20 교정)
   113	
   114	B20 거부의 본질 = **reducer 중심 상태모델** (LangGraph StateGraph). D1/D8 =
   115	`AsyncGenerator<AgentStreamEvent>` stream-first + history append-only.
   116	v2 orchestration 은 다음을 **계약으로 명시**(이름만 X):
   117	
   118	1. **step = `AsyncGenerator<AgentStreamEvent>`** — graph 노드는 자체 reducer
   119	   상태를 갖지 않는다. 각 step 은 Agent.sendStream 과 동일 이벤트 타입을 yield.
   120	2. **합성 = `yield*` 위임** — 상위 orchestrator 가 step 의 stream 을 `yield*`
   121	   로 그대로 위임 전달. 별도 상태 채널/reducer 없음. chunk 실시간 보존.
   122	3. **상태 = message history append-only** (D 결정 준수) — step 간 전달은
   123	   reducer 가 아니라 history 에 append. tool_result 도 history append.
   124	4. **concurrent branch** — 1차 범위에서 **직렬 step 만**(병렬 분기 제외, karpathy
   125	   Simplicity). 병렬 interleave 는 후속 capability(별 §D). 1차에 reducer 도입 안 함.
   126	5. **cancellation/backpressure** — 기존 Agent abort signal(D 결정) 재사용.
   127	   step executor 는 signal 전파만, 자체 취소 모델 신설 X.
   128	6. **위치** — host-side(manifest 의 orchestration 선언을 host 가 해석해 step
   129	   순서로 Agent 호출). 런타임 신규 계약 0. 병렬·조건분기가 실측 필요해지면
   130	   그때 agent-types capability additive(§D + sub-issue).
   131	
   132	→ B20 회피를 *구체 계약(1~6)*으로 고정. "직렬 step + yield* 위임 + append-only"
   133	= reducer 부재 증명. 크로스리뷰가 1~6 의 D1 보존을 재검증.
   134	
   135	---
   136	
   137	## 5. 교차 관심사 — builder layer 적용 (M2/누락 교정)
   138	
   139	Part A.5/A.11 의무를 builder 요소에 명시:
   140	
   141	- **Event emit 지점**(A.5 "주요 상태 전이"): `manifest.load.started/ended`,
   142	  `manifest.validate.failed`, `retrieval.started/hit/empty`,
   143	  `orchestration.step.started/ended`, `service.build.ended`. 전부 기존
   144	  `Logger`/`Event` 계약으로 emit(신규 observability 계약 X).
   145	- **ErrorEvent shape**(A.11): manifest parse 실패 = `error_code:
   146	  MANIFEST_INVALID`, `severity: error`, `retryable: false`. retrieval 실패 =
   147	  `RETRIEVAL_FAILED`, `severity: warn`, `retryable: true`. orchestration step
   148	  실패 = step 의 ErrorEvent 를 `yield*` 그대로 경계 밖 전파(기존 계약).
   149	- **audit / tier**(A.6): T2+ 행위(외부 RAG fetch, tool exec)는 shell audit
   150	  필수 기록 — 기존 shell audit 소유 그대로, builder 가 우회 안 함.
   151	- **regression gate**(A.11): baseline = #31 평가 하니스 수치(컨텍스트 적중·
   152	  한국어·실시간·안정). 공개 전 유의미 regression = release block(기존 원칙).
   153	
   154	---
   155	
   156	## 6. 구현 계획 — gate-닫힘 조건부 (C2 교정)
   157	
   158	### Phase 0 — Gate 폐쇄 (이것이 deliverable. 코드 0줄. 미완 시 이후 전부 차단)
   159	
   160	F08 = "OPEN P0 sub-issue 1건이라도 있으면 R1 plan 차단". 따라서:
   161	
   162	- [ ] **G0-1** naia-agent OPEN P0(#3 G01 / #4 G02 / #5 G03+G04 / #6 F01) 상태
   163	      실측 확인. **열려 있으면 본 계획 slice 작성 자체 차단**(F08). 닫혀 있어야
   164	      진행. (v1 은 이를 "착수 전 재확인"으로 미뤄 CRITICAL)
   165	- [ ] **G0-2** 본 설계 크로스리뷰 2x clean (different-profile)
   166	- [ ] **G0-3** 사용자 합의·보고 (사용자 명시 게이트)
   167	- [ ] **G0-4** naia-agent ref-adoption-matrix **§D 신규 항목 PR** +
   168	      sub-issue(#2 하위): `D-SB1 RetrievalCapable(agent-types additive)` /
   169	      `D-SB2 manifest workspace 포맷(naia-adk, 비-계약)` /
   170	      `D-SB3 orchestration §4 계약(B20 회피 1~6)`. #31 = 본 우산 sub-issue 로 재프레이밍.
   171	- [ ] **G0-5** F01(스켈레톤) 상태 확인 — bin/naia-agent 존재 확인(매트릭스
   172	      A19/A20 으로 해소 추정, 실측 필요). 미해소면 그 해소가 선행.
   173	
   174	**G0-1·G0-4·G0-5 미충족 = Phase 1 진입 금지.** (baseline gate 비우회 명문화)
   175	
   176	### Phase 1 — qwen3.6-27b-dense, "한 서비스가 실제 돈다" 최소증명 (karpathy)
   177	
   178	> v1 의 "추상화 선행" 교정: 6개를 한 번에 세우지 않는다. 최소 동작 먼저.
   179	
   180	- **SB-1 manifest loader 최소** — naia-adk workspace manifest 스키마(docs) +
   181	  host-side loader 가 manifest → 기존 HostContext(llm=qwen via D44 / memory=
   182	  alpha-memory / persona=system msg) 조립. RAG·orchestration 없음.
   183	  S01 `pnpm exec naia-agent --service <manifest>` · S02 unit(스키마 검증) ·
   184	  S03 fixture-replay(qwen) · S04 CHANGELOG · §D-SB2 인용
   185	- **SB-2 RetrievalCapable** — agent-types additive PR(A.5 거버넌스) + alpha-memory
   186	  결합 어댑터(host 주입) + turn-전 context 조립.
   187	  S01 `--rag <source>` · S02 unit · S03 실 alpha-memory · S04 · §D-SB1
   188	- **SB-3 #31 평가 결합** — manifest `eval.fixtures` → #31 하니스로 e2e 품질
   189	  측정(fixture-replay 우선, G15). qwen backend e2e.
   190	  S01 `--eval` · S02 unit · S03 fixture e2e(persona+RAG+memory+qwen) · S04 · #31
   191	- **SB-4 orchestration §4(직렬 step only)** — 필요성이 SB-1~3 에서 실증된 경우만.
   192	  아니면 백로그. (karpathy: 불필요 추상화 회피)
   193	
   194	**외부 데모 MVP = SB-1~SB-3** (manifest→persona+RAG+memory+qwen3.6-27b e2e+평가수치).
   195	
   196	### Phase 2 — minicpm backend
   197	- SB-5 minicpm /v1/realtime connector (v2 계약 rev2.1, lab-proxy-live).
   198	  ko-serve 트랙 PAUSED 해제 의존(gemini 누락 지적 반영 — Phase2 진입 = #31/ko-serve gate).
   199	
   200	### Phase 3 — 비즈니스 layer (operate)
   201	- SB-6 naia-business-adk operate layer 스캐폴드 — RBAC/SDLC/retention **정책
   202	  파일**(manifest 미확장, host 주입). License 검증(A.6 원문).
   203	
   204	---
   205	
   206	## 7. 가정 / 미해결 (재크로스리뷰 공격 유도)
   207	
   208	1. **(검증대상)** §4 직렬-step + yield* 가 D1 reducer-부재를 정말 보존하는가 (M1 핵심).
   209	2. **(검증대상)** RAG=RetrievalCapable additive 가 A.5 거버넌스로 충분한가, MemoryProvider 와 중복 아닌가.
   210	3. **(가정)** manifest=workspace 파일(A.6) ≠ public contract → "제4 계약" 회피 성립.
   211	4. **(미해결, 사용자)** 외부 데모 시한·"성공" 정의(무엇을 보여드릴지).
   212	5. **(gate)** Phase0 G0-1(OPEN P0)·G0-5(F01) 실측 미완 — 본 문서는 *계획*, 실측은 Phase0.
   213	
   214	---
   215	
   216	## 8. 합의 게이트
   217	크로스리뷰 2x clean → 사용자 보고 → **합의 후에만** Phase0 G0 착수. 합의 전 코드 0줄.
   218	
   219	## 변경 이력
   220	- v1 (2026-05-16): 초안. codex+gemini ISSUES_FOUND (CRITICAL 2 / MAJOR 4 / 누락 2).
   221	- **v2 (2026-05-16)**: 전면 재작성. 신규계약0 원칙 / gate-닫힘 / orchestration §4 계약화 / 교차관심사 / 소유권 A.11·A.6 원문정합 / governance=operate / MVP 축소. 재크로스리뷰 대기.

exec
/bin/bash -lc "nl -ba .agents/progress/naia-4repo-migration-plan.md | sed -n '1,320p'" in /var/home/luke/alpha-adk
 succeeded in 0ms:
     1	# Naia 4-Repo Migration Plan — v7
     2	
     3	**Status**: v7.2 — **audit mode**. Phase 1 + X1 의 "완료 ✅" 판정은 self-review + smoke-only 근거였음이 드러남 (2026-04-22 audit). 이 버전은 해당 실태를 정직히 demote하고 TDD rewind 계획을 반영한 것.
     4	**Previous**: v6 passed 8 adversarial review rounds (2 consecutive clean) — **self-review only**, cross-review 근거 없음.
     5	**Changes from v6**: Execution log 추가 (§Z). Phase 0/MVM/Phase 1 완료 상태 반영. Scope rename `@naia-agent/* → @nextain/agent-*` 반영. S6 Option C 확정. 알려진 debt (gateway circular) 기록.
     6	**Changes from v7.0**: Phase 2 X1 착수 → 통합 완료 (2026-04-22, opt-in flag). Adapter unit test 추가. npm publish blocker는 vendored tgz + pnpm.overrides로 우회.
     7	**Changes from v7.1 (this version)**: 테스트 커버리지 감사 반영. Phase 1 ✅ 전체를 🟡로 demote. X1 ✅ → 🟡. Audit doc `.agents/progress/naia-test-coverage-audit-2026-04-22.md` 링크. Meta issue `nextain/naia-agent#1` 등록. "PASS" 정의를 "unit test green + cross-review 2 consecutive clean"으로 상향.
     8	
     9	---
    10	
    11	## §Z Execution Log (v7 신규)
    12	
    13	### Phase 0 (재분류 후) — 완료 또는 해결
    14	
    15	| Spike | 결과 | 비고 |
    16	|---|:---:|---|
    17	| S1 alpha-memory audit | ✅ | `naia-agent/docs/memory-provider-audit.md` |
    18	| S1b mem0 dual audit | ✅ | 같은 문서 §6 — façade 변경 불필요 확인 |
    19	| S2 pnpm workspace link | ✅ | MVM #2-#3 중 de-facto 증명 |
    20	| S3 Flatpak dual-path | 재분류 → Phase 2 CI | naia-os CI build.yml 최근 5회 모두 green (baseline 확보) |
    21	| S4 #227 enforce | ✅ 부분 (soft) | naia-os CODEOWNERS + migration/* 규약 + PR 템플릿 |
    22	| S5 npm publish dry-run + project-any-llm | ✅ | dry-run 6 packages green. project-any-llm accessible |
    23	| S6 Voice pipeline 결정 | ✅ **Option C** | 3-layer hybrid (agent TTS + shell STT + `VoiceEvent` 계약) |
    24	| S7 CI 템플릿 | ✅ | 4 repo 모두 CI + PR template |
    25	| S9 madge import-graph | ✅ 조건부 | circular 2개 gateway 내부 (X8에서 해결할 known debt) |
    26	| S10 Tauri bundling matrix | 재분류 → Phase 2 X1 진입 시 | 3-6주 작업, Phase 0에 두면 Phase 1 지연 |
    27	
    28	**Phase 0 exit 판정**: **PASS** (S3·S10 재분류는 합의된 이관)
    29	
    30	### MVM #1-#5 — 완료
    31	
    32	| # | 결과 | Commit / 증거 |
    33	|---|:---:|---|
    34	| #1 알파메모리 + MemoryProvider 매핑 | ✅ | `naia-agent/a4055f2` |
    35	| #2 types v0.0.1 + LLMClient | ✅ | `naia-agent/ef55d21` → `ad2ae0a` (2차 리뷰 PASS) |
    36	| #3a Anthropic 구현 | ✅ | `naia-agent/2559db5` (2차 리뷰 PASS) |
    37	| #3b smoke test | ✅ | `naia-agent/f627373` (2차 리뷰 PASS). live 경로는 `ANTHROPIC_API_KEY` 있을 때만 |
    38	| #4 Flatpak 빌드 green | ✅ | naia-os `Build Naia` workflow 최근 5회 success |
    39	| #5 `migration/*` + PR 템플릿 | ✅ | 4 repo PR templates + CODEOWNERS |
    40	
    41	### Phase 1 — 구현만 완료, **테스트·리뷰 미달** (v0.1.0 freeze 2026-04-21, audit 2026-04-22)
    42	
    43	| T | 구현 | 테스트 | Cross-review | 실제 상태 |
    44	|---|:---:|:---:|:---:|:---|
    45	| T1 `@nextain/agent-types` 0.1.0 | ✅ | ⚫ 불필요 | 🔴 | 🟡 shape OK, 사용처 테스트 없음 |
    46	| T2 `@nextain/agent-protocol` 0.1.0 | ✅ | 🔴 0개 | 🔴 | 🟡 `parseFrame/encodeFrame` untested |
    47	| T3 `@naia-adk/skill-spec` 0.1.0 | ✅ | 🔴 | 🔴 | 🟡 |
    48	| T4 `@nextain/agent-observability` 0.1.0 | ✅ | 🔴 | 🔴 | 🟡 3 class untested |
    49	| T5 HostContext + VoiceEvent 등 | ✅ | 🔴 | 🔴 | 🟡 |
    50	| T6 MemoryProvider façade | ✅ | 🔴 | 🔴 | 🟡 compact + rolling 전부 untested |
    51	| T7 ARCHITECTURE.md | ✅ | n/a | 🔴 | 🟡 |
    52	| T8 v0.1.0 freeze + CHANGELOG | ✅ | n/a | 🔴 | 🟡 |
    53	
    54	**이전 주장 (v7.0)**: "5 rounds (1 FAIL → 2 FAIL → 3 PASS → 4 Release FAIL → 5 PASS). Code/Contract 2 consecutive clean 달성."
    55	**실태 (audit 2026-04-22)**: 라운드 모두 self-review. cross-review 0회. 단위 테스트 0개. 7 smoke는 `throw new Error()` 기반 happy-path only.
    56	**결론**: Phase 1은 **구현은 shape-ready**이지만 **Phase 1 exit 요건 미달**. Plan §Z의 모든 ✅ 항목이 🟡로 전환.
    57	
    58	### Phase 2 X1 — 구현 완료, 테스트·리뷰 일부만 (audit demote 2026-04-22)
    59	
    60	- Branch: `naia-os/migration/x1-anthropic-providers` (미머지, 관찰 기간)
    61	- Commit: `naia-os/0b25697f` (integration) + `830acf44` (unit tests) + alpha-adk `45ae679`, `8bdf366` (submodule bumps)
    62	- Adapter: `agent/src/providers/adapters/nextain-provider-adapter.ts`
    63	  - `@nextain/agent-providers`의 `AnthropicClient`를 naia-os `LLMProvider`로 래핑
    64	  - 스트림 재조립: `content_block_start/delta/stop` → flat `text/thinking/tool_use/usage/finish`
    65	- Factory gate: `NEXTAIN_AGENT_PROVIDERS=1` 환경 변수 opt-in. 기본은 native `anthropic.ts`.
    66	- 의존성: `@nextain/agent-providers` + `@nextain/agent-types`를 `agent/vendor/*.tgz`로 vendoring. `pnpm.overrides`로 내부 `workspace:*` 참조 해소 (A.3 불변식 유지, registry publish 독립).
    67	
    68	| 요소 | 상태 | 근거 |
    69	|---|:---:|---|
    70	| tsc build | ✅ | 0 error |
    71	| `toNextainMessage` unit | 🟢 | 5 tests |
    72	| `convertStreamChunk` unit | 🟢 | 10 tests |
    73	| `createNextainAnthropicProvider().stream()` wiring | 🔴 | `yield { finish }` closure 미검증 |
    74	| Factory env-gate `NEXTAIN_AGENT_PROVIDERS=1` | 🟡 | 수동 1회 확인, pinned test 없음 |
    75	| `toNextainTool` | 🔴 | untested |
    76	| Cross-review | 🔴 | self-review only |
    77	| Flatpak E2E | 🔴 | 미실행 |
    78	
    79	- 결론: X1 integration 자체는 🟡 — 순수 함수는 녹색이나 wiring/E2E/cross-review 미완.
    80	- 남은 순서: wiring 테스트 → Flatpak E2E → cross-review 2 consecutive → 관찰 → flip default → native 제거
    81	- npm publish blocker **해소**: vendored tgz 전략으로 우회. 실제 publish는 X2/X3 병행 시점으로 이연.
    82	
    83	### Scope rename 기록
    84	
    85	- `@naia-agent/*` → `@nextain/agent-*` (commit `b4e34c2`)
    86	- `@naia-adk/skill-spec`은 `@naia-adk` scope 유지 (naia-adk 레포 소속, tool-agnostic 원칙)
    87	
    88	### E 결정 재정리
    89	
    90	| # | v6 상태 | v7 상태 |
    91	|---|---|---|
    92	| E1 dashboard | Part B (K3) | 미결정, K3 실행 시점 |
    93	| E2 cli 패키지 | Part B | 미결정 |
    94	| E3 TTS layer | Part B (S6 완료) | S6 = Option C로 해결 |
    95	| E4 macOS | defer | defer 유지 |
    96	
    97	### Open blockers (Phase 2 진입 전)
    98	
    99	1. ~~**npm publish**~~ — vendored tgz + `pnpm.overrides`로 우회. X1 통합 실현됨 (2026-04-22).
   100	2. **#227 naia-adk integration** — OPEN 상태. agent/ 관련 작업 시 migration/* branch 준수.
   101	
   102	### 알려진 debt
   103	
   104	- **gateway/ 내부 circular 2건** (`client.ts ↔ tool-bridge.ts`, `tool-bridge.ts ↔ sessions-spawn.ts`) — Phase 2 X8 (messengers 추출) 시 해결.
   105	- **VRM lip-sync viseme vocabulary** — `VoiceEvent.visemeId` 의미론 미정 (ARKit vs Oculus vs custom). 첫 avatar 통합 시 결정.
   106	- **테스트 커버리지 전면 부족** — Phase 1 + X1 전체가 smoke/self-review 근거. `nextain/naia-agent#1` + audit doc `.agents/progress/naia-test-coverage-audit-2026-04-22.md` 참조.
   107	
   108	### §Y TDD Rewind — 우선순위 (audit v2, 2026-04-22 cross-review 반영)
   109	
   110	| Phase | 대상 | 사유 |
   111	|---|---|---|
   112	| A | pure functions (protocol parseFrame/encodeFrame, importance/decay/reconsolidation, parseSkillManifest) | mock 불필요. 0~1 bug만 드러낼 가능성. baseline 가장 싼 값에 pin |
   113	| **D** (up) | **메모리 — stubs 구현 + 테스트** (`contentTokens`/`jaccardSimilarity`/`mergeRelatedFacts` 실제 구현 후 consolidate/compact/rolling summary 테스트) | silent data-loss > loud trust-fail. cross-reviewer 발견: 현재 stub 상태로 dedup branch dead code |
   114	| B | trust boundaries (`SkillToolExecutor.filter`, `CompositeToolExecutor` shadow/order, `GatedToolExecutor` tier, Agent halt + skip-encode) | security/permission 경계 |
   115	| C | 스트림 + **X1 retro-cover** (Agent.sendStream/#streamLLM/#maybeCompact splice, AnthropicClient.stream, X1 full wiring, factory env-gate, **fixture-replay** against recorded Anthropic SDK) | 루프 회귀 silent 통과 위험 + X1 외부 계약 검증 |
   116	| E | MCP 라이프사이클, observability (InMemoryMeter 카운터 등) | 범위 좁은 보강 |
   117	
   118	**PASS 정의 (v2)**: unit 테스트 green + **coverage floor 통과** (pure 85% / runtime 70% / adapter 75%) + **매 phase 종료 시 cross-review 2 consecutive, different profile 또는 diff 후 re-review**. 같은 profile·무변경 2회 = self-review reroll이므로 무효.
   119	
   120	**매 phase 종료 규약** (operator directive 2026-04-22): 이 cross-review gate는 phase 넘어가기 전에 **강제 정착**. 생략 불가.
   121	
   122	---
   123	
   124	## Part A — 확정 사항 (리뷰 대상)
   125	
   126	---
   127	
   128	## Part A — 확정 사항 (리뷰 대상)
   129	
   130	원칙·계약·경계·소유권. 지금 결정해야 하며 실행 중 쉽게 바꿀 수 없는 것들.
   131	
   132	### A.1 철학
   133	
   134	- Naia 4 repo(`naia-os` · `naia-agent` · `naia-adk` · `alpha-memory`)는 **공개 인터페이스로만** 연결.
   135	- 런타임 결합 금지. 계약(Contract)을 구현하고 주입(Inject).
   136	- 포트 앤 어댑터를 생태계 단위로 확장.
   137	
   138	### A.2 레포 역할
   139	
   140	| 레포 | 역할 | 공개 |
   141	|---|---|:---:|
   142	| `naia-os` | Host (Tauri shell + OS image) | ✓ |
   143	| `naia-agent` | Runtime 엔진 + 공개 인터페이스 SoT | ✓ |
   144	| `naia-adk` | 워크스페이스 포맷 + 스킬 표준 | ✓ |
   145	| `alpha-memory` | MemoryProvider 레퍼런스 구현 | ✓ |
   146	
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
   311	
   312	## Part B — 구현 중 결정 (리뷰 대상 제외)
   313	
   314	spike·실측·POC 전엔 확정 불가. 시작 전 확정 요구하지 말 것.
   315	
   316	- Tauri bundling 방식 (externalBin vs resources vs Rollup vs esbuild)
   317	- Flatpak dual-path 실제 사이즈 증분 (실측)
   318	- alpha-memory 7+ 내부 인터페이스와 MemoryProvider façade 정확 매핑
   319	- `naia-os/agent/**` madge baseline 수치와 S9 임계값
   320	- 각 X-item 정밀 timebox (첫 1-2개 실측 후 재산정)

exec
/bin/bash -lc "nl -ba projects/naia-agent/.agents/progress/ref-adoption-matrix.md | sed -n '1,320p'" in /var/home/luke/alpha-adk
 succeeded in 0ms:
     1	# Ref Adoption Matrix — naia-agent R0
     2	
     3	**작성일**: 2026-04-25 (Phase R0)
     4	**입력**: 8개 ref review (`refs/{cline,jikime-adk,jikime-mem,moltbot,openclaw,opencode,project-airi,cc}-review.md`) + Phase 1 explore + 4-repo plan v7.2 + agent-loop-design.md
     5	
     6	목적: 모든 ref reference에서 도출된 채택·거부·이연 결정을 단일 표로 통합. **drift 위험 항목과 결정 누락 항목**도 포함하여 어디에 무엇이 살아있는지 가시화.
     7	
     8	---
     9	
    10	## A. 이미 채택된 결정 (코드/문서로 pin됨)
    11	
    12	| # | 패턴 | 출처 ref | 우리 위치 (코드/문서) | 검증 테스트 |
    13	|---|---|---|---|---|
    14	| A01 | Stream-first API (`sendStream`/`send`) | opencode (D1) | `packages/core/src/agent.ts` | 23 unit (mock) |
    15	| A02 | CompactableCapable 위임 | opencode (D2) | `packages/types/src/memory.ts` | shape only |
    16	| A03 | Compaction policy constants (contextBudget=80K, keepTail=6) | opencode (D3) | `agent.ts` | mock |
    17	| A04 | Tool-hop bounded (max 10) | careti via naia-os/agent (D4) | `agent.ts` `maxToolHops` | mock |
    18	| A05 | Tier T0~T3 + GatedToolExecutor | careti (D5) | `packages/runtime/src/tool-executor.ts` | 13 unit |
    19	| A06 | Bidirectional encode/recall | careti+opencode (D6) | `agent.ts` turn lifecycle | mock |
    20	| A07 | Session 생명주기 (created/active/.../closed) | A.5 | `packages/types/src/session.ts` | mock |
    21	| A08 | AgentStreamEvent union | opencode bus 단순화 (D8) | `agent.ts` types | mock |
    22	| A09 | MemoryProvider 4 + N capability | mem0 audit + alpha-memory | `packages/types/src/memory.ts` | shape only |
    23	| A10 | Anthropic LLMClient 구현 | MVM #3 | `packages/providers/src/anthropic.ts` | smoke + 15 unit (X1 adapter) |
    24	| A11 | Voice 3-layer hybrid (Option C) | S6 결정 + project-airi 일치 | `packages/types/src/voice.ts` (`VoiceEvent`) | shape only |
    25	| A12 | OpenClaw → MCP 4단계 | openclaw analysis | naia-os agent/ Phase 1~4 머지 (commit 1e04928) | 84 unit (naia-os) |
    26	| A13 | Skill 표준 1등 시민 (`@naia-adk/skill-spec`) | claude-code skill, openclaw 4단계 | `packages/runtime/src/skill-loader.ts` | 16 unit |
    27	| A14 | ToolExecutor 추상화 + Composite | claude-code(분석), opencode | `packages/runtime/src/composite-tool-executor.ts` | 14 unit |
    28	| A15 | Agent halt-after-N consecutive errors | 자체 + opencode 영향 | `agent.ts` halt | 12 unit |
    29	| **A16** | Tool 메타 (`isConcurrencySafe?`/`isDestructive?`/`searchHint?`/`contextSchema?`) | cc 분석 + Vercel + Mastra (D10 §D → §A 승격, Slice 1b 머지) | `packages/types/src/tool.ts` ToolDefinitionWithTier | additive shape, 사용처 Slice 2+ |
    30	| **A17** | Tool context schema (sessionId/workingDir/signal/ask) | opencode + Vercel `ToolExecutionOptions` (D11/D05 §D → §A 승격, Slice 1b) | `packages/types/src/tool.ts` ToolExecutionContext | shape, orphan 상태 — Slice 2 ToolExecutor.execute() 시그니처 확장 시 사용 |
    31	| **A18** | Workspace sentinel (`startsWith(root + sep)`) | cleanroom-cc deep-audit F3 fix + OWASP A01 (D09 §D → §A 승격, Slice 1b) | `packages/runtime/src/utils/path-normalize.ts` | 10 unit (path-normalize.test.ts) |
    32	| **A19** | Fixture-replay minimal (StreamPlayer + 정규형 fixture) | opencode 갭 + 자체 (C21 부분 §C → §A 승격, Slice 1b) | `packages/runtime/src/testing/stream-player.ts` + `__fixtures__/anthropic-1turn.json` | 4 unit (fixture-replay.test.ts). 정식 framework는 Slice 5 |
    33	| **A20** | env + JSON config auto-loader (camelCase → SCREAMING_SNAKE_CASE) | 자체 (Slice 1c) | `packages/runtime/src/utils/env-loader.ts` | 18 unit (env-loader.test.ts) |
    34	| **A21** | OpenAI-compat client (zai GLM / vLLM / OpenRouter / Together / Groq / Ollama) | 자체 + zai 검증 (Slice 1c+) | `packages/providers/src/openai-compat.ts` (fetch wrapper, no SDK 의존) | 실 호출 검증 (GLM-4.5-Flash 한국어 응답 확인) |
    35	| **A22** | Anthropic on Vertex AI provider | `@anthropic-ai/vertex-sdk` (Slice 1c) | `packages/providers/src/anthropic-vertex.ts` | shape only — gcloud ADC 환경 필요, 사용자 환경에서 검증 |
    36	| **A23** | LLM Config Standard docs + multi-tool harness 표준화 | 자체 (Slice 1c+) | `docs/llm-config-standard.md` + `naia-agent.env.example` + `.naia-agent.example.json` | docs only |
    37	| **A24** | DANGEROUS_COMMANDS regex catalog (12+ 패턴) | OWASP A03 + CWE-78 (D01 §D → §A, Slice 2). F09 cleanroom 라인 인용 0 | `packages/runtime/src/utils/dangerous-commands.ts` | 38 unit (dangerous-commands.test.ts — block 17 + allow 16 + assertSafe 2 + 메타 2) |
    38	| **A25** | Bash skill (T1, execFile + DANGEROUS pre-filter + timeout) | 자체 (Slice 2) | `packages/runtime/src/skills/bash.ts` | 12 unit (bash-skill.test.ts) — 실 shell 실행 + BLOCKED + 타임아웃 |
    39	| **A26** | Logger.tag()/time() (D06 §D → §A, Slice 2) | opencode pattern, additive (optional methods) | `packages/types/src/observability.ts` + `packages/observability/src/logger.ts` | 4 unit (console-logger.test.ts D06 sub-tests) |
    40	| **A27** | Observability 단위 테스트 (G05 해소) | 자체 (Slice 2) | `packages/observability/src/__tests__/{console-logger,meter,tracer}.test.ts` | 17 unit (G05 0개 → 17개) |
    41	| **A28** | host factory enableBash + extraTools 옵션 | 자체 (Slice 2) | `packages/runtime/src/host/create-host.ts` | bash-skill-host.ts smoke + bin --enable-bash 검증 |
    42	| **A29** | OpenAI-compat tool calling translation (양방향) | 자체 (Slice 2.5). LLMRequest.tools ↔ OpenAI tools[] + tool_use ↔ tool_calls + tool_result ↔ role:"tool" | `packages/providers/src/openai-compat.ts` | 실 호출 검증 (GLM-4.5-Flash가 bash 도구 자율 호출 → 결과 자연어 정리) |
    43	| **A30** | File ops skills (read_file/write_file/edit_file/list_files) — D09 sentinel 재사용 | 자체 + claude-code/aider 영감 (Slice 2.6). T0 read/list, T1 write/edit | `packages/runtime/src/skills/file-ops.ts` + `createFileOpsSkills()` bundle | 23 unit (file-ops.test.ts) + GLM 실 호출 검증 (list_files로 ref review 11개 정확히 출력) |
    44	| **A31** | Log Policy + `Logger.fn()` helper (enter/branch/exit + caller file:line + elapsedMs + args/result) + Dev mode 자동 감지 + 파일 자동 저장 + 5-pattern secret redact | 자체 + opencode tag/time 영감 (Slice 2.7) | `docs/log-policy.md` + `packages/observability/src/{logger.ts, dev-logger.ts, redact.ts}` + 핵심 8 영역 적용 (bin/host/bash/file-ops/openai-compat/anthropic/env-loader/agent) | 250 PASS 회귀 + 실 호출 trace 검증 (`~/.naia-agent/logs/naia-agent-YYYYMMDD.jsonl` append) |
    45	
    46	---
    47	
    48	## B. 명시적으로 거부된 결정
    49	
    50	| # | 거부한 것 | 출처 ref | 이유 |
    51	|---|---|---|---|
    52	| B01 | OpenClaw 스킬 완전 호환 래퍼 | openclaw analysis q1 | 옵션 B(핵심만 MCP 재구현) 선택 — 유지보수 부담 대비 ROI 낮음 |
    53	| B02 | macOS 우선 지원 | E4 | defer 유지 — Linux/Windows 안정화 후 재평가 |
    54	| B03 | Voice full-runtime 소유 (Option A) | voice-pipeline-audit §4 | STT Rust→Node 재작성 비용 과다 |
    55	| B04 | Voice full-shell 소유 (Option B) | voice-pipeline-audit §4 | Agent 직접 음성 방출 기능 포기 불수용 |
    56	| B05 | SQL/Drizzle ORM 영속화 | opencode | NotEffect + zero-runtime-dep 원칙 위배 |
    57	| B06 | Effect Layer 직접 의존 | opencode | 1000+ LoC 번들. zero-runtime-dep 정의 위반 |
    58	| B07 | Go+TUI 첫 commit 패턴 | opencode | 우리는 TS 단일 스택 (Tauri shell 별도 host) |
    59	| B08 | IDE plugin 결합 (webview, comment review) | cline | embeddable runtime은 host 추상화만 |
    60	| B09 | OpenTelemetry/PostHog 패키지 dep | cline | zero-runtime-dep 원칙 위배 |
    61	| B10 | TUI 직접 (terminal layer) | cleanroom-cc | host 책임 분리 (Tauri shell, CLI host) |
    62	| B11 | `/bug`, `/feedback`, `/install-github-app` 등 SaaS 특화 명령 | cleanroom-cc | self-hosted Naia OS — 적합 안 함 |
    63	| B12 | Sentry-style telemetry | cleanroom-cc | 우리 Logger/Tracer/Meter가 더 진전 |
    64	| B13 | Monorepo 구조 (project-airi 자유 결합) | project-airi | 4-repo 분리 + zero-runtime-dep contract 원칙 위배 |
    65	| B14 | Go 바이너리 의존 | jikime-adk | 우리는 TypeScript 단일 스택 |
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
   151	| # | 위험 항목 | 위치 | 현재 상태 |
   152	|---|---|---|---|
   153	| E01 | gateway 내부 circular 2건 | naia-os/agent/gateway/ (`client.ts ↔ tool-bridge.ts`, `tool-bridge.ts ↔ sessions-spawn.ts`) | known debt, X8(messengers 추출) 시 해결 |
   154	| E02 | 테스트 커버리지 전면 부족 | Phase 1 + X1 | smoke/self-review only. issue #1 트래킹. PASS 정의 v2 상향 |
   155	| E03 | VRM lip-sync viseme vocabulary 미정 | `VoiceEvent.visemeId` | ARKit/Oculus/custom 미결정. project-airi의 wLipSync(D03) 후보로 해소 가능 |
   156	| E04 | Agent-level smoke test 미존재 | scripts/smoke-anthropic.ts | AnthropicClient 직접만 테스트. Agent 레벨(InMemory + Mock) 부재 |
   157	| E05 | Memory stubs 구현 | alpha-memory `contentTokens`/`jaccardSimilarity`/`mergeRelatedFacts` | stub 상태, dedup branch dead code. silent data-loss 위험 |
   158	| E06 | X1 wiring + factory env-gate 검증 | naia-os adapter | `yield { finish }` closure 미검증, factory 수동 1회만 확인 |
   159	| E07 | Memory 양방향성 시점/전환 규약 | claude-code 분석 결론 부재 | claude-code "single-directional" 인식만, 우리 정책 명시 미흡 |
   160	| E08 | provider DI 방식 (alpha-memory adapter) | memory-provider-audit §4 | wrapper class vs direct peerDep 미결정 |
   161	
   162	---
   163	
   164	## F. 결정 누락 — 분석은 있는데 정식 결정문 없음
   165	
   166	| # | 항목 | 분석 출처 | 누락 사유 |
   167	|---|---|---|---|
   168	| F01 | claude-code 15-agent 분석 (`11-ref-cc-analysis.json`) "Naia OS 도입 계획" | 보고서 작성 완료 | 채택/거부/이연 정식 매핑 부재 — **본 매트릭스 §A·D에서 cleanroom 비교 후 부분 해소** |
   169	| F02 | Dashboard (E1) | 4-repo plan v7 | Part B 미결정 — K3 실행 시점 |
   170	| F03 | `@naia-agent/cli` 패키지 신설 (E2) | 4-repo plan v7 | Part B 미결정 |
   171	| F04 | jikime-adk Dual Orchestrator 채택 깊이 | jikime-adk-review | Phase 2 이후 specialized agent 필요성 검증 후 |
   172	| **F05** | cleanroom 폐기 대응 plan (archived 2025-03, 974 stars) — D01/D02 OWASP/RFC 재근거화 | cleanroom-cc deep-audit + GitHub 페이지 신호 | **F09 forbidden_action으로 부분 해소**. Slice 2 진입 전 OWASP A03 + RFC 3986 출처 docs 신설 |
   173	
   174	---
   175	
   176	## G. ref별 채택 점수표 (한눈 요약)
   177	
   178	| ref | 우리에게 채택 가치 | 핵심 차용 | 거부 사유 |
   179	|---|---|---|---|
   180	| **opencode** | ★★★★★ | tool context, Logger tag/time, compaction 동적, DI 단순화 (4건) | SQL, Effect Layer 의존, Go+TUI |
   181	| **claude-code (private + cleanroom)** | ★★★★★ | DANGEROUS_COMMANDS, Path normalize, AuthMgr 이벤트, Cmd registry, Error enum (5건) | TUI, SaaS 특화 명령, Sentry telemetry |
   182	| **project-airi** | ★★★★ | wLipSync viseme, Narrative stripping, Emotion blending (3건) | monorepo, Hono backend, Stripe |
   183	| **openclaw / nanoclaw v2** | ★★★ | OpenClaw→MCP 4단계 (이미 완료), engage_mode + fan-out, OneCLI Vault | 999K LOC, gateway server overhead |
   184	| **cline** | ★★ | Memory 모니터링, Hook escape, Proto enum 매핑 | IDE plugin 결합, OTel/PostHog |
   185	| **jikime-adk** | ★★ | Dual Orchestrator 개념, 세분화 Hook | Go 의존, Webchat UI, 마이그레이션 특화 |
   186	| **moltbot** | ★ | ChannelPlugin adapter, Manifest lazy load | 999K LOC, gateway, ecosystem 강결합 |
   187	| **jikime-mem** | ★ | (직접 차용 없음, 검토만) | 모놀리식, Claude Code 플러그인 강결합, Chroma 고정 |
   188	| **mastra** | ★★★★★ | Eval scorers (D14), Memory tiers (D15), Tool context (D11), 3중 방어 (D13), provider fallback (D17) | monorepo (B17), Studio web IDE (B18), DynamicArgument 복잡도 |
   189	| **vercel-ai-sdk** | ★★★★ | ToolLoopAgent 시그니처 검증 (A01 보강), Tool context schema (D11), onStepFinish (D12), prompt cache (D16) | 50 provider 직접 의존 (B21), React hooks 결합 |
   190	| **langgraphjs** | ★★★ | Checkpoint 패턴 (C05 후보), interrupt/resume (C12 인접), Send sub-agent (C02 인접) | LangChain core 의존 (B19), StateGraph reducer (B20), Python parity 우선 |
   191	
   192	---
   193	
   194	## H. 매트릭스 사용 가이드
   195	
   196	- **A 항목**은 변경 금지 — 이미 결정 + 코드. 변경 시 별도 ADR.
   197	- **B 항목**은 재검토 시 `B##` 인용. 새로 거부 추가 시 §B에 append.
   198	- **C 항목**은 트리거 조건 충족 시 `C##` → `D##` 또는 `A##`로 승격.
   199	- **D 항목**은 R0.7 sub-issue로 변환됨. P0=즉시, P1=다음 슬라이스, P2=백로그.
   200	- **E 항목**은 issue #1(test coverage audit) 또는 별도 issue로 트래킹.
   201	- **F 항목**은 R1 plan 작성 시 결정 강제 (Part B로 이연 또는 R0 추가 결정).
   202	
   203	---
   204	
   205	## 참고 — ref별 review 파일 경로
   206	
   207	- `refs/cline-review.md` (commit 901d1b5c9, 2026-04-25)
   208	- `refs/jikime-adk-review.md` (commit b9f4fb98, 1.8.1)
   209	- `refs/jikime-mem-review.md` (commit 0e3f6920)
   210	- `refs/moltbot-review.md` (commit f29e15c05d)
   211	- `refs/openclaw-review.md` (commit 8d85222, prior analysis: `alpha-adk/.agents/progress/issue-186-openclaw-analysis.md`)
   212	- `refs/opencode-review.md` (commit 91468fe45)
   213	- `refs/project-airi-review.md` (commit 2b125d5f, v0.9.0+94)
   214	- `refs/cc-review.md` (private nextain/ref-cc 분석 docs + public ghuntley/claude-code-source-code-deobfuscation cleanroom)
   215	- `refs/cc-cleanroom-security-audit-2026-04-25.md` (cleanroom 보안 audit, F1~F4 미완성 stub 발견)
   216	- `refs/cc-cleanroom-deep-audit-2026-04-25.md` (paranoid bait audit, F5~F12 LLM 환각/silent fail + 8 파일 블랙리스트)
   217	- `refs/mastra-review.md` (commit b97a0594, ★★★★★ Eval/Memory tiers/Tool context)
   218	- `refs/langgraphjs-review.md` (commit 7f3320cd, ★★★ Checkpoint/Sub-agent/Interrupt)
   219	- `refs/vercel-ai-sdk-review.md` (commit 10432742, ★★★★ ToolLoopAgent/onStepFinish)
   220	
   221	---
   222	
   223	## I. v2 변경 이력 (2026-04-25 R1 cross-review 적용)
   224	
   225	**3-perspective cross-review 결과** (architect + reference-driven + paranoid auditor):
   226	
   227	- **§D 신규 9건** (D09~D17) — workspace sentinel / Tool 메타 / Tool context / onStepFinish / 3중 방어 / Eval scorers / Memory tiers / Prompt cache(C04 격상) / Provider fallback
   228	- **§B 신규 6건** (B17~B22) — Mastra monorepo / Mastra Studio / LangChain core / StateGraph reducer / Vercel multi-provider / cleanroom 라인 복붙
   229	- **§C04 → §D16 격상** (Vercel 영향)
   230	- **§F05 신규** — cleanroom 폐기 대응 plan
   231	- **§G 점수표** — Mastra/LangGraph/Vercel 3 ref 추가
   232	
   233	채택 옵션 A (light, 가볍게 directive): D09/D10 P0만 즉시 ingrain (Slice 1b), 나머지 P1/P2는 슬라이스 진행 시 자연 §A 승격. R3+ slice 신설은 outline만 (정식 신설은 R1 종료 후).
   234	
   235	---
   236	
   237	## J. R4 변경 이력 (2026-04-26 Hybrid Wrapper Pivot)
   238	
   239	**trigger**: 사용자 본질 고민 — "바닥부터 만드는 게 맞나" + "팀장 역할이 피곤" + "보고 ≠ 실제로 큰 낭패" + "알파와 단일 대화창에서 연속적으로 일을 시키고 싶다"
   240	
   241	**변경 요약**:
   242	
   243	- **§D 신규 7건** (D18~D24) — Hybrid wrapper / 단일 대화 + 정직 보고 / NaiaStreamChunk multi-modal / Real-time interrupt / vllm-omni adapter / Vercel AI SDK 보류 / Sub-agent supervisor
   244	- **§B 신규 1건** (B23) — naia-agent 풀 자체 build 거부 (1인 70k+ LOC 무리)
   245	- **§A 변경 0건** — R0 lock 보존 (interface contract / D1~D8 / Voice 3-layer 등 그대로)
   246	- **신규 docs 4건** — `docs/{vision-statement, architecture-hybrid, stream-protocol, adapter-contract}.md`
   247	- **R4 progress** — `.agents/progress/r4-hybrid-wrapper-2026-04-26.md`
   248	- **master issue** — nextain/naia-agent#2 댓글 R4 announce
   249	
   250	**vision lock**:
   251	> "Real-time interruptible multi-agent supervisor with multi-modal stream + 정직 보고"
   252	>
   253	> 3차원 차별화 (다른 framework에 거의 없음):
   254	> 1. Multi-modal stream (audio_delta 1급)
   255	> 2. Sub-agent supervisor (ACP/SDK + audit + interrupt)
   256	> 3. 단일 대화 + 정직 보고 (verification + diff + 수치)
   257	
   258	**Phase outline**:
   259	- Phase 1 (Week 1): 알파 CLI + opencode 단순 stdio + workspace watcher + verification + 수치 보고 → 사용자 피로 30~50% 감소 검증
   260	- Phase 2 (Week 2~3): ACP 정식 + Interrupt + Approval gate
   261	- Phase 3 (Week 4~6): claude SDK + sub-session card + alpha-memory
   262	- Phase 4 (Week 7~10): Adversarial review + naia-shell 통합 + vllm-omni audio
   263	
   264	**Week 0 cross-review (2026-04-26)** — 3-perspective parallel:
   265	
   266	- **Architect**: APPROVED with conditions (P0 3건 — SessionPhase enum / unsupported matrix / core 내부 DAG)
   267	- **Reference-driven**: APPROVED with P0 3건 + P1 5건 + 신규 §D 5건 (D25 tool context / D26 onSessionEnd / D27 3중 방어 / D28 memory 3-tier / D29 viseme vocab)
   268	- **Paranoid auditor**: APPROVED_WITH_RISKS — P0 5건 (외부 의존 검증 + secret redact + interrupt 500ms hard kill)
   269	
   270	**resolved by spike** (2026-04-26):
   271	- opencode ACP: ✓ `@agentclientprotocol/sdk@0.20.0`, opencode `packages/opencode/src/acp/` 정식 구현
   272	- Claude Agent SDK: ✓ `@anthropic-ai/claude-agent-sdk@0.2.119` public
   273	
   274	**P0 11건 모두 docs 반영** (stream-protocol §2/§5b, architecture-hybrid §5b/§6b/§6c, adapter-contract §2/§3 매핑/§8 보안/§9 contract test C11~C15).
   275	
   276	상세: `.agents/progress/r4-week0-cross-review-summary.md`
   277	
   278	---
   279	
   280	## K. R5 변경 이력 (2026-04-29 Vercel AI SDK 채택 정정)
   281	
   282	**trigger**: 사용자 directive 2026-04-29 — "Vercel ai sdk를 쓰면 어쨌든 llm확보가 매우 쉬워지잖아" + "토큰이 딸리게 생겨서 naia계정, anyllm에서 runpod을 지원할 수 있을지도 고려" + "우선 vercel ai sdk 적용으로 정리하고 계획 세우고 작업 진행해 / 우리 any-llm의 runpod지원은 이후에 추가 논의하자"
   283	
   284	**배경**: D23 (Vercel AI SDK 보류, R4 lock)이 사용자 원래 의사 ("로컬은 vercel꺼 쓰면 다 해결")와 정반대로 기록되어 silent drift. R3~R4에서 만든 7개 자체 provider 중 5개가 이전 naia-os/agent에서 carry-over일 뿐 실질 신규 abstraction 아니고, registry/factory layer는 오히려 후퇴.
   285	
   286	**변경 요약**:
   287	
   288	- **§D 신규 1건** (D44) — Vercel AI SDK 로컬 LLM 단일 abstraction 채택, peer-dep 패턴
   289	- **§D supersede** — D23 → D44 (strikethrough + supersede 명시)
   290	- **§B 격하** — B21 → demoted (sub-concern 회피 가능 명시: optional peer dep + headless)
   291	- **§A 영향 (예정)** — A10/A21/A22 자체 provider 채택 항목들은 Slice 시퀀스에서 §C/§deprecated 이동 후 제거. lab-proxy / lab-proxy-live (gateway 경로) + claude-cli (subprocess) 검토
   292	- **§D 미결 (RunPod)** — 사용자 directive로 "이후 논의" 보류. D45 후보 자리 표시: naia-anyllm gateway에 RunPod backend 통합 (lab-proxy `runpod:<model>` prefix 라우팅 + naiaKey 단일 인증)
   293	
   294	**P0 결정 (Phase 5.x, slices)**:
   295	
   296	| Slice | 목표 | success criterion |
   297	|---|---|---|
   298	| **5.x.0** | 매트릭스 + progress lock (본 commit) | docs only — S03/S04 면제 (matrix_id_citation 면제 항목) |
   299	| **5.x.1** | `VercelClient` adapter MVP — `LanguageModelV2` → `LLMClient` wrap | S01 신규 명령 (Vercel-backed `pnpm naia-agent`) + S02 unit (stream/generate 양방향 변환) + S03 integration (real Anthropic via Vercel) + S04 CHANGELOG entry |
   300	| **5.x.2** | 자체 `anthropic.ts` deprecate → VercelClient + `@ai-sdk/anthropic` | S01 동일 명령에서 Vercel-backed 동작 + S02 회귀 + S03 fixture-replay 재녹화 (F11 강제) |
   301	| **5.x.3** | `gemini.ts` / `openai-compat.ts` / `anthropic-vertex.ts` deprecate → Vercel | (3 sub-slices) GLM via zhipu-ai-provider, vLLM via @ai-sdk/openai-compatible, Vertex via @ai-sdk/google-vertex |
   302	| **5.x.4** | `claude-cli.ts` deprecate → `ai-sdk-provider-claude-code` (community) | subprocess wrap → Vercel SDK 패턴, Pro/Max 구독 path 보존 |
   303	| **5.x.5** | bin / examples / fixture-replay 갱신 + 자체 provider 5개 제거 | 250 PASS 회귀 + bin --help가 Vercel-backed provider 노출 |
   304	| **5.x.6** | Cross-review 3-perspective (architect / reference / paranoid) | review docs 3건 + P0 fix 반영 |
   305	
   306	**out of scope (별도 논의)**:
   307	- RunPod 통합 (D45 후보, naia-anyllm gateway 측 작업)
   308	- vllm-omni RunPod 호스팅 (자체 컨테이너 빌드 + Pod 배포, Phase 5+ 별도 검토)
   309	
   310	**보존 (Vercel 영역 밖, 변경 없음)**:
   311	- `lab-proxy.ts` (HTTPS, naiaKey)
   312	- `lab-proxy-live.ts` (WSS, naiaKey, vllm-omni `/v1/realtime`)
   313	- D43 자체 audio provider layer (Phase 5+)
   314	
   315	상세: `.agents/progress/vercel-ai-sdk-adoption-2026-04-29.md`

exec
/bin/bash -lc "nl -ba projects/naia-agent/.agents/context/agents-rules.json | sed -n '1,260p'" in /var/home/luke/alpha-adk
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
   101	      "rule": "integration_verify_1_plus",
   102	      "description": "통합 검증 1+ 도입 (fixture-replay or real-LLM smoke or 실 backend 호출). 부재 시 머지 차단"
   103	    },
   104	    {
   105	      "id": "S04",
   106	      "rule": "changelog_entry",
   107	      "description": "README 또는 CHANGELOG에 슬라이스 entry 1건"
   108	    },
   109	    {
   110	      "id": "G15",
   111	      "rule": "ci_fixture_only_mode_default",
   112	      "description": "CI에서 ANTHROPIC_API_KEY 없을 때 fixture-replay만으로 모든 test pass 가능해야 함. real-LLM smoke는 KEY 있을 때만 opt-in. fixture에 실제 API key 절대 금지",
   113	      "release_condition": "Slice 1b 이후 (fixture-replay 1건 도입 후)"
   114	    }
   115	  ],
   116	  "matrix_id_citation": {
   117	    "rule": "commit message + PR description에 매트릭스 ID(A##/B##/C##/D##/E##/F##/G##) 인용 필수",
   118	    "format": "예: 'fixes G03/D01' or 'addresses E05'",
   119	    "exemption": "매트릭스 외 영역(docs, infra) 변경 시 면제"
   120	  },
   121	  "tracking_issues": {
   122	    "master": "nextain/naia-agent#2",
   123	    "test_coverage_audit": "nextain/naia-agent#1",
   124	    "r0_p0_subissues": ["nextain/naia-agent#3", "nextain/naia-agent#4", "nextain/naia-agent#5", "nextain/naia-agent#6"],
   125	    "r0_p1_cluster": "nextain/naia-agent#7"
   126	  },
   127	  "context_priority": [
   128	    ".agents/context/agents-rules.json",
   129	    "AGENTS.md",
   130	    ".agents/context/project-index.yaml"
   131	  ],
   132	  "harness_compatibility": {
   133	    "standard": "AAIF / agents.md (https://agents.md/)",
   134	    "canonical_sot": "AGENTS.md",
   135	    "mirrors": {
   136	      "CLAUDE.md": {
   137	        "tool": "Claude Code",
   138	        "kind": "auto-generated mirror",
   139	        "auto_synced_from": "AGENTS.md",
   140	        "tool_specific_dir": ".claude/"
   141	      },
   142	      "GEMINI.md": {
   143	        "tool": "Gemini CLI",
   144	        "kind": "auto-generated mirror",
   145	        "auto_synced_from": "AGENTS.md",
   146	        "tool_specific_dir": ".gemini/",
   147	        "note": "Gemini CLI may also read .gemini/settings.json"
   148	      },
   149	      "OPENCODE.md": {
   150	        "tool": "opencode (sst)",
   151	        "kind": "auto-generated mirror",
   152	        "auto_synced_from": "AGENTS.md",
   153	        "tool_specific_dir": ".opencode/",
   154	        "note": "opencode reads AGENTS.md directly; mirror exists for explicitness"
   155	      },
   156	      "CODEX.md": {
   157	        "tool": "Codex (OpenAI)",
   158	        "kind": "auto-generated mirror",
   159	        "auto_synced_from": "AGENTS.md",
   160	        "note": "Codex reads AGENTS.md directly per OpenAI convention; mirror exists for explicitness"
   161	      }
   162	    },
   163	    "naia_self_tool": {
   164	      "kind": "future internal tool",
   165	      "reads": "AGENTS.md directly (no wrapper)",
   166	      "rationale": "We design our own tool to follow AAIF standard; no NAIA.md needed"
   167	    },
   168	    "sync_mechanism": {
   169	      "script": "scripts/sync-harness-mirrors.sh",
   170	      "modes": {
   171	        "default": "regenerate all 4 mirrors from AGENTS.md",
   172	        "--check": "exit 1 if any mirror diverges (CI / pre-commit)"
   173	      },
   174	      "edit_rule": "Edit ONLY AGENTS.md. Direct edits to mirrors are overwritten on next sync.",
   175	      "banner": "Each mirror starts with HTML comment <!-- AUTO-GENERATED MIRROR --> (hidden in Markdown render, visible to LLMs/grep)",
   176	      "pre_commit_hook": "ln -sf ../../scripts/sync-harness-mirrors.sh .git/hooks/pre-commit (optional, recommended)"
   177	    },
   178	    "tool_specific_dirs": {
   179	      "rule": "Tool-specific behavior (hooks, slash commands, settings) lives in .{tool}/ directory, not in <TOOL>.md mirror",
   180	      "rationale": "Mirror contains only the canonical project rules (same as AGENTS.md). Tool-specific extras are isolated in tool-specific dirs."
   181	    },
   182	    "conflict_resolution": [
   183	      "If AGENTS.md and mirror disagree → run sync script (AGENTS.md wins)",
   184	      "If .agents/context/agents-rules.json and AGENTS.md disagree → JSON wins (machine-readable, more precise)",
   185	      "If tool-specific dir setting and AGENTS.md disagree → tool-specific dir wins WITHIN tool's scope only (does not override forbidden_actions)"
   186	    ]
   187	  }
   188	}

exec
/bin/bash -lc "nl -ba projects/naia-agent/docs/agent-loop-design.md | sed -n '1,280p'" in /var/home/luke/alpha-adk
 succeeded in 0ms:
     1	# Agent Loop Design — references and decisions
     2	
     3	Design doc for `packages/core/src/agent.ts` (Phase 2 X3 scaffold).
     4	Captures why each choice was made, with reference to source material.
     5	
     6	## References surveyed
     7	
     8	| Source | Location | Strength | Weakness |
     9	|---|---|---|---|
    10	| **careti** (via naia-os/agent) | `naia-os/agent/src/index.ts` | Battle-tested streaming, `MAX_TOOL_ITERATIONS` loop, tool partitioning (concurrent vs sequential), tier-based approval via `pendingApprovals` Map, token budget pre-flight (warn-only), MCP cleanup | Budget check warns but does not compact — compaction TODO'd to #185 Phase 2 |
    11	| **opencode session/compaction** | `refs/ref-opencode/packages/opencode/src/session/{session,compaction,processor}.ts` | Formal compaction policy: `PRUNE_MINIMUM`, `PRUNE_PROTECT`, `preserveRecent`, turn-unit granularity. DB-backed persistence. | Effect + SQL makes it heavy for an embeddable runtime library. Overkill for our zero-runtime-dep + DI-first posture. |
    12	| **claude-code** (analysis) | `.agents/progress/11-ref-cc-analysis.json` + naia-os README quote | Automatic compaction, `CLAUDE.md`-based memory layer with subagent spawning | Memory is file-system and single-directional — no bidirectional real-time memory update |
    13	| **alpha-memory** | `projects/alpha-memory/src/memory/index.ts` | 4-store architecture, background consolidation (30-min default), reconsolidation (contradiction detection), Ebbinghaus decay, `consolidateNow(force)` for manual trigger | Current `consolidate()` is background; real-time stream compaction is a future capability (discussed separately) |
    14	
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
   121	services); we use a yielded union for a simpler embedded story.
   122	
   123	## Alpha-memory integration roadmap
   124	
   125	| Now (v0.1) | Next | Future |
   126	|---|---|---|
   127	| `encode`/`recall`/`consolidate`/`close` | `compact()` via `CompactableCapable` | Real-time compaction hook: memory observes LLM stream, maintains rolling summary, `compact()` returns instantly |
   128	| Background consolidation (30 min) | On-demand `consolidateNow()` triggered by agent | Per-turn micro-consolidation (light, predictable) |
   129	| Recall via vector search | Recall biased by current session | Attention-aware recall (what was just said) |
   130	| — | Sub-capabilities discoverable via `isCapable()` | Capability registry auto-populated |
   131	
   132	## Deferred / follow-up
   133	
   134	- Real tokenizer integration (provider-accurate counts). Currently chars/4
   135	- `sub-agent` spawning (claude-code pattern). Agent is single-level today
   136	- MCP bridge via runtime (X4, continuation of #200)
   137	- Prompt caching strategy — passthrough today, opinionated policy pending
   138	- Multi-session concurrency within a host — one HostContext = one Session (plan A.12)
   139	
   140	## Testing surface
   141	
   142	Current: `scripts/smoke-anthropic.ts` exercises `AnthropicClient` directly
   143	(not `Agent`). An `Agent`-level smoke (InMemoryMemory + Mock LLM + Mock
   144	Tools) lands in a follow-up commit once bash is available to run builds.

exec
/bin/bash -lc "nl -ba projects/naia-business-adk/README.md | sed -n '1,260p'" in /var/home/luke/alpha-adk
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
핵심 조항은 확보했습니다. 이제 #31, capability 거버넌스, manifest 위치 정합처럼 판정에 직접 걸리는 교차 참조만 추가로 좁혀 확인합니다.
exec
/bin/bash -lc 'rg -n "#31|RetrievalCapable|service manifest|manifest|workspace 파일 구조|capability" projects/naia-adk/.agents/progress/agent-service-builder-architecture.md .agents/progress/naia-4repo-migration-plan.md projects/naia-agent/.agents/progress/ref-adoption-matrix.md projects/naia-agent/docs/agent-loop-design.md projects/naia-business-adk/README.md' in /var/home/luke/alpha-adk
 succeeded in 0ms:
projects/naia-agent/docs/agent-loop-design.md:13:| **alpha-memory** | `projects/alpha-memory/src/memory/index.ts` | 4-store architecture, background consolidation (30-min default), reconsolidation (contradiction detection), Ebbinghaus decay, `consolidateNow(force)` for manual trigger | Current `consolidate()` is background; real-time stream compaction is a future capability (discussed separately) |
projects/naia-agent/docs/agent-loop-design.md:42:- **Graceful degradation** — if `memory` does not implement the capability, Agent falls back to simple sliding-window truncation (keep tail N, drop head).
projects/naia-agent/docs/agent-loop-design.md:45:to a capability interface so any memory can plug in.
projects/naia-agent/docs/agent-loop-design.md:86:granularity can add a sub-capability.
.agents/progress/naia-4repo-migration-plan.md:179:**`MemoryProvider`** — 최소 메소드 (`encode`/`recall`/`consolidate`/`close`) + **선택 Capability 인터페이스** (`BackupCapable`, `EmbeddingCapable`, `KnowledgeGraphCapable`, `ImportanceCapable`, `ReconsolidationCapable`, `TemporalCapable`). 구현체가 지원하는 capability만 implements. 소비자는 `if (isCapable(x, KnowledgeGraphCapable))`로 확인.
.agents/progress/naia-4repo-migration-plan.md:182:**`HostContext`** — 필수 최소(llm, memory, logger)와 확장 capability 분리. `HostContext.Core`, `HostContext.Full` 서브셋 허용.
.agents/progress/naia-4repo-migration-plan.md:192:**Capability 확장 거버넌스**: 새 Capability는 `@nextain/agent-types` PR로 추가 (additive). 구현체는 지원 capability를 명시적 implement. 거부·deprecation은 MAJOR 사유. **Capability 조합 의미론**은 각 Capability 정의 문서에서 명시 (예: `KnowledgeGraphCapable + TemporalCapable` 조합 규칙은 `TemporalCapable` 문서에 명시).
projects/naia-agent/.agents/progress/ref-adoption-matrix.md:22:| A09 | MemoryProvider 4 + N capability | mem0 audit + alpha-memory | `packages/types/src/memory.ts` | shape only |
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:21:| C1 service.manifest "제4 계약" (Part A 3-계약 위배) | **신규 최상위 계약 0개 원칙** (§2). manifest = naia-adk *workspace 파일 포맷*(A.6), public contract 아님. loader = host-side 조립 코드 |
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:22:| C2 F08/#31 gate 우회 | **Phase 0 = gate 폐쇄가 deliverable** (§6). 미폐쇄 시 slice 차단 (F08 준수 명문화) |
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:26:| M4 business governance 위치 | **§3** governance = operate layer (naia-business-adk host 주입), manifest 미확장 |
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:73:v1 의 치명 결함 = service.manifest / RAGProvider / OrchestrationPolicy 를
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:74:신규 계약처럼 다뤄 Part A 의 "계약 3개 고정 + capability=agent-types 소속"
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:80:| **service manifest** | naia-adk **workspace 파일 포맷** (A.6 "Workspace 파일 구조 = naia-adk"). public 런타임 contract 아님. 스키마 = naia-adk docs, 버전은 naia-adk semver |
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:81:| **manifest loader** | **host-side 코드** (naia-os / naia-business-adk host). manifest 를 읽어 *기존* HostContext(llm/memory/tools/persona-as-systemprompt) 를 조립. naia-agent 런타임 계약 무변경 |
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:82:| **persona / system prompt** | manifest 필드 → host 가 Agent 의 기존 system message 로 주입. 신규 계약 0 |
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:83:| **RAG** | **`RetrievalCapable` capability** — `@nextain/agent-types` 에 **additive PR**(A.5 capability 거버넌스: "새 Capability 는 agent-types PR 로 추가, 구현체가 implement, 소비자가 isCapable 확인"). 신규 패키지 아님. MemoryProvider 와 동급 capability |
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:84:| **orchestration** | §4 — agent-loop D1~D8(F06 불변) 위 **host-side step 조합**. 신규 계약이 꼭 필요하면 capability additive(A.5), 아니면 manifest 선언 + host 해석 |
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:87:→ **결과**: Part A 계약 3개 불변, 의존방향(A.3) 불변, capability 거버넌스(A.5)
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:94:**원칙**: manifest 는 *서비스 정의*만 담는다(portable/reproducible). 거버넌스는
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:95:manifest 에 넣지 않는다(스키마 확장 불필요 → A.11 계약 미수정 보존). 거버넌스는
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:96:**operate layer = host 가 manifest 실행 시 주입·강제**.
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:100:| service 정의(persona/skill/rag/memory/llm) | manifest (naia-adk workspace 포맷) |
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:102:| RBAC(author/reviewer/approver/releaser/auditor) | **naia-business-adk host** 가 manifest 실행 래핑 시 강제. manifest 미확장 |
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:103:| tenant boundary / approval chain / retention | naia-business-adk **operate layer 정책 파일**(manifest 와 별도, naia-business-adk 소유) |
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:107:**개인 자족성**: 외부 데모 = 개인 layer(naia-os host + manifest + 기존 계약)만으로
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:125:   Simplicity). 병렬 interleave 는 후속 capability(별 §D). 1차에 reducer 도입 안 함.
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:128:6. **위치** — host-side(manifest 의 orchestration 선언을 host 가 해석해 step
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:130:   그때 agent-types capability additive(§D + sub-issue).
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:141:- **Event emit 지점**(A.5 "주요 상태 전이"): `manifest.load.started/ended`,
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:142:  `manifest.validate.failed`, `retrieval.started/hit/empty`,
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:145:- **ErrorEvent shape**(A.11): manifest parse 실패 = `error_code:
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:151:- **regression gate**(A.11): baseline = #31 평가 하니스 수치(컨텍스트 적중·
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:168:      sub-issue(#2 하위): `D-SB1 RetrievalCapable(agent-types additive)` /
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:169:      `D-SB2 manifest workspace 포맷(naia-adk, 비-계약)` /
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:170:      `D-SB3 orchestration §4 계약(B20 회피 1~6)`. #31 = 본 우산 sub-issue 로 재프레이밍.
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:180:- **SB-1 manifest loader 최소** — naia-adk workspace manifest 스키마(docs) +
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:181:  host-side loader 가 manifest → 기존 HostContext(llm=qwen via D44 / memory=
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:183:  S01 `pnpm exec naia-agent --service <manifest>` · S02 unit(스키마 검증) ·
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:185:- **SB-2 RetrievalCapable** — agent-types additive PR(A.5 거버넌스) + alpha-memory
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:188:- **SB-3 #31 평가 결합** — manifest `eval.fixtures` → #31 하니스로 e2e 품질
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:190:  S01 `--eval` · S02 unit · S03 fixture e2e(persona+RAG+memory+qwen) · S04 · #31
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:194:**외부 데모 MVP = SB-1~SB-3** (manifest→persona+RAG+memory+qwen3.6-27b e2e+평가수치).
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:198:  ko-serve 트랙 PAUSED 해제 의존(gemini 누락 지적 반영 — Phase2 진입 = #31/ko-serve gate).
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:202:  파일**(manifest 미확장, host 주입). License 검증(A.6 원문).
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:209:2. **(검증대상)** RAG=RetrievalCapable additive 가 A.5 거버넌스로 충분한가, MemoryProvider 와 중복 아닌가.
projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:210:3. **(가정)** manifest=workspace 파일(A.6) ≠ public contract → "제4 계약" 회피 성립.

exec
/bin/bash -lc "rg -n \"#31|sub-issue|P0|OPEN P0|R1 plan\" projects/naia-agent -g '*.md' -g '*.json'" in /var/home/luke/alpha-adk
 succeeded in 0ms:
projects/naia-agent/GEMINI.md:79:4. 매트릭스에 없는 패턴 도입 시 매트릭스 §D에 항목 신설 + sub-issue 생성
projects/naia-agent/GEMINI.md:116:해소 시점: sub-issue **#3** (G01) close 후 자동 해제.
projects/naia-agent/GEMINI.md:142:### F08. OPEN P0 시 R1 차단
projects/naia-agent/GEMINI.md:144:OPEN P0 sub-issue (label `R0/P0` 또는 제목 prefix `[R0/P0]`)가 1건이라도 남아있으면 R1 plan 작성·실행 차단. 현재 P0: #3, #4, #5, #6.
projects/naia-agent/GEMINI.md:152:`@anthropic-ai/sdk` minor 이상 버전 bump PR은 fixture-replay 재녹화 + StreamPlayer 재생 검증 의무. SDK breaking change가 R1 plan-killer로 식별됨 (paranoid audit).
projects/naia-agent/GEMINI.md:246:- **R0 P0 sub-issues**: #3 (G01 bin), #4 (G02 real-LLM), #5 (G03+G04 보안), #6 (F01 cross-link)
projects/naia-agent/OPENCODE.md:79:4. 매트릭스에 없는 패턴 도입 시 매트릭스 §D에 항목 신설 + sub-issue 생성
projects/naia-agent/OPENCODE.md:116:해소 시점: sub-issue **#3** (G01) close 후 자동 해제.
projects/naia-agent/OPENCODE.md:142:### F08. OPEN P0 시 R1 차단
projects/naia-agent/OPENCODE.md:144:OPEN P0 sub-issue (label `R0/P0` 또는 제목 prefix `[R0/P0]`)가 1건이라도 남아있으면 R1 plan 작성·실행 차단. 현재 P0: #3, #4, #5, #6.
projects/naia-agent/OPENCODE.md:152:`@anthropic-ai/sdk` minor 이상 버전 bump PR은 fixture-replay 재녹화 + StreamPlayer 재생 검증 의무. SDK breaking change가 R1 plan-killer로 식별됨 (paranoid audit).
projects/naia-agent/OPENCODE.md:246:- **R0 P0 sub-issues**: #3 (G01 bin), #4 (G02 real-LLM), #5 (G03+G04 보안), #6 (F01 cross-link)
projects/naia-agent/CLAUDE.md:79:4. 매트릭스에 없는 패턴 도입 시 매트릭스 §D에 항목 신설 + sub-issue 생성
projects/naia-agent/CLAUDE.md:116:해소 시점: sub-issue **#3** (G01) close 후 자동 해제.
projects/naia-agent/CLAUDE.md:142:### F08. OPEN P0 시 R1 차단
projects/naia-agent/CLAUDE.md:144:OPEN P0 sub-issue (label `R0/P0` 또는 제목 prefix `[R0/P0]`)가 1건이라도 남아있으면 R1 plan 작성·실행 차단. 현재 P0: #3, #4, #5, #6.
projects/naia-agent/CLAUDE.md:152:`@anthropic-ai/sdk` minor 이상 버전 bump PR은 fixture-replay 재녹화 + StreamPlayer 재생 검증 의무. SDK breaking change가 R1 plan-killer로 식별됨 (paranoid audit).
projects/naia-agent/CLAUDE.md:246:- **R0 P0 sub-issues**: #3 (G01 bin), #4 (G02 real-LLM), #5 (G03+G04 보안), #6 (F01 cross-link)
projects/naia-agent/AGENTS.md:68:4. 매트릭스에 없는 패턴 도입 시 매트릭스 §D에 항목 신설 + sub-issue 생성
projects/naia-agent/AGENTS.md:105:해소 시점: sub-issue **#3** (G01) close 후 자동 해제.
projects/naia-agent/AGENTS.md:131:### F08. OPEN P0 시 R1 차단
projects/naia-agent/AGENTS.md:133:OPEN P0 sub-issue (label `R0/P0` 또는 제목 prefix `[R0/P0]`)가 1건이라도 남아있으면 R1 plan 작성·실행 차단. 현재 P0: #3, #4, #5, #6.
projects/naia-agent/AGENTS.md:141:`@anthropic-ai/sdk` minor 이상 버전 bump PR은 fixture-replay 재녹화 + StreamPlayer 재생 검증 의무. SDK breaking change가 R1 plan-killer로 식별됨 (paranoid audit).
projects/naia-agent/AGENTS.md:241:- **R0 P0 sub-issues**: #3 (G01 bin), #4 (G02 real-LLM), #5 (G03+G04 보안), #6 (F01 cross-link)
projects/naia-agent/docs/architecture-hybrid.md:153:### 5b. core 내부 module DAG (P0-9 fix, Architect 권고)
projects/naia-agent/docs/architecture-hybrid.md:219:### 6b. Verification 3중 방어 (P0-10, matrix D27)
projects/naia-agent/docs/architecture-hybrid.md:233:### 6c. Interrupt deadline (P0-7, Paranoid)
projects/naia-agent/docs/adapter-contract.md:51:  readonly toolContext: ToolExecutionContext; // P0-4 (D25) — tool 호출 시 inject
projects/naia-agent/docs/adapter-contract.md:55: * P0-4 fix (Reference + Architect):
projects/naia-agent/docs/adapter-contract.md:149:| C11 | **(P0-7)** spawn 시 workdir 외부 file 접근 시 emit drop + warning (matrix D09 강제) |
projects/naia-agent/docs/adapter-contract.md:150:| C12 | **(P0-7, Paranoid)** `cancel()` 호출 후 500ms 내 `session_end(reason:"cancelled")` emit. 미emit 시 supervisor가 SIGKILL. |
projects/naia-agent/docs/adapter-contract.md:151:| C13 | **(P0-6)** 모든 emit chunk에서 secret pattern (sk-ant-/sk-/gw-/AIzaSy/Bearer) redact 검증 |
projects/naia-agent/docs/adapter-contract.md:152:| C14 | **(P0-5)** unsupported method (`pause`/`inject` 등) 호출 시 `UnsupportedError` throw |
projects/naia-agent/docs/adapter-contract.md:167:### Unsupported methods matrix (P0-5 fix, Architect)
projects/naia-agent/docs/adapter-contract.md:332:| **secret redact (P0-6)** | **모든 SubAgentEvent → NaiaStreamChunk 변환 시점에 redact 함수 mandatory wrapper** — `adapters/*/event-converter.ts`에서 `observability/redact.ts`의 `redactSecrets()` 호출 후 emit. (sk-ant- / sk- / gw- / AIzaSy / Bearer 5 패턴, Slice 2.7) |
projects/naia-agent/CODEX.md:79:4. 매트릭스에 없는 패턴 도입 시 매트릭스 §D에 항목 신설 + sub-issue 생성
projects/naia-agent/CODEX.md:116:해소 시점: sub-issue **#3** (G01) close 후 자동 해제.
projects/naia-agent/CODEX.md:142:### F08. OPEN P0 시 R1 차단
projects/naia-agent/CODEX.md:144:OPEN P0 sub-issue (label `R0/P0` 또는 제목 prefix `[R0/P0]`)가 1건이라도 남아있으면 R1 plan 작성·실행 차단. 현재 P0: #3, #4, #5, #6.
projects/naia-agent/CODEX.md:152:`@anthropic-ai/sdk` minor 이상 버전 bump PR은 fixture-replay 재녹화 + StreamPlayer 재생 검증 의무. SDK breaking change가 R1 plan-killer로 식별됨 (paranoid audit).
projects/naia-agent/CODEX.md:246:- **R0 P0 sub-issues**: #3 (G01 bin), #4 (G02 real-LLM), #5 (G03+G04 보안), #6 (F01 cross-link)
projects/naia-agent/CHANGELOG.md:128:**3-perspective cross-review 결과 surgical fixes.** architect / reference-driven (vercel:ai-architect) / paranoid 3개 병렬 review → P0 5건 통합 + P1 일부 즉시 적용. types 확장 필요한 항목은 Tier B로 매트릭스 backlog (D45~D52 후보).
projects/naia-agent/CHANGELOG.md:131:- architect: APPROVED_WITH_CONDITIONS (P0 3건)
projects/naia-agent/CHANGELOG.md:132:- reference-driven: APPROVED_WITH_RECOMMENDATIONS (P0 2건 — Vercel canonical 패턴 deviation)
projects/naia-agent/CHANGELOG.md:133:- paranoid: NEEDS_REVISION (P0 1건 + P1 5건)
projects/naia-agent/CHANGELOG.md:136:1. **P0-1** dist/ 잔존 5 provider artifacts 정리 + `clean`/`rebuild` script (`packages/providers/package.json`). npm publish 시 deleted code 배포 위험 차단
projects/naia-agent/CHANGELOG.md:137:2. **P0-2** specificationVersion discriminant — `VercelClient.#spec` 필드 + `fromVercelFinishReason(reason, spec)` / `fromVercelUsage(usage, spec)` (이전 structural sniff 제거)
projects/naia-agent/CHANGELOG.md:138:3. **P0-3** README + 매트릭스 B21 정정 — `optionalDependencies` 5 default bundle + peer 분리 명시. "zero-runtime-dep 정신 보존" 주장 제거 (자동설치와 충돌)
projects/naia-agent/CHANGELOG.md:139:4. **P0-4** V2 Anthropic `cacheReadTokens` `inputTokenDetails` fallback. `@ai-sdk/anthropic@2.x`가 V2 spec의 `cachedInputTokens` 대신 `inputTokenDetails.cacheReadTokens` 사용 → 이전 cache hit silent 0
projects/naia-agent/CHANGELOG.md:140:5. **P0-5** `tool-call` aggregate fallback — id가 idToIndex에 없을 때 content_block_start + input_json_delta + content_block_stop trio synthesize. Bedrock 등 tool-input-* 안 emit하는 provider 도구 호출 silent 손실 방지
projects/naia-agent/CHANGELOG.md:147:  - `fromVercelUsage` V2 explicit / V2 inputTokenDetails fallback (P0-4) / V2 양쪽 동시일 때 cachedInputTokens 우선 / V3 nested / V3 undefined zero
projects/naia-agent/CHANGELOG.md:149:  - `tool-call` aggregate fallback (P0-5) — id unknown 시 trio synthesize
projects/naia-agent/CHANGELOG.md:432:- **5.x.6**: Cross-review 3-perspective + P0 fix
projects/naia-agent/CHANGELOG.md:684:- closes #5 (G03+G04 P0 — DANGEROUS + path normalize 모두 §A)
projects/naia-agent/CHANGELOG.md:717:Slice 2 (Bash skill + observability + 보안 D01/D02/D09 ingrain) — sub-issue #5
projects/naia-agent/CHANGELOG.md:916:- D09/D10/D11 P0 ingrain
projects/naia-agent/CHANGELOG.md:923:- §D 신규 9건: D09 (workspace sentinel) P0 / D10 (Tool 메타) P0 / D11~D17 (Tool context, onStepFinish, 3중 방어, Eval scorers, Memory tiers, Prompt cache C04 격상, Provider fallback)
projects/naia-agent/CHANGELOG.md:939:- Slice 1b에 D09/D10/D11 P0 ingrain
projects/naia-agent/CHANGELOG.md:940:- Slice 3에 G06 cross-repo P0 gate 명시 (alpha-memory stub 해소 전 진입 차단)
projects/naia-agent/docs/stream-protocol.md:85:      phase: SessionPhase;        // P0-1 fix — string literal union (consumer 추론 가능)
projects/naia-agent/docs/stream-protocol.md:95:  // P0-11: onSessionEnd hook (Vercel onStepFinish + Mastra) — supervisor가 report 생성 전 emit
projects/naia-agent/docs/stream-protocol.md:167:// ─── enums (P0-1 fix) ─────────────────────────────────────────────
projects/naia-agent/docs/stream-protocol.md:280:## 5b. session_aggregated (P0-11, supervisor 책임)
projects/naia-agent/docs/stream-protocol.md:282:**문제** (Reference P0-2): `session_end`은 adapter가 emit. 그러나 supervisor가 `report`를 만들기 전에 stats를 aggregate해야 함 (verification 결과 + tool 사용량 + workspace stats 합산).
projects/naia-agent/packages/providers/README.md:20:The package uses a **two-tier dependency model** (5.x.6 cross-review P0-3

exec
/bin/bash -lc "nl -ba projects/naia-agent/AGENTS.md | sed -n '124,150p'" in /var/home/luke/alpha-adk
 succeeded in 0ms:
   124	
   125	`docs/agent-loop-design.md` D1~D8 수정 금지. 신규 결정만 매트릭스 §D에 추가.
   126	
   127	### F07. 4-repo plan Part A 보존
   128	
   129	`alpha-adk/.agents/progress/naia-4repo-migration-plan.md` Part A 수정 금지. 본 레포 R0/R1은 실행 시퀀싱만 변경.
   130	
   131	### F08. OPEN P0 시 R1 차단
   132	
   133	OPEN P0 sub-issue (label `R0/P0` 또는 제목 prefix `[R0/P0]`)가 1건이라도 남아있으면 R1 plan 작성·실행 차단. 현재 P0: #3, #4, #5, #6.
   134	
   135	### F09. cleanroom 단독 의존 금지 (v2 추가)
   136	
   137	`ref-cc-cleanroom` (ghuntley) 단독 의존 금지. D01/D02 같은 패턴 차용 시 OWASP/RFC/Anthropic 1차 spec 출처 docs 1건 이상 cross-reference 강제. cleanroom 코드 라인 직접 복붙 금지(B22). 근거: cleanroom archived(2025-03) + 2 commits + LLM 환각/silent drift 위험 (deep-audit F1~F12).
   138	
   139	### F11. SDK breaking 사전 감지 (v2 추가)
   140	
   141	`@anthropic-ai/sdk` minor 이상 버전 bump PR은 fixture-replay 재녹화 + StreamPlayer 재생 검증 의무. SDK breaking change가 R1 plan-killer로 식별됨 (paranoid audit).
   142	
   143	### F01 보안 예외 (v2 보강)
   144	
   145	F01 차단은 **보안 패치(CVE-worthy)에 적용 안 함** (4-repo plan A.13 보안 lockstep 면제 원칙). 단 단위 테스트 동시 도입 강제.
   146	
   147	---
   148	
   149	## 자주 하는 실수 회피
   150	

exec
/bin/bash -lc "rg -n \"#31|evaluation harness|평가 하니스|fixture\" projects/naia-agent/.agents/progress -g '*.md'" in /var/home/luke/alpha-adk
 succeeded in 0ms:
projects/naia-agent/.agents/progress/issue-draft-agent-eval-framework.md:2:     ✅ 정식 등록됨: nextain/naia-agent#31
projects/naia-agent/.agents/progress/issue-draft-agent-eval-framework.md:39:가능하게(fixture-replay 우선) 측정. minicpm 은 첫 번째 평가 대상 backend.
projects/naia-agent/.agents/progress/issue-draft-agent-eval-framework.md:48:  fixture-replay). 그래서 다음 작업 = 이 프레임웍. minicpm 라이브 e2e만
projects/naia-agent/.agents/progress/issue-draft-agent-eval-framework.md:66:1. **agent-flow 평가 하니스** (헤드라인): ko-serve backend-only
projects/naia-agent/.agents/progress/issue-draft-agent-eval-framework.md:69:   품질(컨텍스트 적중, 한국어, 실시간, 안정). fixture-replay 우선
projects/naia-agent/.agents/progress/issue-draft-agent-eval-framework.md:100:- [ ] agent-flow 평가 하니스 설계 (지표·fixture-replay 스키마·G15)
projects/naia-agent/.agents/progress/issue-draft-agent-eval-framework.md:104:- [ ] (F01/slice 충족 시) `examples/minicpm-realtime-host.ts` + fixture + unit test 스켈레톤
projects/naia-agent/.agents/progress/issue-draft-agent-eval-framework.md:113:S01 새 실행 명령 · S02 unit test 1+ · S03 통합검증(Phase1 fixture-replay
projects/naia-agent/.agents/progress/ref-adoption-matrix.md:32:| **A19** | Fixture-replay minimal (StreamPlayer + 정규형 fixture) | opencode 갭 + 자체 (C21 부분 §C → §A 승격, Slice 1b) | `packages/runtime/src/testing/stream-player.ts` + `__fixtures__/anthropic-1turn.json` | 4 unit (fixture-replay.test.ts). 정식 framework는 Slice 5 |
projects/naia-agent/.agents/progress/ref-adoption-matrix.md:145:| **D44** | **Vercel AI SDK 로컬 LLM 단일 abstraction 채택** (D23 supersede) — `ai` core를 peer dep, `@ai-sdk/<provider>`도 optional peer dep. 50+ provider 즉시 호환. 자체 5개(`anthropic`/`anthropic-vertex`/`gemini`/`openai-compat`/`claude-cli`) → `VercelClient` adapter 1개로 대체. CLI 구독 path는 community provider (`ai-sdk-provider-claude-code`/`-codex-cli`/`-gemini-cli`/`-opencode-sdk`)로 흡수. **lab-proxy / lab-proxy-live는 보존** (naiaKey 보호 + WebSocket Live API, Vercel 영역 밖). vllm-omni 텍스트 mode = `@ai-sdk/openai-compatible`로 즉시 호환, audio_delta realtime은 D43 자체 layer 유지 | 사용자 directive 2026-04-29 — D23 silent drift 정정. 토큰 부족 → multi-provider 확보 절실. RunPod naia 계정 통합은 별도 (D45 후보) | **P0** | L (Phase 5.x slices) | packages/providers/src/vercel-client.ts (adapter) + 5개 자체 provider deprecate → 제거 (slice 시퀀스). bin / examples / fixture-replay 갱신 |
projects/naia-agent/.agents/progress/ref-adoption-matrix.md:300:| **5.x.2** | 자체 `anthropic.ts` deprecate → VercelClient + `@ai-sdk/anthropic` | S01 동일 명령에서 Vercel-backed 동작 + S02 회귀 + S03 fixture-replay 재녹화 (F11 강제) |
projects/naia-agent/.agents/progress/ref-adoption-matrix.md:303:| **5.x.5** | bin / examples / fixture-replay 갱신 + 자체 provider 5개 제거 | 250 PASS 회귀 + bin --help가 Vercel-backed provider 노출 |
projects/naia-agent/.agents/progress/runnable-testable-gap.md:47:전부 unit. **integration 0건. fixture-replay E2E 0건. real-LLM 통합 0건.**
projects/naia-agent/.agents/progress/runnable-testable-gap.md:71:| Agent 루프 결정적 재생 가능? | ❌ | fixture-replay 부재. 매 테스트 새로 mock 작성 |
projects/naia-agent/.agents/progress/runnable-testable-gap.md:72:| E2E test (real LLM with recorded fixture) 1건이라도? | ❌ | 0건 |
projects/naia-agent/.agents/progress/runnable-testable-gap.md:79:- **테스트**: 2/6 (build + unit OK, integration/fixture/E2E 부재)
projects/naia-agent/.agents/progress/runnable-testable-gap.md:91:| G02 | 진짜 LLM × Agent 통합 검증 0건 | Slice 1 도중 fixture-replay 1건 추가 |
projects/naia-agent/.agents/progress/runnable-testable-gap.md:110:| G11 | fixture-replay framework (StreamRecorder/Player) 자체 | Slice 1 진행하며 ad-hoc로 시작, Slice 5쯤 정식 framework |
projects/naia-agent/.agents/progress/runnable-testable-gap.md:125:   - fixture-replay (StreamRecorder 녹화 → Player 재생)
projects/naia-agent/.agents/progress/design-recheck-2026-04-25.md:64:3. **통합 검증 1+** — fixture-replay OR real-LLM smoke (CI에서 KEY 있을 때만) OR 실 backend 호출
projects/naia-agent/.agents/progress/design-recheck-2026-04-25.md:70:- 테스트: **2/6** (build + unit OK, integration/fixture/E2E 부재)
projects/naia-agent/.agents/progress/design-recheck-2026-04-25.md:99:- **G10/G11/G12/G13/G14**: wLipSync viseme, fixture-replay framework, ChannelPlugin adapter, AuthManager 이벤트, Command Registry 카테고리
projects/naia-agent/.agents/progress/design-recheck-2026-04-25.md:110:| **1** | `bin/naia-agent` 최소 REPL | G01, G02 | `pnpm exec naia-agent "hi"` | fixture-replay 첫 케이스 |
projects/naia-agent/.agents/progress/design-recheck-2026-04-25.md:114:| **5** | fixture-replay framework 정식 | G11 | `pnpm exec naia-agent --replay=path.json` | StreamRecorder/Player 단위 |
projects/naia-agent/.agents/progress/dev-framework-and-process.md:59:| **integration / fixture-replay** | (R3+ Slice 1부터 도입) | **0** |
projects/naia-agent/.agents/progress/dev-framework-and-process.md:63:drift 위험 §E04 — Agent-level smoke 미존재. Slice 1에서 fixture-replay 도입으로 해소.
projects/naia-agent/.agents/progress/dev-framework-and-process.md:160:│    ├─ fixture-replay (선호)                       │
projects/naia-agent/.agents/progress/dev-framework-and-process.md:175:| **Slice 1** | **스켈레톤 먼저** (real Anthropic 통합) → 그다음 그 동작을 fixture로 녹화해 테스트 |
projects/naia-agent/.agents/progress/dev-framework-and-process.md:179:요약: "TDD 우선" 대신 "**살아남는 코드 우선, 즉시 fixture 회귀 잡기**".
projects/naia-agent/.agents/progress/dev-framework-and-process.md:217:- 모든 슬라이스의 fixture를 cross-check
projects/naia-agent/.agents/progress/dev-framework-and-process.md:232:- Slice 1 실패 (real Anthropic 통합 못 함, fixture도 안 됨) → R0 재진입
projects/naia-agent/.agents/progress/dev-framework-and-process.md:273:Slice 5   허파 ................. fixture-replay framework
projects/naia-agent/.agents/progress/dev-framework-and-process.md:324:- 정식 fixture framework → Slice 5
projects/naia-agent/.agents/progress/r1-slice-spine-2026-04-25.md:34:- `migration/slice-5-fixture-replay-framework`
projects/naia-agent/.agents/progress/r1-slice-spine-2026-04-25.md:94:> **v2 변경 (2026-04-25 cross-review)**: Slice 1을 1a(mock-only) / 1b(real Anthropic + fixture) 두 PR로 분할. 위험 격리 — 1b 실패 시 1a로 rollback 가능. 척추(bin) 1a에서 살아남으면 F01 자동 해제.
projects/naia-agent/.agents/progress/r1-slice-spine-2026-04-25.md:112:### 4.1 Slice 1b — real Anthropic + ad-hoc fixture-replay
projects/naia-agent/.agents/progress/r1-slice-spine-2026-04-25.md:115:- **목표**: 1a host factory에 real AnthropicClient 주입. fixture-replay 1건. **D09 (workspace sentinel) + D10 (Tool 메타) 동시 ingrain (P0)**.
projects/naia-agent/.agents/progress/r1-slice-spine-2026-04-25.md:118:  - `__fixtures__/anthropic-1turn.json` (녹화)
projects/naia-agent/.agents/progress/r1-slice-spine-2026-04-25.md:119:  - `__tests__/fixture-replay.test.ts`
projects/naia-agent/.agents/progress/r1-slice-spine-2026-04-25.md:125:  2. `fixture-replay.test.ts` PASS (G02 해소)
projects/naia-agent/.agents/progress/r1-slice-spine-2026-04-25.md:150:| `__tests__/fixture-replay.test.ts` | fixture-replay 1건 — Anthropic SDK 스트림 녹화 JSON → Agent 결정적 재생 |
projects/naia-agent/.agents/progress/r1-slice-spine-2026-04-25.md:151:| `__fixtures__/anthropic-1turn.json` | 녹화된 fixture (1턴 hello/world) |
projects/naia-agent/.agents/progress/r1-slice-spine-2026-04-25.md:161:3. **통합 검증**: `fixture-replay.test.ts` — Anthropic SDK 스트림 fixture 재생 시 assistantText 결정적 (G02 해소)
projects/naia-agent/.agents/progress/r1-slice-spine-2026-04-25.md:167:- **G02**: real-LLM 통합 검증 — fixture-replay로 해소
projects/naia-agent/.agents/progress/r1-slice-spine-2026-04-25.md:183:- 정식 fixture-replay framework (Slice 5 — 본 슬라이스에서는 ad-hoc)
projects/naia-agent/.agents/progress/r1-slice-spine-2026-04-25.md:289:| `__tests__/long-session-fixture-replay.test.ts` | 통합 검증 — fixture로 long-session 재생 → compaction emit verify |
projects/naia-agent/.agents/progress/r1-slice-spine-2026-04-25.md:294:1. **새 실행 가능 명령**: `pnpm exec naia-agent --long-session-demo` (스크립트된 100턴 fixture)
projects/naia-agent/.agents/progress/r1-slice-spine-2026-04-25.md:296:3. **통합 검증**: fixture-replay long-session → 정확한 시점에 `compaction` event emit
projects/naia-agent/.agents/progress/r1-slice-spine-2026-04-25.md:310:Slice 1+4에서 ad-hoc 도입한 fixture-replay를 정식 framework로 격상. `StreamRecorder` + `StreamPlayer` 표준화.
projects/naia-agent/.agents/progress/r1-slice-spine-2026-04-25.md:314:- branch: `migration/slice-5-fixture-replay-framework`
projects/naia-agent/.agents/progress/r1-slice-spine-2026-04-25.md:325:| `examples/fixture-replay-host.ts` | record + replay 데모 |
projects/naia-agent/.agents/progress/r1-slice-spine-2026-04-25.md:326:| `__tests__/cross-slice-replay.test.ts` | 통합 — 다른 슬라이스의 fixture를 player로 재생 |
projects/naia-agent/.agents/progress/r1-slice-spine-2026-04-25.md:332:3. **통합 검증**: 기존 슬라이스(Slice 1) fixture를 player로 재생 → 동일 결과
projects/naia-agent/.agents/progress/r1-slice-spine-2026-04-25.md:337:- **G11**: fixture-replay framework — 해소
projects/naia-agent/.agents/progress/r1-slice-spine-2026-04-25.md:343:- Slice 4 (long-session fixture)
projects/naia-agent/.agents/progress/r1-slice-spine-2026-04-25.md:364:- **R3.1 Eval scorers slice** — Mastra `MastraScorer` 패턴, **D14**. fixture-replay + scorer 묶어 quality 회귀 잡기
projects/naia-agent/.agents/progress/r1-slice-spine-2026-04-25.md:402:- **Slice 1 실패**: bin/naia-agent가 real Anthropic 통합에서 막힘. fixture-replay도 안 되면 → Phase 0 재진입
projects/naia-agent/.agents/progress/r1-slice-spine-2026-04-25.md:418:- [ ] 통합 검증: {fixture-replay or real-LLM smoke or backend call}
projects/naia-agent/.agents/progress/refs/opencode-review.md:30:## 5. fixture-replay 갭 (opencode에 없는 것)
projects/naia-agent/.agents/progress/refs/opencode-review.md:32:opencode는 226개 unit test (bun test) 보유, fixture-replay는 부재 → Anthropic SDK 스트림의 결정적 재생 불가. **우리는 명시적으로 도입해야**:
projects/naia-agent/.agents/progress/refs/opencode-review.md:41:- **이연**: fixture-replay E2E 테스트 (R3+ Slice 단위로 도입; 현재는 smoke test + mock 수준)
projects/naia-agent/.agents/progress/refs/opencode-review.md:47:3. **Fixture-replay 우선순위**: R1에 smoke + mock, R3에 fixture? (Phase 2 backlog 확인 필요)
projects/naia-agent/.agents/progress/r4-week0-cross-review-summary.md:52:| P1-9 | Paranoid | chokidar race condition test (rapid sequential write) | Phase 1 시작 전 (test fixture) |
projects/naia-agent/.agents/progress/r4-week0-cross-review-summary.md:53:| P1-10 | Paranoid | git diff stash/rebase 처리 | Phase 1 (test fixture) |
projects/naia-agent/.agents/progress/r4-phase-1-spec.md:85:| 1.5 | 1h | unit test (mock child_process, contract test C1~C10 일부, A6 path traversal fixture) |
projects/naia-agent/.agents/progress/r4-phase-1-spec.md:119:| 3.6 | 30min | E2E test fixture (file 5개 동시 write → 정확 stats + ordering) |
projects/naia-agent/.agents/progress/r4-phase-1-spec.md:139:| 5.0 | 30min | **StreamMerger spike** (Architect P0-1) — interleave 정책 결정: `(A) 동일 sessionId 내 strict order` + `(B) 다른 sessionId 간 emit timestamp 오름차순 round-robin merge` 채택. fixture 1건 작성 |
projects/naia-agent/.agents/progress/r4-week0-cross-review-2nd-summary.md:72:| A6 | opencode workdir 격리 실제 동작 미검증 | Day 2.5 unit test + path traversal fixture |
projects/naia-agent/.agents/progress/r4-week0-cross-review-2nd-summary.md:73:| A7 | chokidar 파일 간 race (5개 동시 write ordering) | Day 3.5 fixture 추가 명시 |
projects/naia-agent/.agents/progress/r4-week0-cross-review-2nd-summary.md:82:- **Reference P1-1**: chokidar race fixture 구체 — Day 3.5 명시
projects/naia-agent/.agents/progress/r4-week0-cross-review-2nd-summary.md:93:| Q1 | StreamMerger interleave 정책 | (B) sessionId별 strict + 다른 세션 간 timestamp round-robin (Day 5.0 spike에서 fixture 작성) |
projects/naia-agent/.agents/progress/r5-cross-review-2026-04-29.md:66:- P-P1-5: F11 fixture-replay rule misfires (현 fixture는 generic LLMStreamChunk 라 F11 trigger 무관, 단 adapter-level Vercel SDK shape fixture는 부재)
projects/naia-agent/.agents/progress/r5-cross-review-2026-04-29.md:109:| **D49** | adapter-level Vercel SDK shape fixture (V2/V3 raw stream-part) — F11 v3 | P-P1-5 | P1 |
projects/naia-agent/.agents/progress/r5-cross-review-2026-04-29.md:138:2. **D49 adapter-level fixture** — F11 v3, breaking SDK detection 자동화
projects/naia-agent/.agents/progress/vercel-ai-sdk-adoption-2026-04-29.md:125:| **S03 통합** | ✅ Mock LanguageModelV2 가 실 V2 stream-part shape emit. 25 테스트가 round-trip 검증. 실 Anthropic은 ANTHROPIC_API_KEY opt-in (G15 fixture-only-default) |
projects/naia-agent/.agents/progress/vercel-ai-sdk-adoption-2026-04-29.md:154:| **fixture (F11)** | ⊘ 미트리거 — 본 slice는 SDK bump 아니라 내부 deprecate. 기존 fixture는 generic `LLMStreamChunk[]` JSON이라 어떤 LLMClient 구현과도 무관 (StreamPlayer 가 사용) |
projects/naia-agent/.agents/progress/vercel-ai-sdk-adoption-2026-04-29.md:209:- **paranoid**: 키 노출 / SDK breaking (V4 진입 시 explicit error로 surfacing 검증) / fixture drift / F09 cleanroom / F11 SDK bump / cross-platform CLI binary 누락 시 graceful failure / Flatpak sandbox 회피 path 정확성
projects/naia-agent/.agents/progress/vercel-ai-sdk-adoption-2026-04-29.md:271:3. F11 (SDK minor bump fixture-replay 재녹화) 5.x.1에서 적용 OK?

codex
VERDICT: ISSUES_FOUND

[C1~m1 해소]
C1: FAIL — §2는 manifest를 workspace 포맷으로 밀어 넣지만, §7.3에서 그 주장을 아직 “가정”으로 남겨두고 있고 SB-1은 이를 `naia-agent --service`가 소비하는 버전드 스키마로 전제한다. strict 기준에선 “제4 계약 아님”이 입증되지 않았다. `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:80-84` `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:180-184` `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:210` `.agents/progress/naia-4repo-migration-plan.md:209` `.agents/progress/naia-4repo-migration-plan.md:287-288`
C2: FAIL — F08은 OPEN P0가 1건이라도 있으면 R1 plan 작성 자체를 차단하는데, v2는 실제 P0 실측을 Phase0로 미루면서도 이미 Phase1 SB-1~4를 상세 계획으로 써버렸다. gate를 “명문화”했을 뿐 우회를 멈추지 못했다. `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:156-194` `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:212` `projects/naia-agent/.agents/context/agents-rules.json:69-72`
M1: FAIL — §4는 reducer 금지를 선언하지만, step 출력이 어떤 경계에서 history append로 물질화되는지 계약이 없고, §7.1도 D1 보존을 검증대상으로 남긴다. B20 회피가 주장이지 증명은 아니다. `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:118-130` `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:208` `projects/naia-agent/.agents/progress/ref-adoption-matrix.md:70-72` `projects/naia-agent/docs/agent-loop-design.md:17-27`
M2: PASS — builder layer의 emit 지점, ErrorEvent shape, audit, regression gate가 A.5/A.11에 맞게 명시됐다. `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:137-152` `.agents/progress/naia-4repo-migration-plan.md:183-185` `.agents/progress/naia-4repo-migration-plan.md:283-289`
M3: PASS — 공개 4-repo canonical과 business license ownership을 분리해 A.11/A.6 충돌을 해소했다. `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:54-67` `.agents/progress/naia-4repo-migration-plan.md:222` `.agents/progress/naia-4repo-migration-plan.md:287-288`
M4: PASS — governance를 manifest 밖 operate layer로 이동시켜 portability와 A.11 계약 불변을 동시에 유지한다. `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:92-108` `projects/naia-business-adk/README.md:7-18`
m1: FAIL — orchestration은 뒤로 미뤘지만 MVP의 축인 SB-1/SB-2가 여전히 “manifest는 계약이 아님”, “RetrievalCapable이 맞다”라는 미검증 가정 위에 서 있다. `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:176-194` `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:208-210`

[CRITICAL]
F08 직접 위배 지속 — OPEN P0 실측 전에 R1 slice 계획을 작성했다. `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:156-194` `projects/naia-agent/.agents/context/agents-rules.json:69-72`

[MAJOR]
Manifest SoT 누락 — “naia-adk docs”라고만 하고 canonical schema 위치/호환 규칙을 지정하지 않아, workspace 포맷 소유권이 문서 수준에서 고정되지 않는다. `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:80` `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:180`
RAG 책임 중복 — 기존 baseline은 `MemoryProvider.recall()`로 turn-start retrieval을 이미 정의하는데, v2는 별도 `RetrievalCapable`을 추가하면서 두 경로의 책임 분할을 정의하지 않았다. `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:83` `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:185-187` `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:209` `projects/naia-agent/docs/agent-loop-design.md:78-86` `.agents/progress/naia-4repo-migration-plan.md:179-180`
Loader 소유권 모순 — §2는 loader를 `naia-os / naia-business-adk` host-side라고 못박지만, SB-1의 실행면은 `pnpm exec naia-agent --service`다. host가 누구인지 설계 내부에서 일치하지 않는다. `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:81` `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:180-184` `.agents/progress/naia-4repo-migration-plan.md:174`

종합 1문단: 개발 착수 불가. F08 우회가 아직 남아 있어 baseline gate를 통과하지 못했고, C1/M1도 각각 “manifest가 제4 계약이 아님”, “§4가 D1/B20을 보존한다”를 설계 문서 스스로 가정/검증대상으로 남겨 strict 판정에서 닫히지 않았다. 최소한 P0 실측 선행, manifest SoT 고정, RetrievalCapable와 MemoryProvider 경계 확정이 먼저다.
tokens used
68,167
VERDICT: ISSUES_FOUND

[C1~m1 해소]
C1: FAIL — §2는 manifest를 workspace 포맷으로 밀어 넣지만, §7.3에서 그 주장을 아직 “가정”으로 남겨두고 있고 SB-1은 이를 `naia-agent --service`가 소비하는 버전드 스키마로 전제한다. strict 기준에선 “제4 계약 아님”이 입증되지 않았다. `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:80-84` `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:180-184` `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:210` `.agents/progress/naia-4repo-migration-plan.md:209` `.agents/progress/naia-4repo-migration-plan.md:287-288`
C2: FAIL — F08은 OPEN P0가 1건이라도 있으면 R1 plan 작성 자체를 차단하는데, v2는 실제 P0 실측을 Phase0로 미루면서도 이미 Phase1 SB-1~4를 상세 계획으로 써버렸다. gate를 “명문화”했을 뿐 우회를 멈추지 못했다. `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:156-194` `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:212` `projects/naia-agent/.agents/context/agents-rules.json:69-72`
M1: FAIL — §4는 reducer 금지를 선언하지만, step 출력이 어떤 경계에서 history append로 물질화되는지 계약이 없고, §7.1도 D1 보존을 검증대상으로 남긴다. B20 회피가 주장이지 증명은 아니다. `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:118-130` `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:208` `projects/naia-agent/.agents/progress/ref-adoption-matrix.md:70-72` `projects/naia-agent/docs/agent-loop-design.md:17-27`
M2: PASS — builder layer의 emit 지점, ErrorEvent shape, audit, regression gate가 A.5/A.11에 맞게 명시됐다. `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:137-152` `.agents/progress/naia-4repo-migration-plan.md:183-185` `.agents/progress/naia-4repo-migration-plan.md:283-289`
M3: PASS — 공개 4-repo canonical과 business license ownership을 분리해 A.11/A.6 충돌을 해소했다. `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:54-67` `.agents/progress/naia-4repo-migration-plan.md:222` `.agents/progress/naia-4repo-migration-plan.md:287-288`
M4: PASS — governance를 manifest 밖 operate layer로 이동시켜 portability와 A.11 계약 불변을 동시에 유지한다. `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:92-108` `projects/naia-business-adk/README.md:7-18`
m1: FAIL — orchestration은 뒤로 미뤘지만 MVP의 축인 SB-1/SB-2가 여전히 “manifest는 계약이 아님”, “RetrievalCapable이 맞다”라는 미검증 가정 위에 서 있다. `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:176-194` `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:208-210`

[CRITICAL]
F08 직접 위배 지속 — OPEN P0 실측 전에 R1 slice 계획을 작성했다. `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:156-194` `projects/naia-agent/.agents/context/agents-rules.json:69-72`

[MAJOR]
Manifest SoT 누락 — “naia-adk docs”라고만 하고 canonical schema 위치/호환 규칙을 지정하지 않아, workspace 포맷 소유권이 문서 수준에서 고정되지 않는다. `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:80` `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:180`
RAG 책임 중복 — 기존 baseline은 `MemoryProvider.recall()`로 turn-start retrieval을 이미 정의하는데, v2는 별도 `RetrievalCapable`을 추가하면서 두 경로의 책임 분할을 정의하지 않았다. `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:83` `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:185-187` `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:209` `projects/naia-agent/docs/agent-loop-design.md:78-86` `.agents/progress/naia-4repo-migration-plan.md:179-180`
Loader 소유권 모순 — §2는 loader를 `naia-os / naia-business-adk` host-side라고 못박지만, SB-1의 실행면은 `pnpm exec naia-agent --service`다. host가 누구인지 설계 내부에서 일치하지 않는다. `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:81` `projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:180-184` `.agents/progress/naia-4repo-migration-plan.md:174`

종합 1문단: 개발 착수 불가. F08 우회가 아직 남아 있어 baseline gate를 통과하지 못했고, C1/M1도 각각 “manifest가 제4 계약이 아님”, “§4가 D1/B20을 보존한다”를 설계 문서 스스로 가정/검증대상으로 남겨 strict 판정에서 닫히지 않았다. 최소한 P0 실측 선행, manifest SoT 고정, RetrievalCapable와 MemoryProvider 경계 확정이 먼저다.
