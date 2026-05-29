---
name: project-migration
description: >
  기존 프로젝트/디렉토리를 (A) 자체 정본 GitHub 레포 + submodule 구조로 분리(extract)하거나,
  (B) naia-template-project의 self-trust 하네스 표준을 기존 코드에 점진 적용(harden)한다.
  in-place submodule 변환의 위험(.git 손상)을 피하는 push-first → 재clone 패턴과
  Windows lock·gitignore force-add·bash 경로 함정 대응을 내장.
  "프로젝트를 별도 레포로 분리", "submodule로 등록", "기존 디렉토리를 레포로", "하네스 적용/마이그레이션" 요청 시 반드시 사용.
argument-hint: "[대상 경로] [extract|harden]"
---

# project-migration

## 목적

이미 존재하는 프로젝트/디렉토리를 표준 구조로 옮긴다. 두 모드:

- **Mode A — extract**: 워크스페이스 하위 디렉토리를 **자체 정본 GitHub 레포**로 떼어내고,
  원래 자리에 **submodule**로 다시 mount.
- **Mode B — harden**: 기존 프로젝트에 [[project-create]]가 쓰는 self-trust 하네스
  (F12/F13 구조 강제 hooks, SDLC 게이트, CI, 4-tool mirror)를 **점진 도입**.

두 모드는 함께 쓸 수 있다 (먼저 harden → 그다음 extract).

**핵심 원칙 (이 세션 실전 교훈 — 위반 금지)**
1. **push-first**: 정본을 GitHub에 먼저 올린 뒤 로컬을 만진다. 원격이 SoT면 로컬 사고가 나도 무손실 복구된다.
2. **in-place 변환 금지**: 기존 디렉토리를 그대로 submodule로 바꾸지 않는다. push 후 **로컬 삭제 → `git submodule add` 재clone**. (in-place 시도 중 rename/lock으로 `.git`이 비는 손상이 실측됨.)
3. **force-add 컨벤션**: `projects/`가 `.gitignore`로 무시되면 `git submodule add --force` + `!path` 표식(문서용). 부모 디렉토리가 제외되면 `!`는 실제 재포함이 안 됨 — 표식일 뿐, 추적은 force-add가 담당.
4. **AI는 외부 신규 레포 push를 우회하지 않는다**: mass-export guard가 막으면 사용자에게 명령을 제시하고 직접 실행 요청.

## Mode A — extract (정본 레포 + submodule)

### A0 — 사전 점검 (read-only, GATE)
- 대상 디렉토리 경로, 새 레포명(`<owner>/<name>`), visibility 확인.
- 대상이 부모 레포에 **추적 중인지** 확인: `git ls-files <path> | head`.
  - 추적 중이면: 먼저 부모에서 `git rm -r --cached <path>` 후 commit (gitlink 전환 준비).
  - 무시 중(예: `projects/`)이면: 그대로 진행, 나중에 `--force`.
- **[GATE]** 계획 보고 후 승인 대기.

### A1 — 대상에 독립 이력 부여 + push (정본 확보)
```bash
cd <path>
git init -b main            # 이미 repo면 생략
git add -A && git commit -m "feat: <name> 초기 분리"
```
원격 생성 + push는 **사용자 직접** (mass-export guard):
```
!cd /d/<...>/<path> && gh repo create <owner>/<name> --<visibility> --source=. --remote=origin --push
```
> Windows `!`는 bash → 백슬래시 경로(`D:\...`)가 escape로 깨진다. **forward-slash**(`/d/...`) 사용.
> PowerShell이면 `&&` 대신 `;`.

push 성공(`main -> main`) 확인. **이 시점부터 정본은 원격에 안전.**

### A2 — 로컬 삭제 → submodule 재clone (in-place 변환 금지)
부모 워크스페이스 루트에서:
```bash
rm -rf <path>     # 또는 PowerShell: Remove-Item -LiteralPath <path> -Recurse -Force
```
> **lock 대응**: `Permission denied`/`access rights`가 나면 그 디렉토리를 cwd로 잡은
> 셸(`!`로 `cd` 했던 세션)이나 IDE가 lock 중이다. 셸을 다른 경로로 옮기거나(`!cd /d/<repo-root>`)
> IDE 폴더를 닫은 뒤 재시도. 정본은 원격에 있으므로 삭제는 안전.

