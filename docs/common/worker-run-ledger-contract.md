이 문서가 답하는 질문: 일꾼 실행을 업무 장부에 어떤 모양으로 기록하고, 실행기·감시기·대시보드·다른 서버가 어떤 계약으로 읽고 닫는가?
상태: 현행 기준
기준판: 공개 저장소 `ed104d328ff7870908d326df840e4b98a1718a03`

# 일꾼 실행 업무 장부 계약

역할이 `agy`, `codex`, `muse` 같은 일꾼을 `systemd-run --user`로 띄울 때 기존 역할별 업무 장부(`<ADK 뿌리>/.agents/work/ledger/<역할>.json`)에 실행 줄(`kind: "worker"`)을 함께 남깁니다. 대시보드, 작업 보드, 다른 서버는 옛 `naia-comm` 대기열이 아니라 이 장부 줄을 읽어 현재 실행 중인 일꾼 수와 상태를 셉니다.

이 문서는 생산자·정리기·소비자 사이의 데이터 형식, 상태 전이, 파일 경로와 설정 해석 규칙을 정합니다.

## 목적과 참여자

| 구분 | 구성 요소 | 책임 |
| --- | --- | --- |
| 생산자·실행기 | `scripts/work-ledger/worker-run.mjs` | 실행 전 `running` 줄을 열고 `systemd-run --user`로 일꾼을 띄우며, 종료 뒤 종료 코드와 결과 파일 유무로 `done`/`failed`를 닫습니다. |
| 정본 스키마·설정 | `scripts/work-ledger/ledger.mjs` | 설정 읽기(`loadLedgerConfig`), 장부 경로(`ledgerPath`), 잠금(`withLock`), 스키마 검증(`validateLedger`)을 제공합니다. |
| 감시·사라짐 정리기 | `scripts/work-ledger/ledger-watch.mjs`, `scripts/work-ledger/due-timer.mjs`, `scripts/lib/stalled-cards-ledger.mjs` | `kind: "worker"` 줄을 일반 기한·사람 대기·카드 정체 감시에서 건너뛰고, 일꾼 줄은 `worker-run.mjs`의 유닛 대조(`reconcileWorkerRuns`)가 맡아 사라진 `running` 줄을 `failed`로 닫습니다. |
| 소비자 | 대시보드, 작업 보드, 외부 상태 서버 | 읽기 전용으로 설정과 역할별 장부를 읽어 `running` 일꾼 목록, 부모 일감 연결, 최근 완료·실패 이력을 보여 줍니다. |

## 설정과 장부 경로 해석

모든 실행기와 소비자는 경로와 역할 목록을 하드코딩하지 않고 `scripts/work-ledger/ledger.mjs`의 규칙을 그대로 따릅니다.

1. **작업 공간 뿌리(`root`)**: `--root <경로>`를 `path.resolve`로 해석하며, 생략하면 현재 작업 디렉터리(`process.cwd()`)를 씁니다.
2. **설정 파일(`configFile`)**: `resolveConfigPath(root, configPath)`가 `--config <경로>`를 `root` 기준으로 풀고, 생략하면 `<root>/config/work-ledger.json`을 읽습니다.
3. **역할 확인(`loadLedgerConfig`)**: 설정 파일이 있으면 `roles[].role` 목록에서 대상 역할을 찾고, 없는 역할이면 거부합니다. `--config` 없이 기본 설정 파일이 없는(`ENOENT`) 경우에만 `ledger.mjs`와 동일하게 빈 설정으로 동작하며, `--config`를 명시했는데 파일이 없으면 실패합니다.
4. **장부 파일 경로(`ledgerPath`)**: `<root>/.agents/work/ledger/<role>.json` (`safeName(role)` 검증).
5. **실행 로그 기본 경로**: `<root>/.agents/work/ledger/worker-runs/<role>/<id>.log` (`--log`로 덮어쓸 수 있음).

