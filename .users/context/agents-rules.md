<!-- AUTO-GENERATED from .agents/context/agents-rules.json — DO NOT EDIT BY HAND.
     SoT = json. 수정은 json 에서, 이 파일은 hook 이 자동 동기화. -->

# agents-rules (mirror)

> 기계 SoT: `.agents/context/agents-rules.json` — 이 md 는 자동 파생.
- **_copyright**: Copyright 2026 Nextain Inc. All rights reserved.

## project_identity

- **name**: Naia OS
- **nature**: AI desktop companion — open-source project for AI sovereignty
- **philosophy**: Users choose their AI, privacy first, local execution by default
- **org**: nextain
- **repo**: nextain/member-luke

## local_projects


### naia-os

- **purpose**: Naia OS desktop app (Tauri 2 + React + Three.js + Node.js agent)
- **repo**: nextain/naia-os
- **visibility**: public
- **entry_point**: naia-os/AGENTS.md

### issue-desk

- **purpose**: IssueDesk — standalone Vite+React panel for naia-os. GitHub issue/PR triage, community assistant, notification triage.
- **repo**: nextain/issue-desk
- **visibility**: private
- **entry_point**: issue-desk/panel.json
- **notes**: Standalone git repo, not a submodule. Design doc: naia-os/docs/design/issue-desk.ko.md

### about.nextain.io

- **purpose**: Nextain corporate website (Next.js 14 + next-intl)
- **repo**: nextain/about.nextain.io
- **visibility**: public
- **entry_point**: about.nextain.io/README.md

### naia.nextain.io

- **purpose**: Naia web app / Lab portal (Next.js + BFF for gateway)
- **repo**: nextain/naia.nextain.io
- **visibility**: private
- **entry_point**: naia.nextain.io/AGENTS.md

### aiedu.nextain.io

- **purpose**: AI education platform — curriculum-driven AI teacher (Next.js + Monaco + Pyodide + any-llm)
- **repo**: nextain/aiedu.nextain.io
- **visibility**: private
- **entry_point**: aiedu.nextain.io/AGENTS.md
- **notes**: B2B commercial product. Dual-mirror context. Curriculum as plugin. Depends on any-llm B2B extension.

### admin.nextain.io

- **purpose**: Nextain B2B admin control plane (license key mgmt, token tracking, client mgmt)
- **repo**: nextain/admin.nextain.io
- **visibility**: private
- **entry_point**: admin.nextain.io/AGENTS.md
- **notes**: Internal tool. Manages aiedu.nextain.io and future B2B products.

## infrastructure


### gateway


#### prod

- **url**: https://naia-gateway-181404717065.asia-northeast3.run.app
- **key_env**: GATEWAY_MASTER_KEY
- **db**: any_llm_gateway (cafelua-db, Cloud SQL PostgreSQL 15, asia-northeast3-a)

#### dev

- **url**: https://naia-gateway-dev-181404717065.asia-northeast3.run.app
- **key**: qliT3Q4SC128rtR5o2dwud0vP25tu4usuvyFAP1oGAE
- **db**: any_llm_gateway_dev (same cafelua-db instance, separate DB)
- **min_instances**: 0
- **env_rule**: .env.local → dev gateway. .env.production.local → prod gateway. NEVER write prod credentials to .env.local.
- **guard_hook**: .claude/hooks/prod-gateway-guard.js — blocks prod credentials in .env.local at Edit|Write time
- **sync_script**: project-any-llm/scripts/sync-prod-to-dev.sh — manual only, requires 'yes' confirmation, OVERWRITES all dev data

### ci_runners


#### self_hosted

- **name**: luke-bazzite
- **host**: this Bazzite PC (/opt/actions-runner)
- **scope**: nextain org — private repos only (public repos use free GitHub-hosted runners)

##### labels

- self-hosted
- linux
- x64
- bazzite
- **service**: actions.runner.nextain.luke-bazzite.service
- **note**: DO NOT attach self-hosted runners to public repos — fork PR security risk
- **install_note**: /var/home causes SELinux exec block; always install under /opt/
- **workflow_usage**: runs-on: [self-hosted, linux, x64]

