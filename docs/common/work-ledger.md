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

기한은 UTC ISO 시각으로 씁니다. 상태는 `open`(진행 중), `waiting_human`(사람 답변 기다림), `escalated_human`(사람에게 올림), `done`(완료), `dropped`(중단)입니다. 일꾼이 없으면 `worker`는 `null`입니다. 쓰기는 잠금 안에서 임시 파일을 만든 뒤 이름을 바꿉니다. 동시에 명령을 실행해도 서로의 항목을 덮어쓰지 않습니다. 잠금은 Linux의 `flock`을 사용하며 `.lock` 파일에 현재 `pid`와 시작 시각도 함께 기록합니다. 프로세스가 강제 종료되거나 재부팅되어도 운영체제가 잠금을 풀므로 남은 `.lock` 파일을 지울 필요가 없습니다.

사람 지시에서 온 항목(`from.msg_id`가 `-`가 아닌 카드)에는 반복 취소·연기 상한이 걸립니다.

- **중단(`drop`) 2회 상한**: 같은 사람 지시(공백을 손질한 `from.msg_id` 기준 합산 — 카드를 `drop`한 뒤 같은 `msg_id`로 새 카드를 다시 만들어 반복 `drop`하는 경우도 포함)에서 `drop`이 2회를 넘으면(3회째 시도) 명령을 거절하고 카드를 `escalated_human`("사람에게 올림") 상태로 전환합니다. 한 번 `escalated_human`에 들어갔거나 취소·연기 누적 횟수가 상한을 넘긴 `msg_id`로는 카드를 나중에 닫더라도 새 카드를 다시 `add`할 수 없습니다.
- **기한 미룸(`due`) 2회 상한**: 사람 지시 카드의 기한을 기존 기한보다 뒤로 미루는 변경이 2회를 넘으면(3회째 연기 시도) 명령을 거절하고 `escalated_human` 상태로 전환합니다. 기한을 앞당기거나 내부 카드(`--msg-id -`)를 조정하는 경우에는 상한이 걸리지 않습니다.
- **사람 확인 뒤 완료(`done --human-msg-id`)**: `escalated_human` 상태인 카드를 `done`으로 닫을 때는 원래 지시 `msg_id`와 다른 사람 확인 답글 번호(`--human-msg-id <답글 ID>`)를 함께 적어야 합니다. 확인 근거 없는 단독 `done`은 거절됩니다.

## 명령

저장소 뿌리에서 실행합니다. 다른 디렉터리에서는 `--root`에 ADK 뿌리를 지정합니다. 예시의 ID와 시각을 실제 값으로 바꿉니다.

```sh
node scripts/work-ledger/ledger.mjs --root . --role secretary add --title '초안 검토' --due '2030-01-02T09:00:00Z' --channel CHANNEL_ID --msg-id MESSAGE_ID --quote '초안을 검토해 주세요' --worker-name writer --result results/draft.md --done-file results/draft.done
node scripts/work-ledger/ledger.mjs --root . --role secretary list
node scripts/work-ledger/ledger.mjs --root . --role secretary touch --id ITEM_ID
node scripts/work-ledger/ledger.mjs --root . --role secretary done --id ITEM_ID --result results/draft.md
node scripts/work-ledger/ledger.mjs --root . --role secretary drop --id ITEM_ID --reason '요청자가 중단함'
node scripts/work-ledger/ledger.mjs --root . --role secretary report --every-min 60 --channel CHANNEL_ID --msg-id REPORT_MESSAGE_ID
```

`add`가 출력한 항목 ID를 이후 명령에 씁니다. `touch`는 결과를 읽은 시각(`checked_at`)을 갱신합니다. 일반 카드는 `done --result`에 내용이 있는 결과 파일 또는 HTTP(S) 주소를 주면 그 위치(`result`)와 완료 시각(`completed_at`)을 같은 카드에 기록합니다. 상대 파일 경로의 기준은 `--root`입니다. HTTP(S) 주소는 참조용으로 저장합니다.

설정에 등록한 사람이 이미 확인한 경우에는 `--human-msg-id 답글_ID`로 그 답글을 결과로 남길 수도 있습니다. 답글에 카드 ID가 있거나 해당 카드의 원글에 단 답글이어야 합니다. 다른 채널의 답글은 `--channel 채널_ID`를 함께 줍니다. 이전에 완료한 카드는 기존 기록대로 조회됩니다.

