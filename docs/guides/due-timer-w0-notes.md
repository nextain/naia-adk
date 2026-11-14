# 정시 타이머 W0 사전 확인

확인일: 2026-11-12. 이 서버에서 읽기만 했다. `systemctl`과 `systemd-run`은 실행하지 않았다. PC 미확인.

## ① 바탕 가지

- `git branch --show-current` → `feat/due-timer-20261112`.
- `git rev-parse HEAD` → `8b78d4135d90be997532725a9f0b2033df229fa2`.
- `git log -1 --format='%h %s'` → `8b78d413 fix(work-ledger): keep parent-author thread starter, drop internal repo name`.
- `git branch -a --contains 8b78d413`에는 현재 가지와 장부 작업 가지들이 나온다. 사용자가 지정한 이 커밋과 가지를 바탕으로 삼는다.

## ② PC

PC 미확인. systemd 버전, Linger, 절전 복귀 후 달력 타이머와 Node 경로는 확인하지 않았다.

## ③ 작업 감시

- 서버 체크아웃의 `.agents/scripts/work-watch.mjs`는 `TriggeredBy` 속성이나 기존 기록이 있으면 타이머 서비스로 분류해 제외한다(1606행). 하지만 같은 파일에는 수거된 서비스의 타이머 역방향 관계를 확인하는 `timerForService`가 없다.
- 별도 작업 체크아웃(`alpha-wwtimer`)의 `git rev-parse HEAD` → `2c3b31fcb152ecfb55da3cafd627998351cc66f1`; 그 파일 1590~1601행은 `TriggeredBy`가 사라진 서비스에 대해 타이머의 `Triggers`가 해당 서비스와 정확히 일치하는지 확인한다.
- 서버 체크아웃에서 `git merge-base --is-ancestor 2c3b31fcb HEAD`의 종료 값은 1이다. 위 비교는 현재 파일에 해당 보완이 없음을 보여 주지만 실행 중인 프로세스의 코드나 실제 깨움 발생은 확인하지 않았다. 따라서 수거된 `adk-due-*` 서비스가 작업 완료 깨움을 낼 위험이 남으며 W4 전에 운영 측에서 확인하고 해결해야 한다.

## ④ 대시보드

이 작업 트리의 `packages/dashboard/app` 및 `packages/server/src`에서 일정 장치 목록이나 `adk-due-` 분기와 `list-timers`를 찾지 못했다. 서버의 alpha-adk 대시보드·서버 소스와 관련 스크립트에서도 해당 문구나 `adk-due-` 예외를 찾지 못했다. 별도 포털의 일정 화면과 운영 배포판은 확인하지 못했으므로 이 타이머가 실제로 '문서에 없는 장치'로 표시되는지는 **미확인**이다. 실제 장치를 만들거나 대시보드를 변경하지 않았다.

## 구현 전 시험 기준

- 요청된 `node --test scripts/work-ledger/`: Node v22.23.4에서 디렉터리를 모듈로 찾지 못해 `MODULE_NOT_FOUND`, 1개 중 실패 1개.
- 보충 확인 `node --test scripts/work-ledger/*.test.mjs`: 88개 통과, 실패 0개. 종료 때 요청된 명령과 보충 명령을 각각 같은 방식으로 대조한다.

## W4 켜기 전 필수 조건

이 저장소에는 work-watch 구현이 없다. **work-watch에 `adk-due-*`와 `adk-sched-*` 제외가 들어가기 전에는 enable을 금지한다.** 운영 work-watch에 `alpha-wwtimer`의 `2c3b31fcb` 수정본을 적용하고 실행 중인 감시 프로세스에도 반영해야 한다. 역방향 `Triggers` 확인과 시작 시점 `TriggeredBy` 보존이 빠져 있으면 W4를 켜지 않는다. 운영 검증에서 정시 타이머 발화 후 정시 깨움 하나만 생기고 별도의 작업 완료 깨움이 생기지 않는지 확인한다. 파일 검사만으로 실행 중인 코드나 실제 깨움 결과를 증명할 수 없으므로 이 두 검증은 운영자가 직접 수행한다.