## submodules


### docs-work-logs

- **purpose**: Developer work logs (per-person folders)
- **repo**: nextain/docs-work-logs
- **visibility**: private
- **entry_point**: docs-work-logs/AGENTS.md

### docs-nextain

- **purpose**: Internal docs (onboarding, meetings, design)
- **repo**: nextain/docs-nextain
- **visibility**: private
- **entry_point**: docs-nextain/AGENTS.md

### docs-business

- **purpose**: Business docs (proposals, strategy, IR)
- **repo**: nextain/docs-business
- **visibility**: private
- **entry_point**: docs-business/README.md

### cafelua.com

- **purpose**: Cafelua personal website
- **repo**: luke-n-alpha/cafelua-private
- **visibility**: private
- **entry_point**: cafelua.com/README.md

### project-any-llm

- **purpose**: Any-LLM SDK + FastAPI gateway (LLM proxy, credits, auth, usage tracking)
- **repo**: nextain/any-llm
- **visibility**: public
- **entry_point**: project-any-llm/README.md

## reference_submodules

- **_description**: Reference repos for upstream tracking (read-only, periodic sync)

### ref-cline

- **purpose**: Cline upstream reference (VS Code AI extension)
- **source**: https://github.com/cline/cline
- **usage**: Architecture/pattern reference

### ref-opencode

- **purpose**: OpenCode reference (TUI-based AI coding agent)
- **source**: https://github.com/anomalyco/opencode
- **usage**: Architecture/pattern reference for CLI features

### ref-nanoclaw

- **purpose**: NanoClaw reference (lightweight AI agent framework)
- **source**: https://github.com/qwibitai/nanoclaw
- **usage**: Agent framework reference

### ref-moltbot

- **purpose**: Moltbot reference
- **source**: https://github.com/moltbot/moltbot
- **usage**: Bot framework reference

### ref-project-airi

- **purpose**: AIRI reference (AI character project)
- **source**: https://github.com/moeru-ai/airi
- **usage**: AI character/avatar reference

### ref-jikime-adk

- **purpose**: Jikime ADK reference (Agent Development Kit)
- **source**: https://github.com/jikime/jikime-adk
- **usage**: Agent development reference

### ref-jikime-mem

- **purpose**: Jikime Memory reference
- **source**: https://github.com/jikime/jikime-mem
- **usage**: Memory/RAG reference

## architecture_rules


### modification_levels

- **L1_independent**: docs-work-logs (personal folders)
- **L2_conditional**: docs-nextain, docs-business, cafelua.com, project-any-llm

## skills


### read-doc

- **trigger**: MANDATORY — any time a file with extension .hwp, .hwpx, .pdf, .docx, .xlsx, .pptx needs to be read or analyzed
- **command**: /read-doc <file-path>
- **rule**: NEVER say 'I cannot read this file type'. Always use /read-doc first. The skill handles all extraction automatically.
- **sidecar_note**: docs-business HWP/HWPX files have pre-extracted .txt sidecars — /read-doc checks these first automatically

#### use_cases

- docs-business 제안서/사업계획서 분석
- 발표 자료(PPTX) 내용 파악
- 이력서(DOCX) 검토
- 정부과제 제출서류 검토

### webapp-testing

- **trigger**: MANDATORY — any E2E test, UI behavior verification, screenshot capture, or console log check for local web apps (naia.nextain.io, about.nextain.io, aiedu.nextain.io, etc.)
- **command**: /webapp-testing
- **rule**: NEVER ask the user to manually test. Always use this skill to verify directly. Uses Playwright Python scripts.

#### use_cases

- Next.js 앱 E2E 테스트
- UI 동작 검증 (버튼 클릭, 폼 제출 등)
- 스크린샷 캡처
- 콘솔 로그/에러 확인

### doc-coauthoring

- **trigger**: MANDATORY — any request to write a structured document: tech spec, proposal, RFC, design doc, PRD, decision record
- **command**: /doc-coauthoring
- **rule**: Invoke before writing the document. 3-stage workflow: context collection → structured writing → reader test.

#### use_cases