`report`는 실제 보고를 보낸 뒤 그 글 ID와 보낸 시각을 기록합니다. 장부의 보고 주기가 0이면 역할 설정의 보고 주기를 사용합니다. 정기 보고를 끄려면 설정과 장부의 주기를 모두 0으로 둡니다.

## 깨우는 까닭

| 까닭 | 언제 깨우나 |
| --- | --- |
| 기한 넘음 | `open` 또는 `waiting_human` 항목의 기한이 지났을 때 (`waiting_human`은 깨운 뒤 기한을 다음 날로 하루 밀어 하루 한 번 다시 알림) |
| 사람에게 올림 | 사람 지시 카드가 `drop` 2회 초과 또는 기한 미룸 2회 초과로 `escalated_human` 상태가 되었을 때 |
| 일꾼 끝, 결과 안 읽음 | 끝 파일이 있고, 결과 확인 시각이 끝 파일 수정 시각보다 앞일 때 |
| 장부에 없는 사람 글 | 최근 24시간(작성 또는 수정 시각 기준) 사람·중계·웹훅 글 중 담당 역할 몫인 글이 장부 출처(`items[].from.msg_id`)에 없을 때(메신저 답글만 달고 장부에 등록하지 않은 글도 닫힌 것으로 보지 않음) |
| 사람에게 묻고 멈춤(보조) | 대기 카드를 남기지 않은 질문을 찾는 안전망으로, 감시 채널·쓰레드·1:1 채널에서 기본 15분 동안 답이 없는 질문마다 한 번 깨울 때 |
| 정기 보고 시각 | 마지막 보고 이후 설정한 분 수가 지났을 때 |

사람 글은 `human_ids` 작성자 글과 설정한 중계 작성자(`relay_ids`) 또는 웹훅(`webhook_id`)이 옮긴 글을 포함합니다. 다음 넷 중 하나에 해당하면 다른 역할이나 다른 봇 멘션이 함께 있어도 담당 역할 몫으로 깨웁니다(놓침 방지 우선):

1. 역할의 `user_ids` 사용자 멘션(`<@id>`, `<@!id>`, `mentions` 배열) 또는 `role_ids` 역할 멘션(`<@&ROLE_ID>`, `mention_roles` 배열)이 있는 글
2. 담당 역할이 작성한 글(또는 담당 역할 글에서 시작된 쓰레드)에 대한 답글
3. `@everyone`·`@here` 전체 호출(`mention_everyone: true` 또는 `@` 앞이 단어 경계인 `@everyone`·`@here`; `help@here.com`, `team@everyone.org` 같은 이메일 주소는 제외)
4. 역할의 `direct_channels`에 지정한 1:1 채널 글(`direct_channels`는 감시 채널에도 자동으로 포함)

담당 역할 멘션이 없고 1:1 채널이 아닌 상태에서 다른 역할 글에 달린 답글은 본문에 `@everyone`·`@here`가 있어도 그 다른 역할 몫으로 보아 제외합니다. 담당 역할과 아무 관계 없는 일반 채널 글일 때도 다른 역할만 부른 글과 설정에 없는 다른 봇 멘션만 있는 글을 제외합니다.

수정된 글(`edited_timestamp`가 마지막 확인이나 이전 답변·장부 확인 뒤인 글)도 수정 시각을 기준으로 새 글처럼 다시 판정합니다. 메신저 페이지네이션은 첫 페이지 작성 시각이 24시간 이전이더라도 수정 시각과 페이지 상한(`max_pages`, 기본 10)까지 다음 페이지를 이어서 확인해 오래된 글의 최근 수정을 놓치지 않습니다. 장부 확인 완료 판정은 본문 문자열 일치가 아니라 확인 시각(`checked_at >= edited_timestamp`)과 멘션 집합 비교로 판정합니다. 이미 깨운 글이 수정 뒤에도 멘션 집합과 미처리 판정이 같으면 30분 동안 중복 깨움을 억제하고, 새 멘션이 추가되거나 답변·장부 확인 뒤에 수정되면 다시 깨웁니다.

기존 설치에서 `intake` 설정을 생략하면 역할이 원글을 `add`로 직접 기록합니다. 메신저에 답하더라도 카드가 없으면 미등록 알림이 계속됩니다.

