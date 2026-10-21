---
name: project-create
description: >
  단일 통합 naia-adk v0.2.0의 자동 프로젝트 스캐폴더(adk-scaffold-project.mjs) 및
  template-project(AI self-trust 하네스 base)로부터 새 프로젝트(project ADK)를 scaffold하고,
  PC→SP/UC→RQ→FE→[UT→IT→E2E]→QC 명세 사슬 + 요구사항 추적표 + D47 디버그 로거 +
  인터랙티브 Mermaid 스튜디오 뷰어를 자동 생성한 뒤 정본 GitHub 레포 생성 및 링크/submodule 등록까지 수행.
  "새 프로젝트 만들어줘", "새 레포 scaffold", "프로젝트 부트스트랩", "template-project로 시작" 요청 시 반드시 사용.
argument-hint: "[프로젝트명] [한 줄 설명]"
---

# project-create (naia-adk v0.2.0 통합 프로젝트 ADK 스캐폴딩)

## 목적

단일 통합 `naia-adk` v0.2.0의 **`scripts/adk-scaffold-project.mjs`**(`templates/project-skeleton/`)와 `nextain/naia-template-project`(self-trust 하네스 base)를 결합하여 **새 `project` ADK를 명령 한 줄로 표준에 맞게 자동 생성**한다.
수동으로 명세 문서나 서버·로거를 만들지 않고 다음 핵심 구성을 결정론적으로 자동 생성한다:
- `adk.json` (`kind: "project"`, `adk_version: "0.2.0"`, `owner`, `responsible_human` 필수, `keys/` 격리)
- `docs/specs/00-USER-REQUESTS-traceability.ko.md` 및 `PC → SP/UC → RQ → FE → [UT → IT → E2E] → QC` 표준 명세 사슬과 `PC` 다음에 읽는 동작 구조·개념 설명(`08-AC-architecture-concepts.ko.md`)까지 9종
- `scripts/validate-spec-chain.mjs` (요구사항·명세·테스트·QC 양방향 추적 및 마크다운 내부 링크 무결성 결정론 검증기)
- `src/debug-logger.mjs` (링버퍼 `MAX=200`, 글로벌 `error`/`unhandledrejection` 자동 포착, `window.__DEBUG__` API — D47 원칙)
- `scripts/dev-server.mjs` + `scripts/lib/mermaid-viewer-client.mjs` (`/docs` + `/play` 통합 스튜디오 서버 및 `wirePanZoom` 마우스 휠 줌/드래그 팬, `+`/`-`/`100%`/`⛶` 툴바, `openMermaidModal` 전체화면 모달·`Esc` 닫기 지원 모듈)

**핵심 원칙**
- 명세 사슬(`PC→SP/UC→RQ→FE→QC`)·추적표·디버그 로거·Mermaid 문서 뷰어는 손으로 만들지 않고 반드시 **`adk-scaffold-project.mjs`**로 자동 생성한다.
- 모든 ADK는 `owner`(소유)와 `responsible_human`(책임자 사람, 비어 있으면 즉시 실패)을 필수로 가진다.
- `keys/`는 소유 ADK 안에만 격리하며 절대 심볼릭 링크하거나 git 동기화하지 않는다.
- 부트스트랩 직후 `validate-spec-chain.mjs`와 `adk-link.mjs --check`가 모두 통과해야 "생성 완료"로 본다(AI 자가-선언 금지).

## 입력 (수집 후 GATE)

| 항목 | 설명 | 기본값 |
|------|------|--------|
| `name` | 레포/프로젝트명 (kebab-case 권장) | (필수) |
| `description` | 한 줄 설명 (`{{PROJECT_DESCRIPTION}}`에 들어감) | (필수) |
| `owner` | 소유 조직 또는 유저 식별자 (`nextain`, `alice` 등) | `nextain` |
| `responsible_human` | 책임자 사람 식별자 (**비어 있으면 실패 — 필수**) | `alice` |
| `visibility` | `private` \| `public` | `private` |
| `repo_type` | `workspace_adk` \| `runtime_library` \| `app_os` | `app_os` |
| `target` | `standalone`(독립 레포만) \| `submodule` \| `adk-link`(상대 경로 소프트링크 연결) | `adk-link` |

**[GATE]** 위 표를 채워 사용자에게 보여주고 확인받은 뒤 진행.

## 워크플로우

### Step 1 — `adk-scaffold-project.mjs`로 프로젝트 ADK 뼈대 자동 생성 (필수)

수동 파일 생성 대신 아래 명령 한 줄로 `adk.json`, `docs/specs/`(`00-USER-REQUESTS-traceability.ko.md` + `PC/AC/SP/UC/RQ/FE/UT-IT-E2E/QC`), `scripts/validate-spec-chain.mjs`, `src/debug-logger.mjs`, `scripts/dev-server.mjs`, `scripts/lib/mermaid-viewer-client.mjs`를 자동 생성한다:

