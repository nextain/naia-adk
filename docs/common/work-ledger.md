# 업무 장부와 10분 감시

## 왜 필요한가

부탁받은 일과 기한을 대화 안에만 두면 세션이 다시 시작되거나 대화가 줄어들 때 놓칠 수 있습니다. 일꾼이 결과 파일을 써도 담당자가 읽지 않으면 일이 멈춥니다. 업무 장부는 할 일을 파일로 남기고, 감시 대본은 세션 밖에서 10분마다 장부를 확인해 담당 역할을 깨웁니다.

부탁·지시를 받으면 답하기 전에 `add`로 기록합니다. 끝난 일은 `done`, 중단한 일은 까닭과 함께 `drop`으로 남깁니다. 일꾼에게 맡겼다면 결과 경로와 끝 파일을 함께 기록합니다. 결과를 실제로 읽은 다음 `touch`로 확인 시각을 남깁니다.

## 사람에게 묻고 기다릴 때

이미 지시가 있고 되돌릴 수 있는 일은 다시 묻지 않습니다. 앞선 지시와 범위를 확인한 뒤 진행하고 결과를 알립니다. 바깥 발송·운영 변경·돈처럼 사람 승인이 필요한 경계는 지킵니다.

사람에게 물을 때는 상대를 멘션하거나 그 사람 글에 답글을 달고, “N분 안에 말씀 없으면 이렇게 진행하겠습니다”처럼 기다릴 시간과 그 뒤 행동을 함께 적습니다. 침묵은 필요한 승인 대신 쓰지 않습니다. 정말 승인이 필요하면 업무 요청 채널에 `[분류]` 양식으로 옮깁니다.

사람 대기의 주 감시는 업무 카드입니다. `.agents/scripts/task-cards.mjs`와 `docs/guides/work-ledger.md`에 맞춰 카드를 `waiting`으로 남기고, `wait_reason`과 다시 볼 시각 `recheck_at`을 적습니다. 사람 승인을 기다리면 요청 글 주소·번호인 `request_ref`도 필수입니다. `recheck_at`은 시간대를 포함한 ISO 시각으로 최대 4시간 뒤이며, 카드에서 내보낸 장부의 `due_at`에 대응합니다. 카드의 `due`는 업무 기한으로 유지합니다. 이 문서의 JSON 장부에서 `waiting_human`을 쓸 때는 `due`에 재확인 시각을, `note`에 기다리는 답과 다음 행동을 적습니다. 시각 없는 대기로 일을 내려놓지 않습니다.

## 장부 모양

역할별 장부는 `<ADK 뿌리>/.agents/work/ledger/<역할>.json`에 둡니다. 다음은 예시입니다.

```json
{
  "version": 1,
  "role": "secretary",
  "report": {"every_min": 60, "channel": "CHANNEL_ID", "last_msg_id": null, "last_at": null},
  "items": [{
    "id": "example-task",
    "title": "초안 검토",
    "from": {"channel": "CHANNEL_ID", "msg_id": "MESSAGE_ID", "quote": "초안을 검토해 주세요"},
    "due": "2030-01-02T09:00:00.000Z",
    "status": "open",
    "worker": {"name": "writer", "result": "results/draft.md", "done_file": "results/draft.done"},
    "checked_at": null,
    "note": ""
  }]
}
```

기한은 UTC ISO 시각으로 씁니다. 상태는 `open`(진행 중), `waiting_human`(사람 답변 기다림), `done`(완료), `dropped`(중단)입니다. 일꾼이 없으면 `worker`는 `null`입니다. 쓰기는 잠금 안에서 임시 파일을 만든 뒤 이름을 바꿉니다. 동시에 명령을 실행해도 서로의 항목을 덮어쓰지 않습니다. 잠금은 Linux의 `flock`을 사용합니다. 프로세스가 강제 종료되거나 재부팅되어도 운영체제가 잠금을 풀므로 남은 `.lock` 파일을 지울 필요가 없습니다.

