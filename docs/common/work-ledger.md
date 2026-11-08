# 업무 장부와 10분 감시

## 왜 필요한가

부탁받은 일과 기한을 대화 안에만 두면 세션이 다시 시작되거나 대화가 줄어들 때 놓칠 수 있습니다. 일꾼이 결과 파일을 써도 담당자가 읽지 않으면 일이 멈춥니다. 업무 장부는 할 일을 파일로 남기고, 감시 대본은 세션 밖에서 10분마다 장부를 확인해 담당 역할을 깨웁니다.

부탁·지시를 받으면 답하기 전에 `add`로 기록합니다. 끝난 일은 `done`, 중단한 일은 까닭과 함께 `drop`으로 남깁니다. 일꾼에게 맡겼다면 결과 경로와 끝 파일을 함께 기록합니다. 결과를 실제로 읽은 다음 `touch`로 확인 시각을 남깁니다.

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

## 깨우는 까닭 넷

| 까닭 | 언제 깨우나 |
| --- | --- |
| 기한 넘음 | `open` 항목의 기한이 지났을 때 |
| 일꾼 끝, 결과 안 읽음 | 끝 파일이 있고, 결과 확인 시각이 끝 파일 수정 시각보다 앞일 때 |
| 장부에 없는 사람 글 | 감시 채널의 최근 24시간 사람 글이 장부 출처에 없고, 담당 역할이 그 글에 답글도 달지 않았을 때 |
| 정기 보고 시각 | 마지막 보고 이후 설정한 분 수가 지났을 때 |

같은 항목의 같은 까닭은 30분 안에 다시 깨우지 않습니다. 다른 까닭은 따로 확인합니다. 장부를 읽을 수 없거나 깨졌으면 실패를 깨움으로 알립니다. 실패를 정상 검사처럼 넘기지 않습니다.

깨움은 `.agents/work/l4/wake/<YYYYMMDDHHMMSSmmm>-ledger-<항목id>-route-<역할>.md` 파일로 남깁니다. 첫 줄은 `[장부] <까닭>: <제목>`이며 이어서 출처, 기한, 결과 경로를 적습니다. 기존 깨움 처리기가 이 파일을 읽습니다. 감시 자체는 업무를 완료하거나 메신저 답글을 보내지 않습니다.

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
