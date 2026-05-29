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
  (F12/F13 구조 강제 hooks, SDLC 게이트, CI, 멀티툴 mirror)를 **점진 도입**.

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
- 기존 루트 디렉토리/파일 목록 수집 + **표준(F12/F13)과 양방향 대조**:
  - (a) 프로젝트에 **있는데 표준에 없는** 항목 → B1 처분 분류
  - (b) 표준에 **있는데 프로젝트에 없는** 항목 → **채움** 대상
- **보안 스캔 선행**: 키·토큰·시크릿·개인정보가 추적 경로에 있는지 먼저 검사 (B1 보안 격리). 유출 위험이 최우선.
- **[GATE]** 처분표(항목 × 처분) + 채움 목록 + 보안 발견 + 도입할 hook/CI 를 보고하고 **승인 대기**. 승인 전 enforcement 금지.

### B1 — ⚠️ 루트 항목 처분 (삭제·유출 방지)
> `structure-guard` / `enforce-root-structure.sh --fix`는 **미등록 루트 파일/디렉토리를 삭제**한다.
> 하네스를 켜기 **전에** 모든 비표준 항목을 처분하고 누락 표준 항목을 채운다.
> 처분 누락 = 삭제 사고 / 보안 항목 방치 = 유출 사고.

**B1.0 — 누락 자산 동적 산출 + 시드 (고정 목록 쓰지 말 것 — 프로젝트마다 다름)**
> harden 의 본질 = **"표준에 있는데 대상에 없는 것을 채운다"**. 채울 대상은 F12/F13 뿐 아니라
> 하네스 자산 전체(hooks·scripts·CI·테스트·docs·rules 키 등)이며 **프로젝트마다 다르다.**
> 따라서 **무엇을 채울지 목록을 스킬에 박지 않는다. 템플릿과 대상을 대조해 매번 산출한다.**

**누락 = (템플릿 표준 자산) − (대상에 이미 있는 것).** 파일 트리 차집합으로 동적 산출:
```bash
# 임시 clone 한 template($TPL) 와 대상($TGT) 을 git 트리로 대조
comm -23 <(cd "$TPL" && git ls-files | sort) <(cd "$TGT" && git ls-files | sort)
#   → 템플릿에만 있는 항목 = 누락(채움) 후보. 프로젝트별로 결과가 다르다.
```
이 차집합을 **처분 5가지로 분류** (대부분 "채움"; 대상 성격상 불요한 것만 제외/문의).
파일은 복사하되, **대상에도 이미 있는 설정 파일(`agents-rules.json` 등)은 key 단위 union merge**
(덮어쓰기 금지 — 고정 key 목록 없이 차집합으로):
```python
tgt = json.load(open(target_rules)); tpl = json.load(open(tpl_rules))
for k in tpl:                        # 템플릿의 모든 표준 key 순회 (하드코딩 X)
    if k not in tgt: tgt[k] = tpl[k]    # 대상에 없는 key 만 시드. 있으면 대상 값 보존
```
> 결과: 대상 고유 내용 100% 보존 + 표준 골격(F12/F13/forbidden_actions/self_trust_config 등) 채워짐.
> F12/F13 은 템플릿 표준값으로 시드됨 → B1 처분표의 "고유 등록"·"정렬" 항목을 그 위에 반영.
> **검증**: 시드 전 대상 key 전부가 시드 후에도 존재(보존)하는지 diff.

**처분 5가지** — 모든 항목을 빠짐없이(상호배타·전수) 아래 중 하나로:

