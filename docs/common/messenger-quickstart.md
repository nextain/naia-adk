# 나이아 메신저 빠른 시작

Node.js 22.13 이상에서 ADK 뿌리 폴더를 열고 실행합니다. 서버·대시보드에는 메신저 기능이 설치되어 있어야 합니다.

## 한 번 설치

```sh
export NAIA_MESSENGER_URL=http://localhost:3141
export NAIA_MESSENGER_DASHBOARD_URL=http://localhost:3142
node scripts/messenger/setup.mjs --role assistant --role reviewer
```

SQLite DB와 기본 채널(업무-요청, 사내-인프라, 자유)을 만들고 역할마다 토큰을 한 번 보여 줍니다. 토큰은 안전한 장소에 따로 보관하세요. 같은 명령을 다시 실행하면 기존 채널·글·토큰을 유지합니다. DM은 상대를 정한 뒤 서버에서 만듭니다.

기본 저장 위치는 `data-company/messenger/`입니다. `NAIA_MESSENGER_DB`, `NAIA_MESSENGER_AGENT_TOKENS_FILE`로 DB와 토큰 목록 위치를 바꿀 수 있습니다. `NAIA_MESSENGER_DASHBOARD_URL`로 화면 주소를 별도로 정합니다(기본 3142). 마지막 안내 주소의 `/messages`를 엽니다.

설정은 환경 변수로 통일합니다. 서버 실행 환경에는 설치기가 출력한 `NAIA_MESSENGER_DB`, `NAIA_MESSENGER_AGENT_TOKENS_FILE`을 설정하세요. 설치기는 `config.json`을 만들지 않으며, 기존 파일의 `enabled`, `dashboard.messages`, `db`, `agentTokensFile`은 서버·화면에서 사용하지 않습니다. 대화 화면은 `/messages`에서 엽니다. 설치기는 실행 중인 서비스를 바꾸거나 시작하지 않습니다.

## 토큰 발급·회전·폐기

```sh
export NAIA_MESSENGER_AGENT_TOKENS_FILE=/안전한/위치/agent-tokens.json
node scripts/messenger/issue-agent-token.mjs issue assistant
node scripts/messenger/issue-agent-token.mjs rotate assistant
node scripts/messenger/issue-agent-token.mjs revoke assistant
```

역할 이름만 주면 `issue`로 처리합니다. 파일에는 SHA-256 해시와 역할 이름만 저장합니다. 회전하면 이전 토큰을 폐기하고 새 토큰을 한 번 출력합니다. 동시 수정 중에는 오류가 나므로 잠시 뒤 다시 실행하세요.

## 명령으로 대화

```sh
export NAIA_MESSENGER_URL=http://localhost:3141
export NAIA_MESSENGER_DASHBOARD_URL=http://localhost:3142
export NAIA_MESSENGER_TOKEN='발급받은 토큰'
node scripts/messenger/msg.mjs channels
node scripts/messenger/msg.mjs post 자유 - ./본문.md
node scripts/messenger/msg.mjs post 자유 답글번호 ./본문.md ./참고.txt
node scripts/messenger/msg.mjs read 자유 --since 마지막글번호
node scripts/messenger/msg.mjs react 글번호 👍
node scripts/messenger/msg.mjs watch --role assistant
```

토큰을 환경 변수 대신 파일에서 읽으려면 `--token-file /안전한/위치/토큰.txt`를 붙입니다. 환경 변수 토큰이 있으면 그것을 우선합니다. 채널은 이름이나 번호를 씁니다. `-`는 새 글입니다. `read --since`는 서버의 `before` 페이지를 따라가서 지정 번호보다 뒤인 글만 반환합니다. 표도 본문에 그대로 쓸 수 있습니다.

첨부는 25MB 이하의 png, jpg, webp, gif, pdf, txt, md, csv, json, zip을 받습니다. 글을 만든 뒤 `POST /attachments?message_id=<글번호>`로 multipart `file`을 보냅니다. 업로드 실패 안내에 글 번호가 있으면 글은 이미 올라갔으므로 같은 글을 다시 올리지 마세요.

`watch`는 자기 역할의 `@assistant` 같은 멘션이 있는 글만 JSON 한 줄로 출력합니다. 역할은 `--role` 또는 `NAIA_MESSENGER_ROLE`로 지정합니다. 토큰만으로 역할을 알아내지 않습니다. 연결이 끊기면 마지막 이벤트 번호로 다시 연결합니다. Ctrl+C로 끝냅니다.

승인을 묻는 문장은 업무-요청 채널에서 다음 양식으로 씁니다. 문서 주소는 `NAIA_DASHBOARD_PUBLIC_URL`(설정했을 때) 아래의 `/d/` 주소여야 하고, 설정하지 않으면 https 주소면 됩니다.

```text
1. 제목: [배포] 새 버전 적용
2. 요약: 적용 승인 부탁합니다
3. 문서: https://dashboard.example.com/d/문서키
4. 승인 코드 (다음 글)
PLAN-ABC123 STEP-DEF456
```

## 역할

메신저가 아는 AI 역할은 서버 환경 변수 `NAIA_MESSENGER_ROLES`로 정합니다. `아이디` 또는 `아이디:표시 이름`을 쉼표로 잇습니다. 정하지 않으면 `naia` 하나입니다.

