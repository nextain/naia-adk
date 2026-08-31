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
- `status`, `jobs`, `job`, `watch`, `history`, `latest` 조회, 해시 검증 첨부 복구, 명시적 `reply`
- 서로 독립적인 Codex `exec --json` 및 Claude `-p --output-format stream-json` 실행 어댑터
- 실행별 격리 홈, 최소 인증 파일 복사, 안전 이벤트 변환, 시간 제한·취소·시그널 종료 처리
- 이전 권한 프로필 재사용 차단, 무승인 실행 강제, 승인 UI 감지 시 대기 대신 안전 실패 처리
- 무진행 감시의 1회 개입과 Discord 채널 첫 응답 기한 감시
- Discord REST 수신 폴링을 대신하는 Gateway 연결과 시퀀스·재개 상태 저장
- DM·서버 채널·스레드의 정확한 바인딩과 기본 거부 권한
- 스키마 v2 참여자 프로필·프로젝트 작업 위치·필수 컨텍스트의 명시적 결박
- 같은 호스트·OS 사용자의 모든 ADK 루트에 공통인 Discord 토큰 단일 소유 잠금
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
scripts/manage-discord-sessions.sh health-check [--json]
scripts/manage-discord-sessions.sh jobs [--active|--failed] [--json]
scripts/manage-discord-sessions.sh job <job-id> [--events] [--json]
scripts/manage-discord-sessions.sh watch [--job <job-id>] [--jsonl]
scripts/manage-discord-sessions.sh history --channel <channel-id> [--author <user-id>] [--limit 20] [--json]
scripts/manage-discord-sessions.sh latest --channel <channel-id> [--author <user-id>] [--json]
scripts/manage-discord-sessions.sh attachment --channel <channel-id> --message <message-id> --attachment <attachment-id> --output <absolute-path> [--expected-sha256 <hex>]
scripts/manage-discord-sessions.sh reply --channel <channel-id> --content-file <소유자 전용 절대 경로> [--json]
scripts/manage-discord-sessions.sh service install
scripts/manage-discord-sessions.sh service status
scripts/manage-discord-sessions.sh service restart
```

`service install` 뒤에는 같은 스크립트의 생성 실행기인 `naia-dcg`를 대화형
사용자 `PATH`에서 사용할 수 있습니다. 예를 들어 `naia-dcg status`, `naia-dcg jobs
--active`, `naia-dcg job <job-id> --events`를 실행합니다. 별도 런타임이나 제품
CLI가 아니며, Discord 안에서 처리되는 채팅 명령 `!naia`와는 별개의 로컬 운영
진입점입니다.

한 ADK에서 여러 봇이나 역할을 운영할 때는 이름 있는 인스턴스를 사용합니다.
기본 인스턴스는 위 명령 형식을 그대로 쓰고, 이름 있는 인스턴스는 `naia-dcg`와
명령 사이에 인스턴스 이름을 둡니다.

```bash
naia-dcg <instance> status
naia-dcg <instance> jobs --active
naia-dcg <instance> job <job-id> --events
naia-dcg <instance> watch --job <job-id>
naia-dcg <instance> service install
naia-dcg <instance> service restart
```

각 인스턴스는 설정, SQLite 기록, Gateway 재개 상태, 복구 키, 런타임
디렉터리, 인스턴스 잠금, 서비스 등록을 서로 독립적으로 사용합니다. 자격
증명은 공통 소유자 전용 디렉터리에 두고 각 설정의 `credentialRef`로
선택합니다.

`watch`는 로컬 SQLite 기록만 읽습니다. Discord REST 수신 폴링이 아닙니다.
`history`와 `latest`는 운영자가 명시적으로 한 번 실행하는 읽기 전용 조회입니다. `read` 역할과 유일한 운영 바인딩이 있어야 하며 수신 폴링으로 사용하지 않습니다. `attachment`는 정확한 메시지와 Discord CDN, 크기, 선택한 SHA-256을 검증한 뒤 소유자 전용 파일만 만듭니다. `reply`는 `reply` 역할과 유일한 운영 바인딩을 확인하고, 소유자 전용 파일의 내용을 멘션 없이 한 번 전송합니다. 결과가 `unknown`이면 자동 재전송하지 않습니다. 확인이나 조치를 요청하는 메시지라면 누구에게 요청하는지 반드시 적습니다. 채널에는 여러 사람이 있어 대상 없는 "확인 부탁드립니다"는 아무도 자기 일로 받지 않고, 끝난 일이 확인만 기다리며 멈춥니다. 누가·무엇을·어디서 확인하고 결과를 어디에 알릴지까지 적고, 직접 확인하지 못한 이유도 밝힙니다. `reply`는 멘션을 억제하므로 `<@id>`만 쓰면 표시는 되어도 알림이 가지 않습니다. 이름을 함께 적습니다.

## 상태를 읽는 방법

- `progressing`: 최근 구조화된 활동 증거가 있음
- `running_no_detail`: 소유한 프로세스는 살아 있지만 백엔드가 세부 진행을 제공하지 않음
- `waiting`: 승인·대기열·재시도처럼 명확한 기다림
- `suspected_stalled`: 활동 없음 제한을 넘긴 경고이며, 설정된 감시기가 한 번 개입해 `running` 표기만 남지 않게 함
- `unresponsive`: 하드 제한이나 객관적인 프로세스 실패
- `unknown`: 증거가 낡거나 없거나 서로 충돌함
- `not_applicable`: 이미 끝난 작업이라 활동 상태를 적용하지 않음

최근 출력이 있다고 결과가 옳은 것은 아닙니다. 요구사항·빌드·테스트·리뷰 증거와 완료 주장을 따로 보여줍니다. AI가 스스로 “테스트 통과”라고 말한 것만으로는 검증 완료가 되지 않습니다.

## 설정과 복구 상태

```text
naia-settings/messenger-sessions/config.json
naia-settings/.sessions/messenger-sessions/runtime.sqlite3