```bash
git submodule add --force <repo-url> <path>     # 무시 경로면 --force
```
재clone된 `<path>`의 HEAD가 push한 커밋과 일치하는지 확인:
```bash
git -C <path> rev-parse HEAD     # push한 해시와 동일해야 함
```

### A3 — gitignore 표식 + 부모 commit
부모 `.gitignore`가 상위 디렉토리(예: `projects/`)를 무시하면, 의도를 명시하는 표식 추가:
```
projects/
!projects/<name>        # 문서용 표식 (실제 추적은 submodule gitlink가 담당)
```
부모 레포 commit (관련 파일만 — 무관한 WIP 제외):
```bash
git add .gitignore .gitmodules <path>      # <path> add가 ignore로 막히면 이미 staged됐는지 확인 후 제외
git commit -m "chore(projects): register <name> as submodule"
```
> `git add <path>`가 `paths are ignored` 에러로 **명령 전체를 중단**시키면,
> gitlink는 `submodule add --force`로 이미 staged된 상태다. `<path>`를 빼고 나머지만 add.

### A4 — 검증·보고
```bash
git diff --cached --stat              # .gitmodules + gitlink(mode 160000) + .gitignore
git submodule status <path>           # 등록 확인
```
보고: 레포 URL, gitlink 해시, 부모 commit 해시.

## Mode B — harden (self-trust 하네스 점진 도입)

### B0 — 현황 스캔 (GATE)
- 기존 루트 디렉토리/파일 목록 수집.
- template-project가 강제하는 F12 `allowed_root_dirs` / F13 `allowed_root_files`와 대조.
- **[GATE]** 어떤 hook/CI/스크립트를 도입할지, 기존 구조와의 충돌을 보고.

### B1 — ⚠️ 구조 등록 먼저 (삭제 방지)
> `structure-guard` / `enforce-root-structure.sh --fix`는 **미등록 루트 파일/디렉토리를 삭제**한다.
> 하네스를 켜기 **전에** 기존 프로젝트의 실제 루트 항목을 `agents-rules.json` F12/F13에
> 모두 등록한다. 등록 누락 = 기존 코드 삭제 사고.

### B2 — 하네스 자산 복사 (advisory 모드)
template-project에서 가져옴 (경로 충돌 없는 것부터):
```
.agents/hooks/{charter,completion-evidence,sdlc-gate,structure}-guard.js + lib/self-trust-core.mjs
scripts/ci-verify-*.mjs, check-*.mjs, enforce-root-structure.sh, sync-harness-mirrors.sh
.github/workflows/self-trust-gates.yml
src/test/*.test.mjs
```
처음엔 **advisory**(검사만, `--fix` 없이)로 돌려 위반을 보고. 통과·사용자 승인 후 enforcement 전환.

### B3 — mirror 표준화
`AGENTS.md`를 SoT로 두고 `bash scripts/sync-harness-mirrors.sh`로 CLAUDE/GEMINI/OPENCODE/CODEX 생성.
repo_type에 맞는 mirror pattern은 [[repo-structure-standard.yaml]] 참조.

### B4 — 검증
```bash
node --test src/test/                  # 도입한 가드 테스트
bash scripts/enforce-root-structure.sh # 위반 0 (삭제 없이 검사만)
```

## Key Files

| 파일 | 용도 |
|------|------|
| `projects/naia-template-project/` | harden 시 하네스 자산 복사원 |
| `.agents/context/repo-structure-standard.yaml` | repo_type → mirror/구조 SoT |
| `<parent>/.gitmodules` | submodule 등록 결과 |
| `<parent>/.gitignore` | force-add 표식 위치 |

## 참고

- extract와 [[project-create]] Step 6은 같은 "submodule 등록" 서브절차를 공유한다.
- behind/ahead 상태에서 마이그레이션 commit을 쌓으면 이후 merge가 복잡해진다 — 가능하면 upstream sync를 먼저.
- 부모가 그 자체로 submodule이면(예: alpha-adk 안의 naia-adk) `.git`은 gitfile이고 실제 gitdir는 `<super>/.git/modules/...`다. modules 경로를 찾을 땐 `git rev-parse --git-dir` 사용.
- mirror 정책: 이 파일 수정 시 `.users/skills/project-migration/SKILL.md`도 동일 갱신.