| 처분 | 언제 | 처리 | 자동 / 문의 |
|------|------|------|------------|
| **채움** | 표준엔 있는데 프로젝트에 **없는** 필수 요소 (`src/`, `LICENSE`, 멀티툴 mirror 등) | 표준 자산 생성/복사 | **자동** (표준이 정한 것) |
| **정렬** | 표준과 의미 같고 이름/위치만 다름 (`benchmarks`→`benchmark`, `tests`→`src/test`) | `git mv` + 코드 경로 참조 갱신 | **제안 후 사용자 승인** (자동 mv 금지 — 빌드/히스토리 위험, 의도된 비표준일 수 있음) |
| **고유 등록** | 표준엔 없지만 프로젝트 고유·필수 자산 (`data/`, `_imports/`, 연구 산출물) | `agents-rules.json` F12/F13 에 추가 + note 이유 기록 | 명백하면 **자동**, 애매하면 **문의** |
| **추적 제외** | 추적 불필요 산출물·캐시 (`ckpts/`, `*.npy`, `node_modules`) | `.gitignore` (+ 필요시 고유 등록 병행) | **자동** |
| **보안 격리** ★ | 키·토큰·시크릿·개인정보(음성/얼굴 등) | **반드시 gitignore 된 위치에만 존재**. 추적 중이면 즉시 `git rm --cached` + `.gitignore` 등록 후 표준 시크릿 위치(`data-private/`, 그 자체가 gitignore)로 이동. **이미 push 됐으면 history purge(filter-repo)+force push** | **항상 사용자 보고** (유출은 사용자 결정·게이트) |

**처분 원칙**:
- **누락은 채운다** — 표준이 정한 것이므로 임의 판단 아님, 자동 채움.
- **임의 결정이 진짜 어려운 항목만 사용자에게 문의** — 명백한 건(채움·추적제외·명백한 고유등록) AI 가 진행, 애매한 것(정렬 전부·의도 불명 고유등록)만 게이트. *매 항목 다 묻지 않는다.*
- **정렬은 제안만, 실행은 승인** — 기존 프로젝트를 AI 가 함부로 `git mv` 하면 소실/빌드붕괴. "정렬 권장하되 프로젝트 의도 우선". (정렬 vs 고유등록 갈리면 정렬 우선 — 표준 명칭으로 맞춰야 템플릿 테스트와 정합.)
- **보안 격리는 무조건 우선·보고** — 보안 데이터 위치 표준 = `data-private/`(추적 제외) 또는 외부 시크릿 매니저. 추적 경로에 키/개인정보 발견 시 다른 모든 처분보다 먼저 격리.
- **단위(granularity)**: 디렉터리 전체로 처분할지 내부 파일별로 쪼갤지 모호하면 — 디렉터리에 혼재(고유자산 + 시크릿 등)면 **파일 단위로 분리 처분**.

**특정 항목 결정 규칙** (매번 묻지 말 것 — 아래는 결정됨):

| 항목 | 규칙 |
|------|------|
| `LICENSE` | **무조건 채움** (visibility 무관 필수 — 없으면 법적 모호). 내용: 공개=Apache-2.0 / **비공개=proprietary(All Rights Reserved, Nextain Inc.)** / 특허 출원 전이면 비공개라도 proprietary (오픈은 PoC·특허 후 결정). |
| `package.json` | **하네스 도입 시 채움** — 대상이 python 등 non-node 라도, **self-trust 하네스(`src/test/*.test.mjs`, `scripts/ci-verify-*.mjs`) 가 node 라서** 실행·CI 에 필요. "node 코드 없으니 불요"는 틀림. |
| 멀티툴 mirror (`OPENCODE.md`, `CODEX.md` 등) | **채움** — `AGENTS.md` SoT 에서 `sync-harness-mirrors.sh` 로 생성 (B3). |
| `benchmarks`→`benchmark`, `tests`→`src/test` | **정렬** (표준 명칭). 코드 경로 참조 갱신 동반. |
| `data/`, `_imports/`, 연구 산출물 | **고유 등록** (F12). 표준에 없는 게 정상인 프로젝트 자산. |
| `ckpts/`, 대용량 `*.npy`/모델 | **추적 제외** (+ 필요시 F12 등록 — 삭제 방지). |

> ⚠️ 모든 처분(채움·보안격리 포함)을 **enforcement(--fix) 이전에** 끝낸다.
> 순서: 보안격리 → 채움 → 정렬(승인 후) → 고유등록 → 추적제외 권장 (보안 먼저).

