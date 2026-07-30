# Discord에서 Codex·Claude 백그라운드 작업 운영하기

이 실습은 전북대학교 강의에서 다룬 메신저 기반 AI 활용을 독립 과정으로 분리한 것입니다. `naia-agent`나 `naia-shell` 없이 `naia-adk`와 Codex 또는 Claude CLI만 사용합니다.

## 학습 목표

실습을 마치면 다음을 설명하고 직접 확인할 수 있습니다.

- Discord DM, 서버 채널, 스레드를 서로 다른 권한 범위로 설정한다.
- 페르소나, 역할, 허용 행동을 `naia-settings`에 명시한다.
- Discord REST 메시지 폴링 없이 Gateway 이벤트로 작업을 시작한다.
- 재부팅 뒤 서비스, 작업 ID, 안전 활동 기록을 복구한다.
- “프로세스가 활동 중”과 “결과가 검증됨”을 구분한다.
- 전송 여부가 불확실한 답변을 자동 재전송하지 않는 이유를 설명한다.

## 준비물

- Linux와 실행 가능한 systemd 사용자 관리자(`systemctl --user`)
- Node.js 22 이상, pnpm 9 이상
- 로그인된 Codex CLI 0.146.0 이상 또는 Claude Code 2.1.220 이상
- Discord 봇 토큰과 봇 사용자 ID
- 봇을 초대한 시험용 서버·채널 또는 시험용 DM

실제 수업에서는 개인 서버와 시험용 저장소를 사용합니다. 운영 채널과 운영 자격 증명은 사용하지 않습니다. macOS, Windows, systemd가 없는 Linux의 자동 시작 설치는 현재 지원하지 않습니다.

Discord Developer Portal의 봇 설정에서 **Message Content Intent**를 켭니다. 시험 채널에는 View Channel과 Send Messages 권한을 주고, 스레드 실습에는 스레드 보기·보내기 권한도 부여합니다.

## 1. 설정 만들기

```bash
cp naia-settings/messenger-sessions/config.example.json \
  naia-settings/messenger-sessions/config.json
chmod 600 naia-settings/messenger-sessions/config.json
mkdir -p naia-settings/.keys/messenger-sessions
chmod 700 naia-settings/.keys/messenger-sessions
```

`config.json`에서 다음을 실제 값으로 바꿉니다.

- `enabled`: `true`
- `backend.selected`: `codex` 또는 `claude`
- `persona`: AI가 어떤 인격과 설명 방식을 가질지
- `role.allowedActions`: `read`, `reply`, 필요할 때만 `write`, `execute`
- `discord.botUserId`, `operatorUserIds`
- `discord.bindings`: DM, 서버 채널, 스레드의 정확한 ID와 허용 사용자

실습에 사용할 바인딩 하나만 `canStartConversation: true`로 바꿉니다. 예제의 기본값은 실수로 실제 채널에서 실행되지 않도록 모두 `false`입니다.

운영자 ID만 등록했다고 모든 채널의 작업을 볼 수 있는 것은 아닙니다. 해당 바인딩의 `operatorActions`도 `true`여야 합니다. 참여자는 같은 대화 범위의 작업만 봅니다.

토큰은 설정 파일에 쓰지 않습니다. `credentialRef`가 `discord-bot-token`이면 다음 파일에 토큰 한 줄만 저장합니다.

```bash
printf '%s\n' 'DISCORD_BOT_TOKEN' > naia-settings/.keys/messenger-sessions/discord-bot-token
chmod 600 naia-settings/.keys/messenger-sessions/discord-bot-token
```

## 2. 검증하고 자동 시작 설치하기

```bash
pnpm test:discord-sessions
.agents/skills/manage-discord-sessions/scripts/manage-discord-sessions.sh service install
.agents/skills/manage-discord-sessions/scripts/manage-discord-sessions.sh service status
```

설치 명령은 워크스페이스 실제 경로의 해시로 systemd 사용자 서비스 이름을 만듭니다. 그래서 여러 ADK 워크스페이스가 서로 다른 서비스로 공존하고, 같은 워크스페이스에서는 파일 잠금으로 중복 실행을 막습니다.

## 3. Discord에서 범위 확인하기

허용된 위치에서 봇을 구조적으로 멘션하고 요청합니다.

```text
@Naia 이 저장소의 README와 현재 테스트 구성을 읽고 개선점을 알려줘.
```

`respondWhen: mentioned`는 Discord가 제공한 `mentions` 구조를 확인합니다. 본문에 `<@숫자>` 문자열만 흉내 낸 것은 멘션으로 인정하지 않습니다.