## 장부 줄 스키마 (`kind: "worker"`)

기존 `ledger.mjs` 줄(`items[]`) 모양을 그대로 유지하고 일꾼 실행용 칸만 더합니다. 일반 작업 줄은 `kind`를 비워 두거나 `"worker"`가 아닌 값을 쓰며, 기존 칸의 의미와 상태(`open`, `waiting_human`, `escalated_human`, `done`, `dropped`)는 바뀌지 않습니다.

### 추가 및 핵심 필드

| 필드 | 형식 | 필수 | 상태별 제약 및 의미 |
| --- | --- | --- | --- |
| `id` | 문자열(`safeName`) | 필수 | 역할 장부 안에서 유일한 실행 줄 ID (`^[a-zA-Z0-9][a-zA-Z0-9_-]*$`). |
| `kind` | `"worker"` | 필수 | 일꾼 실행 줄 식별자. 일반 업무 줄과 구분할 때 사용합니다. |
| `status` | `"running" \| "done" \| "failed"` | 필수 | 실행 중(`running`) → 정상 완료(`done`) 또는 실패·비정상 종료(`failed`). |
| `role` | 문자열(`safeName`) | 필수 | 일꾼을 띄운 역할 ID (`ledger.role`과 일치해야 함). |
| `parent` | 문자열(`safeName`) \| `null` | 필수 | 어느 장부 줄(부모 일감 `id`)에서 파생된 실행인지. 연결된 부모 줄이 없으면 `null`. 자기 자신과 같을 수 없습니다. |
| `name` | 한 줄 문자열 | 권장 | 사람이 알아보는 실행 이름(`worker-run.mjs`는 항상 `name`과 `title`에 기록). |
| `unit` | 문자열 \| `null` | 필수 | `systemd --user` 유닛 이름(예: `adk-worker-<rootHash8>-<role>-<id>.service`). `--foreground` 실행 등 유닛이 없을 때만 `null`. |
| `tool` | 문자열 | 필수 | 실행한 일꾼 도구 이름(표준: `agy`, `codex`, `muse`, `claude`, `opencode`, `gemini`; 생략 시 명령 앞부분에서 자동 판별). |
| `started` | UTC ISO-8601 `Z` 문자열 | 필수 | 실행 줄을 연 시각(`validDate`). |
| `ended` | UTC ISO-8601 `Z` 문자열 \| `null` | 필수 | `running` 동안 `null`, `done`/`failed`로 닫힐 때 종료 시각(`validDate`). |
| `result` | 한 줄 문자열 \| `null` | 필수 | 결과 파일 경로(`worker-run.mjs start`는 `--result` 필수, 절대 경로로 정규화해 저장). |
| `exit` | 정수 \| `null` | 필수 | `running` 동안 `null`. 정상 종료 수거 시 프로세스 종료 코드(정수), 유닛 증발·실행 실패 등 종료 코드를 알 수 없으면 `null`. |

### 보조 진단 필드 (선택)

| 필드 | 형식 | 의미 |
| --- | --- | --- |
| `pid` | 양의 정수 \| `null` | 일꾼 자식 프로세스 PID. |
| `start_token` | 한 줄 문자열 \| `null` | `/proc/<pid>/stat` 시작 시각 토큰(`processStart`). PID 재사용 오인을 막습니다. |
| `log` | 한 줄 문자열 \| `null` | 유닛 표준 출력·오류를 모으는 로그 파일 경로. |
| `cwd` | 한 줄 문자열 \| `null` | 일꾼 명령의 작업 디렉터리. |
| `reason` | 한 줄 문자열 \| `null` | 실패·비정상 닫기 사유 코드(`exit-nonzero`, `result-missing`, `result-empty`, `result-unchanged`, `launch-failed`, `unit-missing`, `unit-failed`, `process-missing`, `no-unit-or-pid`). |
| `launch_pending` | 불리언 | `systemd-run --user` 호출 직전부터 시작 완료 직후까지 짧은 시작 과도기 표시. |
| `initial_result` | `{ size, mtime_ns } \| null` | 실행 전에 이미 있던 결과 파일의 크기·나노초 수정 시각 스냅샷. |

