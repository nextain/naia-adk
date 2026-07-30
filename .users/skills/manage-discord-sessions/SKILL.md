---
name: manage-discord-sessions
description: Codex 또는 Claude로 실행되는 Discord 백그라운드 작업의 설정·상태·실시간 활동·재부팅 복구를 ADK 워크스페이스에서 관리합니다.
---

# Discord 세션 관리

Codex와 Claude가 함께 쓰는 관리 스킬입니다. 별도 제품 CLI나 `naia-agent`, `naia-shell` 없이 동일한 내부 스크립트로 로컬 상태를 읽습니다.

## 현재 구현된 범위

- SQLite 기반 작업·안전 이벤트 영속 기록
- 서비스 상태의 신선도와 작업 활동 상태 구분
- 사전에 선언한 완료 검사와 신뢰 가능한 검증 증거
- `status`, `jobs`, `job`, `watch` 조회
- 서로 독립적인 Codex `exec --json` 및 Claude `-p --output-format stream-json` 실행 어댑터
- 실행별 격리 홈, 최소 인증 파일 복사, 안전 이벤트 변환, 시간 제한·취소·시그널 종료 처리

Discord Gateway, systemd 설치와 실제 재부팅 복구, Discord 상태 메시지는 이슈 #18의 다음 구현 단계입니다. 현재 실행기는 다음 Gateway가 호출할 내부 모듈이며, Discord에서 아직 작업을 시작할 수 있다고 보고하면 안 됩니다.

## 이렇게 요청하면 됩니다

```text
Discord 세션 상태 보여줘
현재 백그라운드 작업 보여줘
job <id>가 지금 뭘 하는지 보여줘
job <id>를 실시간으로 지켜봐
완료를 뒷받침하는 테스트 결과 보여줘
```

스킬은 내부적으로 다음 명령을 사용합니다.

```bash
scripts/manage-discord-sessions.sh status [--json]
scripts/manage-discord-sessions.sh jobs [--active|--failed] [--json]
scripts/manage-discord-sessions.sh job <job-id> [--events] [--json]
scripts/manage-discord-sessions.sh watch [--job <job-id>] [--jsonl]
```

`watch`는 로컬 SQLite 기록만 읽습니다. Discord REST 수신 폴링이 아닙니다.

## 상태를 읽는 방법

- `progressing`: 최근 구조화된 활동 증거가 있음
- `running_no_detail`: 소유한 프로세스는 살아 있지만 백엔드가 세부 진행을 제공하지 않음
- `waiting`: 승인·대기열·재시도처럼 명확한 기다림
- `suspected_stalled`: 활동 없음 제한을 넘긴 경고이며 실패 확정은 아님
- `unresponsive`: 하드 제한이나 객관적인 프로세스 실패
- `unknown`: 증거가 낡거나 없거나 서로 충돌함
- `not_applicable`: 이미 끝난 작업이라 활동 상태를 적용하지 않음

최근 출력이 있다고 결과가 옳은 것은 아닙니다. 요구사항·빌드·테스트·리뷰 증거와 완료 주장을 따로 보여줍니다. AI가 스스로 “테스트 통과”라고 말한 것만으로는 검증 완료가 되지 않습니다.

## 설정과 복구 상태

```text
naia-settings/messenger-sessions/config.json
naia-settings/.sessions/messenger-sessions/runtime.sqlite3
```

실제 설정과 세션 상태는 Git에 올리지 않습니다. 설정에는 비밀값이 아니라 자격 증명 참조만 둡니다.

검증 명령은 `pnpm test:discord-sessions`입니다. 상세 설계는 `docs/design/discord-session-observability.md`, 요구사항은 `DSO-001`~`DSO-006`이 정본입니다.