## 명령

저장소 뿌리에서 실행합니다. 다른 디렉터리에서는 `--root`에 ADK 뿌리를 지정합니다. 예시의 ID와 시각을 실제 값으로 바꿉니다.

```sh
node scripts/work-ledger/ledger.mjs --root . --role secretary add --title '초안 검토' --due '2030-01-02T09:00:00Z' --channel CHANNEL_ID --msg-id MESSAGE_ID --quote '초안을 검토해 주세요' --worker-name writer --result results/draft.md --done-file results/draft.done
node scripts/work-ledger/ledger.mjs --root . --role secretary list
node scripts/work-ledger/ledger.mjs --root . --role secretary touch --id ITEM_ID
node scripts/work-ledger/ledger.mjs --root . --role secretary done --id ITEM_ID
node scripts/work-ledger/ledger.mjs --root . --role secretary drop --id ITEM_ID --reason '요청자가 중단함'
node scripts/work-ledger/ledger.mjs --root . --role secretary report --every-min 60 --channel CHANNEL_ID --msg-id REPORT_MESSAGE_ID
```

`add`가 출력한 항목 ID를 이후 명령에 씁니다. `touch`는 결과를 읽었다는 표시이며 완료 처리는 별도입니다. `report`는 실제 보고를 보낸 뒤 그 글 ID와 보낸 시각을 기록합니다. 이 명령이 메신저로 보고를 보내지는 않습니다. 장부의 보고 주기가 0이면 역할 설정의 보고 주기를 사용합니다. 정기 보고를 끄려면 설정과 장부의 주기를 모두 0으로 둡니다.

## 깨우는 까닭

| 까닭 | 언제 깨우나 |
| --- | --- |
| 기한 넘음 | `open` 항목의 기한이 지났을 때 |
| 일꾼 끝, 결과 안 읽음 | 끝 파일이 있고, 결과 확인 시각이 끝 파일 수정 시각보다 앞일 때 |
| 장부에 없는 사람 글 | 최근 24시간(작성 또는 수정 시각 기준) 사람·중계·웹훅 글 중 담당 역할 몫인 글이 장부 출처에 없고, 담당 역할이 그 글(수정된 경우 수정 시각 뒤)에 답글도 달지 않았을 때 |
| 사람에게 묻고 멈춤(보조) | 대기 카드를 남기지 않은 질문을 찾는 안전망으로, 감시 채널·쓰레드·1:1 채널에서 기본 15분 동안 답이 없는 질문마다 한 번 깨울 때 |
| 정기 보고 시각 | 마지막 보고 이후 설정한 분 수가 지났을 때 |

사람 글은 `human_ids` 작성자 글과 설정한 중계 작성자(`relay_ids`) 또는 웹훅(`webhook_id`)이 옮긴 글을 포함합니다. 다음 넷 중 하나에 해당하면 다른 역할이나 다른 봇 멘션이 함께 있어도 담당 역할 몫으로 깨웁니다(놓침 방지 우선):

1. 역할의 `user_ids` 사용자 멘션(`<@id>`, `<@!id>`, `mentions` 배열) 또는 `role_ids` 역할 멘션(`<@&ROLE_ID>`, `mention_roles` 배열)이 있는 글
2. 담당 역할이 작성한 글(또는 담당 역할 글에서 시작된 쓰레드)에 대한 답글
3. `@everyone`·`@here` 전체 호출(`mention_everyone: true` 또는 `@` 앞이 단어 경계인 `@everyone`·`@here`; `help@here.com`, `team@everyone.org` 같은 이메일 주소는 제외)
4. 역할의 `direct_channels`에 지정한 1:1 채널 글(`direct_channels`는 감시 채널에도 자동으로 포함)