### B2 — 하네스 자산 복사 (advisory 모드)
> ⚠️ **정본 신선도 (stale-clone 방지, 실전 finding)**: harden 은 template 의 **최신 정본**을 받아야 한다.
> template 에 **아직 push 안 된 로컬 개선**(새 테스트·F12 항목·규칙 등)이 있으면, origin clone 은
> 구버전이라 harden 이 그 개선을 **누락**한다 (검증 단계서 "왜 이 테스트가 없지" 로 드러남).
> 따라서 **둘 중 하나**:
> 1. template 로컬 개선을 **먼저 origin 에 push** 한 뒤 clone, 또는
> 2. clone 대신 **로컬 authoritative copy**(예: alpha-adk submodule `projects/naia-template-project`,
>    개선이 반영된 working tree)를 `$TPL` 로 사용.
> 시작 전 `git -C <template-local> status` 로 unpushed/uncommitted 개선 유무를 확인하라.

정본 template 을 가져온다 (절대경로 박지 말 것 — `mktemp` 변수). **신선도 확인 후**:
```bash
# (A) origin 이 최신이면: clone
TPL="$(mktemp -d)"; git clone --depth 1 https://github.com/nextain/naia-template-project.git "$TPL"
# (B) 로컬에 unpushed 개선이 있으면: 그 로컬 정본을 $TPL 로 (clone 대신)
#     TPL=<template 로컬 authoritative copy 경로>
TGT=<대상 프로젝트 루트>
```
**복사 대상 = B1.0 차집합(누락 자산)** — 고정 목록이 아니라 `comm -23` 결과를 복사한다:
```bash
comm -23 <(cd "$TPL" && git ls-files|sort) <(cd "$TGT" && git ls-files|sort) \
  | while read f; do mkdir -p "$TGT/$(dirname "$f")"; cp "$TPL/$f" "$TGT/$f"; done
```
> 전형적 누락 자산(참고용 예시 — 실제는 차집합이 결정): self-trust hooks(`charter/structure/sdlc-gate/completion-evidence-guard` + `lib/self-trust-core`),
> `scripts/ci-verify-*`·`enforce-root-structure.sh`·`sync-harness-mirrors.sh`·`check-doc-graph.mjs`·`mirror-translate.mjs`·`verify-watch.sh`(주기 검증 러너),
> `.github/workflows/`, `src/test/*.test.mjs`, `docs/{README,project-structure,threat-model,llm-roles}`.
> ⚠️ **복제 제외(base 전용, payload 아님)**: `README.md`(base 소개), `about-docs/`(표준 자체 메타), `README.template.md`.
>   대상에 README 가 없으면 base 의 `README.template.md` 를 치환해 README.md 로. 있으면 **기존 README 보존**(덮어쓰기 금지).
> 대상에 **이미 있는 설정 파일(`agents-rules.json` 등)은 덮어쓰지 말고 B1.0 union merge** 적용.

처음엔 **advisory**(검사만, `--fix` 없이)로 돌려 위반을 보고. 통과·사용자 승인 후 enforcement 전환.

### B3 — 문서·컨텍스트 갱신 + mirror 표준화
> **구조를 바꿨으면 문서도 바꿔야 마이그레이션이다.** 정렬(rename)·채움·등록·제외로 바뀐 구조가
> 기존 README·entry(AGENTS.md)·컨텍스트와 **불일치**하면 마이그레이션 미완. (예: 문서가 옛 `benchmarks/`·
> `tests/`·"License 미정"을 그대로 말하면 실제와 어긋남.)

**B3.1 — 기존 문서/컨텍스트를 새 구조로 갱신** (mirror 생성 *전에*, SoT 부터):
- entry SoT(`AGENTS.md`)의 구조/디렉터리 트리·License·하네스 항목을 **harden 결과와 일치**시킴
  (정렬된 이름, 채워진 자산, 등록된 고유 dir, 실제 LICENSE).
- `README*`·`.agents/context/project-index.yaml`·기타 구조 언급 문서를 동일 갱신.
- 점검: 정렬 전 이름(`benchmarks`/`tests` 등)·"미정"류 잔존 문구를 grep 으로 0 확인.