- 기술 스펙 작성
- 제안서/IR 문서
- RFC / 설계 결정 기록
- GitHub Issue 기반 기능 설계 스펙

## ai_workflow

- **knowledge_principle**: AI knowledge = Developer knowledge (1:1 parity)
- **default_workflow**: issue-driven-development.yaml (feature-level work)
- **lightweight_workflow**: development-cycle.yaml (non-feature changes: typos, config values, simple directives)

### permission_model

- **code_files**: AI = implementer. Can read, modify, create, delete freely.
- **design_docs**: AI = reviewer. CANNOT modify unless: (A) typo/grammar, (B) internal contradiction within the doc, (C) broken link/reference. ANY other change requires surfacing to user first.

#### design_doc_paths

- docs/design/
- design/
- spec/

#### design_doc_extensions

- .md
- .txt
- .yaml
- .json
- **note**: Any file matching these path prefixes + extensions is treated as a design doc. Hook enforces this at Edit|Write time.
- **key_distinction**: Code review clean pass = no code issues. Design doc review clean pass = no NEW findings (typos/contradictions/broken links). Never: 'design should match implementation'.

### escalation_path


#### design_gap_found_during_build

- 1. Do NOT modify the design doc to match implementation
- 2. Do NOT silently adapt implementation to paper over the gap
- 3. Surface to user: state the gap (design says X, implementation does Y), present options (A: update design, B: fix implementation, C: accept as intentional deviation)
- 4. Wait for user decision before proceeding

#### design_flaw_found_during_review

- 1. Report to user: 'Found potential design issue at [file:line]: [description]'
- 2. Propose: 'Options: A) fix typo/grammar (allowed), B) this is a design decision I should not change — your call'
- 3. Do not make the change until user confirms it's (A)

### mandatory_pre_checks

- Read agents-rules.json first
- When working in submodule, read its entry point file
- For feature-level work: follow issue-driven-development.yaml gates (understand → scope → plan confirmation required before proceeding)
- Apply minimal-change principles
- For any .hwp/.hwpx/.pdf/.docx/.xlsx/.pptx file: use /read-doc skill FIRST — never claim inability to read documents
- Design docs (docs/design/, spec/, design/) + extensions (.md/.txt/.yaml/.json): see permission_model above. Hook fires on edits — surface reason to user first.
- Before running destructive git commands (git checkout --, git reset --hard, git clean -f): ALWAYS ask user for explicit confirmation first. State exactly what will be deleted. No exceptions.
- Before deleting ANY code/branch/file (even temp/work files): treat it as risky, NOT harmless — understand why it is dead, back it up, get user confirmation. No AI-only deletion. (see dead_code_safety)

### completeness_principle

- **statement**: AI marginal cost ≈ 0 — when approved to build something, build it completely (all edge cases, error handling, tests included).

#### three_principles_distinction

- **no_autonomous_development**: WHAT to build = user decides. Never add features or scope without asking.
- **minimal_modification**: HOW FAR to deviate from upstream = minimize. For fork-based work: overlay custom changes with minimal delta from upstream.
- **completeness**: QUALITY of approved work = complete. If user approves X, implement X fully. Option A (complete) vs Option B (partial) → always recommend A unless user explicitly asks for partial.
- **boilable_lake_rule**: A bounded, scoped module is 'boilable'. If scope is finite, implement it completely. Never deliver partial when complete costs AI nothing extra.

### dead_code_safety

- **statement**: Dead/unused code, branches, files, and artifacts are NOT harmless. The AI's assumption that 'this seems unused, so removing/ignoring it is safe' is frequently wrong: deletion is irreversible, and orphaned dead code misleads the next session into treating it as normal. Default to RISK-assumption, not harmlessness.
- **rules**:
  - Do not casually delete OR ignore dead/unused code, branches, or files.
  - Before deletion: (1) understand WHY it is dead (intentional retention? migration leftover? not-yet-wired?) (2) back it up (3) get explicit user confirmation.
  - No AI-only deletion — even for temp/work files, follow an explicit lifecycle rule or ask the user first.