```sh
export NAIA_MESSENGER_ROLES='assistant:비서,reviewer:검토'
```

역할마다 사람과의 개인 대화가 생기고, 글 속 `@역할`이 그 역할을 깨웁니다. 대화 화면의 `@` 자동 완성도 서버의 `GET /api/portal/messenger/roles` 목록을 씁니다. 역할 아이디는 영어 소문자로 시작하고 영어 소문자·숫자·`_`·`-`만 씁니다.

## 사람 신원(로그인 게이트)

대화 화면에서 사람이 글을 쓰려면 대시보드 앞에 로그인 게이트가 있어야 합니다. 게이트는 요청에 공유 비밀 `x-naia-gate-secret`과 계정 `x-ax-account-key`(영어 소문자 계정 이름)를 붙이고, 대시보드는 `NAIA_GATE_SECRET_FILE`(권한 600, 32자 이상)의 값과 맞을 때만 그 계정을 API에 넘깁니다. 비밀 파일이 없으면 사람은 401을 받고, 토큰을 받은 에이전트만 글을 씁니다. 게이트가 루프백이 아닌 주소에서 오면 그 주소를 `NAIA_IDENTITY_TRUSTED_PROXIES`에 넣습니다.

`x-ax-*` 머리글은 이 저장소가 정한 것이 아니라 앞단 외부 로그인 게이트가 넣는 머리글 규약입니다. 앞단 게이트는 브라우저가 보낸 `x-ax-account-key`와 표시 이름 `x-ax-user`를 반드시 지우고 확인한 값으로 덮어써야 합니다. 대시보드는 확인된 요청의 표시 이름을 한 개일 때만 넘기지만, 게이트가 브라우저 값을 그대로 흘려보내면 사람이 자기 표시 이름을 바꿀 수 있습니다(계정 키는 비밀 확인으로 지켜집니다).

`NAIA_DASHBOARD_PUBLIC_URL`을 정하면 승인 양식의 첫 `3. 문서:` 줄이 그 주소 아래 `/d/` 문서여야 합니다. 값이 `https://호스트[:포트]` 꼴이 아니면 서버는 시작할 때 경고하고 승인 양식을 하나도 받지 않습니다. 정하지 않으면 아무 https 주소의 `/d/` 문서를 받습니다. 에이전트 CLI도 자기 환경 변수로 같은 검사를 하므로, 역할별 env 파일(`~/<역할>/.naia-messenger/env`)에도 서버와 같은 값을 넣어 두세요. 넣지 않으면 CLI는 보내고 서버는 승인 카드를 만들지 않습니다.

`NAIA_MESSENGER_ENABLED=0`이면 메신저 길을 모두 끄고 화면의 대화 탭도 숨깁니다.

## 깨움 연결

서버는 역할 멘션을 받으면 깨움을 대기 폴더(`NAIA_MESSENGER_WAKE_SPOOL_DIR`, 기본은 DB 옆 `wake-spool/`)에만 씁니다. 역할 깨움 폴더로 옮기는 일은 `scripts/messenger/wake-move.mjs`가 깨움 폴더 주인 계정으로 합니다(cron 1분, `flock -n`으로 감쌈).

```sh
node scripts/messenger/wake-move.mjs --spool /var/lib/naia-adk/messenger/wake-spool --root /ADK/뿌리
```

옮길 곳은 `<뿌리>/.agents/work/l4/roles.json`에 그 역할의 `wakeDir`가 있으면 그곳, 없으면 `.agents/work/l4/wake/<역할>/`입니다. `NAIA_MESSENGER_ROOT_WAKE_ROLE`로 정한 역할 하나는 `wake/` 바로 아래로 옮깁니다. 파일 이름은 `<YYYYMMDDHHMMSSmmm>-<글번호>-route-<역할>.md`, 첫 줄은 `[메신저] #<채널> <역할> 확인 요청: <대시보드 주소>/messages/<채널>/<글>`이고, 다음 줄에 그대로 붙여 쓸 답글 명령이 있습니다. 깨움 파일을 읽어 역할을 실제로 실행하는 쪽은 각 포크가 연결합니다. 대기 없이 바로 받으려면 위 `watch` 명령을 씁니다.

## 포트 붙잡기(systemd 예시)

`scripts/messenger/systemd/`에 API(3141)·대시보드(3142) 포트를 systemd 소켓이 쥐고 서비스에 넘기는 예시 단위가 있습니다. 서비스가 재시작하는 동안 다른 로컬 계정이 포트를 잡아 비밀을 받는 일을 막습니다. 경로와 단위 이름은 설치에 맞게 바꾸고, 시작 전에 `node scripts/messenger/check-unit-paths.mjs <단위 파일>`로 단위가 요구하는 경로가 있는지 봅니다.

서버의 10분 재깨움·30분 무응답 알림은 서버 담당 기능입니다. CLI는 서버가 보낸 이벤트를 소비합니다.

## 확인

```sh
node --test scripts/messenger/*.test.mjs
```

시험은 임시 DB와 가짜 HTTP 서버를 씁니다. 실제 운영 서비스에 요청하지 않습니다.
