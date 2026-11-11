# 대시보드 문서 짧은 주소

범위: 공통 (ADK 대시보드 기본 기능. 기기 이름·포트·사설망 주소는 설정에서 읽고 이 문서와 코드에 적지 않는다)
코드: `packages/dashboard/short-links.mjs`, `packages/dashboard/server.mjs`, `packages/dashboard/scripts/short-link.mjs`, `packages/dashboard/app/docs/ShortLinkButton.tsx`

## 1. 왜 있나

대시보드 문서 주소는 `/docs?tab=…&source=…&path=…` 꼴이고, 경로를 인코딩하면 휴대폰 화면에서 몇 줄씩 늘어진다.
메신저 승인 카드처럼 문서 링크를 붙이는 곳은 짧고 늘 같은 모양의 주소가 필요하다.

## 2. 짧은 주소 두 가지

- `/d/<키>` (예: `<대시보드 주소>/d/92d991`): 키는 `출처 + 줄바꿈 + 문서 경로`의 sha256 앞 6자(16진). 표 파일에 등록된 키만 열린다. 앞 6자가 다른 문서와 겹치면 그 문서만 7자, 8자로 늘린다.
- `/d/<출처>/<경로>` (예: `<대시보드 주소>/d/adk/guides/dashboard-short-links.md`): 표 없이 바로 열린다. `tab=`, `source=`, `%2F` 를 쓰지 않는다.

둘 다 대시보드가 긴 문서 주소로 302 넘겨 준다. 넘겨 줄 때 대시보드 탭 규칙(`app/docs/tabs.ts`)으로 탭을 붙이고, 데이터 폴더 출처처럼 탭을 서버가 모르거나 탭 규칙을 읽지 못하면 탭 없이 넘겨 화면이 탭을 고른다.

- 없는 키: 404
- `..`, `.`, 빈 조각, 인코딩한 `/`(`%2f`)·`\`(`%5c`), 깨진 인코딩: 400
- 접근 범위: 기존 대시보드와 같다. 같은 서버의 Host 검사(`host-guard.mjs`)를 먼저 지나야 하고, 새 포트나 새 공개 경로를 열지 않는다.

## 3. 만드는 명령

대시보드를 띄운 ADK 저장소에서:

```
node packages/dashboard/scripts/short-link.mjs <긴 주소 | /d/출처/경로 | 문서 경로> [--verify]
```

짧은 주소 한 줄을 낸다. 메신저 글에 그대로 붙이면 된다.

- 긴 주소를 주면 그 주소의 앞부분(기기·포트)을 그대로 쓴다.
- 문서 경로는 기본 출처 `adk`로 본다. 저장소 기준 경로 `docs/…` 를 줘도 앞의 `docs/` 를 뗀다(`adk` 출처의 뿌리가 `docs/`).
- 다른 출처: `--source <출처 id>`
- 표 없이 경로 형식으로: `--path-form`
- 바깥 주소를 직접: `--base http://<주소>:<포트>`
- `--verify`: 키를 만든 뒤 `/d/<키>` 가 넘기는 문서를 문서 API(`/api/portal/doc`)로 읽어 200 이 아니면 실패한다. 302 만으로는 내용이 뜨는지 모른다.

대시보드가 열 수 없는 경로는 키를 만들지 않고 거절한다: `.md` 가 아닌 파일, 점으로 시작하는 폴더(`.agents/` 등)·`node_modules`·`data-private` 이 든 경로, `adk` 출처에서 `docs/` 밖에만 있는 저장소 파일. 사람에게 보일 문서는 `docs/` 아래로 옮긴 뒤 링크를 만든다.

바깥 주소를 찾는 차례: `--base` → 긴 주소의 앞부분 → 환경 변수 `NAIA_DASHBOARD_PUBLIC_URL` → 이 기기 테일넷 이름(`tailscale status --json`) + `NAIA_DASHBOARD_PORT`(기본 3142) → `http://localhost:<포트>`.

키 등록은 그 바깥 주소의 대시보드(`POST /d`)에 맡긴다. 그래서 저장소 사본이 여럿이어도(작업 트리·다른 가지) 키는 서버가 읽는 표 하나에 남는다. 대시보드가 응답하지 않을 때만 명령을 돌린 사본의 표 파일에 직접 쓰고 표준 오류에 그 사실을 알린다.

## 4. 화면 단추

문서 보기 제목 옆 [짧은 주소] 단추가 키를 등록하고 `<지금 주소 앞부분>/d/<키>` 를 복사한다. 휴대폰처럼 http 주소로 열면 브라우저 복사 기능(navigator.clipboard)이 막히므로 숨긴 글 칸 복사로 바꾸고, 그것도 안 되면 주소를 글 칸에 띄워 길게 눌러 복사하게 한다. 등록이 실패하면 표 없이 열리는 `/d/<출처>/<경로>` 를 준다.

등록 요청은 `POST /d` (본문 JSON `{"source","path"}`)이고, 같은 출처(Origin = `scheme://Host`)에서 온 JSON 만 받는다. 본문은 4096 바이트까지.

## 5. 표 파일

- 위치: 환경 변수 `NAIA_SHORT_LINKS_FILE`, 없으면 `packages/dashboard/data/short-links.json`
- 모양: `{"version":1,"links":{"<키>":{"source","path","created"}}}`
- 쓰는 쪽은 보통 서버 하나다(화면 단추와 명령 모두 `POST /d`). 서버는 파일이 바뀔 때만 다시 읽으므로, 대시보드가 꺼져 있을 때 명령이 직접 쓴 키도 서버를 다시 띄우지 않고 열린다.
- 기기마다 다른 자료라 git 에 넣지 않는다(`packages/dashboard/.gitignore`). 키는 문서 경로에서 결정적으로 나오므로 표를 잃어도 같은 명령으로 같은 키를 다시 만든다(겹침으로 늘어난 7자 이상 키만 순서에 따라 달라질 수 있다).

## 6. 단축 도메인 설정 예시

`{도메인}/<키>` 처럼 대시보드 바깥의 단축 도메인을 쓰려면 저장소 뿌리의 `config/short-link.example.json` 을 `config/short-link.json` 으로 복사해 도메인과 대상 주소를 바꾼다. 예시에는 예약 도메인(`example.com`, `example.net`, `docs.internal.example`)만 있다. 대상 주소는 대시보드 `/d/{key}` 를 그대로 가리키므로 같은 키가 대시보드와 단축 도메인에서 같은 문서를 연다.

## 7. 시험

`packages/dashboard` 에서 `pnpm test`:

- `server.test.mjs` 의 "문서 짧은 주소" 묶음: 넘겨 주기, 없는 키 404, 경로 밖 시도 400, POST 같은 출처만, Host 검사 421, 명령 출력
- `scripts/short-link.test.mjs`: 대시보드가 못 여는 경로 거절, `--verify`
- `app/docs/short-link-button.render.test.tsx`: 화면 단추
- `short-link-standalone.test.mjs`: naia-adk 만으로 포털 API(`packages/server`)와 대시보드 요청 처리기를 띄워, `POST /d` → `/d/<키>` 302 → 문서 API 200 까지 확인
