# 드리프트 방지 훅 (Drift Guard)

커밋되지 않은 로컬 대본으로 산출물을 굽거나, 기존 코드 파일 대신 변형 이름(`_v2`, `-copy` 등)으로 사본 파일을 늘리거나, 미커밋 변경을 장시간 방치해 저장소 `main`과 실제 산출물 경로가 어긋나는 드리프트를 막는다.

## 사고 배경

한 에이전트가 로컬에서 커밋하지 않은 `stream_render.py`의 수치를 캐릭터마다 수동으로 바꿔 `*-scale085.nva`, `*-scale082.nva` 등 산출물만 여러 벌 구웠다.
저장소 `main`에는 해당 코드가 남지 않고 제품(나이아스튜디오) 공통 경로도 그 파일을 거치지 않아 재현 불가능한 코드·산출물 드리프트가 발생했다.

## 구성 요소

| 구분 | 파일 | 시점 | 역할 |
| --- | --- | --- | --- |
| 산출물 관문 | `.claude/hooks/artifact-drift-guard.js` (`.agents/hooks/policies/bash.js`) | `PreToolUse` (`Bash`) | 미커밋(untracked/modified) 또는 저장소 밖(`/tmp` 등) 대본·산출물 생산 폴더 대본·인라인/표준입력 실행 및 미커밋 산출물 복사·개명 차단 |
| 사본 파일 관문 | `.claude/hooks/copy-file-guard.js` (`.agents/hooks/policies/edit.js`) | `PreToolUse` (`Edit\|Write\|NotebookEdit\|MultiEdit` 및 `Bash` 복사·개명) | 같은 폴더에 이미 있는 코드 파일의 변형 이름으로 새 코드 파일 생성 차단 |
| 미커밋 알림 | `scripts/check-stale-uncommitted.cjs`, `.claude/hooks/stale-uncommitted-notice.js` | `SessionStart` / CLI | 작업 공간과 `projects/*` 저장소의 `N`시간(기본 4) 초과 미커밋 변경 한 줄 경고 |
| 설정 파일 | `.agents/context/drift-guard.json` | 상시 | 산출물 확장자, 산출물 생산 폴더(`artifact_script_dirs`), 코드 확장자, 숫자 접미 정식 명칭(`allowed_numeric_stems`), 미커밋 경고 시간 설정 |

## 1. 산출물 관문 (`artifact-drift-guard.js`)

- 산출물 생산 폴더(`artifact_script_dirs`: 기본 `naia-labs/avatar`, `naia-labs/**/service`, `scripts/build*`, 저장소별 추가 가능)의 대본이 미커밋(`untracked`/`modified`)이면 명령줄에 산출물 토큰이 없어도 실행을 막고, 명령에 산출물 확장자(기본 `.nva`, `.exe`, `.msi`, `.dmg`, `.AppImage`, `.apk`, `.vrm`)가 있으면 어느 폴더든 미커밋·저장소 밖 대본 실행을 막는다.
- 서브셸·그룹(`()`, `{}`), 래퍼(`env`, `sudo`, `nohup`, `time`, `xargs`, `find -exec`)를 벗겨 대본을 찾으며, 산출물 토큰이 있는 `| bash`·`| sh`·`| python` 표준 입력 실행과 `python -c`·`node -e` 인라인 실행, 미커밋 원본을 산출물 확장자로 개명·복사(`cp`, `mv`, `ln`, `install`, `rsync`)하는 명령도 차단한다.
- 확장자 목록과 산출물 생산 폴더 목록은 `.agents/context/drift-guard.json`에서 변경·추가할 수 있다.

## 2. 사본 파일 관문 (`copy-file-guard.js`)

- `Edit`, `Write`, `NotebookEdit`, `MultiEdit` 및 `Bash`(`cp`, `mv`, `ln`, `install`, `rsync`)로 새 코드 파일(`.py`, `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.rs`, `.go`, `.sh`)을 만들 때 동작하며, 기존 파일 수정은 통과한다.
- 같은 폴더에 있는 기존 코드 파일 이름의 변형(`_v2`, `-v3`, `_new`, `_old`, `_copy`, `-copy`, `_backup`, `_fixed`, `_final`, 숫자만 다른 이름, `" (1)"` 등)이면 사본 생성을 막고 `"원래 파일을 고치세요"`를 안내한다(판정 함수는 `edit.js` 한 곳에 두고 `bash.js`가 불러 쓴다).
- 시험 파일(`test_*`, `*.test.*`, `*_test.*`), `migrations/` 폴더, 숫자 접미 정식 명칭(`oauth2`, `http2`, `md5`, `sha256`, `base64`, `utf8`, `i18n`, `k8s` 등 `allowed_numeric_stems`)은 예외로 허용한다.

## 3. 오래된 미커밋 변경 알림 (`scripts/check-stale-uncommitted.cjs`)

- 작업 공간 루트와 `projects/*` 하위 git 저장소에서 파일 수정 시각(`mtime`) 기준 기본 4시간(`--hours <N>` 또는 `.agents/context/drift-guard.json`의 `stale_uncommitted_hours`) 넘게 커밋되지 않은 변경을 찾아 출력한다.
- 세션 시작 시 `.claude/hooks/stale-uncommitted-notice.js`가 `SessionStart` `additionalContext`로 한 줄 경고를 표시한다(깨움·디스코드 발송 없음).