### 기존 호환 필드 (의미 변경 없음)

| 필드 | `kind: "worker"` 줄에서의 값 | 보존 이유 |
| --- | --- | --- |
| `title` | 실행 이름(`name`)과 같은 한 줄 문자열 | `ledger.mjs list` 및 기존 제목 검사 호환. |
| `from` | `{ "channel": "<부모 채널 또는 빈 문자열>", "msg_id": "-", "quote": "" }` | `msg_id: "-"`로 두어 사람 지시 미등록·중단·연기 상한 계산에 섞이지 않게 합니다. |
| `due` | `started`와 같은 UTC ISO `Z` 시각(또는 `--due`) | 기존 필수 날짜 검증 호환. `kind: "worker"`는 기한 깨움·타이머 대상에서 제외합니다. |
| `created_at` | `started`와 같은 UTC ISO `Z` 시각 | 생성 시각 호환. |
| `worker` | `null` | 기존 `worker.done_file` 감시(`ledger-watch.mjs`)와 분리. |
| `checked_at` | `null` 또는 `ledger.mjs touch` 시각 | 담당자가 결과를 읽고 확인한 시각. |
| `note` | `""` 또는 실패·종료 설명 문자열 | 사람·운영자 메모. |

### 예시 JSON

```json
{
  "version": 1,
  "role": "minho",
  "report": { "every_min": 60, "channel": "1436661964886315030", "last_msg_id": null, "last_at": null },
  "items": [
    {
      "id": "task-001",
      "title": "대시보드 실행 중 표시 수정",
      "from": { "channel": "1436661964886315030", "msg_id": "1570000000000000000", "quote": "잘 좀 고쳐줘라" },
      "due": "2026-11-18T12:00:00.000Z",
      "created_at": "2026-11-18T05:35:00.000Z",
      "status": "open",
      "worker": null,
      "checked_at": null,
      "note": ""
    },
    {
      "id": "w-dashboard-fix-20261118T055000Z-a1b2c3",
      "kind": "worker",
      "title": "dashboard-fix",
      "name": "dashboard-fix",
      "role": "minho",
      "parent": "task-001",
      "unit": "adk-worker-1a2b3c4d-minho-w-dashboard-fix-20261118T055000Z-a1b2c3.service",
      "tool": "codex",
      "status": "running",
      "started": "2026-11-18T05:50:00.000Z",
      "ended": null,
      "result": "/path/to/adk/results/dashboard-fix.md",
      "exit": null,
      "pid": 41230,
      "start_token": "991234",
      "log": "/path/to/adk/.agents/work/ledger/worker-runs/minho/w-dashboard-fix-20261118T055000Z-a1b2c3.log",
      "cwd": "/path/to/adk",
      "reason": null,
      "from": { "channel": "1436661964886315030", "msg_id": "-", "quote": "" },
      "due": "2026-11-18T05:50:00.000Z",
      "created_at": "2026-11-18T05:50:00.000Z",
      "worker": null,
      "checked_at": null,
      "note": ""
    }
  ]
}
```

## 상태 전이와 닫기 규칙

```
[start] ──▶ running ──(exit === 0 && 결과 파일 존재·비어있지 않음·신규/갱신)──▶ done
               │
               ├──(exit !== 0 || 결과 파일 없음·빔·미갱신)───────────────────▶ failed
               ├──(systemd-run 띄우기 실패)─────────────────────────────────▶ failed (reason=launch-failed)
               └──(유닛/PID 사라짐 · reconcile)─────────────────────────────▶ failed (reason=unit-missing|unit-failed|process-missing)
```

