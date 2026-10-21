---
name: view-folders
description: 작업공간 대시보드에 외부 데이터 폴더를 출처로 붙이거나 뗍니다. "대시보드에서 이 폴더 보이게 해 줘", "데이터 폴더 빼 줘", "데이터 폴더 등록", "view folders" 요청 시 반드시 사용.
---

# view-folders

## 목적

작업공간 대시보드 문서 화면에 외부 데이터 폴더를 읽기 전용 출처(`data:<id>`)로 등록하거나 해제합니다.
설정은 작업공간 로컬의 `<작업공간 루트>/.agents/work/view-folders.json`에 저장되며 저장소 커밋 대상이 아닙니다.

## 명령 도구

`node scripts/view-folders.mjs` 스크립트를 사용합니다. (공통 인자 `--root <작업공간 루트>` 지원)

### 1. 목록 조회
```bash
node scripts/view-folders.mjs list
```
등록된 데이터 폴더 목록(id, 레이블, 경로, 탭)을 확인합니다.

### 2. 폴더 추가
```bash
node scripts/view-folders.mjs add --id <id> --label <label> --path <path> [--tab <common|brand|developer>]
```
- `--id`: 영문 소문자·숫자·하이픈(`-`), 1~40자. 중복 불가. (출처 id는 `data:<id>`가 됨)
- `--label`: 대시보드 트리에 표시될 이름.
- `--path`: 절대경로 또는 `~/`로 시작하는 경로.
- `--tab`: `common` | `brand` | `developer` (기본값: `common`).

**주의 및 안전 규칙 (금지 1~3):**
- 금지 1: 홈, 작업공간 루트, 임시 폴더(`os.tmpdir()`), XDG 런타임 폴더, 비밀 값 파일 폴더 및 그 상위(루트 `/` 등)는 등록이 거절됩니다.
- 금지 2: 표시 파일(`.naia-view`)이 없는 폴더는 실경로가 반드시 홈 폴더 안이어야 하며 숨김 조각(`.local`, `.ssh` 등)이 없어야 합니다. 표시 파일은 폴더 제작자가 두는 것이며, 본 도구가 생성하지 않습니다.
- 금지 3: 경로 조각에 `data-private`, `.git`, `node_modules`가 포함된 경로는 거절됩니다.
- 추가 시 첫 단계 항목 이름 목록이 출력되어 무엇이 붙는지 확인합니다.

### 3. 폴더 제거
```bash
node scripts/view-folders.mjs remove --id <id>
```
지정한 id의 데이터 폴더를 목록에서 제거합니다. 폴더 내부 파일은 삭제되지 않습니다.
