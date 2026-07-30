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
- Discord REST 수신 폴링을 대신하는 Gateway 연결과 시퀀스·재개 상태 저장
- DM·서버 채널·스레드의 정확한 바인딩과 기본 거부 권한
- 사용자 systemd 자동 시작, 단일 실행 잠금, 끊김 후 제한된 지수 백오프 재연결
- 중단된 작업 ID를 보존하면서 `recovery_review`로 표시하는 재부팅 복구
- Discord 안의 범위 제한 명령: `!naia status`, `!naia jobs`, `!naia job <id>`

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
scripts/manage-discord-sessions.sh service install
scripts/manage-discord-sessions.sh service status
scripts/manage-discord-sessions.sh service restart
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

실제 설정과 세션 상태는 Git에 올리지 않습니다. 설정에는 비밀값이 아니라 자격 증명 참조만 둡니다. Discord 토큰은 `naia-settings/.keys/messenger-sessions/<credentialRef>`에 권한 `0600`으로 두며, 설정 파일도 `0600`이어야 합니다. `backend.selected`를 `codex` 또는 `claude`로 선택하면 되고 `naia-agent`나 `naia-shell`은 필요하지 않습니다.

## 가시성과 재부팅 복구

서비스는 재부팅 뒤 터미널이나 과거 AI 세션 화면을 자동으로 열지 않습니다. 화면이 떠 있다는 사실은 실제 작업 상태의 증거가 아니기 때문입니다. 대신 다음 정보가 SQLite 안전 이벤트 기록에 남습니다.

1. `status`: 서비스가 실제로 살아 있는지, heartbeat가 신선한지, Gateway 재개 상태가 있는지
2. `jobs`, `job <id> --events`: 작업 단계, 최근 안전 활동, 자식 프로세스 소유권, 전송 상태, 대기·멈춤 의심 이유
3. `completionAssessment`: 요구사항·빌드·테스트·리뷰 증거. 활동 중이라는 것과 결과가 올바르다는 것을 분리해 보여줍니다.

실시간 확인은 `watch --job <id>` 또는 Discord의 `!naia` 명령을 사용합니다. `watch`는 로컬 SQLite만 읽으며 Discord 수신 폴링이 아닙니다. systemd journal에는 안전한 서비스 사유 코드만 남고 프롬프트, 모델 원문 출력, 최종 답변, 토큰, 명령, 로컬 경로는 저장하지 않습니다.

`service.startAt=login`이면 로그인 뒤, `boot`이면 설치기가 사용자 linger를 활성화해 부팅 때 복구를 시작합니다. 프롬프트는 소유자 전용 로컬 복구 키로 인증 암호화한 암호문만 저장합니다. `recovery.autoRetry=true`일 때도 읽기 전용·계획 모드 작업만 같은 작업 ID의 새 실행으로 이어집니다. 쓰기 가능 작업, 자동 재시도 비활성화, 키·암호문 손상은 `recovery_review`가 됩니다. Discord 전송 여부가 불확실한 답변은 자동 재전송하지 않습니다.

`service install`은 설치 터미널의 `PATH`에서 선택한 Codex 또는 Claude 실행파일을 찾아 절대 경로와 현재 Node 실행 디렉터리를 사용자 unit에 고정합니다. 그래서 systemd의 `PATH`가 더 좁아도 `/usr/bin/env node`를 쓰는 Codex를 포함한 Linuxbrew나 사용자 전용 설치가 재부팅 뒤 동작합니다. `backend.selected`를 바꾼 뒤에는 단순 재시작이 아니라 `service install`을 다시 실행해야 새 실행 경로가 고정됩니다.

검증 명령은 `pnpm test:discord-sessions`입니다. 상세 설계는 `docs/design/discord-session-observability.md`, 요구사항은 `DSO-001`~`DSO-006`이 정본입니다.
