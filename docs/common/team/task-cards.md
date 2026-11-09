# 업무 카드로 일 놓치지 않기

범위: 공통 틀 + 인스턴스 값 (`docs/guides/task-cards.md` 와 짝)

## 왜 하나

- 각자 업무를 받으면 업무 카드를 만들고 해당 업무들의 상황을 정기 조사한다.
- 급한 일이나 크레딧 때문에 미룰 수는 있어도 조용히 없어지거나 잊히지 않게 한다.
- 업무 끝과 업무 중에 1시간마다 목록을 다시 보게 한다.
- **이미 지시가 있고 되돌릴 수 있는 일은 대기에 넣지 않고 진행**한다.

## 카드 한 장이 품는 칸

`docs/common/team/cards/<역할>/<날짜>-<짧은이름>.md` 한 파일이 일 하나다.
머리 칸 이름: `id`, `title`, `owner`, `status`(`doing` 진행 / `waiting` 대기 / `deferred` 미룸 / `done` 끝), `source`(받은 원문), `received`(받은 때), `due`(예상 완료), `next`(다음 행동), `moved`(마지막 움직임), `calendar`(`yes`/`no`), `progress`(진행 문서), `wait_reason`(대기 까닭), `recheck_at`(다시 볼 시각), `request_ref`(요청 글 주소·번호), `defer_reason`(미룬 까닭), `revisit`(다시 볼 날), `defer_count`(미룬 횟수), `result`(끝 주소).

## 카드를 대기(`waiting`/`blocked`/`대기`/`보류`)로 바꿀 때 지킬 것

1. **`waitReason`은 넷 중 하나만**: `바깥 송출·게시` / `운영 배포·운영 접속` / `돈 드는 것` / `다른 사람 결과물`. 그 밖이면 거절하고 `"진행으로 두고 바로 하십시오"`를 안내한다. **이미 지시가 있고 되돌릴 수 있는 일은 대기에 넣지 않고 진행**한다.
2. **`recheckAt`(다시 볼 시각) 필수**: 최대 지금+4시간(설정 `maxRecheckHours`). 사람 승인 기다림(앞 셋: `바깥 송출·게시`, `운영 배포·운영 접속`, `돈 드는 것`)이면 `requestRef`(`#업무-요청` 등 요청 글 주소/번호)도 필수다.
3. **`recheckAt` 경과 시 담당 역할 깨움**: `recheckAt`이 지나면 그 인스턴스의 역할 깨움 경로 규칙대로 담당 역할 깨움 파일을 한 카드·한 시각당 한 번 만든다. 새 상주 서비스는 만들지 않고 이미 있는 정기 타이머·장부 점검에 붙인다.
4. **옛 카드(필드 없는 대기)**: 읽기는 그대로 되고, 감시가 `"까닭·시각 없는 대기"`로 담당을 한 번 깨워 채우거나 진행으로 바꾸게 한다.

## 언제 무엇을 하나

- 일을 받으면: `new` 로 카드를 만든다. 원문 주소와 다음 행동을 함께 적는다.
- 일에 손대면: `move` 로 다음 행동을 고치고, 움직임 시각이 따라간다.
- 정해진 네 까닭으로 꼭 기다려야 하면: `move <id> --status waiting --wait-reason <까닭> --recheck-at <시각> [--request-ref <요청주소>]` 로 다시 볼 시각을 못박는다.
- 못 하면: `defer` 로 미룬다. 까닭과 다시 볼 날을 남긴다. 카드는 지우지 않는다.
- 끝내면: `done` 으로 끝내고 결과 주소를 남긴다. 남은 카드가 기한 순으로 바로 나와 다음 일을 고르게 된다.

## 명령 예시

- `node .agents/scripts/task-cards.mjs new --role <역할> --title "판올림" --source <원문> --due 2030-01-02 --next "막힌 시험 고치기"`
- `node .agents/scripts/task-cards.mjs move <id> --next "다음 행동"`
- `node .agents/scripts/task-cards.mjs move <id> --status waiting --wait-reason "운영 배포·운영 접속" --recheck-at 2030-01-01T12:00:00Z --request-ref "#업무-요청/<글번호>"`
- `node .agents/scripts/task-cards.mjs defer <id> --reason "급한 일 먼저" --revisit 2030-01-03`
- `node .agents/scripts/task-cards.mjs done <id> --result <결과 주소>`
- `node .agents/scripts/task-cards.mjs check --no-wake --role <역할>`
- `node .agents/scripts/task-cards.mjs board --no-wake`
