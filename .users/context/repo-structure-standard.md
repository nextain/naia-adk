# 레포 구조 표준 (Repo Structure Standard)

> **언어**: [English](en/repo-structure-standard.md) · 한국어 (이 파일)
> **AI SoT**: `.agents/context/repo-structure-standard.yaml`
> **버전**: 1.0 (2026-05-27)
> **상속**: naia-adk → naia-business-adk → {org}-adk → {user}-adk

---

## 개요

naia-adk 생태계 전체 레포의 **문서 구조 · SDLC 산출물 · RBAC** 표준.
이 파일은 `agents-rules.yaml` SoT의 한국어 mirror입니다.

fork 커스터마이즈: 포크 루트에 `FORK.md` 생성 → `overrides:` 섹션으로 덮어쓰기.

---

## 1. 레포 타입

| 타입 | 대표 레포 | 설명 |
|------|----------|------|
| `workspace_adk` | naia-adk, alpha-adk, {org}-adk | 개발자가 작업하는 최상위 워크스페이스 |
| `runtime_library` | naia-agent, naia-memory | 호스트가 사용하는 런타임/라이브러리 패키지 |
| `app_os` | naia-os | 커뮤니티 기여자가 있는 사용자 향 전체 앱/OS |

### workspace_adk 필수 디렉토리

```
.agents/context/       ← AI SoT (agents-rules.json + project-index.yaml 필수)
.users/context/        ← 한국어 human mirror (기본값)
```

### runtime_library 필수 디렉토리

```
.agents/context/       ← AI SoT
docs/                  ← 영어 SoT (human 1차 문서)
.users/docs/ko/        ← 한국어 mirror
```

### app_os 필수 디렉토리

```
.agents/context/
.users/context/        ← 영어 mirror (1차)
.users/context/ko/     ← 한국어 mirror
```

---

## 2. 미러 패턴

| 패턴 | 적용 대상 | 레이어 |
|------|----------|--------|
| **dual** | workspace_adk (private fork) | `.agents/context/` (AI) ↔ `.users/context/` (human) |
| **triple** | app_os, public 베이스 (naia-adk 자체) | `.agents/` ↔ `.users/context/` (영어) ↔ `.users/context/ko/` (한국어) |
| **split** | runtime_library (naia-agent 패턴) | `.agents/` ↔ `docs/` (영어 SoT) ↔ `.users/docs/ko/` (한국어) |

**규칙 (split 패턴)**: 항상 영어 원본(`docs/`) 먼저 수정 후 한국어 mirror 동기화.

---

## 3. Multi-tool Harness

`AGENTS.md`(canonical) = `CLAUDE.md` = `GEMINI.md` = `OPENCODE.md` = `CODEX.md`

- `AGENTS.md`만 편집. `scripts/sync-harness-mirrors.sh` 또는 pre-commit hook이 나머지 동기화.
- 초기 레포: 3개(AGENTS/CLAUDE/GEMINI)만 있어도 허용.

---

## 4. SDLC 산출물 라이프사이클

### `.agents/progress/` — 작업 진행 기록

| 상태 | 위치 | 조건 |
|------|------|------|
| 진행 중 | `.agents/progress/` | 작업 중 |
| 완료 | `.agents/progress/archive/YYYY-MM/` | 객관적 신호 2건 이상 (PR merge + issue close + deploy 등) |

- gitignored (세션 로컬, 커밋 안 함)
- 파일 형식: `{issue-slug}-{YYYY-MM-DD}.md` + `.json` 쌍
- **AI 자가 완료 선언 금지** — 객관적 외부 신호 필수
- 30일 무갱신 시 사용자 결정

### `work-logs/{username}/` — 개발자 개인 기록

- gitignored, 언어 자유

### `.agents/work/` — 임시 작업 파일

- gitignored, 30일 후 사용자 결정(유지/아카이브/삭제)

---

## 5. RBAC 티어

### naia-adk 기본 (T0~T3)

| 티어 | 이름 | 디렉토리 예시 |
|------|------|-------------|
| T0 | public | `skills/`, `scripts/`, `docs/`, `.agents/context/` |
| T1 | org-general | `data-company/`, `projects/` |
| T2 | org-sensitive | `data-teams/` |
| T3 | private | `data-private/` |

T1~T3은 gitignored (포크별 데이터, upstream에 커밋 안 함).

### naia-business-adk 확장

| 추가 | 티어 | 디렉토리 |
|------|------|---------|
| 팀 문서 | T2 | `data-teams/` |
| 비즈니스 스킬 | T1 | `skills/business/` |

---

## 6. 다중 프로젝트 관리

`{user}-adk` / `{org}-adk` 워크스페이스에서 `projects/` 아래 여러 서브프로젝트 레포를 관리할 때:

- **진입 전 필수 읽기**: `projects/<name>/` 진입 전 해당 프로젝트의 `AGENTS.md` 반드시 읽을 것 (blocking 규칙)
- **세션 중 전환**: 서브프로젝트 전환 시 새 프로젝트의 mandatory reads 재실행
- **루트 CLAUDE.md 대체 불가**: 루트 컨텍스트는 서브프로젝트 컨텍스트를 대체하지 않음
- `projects/refs/` — 읽기 전용 upstream 레퍼런스; 편집 금지
- 인덱스: `.agents/context/project-index.yaml` (포크별 관리)

---

## 7. Fork 커스터마이즈

`FORK.md` (포크 루트에 생성):

```markdown
# FORK.md
org_name: ...
default_lang: ko      # .users/ mirror 기본 언어
fork_type: user-adk   # org-adk | user-adk

overrides:
  rbac_tiers:
    T2:
      dirs: [data-teams/, data-finance/]  # 추가 디렉토리
```

**우선순위** (높을수록 우선):

```
{user}-adk FORK.md (최우선)
{org}-adk FORK.md
naia-business-adk 추가 정의
naia-adk 기본값 (이 파일)
```