- **rationale**: Known AI cognitive bias — underweighting the risk of dead code. Same root cause as the 'recurring-symptom misclassification' failure pattern.

### ask_user_question_format

- **description**: Standard structure for user-facing decision questions (gates, options, scope choices). Makes trade-offs explicit.

#### structure

- 1. Re-ground (1-2 sentences): state the project, current phase, and specific question in plain terms
- 2. Simplify: ask without jargon — as if explaining to a non-engineer
- 3. Recommend: explicit recommendation with completeness score (1-10) + AI time + human review time
- 4. Options: lettered A/B/C, each with effort estimate + completeness score + one-sentence trade-off
- **example**: RECOMMENDATION: A (completeness 9/10 | AI: ~30min | review: ~10min)
A) Full implementation — all edge cases covered [completeness 9/10]
B) Minimal — ships faster, revisit later [completeness 5/10]
- **review_skill**: Use '/review-pass stage=planning|development|test|integration files=...' for stage-specific multi-AI cross-validation review. REQ-IDs required for feature-level work. Simple changes (lightweight cycle: <3 files, single module) skip REQ-ID creation. Read .agents/requirements/_index.yaml when entering Plan or Review phases.

### requirements_management

- **storage**: .agents/requirements/
- **index**: .agents/requirements/_index.yaml
- **load_timing**: on-demand when entering Plan or Review phases (NOT session-injected)
- **req_id_threshold**: Feature-level work only. Lightweight cycle changes (typos, config, <3 files, single module) skip REQ-ID creation.

#### source_authority

- **candidate**: Code is source of truth. Requirements are descriptive (derived from existing code).
- **human**: Requirements are normative. Code must conform.
- **default**: When requirements conflict with code: candidate→code wins, human→REQ wins.
- **retrofitted_requirements**: Always status: candidate. Require explicit human promotion to active/verified.
- **dual_mirror**: Requirements live in .agents/requirements/ ONLY (no .users/ mirror). Use title_ko field for Korean title.
- **trace_format**: Use file + symbol references. Never hardcode line numbers (they rot immediately).
- **submodule_rule**: Each submodule has own rules. Read entry_point before modifications.

## financial_integrity

- **cost_estimation_first**: Before performing any large-scale cloud operations, the agent MUST estimate the potential cost and obtain explicit user approval.

### expensive_operations_blacklist

- GCS: Data movement > 10GB or API ops > 1,000 via mount points (e.g., rsync via gcsfuse)
- GCE: Provisioning high-tier GPU instances (A100, H100, etc.)
- Vertex AI/LLM: Massive batch inference or fine-tuning jobs
- Cloud SQL: Massive data migrations or large-scale index rebuilds
- **resource_awareness**: Always monitor Class A/B API operation counts for GCS and egress traffic costs for GCE/Cloud Run.

## language_harness

- **no_korean_in_agents**: Strictly prohibit Korean characters in .agents/ directory to optimize token usage. All context files here must be in concise English.
- **concise_session_output**: AI responses should be extremely brief (less than 3 lines) to minimize history weight. Avoid long Korean preambles.

## context_governance — runtime context budgeting (absorbed from A.4)

> Source: harness-books Book1 Appendix A.4. Absorption review = `.agents/progress/harness-books-integration-findings-2026-06-18.md` (section A, gap 2).
> **Layer note:** this is the *runtime session-window* token axis only, NOT the naia-memory product axis (long-term / real memory). Do not conflate them — naia-memory decides what to remember across sessions; this decides what to keep live in the current window.

- **on_demand_loading**: Load only the project-index.yaml on_demand section needed for the task. Never load a full context file (A.4: separate entrypoint vs body files to prevent index bloat).
- **reserve_for_compact**: Reserve compact output space before the window is full — never wait for overflow then handle it as an emergency.
- **restore_after_compact**: After compact, reconstruct work semantics (active plan, loaded skills, key files, tool state) via post-compact-context.js hook.
- **layered_lifetimes**: Keep long-lived rules, persistent memory, session continuity, and temporary dialogue as distinct layers with different entry costs.

## conventions