담당 역할 멘션이 없고 1:1 채널이 아닌 상태에서 다른 역할 글에 달린 답글은 본문에 `@everyone`·`@here`가 있어도 그 다른 역할 몫으로 보아 제외합니다. 담당 역할과 아무 관계 없는 일반 채널 글일 때도 다른 역할만 부른 글과 설정에 없는 다른 봇 멘션만 있는 글을 제외합니다.

수정된 글(`edited_timestamp`가 마지막 확인이나 이전 답변·장부 확인 뒤인 글)도 수정 시각을 기준으로 새 글처럼 다시 판정합니다. 메신저 페이지네이션은 첫 페이지 작성 시각이 24시간 이전이더라도 수정 시각과 페이지 상한(`max_pages`, 기본 10)까지 다음 페이지를 이어서 확인해 오래된 글의 최근 수정을 놓치지 않습니다. 장부 확인 완료 판정은 본문 문자열 일치가 아니라 확인 시각(`checked_at >= edited_timestamp`)과 멘션 집합 비교로 판정합니다. 이미 깨운 글이 수정 뒤에도 멘션 집합과 미처리 판정이 같으면 30분 동안 중복 깨움을 억제하고, 새 멘션이 추가되거나 답변·장부 확인 뒤에 수정되면 다시 깨웁니다.

역할 설정의 `answered_by_any_role_post_after`는 기본 `false`입니다. 기본값에서는 같은 채널·같은 쓰레드에서 해당 사람 글에 직접 단 담당 역할 답글만 답변으로 봅니다. `true`이면 같은 채널·같은 쓰레드에서 그 사람 글의 유효 시각(수정된 경우 수정 시각)보다 뒤에 담당 역할이 올린 일반 글도 답변으로 봅니다. 다른 채널이나 다른 쓰레드의 글, 다른 역할의 글, 사람 글 이전의 글은 답변으로 보지 않습니다.

감시 채널을 읽을 때는 길드 활성 쓰레드(`/guilds/{guild.id}/threads/active`)와 감시 채널 글에 달린 쓰레드(`thread`)도 함께 읽습니다. 한 번에 읽는 쓰레드 수 상한은 `max_threads`(기본 25)로 제한하되, 상한을 넘는 쓰레드는 감시 상태 파일의 라운드로빈 커서로 다음 실행에서 이어서 읽어 영구 누락을 막습니다. 길드 활성 쓰레드 목록은 감시 한 회차에 길드마다 한 번만 조회해 역할과 채널 사이에 공유합니다. Discord가 HTTP 429를 반환하면 한 번 최대 5초, 회차당 누적 30초 예산 안에서 한 번 기다렸다 다시 읽습니다. 이 상한을 넘는 `retry_after`는 기다리지 않고 이번 회차를 건너뜁니다. 다시 429이면 해당 채널·쓰레드는 이번 회차만 건너뛰고 경고를 남깁니다. 이 경우만 있으면 종료코드는 0입니다. 같은 채널에서 3회차 연속 429가 나면 담당 역할을 깨우며, 정상적으로 읽은 회차에는 연속 실패 수를 지웁니다. 채널 읽기 사이에는 기본 300ms 간격을 둡니다. 다른 활성 쓰레드 목록 조회 오류(404·403 포함)나 메신저 채널·쓰레드 읽기 오류는 해당 대상과 HTTP 상태, 응답 본문 앞 200자를 실패 깨움에 남긴 뒤 나머지 쓰레드·채널을 계속 확인합니다. `safeName` 규칙(`^[a-zA-Z0-9][a-zA-Z0-9_-]*$`)이 막는 채널·쓰레드·메시지 ID 모양을 만나더라도 감시 전체가 죽지 않고 그 한 건만 오류 깨움으로 남긴 뒤 다음 검사를 이어 갑니다. 실패 건마다 30분 동안 중복을 억제합니다.

