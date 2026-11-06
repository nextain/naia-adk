# 드리프트 방지 훅 (Drift Guard)

커밋되지 않은 로컬 대본으로 산출물을 굽거나, 기존 코드 파일 대신 변형 이름(`_v2`, `-copy` 등)으로 사본 파일을 늘리거나, 미커밋 변경을 장시간 방치해 저장소 `main`과 실제 산출물 경로가 어긋나는 드리프트를 막는다.

## 사고 배경

한 에이전트가 로컬에서 커밋하지 않은 `stream_render.py`의 수치를 캐릭터마다 수동으로 바꿔 `*-scale085.nva`, `*-scale082.nva` 등 산출물만 여러 벌 구웠다.
저장소 `main`에는 해당 코드가 남지 않고 제품(나이아스튜디오) 공통 경로도 그 파일을 거치지 않아 재현 불가능한 코드·산출물 드리프트가 발생했다.

## 구성 요소

| 구분 | 파일 | 시점 | 역할 |
| --- | --- | --- | --- |
| 산출물 관문 | `.claude/hooks/artifact-drift-guard.js` (`.agents/hooks/policies/bash.js`) | `PreToolUse` (`Bash`) | 미커밋(untracked/modified) 또는 저장소 밖(`/tmp` 등) 대본으로 산출물 생성 차단 |
| 사본 파일 관문 | `.claude/hooks/copy-file-guard.js` (`.agents/hooks/policies/edit.js`) | `PreToolUse` (`Edit\|Write`) | 같은 폴더에 이미 있는 코드 파일의 변형 이름으로 새 코드 파일 생성 차단 |
| 미커밋 알림 | `scripts/check-stale-uncommitted.cjs`, `.claude/hooks/stale-uncommitted-notice.js` | `SessionStart` / CLI | 작업 공간과 `projects/*` 저장소의 `N`시간(기본 4) 초과 미커밋 변경 한 줄 경고 |
| 설정 파일 | `.agents/context/drift-guard.json` | 상시 | 산출물 확장자, 코드 파일 확장자, 미커밋 경고 기준 시간(`stale_uncommitted_hours`) 설정 |

## 1. 산출물 관문 (`artifact-drift-guard.js`)

- 명령 인자나 출력 경로에 산출물 확장자(기본 `.nva`, `.exe`, `.msi`, `.dmg`, `.AppImage`, `.apk`, `.vrm`)가 포함되고 대본(`python`, `node`, `bash`, `sh`, `tsx`, `uv run` 등의 첫 대본 인자 또는 직접 실행 대본)을 실행할 때 검사한다.
- 대본 파일이 git 저장소 밖(`/tmp` 등)에 있거나, 저장소 안에서 `untracked` 또는 `modified` 상태이면 실행을 막고 공통 코드에 반영해 커밋·PR 후 실행하도록 안내한다.
- 확장자 목록은 `.agents/context/drift-guard.json`의 `artifact_extensions` 배열에서 변경할 수 있다.

## 2. 사본 파일 관문 (`copy-file-guard.js`)

- 새 코드 파일(`.py`, `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.rs`, `.go`, `.sh`)을 만들 때만 동작하며, 이미 존재하는 파일을 수정하는 경우는 통과한다.
- 같은 폴더에 있는 기존 코드 파일 이름의 변형(`_v2`, `-v3`, `_new`, `_old`, `_copy`, `-copy`, `_backup`, `_fixed`, `_final`, 숫자만 다른 이름, `" (1)"` 등)이면 차본 생성을 막고 `"원래 파일을 고치세요"`를 안내한다.
- 시험 파일(`test_*`, `*.test.*`, `*_test.*`)과 `migrations/` 폴더는 예외로 허용한다.

## 3. 오래된 미커밋 변경 알림 (`scripts/check-stale-uncommitted.cjs`)

- 작업 공간 루트와 `projects/*` 하위 git 저장소에서 파일 수정 시각(`mtime`) 기준 기본 4시간(`--hours <N>` 또는 `.agents/context/drift-guard.json`의 `stale_uncommitted_hours`) 넘게 커밋되지 않은 변경을 찾아 출력한다.
- 세션 시작 시 `.claude/hooks/stale-uncommitted-notice.js`가 `SessionStart` `additionalContext`로 한 줄 경고를 표시한다(깨움·디스코드 발송 없음).