새 설치 예시에는 `intake.enabled: true`가 들어 있습니다. 이 설정을 켜면 감시기가 등록된 사람이나 중계자가 역할에 보낸 요청을 처음 읽을 때 열린 카드를 만들고, 해당 역할의 깨움에 카드 번호를 넣습니다. 같은 원글과 그 답글은 같은 카드에서 추적합니다. 기존 카드를 다시 읽어도 닫힌 상태와 담당자는 보존됩니다. 카드를 명시적으로 만들 때 `add`가 돌려주는 번호를 사용하고, 이미 접수된 카드에 지시서를 붙일 때는 `adopt`를 사용합니다. 모델 실행은 접수와 별도입니다.

접수 때 임시로 정하는 기한은 `intake.defaultDueMinutes`(기본 120분)이며 카드에 `due_assumed`로 표시합니다. 기존 설치를 옮길 때 `intake.since`에 전환 시각(UTC ISO)을 적으면 그 시각부터 작성된 요청을 접수합니다. `intake`는 역할별로 설정할 수 있습니다.

최근 조회 목록에서 빠진 답글도 메신저가 제공하는 원글 참조를 따라 기존 카드에 연결합니다. 일시적인 조회 오류가 나면 다음 감시 때 같은 답글을 다시 처리합니다. 삭제나 접근 제한으로 참조를 읽을 수 없는 경우에는 현재 글의 수신 역할과 확인 가능한 스레드 정보로 접수합니다.

- 외부 확인 목록(`answered_elsewhere_file`): 설정에 파일 경로를 명시한 경우에만 읽습니다(자동 경로 탐색 없음). 줄마다 `<글 ID> <기록 시각 ISO> <이유>` 형식이어야 하며, 7일이 지난 줄은 무시합니다. 사람이 `<기록 시각 ISO>`보다 뒤에 글을 수정하면 억제하지 않고 다시 깨웁니다.
- 재깨움 상한과 `waiting_human`:
  - 일반 미등록 사람 글은 재깨움 상한(`max_human_wakes`, 기본 `3`회 — `1` 이상 정수가 아니면 stderr에 경고 1줄을 남기고 기본값 사용)을 채운 뒤 다음 깨움 차례(쿨다운 30분 경과 뒤)에 깨움 대신 `waiting_human` 항목(초기 기한 4시간 뒤)을 등록합니다.
  - 멘션만 있는 빈 글(본문·첨부·임베드가 모두 비어 있는 글; 첨부 또는 임베드가 있으면 일반 글로 취급)은 상한 `1`회 뒤 동일하게 `waiting_human`을 등록합니다.
  - 24시간(`since`) 감시 창을 벗어나는 미등록 사람 글도 버리기 전에 `waiting_human`으로 등록합니다.
  - `waiting_human` 항목의 기한이 지나면 한 번 깨운 뒤 기한을 다음 날(+24시간)로 밀어 하루 한 번 다시 깨우며, 사람이 해당 글을 수정하거나 같은 쓰레드에 새 글을 올리면 재깨움 상한을 초기화해 다시 깨웁니다.
- 감시 상태와 공통 기본값:
  - `watch-state.json`에서 일부 항목·값이 손상되면 해당 항목만 버리고 나머지 `sent`·쿨다운·횟수는 유지하며, `wake_counts` 정수는 `0..상한` 범위로 자릅니다.
  - `user_ids`는 역할(`roles[]`)별로만 설정하며(`defaults`·최상위 상속 금지), 나머지 공통 설정 키(`channels`, `direct_channels`, `human_ids`, `relay_ids`, `report`, `max_threads`, `guild_id`, `human_wait`, `check_unrecorded_human`, `answered_by_any_role_post_after`, `answered_elsewhere_file`, `max_human_wakes` 등)는 역할별 → `defaults.<키>` → 최상위 `<키>` 순으로 물려받습니다.

