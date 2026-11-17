범위: 공통

# 그룹 세션 센서

그룹은 회사나 팀의 구성원·권한·에이전트 자리·채널을 묶는 ADK입니다.
`docs/guides/adk-2.0-structure.md`와 `templates/group-skeleton/`이 기준입니다.
이 저장소의 구조 버전은 2.0.0입니다.

## 설정

`templates/group-skeleton/adk.json`의 `group_config.operations.sensors_file`이
`operations/sensors.example.json`을 가리킵니다. 기본값은 `enabled: false`입니다.
그룹 인스턴스에 복사하고 역할·서버·사서함 참조를 채운 뒤 `enabled: true`로 켭니다.
실제 연결 주소와 자격 증명은 로컬 어댑터가 참조 이름으로 찾습니다.
`state_directory`는 그룹 안의 전용 디렉터리 이름입니다. 인스턴스의 무시 목록에
이 디렉터리를 추가하고 소유자만 읽도록 둡니다.

`messenger.routes`는 여러 서버의 대화방과 담당 역할을 연결합니다.
`unanswered_seconds: 1800`은 사람 글과 봇을 멘션한 글에 30분 동안 팀 봇의
답이 없을 때 역할을 깨웁니다. 같은 서버·같은 대화방의 뒤이은 팀 봇 답이
대기를 해소합니다. 관측 범위는 최근 두 시간입니다.

`mail.sources`의 `kind`는 `mailbox` 또는 `group`입니다.
`metadata_only: true`로 메일 번호·발신자 참조·제목·수신 시각만 요청합니다.
어댑터는 서버의 필드 선택 기능으로 이 헤더만 가져옵니다. 본문 조회 함수는
계약에 없습니다. `agent_sender_refs`에 있는 발신자는 건너뜁니다.
깨움에는 발신자 참조와 256자 이내 제목을 담습니다. 번호는 자원과 함께
해시하여 중복을 가립니다. 최근 두 시간의 메일을 검사합니다.

## 실행

구현은 `scripts/lib/group-sensors.mjs`, 실행 입구는 `scripts/group-sensors.mjs`입니다.
운영자가 검토한 로컬 ES 모듈을 어댑터로 전달합니다. 다음 예시의 파일은
인스턴스 운영자가 구현하는 연결부입니다.

```sh
node scripts/group-sensors.mjs poll <GROUP_ROOT> <TRUSTED_ADAPTER_MODULE> sensor-primary
node scripts/group-sensors.mjs diagnose <GROUP_ROOT> <TRUSTED_ADAPTER_MODULE>
node scripts/group-sensors.mjs recover <GROUP_ROOT> <TRUSTED_ADAPTER_MODULE> sensor-primary developer-session enable_wait
node scripts/group-sensors.mjs recover <GROUP_ROOT> <TRUSTED_ADAPTER_MODULE> sensor-primary developer-session enable_wait --apply
```

별도 타이머가 1분마다 `poll`을 실행합니다. AI 세션이 쉬거나 멈춰도 타이머는
돌아갑니다. 어댑터의 default export는 다음 비동기 함수를 제공합니다.

| 함수 | 입력과 반환 약속 |
|---|---|
| `readMessages({route,since,limit})` | 해당 서버·대화방의 최근 기록만 반환. 각 항목은 `id`, 밀리초 `at`, `human`, `bot_mentioned`, `team_bot`. 신뢰하는 팀 봇 목록으로 `team_bot`을 계산하고, 담당 봇 멘션으로 `bot_mentioned`를 계산 |
| `readMailHeaders({source,fields,limit})` | 요청한 필드만 조회. `id`, `sender_ref`, `subject`, 밀리초 `received_at`. 실제 발신 주소는 로컬 참조로 바꿈 |
| `wake(request)` | `requestId`, `role`, `kind`, `access: read-only`, `source_ref`, `message_id`, 메신저의 `route_id`, 메일의 `source_kind`, `sender_ref`, `subject`를 받아 깨움함에 전달. 수락한 뒤 resolve. `requestId`를 영속 기록하여 재시도 중복 실행 방지 |
| `readSessionStatus({sessionId,workspace})` | 로컬 작업 폴더·화면·세션 기록·센서 상태를 읽어 `workspace`, `account_ref`, `sensor_at`, `input_pending`, `wait_enabled`, `alive`만 반환 |
| `recover({sessionId,workspace,action})` | 지정 세션의 허용 동작 하나만 수행 |

