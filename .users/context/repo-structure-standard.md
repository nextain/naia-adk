# 레포 구조 표준 (Repo Structure Standard)

> **언어**: 한국어 (이 파일) · [English](en/repo-structure-standard.md)
> **AI SoT**: `.agents/context/repo-structure-standard.yaml`
> **버전**: 1.0 (2026-05-27)
> **적용 계보**: naia-adk 직접 개인 포크 또는 선택적 조직 계보(naia-business-adk → {org}-adk → {user}-adk)

---

## 언어 기본 / 오버라이드

기본: 공개 OSS 레포는 영어-primary로 문서화하고, 메인테이너·사용자 포크는 메인테이너 언어를 기본으로 사용합니다.

**`naia-adk` 공개 기준선의 실제 파일 규칙 (2026-06-22)**:
- `README.md`는 한국어, `README.en.md`는 영어입니다.
- `AGENTS.md`는 영어 canonical 인덱스이고 `CLAUDE.md`와 `GEMINI.md`는 `@AGENTS.md` 한 줄 포인터입니다.
- `.users/context/`는 한국어 human guide, `.users/context/en/`은 영어 human guide입니다.

`naia-memory`는 자체 저장소 규칙을 따르며 이 표준의 override 대상이 아닙니다.

---

## 개요

naia-adk 생태계 전체 레포의 **문서 구조 · SDLC 산출물 · RBAC** 표준.
이 파일은 `.agents/context/repo-structure-standard.yaml` SoT의 한국어 mirror입니다.

fork 커스터마이즈: 포크 루트에 `FORK.md` 생성 → `overrides:` 섹션으로 덮어쓰기.

---

## 1. 레포 타입

| 타입 | 대표 레포 | 설명 |
|------|----------|------|
| `workspace_adk` | naia-adk, naia-business-adk, {org}-adk, {user}-adk | 개발자가 작업하는 최상위 워크스페이스 |
| `runtime_library` | naia-agent, naia-memory | 호스트가 사용하는 런타임/라이브러리 패키지 |
| `app_os` | naia-os | 커뮤니티 기여자가 있는 사용자 향 전체 앱/OS |

### workspace_adk 필수 디렉토리

```
.agents/context/       ← AI SoT (agents-rules.json + project-index.yaml 필수)
.users/context/        ← 한국어 human guide
.users/context/en/      ← 영어 human guide
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
| **triple** | app_os | `.agents/` ↔ `.users/context/` (영어) ↔ `.users/context/ko/` (한국어) |
| **public_workspace_adk** | 공개 workspace_adk 기준선(naia-adk) | `.agents/context/` (영어 기계 원본) ↔ `.users/context/` (한국어) ↔ `.users/context/en/` (영어) |
| **split** | runtime_library (naia-agent 패턴) | `.agents/` ↔ `docs/` (영어 SoT) ↔ `.users/docs/ko/` (한국어) |

**규칙 (split 패턴)**: 항상 영어 원본(`docs/`) 먼저 수정 후 한국어 mirror 동기화.

---

## 3. Multi-tool Harness

`AGENTS.md`가 canonical이고 `CLAUDE.md`와 `GEMINI.md`는 `@AGENTS.md` 한 줄 포인터입니다.

- `AGENTS.md`만 편집합니다.
- 검사: `node .claude/hooks/sync-entry-points.js --check`
- 동기화: `node .claude/hooks/sync-entry-points.js` (지원되는 미러만)
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

직접 개인 포크는 조직 계보를 거치지 않고 `naia-adk` 기본값을 사용합니다. 조직 계보를 선택한 경우에만 조직 레이어가 추가됩니다.

**우선순위** (높을수록 우선):

```
{user}-adk FORK.md (최우선)
{org}-adk FORK.md
naia-business-adk 추가 정의
naia-adk 기본값 (이 파일)
```