감시 채널을 읽을 때는 길드 활성 쓰레드(`/guilds/{guild.id}/threads/active`)와 감시 채널 글에 달린 쓰레드(`thread`)도 함께 읽습니다. 한 번에 읽는 쓰레드 수 상한은 `max_threads`(기본 25)로 제한하되, 상한을 넘는 쓰레드는 감시 상태 파일의 라운드로빈 커서로 다음 실행에서 이어서 읽어 영구 누락을 막습니다. 길드 활성 쓰레드 목록은 감시 한 회차에 길드마다 한 번만 조회해 역할과 채널 사이에 공유합니다. Discord가 HTTP 429를 반환하면 한 번 최대 5초, 회차당 누적 30초 예산 안에서 한 번 기다렸다 다시 읽습니다. 이 상한을 넘는 `retry_after`는 기다리지 않고 이번 회차를 건너뜁니다. 다시 429이면 해당 채널·쓰레드는 이번 회차만 건너뛰고 경고를 남깁니다. 이 경우만 있으면 종료코드는 0입니다. 같은 채널에서 3회차 연속 429가 나면 담당 역할을 깨우며, 정상적으로 읽은 회차에는 연속 실패 수를 지웁니다. 채널 읽기 사이에는 기본 300ms 간격을 둡니다. 다른 활성 쓰레드 목록 조회 오류(404·403 포함)나 메신저 채널·쓰레드 읽기 오류는 해당 대상과 HTTP 상태, 응답 본문 앞 200자를 실패 깨움에 남긴 뒤 나머지 쓰레드·채널을 계속 확인합니다. `safeName` 규칙(`^[a-zA-Z0-9][a-zA-Z0-9_-]*$`)이 막는 채널·쓰레드·메시지 ID 모양을 만나더라도 감시 전체가 죽지 않고 그 한 건만 오류 깨움으로 남긴 뒤 다음 검사를 이어 갑니다. 실패 건마다 30분 동안 중복을 억제합니다.

지시서가 붙은 항목은 깨우는 데서 그치지 않고 일꾼을 띄웁니다. 아래 "지시서가 붙은 항목은 장부가 굴린다"를 봅니다.

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

## 지시서가 붙은 항목은 장부가 굴린다

깨우기만 하면 깨움을 받은 역할이 잊거나 다른 일을 하는 동안 일이 멈춥니다. 그래서 항목에 지시서를 붙일 수 있고, 지시서가 붙은 항목은 기한이 지나면 감시가 그 지시서로 일꾼을 직접 띄웁니다. 역할은 알림만 받습니다. 지시서가 없는 항목(약속·기한만 적은 항목)은 지금까지와 똑같이 동작합니다.

지시서를 붙이면 항목에 `drive` 칸이 생깁니다. 별도 장부 파일이나 별도 대본은 없습니다. 같은 `ledger.mjs`, 같은 장부 파일, 같은 잠금을 씁니다. `drive` 칸을 모르는 옛 판 코드는 이 칸을 읽지 않고 그대로 보존합니다.

```sh
node scripts/work-ledger/ledger.mjs --root . --role secretary add --title '초안 검토' --due '2030-01-02T09:00:00Z' --channel CHANNEL_ID --msg-id MESSAGE_ID --prompt work/draft-review.md --result-file results/draft-review.md --model MODEL_ID
node scripts/work-ledger/ledger.mjs --root . --role secretary adopt --id ITEM_ID --prompt work/draft-review.md --result-file results/draft-review.md --model MODEL_ID
node scripts/work-ledger/ledger.mjs --root . --role secretary start --id ITEM_ID
node scripts/work-ledger/ledger.mjs --root . --role secretary attach --id ITEM_ID --pid WORKER_PID
node scripts/work-ledger/ledger.mjs --root . --role secretary done --id ITEM_ID --result results/draft-review.md
node scripts/work-ledger/ledger.mjs --root . --role secretary confirm --id ITEM_ID --channel CHANNEL_ID --msg-id OWNER_MESSAGE_ID --as dropped --reason '요청자가 중단함'
node scripts/work-ledger/ledger.mjs --root . drive --dry
```

- `add`에 `--prompt --result-file --model` 셋을 함께 주면 지시서가 붙습니다. 셋 중 일부만 주거나, 지시서 파일이 없거나 비었거나, 결과 파일이 이미 있거나, 모델이 `drive.worker.models`에 없으면 등록을 거절합니다. 지시서 파일(`--prompt`)에는 [상위 구조 적합 세 칸](../guides/architecture-fit-before-fix.md)(`original_request`·`parent_structure`·`acceptance_rationale`)을 적고, `drive`의 기본 머리글(`DEFAULT_PREAMBLE`)도 실행 전 세 칸 확인을 일꾼에게 함께 전달합니다. `adopt`는 이미 있는 열린 항목에 지시서를 붙입니다.
- `start`는 기한을 기다리지 않고 지금 띄웁니다. `attach`는 손으로 띄운 일꾼의 프로세스 번호를 항목에 붙여 감시가 같은 일을 또 띄우지 않게 합니다.
- 지시서가 붙은 항목은 `drop`으로 닫지 못하고 `due`로 기한을 옮기지 못합니다. 닫는 길은 둘입니다. 결과가 있으면 `done --result <파일 또는 주소>`(파일이면 실제로 있고 내용이 있어야 함), 중단이면 `confirm`으로 `drive.owner_ids`에 적힌 사람이 그 항목 ID 앞 8자를 적은 글(또는 그런 글에 단 답글)을 가리킵니다. 기록 없이 닫힌 항목은 다음 순회가 다시 열고 그 역할에 알립니다.
- `drive`는 순회를 한 번 손으로 돌립니다. `--dry`는 무엇을 띄울지만 보여 주고 아무것도 쓰지 않습니다. 순회가 오류를 보고하면 종료 코드가 1입니다.