메일·메신저 배치는 각각 최대 1,000개입니다. 제공자는 최근 두 시간의 항목을
빠짐없이 반환하도록 페이지를 모읍니다. 그 범위를 넘으면 조회 범위를 나누는
인스턴스 어댑터를 준비합니다. 코어는 한도를 넘긴 배치를 거절합니다.
현재 코어는 제공자 SDK를 포함하지 않으며 이 계약을 구현한 어댑터와 함께 실행합니다.

## 정본 하나

1층 센서는 정해진 규칙대로 입력을 관측하고 깨움함에 전달하는 프로세스입니다.
`authority.instance_id`와 정확히 같은 실행자만 관측과 복구를 수행합니다.
상태 디렉터리의 `authority.lock`을 배타적으로 만들어 동시 실행을 막습니다.
여러 기기에서 같은 이름으로 실행할 때는 같은 원자적 잠금을 지원하는 상태
저장소를 사용합니다. 기기마다 분리된 상태 폴더는 공동 잠금을 제공하지 않습니다.

정본을 옮길 때는 이전 타이머와 실행의 종료를 확인하고, 남은 잠금을 확인한 뒤
정본 설정과 상태 저장소를 함께 옮깁니다. 프로세스가 강제 종료되어 남은 잠금은
운영자가 실제 종료를 확인한 뒤 정리합니다. 기기의 전원 상태 대신 센서의 최근
실행 시각을 확인합니다. 살아 있는 정본 하나와 명시적인 전환으로 역할을 나눕니다.

상태 파일은 임시 파일을 쓴 뒤 이름을 바꿔 교체합니다. 발송 전에 outbox를
기록하고 수락한 뒤 완료를 기록합니다. 수락 직후 중단되면 같은 요청 번호로
재시도하므로 `wake` 수신자의 영속 중복 검사가 필요합니다. 실패는 다음 실행에
남고 두 시간 지난 항목은 버립니다. 완료 번호는 하루 보관합니다. 메일 헤더가
담긴 로컬 outbox와 실제 어댑터는 인스턴스의 비공개 운영 자료입니다.

## 진단과 복구

바깥 프로세스의 `diagnose`는 설정과 상태를 읽고 `readSessionStatus`를 호출합니다.
폴더·잠금·상태를 만들거나 고치는 호출이 없습니다. 어댑터도 읽기 전용으로
구현합니다. 결과에는 확인값과 역할 식별자만 담고 화면·기록 원문은 로컬에서
필요한 범위만 살펴봅니다. 센서 신선도 기준은 2분입니다.

| 순서 | 확인할 것 | 다음 동작 |
|---|---|---|
| 1 | 작업 폴더와 세션이 연결되는가 | 실제 프로세스의 cwd와 세션 식별자를 대조 |
| 2 | 비용 감시 계정 참조가 기대값과 같은가 | 소유자가 계정 바인딩을 확인 |
| 3 | 정본 센서가 2분 안에 돌았는가 | 정본·타이머·잠금과 최근 실행 기록 확인 |
| 4 | 입력창에 제출할 글이 남았는가 | 보존할 내용을 확인하고 `clear_input` 검토 |
| 5 | 대기가 켜져 있는가 | `enable_wait` 검토 |
| 6 | 세션이 살아 있는가 | 소유자가 세션 수명 주기를 확인 |

`recover`는 먼저 진단하고 계획을 출력합니다. `--apply`가 있을 때 잠금 안에서
신원을 다시 확인한 뒤 설정의 `recovery_actions`에 든 동작 하나를 호출합니다.
공통 동작 목록은 `restart_sensor`, `enable_wait`, `clear_input`입니다.
작업 폴더와 계정이 일치할 때 적용하며, 적용 뒤 다시 진단합니다. 입력을 정리하기
전에는 필요한 내용을 운영자가 보존합니다. 계정 변경·잠금 제거·정본 이동은
소유자가 별도로 검토하는 절차로 둡니다.

## 검증

`tests/group-sensors.test.mjs`는 설정 opt-in, 메신저 경계, 메일 헤더, 중복,
재시도, 잠금, 읽기 전용 진단과 복구 범위를 로컬 가짜 어댑터로 검사합니다.
실제 제공자 연결은 인스턴스 어댑터를 준비한 환경에서 확인합니다.
