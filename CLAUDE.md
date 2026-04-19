<!-- Copyright 2026 Nextain Inc. All rights reserved. -->

# Naia ADK

Nextain's AI business operations workspace (`nextain/naia-adk`).
naia-adk is the foundation for AI-driven business operations — skills, runtime, and company data.

## Mandatory Reads

**Read these files at the start of every session:**

1. `.agents/context/agents-rules.json` — Project rules (SoT)
2. `.agents/context/ai-work-index.yaml` — Work type → workflow index
3. `.agents/context/project-index.yaml` — Submodule entry points

**On-demand (read when entering Plan or Review phases):**

4. `.agents/requirements/_index.yaml` — Product requirements index
5. `.agents/context/skills-index.yaml` — Skill trigger/summary index (SKILL.md 재로드 방지)

## Project Structure

### Workspace Directories

| Directory | Tier | Purpose |
|-----------|------|---------|
| `data-company/` | T2 | Company general data |
| `data-business/` | T3 | Company sensitive data |
| `data-private/` | T3 | Personal data |
| `projects/` | T2 | Project repos (submodules) |
| `projects/refs/` | T2 | Reference repos (read-only) |
| `skills/` | T1 | naia-adk + business pack skills |
| `packages/` | T1 | Runtime packages (future) |
| `scripts/` | T1 | PDF/sign engine, tools |
| `templates/` | T1 | Document templates |
| `docs/` | T1 | Architecture, specs |

### Projects (in projects/)

| Project | Purpose | Repo | Public | Entry Point |
|---------|---------|------|:------:|-------------|
| `naia-os` | Naia OS desktop app (Tauri 2 + React + Node.js Agent) | `nextain/naia-os` | yes | `naia-os/AGENTS.md` |
| `about.nextain.io` | Nextain corporate site (Next.js 14 + next-intl) | `nextain/about.nextain.io` | yes | `about.nextain.io/README.md` |
| `naia.nextain.io` | Naia web app / Lab portal (Next.js + BFF) | `nextain/naia.nextain.io` | no | `naia.nextain.io/AGENTS.md` |
| `aiedu.nextain.io` | AI education platform | `nextain/aiedu.nextain.io` | no | `aiedu.nextain.io/AGENTS.md` |
| `admin.nextain.io` | Nextain B2B admin control plane | `nextain/admin.nextain.io` | no | `admin.nextain.io/AGENTS.md` |
| `9router` | Free AI Router dashboard | `decolua/9router` | yes | `9router/README.md` |
| `cafelua.com` | Cafelua personal website | `luke-n-alpha/cafelua-private` | no | `cafelua.com/README.md` |
| `project-any-llm` | Any-LLM SDK + FastAPI Gateway | `nextain/any-llm` | yes | `project-any-llm/README.md` |

### Data Submodules

| Submodule | Location | Repo | Tier |
|-----------|----------|------|------|
| `docs-nextain` | `data-company/docs-nextain/` | `nextain/docs-nextain` | T2 |
| `docs-work-logs` | `data-company/docs-work-logs/` | `nextain/docs-work-logs` | T2 |
| `docs-business` | `data-business/docs-business/` | `nextain/docs-business` | T3 |
| `accounting` | `data-business/accounting/` | `nextain/nextain-accounting` | T3 |

### Reference Repos (in projects/refs/)