1. **선등록 후 실행**: `worker-run.mjs`는 `systemd-run --user`를 부르기 전에 먼저 `withLock` 안에서 `status: "running"` 줄을 기록합니다. 짧은 명령이 즉시 끝나더라도 기록 경쟁이 나지 않습니다.
2. **내부 실행 래퍼(`_exec`)**: `systemd-run --user --unit=<unit> --collect` 안에서는 `worker-run.mjs _exec`가 실제 일꾼 명령을 실행하며, 메신저 봇 토큰(`config.provider.token_env` / `DISCORD_BOT_TOKEN`)을 환경에서 제거합니다. 자식 프로세스가 끝나면 종료 코드와 `result` 파일 존재·크기(> 0)·변경 여부를 확인해 `done` 또는 `failed`로 닫습니다.
3. **종료 판정 상세**:
   - `done`: `exit === 0`이고, `result`가 일반 파일이며 `size > 0`이고, 실행 전 기존 파일이 있었다면 `mtime_ns` 또는 `size`가 달라졌을 때만 허용합니다.
   - `failed`: `exit !== 0`이면 결과 파일이 있어도 `failed`입니다. `exit === 0`이어도 결과 파일이 없거나 비어 있거나 이전 파일 그대로면 `failed`(`reason: "result-missing" | "result-empty" | "result-unchanged"`)로 닫습니다.
   - 닫힌 줄(`done`, `failed`)에는 `finish`를 다시 적용해도 상태를 되돌리지 않습니다(이미 닫힌 줄은 거부).
4. **유닛 사라짐·죽음 복구(`reconcileWorkerRuns`)**:
   - `ledger-watch.mjs`는 매 감시 주기마다, `due-timer.mjs`는 `reconcileCurrent`에서 `running` 일꾼 줄이 하나라도 있으면 `systemctl --user show <unit>`으로 유닛 상태를 확인합니다.
   - `ActiveState`가 `active`, `activating`, `reloading`이면 `running`을 유지합니다.
   - `LoadState=not-found`이면(단, `launch_pending === true`이고 시작 후 5초 미만인 과도기와 살아 있는 `pid`/`start_token` 예외 제외) `exit: null`, `status: "failed"`, `reason: "unit-missing"`으로 닫고 `ledger-watch.mjs`가 해당 역할에 `[장부] 일꾼 유닛 사라짐` 깨움을 남깁니다. (`systemd --user show`는 `not-found` 유닛에도 `ExecMainStatus=0`, `Result=success`를 출력하므로 반드시 `LoadState=not-found`를 먼저 판정합니다.)
   - `ActiveState=failed` 또는 `Result=failed`이면 `failed`(`reason: "unit-failed"`)로 닫습니다.
   - `LoadState=loaded`, `ActiveState=inactive`, `SubState=dead`, `Result=success`, `ExecMainStatus=0`인 채 남아 있으면 결과 파일 검사를 거쳐 `done` 또는 `failed`(`result-missing`)로 닫습니다.
   - `systemctl` 호출 자체가 실패(예: D-Bus 연결 실패)하면 억측으로 닫지 않고 `running`을 유지하며 오류를 보고합니다.
5. **기존 `ledger.mjs` 명령과의 관계**:
   - `ledger.mjs touch --id <worker-id> --role <role>`은 허용되어 `checked_at`을 갱신합니다.
   - `ledger.mjs done|drop|due|adopt|start|attach|confirm`은 `kind: "worker"` 줄을 거부하고 `worker-run.mjs`를 안내합니다.

## 공통 실행기 CLI (`scripts/work-ledger/worker-run.mjs`)