- **response_language**: Korean (한국어로 응답)
- **development_approach**: Issue-driven development (default). TDD where applicable.
- **test_code_review**: After writing tests, never trust results blindly. Review test logic itself with iterative review (2 consecutive clean passes) before trusting outcomes. Signs of invalid tests: assertions that always pass, mocked internals that diverge from real behavior, missing negative cases.

### tmp_files

- **rule**: All temporary/debug/scratch scripts MUST be created inside tmp/ at the root of the active working directory. NEVER create tmp-* or tmp_* files in the repo root or subproject roots.
- **gitignore**: tmp/, tmp-*, tmp_* are gitignored at root. Files placed there are never tracked.
- **naming**: Use descriptive names inside tmp/ (e.g. tmp/check-db.php, tmp/debug-redis.sh) — no tmp- prefix needed since the directory provides the namespace.
- **work_logs**: Don't modify unless explicitly requested

### workfile_lifecycle

- **principle**: All work files (progress reports, scratch scripts, temp data) MUST follow explicit lifecycle. No accumulation without policy.
- **directories**:
  - `.agents/context/`: Permanent context (on_demand loaded). Long-lived. In-place corrections only.
  - `.agents/progress/`: Active/completed work reports. JSON = harness 1st-class (session-inject). MD = lifecycle-tracked.
  - `.agents/progress/archive/YYYY-MM/`: Completed reports preserved (searchable). readdirSync skips subdirs = excluded from active set.
  - `.agents/work/`: Temporary work scripts. `.gitignore`. User-managed cleanup (no AI auto-delete).
  - `tmp/, tmp-*, tmp_*`: Debug/scratch (see tmp_files above).
- **completion_criteria** (2+ required): (a) code committed/pushed to origin, (b) user explicitly declares done/closed, (c) cross-review GO + user acceptance, (d) superseded by next-step plan/issue. AI self-declaring "complete" is prohibited.
- **triggers**:
  - work_start: Create or update one progress file (1 per work, not per session).
  - session_end_or_milestone: Add status line (`✅ done` / `⏳ in-progress` / `🔴 blocked`).
  - after_commit_push: Move that work's progress to `archive/YYYY-MM/` (mention in commit message).
  - monthly_cleanup: Review 30+ day progress; archive completed or inline-resolve.
  - `.agents/work/` 30+ day: User-decided deletion (volatile by design).
- **naming**: `<topic>-YYYY-MM-DD.md` OR `<issue-slug>.json` (naia-adk pattern). On archive: move only (no rename).
- **archive_unit**: Archive MD/JSON pair together (same base name). JSON `current_phase != close` → close/unbind before move.
- **inbound_references**: Default = allow link breakage on archive. On case-by-case: 1-line stub at original path. No automatic index (over-engineering).
- **harness_scope_asymmetry**: session-inject collects cwd + IMMEDIATE child subdirs only. 2nd-level subs not scanned. commit-guard scans cwd only. Policy applies repo-wide as convention but ENFORCEMENT = root + direct children. 2nd-level subs need own hooks.
- **session_map_cleanup**: archive 시 `.agents/progress/.session-map.json` stale → session-inject 자가 정리하나 명시적 cleanup 권장.

### git_workflow