같은 항목의 같은 까닭은 30분 안에 다시 깨우지 않습니다. 다른 까닭은 따로 확인합니다. 장부를 읽을 수 없거나 깨졌으면 실패를 깨움으로 알립니다. 실패를 정상 검사처럼 넘기지 않습니다.

깨움은 `.agents/work/l4/wake/<YYYYMMDDHHMMSSmmm>-ledger-<항목id>-route-<역할>.md` 파일로 남깁니다. 첫 줄은 `[장부] <까닭>: <제목>`이며 이어서 출처, 기한, 결과 경로를 적습니다. 소비자는 파일명의 `-route-<역할>.md`를 읽어 해당 역할로 전달해야 합니다. 역할별 하위 폴더는 만들지 않으며 `wake_subdir`로 경로를 바꾸지 않습니다. 최상위 폴더 파일을 한 역할로만 보내는 구형 소비자와는 호환되지 않으므로, 그 소비자를 그대로 둔 서버에는 여러 역할 감시 설정을 적용하지 않습니다. 감시 자체는 업무를 완료하거나 메신저 답글을 보내지 않습니다.

## 사람 기다림 감지

주 감시는 `waiting` 업무 카드와 `recheck_at`입니다. `ledger-watch`의 메신저 질문 추론은 카드가 없을 때 한 번 깨워 대기 카드를 남기게 하는 보조 안전망으로만 사용합니다. 이 감시기가 업무 카드의 존재를 조회하거나 카드 감시를 대신하지는 않습니다. 깨움을 받은 역할이 먼저 카드를 확인하고, 이미 있으면 기존 카드의 재확인 시각을 따릅니다.

질문은 인용문·코드블록을 제외한 본문에서 찾습니다. 완료 보고의 조건부 끝인사와 자문자답, 다른 봇에게만 한 질문은 제외합니다. 짧은 시간에 같은 봇이 연속 전송한 분할 글은 사람 멘션·답글 참조와 질문 문장을 함께 판정합니다. 사람이 시작한 쓰레드와 설정된 1:1 채널에서는 멘션 없는 질문도 확인합니다.

대기는 질문 대상인 사람이 답했을 때만 닫습니다. 같은 채널의 그 사람 글, 질문을 참조한 답글, 질문에서 파생된 쓰레드의 답을 보관 여부와 무관하게 인정합니다. 질문한 봇의 다른 주제 글이나 다른 봇과의 협업 글로는 닫지 않습니다. 질문 작성 시각으로 답의 선후를 비교하므로 나중에 오타를 고쳐도 이미 받은 답이 무효가 되지 않습니다. 감시 기준 시간이 지난 질문은 다음 검사 회차에 한 번 깨웁니다.

`human_wait.after_min`은 기다릴 분 수(기본 15), `human_wait.question_patterns`는 질문을 찾는 정규식 문자열 목록입니다. 역할 안의 `human_wait`로 공통 설정을 덮어쓸 수 있습니다. 사람은 기존 `human_ids` 또는 `humans` 목록(역할 설정 우선, 없으면 공통 설정), 봇 사용자 ID와 역할 연결은 `roles[].user_ids`로 정합니다. 읽기 간격은 공통 `channel_read_interval_ms`(기본 300)입니다. 다음은 가짜 ID를 쓴 설정 일부입니다.

```json
{
  "channel_read_interval_ms": 300,
  "human_wait": {
    "after_min": 15,
    "question_patterns": ["[?？](?:\\s|$)", "(?:골라\\s*주시면|고르시면)"]
  },
  "roles": [{
    "role": "assistant",
    "user_ids": ["EXAMPLE_BOT_USER"],
    "human_ids": ["EXAMPLE_HUMAN_USER"],
    "channels": ["EXAMPLE_CHANNEL"],
    "check_unrecorded_human": false
  }]
}
```

봇 사용자 ID와 역할의 연결은 인스턴스 설정으로 정합니다. 깨움은 위의 평면 경로와 `route` 역할 표기를 쓰며, 채널·질문 글 주소·질문 첫 줄과 다음 행동을 담습니다.