```sh
# 1. 일꾼 실행 (장부에 running 등록 후 systemd-run --user 유닛으로 띄움)
node scripts/work-ledger/worker-run.mjs \
  --root . \
  --role minho \
  --parent task-001 \
  --name "dashboard-fix" \
  --result results/dashboard-fix.md \
  -- codex exec "..."

# 2. 수동/외부 종료 닫기
node scripts/work-ledger/worker-run.mjs finish \
  --root . --role minho --id <worker-id> --exit 0

# 3. 사라진 유닛·프로세스 정리
node scripts/work-ledger/worker-run.mjs reconcile --root .

# 4. 목록 조회
node scripts/work-ledger/worker-run.mjs list --root . --status running --json
```

주요 선택 옵션: `--config <경로>`, `--tool <이름>`, `--id <ID>`, `--unit <유닛명>`, `--cwd <작업폴더>`, `--log <로그경로>`, `--wait`, `--foreground`, `--dry`, `--strict-parent`.

## 소비자(대시보드·작업 보드·다른 서버) 읽기 계약

대시보드·작업 보드·외부 관측기는 다음 순서로 읽습니다.

1. `<root>/config/work-ledger.json`에서 `roles[].role` 목록을 읽습니다. (단일 역할만 볼 때는 해당 `<role>`만 읽습니다.)
2. 각 역할의 `<root>/.agents/work/ledger/<role>.json`을 읽어 JSON 파싱과 `version === 1`, `Array.isArray(items)`를 확인합니다. 파일이 없으면(`ENOENT`) 0건으로 봅니다. 파일이 있는데 JSON이 깨졌으면 정상 0건으로 숨기지 말고 읽기 오류 상태를 드러냅니다.
3. `items`에서 `item.kind === "worker"`인 줄만 고릅니다.
   - **실행 중(`running`)**: `item.kind === "worker" && item.status === "running"`. 대시보드의 `실행 중` 카운트와 활성 일꾼 목록은 이 줄을 셉니다.
   - **최근 이력**: `item.kind === "worker" && (item.status === "done" || item.status === "failed")`를 `ended` 내림차순으로 정렬해 표시합니다.
   - **부모 일감 연결**: `item.parent`가 `null`이 아니면 같은 역할 장부(또는 상위 작업 보드)의 `item.kind !== "worker" && item.id === item.parent` 줄과 연결해 제목·출처를 함께 보여 줍니다.
4. 일반 업무 카드 목록은 `item.kind !== "worker"`인 줄만 읽습니다.

## 병렬 개발·통합 시 맞출 하위 소비자 참고

이 계약은 `scripts/work-ledger/`와 `docs/` 범위에서 먼저 확정되었습니다. 병렬 개발 이후 통합 단계에서 아래 인접 모듈을 함께 맞춥니다.

1. **`scripts/lib/stalled-cards-ledger.mjs` (`session-health.mjs`)**: `kind: "worker"` 줄은 사람·카드 기한·정체 감시에서 건너뛰며, 대신 일꾼 줄 감시는 `worker-run.mjs`의 유닛 대조(`reconcileWorkerRuns`)가 맡습니다(일반 카드의 `escalated_human` 상태 확장만 작업 보드 통합 시 별도 반영).
2. **`.claude/hooks/lib/effective-argv.js`**: 역할이 배경/래퍼 명령 안에서 `scripts/work-ledger/worker-run.mjs`를 호출하도록 표준 진입점 허용 목록(`isAllowedStandardEntrypoint`)에 추가하거나 `scripts/worker-runner/spawn-worker.mjs`와 연결할 수 있습니다.

## 시험 및 근거

- 계약 및 실행기 단위·통합 시험: `scripts/work-ledger/worker-run.test.mjs`
  - `startWorkerRun`, `finishWorkerRun`, `execWorkerRun`, `reconcileWorkerRuns`, `ledger.mjs` 공존, `ledger-watch.mjs` 및 `due-timer.mjs` 유닛 사라짐 감지 검증.
- 전체 `scripts/work-ledger/` 회귀 확인:
  ```sh
  node --test scripts/work-ledger/*.test.mjs
  ```
