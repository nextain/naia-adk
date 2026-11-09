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
  - `recheck_at`: 다시 볼 시각 (ISO-8601 또는 `YYYY-MM-DDTHH:MM`, 최대 지금+4시간)
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
2. **다시 볼 시각(`recheckAt`)과 요청 글 주소(`requestRef`) 필수**:
   - `recheckAt`(`--recheck-at`)은 필수이며, 현재 시각 이후부터 **최대 지금+4시간**(`config/task-cards.json`의 `maxRecheckHours`로 설정 가능, 기본 4시간) 이내여야 합니다.
   - 사람 승인을 기다리는 앞의 세 까닭(`바깥 송출·게시`, `운영 배포·운영 접속`, `돈 드는 것`)은 반드시 `requestRef`(`--request-ref`, 예: `#업무-요청` 등 요청 글 주소/번호)를 함께 적어야 합니다.
3. **`recheckAt` 경과 시 담당 역할 깨움(한 카드·한 시각당 한 번)**:
   - `recheckAt`이 지나면 정기 점검(`check`, `board`, `tick`, `to-ledger`, `session-health`)이 그 인스턴스의 역할 깨움 경로 규칙(`config/task-cards.json`의 `roleWakeDirs` 또는 `.agents/context/work-watch.json`의 `roles[].wakeDir`, 기본 `.agents/work/l4/wake/<역할>`)에 따라 담당 역할 깨움 파일을 만듭니다.
   - 깨움 기록은 `.agents/work/task-cards/wait-wake-state.json`에 남겨 **한 카드·한 시각당 한 번**만 깨우며, 새 상주 서비스를 만들지 않고 기존 정기 타이머·장부 점검에 붙여서 동작합니다.
4. **옛 카드(필드 없는 대기) 호환 및 1회 깨움**:
   - 필수 필드가 생기기 전에 만들어진 옛 대기 카드(`wait_reason`·`recheck_at` 등이 없는 `waiting` 카드)는 읽기(`list`, `board`, `check`)는 그대로 되며, 감시가 **"까닭·시각 없는 대기"** 로 담당 역할을 한 번 깨워 까닭·시각을 채우거나 진행(`doing`)으로 바꾸게 합니다.

---

## 4. 인스턴스 설정 (`config/task-cards.json`)

회사 실값(채널 번호, 사람 이름, 사용자 ID, IP)은 업스트림 공통 파일에 두지 않고 각 인스턴스의 `config/task-cards.json`(예시: `config/task-cards.example.json`)에 둡니다.

```json
{
  "maxRecheckHours": 4,
  "leadRole": "<lead-role-id>",
  "ownerSenderIds": [
    "<owner-user-id>"
  ],
  "roleWakeDirs": {
    "<lead-role-id>": ".agents/work/l4/wake",
    "<role-id>": ".agents/work/l4/wake/<role-id>"
  }
}
```

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