1. 이미 받은 지시가 있는지 그 채널 앞 글을 다시 읽습니다.
2. 바깥 발송·운영 변경·돈이 아니고 되돌릴 수 있으면 지금 진행하고 그 채널에 알립니다.
3. 정말 사람 승인이 필요한 일이면 업무 요청 채널에 `[분류]` 양식으로 옮기고 대기 카드를 `waiting`으로 남깁니다. `recheck_at`과 `request_ref`를 함께 적습니다.

JSON 장부를 사용하지 않고 사람 기다림만 확인하는 역할에는 `check_unrecorded_human: false`를 명시합니다. 기본값은 `true`이므로 빈 장부에 역할만 추가하면 기존 사람 글 감시도 함께 켜집니다. `provider.guild_id`와 전체 팀의 `roles[].user_ids`, 담당 채널 목록은 실제 라우팅 설정과 대조합니다.

분할 질문은 모든 조각의 깨움 기록을 남겨 뒷 조각만 다음 검사에 남아 다시 깨우지 않게 합니다. 질문별 깨움 기록을 감시 상태 파일에 남겨 다음 회차에 중복해서 깨우지 않습니다. 손상된 상태는 한 번 알리고 새로 시작하되, 별도 중복 방지 증거로 이미 깨운 질문을 다시 깨우지 않습니다. 기록은 감시 보존 기간에 맞춰 정리합니다. 감시기는 메신저로 글을 보내지 않고 역할을 깨우는 파일만 만듭니다. 채널·사람·봇의 실제 ID와 요청 채널 이름은 비공개 인스턴스 설정에 둡니다.

## 설정과 설치

CLI와 감시 대본은 Node.js 22 이상과 util-linux의 `flock`이 설치된 Linux에서 실행합니다. 현재 Windows와 macOS는 지원하지 않습니다. 타이머 설치에는 사용자 systemd도 필요합니다.

`config/work-ledger.example.json`을 `config/work-ledger.json`으로 복사하고 역할, 그 역할의 메신저 사용자 ID, 감시 채널, 사람 사용자 ID를 채웁니다. 역할과 채널은 서버마다 설정하므로 코드에 회사나 기기 이름을 넣지 않습니다. Discord 토큰은 `provider.token_env`에 지정한 환경 변수로 전달하며 설정 파일에 토큰을 적지 않습니다. 메신저 읽기는 공급자 어댑터를 통해 하므로 다른 REST 메신저를 붙일 때 장부 규칙을 바꿀 필요가 없습니다.

먼저 한 번 검사할 수 있습니다. Discord 읽기에는 해당 채널의 읽기 권한과 토큰 환경 변수가 필요합니다.

```sh
node scripts/work-ledger/ledger-watch.mjs --root . --config config/work-ledger.json
```

설치 대본은 사람이 직접 실행할 때만 사용자 systemd 파일을 작성합니다. 저장소 작업 중에는 실행하지 않습니다. Node.js와 사용자 systemd가 있는 Linux에서 다음과 같이 설치합니다.

```sh
bash scripts/work-ledger/install-timer.sh --root "$PWD" --config "$PWD/config/work-ledger.json"
```

대본이 출력하는 `systemctl --user daemon-reload`와 `systemctl --user enable --now work-ledger-watch.timer` 명령을 운영자가 실행하면 10분 타이머가 시작됩니다. 토큰 환경 변수는 서비스 실행 환경에 별도로 전달해야 합니다. 설치 대본은 토큰을 읽거나 저장하지 않습니다. 타이머 상태는 `systemctl --user status work-ledger-watch.timer`, 검사 기록은 `journalctl --user -u work-ledger-watch.service`로 확인합니다. 정지는 `systemctl --user disable --now work-ledger-watch.timer`입니다.