# 이름 있는 인스턴스
naia-settings/messenger-sessions/instances/<instance>/config.json
naia-settings/.sessions/messenger-sessions/instances/<instance>/runtime.sqlite3
```

실제 설정과 세션 상태는 Git에 올리지 않습니다. 설정에는 비밀값이 아니라 자격 증명 참조만 둡니다. Discord 토큰은 `naia-settings/.keys/messenger-sessions/<credentialRef>`에 권한 `0600`으로 두며, 설정 파일도 `0600`이어야 합니다. `backend.selected`를 `codex` 또는 `claude`로 선택하면 되고 `naia-agent`나 `naia-shell`은 필요하지 않습니다. Codex의 `costProfile` 기본값은 `balanced`이며 낮은 추론 강도를 명시적으로 적용합니다. `control`은 중간 강도이고, 현재 `economy`는 같은 낮은 강도 경계를 유지합니다. Gateway 프롬프트에는 호스트가 검증한 `read-only` 또는 `workspace-write` 실행 계약을 기록하므로, 쓰기가 허용된 작업이 대화형 세션 결박이 없다는 이유만으로 읽기 전용으로 강등되지 않습니다. 아직 등록하지 않은 인스턴스는 첫 `service install` 전에 이 값을 선택합니다. 기존 등록의 `backend.selected` 변경은 관리 런타임 전환이므로, 일반 `service install`이나 restart로 덮어쓰지 말고 아래의 검증된 후보 cutover 절차를 사용합니다.

사람의 권한 설정이 바뀌면 `runtime.permissionProfileEpoch`도 바꿉니다. 무인 Discord 설정은 `runtime.approvalPolicy`를 명시적으로 `never`로 둬야 하며 `managed`와 누락 값은 안전하게 거부합니다. 스키마 v2의 모든 참여자는 `operatorUserIds`에도 있어야 합니다. 참여자 프로필은 역할 설명과 작업 제한일 뿐 파일 읽기 격리 수단이 아니며, 현재 Codex 읽기 전용·Claude 계획 모드는 같은 OS 사용자가 읽을 수 있는 파일을 프로젝트별로 격리하지 못하기 때문입니다. 따라서 현재는 호스트 운영자와 같은 수준으로 신뢰할 수 없는 사용자를 허용하지 않습니다.

대화 권한은 `read`와 `reply`를 함께 부여합니다. 변경 권한은 일부만 지원하는 척하지 않고 `write`+`execute` 묶음으로만 허용하며, `operatorUserIds`와 `binding.operatorActions=true`가 모두 필요합니다. Claude는 실제 무승인 변경 canary가 검증될 때까지 읽기·응답 전용입니다. `role.requiresApproval`에 든 작업은 실제 무인 허용 작업에서 제외되므로 권한이 묵시적으로 확대되지 않습니다.

참여자 권한 증거가 완전하지 않은 구형 복구 작업은 항상 `recovery_review`로 보내며 새 쓰기 권한으로 교체하지 않습니다. 스키마 v2 복구도 참여자·바인딩·설정·컨텍스트·관리 런타임 리비전이 모두 같고 읽기 전용일 때만 허용합니다. 암호화 복구 봉투에는 제한된 현재 요청과 결박 해시만 저장하고 조립된 프로젝트 컨텍스트 프롬프트는 저장하지 않으며, 복구 시 현재 검증된 파일에서 다시 만듭니다. 모델 출력이 현재 대화 밖으로 별도 Discord DM을 보내도록 할 수 없습니다.

`noProgressInterventionSeconds`는 소유한 자식이 무진행일 때 한 번 중단시키는 한계입니다. 각 접수 작업은 durable admission 직후 자기 `operatorResponseSeconds` ACK 타이머를 따로 시작하며 60초 supervisor를 기다리거나 Discord를 폴링하지 않습니다. ACK 성공 또는 누락은 작업별로 한 번 기록되고 복구 때 반복하지 않으며 작업 실행을 막거나 취소하지 않습니다. 서비스 종료는 Gateway를 닫기 전에 진행 중인 ACK·제어·상태 projection의 생성·수정·핀 요청을 취소하고 정리해 늦은 전송·fallback·저장·핀이 서비스 소유 범위를 벗어나지 않게 합니다. 백엔드 리더 종료와 상속된 출력 스트림 정리를 별도 제한시간으로 처리해 자손이 종료를 붙잡지 못하게 합니다.

자식의 작업 위치는 반드시 절대 실제 디렉터리여야 하고 cwd와 Codex의 `--cd`로 함께 전달됩니다. Codex의 자동 프로젝트 문서 로딩과 Claude의 사용자 정의 로딩을 끄고, 해시로 결박한 명시적 컨텍스트를 프롬프트 앞에 넣습니다. 공급자 도구 설명과 명시적으로 호출한 기능 스킬은 이 컨텍스트 해시에 포함하지 않으며 설정된 작업 권한을 넓힐 수 없습니다.

production conversation-coordinator 런타임·활성화 분기·새 DB 테이블 생성은 제거되었습니다. `runtime.conversationCoordinator` 키 자체를 지원하지 않고, 철회 전 복구 envelope는 격리만 하며 기존 legacy DB 테이블은 건드리지 않습니다.

## 가시성과 재부팅 복구

서비스는 재부팅 뒤 터미널이나 과거 AI 세션 화면을 자동으로 열지 않습니다. 화면이 떠 있다는 사실은 실제 작업 상태의 증거가 아니기 때문입니다. 대신 다음 정보가 SQLite 안전 이벤트 기록에 남습니다.

1. `status`: 서비스가 실제로 살아 있는지, heartbeat가 신선한지, Gateway 재개 상태가 있는지
2. `jobs`, `job <id> --events`: 작업 단계, 최근 안전 활동, 자식 프로세스 소유권, 전송 상태, 대기·멈춤 의심 이유
3. `completionAssessment`: 요구사항·빌드·테스트·리뷰 증거. 활동 중이라는 것과 결과가 올바르다는 것을 분리해 보여줍니다.

실시간 확인은 `watch --job <id>` 또는 Discord의 `!naia` 명령을 사용합니다. `watch`는 로컬 SQLite만 읽으며 Discord 수신 폴링이 아닙니다. systemd journal에는 안전한 서비스 사유 코드만 남고 프롬프트, 모델 원문 출력, 최종 답변, 토큰, 명령, 로컬 경로는 저장하지 않습니다.

`service.startAt=login`이면 로그인 뒤, `boot`이면 설치기가 사용자 linger를 활성화해 부팅 때 복구를 시작합니다. 제한된 현재 요청과 결박 해시만 소유자 전용 로컬 복구 키로 인증 암호화해 저장하며, 조립된 컨텍스트 프롬프트는 현재 검증된 파일에서 다시 만듭니다. 구형 복구 작업은 항상 검토 대상으로 남깁니다. 스키마 v2에서 `recovery.autoRetry=true`여도 참여자·바인딩·설정·컨텍스트·관리 런타임 리비전이 정확히 같고 읽기 전용인 작업만 같은 작업 ID의 새 실행으로 이어집니다. 쓰기 가능 작업, 자동 재시도 비활성화, 키·암호문 손상은 `recovery_review`가 됩니다. Discord 전송 여부가 불확실한 답변은 자동 재전송하지 않습니다.

`service install`은 설치 터미널의 `PATH`에서 선택한 Codex 또는 Claude 실행파일을 찾습니다. Linux는 소유자 전용 Git runtime artifact를 만들고 리비전·runtime-tree ID·전체 digest·unit 바이트를 검증한 뒤 서비스와 supervisor를 그 복사본에 고정합니다. systemd 실행에는 완전한 managed marker가 필수이고 서비스와 supervisor 모두 설정 읽기·토큰 소유·감시 전에 검증하므로, marker 누락을 직접 실행으로 해석하지 않습니다. 대상 checkout이 나중에 바뀌어도 이전 리비전 이름으로 새 코드를 실행하지 않습니다. Windows는 소유자 전용 실행 파일과 제한된 ONLOGON 예약 작업을 설치하며, 로컬 정책이 예약 작업 생성을 거부하면 소유자 전용 숨김 시작프로그램으로 자동 대체합니다. `service status`, `start`, `stop`, `restart`, `enable`, `disable`은 실제 설치된 등록 방식을 검증한 뒤 제어합니다. `naia-dcg.cmd`도 함께 설치됩니다. 기존 Linux 등록이 있으면 `service install`만으로 덮어쓸 수 없고, 검증된 원복 묶음·이전 설치·배포 후보·별도 후보 제어기가 모두 결박된 cutover 경로를 사용해야 합니다. `backend.selected` 변경도 같은 cutover 절차를 따르며, 일반 `service install`이나 restart는 업그레이드 경로가 아닙니다.

watchdog와 독립 supervisor의 반복 경로는 끝나지 않은 작업만 읽고, 과거 검토·전송 주의 건수는 두 개의 부분 인덱스 집계로 얻습니다. `jobs`는 기본 100건이며 `jobs --limit <1-1000>`으로 명시적인 제한 범위를 정합니다. 누적된 durable history 전체를 매초 읽지 않습니다.

Linux systemd는 자격 증명 바이트에서 만든 토큰 지문과 named-instance 경로에 `/usr/bin/flock`을 중첩합니다. 같은 토큰은 bot ID를 잘못 적거나 ADK 루트가 달라도 같은 커널 잠금에 도달하며, 서비스는 자격 증명을 읽은 뒤 unit이 준 지문과 READY 봇 ID를 다시 검증합니다. 두 advisory lock은 서비스 프로세스 수명 동안 유지되고 종료·crash 때 커널이 해제됩니다. 관리형 Linux도 직접 실행·Windows와 같은 fail-closed owner-record 잠금을 추가로 얻으므로 두 실행 방식이 서로 다른 잠금만 잡고 동시에 Gateway를 소유할 수 없습니다. 같은 호스트·같은 부팅의 완전한 기록에서 PID가 객관적으로 없을 때만 이전 디렉터리를 원자적으로 격리하고 회수합니다. 불완전 기록, 권한 거부, PID 재사용과 신원 충돌은 자동 회수하지 않습니다. XDG 런타임 디렉터리가 없는 Unix의 기본 `/tmp` 대체 경로는 부팅별로 나뉘므로 끝난 이전 부팅의 기록이 다음 부팅을 영구 차단하지 않습니다. 명시적으로 지정한 공용 디렉터리와 같은 디렉터리에서 발견된 다른 호스트·부팅 기록은 계속 안전하게 거부합니다. 외부 kernel lock 충돌은 서비스 코드 진입 전 78로 종료되므로 supervisor에는 stopped로, journal에는 종료 상태로 나타납니다. 서비스 내부에서 도달한 시작 실패만 제한된 사유 코드로 기록합니다.

코드·설정·서비스를 전환하기 전에 아직 수정하지 않은 대상과 별도의 깨끗한 후보 체크아웃을 준비합니다. 기존 설치 CLI에는 새 `cutover` 명령이 없을 수 있으므로 아래처럼 하나의 절대 후보 CLI를 prepare·verify·canary·rollback 전 단계에 사용합니다.

```bash
node /absolute/candidate/.agents/skills/manage-discord-sessions/helper/cli.mjs --adk-root /absolute/target --instance <instance> cutover prepare
node /absolute/candidate/.agents/skills/manage-discord-sessions/helper/cli.mjs --adk-root /absolute/target --instance <instance> cutover verify
node /absolute/candidate/.agents/skills/manage-discord-sessions/helper/cli.mjs --adk-root /absolute/target --instance <instance> cutover canary --job <job-id>
node /absolute/candidate/.agents/skills/manage-discord-sessions/helper/cli.mjs --adk-root /absolute/target --instance <instance> cutover rollback
```

첫 관리형 전환에서는 이 스킬이 만들었던 정확한 구형 mutable 등록만 1회 채택할 수 있습니다. prepare가 소유자 전용 서비스·supervisor·timer 바이트, 정규화된 Node·백엔드 실행 파일, 토큰 자격 증명, 등록 상태, 실행 중이면 실제 소유 프로세스, 유휴 ledger를 확인하고 구형 unit 해시를 묶음에 결박합니다. 임의 또는 부분 일치 구형 unit은 거부합니다.

후보와 대상의 Discord 스킬 트리는 모두 깨끗하고 서로 다른 커밋이어야 합니다. 원복 묶음은 이전 커밋과 Git 트리 ID, 실제 복사 코드 해시, 설정, 그 설정이 복사된 이전 런타임의 실제 loader에서 수락됐다는 영수증, 서비스·감시 unit, 데이터베이스 호환 증거를 함께 결박합니다. canary의 `continue`는 묶음 재검증, 설치된 서비스·supervisor·timer unit 바이트 일치, Linux 서비스와 timer의 enabled·active, 신선하고 정상인 독립 supervisor·서비스·Gateway, 작업 접수·실행·현재 서비스·supervisor 세대의 정확한 일치, 그리고 실제 router가 저장한 schema-v2 읽기 전용 작업의 instance·agent·workspace·context·참여자 권한·설정·access 증거를 현재 호스트에서 다시 계산한 값과 정확히 일치시키고 완료·ACK 확인·최종 전송 확인까지 해야만 가능합니다. 근거 누락·위조·stale·형식 오류·세대 불일치·미완료·`recovery_review`·승인 UI·미확인 ACK/전송은 모두 `stop`입니다. 중단 판정이면 같은 후보 CLI로 원복합니다. 원복은 변경 전에 loader 영수증을 포함한 묶음을 다시 검증하고 서비스를 중지하며, 끝나지 않은 작업이 하나라도 있으면 이전 런타임에 데이터베이스를 넘기지 않습니다. 이전 설정과 versioned 서비스·supervisor unit을 복구한 뒤에만 재시작하고, 한 단계가 실패하면 뒤 단계는 실행하지 않습니다. 검증 실패 시 전환하지 않습니다. Windows의 versioned rollback은 지원하지 않습니다.

관리 런타임 복사본과 원복 묶음은 수동 복구를 위해 보존합니다. `naia-dcg <instance> artifacts list`로 확인하고, 현재 등록과 활성 원복 포인터를 검증한 뒤 `naia-dcg <instance> artifacts prune`으로 다시 검증된 미참조 복사본만 제거합니다. 설치·전환 준비·원복·정리는 인스턴스별 Linux 커널 잠금으로 직렬화하므로 활성화 중인 자산과 정리가 경합하지 않으며 프로세스 종료 시 잠금과 준비 표식이 자동 해제됩니다. 설치 중인 런타임, 활성 원복 묶음, 손상된 자산, 구형·불명확 등록은 제거하지 않습니다. 설치 실패 자산도 어떤 unit도 참조하지 않을 때만 제거됩니다. 버전 고정 Windows 전환을 지원하기 전까지 Windows 설치는 최초 설치만 허용하고, 실행 파일을 만들기 전에 기존 본 서비스 또는 supervisor 등록을 거부합니다. `autoStart=false`는 실행 가능한 본 서비스 Task를 만들지 않고 비활성 Startup 파일만 설치하며, Windows stop·disable·restart·격리는 하나의 검증된 fail-closed 전이를 사용합니다. 과거의 검토·전송 주의 기록은 계속 보이지만 그것만으로 새 정상 canary를 영구 차단하지 않습니다.

캐시 증거는 공급자가 준 원시 정수만 기록합니다. 일반 입력, cache-read, Claude cache-created는 서로 독립된 값이며 전체나 부분집합으로 추론하지 않습니다. 완전한 영수증이 없으면 캐시 효과는 입증되지 않은 것으로 봅니다.

독립 supervisor는 더 엄격합니다. Linux에서는 별도 timer, Windows에서는 검증된 최소 권한 1분 Task Scheduler 작업이 필수입니다. supervisor 등록을 본 서비스보다 먼저 검증하며 실패하면 부분 설치의 본 서비스와 supervisor timer를 모두 격리합니다. `service status`는 두 등록을 모두 검증합니다. 후보 설정이 깨져도 설치된 등록을 확인·격리할 수 있도록 `service status`, `stop`, `disable`은 후보 설정을 먼저 읽지 않습니다.

watchdog와 독립 supervisor는 매번 끝나지 않은 작업을 오래 기다린 순서로 최대 256개만 읽습니다. 전체 활성 작업 수와 과거 검토·전송 주의 건수는 집계 조회로 얻습니다. 활성 작업이 256개를 넘으면 초과 건수를 숨기지 않고 `operational_jobs_truncated` 장애로 표시합니다. 운영자용 `jobs` 조회도 기본 100개, 최대 1000개로 제한됩니다.

백엔드 완료 판정은 닫힌 방식입니다. 공급자가 결과를 `unknown`으로 표시하거나 명시적 성공 근거가 없으면 성공으로 올리지 않고 Discord에도 전달하지 않습니다.

## 지속 감시 계약

대화형 AI 턴 안의 폴링은 턴·컨텍스트·위임 에이전트가 끝나면 함께 멈추므로 지속 감시라고 표현하지 않습니다. `service install`은 Discord 서비스와 별도로 60초마다 실행되는 결정론적 supervisor를 설치합니다. supervisor는 SQLite를 읽기 전용으로 열고 그 밖의 `supervisor-status.json`만 원자적으로 갱신하며 메시지 전송, 재실행, 재시작, ledger 변경을 하지 않습니다. `health-check --json`으로 서비스 중단·stale, 기한을 넘긴 활성 작업, 과거 주의 기록, Gateway 근거 불명을 구분합니다. 협업 서브에이전트는 이 하네스의 관리 대상이 아니므로 상태에 `foreignAgentSupervision=unsupported`를 표시하고, 실제 생명주기를 별도로 확인하기 전에는 active라고 말하거나 결과에 의존하지 않습니다.

검증 명령은 `pnpm test:discord-sessions`입니다. 상세 설계는 `docs/design/discord-session-observability.md`와 `docs/design/discord-unattended-supervision-plan.md`, 요구사항은 `DSO-001`~`DSO-012`가 정본입니다.
