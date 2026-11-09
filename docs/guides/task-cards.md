# 업무 카드와 대기 규칙 (`task-cards.mjs`)

범위: 공통 틀 + 인스턴스 설정 (`config/task-cards.json`)

## 1. 왜 쓰나

한 가지 작업에 몰입하면 다른 지시나 대기 중인 업무를 놓치기 쉽습니다. 업무 카드 대본(`.agents/scripts/task-cards.mjs`)은 역할별 일을 카드 파일(`docs/common/team/cards/<역할>/<날짜>-<짧은이름>.md`)과 덧붙이기 전용 장부(`docs/common/team/cards/ledger.jsonl`)로 관리하고, 정기 점검과 깨움으로 멈춘 일을 다시 움직이게 합니다.

**원칙**: **이미 지시가 있고 되돌릴 수 있는 일은 대기에 넣지 않고 진행**합니다. 내부 시험, 초안 작성, 로컬 검증처럼 되돌릴 수 있는 작업은 "시작해도 될까요?"라고 다시 묻거나 카드를 대기로 바꾸지 말고 바로 진행(`doing`)으로 둡니다.

---

## 2. 카드 한 장이 품는 칸

`docs/common/team/cards/<역할>/<날짜>-<짧은이름>.md` 머리말(frontmatter) 칸:

- `id`, `title`, `owner`, `status` (`doing` 진행 / `waiting` 대기 / `deferred` 미룸 / `done` 끝)
- `source` (원문 주소·메시지 번호), `received` (받은 시각), `due` (예상 완료), `next` (다음 행동), `moved` (마지막 움직임), `calendar` (`yes`/`no`), `progress` (진행 문서 경로)
- 대기 전용 칸:
  - `wait_reason`: 정해진 네 가지 대기 까닭 중 하나
  - `recheck_at`: 다음 깨움 시각 (시간대가 있는 ISO-8601, 예: `2030-01-01T12:00:00Z` 또는 `2030-01-01T21:00:00+09:00`, 최대 지금+4시간). `due`는 작업 마감일이며 별도입니다. 장부로 옮길 때에는 사람 응답 감시와 같은 `due_at`으로 내보냅니다.
  - `request_ref`: 사람 승인 기다림일 때 요청 글 주소·번호 (예: `#업무-요청` 글 주소/번호)
- 미룸·완료 칸: `defer_reason`, `revisit`, `defer_count`, `result`

---

## 3. 카드를 "대기"로 바꿀 때의 네 가지 규칙

카드를 대기(또는 같은 뜻 상태: `waiting`, `blocked`, `대기`, `보류`)로 바꿀 때는 다음 네 가지를 반드시 지킵니다.

1. **정해진 네 가지 까닭(`waitReason`)만 허용**:
   - `바깥 송출·게시`
   - `운영 배포·운영 접속`
   - `돈 드는 것`
   - `다른 사람 결과물`
   - 위 넷 밖의 까닭이거나 까닭이 비어 있으면 대본이 거절하고 **"진행으로 두고 바로 하십시오"** 라고 안내합니다. **이미 지시가 있고 되돌릴 수 있는 일은 대기에 넣지 않고 진행**합니다.
2. **다음 깨움 시각(`recheck_at`)과 요청 글 주소(`request_ref`) 필수**:
   - `recheck_at`(`--recheck-at`)은 필수이며, 현재 시각 이후부터 **최대 지금+4시간**(`config/task-cards.json`의 `maxRecheckHours`로 설정 가능, 기본 4시간) 이내여야 합니다.
   - 사람 승인을 기다리는 앞의 세 까닭(`바깥 송출·게시`, `운영 배포·운영 접속`, `돈 드는 것`)은 반드시 `requestRef`(`--request-ref`, 예: `#업무-요청` 등 요청 글 주소/번호)를 함께 적어야 합니다.
3. **`recheck_at` 경과 시 담당 역할 깨움(한 카드·한 시각당 한 번)**:
   - `recheck_at`이 지나면 정기 점검(`check`, `board`, `tick`, `to-ledger`, `session-health`)이 소비자 wake-pump가 읽는 `wakeRoot` 바로 아래(기본 `.agents/work/l4/wake/<파일>`)에 담당 역할을 담은 깨움 파일을 만듭니다. 역할별 하위 폴더를 만들지 않으며 설정 `roles`에 없는 카드 역할도 점검합니다.
   - 깨움 기록은 `.agents/work/task-cards/wait-wake-state.json`에 남겨 **한 카드·한 시각당 한 번**만 깨우며, 새 상주 서비스를 만들지 않고 기존 정기 타이머·장부 점검에 붙여서 동작합니다.
