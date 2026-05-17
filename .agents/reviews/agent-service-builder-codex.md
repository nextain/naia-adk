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
session id: 019e335b-e5d2-7410-9ee0-f4eadbb16514
--------
user
# 3회전 크로스리뷰 — Agent Service Builder 설계 v3

당신은 Naia 4-repo 아키텍처 리뷰어. v3 **판정**. 칭찬·요약 금지. 한국어.

## 라운드 이력
- v1: codex+gemini ISSUES_FOUND (CRITICAL 2 / MAJOR 4 / 누락 2)
- v2: M2/M3/M4 양쪽 PASS. codex strict C1/C2/M1/m1 FAIL(="가정으로 표현"). gemini C1~m1 全 PASS. **공통 신규결함 = RAG RetrievalCapable vs MemoryProvider.recall 중복**.
- v3 surgical 교정 (변경이력·§7 참조):
  - RAG: RetrievalCapable 신설 **폐기** → 기존 `MemoryProvider.recall()` 흡수 (manifest `rag.sources` 선언, alpha-memory source-aware)
  - loader: naia-os/business host-side → **naia-agent CLI(=host, A.4 'CLI소유=naia-agent' + direction 'host=CLI')** 로 일관, SB-1 `naia-agent --service`=CLI-host(모순 제거)
  - manifest SoT: "naia-adk docs" → **`naia-adk/docs/service-manifest-schema.md` + naia-adk semver + 호환표**, "비-계약" 가정→단정
  - orchestration: step→history = **기존 D6 turn lifecycle 재사용**(독립 Agent.sendStream 직렬, 신규 물질화 경계 0)
  - F08/F01: §6 G0-1·G0-5 = **실측 완료**(#3·4·5·6 CLOSED·OPEN P0 0건·bin/naia-agent.ts 실존, 사실 명기)

## 검토 대상
- v3: `/var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md`

## baseline (위배=critical)
- Part A: `/var/home/luke/alpha-adk/.agents/progress/naia-4repo-migration-plan.md` (A.1~A.13, F07)
- 매트릭스: `/var/home/luke/alpha-adk/projects/naia-agent/.agents/progress/ref-adoption-matrix.md` (B19/B20/A.5 capability 거버넌스/D44)
- F-rules: `/var/home/luke/alpha-adk/projects/naia-agent/.agents/context/agents-rules.json` (F08 = OPEN P0 시 차단)
- agent-loop D1~D8 / MemoryProvider.recall: `/var/home/luke/alpha-adk/projects/naia-agent/docs/agent-loop-design.md`

## 판정 (각 PASS/FAIL + file:line 근거)
1. **C1 (manifest 제4계약)** — v3 §2가 manifest=naia-adk 데이터파일(비-계약 **단정**) + SoT 경로 고정 + Part A 3계약 불변. strict 로 "제4계약 아님" 입증됐나? 아직 가정 잔존?
2. **C2 (F08 우회)** — v3 §6 G0-1 = P0 실측완료(#3·4·5·6 CLOSED, OPEN P0 0) 사실 명기. F08 통과가 사실로 닫혔나? slice 작성이 F08 비위배인가?
3. **M1 (B20/D1)** — v3 §4-3 = 각 step 독립 Agent.sendStream + D6 turn lifecycle 재사용(신규 경계 0). reducer 부재·D1 보존이 계약으로 닫혔나? gemini v2 누락("step간 history 오염")이 해소됐나?
4. **RAG 중복 (v2 공통 신규결함)** — v3 가 RetrievalCapable 폐기, recall 흡수. MemoryProvider.recall 과 책임 중복이 *제거*됐나? recall 시그니처로 rag.sources 전달이 agent-loop-design recall 계약과 정합하나?
5. **loader 소유권 모순 (codex v2 MAJOR)** — naia-agent CLI=host 일관화로 §2/SB-1 모순 제거됐나? A.4(CLI소유=naia-agent) 정합?
6. **manifest SoT (codex v2 MAJOR)** — 경로/semver/호환규칙 고정으로 소유권 닫혔나?
7. **신규 결함** — v3 surgical 교정이 만든 새 모순/누락 (특히 recall 에 rag.sources 끼우는 게 D6/MemoryProvider 계약 위배 아닌지)

## 출력
```
VERDICT: CLEAN | ISSUES_FOUND
[C1·C2·M1·RAG·loader·manifestSoT 해소]: PASS/FAIL 각 1줄
[CRITICAL]/[MAJOR]/[MINOR]/[누락] (신규/미해소만)
종합: 개발 착수 가능? (가능/조건부/불가 + 핵심 1개)
```
critical=Part A/매트릭스/F-rule 정면위배만. "문서가 단정 안 했다"는 표현 트집이 아니라 *실질 위배*만 critical. Part B/C 보류는 미해결로 잡지 말 것.

[profile: ARCHITECT/MATRIX. 파일은 Read 도구로 직접 읽어라. 최종 출력만 간결히: VERDICT / 6항목 PASS-FAIL 각1줄 / CRITICAL·MAJOR(있으면) / 종합 1줄.]
codex
요청한 v3 판정을 위해 먼저 필수 컨텍스트와 기준 문서를 직접 읽고, 그 다음 검토 대상 문서의 해당 섹션과 라인 근거를 대조하겠습니다.
exec
/bin/bash -lc "sed -n '1,220p' .agents/context/agents-rules.json" in /var/home/luke/alpha-adk
exec
/bin/bash -lc "sed -n '1,220p' .agents/context/ai-work-index.yaml" in /var/home/luke/alpha-adk
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

codex
기준 문서와 검토 대상 본문을 라인 번호 포함으로 읽어 쟁점별로 직접 대조하겠습니다.
exec
/bin/bash -lc "nl -ba .agents/progress/naia-4repo-migration-plan.md | sed -n '1,260p'" in /var/home/luke/alpha-adk
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

exec
/bin/bash -lc "nl -ba projects/naia-agent/.agents/progress/ref-adoption-matrix.md | sed -n '1,260p'" in /var/home/luke/alpha-adk
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
   146	| **D50** | **Service manifest = naia-adk workspace 데이터 파일 포맷 (비-계약)** — 에이전트 서비스(persona+skill+rag.sources+memory+llm) 선언적 묶음. **Part A 3-계약 불변** (types/protocol/skill-spec 외 신규 계약 0). SoT = `naia-adk/docs/service-manifest-schema.md` + naia-adk semver. loader = naia-agent CLI(=host, A.4). RAG = 기존 `MemoryProvider.recall()` 흡수(신규 capability 0 — RetrievalCapable 신설 폐기, codex/gemini v2 공통 지적). | R6 — agent-service-builder 우산(naia-adk `.agents/progress/agent-service-builder-architecture.md` v3, gemini 3R cross-review CLEAN) | **P0** | M | SB-1(manifest loader) / SB-2(rag via recall) — #31 우산 sub-issue |
   147	| **D51** | **Orchestration = 직렬 step (기존 `Agent.sendStream()` 연결)** — B20(LangGraph StateGraph reducer) 회피를 *구체 계약*으로: 각 step 독립 sendStream, history/순서/중복 = 기존 D6 turn lifecycle 재사용(신규 물질화 경계 0), reducer/공유상태 채널 없음, D1 stream-first 보존. 병렬/분기는 실측 시에만 agent-types additive(A.5). | R6 — 同 우산. B19/B20 거부 정합 (LangChain core/StateGraph 미도입) | P1 | M | SB-4(조건부) — #31 우산 sub-issue |
   148	
   149	---
   150	
   151	## E. Drift 위험 — 적혔지만 코드/테스트로 pin 안 됨
   152	
   153	| # | 위험 항목 | 위치 | 현재 상태 |
   154	|---|---|---|---|
   155	| E01 | gateway 내부 circular 2건 | naia-os/agent/gateway/ (`client.ts ↔ tool-bridge.ts`, `tool-bridge.ts ↔ sessions-spawn.ts`) | known debt, X8(messengers 추출) 시 해결 |
   156	| E02 | 테스트 커버리지 전면 부족 | Phase 1 + X1 | smoke/self-review only. issue #1 트래킹. PASS 정의 v2 상향 |
   157	| E03 | VRM lip-sync viseme vocabulary 미정 | `VoiceEvent.visemeId` | ARKit/Oculus/custom 미결정. project-airi의 wLipSync(D03) 후보로 해소 가능 |
   158	| E04 | Agent-level smoke test 미존재 | scripts/smoke-anthropic.ts | AnthropicClient 직접만 테스트. Agent 레벨(InMemory + Mock) 부재 |
   159	| E05 | Memory stubs 구현 | alpha-memory `contentTokens`/`jaccardSimilarity`/`mergeRelatedFacts` | stub 상태, dedup branch dead code. silent data-loss 위험 |
   160	| E06 | X1 wiring + factory env-gate 검증 | naia-os adapter | `yield { finish }` closure 미검증, factory 수동 1회만 확인 |
   161	| E07 | Memory 양방향성 시점/전환 규약 | claude-code 분석 결론 부재 | claude-code "single-directional" 인식만, 우리 정책 명시 미흡 |
   162	| E08 | provider DI 방식 (alpha-memory adapter) | memory-provider-audit §4 | wrapper class vs direct peerDep 미결정 |
   163	
   164	---
   165	
   166	## F. 결정 누락 — 분석은 있는데 정식 결정문 없음
   167	
   168	| # | 항목 | 분석 출처 | 누락 사유 |
   169	|---|---|---|---|
   170	| F01 | claude-code 15-agent 분석 (`11-ref-cc-analysis.json`) "Naia OS 도입 계획" | 보고서 작성 완료 | 채택/거부/이연 정식 매핑 부재 — **본 매트릭스 §A·D에서 cleanroom 비교 후 부분 해소** |
   171	| F02 | Dashboard (E1) | 4-repo plan v7 | Part B 미결정 — K3 실행 시점 |
   172	| F03 | `@naia-agent/cli` 패키지 신설 (E2) | 4-repo plan v7 | Part B 미결정 |
   173	| F04 | jikime-adk Dual Orchestrator 채택 깊이 | jikime-adk-review | Phase 2 이후 specialized agent 필요성 검증 후 |
   174	| **F05** | cleanroom 폐기 대응 plan (archived 2025-03, 974 stars) — D01/D02 OWASP/RFC 재근거화 | cleanroom-cc deep-audit + GitHub 페이지 신호 | **F09 forbidden_action으로 부분 해소**. Slice 2 진입 전 OWASP A03 + RFC 3986 출처 docs 신설 |
   175	
   176	---
   177	
   178	## G. ref별 채택 점수표 (한눈 요약)
   179	
   180	| ref | 우리에게 채택 가치 | 핵심 차용 | 거부 사유 |
   181	|---|---|---|---|
   182	| **opencode** | ★★★★★ | tool context, Logger tag/time, compaction 동적, DI 단순화 (4건) | SQL, Effect Layer 의존, Go+TUI |
   183	| **claude-code (private + cleanroom)** | ★★★★★ | DANGEROUS_COMMANDS, Path normalize, AuthMgr 이벤트, Cmd registry, Error enum (5건) | TUI, SaaS 특화 명령, Sentry telemetry |
   184	| **project-airi** | ★★★★ | wLipSync viseme, Narrative stripping, Emotion blending (3건) | monorepo, Hono backend, Stripe |
   185	| **openclaw / nanoclaw v2** | ★★★ | OpenClaw→MCP 4단계 (이미 완료), engage_mode + fan-out, OneCLI Vault | 999K LOC, gateway server overhead |
   186	| **cline** | ★★ | Memory 모니터링, Hook escape, Proto enum 매핑 | IDE plugin 결합, OTel/PostHog |
   187	| **jikime-adk** | ★★ | Dual Orchestrator 개념, 세분화 Hook | Go 의존, Webchat UI, 마이그레이션 특화 |
   188	| **moltbot** | ★ | ChannelPlugin adapter, Manifest lazy load | 999K LOC, gateway, ecosystem 강결합 |
   189	| **jikime-mem** | ★ | (직접 차용 없음, 검토만) | 모놀리식, Claude Code 플러그인 강결합, Chroma 고정 |
   190	| **mastra** | ★★★★★ | Eval scorers (D14), Memory tiers (D15), Tool context (D11), 3중 방어 (D13), provider fallback (D17) | monorepo (B17), Studio web IDE (B18), DynamicArgument 복잡도 |
   191	| **vercel-ai-sdk** | ★★★★ | ToolLoopAgent 시그니처 검증 (A01 보강), Tool context schema (D11), onStepFinish (D12), prompt cache (D16) | 50 provider 직접 의존 (B21), React hooks 결합 |
   192	| **langgraphjs** | ★★★ | Checkpoint 패턴 (C05 후보), interrupt/resume (C12 인접), Send sub-agent (C02 인접) | LangChain core 의존 (B19), StateGraph reducer (B20), Python parity 우선 |
   193	
   194	---
   195	
   196	## H. 매트릭스 사용 가이드
   197	
   198	- **A 항목**은 변경 금지 — 이미 결정 + 코드. 변경 시 별도 ADR.
   199	- **B 항목**은 재검토 시 `B##` 인용. 새로 거부 추가 시 §B에 append.
   200	- **C 항목**은 트리거 조건 충족 시 `C##` → `D##` 또는 `A##`로 승격.
   201	- **D 항목**은 R0.7 sub-issue로 변환됨. P0=즉시, P1=다음 슬라이스, P2=백로그.
   202	- **E 항목**은 issue #1(test coverage audit) 또는 별도 issue로 트래킹.
   203	- **F 항목**은 R1 plan 작성 시 결정 강제 (Part B로 이연 또는 R0 추가 결정).
   204	
   205	---
   206	
   207	## 참고 — ref별 review 파일 경로
   208	
   209	- `refs/cline-review.md` (commit 901d1b5c9, 2026-04-25)
   210	- `refs/jikime-adk-review.md` (commit b9f4fb98, 1.8.1)
   211	- `refs/jikime-mem-review.md` (commit 0e3f6920)
   212	- `refs/moltbot-review.md` (commit f29e15c05d)
   213	- `refs/openclaw-review.md` (commit 8d85222, prior analysis: `alpha-adk/.agents/progress/issue-186-openclaw-analysis.md`)
   214	- `refs/opencode-review.md` (commit 91468fe45)
   215	- `refs/project-airi-review.md` (commit 2b125d5f, v0.9.0+94)
   216	- `refs/cc-review.md` (private nextain/ref-cc 분석 docs + public ghuntley/claude-code-source-code-deobfuscation cleanroom)
   217	- `refs/cc-cleanroom-security-audit-2026-04-25.md` (cleanroom 보안 audit, F1~F4 미완성 stub 발견)
   218	- `refs/cc-cleanroom-deep-audit-2026-04-25.md` (paranoid bait audit, F5~F12 LLM 환각/silent fail + 8 파일 블랙리스트)
   219	- `refs/mastra-review.md` (commit b97a0594, ★★★★★ Eval/Memory tiers/Tool context)
   220	- `refs/langgraphjs-review.md` (commit 7f3320cd, ★★★ Checkpoint/Sub-agent/Interrupt)
   221	- `refs/vercel-ai-sdk-review.md` (commit 10432742, ★★★★ ToolLoopAgent/onStepFinish)
   222	
   223	---
   224	
   225	## I. v2 변경 이력 (2026-04-25 R1 cross-review 적용)
   226	
   227	**3-perspective cross-review 결과** (architect + reference-driven + paranoid auditor):
   228	
   229	- **§D 신규 9건** (D09~D17) — workspace sentinel / Tool 메타 / Tool context / onStepFinish / 3중 방어 / Eval scorers / Memory tiers / Prompt cache(C04 격상) / Provider fallback
   230	- **§B 신규 6건** (B17~B22) — Mastra monorepo / Mastra Studio / LangChain core / StateGraph reducer / Vercel multi-provider / cleanroom 라인 복붙
   231	- **§C04 → §D16 격상** (Vercel 영향)
   232	- **§F05 신규** — cleanroom 폐기 대응 plan
   233	- **§G 점수표** — Mastra/LangGraph/Vercel 3 ref 추가
   234	
   235	채택 옵션 A (light, 가볍게 directive): D09/D10 P0만 즉시 ingrain (Slice 1b), 나머지 P1/P2는 슬라이스 진행 시 자연 §A 승격. R3+ slice 신설은 outline만 (정식 신설은 R1 종료 후).
   236	
   237	---
   238	
   239	## J. R4 변경 이력 (2026-04-26 Hybrid Wrapper Pivot)
   240	
   241	**trigger**: 사용자 본질 고민 — "바닥부터 만드는 게 맞나" + "팀장 역할이 피곤" + "보고 ≠ 실제로 큰 낭패" + "알파와 단일 대화창에서 연속적으로 일을 시키고 싶다"
   242	
   243	**변경 요약**:
   244	
   245	- **§D 신규 7건** (D18~D24) — Hybrid wrapper / 단일 대화 + 정직 보고 / NaiaStreamChunk multi-modal / Real-time interrupt / vllm-omni adapter / Vercel AI SDK 보류 / Sub-agent supervisor
   246	- **§B 신규 1건** (B23) — naia-agent 풀 자체 build 거부 (1인 70k+ LOC 무리)
   247	- **§A 변경 0건** — R0 lock 보존 (interface contract / D1~D8 / Voice 3-layer 등 그대로)
   248	- **신규 docs 4건** — `docs/{vision-statement, architecture-hybrid, stream-protocol, adapter-contract}.md`
   249	- **R4 progress** — `.agents/progress/r4-hybrid-wrapper-2026-04-26.md`
   250	- **master issue** — nextain/naia-agent#2 댓글 R4 announce
   251	
   252	**vision lock**:
   253	> "Real-time interruptible multi-agent supervisor with multi-modal stream + 정직 보고"
   254	>
   255	> 3차원 차별화 (다른 framework에 거의 없음):
   256	> 1. Multi-modal stream (audio_delta 1급)
   257	> 2. Sub-agent supervisor (ACP/SDK + audit + interrupt)
   258	> 3. 단일 대화 + 정직 보고 (verification + diff + 수치)
   259	
   260	**Phase outline**:

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
/bin/bash -lc "nl -ba projects/naia-agent/docs/agent-loop-design.md | sed -n '1,320p'" in /var/home/luke/alpha-adk
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
/bin/bash -lc "nl -ba projects/naia-adk/.agents/progress/agent-service-builder-architecture.md | sed -n '1,320p'" in /var/home/luke/alpha-adk
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
    80	| **service manifest** | naia-adk **workspace 데이터 파일 포맷** (A.6 "Workspace 파일 구조 = naia-adk"). **public 런타임 계약 아님 — 단정(가정 아님). Part A 3-계약 불변**. 스키마 SoT = `naia-adk/docs/service-manifest-schema.md`, 버전 = naia-adk semver, 호환규칙 = 해당 docs §호환표 |
    81	| **manifest loader** | **naia-agent CLI** (= host 역할. A.4 "CLI 소유 = naia-agent" + direction-2026 "host = CLI 자체"). naia-os / naia-business-adk 는 embed 시 *각자* host loader 보유. **모두** manifest → 기존 HostContext(llm/memory/tools/persona-as-systemprompt) 조립. naia-agent 런타임 계약 무변경. SB-1 의 `naia-agent --service` = CLI-host 경로(모순 아님) |
    82	| **persona / system prompt** | manifest 필드 → host 가 Agent 의 기존 system message 로 주입. 신규 계약 0 |
    83	| **RAG** | **기존 `MemoryProvider.recall()` 경로로 흡수** — manifest `rag.sources` 선언 → recall 구현체(alpha-memory)가 source-aware retrieval 수행. **신규 capability/계약 0** (RetrievalCapable 신설 폐기 — codex/gemini 공통 지적: recall 과 중복). recall 시그니처로 부족이 *실증*되면 그때만 agent-types additive(A.5 거버넌스); 1차는 recall 재사용 |
    84	| **orchestration** | §4 — agent-loop D1~D8(F06 불변) 위 **직렬 step = 기존 `Agent.sendStream()` 연결**. 1차 신규 계약 0. 병렬/분기가 실측 필요 시에만 agent-types additive(A.5) |
    85	| **LLM backend** | D44 Vercel AI SDK adapter (기존 §A 채택). qwen3.6-27b-dense = `@ai-sdk/openai-compatible`, minicpm = lab-proxy-live |
    86	
    87	→ **결과**: Part A 계약 3개 불변, 의존방향(A.3) 불변, capability 거버넌스(A.5)
    88	경유 = "제4 계약" 없음. **신규 계약 0** (RAG=recall 재사용, manifest=데이터 파일).
    89	매트릭스 §D 항목은 `manifest workspace 포맷(비-계약)` · `orchestration §4 계약`
    90	2건만 (RAG 제외 — recall 흡수로 §D 불요).
    91	
    92	---
    93	
    94	## 3. 개인 / 비즈니스 경계 (M4 교정 — governance = operate layer)
    95	
    96	**원칙**: manifest 는 *서비스 정의*만 담는다(portable/reproducible). 거버넌스는
    97	manifest 에 넣지 않는다(스키마 확장 불필요 → A.11 계약 미수정 보존). 거버넌스는
    98	**operate layer = host 가 manifest 실행 시 주입·강제**.
    99	
   100	| 관심사 | 위치 / enforce 주체 |
   101	|---|---|
   102	| service 정의(persona/skill/rag/memory/llm) | manifest (naia-adk workspace 포맷) |
   103	| 개인 실행 | naia-os host. 단일 사용자 T0~T3 self. 승인=ApprovalBroker(기존) |
   104	| RBAC(author/reviewer/approver/releaser/auditor) | **naia-business-adk host** 가 manifest 실행 래핑 시 강제. manifest 미확장 |
   105	| tenant boundary / approval chain / retention | naia-business-adk **operate layer 정책 파일**(manifest 와 별도, naia-business-adk 소유) |
   106	| License 검증 | naia-business-adk (A.6 원문). 개인 layer 부재 |
   107	| audit / SDLC artifact | shell audit(A.6, 기존) + naia-business-adk SDLC 정책 |
   108	
   109	**개인 자족성**: 외부 데모 = 개인 layer(naia-os host + manifest + 기존 계약)만으로
   110	end-to-end 동작. 비즈니스 거버넌스 코드 경로 부재(존재 안 함, bypass 아님).
   111	
   112	---
   113	
   114	## 4. Orchestration — D1 stream-first 보존 계약 (M1/C-B20 교정)
   115	
   116	B20 거부의 본질 = **reducer 중심 상태모델** (LangGraph StateGraph). D1/D8 =
   117	`AsyncGenerator<AgentStreamEvent>` stream-first + history append-only.
   118	v2 orchestration 은 다음을 **계약으로 명시**(이름만 X):
   119	
   120	1. **step = `AsyncGenerator<AgentStreamEvent>`** — graph 노드는 자체 reducer
   121	   상태를 갖지 않는다. 각 step 은 Agent.sendStream 과 동일 이벤트 타입을 yield.
   122	2. **합성 = `yield*` 위임** — 상위 orchestrator 가 step 의 stream 을 `yield*`
   123	   로 그대로 위임 전달. 별도 상태 채널/reducer 없음. chunk 실시간 보존.
   124	3. **각 step = 독립 `Agent.sendStream()` 1회 호출** — history append·순서·
   125	   중복방지는 **기존 D6 turn lifecycle 이 담당**(신규 물질화 경계 0). step 간
   126	   전달 = 이전 step assistantText → 다음 step input(직렬). reducer/공유 상태
   127	   채널 없음. (gemini 누락 지적 "step 간 history 오염" = turn 단위 보장 재사용으로 해소)
   128	4. **concurrent branch** — 1차 범위에서 **직렬 step 만**(병렬 분기 제외, karpathy
   129	   Simplicity). 병렬 interleave 는 후속 capability(별 §D). 1차에 reducer 도입 안 함.
   130	5. **cancellation/backpressure** — 기존 Agent abort signal(D 결정) 재사용.
   131	   step executor 는 signal 전파만, 자체 취소 모델 신설 X.
   132	6. **위치** — host-side(manifest 의 orchestration 선언을 host 가 해석해 step
   133	   순서로 Agent 호출). 런타임 신규 계약 0. 병렬·조건분기가 실측 필요해지면
   134	   그때 agent-types capability additive(§D + sub-issue).
   135	
   136	→ B20 회피를 *구체 계약(1~6)*으로 고정. "직렬 step + yield* 위임 + append-only"
   137	= reducer 부재 증명. 크로스리뷰가 1~6 의 D1 보존을 재검증.
   138	
   139	---
   140	
   141	## 5. 교차 관심사 — builder layer 적용 (M2/누락 교정)
   142	
   143	Part A.5/A.11 의무를 builder 요소에 명시:
   144	
   145	- **Event emit 지점**(A.5 "주요 상태 전이"): `manifest.load.started/ended`,
   146	  `manifest.validate.failed`, `retrieval.started/hit/empty`,
   147	  `orchestration.step.started/ended`, `service.build.ended`. 전부 기존
   148	  `Logger`/`Event` 계약으로 emit(신규 observability 계약 X).
   149	- **ErrorEvent shape**(A.11): manifest parse 실패 = `error_code:
   150	  MANIFEST_INVALID`, `severity: error`, `retryable: false`. retrieval 실패 =
   151	  `RETRIEVAL_FAILED`, `severity: warn`, `retryable: true`. orchestration step
   152	  실패 = step 의 ErrorEvent 를 `yield*` 그대로 경계 밖 전파(기존 계약).
   153	- **audit / tier**(A.6): T2+ 행위(외부 RAG fetch, tool exec)는 shell audit
   154	  필수 기록 — 기존 shell audit 소유 그대로, builder 가 우회 안 함.
   155	- **regression gate**(A.11): baseline = #31 평가 하니스 수치(컨텍스트 적중·
   156	  한국어·실시간·안정). 공개 전 유의미 regression = release block(기존 원칙).
   157	
   158	---
   159	
   160	## 6. 구현 계획 — gate-닫힘 조건부 (C2 교정)
   161	
   162	### Phase 0 — Gate 폐쇄 (이것이 deliverable. 코드 0줄. 미완 시 이후 전부 차단)
   163	
   164	F08 = "OPEN P0 sub-issue 1건이라도 있으면 R1 plan 차단". 실측·게이트:
   165	
   166	- [x] **G0-1 F08 실측 완료 (2026-05-16)** — `gh issue view 3·4·5·6 -R nextain/naia-agent`
   167	      = #3·#4·#5·#6 [R0/P0] **전부 CLOSED**, OPEN P0 = **0건** (OPEN #7 은 R0/**P1**,
   168	      F08 비대상). → **F08 통과**. (codex C2 "P0 실측 선행" 충족 — 가정 아닌 사실)
   169	- [x] **G0-5 F01 실측 완료** — `bin/naia-agent.ts` 실존(16,205 B). #6(F01) CLOSED.
   170	      → **F01 해제 확인** (추정 아닌 사실).
   171	- [ ] **G0-2** 본 설계 크로스리뷰 2x clean (different-profile)
   172	- [ ] **G0-3** 사용자 합의·보고 (사용자 명시 게이트)
   173	- [ ] **G0-4** naia-agent ref-adoption-matrix **§D 신규 항목 PR** + sub-issue(#2 하위):
   174	      `D-SB1 manifest workspace 포맷(naia-adk, 비-계약 단정)` /
   175	      `D-SB2 orchestration §4 계약(직렬 step=Agent.sendStream, B20 회피)`.
   176	      **RAG 는 §D 불요**(recall 흡수). #31 = 본 우산 sub-issue 로 재프레이밍.
   177	
   178	**G0-1·G0-5 = 충족(실측). G0-2·G0-3·G0-4 미충족 = Phase 1 진입 금지.**
   179	(F08 은 통과했으나 slice 착수는 크로스리뷰 clean + 사용자 합의 + §D PR 후)
   180	
   181	### Phase 1 — qwen3.6-27b-dense, "한 서비스가 실제 돈다" 최소증명 (karpathy)
   182	
   183	> v1 의 "추상화 선행" 교정: 6개를 한 번에 세우지 않는다. 최소 동작 먼저.
   184	
   185	- **SB-1 manifest loader 최소** — `naia-adk/docs/service-manifest-schema.md`
   186	  스키마 정의 + naia-agent CLI-host loader 가 manifest → 기존 HostContext
   187	  (llm=qwen via D44 / memory=alpha-memory / persona=system msg) 조립.
   188	  RAG·orchestration 없음.
   189	  S01 `pnpm exec naia-agent --service <manifest>` · S02 unit(스키마 검증) ·
   190	  S03 fixture-replay(qwen) · S04 CHANGELOG · §D-SB1(manifest 포맷) 인용
   191	- **SB-2 RAG via recall** — manifest `rag.sources` → 기존 `MemoryProvider.recall()`
   192	  (alpha-memory 가 source-aware retrieval). **신규 capability/계약 0**.
   193	  recall 어댑터(host 주입) + turn-전 context 조립.
   194	  S01 `--rag <source>` · S02 unit(source→recall 매핑) · S03 실 alpha-memory · S04 · (§D 불요)
   195	- **SB-3 #31 평가 결합** — manifest `eval.fixtures` → #31 하니스로 e2e 품질
   196	  측정(fixture-replay 우선, G15). qwen backend e2e.
   197	  S01 `--eval` · S02 unit · S03 fixture e2e(persona+RAG+memory+qwen) · S04 · #31
   198	- **SB-4 orchestration §4(직렬 step only)** — 필요성이 SB-1~3 에서 실증된 경우만.
   199	  아니면 백로그. (karpathy: 불필요 추상화 회피)
   200	
   201	**외부 데모 MVP = SB-1~SB-3** (manifest→persona+RAG+memory+qwen3.6-27b e2e+평가수치).
   202	
   203	### Phase 2 — minicpm backend
   204	- SB-5 minicpm /v1/realtime connector (v2 계약 rev2.1, lab-proxy-live).
   205	  ko-serve 트랙 PAUSED 해제 의존(gemini 누락 지적 반영 — Phase2 진입 = #31/ko-serve gate).
   206	
   207	### Phase 3 — 비즈니스 layer (operate)
   208	- SB-6 naia-business-adk operate layer 스캐폴드 — RBAC/SDLC/retention **정책
   209	  파일**(manifest 미확장, host 주입). License 검증(A.6 원문).
   210	
   211	---
   212	
   213	## 7. 결정 / 미해결
   214	
   215	1. **(결정)** §4 = 각 step 독립 `Agent.sendStream()` 직렬 연결, history/순서 =
   216	   기존 D6 turn lifecycle 재사용 → reducer 부재·D1 보존 (가정 아닌 설계 결정).
   217	2. **(결정)** RAG = 기존 `MemoryProvider.recall()` 흡수, RetrievalCapable 신설
   218	   폐기 → MemoryProvider 중복 제거 (codex/gemini 공통 지적 반영, 결정).
   219	3. **(결정)** manifest = naia-adk workspace **데이터 파일**(A.6), public 계약 아님,
   220	   Part A 3-계약 불변 → "제4 계약" 회피 (단정).
   221	4. **(결정)** F08/F01 = §6 G0-1·G0-5 실측 완료(P0 0건·bin 실존) → gate 통과(사실).
   222	5. **(미해결, 사용자)** 외부 데모 시한·"성공" 정의(무엇을 보여드릴지) — 합의 시 확정.
   223	
   224	---
   225	
   226	## 8. 합의 게이트
   227	크로스리뷰 2x clean → 사용자 보고 → **합의 후에만** Phase0 G0 착수. 합의 전 코드 0줄.
   228	
   229	## 변경 이력
   230	- v1 (2026-05-16): 초안. codex+gemini ISSUES_FOUND (CRITICAL 2 / MAJOR 4 / 누락 2).
   231	- v2 (2026-05-16): 전면 재작성. 신규계약0 / gate-닫힘 / orchestration §4 / 교차관심사 / 소유권정합 / governance=operate / MVP 축소.
   232	- v2 재크로스리뷰: codex(C1/C2/M1/m1 FAIL·strict) / gemini(C1~m1 全 PASS). 공통 신규결함 = RAG capability vs recall 중복.
   233	- **v3 (2026-05-16)**: surgical 교정 4건 — RAG=recall 흡수(신규capability 폐기) / loader=naia-agent CLI host 일관 / manifest SoT=naia-adk/docs/service-manifest-schema.md(비-계약 단정) / step→D6 turn 재사용 / F08·F01 실측 사실 명기. v2 골격(M2/M3/M4 PASS) 유지. 재크로스리뷰 대기.

codex
`recall()` 계약과 CLI host 사실관계를 확인하기 위해 관련 타입/실파일도 직접 보겠습니다.
exec
/bin/bash -lc "rg -n \"recall\\(|interface MemoryProvider|type Recall|rag\\.sources|--service|bin/naia-agent\" -S projects/naia-agent -g '"'!**/node_modules/**'"'" in /var/home/luke/alpha-adk
 succeeded in 0ms:
projects/naia-agent/OPENCODE.md:111:`bin/naia-agent` 진입점 미존재 시 다음 금지:
projects/naia-agent/GEMINI.md:111:`bin/naia-agent` 진입점 미존재 시 다음 금지:
projects/naia-agent/CODEX.md:111:`bin/naia-agent` 진입점 미존재 시 다음 금지:
projects/naia-agent/AGENTS.md:100:`bin/naia-agent` 진입점 미존재 시 다음 금지:
projects/naia-agent/CLAUDE.md:111:`bin/naia-agent` 진입점 미존재 시 다음 금지:
projects/naia-agent/package.json:16:    "naia-agent": "tsx bin/naia-agent.ts",
projects/naia-agent/CHANGELOG.md:122:- naia-memory's `provider-types.ts` switching to `import { … } from "@nextain/agent-types"` is the next step (separate naia-memory commit). At that point Slice 3 wire-in (`bin/naia-agent --memory=alpha`) becomes type-clean.
projects/naia-agent/CHANGELOG.md:464:- `bin/naia-agent.ts` — main, detectRealLLM
projects/naia-agent/CHANGELOG.md:486:{"ts":"...","level":"debug","msg":"enter:main","caller":"bin/naia-agent.ts:258","argv":["--enable-all","..."]}
projects/naia-agent/CHANGELOG.md:487:{"ts":"...","level":"debug","msg":"enter:detectRealLLM","caller":"bin/naia-agent.ts:35"}
projects/naia-agent/CHANGELOG.md:517:LOG_LEVEL=warn node dist-bin/naia-agent.js "..."
projects/naia-agent/CHANGELOG.md:536:- `bin/naia-agent.ts` — `--enable-files` + `--enable-all` 플래그
projects/naia-agent/CHANGELOG.md:629:- `bin/naia-agent.ts` — `--enable-bash` 플래그 (opt-in, default off)
projects/naia-agent/CHANGELOG.md:667:[tool ◀] bin/naia-agent.ts
projects/naia-agent/CHANGELOG.md:669:[final] I found the bin entry — bin/naia-agent.ts.
projects/naia-agent/CHANGELOG.md:768:- `bin/naia-agent.ts` — `--env <path>` / `--config <path>` 플래그 + `NAIA_AGENT_ENV` / `NAIA_AGENT_CONFIG` 환경변수 + 자동 검색
projects/naia-agent/CHANGELOG.md:826:- `bin/naia-agent.ts` `detectRealLLM()` — `ANTHROPIC_API_KEY` (+ `ANTHROPIC_BASE_URL` gateway 라우팅) 검출 → AnthropicClient 주입. F11 graceful fallback (SDK load 실패 시 stderr 경고 + mock fallback)
projects/naia-agent/CHANGELOG.md:881:## [Slice 1a] — 2026-04-25 — bin/naia-agent skeleton (mock-only)
projects/naia-agent/CHANGELOG.md:886:- `bin/naia-agent.ts` — REPL/stdin/args 분기 entry (mock LLM)
projects/naia-agent/CHANGELOG.md:889:- `package.json scripts.naia-agent` (`tsx bin/naia-agent.ts`)
projects/naia-agent/CHANGELOG.md:903:- 해소: G01 (bin/naia-agent 진입점) — F08 자동 해제 trigger 충족
projects/naia-agent/docs/llm-config-standard.md:4:**Scope**: naia-agent CLI (`bin/naia-agent.ts`) + embedded host context
projects/naia-agent/docs/vision-statement.md:93:→ Phase 3에서 두 layer 동시 inject 메커니즘 정식화: `TaskSpec.extraSystemPrompt = naia-adk persona base + alpha-memory.recall() result`
projects/naia-agent/docs/vision-statement.md:181:| `MemoryProvider.recall()` | 대화 시작 시 사용자 컨텍스트 가져옴 → extraSystemPrompt | Phase 3 |
projects/naia-agent/docs/vision-statement.md:186:# alpha-adk가 naia-adk에서 페르소나 spec 로드 + alpha-memory.recall() 결과 결합 →
projects/naia-agent/docs/naia-memory-wire.md:20:→ naia-agent는 검색 로직을 가지지 않는다. `provider.recall(opts)` 호출 + 결과를 `extraSystemPrompt`에 주입할 뿐.
projects/naia-agent/docs/naia-memory-wire.md:69:const hits = await provider.recall({
projects/naia-agent/docs/agent-loop-design.md:80:- Turn start: `recall(userText, { topK: 5 })` — injects memory hits into system prompt
projects/naia-agent/docs/memory-provider-audit.md:57:export interface MemoryProvider {
projects/naia-agent/docs/memory-provider-audit.md:59:  recall(query: string, opts?: RecallOpts): Promise<MemoryHit[]>;
projects/naia-agent/docs/memory-provider-audit.md:93:| `recall(query, opts)` | `memorySystem.recall(query, opts)` → map `Episode[]` → `MemoryHit[]` | Episode.strength → hit.score |
projects/naia-agent/docs/log-policy.md:22:- **bin/naia-agent.ts**: `warn` (사용자 노이즈 최소)
projects/naia-agent/docs/architecture-hybrid.md:74:| **`apps/cli/`** (신설) | bin/naia-agent.ts (R3 이미 있음) | 분리 + Conversation/Supervisor 사용 |
projects/naia-agent/examples/hardened-sqlite-host.ts:54:  async recall(query: string, opts?: RecallOpts): Promise<MemoryHit[]> {
projects/naia-agent/examples/hardened-sqlite-host.ts:55:    const result = await this.#sys.recall(query, {
projects/naia-agent/naia-agent.env.example:1:# naia-agent provider config — auto-loaded by bin/naia-agent.ts
projects/naia-agent/bin/naia-agent.ts:3: * bin/naia-agent — R5 entry point.
projects/naia-agent/examples/naia-memory-host.ts:51: *   - recall(): alpha returns `Episode[]`, we map to `MemoryHit[]` and
projects/naia-agent/examples/naia-memory-host.ts:90:  async recall(query: string, opts?: RecallOpts): Promise<MemoryHit[]> {
projects/naia-agent/examples/naia-memory-host.ts:91:    const result = await this.#sys.recall(query, {
projects/naia-agent/examples/naia-memory-host.ts:450:        const hits = await verifyMem.recall("editor", { topK: 3 });
projects/naia-agent/examples/bash-skill-host.ts:37:      blocks: "I found the bin entry — bin/naia-agent.ts.",
projects/naia-agent/packages/cli-app/package.json:20:    "naia-agent": "./bin/naia-agent.mjs"
projects/naia-agent/packages/types/src/memory.ts:78:export interface MemoryProvider {
projects/naia-agent/packages/types/src/memory.ts:80:  recall(query: string, opts?: RecallOpts): Promise<MemoryHit[]>;
projects/naia-agent/packages/runtime/src/mocks/in-memory-memory.ts:30:  async recall(query: string, opts?: RecallOpts): Promise<MemoryHit[]> {
projects/naia-agent/packages/cli-app/src/index.ts:4: * Supervisor + StreamMerger + CLI renderer wiring used by bin/naia-agent.
projects/naia-agent/packages/runtime/src/mocks/compactable-memory.ts:37:  async recall(query: string, opts?: RecallOpts): Promise<MemoryHit[]> {
projects/naia-agent/packages/core/src/agent.ts:325:      return await this.#host.memory.recall(query, { topK: 5 });
projects/naia-agent/packages/cli-app/src/interrupt-manager.ts:5: * Applied by bin/naia-agent (Phase 1's inline SIGINT handler is replaced).
projects/naia-agent/packages/runtime/src/host/create-host.ts:1:// Host factory — assembles HostContext for bin/naia-agent and embedded uses.
projects/naia-agent/packages/runtime/src/host/create-host.ts:4:// Slice 1b (R3): real LLM injection via opts.llm. The host (bin/naia-agent
projects/naia-agent/packages/cli-app/src/__tests__/bin-direct.test.ts:1:// Integration test for bin/naia-agent.ts direct mode.
projects/naia-agent/packages/cli-app/src/__tests__/bin-direct.test.ts:13:const binPath = resolve(repoRoot, "bin/naia-agent.ts");
projects/naia-agent/packages/cli-app/src/__tests__/bin-direct.test.ts:44:describe("bin/naia-agent direct mode (G01 / #21)", () => {

exec
/bin/bash -lc "nl -ba .agents/progress/direction-2026-04-25.md | sed -n '1,220p'" in /var/home/luke/alpha-adk
 succeeded in 0ms:
     1	# Direction change — 2026-04-25
     2	
     3	**Context**: End of a long session where the 4-repo TDD rewind (Phase A/B/C) was
     4	proceeding mechanically while the actual runtime skeleton wasn't running. The
     5	user realized the order was inverted and called a hard redirect.
     6	
     7	---
     8	
     9	## Decision
    10	
    11	1. **PAUSE the TDD rewind** (Phase C.1/C.3–C.8, Phase D continuation elsewhere, Phase E).
    12	2. **PAUSE Strangler X2–X8** planning.
    13	3. **Next priority = `naia-agent` as an independently runnable hub**:
    14	   - Goal shape: opencode-like CLI. `echo "hi" | naia-agent` (or REPL) talks to real Claude, uses real memory, calls real skills.
    15	   - Current gap: every `examples/*.ts` uses `MockLLMClient + InMemoryMemory + InMemoryToolExecutor`. There is no `bin/naia-agent` entrypoint.
    16	4. **Before building the skeleton, audit the project itself** (issue `nextain/naia-agent#2`):
    17	   - Context completeness — `AGENTS.md` / `CLAUDE.md` / `.agents/context/*` are **missing** from the hub project.
    18	   - Development methodology + documentation management.
    19	   - Context + harness alignment with architecture A.1–A.6.
    20	   - Reference-project adoption matrix (opencode / careti / claude-code).
    21	
    22	---
    23	
    24	## What was completed this session (do NOT redo)
    25	
    26	Committed on `naia-agent` branch `migration/phase-d` (commit `7f8a161`):
    27	
    28	- **Phase B — trust boundaries** (55 tests)
    29	  - `tool-executor.test.ts` (13) — GatedToolExecutor
    30	  - `skill-tool-bridge.test.ts` (16) — SkillToolExecutor
    31	  - `composite-tool-executor.test.ts` (14) — CompositeToolExecutor
    32	  - `agent-halt.test.ts` (12) — Agent halt-after-N + skip-encode-on-halt
    33	  - Source fixes: `tool-executor.ts` split `tool.denied`/`tool.timeout` log names; `agent.ts` `tool.error.halt` gained `errorCode/severity/retryable` + `logger.error("tool.halt", ...)` emit (both from cross-review R2-#4 P0 findings).
    34	- **Phase C.2 — `Agent.#streamLLM` chunk assembly** (11 tests) in `agent-stream-llm.test.ts`
    35	- **Shared helpers** in `packages/core/src/__tests__/helpers.ts`
    36	- **Infrastructure**:
    37	  - `CHANGELOG.md` — added `@nextain/agent-runtime` 0.1.0 freeze section that had been missing
    38	  - `.github/workflows/ci.yml` — added `pnpm -r --if-present test -- --run` step
    39	  - `packages/core/vitest.config.ts`, updated `packages/runtime/vitest.config.ts`
    40	
    41	Totals at commit time: **189 tests green** (protocol 73 + runtime 93 + core 23), `tsc --build` exit 0.
    42	
    43	Cross-review at Phase B close: **6 rounds across 3 parallel batches**, §Y PASS ("2 consecutive clean different-profile") achieved. Full log in `phase-b-outline.md` CLOSE section.
    44	
    45	Committed on `alpha-adk` `main` (commit `2a58301`):
    46	
    47	- `.agents/progress/phase-b-outline.md` — Phase B outline + close record
    48	- `.agents/progress/phase-c-outline.md` — Phase C 8 sub-phase outline (70 more tests, not implemented yet)
    49	
    50	---
    51	
    52	## What is PAUSED (not abandoned)
    53	
    54	| Track | State | Unfreeze when |
    55	|---|---|---|
    56	| Phase C.1 — `sendStream` abort + event order (12 tests) | Outline written | After skeleton proves Agent sendStream really works end-to-end |
    57	| Phase C.3 — `maybeCompact` splice + fallback (10 tests) | Outline written | Same |
    58	| Phase C.4 — `AnthropicClient.stream` (12 tests) | Outline written | When skeleton needs fixture-replay regression guard |
    59	| Phase C.5 — X1 adapter wiring + env gate (9 tests) | Outline written | If X1 flip-day is revisited |
    60	| Phase C.6 — composed-stack integration (7 tests) | Outline written | Post-skeleton |
    61	| Phase C.7 — multi-turn halt reset (4 tests) | Outline written | Post-skeleton |
    62	| Phase C.8 — multi-hop event ordering (5 tests) | Outline written | Post-skeleton |
    63	| Strangler X2 CommandExecutor | Not started | Post-skeleton, post-first-slice migration |
    64	| Strangler X3 Runtime loop (official) | Partially done (core `Agent` class exists) | When skeleton proves the loop runs in production |
    65	| Strangler X4 MCP + SkillLoader | Scaffold done | Post-skeleton |
    66	| Strangler X5 flip-day | Not reachable yet | Several slices migrated |
    67	
    68	None of this is **wrong work** — the tests themselves will be preserved. The pause is on **continuing to write more tests before proving the runtime runs**.
    69	
    70	---
    71	
    72	## Next session — starting point
    73	
    74	**Do this first** (issue `nextain/naia-agent#2`):
    75	
    76	### Step 1: naia-agent design review (audit)
    77	
    78	The hub project has structural gaps that need fixing before skeleton work:
    79	
    80	- No `AGENTS.md`, no `CLAUDE.md` at repo root.
    81	- `.agents/` has only `progress/` — no `context/`, `workflows/`, `skills/`.
    82	- No CODEOWNERS (naia-os has one).
    83	- No local summary of the 4-repo plan v7.2 — contributors have to read the parent plan in `alpha-adk`.
    84	- `@naia-adk/skill-spec` is **duplicated** into `packages/runtime/src/skill-loader.ts` as a shape copy — noted in code but not issue-tracked.
    85	- Reference-project adoption (opencode/careti/claude-code) is cited in `docs/` but not tabled into an adoption matrix with tests pinning the adoption.
    86	
    87	Run the 4 audits from the issue (context completeness / methodology / harness alignment / reference adoption) and produce `docs/design-review-2026-04.md` (or under `.agents/progress/`). P0 findings block the skeleton; P1 should fix before; P2 defer.
    88	
    89	### Step 2 (only after Step 1): skeleton CLI
    90	
    91	`bin/naia-agent` — readline REPL + real Anthropic + real alpha-memory + real FileSkillLoader. Template from `examples/minimal-host.ts` but swap mocks for real implementations. Exercise with `ANTHROPIC_API_KEY=... pnpm exec tsx bin/naia-agent.ts`.
    92	
    93	### Step 3 (after skeleton runs): first migration slice
    94	
    95	Pick smallest thing from `naia-os/agent/` — likely `providers/anthropic.ts`. Ensure the naia-agent skeleton subsumes it, then delete from naia-os. Verify via naia-os shell spawning the naia-agent CLI as sidecar.
    96	
    97	---
    98	
    99	## Branch / repo state to remember
   100	
   101	| Repo | Branch | Note |
   102	|---|---|---|
   103	| `alpha-adk` | `main` | This memo + outlines committed (2a58301). Submodule pointers NOT bumped. |
   104	| `naia-agent` | `migration/phase-d` | Phase B + C.2 committed (7f8a161). Branch name says "phase-d" but content is B+C — rename to `migration/phase-b-c2` or create new branch next session. |
   105	| `naia-os` | detached HEAD @ `830acf44` (X1 tip) | Re-attach via `git checkout migration/x1-anthropic-providers` when touching naia-os. |
   106	| `alpha-memory` | `main` | Separate session's ongoing benchmark work. Do not touch. |
   107	| `naia-adk` | `main` | Untouched. skill-spec 0.1.0 freeze intact. |
   108	
   109	---
   110	
   111	## Principles reaffirmed this session
   112	
   113	1. **Interface-not-dependency** (plan A.1). `naia-agent` does NOT import `alpha-memory` or `naia-adk` at runtime. Hosts inject implementations. Do not sub-module them into `naia-agent`.
   114	2. **npm publish is deferred indefinitely.** Submodule pin + workspace:* + file: suffices for internal coordination. Plan A.8 semver lockstep clauses are adjusted accordingly.
   115	3. **4-repo integration work happens in `alpha-adk/integration/*` branches** — each repo keeps its own `main` for independent improvements.
   116	4. **TDD rewind is a quality track**, not a gating track. Skeleton runs first, tests backfill as slices migrate.
   117	5. **Author separation** (§4.3) and **cross-review 2 consecutive different-profile clean** (§Y) remain mandatory when tests or source change.

exec
/bin/bash -lc "test -f projects/naia-agent/bin/naia-agent.ts && wc -c projects/naia-agent/bin/naia-agent.ts && nl -ba projects/naia-agent/bin/naia-agent.ts | sed -n '1,80p'" in /var/home/luke/alpha-adk
 succeeded in 0ms:
16205 projects/naia-agent/bin/naia-agent.ts
     1	#!/usr/bin/env -S pnpm exec tsx
     2	/**
     3	 * bin/naia-agent — R5 entry point.
     4	 *
     5	 * Default mode (--mode=direct, default):
     6	 *   Agent(HostContext) → VercelClient → LLM directly.
     7	 *   TTY stdin:    readline REPL loop  (type 'exit' or 'quit' to quit)
     8	 *   Piped stdin:  single-shot from positional arg or piped stdin
     9	 *
    10	 * Supervisor mode (--mode=supervisor):
    11	 *   Phase1Supervisor wrapping opencode-cli/shell sub-agent.
    12	 *   Kept for backward compatibility.
    13	 *
    14	 * Usage:
    15	 *   pnpm naia-agent "hello"                      # direct, single-shot
    16	 *   pnpm naia-agent                              # direct, REPL (TTY)
    17	 *   pnpm naia-agent "task" --mode=supervisor     # supervisor (opencode)
    18	 *   pnpm naia-agent "task" --workdir /path       # workdir
    19	 *   pnpm naia-agent "task" --no-verify           # skip test/typecheck (supervisor)
    20	 *   pnpm naia-agent "task" --adapter shell -- echo "x"  # shell sub-agent
    21	 *   pnpm naia-agent "task" -m provider/model     # model (supervisor)
    22	 *   pnpm naia-agent "task" --debug               # verbose event log
    23	 *
    24	 * Provider resolution (direct mode, first match wins):
    25	 *   1. ANTHROPIC_API_KEY  → claude-haiku-4-5-20251001 (or ANTHROPIC_MODEL)
    26	 *   2. OPENAI_API_KEY + OPENAI_BASE_URL → OPENAI_MODEL (default glm-4.5-flash)
    27	 *   3. GLM_API_KEY        → glm-4.5-flash (or GLM_MODEL)
    28	 *   4. VERTEX_PROJECT_ID + VERTEX_REGION → claude-haiku-4-5-20251001
    29	 *   5. (none)             → MockLLMClient (warns, for tests only)
    30	 *
    31	 * Exit codes: 0 = ok, 1 = verif fail, 2 = runtime error, 3 = usage error
    32	 * See: docs/llm-config-standard.md
    33	 */
    34	
    35	import readline from "node:readline";
    36	import { access as fsAccess } from "node:fs/promises";
    37	import path from "node:path";
    38	import process from "node:process";
    39	
    40	import { Agent } from "@nextain/agent-core";
    41	import type { HostContext, LLMClient } from "@nextain/agent-types";
    42	import { ConsoleLogger, InMemoryMeter, NoopTracer } from "@nextain/agent-observability";
    43	import {
    44	  InMemoryMemory,
    45	  InMemoryToolExecutor,
    46	  createBashSkill,
    47	} from "@nextain/agent-runtime";
    48	import { VercelClient } from "@nextain/agent-providers";
    49	
    50	
    51	// Supervisor mode imports
    52	import { ShellAdapter } from "@nextain/agent-adapter-shell";
    53	import { OpencodeRunAdapter } from "@nextain/agent-adapter-opencode-cli";
    54	import { OpencodeAcpAdapter } from "@nextain/agent-adapter-opencode-acp";
    55	import { ChokidarWatcher } from "@nextain/agent-workspace";
    56	import { TestVerifier, TypeCheckVerifier } from "@nextain/agent-verification";
    57	import {
    58	  AutoDenyApprovalBroker,
    59	  CliApprovalBroker,
    60	  InterruptManager,
    61	  Phase1Supervisor,
    62	  runCli,
    63	} from "@nextain/agent-cli-app";
    64	import type { ApprovalBroker, SubAgentAdapter, Verifier } from "@nextain/agent-types";
    65	
    66	// ─── Sensitive env var blacklist (D37 / #23) ────────────────────────────────
    67	// Used by --secure-env to scrub child process env (NOT applied to this process)
    68	const SENSITIVE_ENV_PATTERNS: readonly RegExp[] = [
    69	  /^ANTHROPIC_/,
    70	  /^OPENAI_/,
    71	  /^GOOGLE_/,
    72	  /^GEMINI_/,
    73	  /^AWS_/,
    74	  /^AZURE_/,
    75	  /^GITHUB_/,
    76	  /^GH_/,
    77	  /^GITLAB_/,
    78	  /^OPENROUTER_/,
    79	  /^GLM_/,
    80	  /^ZAI_/,

codex
`recall` 타입과 설계 문서 사이 정합만 추가 확인하면 판정 가능합니다.
exec
/bin/bash -lc "nl -ba projects/naia-agent/packages/types/src/memory.ts | sed -n '1,220p'" in /var/home/luke/alpha-adk
 succeeded in 0ms:
     1	/**
     2	 * MemoryProvider — long-term memory façade.
     3	 *
     4	 * Minimum contract: encode, recall, consolidate, close.
     5	 * Optional behaviours exposed via Capability interfaces. Consumers check
     6	 * capability at runtime; graceful degradation is the rule (A.11).
     7	 *
     8	 * Reference implementation: @nextain/naia-memory.
     9	 * See docs/memory-provider-audit.md for the façade → naia-memory mapping.
    10	 *
    11	 * Score semantics (MemoryHit.score): implementations SHOULD normalize to
    12	 * [0, 1] where 1 = strongest match. Raw strength or cosine distance must be
    13	 * normalized before returning.
    14	 */
    15	
    16	export type MemoryRole = "user" | "assistant" | "tool";
    17	
    18	export interface MemoryInput {
    19	  content: string;
    20	  role: MemoryRole;
    21	  /** Optional context hints (project, activeFile, sessionId, ...). */
    22	  context?: Record<string, string>;
    23	  /** Optional timestamp override (useful for ingesting historical data). */
    24	  timestamp?: number;
    25	}
    26	
    27	export interface RecallOpts {
    28	  topK?: number;
    29	  minStrength?: number;
    30	  /** Ignore decay weighting; retrieve from deep long-term store. */
    31	  deepRecall?: boolean;
    32	  /** Optional context hints for context-dependent recall. */
    33	  context?: Record<string, string>;
    34	  /** Project scope filter. When set, only memories tagged for this project
    35	   *  are eligible. naia-memory uses this for `encodingContext.project` /
    36	   *  `topics.includes(project)`. (R2.5 alignment with naia-memory) */
    37	  project?: string;
    38	  /** Session continuity hint. Implementations may bias recall toward the
    39	   *  same session's prior memories. (R2.5 alignment) */
    40	  sessionId?: string;
    41	}
    42	
    43	export interface MemoryHit {
    44	  id: string;
    45	  content: string;
    46	  summary?: string;
    47	  /** Normalized 0..1 match score. 1 = strongest. */
    48	  score: number;
    49	  /** When the underlying memory was first created. Implementations SHOULD
    50	   *  populate this; old code paths use `timestamp` as a fallback alias. */
    51	  createdAt?: number;
    52	  /** When the memory was last updated (reconsolidation, supersede, …). */
    53	  updatedAt?: number;
    54	  /** Deprecated alias for `createdAt`. Kept for backward compatibility. */
    55	  timestamp?: number;
    56	  metadata?: Record<string, unknown>;
    57	}
    58	
    59	export interface ConsolidationSummary {
    60	  /** How many new facts were extracted. */
    61	  factsCreated: number;
    62	  /** How many existing facts were updated (reconsolidation / supersede).
    63	   *  Optional — old implementations may not populate. (R2.5 alignment) */
    64	  factsUpdated?: number;
    65	  /** How many episodes were processed during this consolidation cycle.
    66	   *  Optional. (R2.5 alignment) */
    67	  episodesProcessed?: number;
    68	  /** Milliseconds spent. */
    69	  durationMs: number;
    70	}
    71	
    72	/** Optional encode-time hints (project tag, etc.). (R2.5 alignment) */
    73	export interface EncodeOpts {
    74	  /** Project tag attached to the resulting memory's encoding context. */
    75	  project?: string;
    76	}
    77	
    78	export interface MemoryProvider {
    79	  encode(input: MemoryInput, opts?: EncodeOpts): Promise<void>;
    80	  recall(query: string, opts?: RecallOpts): Promise<MemoryHit[]>;
    81	  /** Returns a summary so hosts can emit Event.data for observability. */
    82	  consolidate(): Promise<ConsolidationSummary>;
    83	  close(): Promise<void>;
    84	}
    85	
    86	// ─── Optional Capabilities ───────────────────────────────────────────────────
    87	// Implementations implement the ones they support; consumers check via
    88	// isCapable() before using.
    89	
    90	/**
    91	 * Encrypted backup capability — AES-256-GCM with PBKDF2-derived key.
    92	 * (R2.5 alignment — adopts naia-memory's password-protected scheme.)
    93	 *
    94	 * Implementations that don't need encryption may pass an empty password
    95	 * but the parameter is required by the contract for forward compatibility.
    96	 */
    97	export interface BackupCapable {
    98	  exportBackup(password: string): Promise<Uint8Array>;
    99	  importBackup(blob: Uint8Array, password: string): Promise<void>;
   100	}
   101	
   102	export interface EmbeddingCapable {
   103	  embed(text: string): Promise<number[]>;
   104	}
   105	
   106	export interface Entity {
   107	  id: string;
   108	  name: string;
   109	  type?: string;
   110	}
   111	
   112	export interface Relation {
   113	  from: string;
   114	  to: string;
   115	  relation: string;
   116	}
   117	
   118	export interface KnowledgeGraphCapable {
   119	  queryEntities(name: string): Promise<Entity[]>;
   120	  queryRelations(fromEntityId: string, relation?: string): Promise<Relation[]>;
   121	}
   122	
   123	export interface ImportanceScore {
   124	  importance: number;
   125	  surprise: number;
   126	  emotion: number;
   127	  utility: number;
   128	}
   129	
   130	export interface ImportanceCapable {
   131	  scoreImportance(input: MemoryInput): Promise<ImportanceScore>;
   132	}
   133	
   134	export interface Contradiction {
   135	  /** ID of the existing fact that conflicts with the new content. */
   136	  conflictingId: string;
   137	  /** Direct = same entity/attribute replaced. Indirect = related fact reframed. */
   138	  conflictType: "direct" | "indirect";
   139	  reason: string;
   140	}
   141	
   142	export interface ReconsolidationCapable {
   143	  /**
   144	   * Detect contradictions between *new content* and stored facts.
   145	   *
   146	   * (R2.5 alignment — naia-memory's signature: caller supplies the new
   147	   * content directly, optionally restricted to specific existing fact IDs.
   148	   * Returns enriched verdicts including conflict type.)
   149	   */
   150	  findContradictions(
   151	    newContent: string,
   152	    existingIds?: readonly string[],
   153	  ): Promise<Contradiction[]>;
   154	}
   155	
   156	export interface TemporalCapable {
   157	  /** Run an Ebbinghaus-style decay sweep. Returns the count of pruned items
   158	   *  (R2.5 alignment — naia-memory returns the count, not void). */
   159	  applyDecay(): Promise<number>;
   160	  /**
   161	   * Bi-temporal recall — return memories valid at the given timestamp.
   162	   *
   163	   * (R2.5 alignment — naia-memory makes `atTimestamp` required and accepts
   164	   * the same opts shape as `recall`. Implementations leverage the
   165	   * `-v{ts}/superseded` versioning scheme to surface the version that was
   166	   * active at the queried point in time.)
   167	   */
   168	  recallWithHistory(
   169	    query: string,
   170	    atTimestamp: number,
   171	    opts?: RecallOpts,
   172	  ): Promise<MemoryHit[]>;
   173	}
   174	
   175	// ─── ContradictionFilter (R2.5 — dual-process retrieval-rerank) ──────────────
   176	
   177	/** Pair of an existing memory and an incoming statement, evaluated by a
   178	 *  `ContradictionFilterCapable` provider for actual contradiction. */
   179	export interface ContradictionCandidate {
   180	  existing: { id: string; content: string; entities?: readonly string[] };
   181	  newInfo: string;
   182	}
   183	
   184	/** Per-pair verdict from the filter. \`confidence\` is 0–1; consumers may
   185	 *  threshold (default ≥0.7 in naia-memory) before acting on the verdict. */
   186	export interface ContradictionVerdict {
   187	  /** Index into the input candidates array (preserved for caller correlation). */
   188	  index: number;
   189	  action: "update" | "flag" | "keep";
   190	  /** New content to install when `action === "update"`. */
   191	  updatedContent?: string;
   192	  reason: string;
   193	  confidence: number;
   194	}
   195	
   196	/**
   197	 * Optional capability — small-LLM (or heuristic) filter that decides which
   198	 * of a *broad candidate set* (entity/cosine match) are *actual*
   199	 * contradictions. Mirrors human ACC (conflict detection) → PFC (resolution)
   200	 * division of labour; see naia-memory `contradiction-filter.ts` for the
   201	 * dual-process / asymmetric-model-sizing rationale.
   202	 *
   203	 * Implementations: \`HeuristicContradictionFilter\` (offline default),
   204	 * \`GeminiFlashLiteContradictionFilter\` (cloud), \`VllmReasoningContradictionFilter\`
   205	 * (local Gemma via vLLM). Selection by env: \`VLLM_REASONING_BASE > GEMINI_API_KEY > heuristic\`.
   206	 */
   207	export interface ContradictionFilterCapable {
   208	  filterContradictions(
   209	    candidates: readonly ContradictionCandidate[],
   210	  ): Promise<ContradictionVerdict[]>;
   211	}
   212	
   213	export interface SessionRecallCapable {
   214	  sessionRecall(text: string, opts?: { topK?: number }): Promise<string | null>;
   215	}
   216	
   217	/**
   218	 * `CompactableCapable` — memory-assisted context compaction.
   219	 *
   220	 * Consumed by the agent loop when the LLM context approaches its budget.

exec
/bin/bash -lc "nl -ba projects/naia-agent/docs/memory-provider-audit.md | sed -n '50,130p'" in /var/home/luke/alpha-adk
 succeeded in 0ms:
    50	## 2. Proposed `MemoryProvider` façade (for `@nextain/agent-types`)
    51	
    52	Minimum surface — matches A.5 contract (`encode`, `recall`, `consolidate`, `close`) with alpha-memory mapping:
    53	
    54	```typescript
    55	// @nextain/agent-types (zero runtime deps)
    56	
    57	export interface MemoryProvider {
    58	  encode(input: MemoryInput): Promise<void>;
    59	  recall(query: string, opts?: RecallOpts): Promise<MemoryHit[]>;
    60	  consolidate(): Promise<void>;
    61	  close(): Promise<void>;
    62	}
    63	
    64	export interface MemoryInput {
    65	  content: string;
    66	  role: "user" | "assistant" | "tool";
    67	  context?: Record<string, string>;  // project, activeFile, sessionId, ...
    68	  timestamp?: number;
    69	}
    70	
    71	export interface RecallOpts {
    72	  topK?: number;
    73	  minStrength?: number;
    74	  deepRecall?: boolean;          // Alpha feature — gracefully ignored by impls that lack it
    75	  context?: Record<string, string>;
    76	}
    77	
    78	export interface MemoryHit {
    79	  id: string;
    80	  content: string;
    81	  summary?: string;
    82	  score: number;                  // implementation-defined (strength, cosine, etc.)
    83	  timestamp?: number;
    84	  metadata?: Record<string, unknown>;
    85	}
    86	```
    87	
    88	### Mapping to alpha-memory
    89	
    90	| Façade method | alpha-memory call | Notes |
    91	|---|---|---|
    92	| `encode(input)` | `memorySystem.encode(input, input.context)` | Importance gating happens inside alpha-memory |
    93	| `recall(query, opts)` | `memorySystem.recall(query, opts)` → map `Episode[]` → `MemoryHit[]` | Episode.strength → hit.score |
    94	| `consolidate()` | `memorySystem.consolidate()` | Drop `ConsolidationResult` to `void`; caller inspects logs |
    95	| `close()` | `memorySystem.close()` | Direct pass-through |
    96	
    97	## 3. Optional Capability interfaces (A.5)
    98	
    99	Alpha-memory features that belong in optional capabilities, not the minimum façade:
   100	
   101	```typescript
   102	export interface BackupCapable {
   103	  backup(): Promise<Uint8Array>;
   104	  restore(data: Uint8Array): Promise<void>;
   105	}
   106	
   107	export interface EmbeddingCapable {
   108	  embed(text: string): Promise<number[]>;
   109	}
   110	
   111	export interface KnowledgeGraphCapable {
   112	  queryEntities(name: string): Promise<Entity[]>;
   113	  queryRelations(from: string, relation?: string): Promise<Relation[]>;
   114	}
   115	
   116	export interface ImportanceCapable {
   117	  scoreImportance(input: MemoryInput): Promise<ImportanceScore>;
   118	}
   119	
   120	export interface ReconsolidationCapable {
   121	  findContradictions(factId: string): Promise<Contradiction[]>;
   122	}
   123	
   124	export interface TemporalCapable {
   125	  applyDecay(): Promise<void>;
   126	  recallWithHistory(query: string, at?: number): Promise<MemoryHit[]>;
   127	}
   128	
   129	export interface SessionRecallCapable {
   130	  sessionRecall(text: string, opts?: { topK?: number }): Promise<string | null>;

exec
/bin/bash -lc "nl -ba projects/naia-agent/docs/naia-memory-wire.md | sed -n '1,140p'" in /var/home/luke/alpha-adk
 succeeded in 0ms:
     1	# naia-agent ↔ naia-memory 연결 spec
     2	
     3	> **status**: Phase 2 docs (Phase 3 정식 wire 시 정식화)
     4	> **상위**: `docs/vision-statement.md` §4b (페르소나 분리), `docs/memory-provider-audit.md` (façade 감사)
     5	
     6	---
     7	
     8	## 1. 책임 분리 (사용자 directive 명시)
     9	
    10	> "기억을 불러오거나 선택하는 모듈은 naia-memory에서 해야 한다"
    11	
    12	| 책임 | 위치 |
    13	|---|---|
    14	| **MemoryProvider interface 정의** | naia-agent (`packages/types/src/memory.ts`) |
    15	| **기억 저장 (encode)** | **naia-memory** (LocalAdapter / Mem0 / Qdrant 등) |
    16	| **기억 검색 (recall)** + **랭킹/선택** + **decay** + **importance gating** | **naia-memory** |
    17	| **압축 (compact)** | **naia-memory** (CompactableCapable impl) |
    18	| **interface 호출 + 결과 inject** | naia-agent (Phase 3 supervisor) |
    19	
    20	→ naia-agent는 검색 로직을 가지지 않는다. `provider.recall(opts)` 호출 + 결과를 `extraSystemPrompt`에 주입할 뿐.
    21	
    22	---
    23	
    24	## 2. 의존 방식 (현재 = 로컬 file: dep)
    25	
    26	```json
    27	// naia-agent/package.json (devDependencies)
    28	"@nextain/naia-memory": "file:../alpha-memory"
    29	```
    30	
    31	**npm online publish 없이도 동작** — alpha-adk monorepo 안에서 file: 의존이 자동 link.
    32	
    33	| 환경 | 동작 |
    34	|---|:---:|
    35	| alpha-adk 안 (로컬 dev) | ✓ 즉시 (354 PASS 검증) |
    36	| 외부 사용자 / CI | ✗ alpha-memory 디렉터리 부재 |
    37	
    38	**publish 시점 권고**:
    39	- alpha-memory 성능 테스트 / 안정화 후
    40	- 외부 distribution 필요 시 (지금은 미필요)
    41	- 권한: 사용자 본인 npm account
    42	
    43	publish 후에는 `"@nextain/naia-memory": "^0.x.y"` 로 변경.
    44	
    45	---
    46	
    47	## 3. wire 패턴 (host = alpha-adk 또는 다른 인스턴스 host)
    48	
    49	```typescript
    50	import { Agent } from "@nextain/agent-core";
    51	import { LocalAdapter, MemorySystem } from "@nextain/naia-memory";
    52	
    53	// 1. naia-memory 인스턴스 (alpha-adk가 path 결정)
    54	const adkRoot = process.env["ADK_ROOT"] ?? process.cwd();
    55	const memorySystem = new MemorySystem({
    56	  adapter: new LocalAdapter({
    57	    storagePath: path.join(adkRoot, "data/memory"),  // naia-adk 컨벤션
    58	  }),
    59	});
    60	
    61	// 2. MemoryProvider 어댑터로 wrap (examples/naia-memory-host.ts 패턴)
    62	const provider: MemoryProvider = makeNaiaMemoryProvider(memorySystem);
    63	
    64	// 3. naia-agent에 inject
    65	const host: HostContext = { llm, memory: provider, ... };
    66	const agent = new Agent(host, ...);
    67	
    68	// 4. (Phase 3 정식) supervisor가 prompt 보내기 전 recall + inject
    69	const hits = await provider.recall({
    70	  query: userPrompt,
    71	  topK: 5,
    72	  minStrength: 0.6,
    73	});
    74	const memoryContext = hits.map((h) => h.content).join("\n");
    75	const taskSpec = {
    76	  prompt: userPrompt,
    77	  workdir,
    78	  extraSystemPrompt: `[기억]\n${memoryContext}\n\n[페르소나]\n${naiaAdkPersona}`,
    79	};
    80	
    81	// 5. sub-agent에 전달 → 응답 → encode 다시 호출
    82	await provider.encode({
    83	  content: assistantResponse,
    84	  role: "assistant",
    85	  context: { sessionId },
    86	});
    87	```
    88	
    89	**Phase 3에서 정식 wire**. 현재 Phase 2는 wire X (interface만 정의 + adapter 예시).
    90	
    91	---
    92	
    93	## 4. naia-agent가 절대 하지 않는 것
    94	
    95	- ❌ vector search / cosine similarity
    96	- ❌ 기억 importance scoring
    97	- ❌ Ebbinghaus decay
    98	- ❌ knowledge graph
    99	- ❌ 어떤 storage backend 직접 import
   100	
   101	→ 모두 naia-memory 책임. naia-agent는 **interface 호출 + 결과 inject** 만.
   102	
   103	---
   104	
   105	## 5. 디렉터리명 vs pkg name (현 상황)
   106	
   107	| | 값 |
   108	|---|---|
   109	| **GitHub repo** | `nextain/alpha-memory` (legacy 이름 유지) |
   110	| **submodule 디렉터리** | `projects/alpha-memory/` |
   111	| **npm package name** | **`@nextain/naia-memory`** (rename 완료) |
   112	| **import 식** | `import { ... } from "@nextain/naia-memory"` |
   113	
   114	→ 디렉터리명 (alpha-memory) 과 pkg name (naia-memory) 분리. 코드/import는 naia-memory만 쓰니 의존 path 명확. 디렉터리 rename은 사용자 별도 결정 (Phase 3 권장).
   115	
   116	---
   117	
   118	## 6. Phase 3 정식 wire 시 추가될 것
   119	
   120	- naia-adk가 storage path 컨벤션 export (예: `getMemoryStoragePath(adkRoot: string)`)
   121	- Phase2Supervisor → Phase3Supervisor (또는 옵션 추가)에 `MemoryProvider` DI
   122	- supervisor.run() 내부에서 recall → extraSystemPrompt 자동 채움
   123	- session_aggregated 후 encode 자동 호출
   124	- `--memory` flag (CLI에서 enable/disable)

codex
VERDICT: ISSUES_FOUND

[C1·C2·M1·RAG·loader·manifestSoT 해소]
- C1: PASS — v3는 manifest를 `naia-adk` 소유의 workspace 데이터 파일로 고정하고 public 계약이 아님을 단정했으며 SoT/버전/호환표도 명시했다. [agent-service-builder-architecture.md](/var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:80) [agent-service-builder-architecture.md](/var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:87) [naia-4repo-migration-plan.md](/var/home/luke/alpha-adk/.agents/progress/naia-4repo-migration-plan.md:170) [naia-4repo-migration-plan.md](/var/home/luke/alpha-adk/.agents/progress/naia-4repo-migration-plan.md:207)
- C2: PASS — F08 해제 조건인 `#3/#4/#5/#6 CLOSED`와 `OPEN P0 0건`을 사실로 적시했고, 이후 slice는 추가 게이트 충족 전 금지로 써서 우회가 아니다. [agent-service-builder-architecture.md](/var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:166) [agent-service-builder-architecture.md](/var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:178) [agents-rules.json](/var/home/luke/alpha-adk/projects/naia-agent/.agents/context/agents-rules.json:69)
- M1: PASS — `yield*` 위임, step당 독립 `Agent.sendStream()`, reducer/공유상태 채널 없음, history/순서/중복은 기존 D6 turn lifecycle 재사용으로 계약을 닫았다. [agent-service-builder-architecture.md](/var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:120) [agent-service-builder-architecture.md](/var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:124) [ref-adoption-matrix.md](/var/home/luke/alpha-adk/projects/naia-agent/.agents/progress/ref-adoption-matrix.md:71) [agent-loop-design.md](/var/home/luke/alpha-adk/projects/naia-agent/docs/agent-loop-design.md:78)
- RAG: FAIL — RetrievalCapable 중복 책임은 제거됐지만, `rag.sources`를 현재 `MemoryProvider.recall(query, opts?: RecallOpts)` 계약으로 어떻게 전달하는지 설계가 비어 있다. 현 `RecallOpts`에는 `sources`가 없고 문서는 “source-aware retrieval 수행”만 선언했다. [agent-service-builder-architecture.md](/var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:83) [memory.ts](/var/home/luke/alpha-adk/projects/naia-agent/packages/types/src/memory.ts:27) [memory.ts](/var/home/luke/alpha-adk/projects/naia-agent/packages/types/src/memory.ts:78) [agent-loop-design.md](/var/home/luke/alpha-adk/projects/naia-agent/docs/agent-loop-design.md:80)
- loader: PASS — SB-1을 `naia-agent --service` CLI-host 경로로 고정했고, 이는 A.4의 “CLI 소유 = naia-agent”와 충돌하지 않는다. [agent-service-builder-architecture.md](/var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:81) [agent-service-builder-architecture.md](/var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:185) [naia-4repo-migration-plan.md](/var/home/luke/alpha-adk/.agents/progress/naia-4repo-migration-plan.md:174)
- manifestSoT: PASS — 경로 `naia-adk/docs/service-manifest-schema.md`, 버전=naia-adk semver, 호환표 문서화를 못박아 소유권/SoT 불명확성은 해소됐다. [agent-service-builder-architecture.md](/var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:80) [naia-4repo-migration-plan.md](/var/home/luke/alpha-adk/.agents/progress/naia-4repo-migration-plan.md:242)

[MAJOR]
- `rag.sources` 전달 경로 미정: 현재 계약상 가능한 값은 `RecallOpts.context/project/sessionId`뿐인데, v3는 어느 필드로 실어보낼지 또는 additive 변경이 필요한지 확정하지 않았다. 이 상태로는 “recall 재사용”이 문장 수준 선언에 머문다. [agent-service-builder-architecture.md](/var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:83) [memory.ts](/var/home/luke/alpha-adk/projects/naia-agent/packages/types/src/memory.ts:32)

종합: 조건부 — 개발 착수 전 `rag.sources → RecallOpts` 매핑 계약 1개를 먼저 닫아야 한다.
tokens used
56,766
VERDICT: ISSUES_FOUND

[C1·C2·M1·RAG·loader·manifestSoT 해소]
- C1: PASS — v3는 manifest를 `naia-adk` 소유의 workspace 데이터 파일로 고정하고 public 계약이 아님을 단정했으며 SoT/버전/호환표도 명시했다. [agent-service-builder-architecture.md](/var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:80) [agent-service-builder-architecture.md](/var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:87) [naia-4repo-migration-plan.md](/var/home/luke/alpha-adk/.agents/progress/naia-4repo-migration-plan.md:170) [naia-4repo-migration-plan.md](/var/home/luke/alpha-adk/.agents/progress/naia-4repo-migration-plan.md:207)
- C2: PASS — F08 해제 조건인 `#3/#4/#5/#6 CLOSED`와 `OPEN P0 0건`을 사실로 적시했고, 이후 slice는 추가 게이트 충족 전 금지로 써서 우회가 아니다. [agent-service-builder-architecture.md](/var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:166) [agent-service-builder-architecture.md](/var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:178) [agents-rules.json](/var/home/luke/alpha-adk/projects/naia-agent/.agents/context/agents-rules.json:69)
- M1: PASS — `yield*` 위임, step당 독립 `Agent.sendStream()`, reducer/공유상태 채널 없음, history/순서/중복은 기존 D6 turn lifecycle 재사용으로 계약을 닫았다. [agent-service-builder-architecture.md](/var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:120) [agent-service-builder-architecture.md](/var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:124) [ref-adoption-matrix.md](/var/home/luke/alpha-adk/projects/naia-agent/.agents/progress/ref-adoption-matrix.md:71) [agent-loop-design.md](/var/home/luke/alpha-adk/projects/naia-agent/docs/agent-loop-design.md:78)
- RAG: FAIL — RetrievalCapable 중복 책임은 제거됐지만, `rag.sources`를 현재 `MemoryProvider.recall(query, opts?: RecallOpts)` 계약으로 어떻게 전달하는지 설계가 비어 있다. 현 `RecallOpts`에는 `sources`가 없고 문서는 “source-aware retrieval 수행”만 선언했다. [agent-service-builder-architecture.md](/var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:83) [memory.ts](/var/home/luke/alpha-adk/projects/naia-agent/packages/types/src/memory.ts:27) [memory.ts](/var/home/luke/alpha-adk/projects/naia-agent/packages/types/src/memory.ts:78) [agent-loop-design.md](/var/home/luke/alpha-adk/projects/naia-agent/docs/agent-loop-design.md:80)
- loader: PASS — SB-1을 `naia-agent --service` CLI-host 경로로 고정했고, 이는 A.4의 “CLI 소유 = naia-agent”와 충돌하지 않는다. [agent-service-builder-architecture.md](/var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:81) [agent-service-builder-architecture.md](/var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:185) [naia-4repo-migration-plan.md](/var/home/luke/alpha-adk/.agents/progress/naia-4repo-migration-plan.md:174)
- manifestSoT: PASS — 경로 `naia-adk/docs/service-manifest-schema.md`, 버전=naia-adk semver, 호환표 문서화를 못박아 소유권/SoT 불명확성은 해소됐다. [agent-service-builder-architecture.md](/var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:80) [naia-4repo-migration-plan.md](/var/home/luke/alpha-adk/.agents/progress/naia-4repo-migration-plan.md:242)

[MAJOR]
- `rag.sources` 전달 경로 미정: 현재 계약상 가능한 값은 `RecallOpts.context/project/sessionId`뿐인데, v3는 어느 필드로 실어보낼지 또는 additive 변경이 필요한지 확정하지 않았다. 이 상태로는 “recall 재사용”이 문장 수준 선언에 머문다. [agent-service-builder-architecture.md](/var/home/luke/alpha-adk/projects/naia-adk/.agents/progress/agent-service-builder-architecture.md:83) [memory.ts](/var/home/luke/alpha-adk/projects/naia-agent/packages/types/src/memory.ts:32)

종합: 조건부 — 개발 착수 전 `rag.sources → RecallOpts` 매핑 계약 1개를 먼저 닫아야 한다.