순회는 10분 감시(`ledger-watch.mjs`) 안에서 `drive.enabled`가 `true`일 때만 돕니다. 따로 거는 일정은 없습니다. 한 번 돌 때 설정의 모든 역할 장부를 보고 지시서가 붙은 열린 항목마다 다음을 합니다.

| 상태 | 하는 일 | 알림 |
| --- | --- | --- |
| 일꾼이 돌고 있음 | 다시 띄우지 않음 | `max_run_min`을 넘기면 "일꾼이 오래 돎" |
| 결과 파일에 내용이 있음 | 띄우지 않음 | "결과 나옴"(읽고 `done --result`). 일꾼을 띄운 적이 없으면 "일꾼 없이 결과 파일이 이미 있음" |
| 기한 전 | 아무것도 안 함 | 없음 |
| 기한 지남, 일꾼 없음 | 지시서를 표준 입력으로 넣어 `drive.worker.command`를 띄움 | "일꾼 띄움" |
| 지시서가 사라짐·빔 | 띄우지 않음 | "지시서 없음" |
| 디스크 여유가 `drive.disk.min_free_gb` 아래 | 띄우지 않음 | "디스크 부족으로 안 띄움" |
| 도는 일꾼이 `max_parallel`개 | 띄우지 않고 다음 순회로 | "동시 수 상한으로 대기" |
| `max_attempts`번 띄웠는데 결과 없음 | 더 띄우지 않음 | "시도 횟수 소진" |
| 일꾼 명령을 띄우지 못함 | 시도 횟수를 쓰지 않고 다음 순회에 다시 | "일꾼 띄우기 실패" |

일꾼이 결과 없이 끝나면 `retry_min` 뒤에 다시 띄웁니다. 디스크 여유(`drive.disk.min_free_gb`)는 `drive.disk.path`뿐 아니라 일꾼이 캐시·트랜스크립트·임시 파일을 쓰는 `/`, `~`, `~/.gemini`, `~/.claude`, `~/.cache`, `/tmp` 마운트까지 함께 재서 가장 좁은 곳을 기준으로 판단합니다. 띄운 일꾼은 `.agents/work/work-watch/registry.json`에도 자동 등록되어 `scripts/work-watch.mjs`가 결과 파일 생성·진도 멈춤·프로세스 종료를 함께 감시합니다. 일꾼은 프로세스 번호와 시작 시각으로 알아보므로 번호가 재사용돼도 다른 프로세스를 일꾼으로 착각하지 않습니다. 일꾼 환경에는 `LEDGER_ROLE`, `LEDGER_ITEM_ID`, `LEDGER_RESULT_FILE`을 넣고 메신저 토큰 변수는 뺍니다. 실행 기록은 `.agents/work/ledger/runs/<역할>/<항목id>/<회차>.log`에 남습니다. 순회는 항목을 닫지 않고, 지시서가 없는 항목과 `waiting_human` 항목을 건드리지 않습니다.

### 알림은 그 역할의 깨움함으로

굴리기 알림은 `roles[].wake_dir`에 적은 그 역할의 깨움함에 씁니다. 예약 일꾼의 성공 알림은 기동할 때 정한 깨움함으로 갑니다. 장부와 일꾼 감시가 같은 실행을 확인해도 읽을 알림은 한 건입니다. 깨움함의 `.work-watch-completions/`에 실행별 전달 기록이 남아, 역할이 알림을 읽은 뒤에도 중복을 막습니다. 프로파일로 기동한 일꾼의 종료 기록은 부모 카드의 `drive.run.ended_at`에도 같은 시각으로 남습니다. 기본값은 없습니다. `wake_dir`이 없는 역할에는 지시서를 붙일 수 없고, 순회는 그 역할 것을 띄우지 않고 오류로 보고합니다. 다른 역할의 깨움함으로 보내는 일은 없습니다. 위 "깨우는 까닭"의 감시 깨움은 지금까지처럼 평면 폴더에 쓰며 이 설정의 영향을 받지 않습니다.