4. **옛 카드(필드 없는 대기) 호환 및 1회 깨움**:
   - 필수 필드가 생기기 전에 만들어진 옛 대기 카드(`wait_reason`·`recheck_at` 등이 없는 `waiting` 카드)는 읽기(`list`, `board`, `check`)는 그대로 되며, 감시가 **"까닭·시각 없는 대기"** 로 역할마다 한 건으로 묶어 한 번 깨웁니다. 담당자는 까닭·시각을 채우거나 진행(`doing`), 결과를 적은 완료(`done`), 사유와 날짜를 적은 미룸(`defer --reason ... --revisit YYYY-MM-DD`)으로 옮깁니다. 옛 카드 표시와 관계없이 기한 초과·진행 정체 경고도 함께 표시합니다.

---

## 4. 인스턴스 설정 (`config/task-cards.json`)

회사 실값(채널 번호, 사람 이름, 사용자 ID, IP)은 업스트림 공통 파일에 두지 않고 각 인스턴스의 `config/task-cards.json`(예시: `config/task-cards.example.json`)에 둡니다.

```json
{
  "maxRecheckHours": 4,
  "timeZone": "UTC",
  "ownerSenderIds": [
    "<owner-user-id>"
  ],
  "wakeRoot": ".agents/work/l4/wake",
  "stateFile": ".agents/work/task-cards/wait-wake-state.json"
}
```

같은 운영 카드 폴더를 보는 모든 호출은 같은 `wakeRoot`와 `stateFile`을 사용해야 합니다. 인스턴스 설정의 `wakeRoot`·`stateFile`에 중앙 경로를 지정하고, session-health 설정의 `taskCardsRoot`는 `docs/common/team/cards`를 포함한 카드 정본 저장소 뿌리로 맞춥니다. 별도 체크아웃에서 실행한다면 상대 경로 대신 같은 절대 경로를 지정하여 깨움 중복과 상태 분리를 막습니다. `to-ledger <카드 폴더> <출력>`의 첫 인자는 역할 폴더들을 직접 포함한 `docs/common/team/cards` 경로이며, 전달받은 그 폴더를 점검합니다. 실제 인스턴스 변경은 운영 담당자가 수행합니다.

대기 깨움 시각은 시간대 없는 값을 거부합니다. 설정 `timeZone`은 `UTC`만 지원합니다(기본값 UTC). 기존 작업 마감일의 시간대 없는 `YYYY-MM-DDTHH:MM`은 UTC로 해석하며, 날짜만 있는 마감일·미룸 날짜는 그날 UTC 끝으로 해석·표시합니다. 입력한 시각의 시간대 표시와 같은 순간을 기준으로 비교·표시합니다. `--request-ref`는 비어 있지 않은 문자열 값이 있어야 합니다. `defer`는 필수 사유와 날짜를 검증하며 대기 상태를 그대로 남기는 우회로가 아닙니다. 카드 직접 수정으로 진행·미룸·완료가 된 경우도 다음 점검에서 깨움 상태를 정리합니다.

---

## 5. 명령 예시

```bash
# 새 카드 만들기
node .agents/scripts/task-cards.mjs new --role <role> --title "기능 검증" --source <원문-주소> --due 2030-01-02 --next "단위 시험 실행"

# 진행 중 다음 행동 갱신
node .agents/scripts/task-cards.mjs move <id> --status doing --next "검증 결과 정리"

# 대기로 바꾸기 (사람 승인 기다림: 앞의 셋은 --request-ref 필수)
node .agents/scripts/task-cards.mjs move <id> --status waiting \
  --wait-reason "운영 배포·운영 접속" \
  --recheck-at 2030-01-01T12:00:00Z \
  --request-ref "#업무-요청/<message-id>" \
  --next "승인 후 배포 실행"

# 대기로 바꾸기 (다른 사람 결과물 기다림)
node .agents/scripts/task-cards.mjs wait <id> \
  --wait-reason "다른 사람 결과물" \
  --recheck-at 2030-01-01T11:00:00Z \
  --next "전달받은 산출물 반영"

# 미루기 (사유·다시 볼 날 둘 다 필수)
node .agents/scripts/task-cards.mjs defer <id> --reason "선행 작업 우선 처리" --revisit 2030-01-03

# 끝내기 (결과 주소 필수)
node .agents/scripts/task-cards.mjs done <id> --result <결과-주소>

# 점검 및 깨움 생성 (기존 정기 타이머에서 호출)
node .agents/scripts/task-cards.mjs check
node .agents/scripts/task-cards.mjs board
node .agents/scripts/task-cards.mjs to-ledger docs/common/team/cards /<private>/work-ledger.json
```