확인 후 운영자가 증빙 JSON에 실제 실행 파일의 `realpath`와 SHA-256을 기록하고, 실행 중인 코드 확인과 추가 깨움 없음 확인을 각각 `true`로 기록한다. 예: `{"work_watch_path":"/absolute/path/work-watch.mjs","work_watch_sha256":"<sha256>","running_code_verified":true,"no_extra_completion_wake_verified":true}`. `node scripts/work-ledger/enable-due-timer.mjs --config /absolute/path/work-ledger.json --work-watch /absolute/path/work-watch.mjs --evidence /absolute/path/evidence.json`으로 켠다. 명령은 증빙의 경로·해시와 지정된 수정본의 파일 해시를 대조하고 모든 항목이 맞을 때만 설정을 바꾼다. 수정본의 바이트가 다른 후속 버전은 이 검사에서 거부되므로 동등성 검증과 검사 갱신이 먼저 필요하다. 명령은 설정 내용의 SHA-256, 승인된 감시 대본 해시, 켠 시각, 활성화 대본 SHA-256을 설정 옆 증빙 사이드카에 기록한다. 사이드카가 없거나 설정 내용이 달라지면 맞추기와 발화를 거부한다. 설정을 변경한 뒤에는 검증을 다시 거쳐 켠다. 사이드카는 서명이 아니므로 파일 쓰기 권한 자체를 통제해야 한다.

## 운영·되돌리기

설정의 `due_timer.enabled`를 `false`로 바꾼 다음 `node scripts/work-ledger/due-timer.mjs clear --root <작업공간> --config <설정>`을 실행한다. `clear`와 `disarm`은 꺼진 상태에서도 이 작업공간의 타이머를 정리하며 새 타이머는 만들지 않는다. 각 장치의 오류는 나머지 정리를 계속한 후 합산해 보고한다. 구형 이름의 장치는 보고만 하며, 정리가 필요하면 `clear --include-legacy`로 이 작업공간의 구형 장치까지 명시적으로 지운다. 설정에서 역할을 제거하면 다음 전체 순회에서 그 역할의 장치를 정리한다. 설정에는 있으나 장부를 읽을 수 없는 역할의 장치는 보존하고 경고한다. 타이머 조정 잠금을 10초 안에 얻지 못하면 장부 변경은 유지하고 다음 순회에서 다시 조정한다. 역할명은 최대 240자다.

`due_timer.after_fire`는 셸을 거치지 않는 명령 인자 배열이지만 설정 작성자는 이 사용자 권한으로 임의 명령을 실행할 수 있다. 설정 파일과 그 경로는 신뢰할 수 있는 사용자만 소유·수정하도록 제한하고, 인자에 토큰이나 민감값을 넣지 않는다. 후속 명령이 실패해도 깨움은 이미 기록됐으므로 발화를 재호출하지 말고 운영자가 후속 전달 프로그램을 직접 확인하고 수동으로 실행한다.

중복 방지를 위해 깨움 전에 영수증을 기록한다. 파일 작성 실패는 영수증을 `claimed`로 되돌려 순회에서 복구한다. 장부 잠금 획득 실패는 `failed`로 기록하고 순회가 `정한 시각` 사유로 다시 깨운다. 영수증 기록 직후 프로세스가 강제 종료되면 깨움 없이 `sent`가 남을 수 있으므로 실패 로그와 깨움 디렉터리를 확인한다.

시험 시 작업 트리 안에 `systemctl`, `systemd-run`을 차단하는 가짜 실행 파일을 두고 그 디렉터리를 `PATH` 맨 앞에 둔다. `TMPDIR`도 작업 트리 안으로 지정하고 실행기를 주입한다. `NODE_TEST_CONTEXT` 또는 `ADK_FORBID_SYSTEM_RUNNER=1`에서는 기본 실행기가 호출을 거부한다.
