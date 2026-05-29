---
name: project-create
description: >
  template-project(AI self-trust 하네스 base)로부터 새 프로젝트를 scaffold하고,
  정본 GitHub 레포 생성 + (선택) 현재 워크스페이스에 submodule 등록까지 수행.
  repo_type(workspace_adk/runtime_library/app_os)에 맞춰 mirror pattern·필수 디렉토리·.users 기본 언어를 자동 적용.
  "새 프로젝트 만들어줘", "새 레포 scaffold", "프로젝트 부트스트랩", "template-project로 시작" 요청 시 반드시 사용.
argument-hint: "[프로젝트명] [한 줄 설명]"
---

# project-create

## 목적

`nextain/naia-template-project`(self-trust 하네스 base — F12/F13 구조 강제 hooks,
SDLC 게이트, 4-tool mirror, 115개 테스트)를 출발점으로 **새 프로젝트를 표준에 맞게
부트스트랩**한다. 신규 레포 표준([[repo-structure-standard.yaml]])을 기계적으로
적용하여, 사람이 매번 디렉토리·미러·placeholder를 손으로 맞추는 실수를 없앤다.

**핵심 원칙**
- base는 손으로 복사하지 않는다 — GitHub template 또는 로컬 submodule에서 복제.
- placeholder 치환은 `scripts/scaffold.mjs`(결정론적)로만. AI 수기 치환 금지.
- 외부 신규 레포 push는 mass-export guard가 막을 수 있다 → 사용자 직접 실행 안내.
- 부트스트랩 직후 base의 115개 테스트가 통과해야 "생성 완료"로 본다(AI 자가-선언 금지).

## 입력 (수집 후 GATE)

| 항목 | 설명 | 기본값 |
|------|------|--------|
| `name` | 레포/디렉토리명 (kebab-case, repo-safe) | (필수) |
| `description` | 한 줄 설명 (`{{PROJECT_DESCRIPTION}}`에 들어감) | (필수) |
| `visibility` | `private` \| `public` | `private` |
| `repo_type` | `workspace_adk` \| `runtime_library` \| `app_os` | (필수) |
| `target` | `standalone`(독립 레포만) \| `submodule`(현재 워크스페이스 `projects/`에 등록) | `submodule` |
| `owner` | GitHub org/user | `nextain` |

`repo_type`이 결정하는 것 ([[repo-structure-standard.yaml]] 참조):

| repo_type | mirror pattern | .users 기본 언어 | 필수 디렉토리 |
|-----------|----------------|------------------|----------------|
| `workspace_adk`(private fork) | dual | fork default | `.agents/context/`, `.users/context/` |
| `runtime_library` | split | English(docs/) + ko mirror | `.agents/context/`, `docs/`, `.users/docs/ko/` |
| `app_os` | triple | English + ko | `.agents/context/`, `.users/context/`, `.users/context/ko/` |
| public workspace_adk base | triple | English | + `LICENSE`, `CONTRIBUTING.md` |

**[GATE]** 위 표를 채워 사용자에게 보여주고 확인받은 뒤 진행.

## 워크플로우

### Step 1 — base 복제

**Strategy A (권장, GitHub template):** `naia-template-project`가 GitHub에서
template repository로 표시되어 있으면 서버 측 복제 → 로컬 full-tree push 없음 → mass-export guard 회피.

```bash
gh repo create <owner>/<name> --<visibility> --template nextain/naia-template-project --clone
cd <name>
```

template 표시가 안 되어 있으면 한 번만: `gh repo edit nextain/naia-template-project --template`.

**Strategy B (위치 독립, GitHub clone):** 어느 워크스페이스·PC·컨텍스트에서도
동일하게 동작 — 정본 base를 GitHub에서 직접 clone (로컬 mount 경로에 의존하지 않음).

```bash
git clone https://github.com/nextain/naia-template-project.git <target-dir>
rm -rf <target-dir>/.git        # base 이력 분리 — 새 프로젝트는 자체 이력으로 시작
```

> 완전 오프라인이면 로컬 mount를 복사. 단 경로가 컨텍스트마다 다름:
> naia-adk 안에선 `projects/naia-template-project`, alpha-adk 루트에선
> `projects/naia-adk/projects/naia-template-project`. 가능하면 GitHub clone을 쓸 것.

### Step 2 — placeholder 치환 (결정론적)

base 전체의 `{{PROJECT_NAME}}` / `{{PROJECT_DESCRIPTION}}` / `{{DATE}}`를 치환.
**AI 수기 치환 금지 — 반드시 스크립트로.**

