# 계획 리뷰 중 저장소 쓰기 막기 (plan-review-write-guard)

운영 배포·작업 계획 적대 리뷰(`node .agents/scripts/approval-plan.mjs review <계획서>`)는 시작 시점의 계획서 SHA-256, 고정 파일(`files`) SHA-256, 실행기 해시, 작업 트리 `git status`/`diff` 스냅샷을 묶어 검증한다. 리뷰가 도는 몇 분~수십 분 동안 다른 세션이 같은 인스턴스 저장소 안 파일을 고치면 리뷰 영수증이 무효가 되거나 PASS 직후 배포 관문(`deploy-guard.js`)이 막힌다(11/8·11/9 재발).

이 장치는 "리뷰 중 쓰지 말 것"이라는 글 규칙 대신, 리뷰 실행기가 잡는 인스턴스 저장소 잠금과 `PreToolUse` 관문으로 리뷰 중 저장소 변경을 막는다.

- 잠금 생성·해제: `.agents/scripts/approval-plan.mjs` (`case "review":`), 공용 잠금 규약 `.claude/hooks/lib/deploy-plan.js`
- 관문 훅: `.claude/hooks/plan-review-write-guard.js`, 경로 추출 `.claude/hooks/lib/plan-review-write-targets.js`
- 시한 감시: `.claude/hooks/lib/hook-watchdog.js`
- 시험: `.claude/hooks/plan-review-write-guard.test.cjs` (`scripts/adk-user-profile.test.mjs` 에서도 함께 실행)
- 등록: `.claude/settings.json` 및 `templates/claude-user-profile/settings.json` (`Bash|Edit|Write|NotebookEdit|MultiEdit|apply_patch`)

## 잠금 규약 (`.agents/state/plan-review.lock`)

`approval-plan.mjs review` 는 계획서(`deploy-plan.json`)가 속한 git 저장소 뿌리(`planRoot`) 아래 `.agents/state/plan-review.lock` 을 배타 플래그(`wx`)로 만든다. 실행기 스크립트가 다른 공통 경로에서 불려도 잠금은 항상 **계획서가 놓인 대상 인스턴스 저장소 뿌리**에 잡힌다.

```json
{
  "schema": "plan-review-lock/v1",
  "pid": 12345,
  "pidStartTicks": "987654321",
  "instanceId": "b6c0...",
  "plan": ".agents/progress/sample-work/gates/deploy-plan.json",
  "repoRoot": "/home/<사용자>/<인스턴스-adk>",
  "startedAt": "2026-11-15T12:20:00.000Z",
  "expiresAt": "2026-11-15T13:20:00.000Z"
}
```

- **기본 시한**: 60분(단일 리뷰어 제한 45분 + 한도 전환 여유). `APPROVAL_PLAN_REVIEW_LOCK_TTL_MS` 환경 변수로 조정할 수 있다.
- **중복 리뷰 방지**: 살아 있는 잠금이 이미 있으면 덮어쓰지 않고 `"이미 진행 중인 계획 리뷰 잠금이 있습니다"` 로 즉시 종료한다.
- **정리 보장**: 정상 완료(`finally`), 오류 종료(`exit`), 신호 중단(`SIGINT`·`SIGTERM`·`SIGHUP`) 모두에서 본인이 잡은 잠금(`instanceId`/`pid` 일치)을 지우고 `.agents/state` 폴더가 비어 있으면 폴더까지 함께 정리한다. 따라서 외부 래퍼(`plan-review.sh` 등)의 전후 `git status` 스냅샷에도 잔여물이 남지 않는다.
- Linux에서 각 검수기는 전용 프로세스 그룹을 쓴다. 검수를 중단하면 실행기가 그 그룹을 종료하고 검수기 출력을 닫은 뒤 잠금을 반납한다. 중단된 실행의 검수자 목록은 비어 있다. 검수기가 먼저 끝나도 같은 그룹에 남은 자식은 함께 종료된다.

## PreToolUse 판정 규칙

관문은 작업 폴더(`cwd`)가 저장소 안이든 밖이든(예: `/home/<사용자>/work/...` 에서 실행되는 2층 일꾼이나 역할 폴더의 3층 세션), 변경 대상 경로의 심볼릭 링크를 실제 경로로 푼 뒤 그 경로가 속한 git 저장소의 `.agents/state/plan-review.lock` 을 확인한다.

| 상태 / 대상 | 판정 | 출력 |
| --- | --- | --- |
| 잠금 없음 | 통과 | 출력 없음 |
| 살아 있는 잠금(`pid` 생존 + 시한 안) + 저장소 안 파일 변이(`Write`/`Edit`/`NotebookEdit`/`MultiEdit`/`apply_patch`) | **차단** | `[Harness] 계획 리뷰 중(<계획 경로>, <시작 시각>) — 끝난 뒤 다시 시도하십시오.` |
| 살아 있는 잠금 + 저장소 안 쓰기 셸 명령(`>`, `>>`, `tee`, `sed -i`, `rm/cp/mv/touch/mkdir/chmod`, `git add/commit/checkout/reset/stash/...`, 인라인 Python/Node 쓰기 등) | **차단** | 위와 같은 차단 안내 |
| 살아 있는 잠금 + 읽기 도구(`Read`/`Grep`/`Glob`) 또는 읽기 전용 셸(`git status/diff/log`, `ls`, `cat`, `rg`, `node --test` 등) | 통과 | 출력 없음 |
| 살아 있는 잠금 + 잠긴 저장소 밖 경로(`/tmp/...`, 작업 폴더, 다른 저장소) 쓰기 | 통과 | 출력 없음 |
| 살아 있는 잠금 + 리뷰 실행기 자신(`/proc` 조상 PID 계보 일치) | 통과 | 출력 없음 |
| 살아 있는 잠금 + `gates/` 아래 리뷰 기록 쓰기(`deploy-plan-review.json`, `deploy-plan-review-*.md`, `deploy-plan-review-findings.md`) | 통과 | 출력 없음 (`gates/deploy-plan.json` 원본 수정과 `plan-review.lock` 삭제는 차단) |
| 죽은 잠금(`pid` 종료·좀비·PID 재사용) 또는 시한(`expiresAt`) 만료 잠금 | 통과 | `PreToolUse` `additionalContext` 한 줄 알림 |
| 잠금 파일 JSON 손상·심볼릭 링크·입력 파싱 오류·내부 예외·관문 시간 초과 | **차단 (fail-closed)** | 오류/시간 초과 사유를 담은 차단 JSON |

## 시한 감시와 Fail-Closed (11/13 시간 초과 사고 교훈)

Claude Code 는 `PreToolUse` 훅이 자체 시간 제한까지 응답하지 못하고 멈추면 훅을 취소하고 도구 실행을 허용(fail-open)해 버린다(11/13 사고). 이를 막기 위해 `plan-review-write-guard.js` 는 `deploy-guard.js` 와 마찬가지로 `lib/hook-watchdog.js` 부모 프로세스 감시 아래에서 자식 프로세스로 본문을 실행한다.

- 기본 감시 시한은 **15초**(`NAIA_PLAN_REVIEW_GUARD_WATCHDOG_MS` 환경 변수로 조정 가능)다.
- 자식이 시한 안에 판정하지 못하거나 신호·비정상 코드로 죽으면 부모 감시기가 자식을 `SIGKILL` 로 정리하고 즉시 `{"decision":"block", ...}` 를 출력해 쓰기가 강행되지 않도록 막는다.