상태 조회 명령:

```text
@Naia !naia status
@Naia !naia jobs
@Naia !naia job <작업-ID>
```

DM, 채널, 스레드는 각각 별도 범위입니다. 다른 범위의 작업 ID를 참여자가 조회하면 세부 내용을 보여주지 않습니다.

## 4. 실제 백그라운드 작업 확인하기

로컬에서는 다음 세 층을 봅니다.

```bash
# 서비스가 실제로 살아 있는가
.agents/skills/manage-discord-sessions/scripts/manage-discord-sessions.sh status

# 어떤 작업이 실행·대기·검토 상태인가
.agents/skills/manage-discord-sessions/scripts/manage-discord-sessions.sh jobs --active

# 한 작업의 사람용 안전 이벤트를 본다
.agents/skills/manage-discord-sessions/scripts/manage-discord-sessions.sh job <작업-ID> --events

# completionAssessment까지 포함한 구조화 상태를 본다
.agents/skills/manage-discord-sessions/scripts/manage-discord-sessions.sh job <작업-ID> --json

# 새 안전 이벤트를 실시간으로 보기
.agents/skills/manage-discord-sessions/scripts/manage-discord-sessions.sh watch --job <작업-ID>
```

`progressing`은 최근 활동이 있다는 뜻이지 정답이라는 뜻이 아닙니다. `completionAssessment`의 요구사항·빌드·테스트·리뷰 증거를 함께 확인해야 “잘했다”는 판단을 할 수 있습니다. 현재 Discord 대화 작업은 외부 검증기가 증거를 등록하기 전까지 정직하게 `unverified`로 표시됩니다. `suspected_stalled`는 활동 없음 경고이고, `unresponsive`는 프로세스나 시간 제한에서 객관적 실패를 관측한 상태입니다.

## 5. 재부팅 복구 실험

1. 부팅 직후 로그인을 기다리지 않고 복구하려면 `service.startAt`을 `boot`로 바꾸고 `service install`을 다시 실행합니다. 설치기가 해당 사용자의 linger를 활성화합니다. 기본값 `login`은 로그인 뒤에 시작합니다.
2. 읽기 작업을 시작하고 작업 ID를 기록합니다.
3. 테스트 환경의 서비스를 강제로 중지하거나 시험 장비를 재부팅합니다.
4. 서비스 상태와 같은 작업 ID를 다시 조회합니다.

예상 결과:

- systemd가 서비스를 다시 시작하고 Gateway가 저장한 세션과 시퀀스로 재개를 시도합니다.
- 중단된 작업 ID와 안전 이벤트는 남습니다.
- 원 프롬프트는 소유자 전용 복구 키로 암호화되어 `naia-settings` 로컬 상태에만 남습니다. `recovery.autoRetry:true`이면서 실행 권한이 읽기 전용인 작업만 같은 작업 ID의 새 실행으로 이어집니다. 쓰기 가능 작업, 자동 재시도 비활성화, 키·암호문 손상은 `recovery_review`가 됩니다.
- Discord 전송 성공 여부가 불확실한 답변은 중복 위험 때문에 자동 재전송하지 않습니다.

“복구”는 터미널 화면이나 모델 대화를 되살리는 것이 아니라 서비스 연결, 작업 식별자, 안전한 활동·검증 증거를 정직하게 보존하는 것입니다.

## 6. 토론 과제

1. 프롬프트를 저장하면 자동 재실행은 쉬워집니다. 개인정보와 운영 편의 사이의 경계를 어디에 둘 것인가?
2. 네트워크 타임아웃 뒤 Discord가 메시지를 받았는지 모를 때 왜 즉시 재전송하면 안 되는가?
3. “출력이 계속 나온다”와 “요구사항을 만족했다”를 어떤 증거로 구분할 것인가?
4. 새 메신저 어댑터를 추가할 때 어떤 부분을 공통으로 두고, DM·채널 모델은 어디서 변환할 것인가?

## 확장 방향

현재 공통 작업 저장소, 백엔드 실행기, 활동·완료 투영은 Discord에 종속되지 않습니다. 이후 메신저별 어댑터는 수신 이벤트를 공통 대화 범위로 바꾸고, 결과 전달 영수증을 공통 전달 상태로 변환합니다. `naia-agent`와 `naia-shell`은 같은 계약을 소비하는 선택적 상위 계층이며 필수 의존성이 아닙니다.