**B3.1b — `docs/README.md` 허브 (문서 고립 방지)**: `docs/` 의 **큐레이트 문서(날짜 없는 참조 문서)는
전부 `docs/README.md` 에서 도달 가능**해야 한다 (`check-doc-graph` 가 강제). 허브가 없으면 만든다.
- 날짜형 작업 기록(`*-YYYY-MM-DD.md`, 검토·진행 메모)은 `docs/progress/` 로 모아 **디렉터리 면제**
  (`--exempt progress`) 대상으로 둔다. ⚠️ 파일명 날짜로 면제하지 않는다 — 큐레이트 문서가 파일명에
  날짜를 넣어도 면제되면 안 되므로 **디렉터리** 기준.
- 점검: `node scripts/check-doc-graph.mjs docs README.md --exempt progress` → 고립 0.

**B3.2 — mirror 생성 + scope**: `AGENTS.md`를 SoT로 `bash scripts/sync-harness-mirrors.sh`로
CLAUDE/GEMINI/OPENCODE/CODEX 생성 (멀티툴 mirror — 표준 F13 의 OPENCODE.md/CODEX.md 채움 포함).
- `.agents → .users` 컨텍스트 미러 scope = **`.agents/context/**` 의 `yaml/yml/md` 만**.
  `.json` 정책/상태 파일(`agents-rules.json`·`process-status.json` = charter)은 **미러 제외** —
  작은 모델이 charter JSON 을 번역하면 제어 구조(BLOCK/ACTIVE)·의미가 왜곡(silent pollution).
  charter 의 사람용 얼굴 = 진입점 MD(`AGENTS.md` 등, 그 자체로 사람 가독).
- `.agents/reviews/**`·`.agents/progress/**`(휘발성 AI 작업물)도 미러 제외.
repo_type에 맞는 mirror pattern은 [[repo-structure-standard.yaml]] 참조.
> mirror 일치는 B4 의 `m13-mirror.test.mjs` 가 검증. 문서 갱신 누락은 B4 ③(구조·doc-graph)·수동 grep 으로 잡는다.

### B4 — 최종 검증 = 단계1: 검출 스크립트 **수동** 실행 → drift 0 (전부 통과해야 harden 완료)
harden 은 아래 **4축 전부 green** 이어야 "완료". 일부만 돌리고 "됐다" 금지.
> 마이그레이션 = **2단계**. **단계1(여기, 수동)**: 검출 스크립트를 손으로 돌려 drift 를 전부 surface →
> 큰 모델이 cross-check 동반 수정 → 0 violation. **단계2(B5)**: 깨끗해지면 주기 검증을 백그라운드로 켠다.