| Submodule | Purpose | Source |
|-----------|---------|--------|
| `ref-cline` | Cline upstream (VS Code AI extension) | [cline/cline](https://github.com/cline/cline) |
| `ref-opencode` | OpenCode (TUI AI coding agent) | [anomalyco/opencode](https://github.com/anomalyco/opencode) |
| `ref-moltbot` | Moltbot | [moltbot/moltbot](https://github.com/moltbot/moltbot) |
| `ref-project-airi` | AIRI (AI character project) | [moeru-ai/airi](https://github.com/moeru-ai/airi) |
| `ref-jikime-adk` | Jikime ADK (Agent Development Kit) | [jikime/jikime-adk](https://github.com/jikime/jikime-adk) |
| `ref-jikime-mem` | Jikime Memory | [jikime/jikime-mem](https://github.com/jikime/jikime-mem) |
| `ref-openclaw` | NanoClaw (lightweight AI agent framework) | [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) |
| `ref-cc` | Claude Code CLI | Extracted (Anthropic) |
| `nextain/titanoboa` | Naia OS Live ISO builder | yes | `ublue-os/titanoboa` fork |
| `nextain/member-template` | Member workspace template | no | New member onboarding |

**Important**: When working in a submodule, read its entry point file first.

### Context Structure Differences

Projects differ in context structure. Read each project's entry point to confirm.

| Project | Mirroring | `.users/` default lang | Note |
|---------|-----------|:----------------------:|------|
| Root (this workspace) | dual (`.agents/` ↔ `.users/`) | Korean (`en/` subfolder) | |
| `naia-os` | **triple** (`.agents/` ↔ `.users/` EN ↔ `.users/ko/`) | English (`ko/` subfolder) | Public, community i18n |
| `naia.nextain.io` | dual (`.agents/` ↔ `.users/`) | Korean | |
| `cafelua.com` | dual (`.agents/` ↔ `.users/`) | Korean | `public-home/` has standalone CLAUDE.md |
| `docs-*` | dual (`.agents/` ↔ `.users/`) | Korean | |
| `about.nextain.io`, `project-any-llm` | none | — | Simple projects |

## Submodule Init

```bash
git submodule update --init --recursive
```

## Development Process

### Feature Development (default) — Issue-Driven Development

For feature-level work (new features, broad bug fixes). **Recognize these 14 phases at every session start.**

1. **Issue** — Create or receive GitHub Issue (English)
2. **Understand** — Summarize understanding, get user confirmation (gate)
3. **Scope** — Define investigation scope/depth, user approval (gate)
4. **Investigate** — Code-centric investigation within confirmed scope
5. **Plan** — Comprehensive plan based on ALL findings, user approval (gate)
6. **Build** — Implement according to approved plan
7. **Review** — Iterative review after each phase + full review after all phases (repeat until TWO consecutive clean passes) → run `/verify-implementation`
8. **E2E Test** — Run actual app/server, targeted tests first then full suite (.env for test data, ask user if missing)
9. **Post-test Review** — Re-review after tests pass (repeat until TWO consecutive clean passes) → run `/verify-implementation`
10. **Sync** — Update `.agents/` + `.users/` context, reflect lessons learned → run `/manage-skills` → user confirmation (gate)
11. **Sync Verify** — Verify context accuracy (repeat until TWO consecutive clean passes)
12. **Report** — Summarize results to user
13. **Commit** — If in worktree: use `/merge-worktree`. Otherwise: commit referencing Issue number, create PR
14. **Close** — Lessons learned 재검토 + phase-by-phase 완료보고를 이슈 댓글로 작성 + 사용자 확인 후 close (gate)

**"Iterative review"**: re-read files, find issues, fix, re-read again — repeat **until TWO consecutive passes find no changes**. NOT a single pass.

**Iterative review applies at 5 points:**
1. After **Plan** — review plan before build
2. After each **Build** phase — per-phase code review + test
3. After all **Build** phases — full code review across all changes
4. After **E2E Test** — post-test full code review
5. After **Sync** — context mirror accuracy verification

**Plan phase splitting**: Split phases by testable boundaries. Each phase MUST define its verification method (build check, unit test, E2E, manual, file review). Never group untestable and testable work in the same phase. If a phase cannot be tested locally, note it explicitly.

**Context file change rule:** When modifying `.agents/workflows/*.yaml`, `.agents/skills/*/SKILL.md`, `.agents/context/*.json`, hooks, or their `.users/` mirrors — write a validation test and run it BEFORE committing. Validate: YAML parse, required sections present, `.agents` ↔ `.users` mirror consistency, referenced file existence. A diff match alone is NOT sufficient.

**Principles:** Read upstream code first (no guessing). Minimal modification (no reinvention). Never break working code. Propose improvements, never decide autonomously.

**Context survival (anti-compact):** Do NOT rely on conversation memory for important decisions. Write investigation findings, plan, and user corrections to durable storage (GitHub Issue comments, files) immediately. Context compaction WILL erase conversation history during long feature work.

**Progress file (MANDATORY):** At every phase transition, write/update `.agents/progress/{issue-slug}.json`. This file is auto-injected into every conversation turn by the `session-inject` harness hook — it is your lifeline after context compression.

```json
{
  "issue": "#51 STT/TTS Provider Registry",
  "issue_url": "https://github.com/nextain/naia-os/issues/51",
  "current_phase": "build",
  "gates_cleared": ["understand", "scope", "plan"],
  "current_task": "Dynamic voice fetch",
  "key_decisions": ["Provider registry pattern", "STT first then TTS"]
}
```

Valid `current_phase` values: `issue` → `understand` → `scope` → `investigate` → `plan` → `build` → `review` → `e2e_test` → `post_test_review` → `sync` → `sync_verify` → `report` → `commit` → `close`

Details: `.agents/workflows/issue-driven-development.yaml`

### End of EVERY session (mandatory)

Purpose: ensure the NEXT session's AI inherits everything learned in THIS session.

Before ending any session, ALWAYS:
1. Update context files with any new knowledge (.agents/ ↔ .users/ ↔ CLAUDE.md)
2. Record lessons-learned if corrections or mistakes occurred during this session
3. Update MEMORY.md if session-specific technical context should persist
4. Commit and push all changes

This is NOT just "save your work." This is "transfer your learning to the next AI session."
Do NOT wait for user to ask. Do this automatically when the session is ending.

### Simple Changes (lightweight cycle)

For non-feature changes: typos, config values, simple directives. Details: `.agents/workflows/development-cycle.yaml`

## Key Commands

### Claude Code Monitoring
- `python3 scripts/cc-monitor.py` : Run monitor & send alerts if over limit. (Exits immediately if snoozed)
- `python3 scripts/cc-monitor.py --status` : Check status only.
- `python3 scripts/cc-monitor.py --snooze reset` : **Mute until next reset (Fri 15:59 or Sun 09:59).** (Hard silences the timer)
- `python3 scripts/cc-monitor.py --snooze 18:00` : Mute until specific time today.
- `python3 scripts/cc-monitor.py --unsnooze` : Reactivate alerts immediately.

### naia-os (Desktop App)
```bash
cd projects/naia-os/shell
pnpm run dev              # Shell dev server (Vite)
cd projects/naia-os/shell && pnpm run tauri:dev  # Tauri app
cd projects/naia-os/agent && pnpm test           # Agent tests
```

### project-any-llm (LLM Gateway)
```bash
cd projects/project-any-llm
pip install -e ".[all,gateway]"           # Install deps
any-llm-gateway serve --config config.yml # Run gateway
docker compose -f docker/docker-compose.yml up  # Docker
```

## Skills

프로젝트 전용 Claude Code 스킬. **SoT: `.agents/skills/`** — `.claude/skills/`는 심링크. `verify-*` 스킬은 `/manage-skills`가 자동 추가/관리.

| 스킬 | 설명 | 관리 |
|------|------|------|
| `merge-worktree` | 워크트리 → main 스쿼시 머지, 코드 분석 기반 시맨틱 커밋 생성 | 수동 (phase 13) |
| `review-pass` | 4단계 멀티 AI 상호검증 리뷰 (planning/development/test/integration, REQ-ID 추적) | 자동 (phase 7, 9) |
| `verify-implementation` | 등록된 모든 `verify-*` 스킬 순차 실행, 통합 검증 보고서 생성 | 자동 (phase 7, 9) |
| `manage-skills` | 세션 변경사항 분석, `verify-*` 스킬 생성/업데이트, CLAUDE.md 관리 | 자동 (phase 10) |
| `read-doc` | HWP/HWPX/PDF/DOCX/XLSX/PPTX 텍스트 추출 → AI 컨텍스트 로드 | 수동 |
| `webapp-testing` | Playwright로 naia.nextain.io 등 로컬 웹 앱 E2E 테스트, 스크린샷, 콘솔 로그 캡처 | 수동 |
| `weekly-report` | Nextain 프로젝트 기준 주간 업무 결과 마크다운 초안 생성 | 수동 |
| `doc-coauthoring` | 기술 스펙/제안서/RFC 등 구조화된 문서 3단계 공동 작성 워크플로우 | 수동 |
| `patent-draft` | KIPO 전자출원 양식 기반 특허 명세서 초안 생성 (한글+영문 발명의 명칭 포함) | 수동 |
| `md-to-pdf` | Markdown → PDF 변환 (Mermaid 다이어그램 렌더링 포함). 특허문서·제안서·보고서 PDF 출력 시 사용 | 수동 |
| `patent-pipeline` | 코드베이스 AI 분석 → 특허 후보 발굴 → 가치평가 → 선행기술 조사 → 가출원 초안 생성. 헤드리스 반복 리뷰 + 이력 DB 학습 | 수동 |
| `copyright-reg` | 어문저작권 등록 서류 생성 — 업무상저작물 확인서 PDF(넥스테인 브랜딩) + 저작권등록신청명세서 내용란 초안 | 수동 |
| `press-release` | 보도자료 배포 풀 사이클 — 기자 조사·개인화 발송·결과 수집·인사이트. 하네스 가드로 외부 발송 차단 | 수동 |

## Directory Structure (Dual-directory Architecture)

> This is the **root workspace** structure. Projects may differ — see [Context Structure Differences](#context-structure-differences) above.

```
.agents/                    # AI-optimized (English, token-efficient)
├── context/
│   ├── agents-rules.json   # Main rules (SoT) ← mandatory read
│   └── ai-work-index.yaml  # Work index ← mandatory read
├── workflows/              # On-demand workflows
├── commands/               # Slash commands
├── hooks/
└── skills/                 # Skill definitions (SoT) ← see ## Skills section

.users/                     # Human-readable (Korean, detailed)
├── context/
│   ├── agents-rules.md     # Rules guide
│   └── ai-work-index.md    # Work index guide
├── workflows/
├── commands/
├── hooks/
└── skills/                 # .agents/skills/ mirror (symlinks)

.claude/                    # Claude Code configuration
├── settings.json           # Hooks registration
├── hooks/                  # PostToolUse hooks (entry-point sync, cascade check, commit guard)
└── skills/                 # Symlinks → .agents/skills/ (Claude Code entry point)
```

## Pre-commit Checklist for Web Projects (MANDATORY)

Before every commit/push on any web project (about/naia/aiedu/admin.nextain.io, home.onmam.com):

1. Run the dev server and confirm it is up (see each project's CLAUDE.md for port)
2. Directly verify modified pages u2014 200 OK + normal rendering (browser or curl)
3. If `.next` cache is suspected corrupt: `rm -rf .next` and restart
4. `npx tsc --noEmit --skipLibCheck` u2014 no new errors introduced by our changes
5. **Push only after explicit user approval** u2014 committing is OK, but always ask before pushing

> Why: 2026-04-07 u2014 pushed about.nextain.io with corrupt `.next` cache, site went fully down

## Core Principles

1. **1:1 Mirroring**: `.users/` mirrors `.agents/` structure exactly
2. **SoT**: `.agents/context/agents-rules.json` is the single source of truth
3. **Response language**: Contributor's preferred language (maintainer Luke: Korean)

## Conventions

- **Development**: Issue-driven development (default). TDD where applicable.
- **Work logs**: Don't modify unless explicitly requested.

## Work Logs

Work logs go in `data-company/docs-work-logs/` submodule.

### Rules
- **Filename**: `YYYYMMDD-{number}-{topic}.md`
- **Folders**: `todo/`, `doing/`, `done/`
- **Dates**: Record date at each work phase
- **Language**: Korean preferred

### References
- `data-company/docs-work-logs/AGENTS.md`
- `data-company/docs-work-logs/.agents/context/agents-rules.json`

## Cascade Rules (Context Propagation)

When context changes, propagate to related modules. Details: `.agents/context/agents-rules.json` → `cascadeRules`.

| Trigger | Propagate To |
|---------|-------------|
| Submodule added | parent context |
| Submodule removed | parent context |
| Rules file changed | .users/ mirror |
| CLAUDE.md / AGENTS.md / GEMINI.md changed | self (copy to other two) |

**Order**: self → parent → siblings → children → mirror

**Entry point files**: `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` are always identical. When one changes, copy to the other two.

## Parallel Session File Lock

Prevents file conflicts when multiple Claude sessions work in `/home/luke/dev/`.

**Lock file**: `/home/luke/dev/.claude/file-locks.json`

### Rules
1. **Session start**: Read lock file, note locked files
2. **Before edit**: If file locked by another session, notify user instead of editing
3. **Lock register**: Register in `locks` when starting to edit (owner = branch name)
4. **Unlock**: Remove lock when work is done
5. **Free list**: Files in `free` array can be freely created/modified by anyone
6. **CSS rule**: Even locked CSS files allow adding classes with unique prefix

## Confidential

Copyright 2026 Nextain Inc. All rights reserved. Internal use only.

Public projects (naia-os, any-llm, etc.) are licensed per their respective repos.
