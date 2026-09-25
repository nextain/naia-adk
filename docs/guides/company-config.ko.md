# 회사 설정 파일 안내

회사 관리자가 보는 문서입니다. 구성원이 `pnpm adk:setup -- --company <주소>`로 회사 문서를 연결하면, ADK는 회사 문서 저장소 맨 위의 `adk-company.json`을 읽습니다. 이 파일로 두 가지를 정합니다. 대시보드 문서 탭에 보여 줄 폴더, 그리고 구성원이 함께 받을 공동 프로젝트입니다.

회사 문서는 기본적으로 감춥니다. 이 파일에 적은 폴더만 대시보드에 보이고, 적지 않은 폴더는 목록에도 나오지 않고 주소로 불러도 열리지 않습니다.

## 예시

```json
{
  "schemaVersion": 1,
  "title": "회사 문서",
  "docs": {
    "include": ["01. 온보딩", "05. 브랜드·마케팅"]
  },
  "repos": [
    {
      "id": "hub",
      "path": "projects/hub",
      "remote": "https://github.com/example/hub.git",
      "docs": { "title": "공동작업 허브", "include": ["docs"] }
    }
  ],
  "board": {
    "repo": "hub",
    "script": "scripts/board-server.mjs",
    "port": 8894
  }
}
```

## 항목 설명

- `schemaVersion`는 파일 형식의 판 번호입니다. 지금은 1입니다.
- `title`은 문서 탭에서 회사 문서 묶음 위에 보이는 이름입니다.
- `docs.include`에는 대시보드에 보여 줄 폴더 이름을 적습니다.
- `repos`에는 구성원이 함께 받을 공동 프로젝트를 적습니다. 한 항목은 다음 값으로 이루어집니다.
  - `id`는 프로젝트를 가리키는 짧은 이름입니다.
  - `path`는 받을 위치입니다. `projects/`나 `data-company/` 아래만 쓸 수 있고, `..`이나 절대 경로는 거부됩니다.
  - `remote`는 받아 올 Git 저장소 주소입니다.
  - `docs`는 그 프로젝트 안의 문서도 문서 탭에 보여 주고 싶을 때 적습니다. `title`은 묶음 이름, `include`는 보여 줄 폴더입니다.
- `board`는 작업보드를 쓸 때만 적습니다. 적으면 대시보드 작업 탭이 이 보드를 같은 주소 안에서 보여 줍니다.
  - `repo`는 보드 프로그램이 들어 있는 프로젝트의 `id`입니다. 위 `repos`에 있는 값이어야 합니다.
  - `script`는 보드 프로그램 파일의 위치입니다.
  - `port`는 보드 프로그램이 쓸 포트입니다.

설정을 바꾼 뒤 무엇이 달라지는지 미리 보려면 `pnpm adk:setup -- --company <주소> --dry-run`을 실행합니다. 실제로 받지 않고 할 일만 보여 줍니다.