**① 하네스 단위 테스트** (`src/test/*.test.mjs` — 각 파일 직접 실행, `node --test` 아님):
```bash
fail=0; for t in src/test/*.test.mjs; do node "$t" || fail=1; done; [ $fail -eq 0 ] && echo "✓ 테스트"
```
**② CI 게이트 전체** — CI(`self-trust-gates.yml`)가 실제 강제하는 검증기. 로컬서도 통과 확인:
```bash
# 변경 파일 목록(FILES)으로 — CI 워크플로가 부르는 검증기 그대로
node scripts/ci-verify-structure.mjs "${FILES[@]}"
node scripts/ci-verify-sdlc.mjs "${FILES[@]}"
node scripts/ci-verify-charter.mjs "${FILES[@]}"
git log -1 --format=%B | node scripts/ci-verify-completion.mjs "${FILES[@]}"
```
**③ 구조 + 문서그래프 + 미러 + 누락 재확인** (채움 완전성 + B3 문서/미러 갱신):
```bash
bash scripts/enforce-root-structure.sh                 # 루트 구조 위반 0 (삭제 없이 검사만)
node scripts/check-doc-graph.mjs docs README.md --exempt progress   # 문서 고립·깨진링크 0
# 컨텍스트 미러 stale 0 (scope = context yaml/md, json=charter 제외):
for f in $(find .agents/context -type f \( -name '*.yaml' -o -name '*.yml' -o -name '*.md' \)); do
  node scripts/mirror-translate.mjs "$f" --check; done   # 전부 up-to-date 여야
comm -23 <(cd "$TPL" && git ls-files|sort) <(git ls-files|sort)   # 채움 후 잔여 누락 = 0 (예외만 남아야)
grep -rnE "<정렬전이름>|미정|TODO 구조" AGENTS.md README* .agents/context/ docs/ 2>/dev/null   # 옛 구조 문구 0
```
> 위 검출 한 방에: `bash scripts/verify-watch.sh once` (단계2 러너를 단계1 검출에도 재사용 — exit 0 이어야).
**④ 소실·유출 0 검증** (안전 — 가장 중요):
```bash
git ls-files | grep -icE '\.env$|secret|key|개인정보 패턴'   # 추적 시크릿 = 0
# harden 전 자산 목록과 비교 — 코드/데이터 파일 수가 줄지 않았는지 (정렬 rename 제외)
```
> 4축 중 하나라도 실패 = harden **미완**. 통과해야 enforcement(--fix)·push.
> mirror(B3)는 `m13-mirror.test.mjs`가 ①에서 검증 (AGENTS=CLAUDE=GEMINI… 일치).

### B5 — 마이그레이션 완료 후 = 단계2: 주기 검증 백그라운드 활성화
단계1(B4)에서 drift 0 을 달성한 *뒤에만* 켠다. 도구가 있어도 wired 안 하면 다시 drift 가 쌓인다.
```bash
bash scripts/verify-watch.sh accept     # 현재(깨끗) 상태를 baseline 으로 승인 → 이후 신규(delta)만 보고
bash scripts/verify-watch.sh start      # 백그라운드 sleep-loop (flock 중복방지·PID·로그 rotation)
# 재부팅에도 지속하려면(권장 영속 옵션):
bash scripts/verify-watch.sh cron       # 출력된 crontab 줄을 crontab -e 에 추가 (sleep-loop 은 재부팅 시 죽음)
```
**원칙 (불변)**:
- **검출·보고만 자동.** 자동 수정 절대 금지 — 작은 모델/자동 수정은 맥락 소실로 정합성을 깬다.
  신규 drift 발견 시 **사람/큰 모델 세션**이 cross-check 동반해 수정한다.
- enforce 는 러너가 **`--fix` 없이(읽기전용)만** 호출 — 백그라운드에서 `rm -rf` 절대 안 돈다.
- 보고는 **baseline 대비 delta(신규)만** → alert fatigue 방지. 같은 위반 반복 기록 안 함.
- 가시 채널 = `.agents/work/verify-status.txt`(최신, 덮어씀). 세션 시작 시/사람이 이걸 본다.
- ⚠️ phase 진입·active_phase 변경 같은 **게이트 항목은 러너가 "지적"만** — 자율 판정 금지(사용자 게이트).

## Key Files

| 파일 | 용도 |
|------|------|
| `nextain/naia-template-project` (GitHub) | harden 자산 복사원 (B2에서 임시 clone) |
| `.agents/context/repo-structure-standard.yaml` | repo_type → mirror/구조 SoT |
| `<parent>/.gitmodules` | submodule 등록 결과 |
| `<parent>/.gitignore` | force-add 표식 위치 |

## 참고

- extract와 [[project-create]] Step 6은 같은 "submodule 등록" 서브절차를 공유한다.
- behind/ahead 상태에서 마이그레이션 commit을 쌓으면 이후 merge가 복잡해진다 — 가능하면 upstream sync를 먼저.
- 부모가 그 자체로 submodule이면(예: alpha-adk 안의 naia-adk) `.git`은 gitfile이고 실제 gitdir는 `<super>/.git/modules/...`다. modules 경로를 찾을 땐 `git rev-parse --git-dir` 사용.
- mirror 정책: 이 파일 수정 시 `.users/skills/project-migration/SKILL.md`도 동일 갱신.