```bash
node <skill-dir>/scripts/scaffold.mjs --root <target-dir> \
  --name "<name>" --description "<description>"
# --date 생략 시 오늘 날짜 자동
```

스크립트가 치환한 파일 수를 보고. 남은 `{{...}}`가 0인지 확인:
```bash
grep -rn "{{[A-Z_]*}}" <target-dir> --include="*.md" --include="*.json" --include="*.yaml" || echo "치환 완료"
```

### Step 3 — repo_type별 mirror pattern 적용

위 입력 표의 mapping대로:
1. 필수 디렉토리 존재 확인/생성 (base는 dual 기준 — split/triple이면 `docs/`·`.users/context/ko/` 등 추가/조정).
2. `.users/` 기본 언어를 repo_type에 맞게 설정 (base는 한국어 기준).
3. 4-tool mirror 동기화: base는 `AGENTS.md`가 SoT, 나머지는 자동 생성.
   ```bash
   cd <target-dir> && bash scripts/sync-harness-mirrors.sh
   ```
4. (public) `LICENSE`(Apache 2.0) + `CONTRIBUTING.md` + `FORK.md` 추가.

### Step 4 — 초기 commit

```bash
cd <target-dir> && git init -b main   # Strategy B만 (A는 이미 git repo)
git add -A && git commit -m "feat: <name> 초기 — naia-template-project base scaffold"
```

### Step 5 — 외부 push (사용자 직접)

> ⚠️ Strategy B는 신규 외부 레포 full-tree push → **mass-export guard가 막는다**.
> AI가 우회하지 말 것. 사용자에게 명령을 제시하고 직접 실행 요청.
> (Strategy A는 이미 원격이 있으므로 일반 push.)

Windows `!` 셸은 bash라 백슬래시 경로가 깨진다 → **forward-slash 사용**:
```
!cd /d/<...>/ <target-dir> && gh repo create <owner>/<name> --<visibility> --source=. --remote=origin --push
```
PowerShell이면 `&&` 대신 `;`로 체인.

### Step 6 — (옵션) submodule 등록

`target=submodule`이면 [[project-migration]] **Mode A의 "submodule 등록" 서브절차**를
그대로 따른다 (push-first → 로컬 디렉토리 삭제 → `git submodule add --force` 재clone →
`.gitignore` force-add 표식 → 부모 레포 commit). in-place 변환 금지.

### Step 7 — 검증 (자동, 모두 통과 필수)

```bash
cd <target-dir>
# 115개 self-trust 테스트 — 각 파일을 직접 실행(CI 방식). node:test 프레임워크가
# 아니라 자체 assert 스크립트라 `node --test`로는 파일 수만 세고 실제 검증이 안 됨.
fail=0; for t in src/test/*.test.mjs; do node "$t" || fail=1; done; [ $fail -eq 0 ] && echo "✓ 전체 통과"
bash scripts/enforce-root-structure.sh          # F12/F13 구조 (--fix 없이 검사만)
bash scripts/sync-harness-mirrors.sh && git diff --exit-code   # mirror 동기화 멱등성
```

**검증 보고 형식:**
```
✅ 테스트: 115/115 통과
✅ 구조: F12/F13 위반 0
✅ mirror: AGENTS.md ↔ 4 mirror 동기화 (diff 없음)
✅ placeholder: 잔여 {{...}} 0
```

### Step 8 — 보고

레포 URL, submodule 경로(있으면), 검증 결과를 사용자에게 보고. push가 사용자
직접 단계로 남았으면 명령을 다시 제시.

## Key Files

| 파일 | 용도 |
|------|------|
| `scripts/scaffold.mjs` | placeholder 치환 (결정론적, 의존성 없음) |
| `nextain/naia-template-project` (GitHub) | 정본 base (Strategy A template / Strategy B clone 소스) |
| `projects/naia-template-project/` (로컬 mount) | 오프라인 복사용 fallback (경로는 컨텍스트 의존) |
| `.agents/context/repo-structure-standard.yaml` | repo_type → mirror/필수디렉토리 SoT |

## 참고

- base의 `structure-guard`/`enforce-root-structure.sh --fix`는 **미등록 루트 파일/디렉토리를 삭제**한다. 새 디렉토리 추가 시 반드시 `agents-rules.json` F12/F13에 먼저 등록.
- base 이력(115 테스트의 commit 등)은 새 프로젝트에 가져오지 않는다 — Strategy B에서 `.git` 제거 필수.
- mirror 정책: 이 파일 수정 시 `.users/skills/project-create/SKILL.md`도 동일 갱신.