- **maintainer_rule**: Luke is a maintainer of all Nextain repos. NEVER create PRs for Nextain repos — commit and push directly to main (or the relevant branch). PRs are for external contributors only.
- **pr_prohibition**: DO NOT run `gh pr create` for nextain/* repos. The pr-guard hook will block this automatically.

### external_repo_policy

- **principle**: Information gathering first — before any action on external repos

#### steps

- 1. Read CONTRIBUTING.md / contributing guide of the external repo
- 2. Search existing issues and PRs to avoid duplicates
- 3. Study code patterns and conventions used in the repo
- 4. Prototype and validate internally before reaching out
- 5. Draft issue/PR content and show to user for review
- 6. Get explicit user approval before posting anything
- **community_context_first**: Before engaging in any external community (repo, Discord, Slack, forum, etc.), gather context first: (1) communication tone — formal/casual, terse/verbose, (2) explicit rules — CoC, PR/issue templates, labeling conventions, (3) community tendencies — what they value, what they reject, how they respond to outsiders, who the influential members are, what past interactions look like
- **rule**: Never post issues, PRs, or comments to external repos without explicit user approval of the reviewed content
- **tone_matching**: Technical issues and PRs are read by people. Write in a tone that fits the community's atmosphere — not just technically correct, but culturally appropriate. A dry RFC-style community expects concise technical prose; a friendly community expects warmth. Match the room.
- **ai_disclosure**: When posting AI-assisted content to external repos, always include a disclosure footer: state it was written with AI assistance AND provide a contact point for the developer in case of issues (e.g. '🤖 Written with AI assistance. If anything looks off, please ping @luke-n-alpha or open a discussion.'). Transparency and accountability both required. [HOOK-ENFORCED 2026-05-16: .claude/hooks/pr-guard.js — 외부 repo content op(gh issue/pr create·comment, pr review, release create) 시 disclosure footer(🤖/AI assistance) 미포함이면 차단(OSS-access 마커 소비 전). 내부 nextain/* 면제. merge/reopen/edit 등 비-content op 면제.]

### contribution_fork_policy

- **account**: Use nextain org (e.g. nextain/vllm) — this is an official Nextain-backed contribution, not a personal side project
- **naming**: Same name as upstream repo — no prefix
- **readme_required**: Every contribution fork MUST have a README clearly stating: (1) this is a contribution fork, not a hard fork, (2) upstream repo link, (3) what feature/fix is being contributed, (4) current status (in progress / PR submitted / merged), (5) contact: @luke-n-alpha
- **repo_description**: Set GitHub repo description to: 'Contribution fork — [feature] upstream PR in progress. See [upstream url]'

#### branch_strategy

- **main**: fork main = upstream main + AGENTS.md (AI context, version controlled here)
- **feature**: feature branch = based on upstream main, code changes only — NEVER add AGENTS.md here
- **pr**: PR = feature branch → upstream. AGENTS.md is on main only, so it is automatically excluded from the PR diff
- **main_sync**: Keep main branch in sync with upstream at all times (rebase or merge upstream main regularly)
- **work_branch**: All work on feature branches only (e.g. feat/minicpm-audio-output)
- **lifecycle**: Archive or delete after upstream PR is merged

## cascadeRules

- **_description**: When context changes, propagate to related modules.

### onSubmoduleAdd

- **trigger**: New submodule added

#### propagateTo

- parent

#### actions

- Add entry to parent/.gitmodules
- Add entry to parent/.agents/context/agents-rules.json submodules
- Update parent/CLAUDE.md submodule table
- Add category to parent/.agents/context/ai-work-index.yaml (if needed)

### onSubmoduleRemove

- **trigger**: Submodule removed

#### propagateTo

- parent

#### actions

- Remove from parent/.gitmodules
- Remove from parent/.agents/context/agents-rules.json submodules
- Remove from parent/CLAUDE.md submodule table

### onRulesChange

- **trigger**: .agents/context/agents-rules.json changed

#### propagateTo

- mirror

#### actions

- Sync update .users/context/agents-rules.md (1:1 mirroring)

### onEntryPointChange

- **trigger**: CLAUDE.md or AGENTS.md or GEMINI.md changed

#### propagateTo

- self

#### actions

- Copy the changed file to the other two (CLAUDE.md = AGENTS.md = GEMINI.md, always identical)

### propagationOrder

- **_description**: Propagation order (dependency order)

#### order

- 1. self — complete own changes
- 2. parent — update parent context
- 3. siblings — update referencing sibling modules
- 4. children — update referencing child modules
- 5. mirror — sync .users/

## workflows

- **instruction**: Read workflows on demand. Do not load all at once.

### selection_guide

- **reference**: .agents/context/ai-work-index.yaml

#### steps

- Extract keywords from the user request
- Match the category in ai-work-index.yaml
- Read the matching root quick reference first
- Load the workflow document only if the task still needs details

### index

- **submodule_init**: git submodule update --init --recursive
- **development_cycle**: .agents/workflows/development-cycle.yaml
- **issue_driven_development**: .agents/workflows/issue-driven-development.yaml