```bash
node projects/naia-adk/scripts/adk-scaffold-project.mjs \
  --target <target-dir> \
  --name "<name>" \
  --owner "<owner>" \
  --responsible "<responsible_human>" \
  --description "<description>"
```

> `naia-adk` 루트 내부에서 실행할 때는 `node scripts/adk-scaffold-project.mjs ...`로 실행한다.

### Step 2 — (선택) `naia-template-project` 하네스 훅 결합 시

전체 115개 self-trust 하네스 훅이 함께 필요한 경우에만 `naia-template-project` base를 먼저 복제한 뒤, 그 위에 Step 1의 `adk-scaffold-project.mjs`를 실행해 `adk.json`과 `docs/specs/`, `src/debug-logger.mjs`, `scripts/dev-server.mjs`, `scripts/lib/mermaid-viewer-client.mjs`, `scripts/validate-spec-chain.mjs`를 얹는다:

```bash
git clone https://github.com/nextain/naia-template-project.git <target-dir>
rm -rf <target-dir>/.git
node <skill-dir>/scripts/scaffold.mjs --root <target-dir> --name "<name>" --description "<description>"
mv -f <target-dir>/README.template.md <target-dir>/README.md
rm -rf <target-dir>/about-docs
node projects/naia-adk/scripts/adk-scaffold-project.mjs \
  --target <target-dir> --name "<name>" --owner "<owner>" --responsible "<responsible_human>" --description "<description>"
```

### Step 3 — 같은 기기 내 ADK 상대 경로 소프트링크 연결 (`adk-link.mjs`)

유저 ADK 또는 조직 ADK에 새 프로젝트 ADK를 붙일 때는 상대 경로 소프트링크 도구를 사용한다(`keys/`는 절대 링크하지 않음):

```bash
node projects/naia-adk/scripts/adk-link.mjs --link \
  --from <user-or-org-adk-dir> \
  --to <target-dir>
```

### Step 4 — 결정론적 검증 (자동, 모두 통과 필수)

생성 직후 명세 사슬·양방향 추적·마크다운 링크·디버그 로거·Mermaid 모듈 검증기와 ADK 무결성 점검을 실행한다:

```bash
# 1. 프로젝트 명세 사슬(PC→SP/UC→RQ→FE→UT/IT/E2E→QC) + 마크다운 링크 + 디버그 로거 + Mermaid 모듈 검증
node <target-dir>/scripts/validate-spec-chain.mjs

# 2. ADK 매니페스트(owner, responsible_human) + 상대 경로 소프트링크 + keys/ 격리 점검
node projects/naia-adk/scripts/adk-link.mjs --check <target-dir>
```

**검증 보고 형식:**
```
✅ ADK 매니페스트: kind=project, owner=<owner>, responsible_human=<responsible_human>, keys_isolated=true
✅ 명세 사슬 추적: 00-USER-REQUESTS + PC→SP/UC→RQ→FE→UT/IT/E2E→QC 양방향 추적 통과
✅ 마크다운 링크: 내부 링크 깨짐 0건
✅ 디버그 로거 & Mermaid 뷰어: src/debug-logger.mjs (MAX=200) & scripts/lib/mermaid-viewer-client.mjs 검증 통과
```

### Step 5 — 초기 commit 및 외부 push (필요 시)

```bash
cd <target-dir> && git init -b main
git add -A && git commit -m "feat: <name> 초기 — naia-adk v0.2.0 project ADK scaffold"
```

외부 신규 레포 push는 mass-export guard가 막을 수 있으므로 사용자에게 명령을 안내한다:
```bash
!cd <target-dir> && gh repo create <owner>/<name> --<visibility> --source=. --remote=origin --push
```

## Key Files

| 파일 | 용도 |
|------|------|
| `projects/naia-adk/scripts/adk-scaffold-project.mjs` | 새 `project` ADK 자동 스캐폴딩 CLI (`adk.json`, `docs/specs/`, 로거, 스튜디오 서버, 검증기 일괄 생성) |
| `projects/naia-adk/templates/project-skeleton/` | 프로젝트 ADK 정본 스켈레톤 템플릿 디렉토리 |
| `projects/naia-adk/scripts/adk-link.mjs` | 4종 ADK(`user`/`agent`/`project`/`org`) 매니페스트 검증(`--validate`), 상대 경로 소프트링크(`--link`), 키 격리·책임자 점검(`--check`) |
| `projects/naia-adk/schemas/adk-manifest.schema.json` | `adk.json` v0.2.0 통합 JSON 스키마 |
