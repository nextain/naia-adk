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

- 서버의 `/home/nextain/minho/alpha-adk/.agents/scripts/work-watch.mjs`는 `TriggeredBy` 속성이나 기존 기록이 있으면 타이머 서비스로 분류해 제외한다(1606행). 하지만 같은 파일에는 수거된 서비스의 타이머 역방향 관계를 확인하는 `timerForService`가 없다.
- `/home/nextain/work/alpha-wwtimer`의 `git rev-parse HEAD` → `2c3b31fcb152ecfb55da3cafd627998351cc66f1`; 그 파일 1590~1601행은 `TriggeredBy`가 사라진 서비스에 대해 타이머의 `Triggers`가 해당 서비스와 정확히 일치하는지 확인한다.
- 서버 체크아웃에서 `git merge-base --is-ancestor 2c3b31fcb HEAD`의 종료 값은 1이다. 위 비교는 현재 파일에 해당 보완이 없음을 보여 주지만 실행 중인 프로세스의 코드나 실제 깨움 발생은 확인하지 않았다. 따라서 수거된 `adk-due-*` 서비스가 작업 완료 깨움을 낼 위험이 남으며 W4 전에 운영 측에서 확인하고 해결해야 한다.

## ④ 대시보드

이 작업 트리의 `packages/dashboard/app` 및 `packages/server/src`에서 일정 장치 목록이나 `adk-due-` 분기와 `list-timers`를 찾지 못했다. 서버의 alpha-adk 대시보드·서버 소스와 관련 스크립트에서도 해당 문구나 `adk-due-` 예외를 찾지 못했다. 별도 포털의 일정 화면과 운영 배포판은 확인하지 못했으므로 이 타이머가 실제로 '문서에 없는 장치'로 표시되는지는 **미확인**이다. 실제 장치를 만들거나 대시보드를 변경하지 않았다.

## 구현 전 시험 기준

- 요청된 `node --test scripts/work-ledger/`: Node v22.23.4에서 디렉터리를 모듈로 찾지 못해 `MODULE_NOT_FOUND`, 1개 중 실패 1개.
- 보충 확인 `node --test scripts/work-ledger/*.test.mjs`: 88개 통과, 실패 0개. 종료 때 요청된 명령과 보충 명령을 각각 같은 방식으로 대조한다.