`drive.notify.command`를 적으면 깨움 파일을 쓴 뒤 그 명령을 실행하고 알림 본문을 표준 입력으로 넘깁니다. 깨움 파일 쓰기나 이 명령이 실패하거나 `timeout_sec` 안에 끝나지 않으면 알림은 보내지 않은 것으로 남아 다음 순회에 다시 보냅니다. 예약 일꾼의 성공 알림에서 이 명령만 실패하면 다음 순회가 명령을 다시 시도합니다. 성공한 회차의 알림은 끝나며, 반복 알림의 간격(`repeat_min`)은 전달이 성공한 뒤부터 셉니다. 같은 본문의 알림이 깨움함에 아직 읽히지 않은 채 있으면 파일을 또 쓰지 않습니다.

### 감시·정시 타이머와 겹치지 않게

- 순회가 탈 없이 다룬 항목에는 감시가 "기한 넘음"을 따로 깨우지 않습니다. 그 역할은 굴리기 알림을 받습니다.
- 순회가 통째로 실패했거나, 그 역할 순회가 실패했거나, 그 항목의 알림 전달이 실패했으면 감시는 예전처럼 "기한 넘음"으로 깨우고 "감시 실패: 굴리기 실패" 깨움에 오류를 적습니다. 감시의 종료 코드도 1이 됩니다.
- 정시 타이머(`due_timer`)는 굴리기가 켜져 있으면 지시서가 붙은 항목에는 깨움을 쓰지 않습니다. 역할을 깨우면 일꾼과 역할이 같은 일을 두 번 하게 되기 때문입니다. 그 항목은 다음 감시 순회(최대 10분 뒤)가 띄웁니다.

### 켜기와 되돌리기

1. 설정의 역할마다 `wake_dir`을 적고 `drive` 절을 채웁니다(`config/work-ledger.example.json`). `drive.enabled`는 `false`로 둡니다. `drive.owner_ids`에는 닫기를 확인해 줄 사람의 메신저 사용자 ID(숫자)를 적습니다. 예시의 자리 표시 값을 그대로 두면 설정 오류로 거절합니다.
2. `drive --dry`로 무엇을 띄울지 확인합니다.
3. `drive.enabled`를 `true`로 바꿉니다. 다음 감시부터 순회가 돕니다.

되돌릴 때는 `drive.enabled`를 `false`로 바꿉니다. 띄우기와 굴리기 알림이 멈추고 감시·정시 타이머는 지시서가 붙은 항목도 예전처럼 깨웁니다. 이미 도는 일꾼은 그대로 두며 `drive` 칸도 장부에 남습니다. 닫기 관문(`drop`·`due` 거절, `done --result`)은 `drive` 칸이 있는 항목에 계속 적용됩니다.

주의할 점:

- 순회 하나는 한 ADK 뿌리의 장부를 그 감시를 돌리는 계정으로 다룹니다. 다른 계정이나 다른 뿌리에 있는 장부는 그쪽에서 같은 판의 대본과 설정으로 따로 켭니다.
- 감시를 사용자 systemd의 한 번 실행 서비스로 돌리면 서비스가 끝날 때 같은 제어 그룹의 프로세스가 함께 정리될 수 있습니다. 일꾼이 감시보다 오래 살아야 하므로, 켜기 전에 일꾼 명령을 별도 범위로 띄우게 하고(예: `drive.worker.command`를 `systemd-run --user --scope`로 감싸기) 일꾼이 감시가 끝난 뒤에도 살아 있는지 그 서버에서 직접 확인합니다.
- 일꾼 명령은 지시서를 표준 입력으로 받고 결과를 `LEDGER_RESULT_FILE`에 써야 합니다. 명령 인자의 `{model}`, `{id}`, `{role}`, `{prompt}`, `{result_file}`, `{title}`은 항목 값으로 바뀝니다.

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

## 일꾼 실행 등록 (`worker-run.mjs`)

역할이 `agy`, `codex`, `muse` 같은 일꾼을 `systemd-run --user`로 직접 띄울 때도 같은 역할 장부(`<ADK 뿌리>/.agents/work/ledger/<역할>.json`)에 `kind: "worker"` 줄(`status: "running" → "done" | "failed"`)로 남깁니다. `ledger-watch.mjs`와 `due-timer.mjs`는 유닛이 사라졌는데 `running`으로 남은 줄을 찾아 닫습니다. 자세한 줄 스키마·소비자 계약·CLI는 [일꾼 실행 업무 장부 계약](worker-run-ledger-contract.md)을 따릅니다.
