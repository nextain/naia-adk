범위: 공통
상태: 1판(2026-11-05). 역할 세션 사용자 설정의 공통 판

# Claude 사용자 프로파일

역할 세션은 ADK 저장소 밖 역할 폴더(예: `/home/<사용자>/<역할>`)에서 돕니다(`agent-role-sessions.md`). 그 자리에서는 저장소의 `.claude/settings.json` 이 걸리지 않아, 압축 기준·압축 뒤 다시 읽기 훅이 하나도 없습니다. 이 프로파일은 모든 서버의 사용자 설정(`~/.claude/`)에 같은 판을 넣습니다.

## 담긴 것

`templates/claude-user-profile/`

| 파일 | 넣는 곳 | 내용 |
| --- | --- | --- |
| `settings.json` | `~/.claude/settings.json` | 압축 기준 `CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000`, `CLAUDE_CODE_GOAL_CHECKIN_MINUTES=0`, `CLAUDE_CODE_RETRY_WATCHDOG=0`, 세션 시작 `role-compact-brief.js` 훅(ADK 뿌리 절대 경로). 압축 뒤에도 세션 시작이 `source: "compact"` 로 다시 불려 같은 훅이 미션 경로를 다시 싣습니다. 압축 뒤(PostCompact) 훅 출력은 사람 화면에만 뜨고 모델에 들어가지 않아 쓰지 않습니다 |
| `CLAUDE.md` | `~/.claude/CLAUDE.md` 의 표시 구간 | 압축할 때 남길 것(미션·원문 지시·작업 문서 표·코드 상태·돌아가는 것·남은 일·지킬 것)과 컨텍스트 절약 |
| `hooks/*.cjs` | ADK 안의 절대 경로로 실행 | 비용 관찰, GPU 대여 확인, 하위 모델 제한. 비용 상태·사용량 보조 모듈도 같은 폴더에서 읽습니다 |
| `cost-guard.policy.example.json` | `~/.claude/cost-guard/policy.json` | 사용자별 설정 디렉터리·계정·비용 기준 견본. 기존 파일은 그대로 둡니다 |
| `subagent-model.policy.example.json` | `~/.claude/subagent-model-policy.json` | 허용 모델·위임 안내·긴급 예외 시간 견본. 기존 파일은 그대로 둡니다 |

압축 기준이 없으면 세션은 모델 최대 창까지 맥락을 키운 뒤에야 압축합니다. 부를 때마다 보내는 맥락이 커져 비용이 늘고 중간 내용을 놓치는 일이 커집니다.

사용자 설정에는 파괴적 Git, 최상위 삭제, 강제 푸시, 메일 발송 훅과 아래 여덟 훅을 등록합니다. 매처는 저장소 설정과 같습니다. 역할 모드를 쓰는 훅은 `CLAUDE_PROJECT_DIR`(없으면 cwd) 바로 아래에 `.naia-role.json`이 있을 때만 역할 모드를 켭니다. 역할 파일이 없는 세션은 `NAIA_ADK_ROOT` 환경 변수가 있어도 기존 저장소 훅과 같은 판정을 내립니다. `NAIA_ADK_ROOT`는 정책·기록을 찾을 ADK 절대 경로만 지정합니다. 저장소 안에서 연 세션에는 같은 훅이 저장소 설정과 사용자 설정에서 두 번 걸립니다. 둘 다 막는 쪽으로 판정하므로 위험은 없고 실행만 두 번입니다.

| 훅 | 매처 | 역할 폴더에서 읽는 것 |
| --- | --- | --- |
| `commit-guard.js` | `Bash` | ADK 뿌리 기준 `P.commit` 정책 판정. 진행 기록이 없는 작업 공간은 기존 정책대로 통과 |
| `deploy-guard.js` | `Bash` | ADK 배포 설정·승인·감사 기록. 승인 없는 운영 배포 차단 |
| `remote-identity-gate.js` | `Bash` | ADK 저장소 목록·공개 저장소 승인. 실제 Git 대상 경로도 검사 |
| `gcs-guard.js` | `Bash` | ADK 버킷 정책. 정책 누락·손상 시 버킷 작업 차단 |
| `prod-gateway-guard.js` | `Edit|Write` | 편집 입력의 운영 게이트웨이 값. 외부 정책 불필요 |
| `lead-write-guard.js` | `Bash|Edit|Write|NotebookEdit|MultiEdit|apply_patch` | 3층 역할 세션(`.naia-role.json` `lead_guard.enabled`)의 저장소 작업 트리 직접 쓰기 차단 (`lead-write-guard.md`) |
| `plan-review-write-guard.js` | `Bash|Edit|Write|NotebookEdit|MultiEdit|apply_patch` | 대상 저장소의 `.agents/state/plan-review.lock` 확인. 적대 리뷰 진행 중 저장소 쓰기 차단 (`plan-review-write-guard.md`) |
| `subagent-spawn-guard.js` | `Task\|Agent` (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`), `SubagentStop` | 역할 폴더의 `.claude/allow-subagents`(`maxConcurrent`)와 동시 구동 한도. 역할마다 카운터 분리 |

추가 사용자 훅은 비용 이벤트 일곱 개(`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Stop`, `PreCompact`), GPU 생성 확인(`PreToolUse`, `Bash`), 하위 모델 제한(`PreToolUse`, `Task|Agent|Workflow`)입니다. GPU 훅은 원본처럼 생성·재시도·백그라운드 실행에 확인을 요청합니다. 하위 모델 훅은 기본 `haiku`·`sonnet`과 `상위 목표:`·`막히면 올림:` 안내 줄을 요구합니다. 생성 허용 표지가 있어도 모델 검사는 함께 적용됩니다.

`subagent-spawn-guard.js`는 세션 누적 생성 수가 아니라 **지금 동시에 돌고 있는 서브에이전트 수**만 제한합니다. `PreToolUse(Task|Agent)`가 `tool_use_id`별로 자리를 잡고(저장소·사용자 이중 등록 중복 제외), 앞단 완료(`PostToolUse`), 실패(`PostToolUseFailure`), 배경 실행(`run_in_background`) 종료(`PostToolUse(async_launched)`의 `agentId` → `SubagentStop`) 시 자리를 해제합니다. 종료 신호를 놓친 자리는 마지막 갱신 뒤 30분이 지나면 자동 해제되어 오래 연 세션이 잠기지 않습니다. `.claude/allow-subagents`는 `{ "maxConcurrent": 8 }`처럼 적으며(최대 40, 미지정 시 고정 4 상한 없이 `max(1, floor((MemTotal - 4GB) / 0.5GB / 2))`로 계산해 31GB 서버 기준 27로 잡히며 `reserveMemGb`·`memPerSubagentGb`·`estimatedSessions`·`defaultMaxConcurrentCap` 키로 조정 가능), 옛 `maxSpawns`는 `maxConcurrent`와 같은 뜻으로 읽고 `windowMinutes`와 옛 `{"spawns":N}` 카운터는 무시합니다. 또한 띄울 때 `/proc/meminfo`의 `MemAvailable`이 `reserveMemGb + max(1GB, memPerSubagentGb)`(기본 `5GB`) 미만이면 구동 수와 무관하게 차단합니다(`/proc/meminfo`가 없는 환경에서는 가용 메모리 검사만 건너뛰고 `MemTotal` 기준 상한만 적용).

역할 모드의 커밋도 `P.commit`에 위임합니다. 가장 최근 기록 하나나 별도 단계 목록으로 판정하면 다른 작업의 기록과 새 단계 이름이 커밋을 막을 수 있기 때문입니다. 정책 모듈을 읽지 못하면 역할 모드에서는 차단합니다.

## 넣는 법

서버의 세션 사용자마다 ADK를 받은 뒤 **정책 채우기 → apply → check → 역할 세션 다시 시작** 순서로 적용합니다.

1. 위 표의 두 정책 견본을 사용자 홈의 지정 경로에 준비합니다. 비용 정책의 `configDir`와 `expectedEmail`을 해당 사용자의 설정 디렉터리와 계정으로 채웁니다. 하위 모델 견본은 기본값 그대로 쓸 수 있으며, 수정했다면 자리표시 없이 유효한 정책인지 확인합니다.
2. `apply`로 사용자 설정을 적용합니다.
3. `check`가 차이 없이 종료하는지 확인합니다.
4. 역할 세션을 다시 시작합니다.

```bash
node scripts/adk-user-profile.mjs apply              # 지금 사용자 (Claude + Muse)
node scripts/adk-user-profile.mjs apply --target muse --home /home/<다른 사용자>
node scripts/adk-user-profile.mjs check              # 다르면 경로를 찍고 1로 끝남
```

- `templates/muse-user-profile/settings.json` → `~/.config/muse/settings.json`(`--home` 미지정 시 `$XDG_CONFIG_HOME` 우선): `muse-pretooluse-adapter.cjs` 로 Muse 에 Claude 사용자 프로파일과 같은 8개 이벤트(`PreToolUse`, `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Stop`, `PreCompact`, `SessionStart`)와 같은 15종 훅(`cost-guard.cjs`, `subagent-model-guard.cjs`, `role-compact-brief.js`, 안전·역할 훅)을 연결합니다(`--target all|claude|muse`). 저장소(`.muse/hooks.json`) 밖 폴더(예: `/home/<사용자>/work`, 역할 폴더)에서 도는 Muse 에는 이 사용자 층만 걸리며 그 범위는 같은 층의 Claude Code 사용자 프로파일(`templates/claude-user-profile/settings.json`)과 같습니다(저장소 전용 훅인 `session-contract-gate.js` 등은 저장소 `.muse/hooks.json` 에서만 걸립니다). 적용은 승인 후 `adk-user-profile.mjs apply` 로만 수행하며 서버에서 손으로 고치지 않습니다.

- 프로파일의 환경 변수와 같은 이름의 기존 값은 덮어쓰며, 바뀐 키 이름을 출력합니다. 다른 설정은 유지합니다. 같은 훅은 두 번 넣지 않습니다. ADK 경로가 바뀌어 다시 돌리면 옛 경로의 프로파일 훅을 지우고 새 경로로 바꿉니다.
- 정책 파일이 없으면 견본을 권한 `0600`으로 한 번 복사합니다. 자리표시가 남아 있거나 정책이 유효하지 않으면 `settings.json`을 쓰기 전에 오류(2)로 멈춥니다. 안내에는 정책 파일 경로와 채울 키 이름만 나오며 값은 출력하지 않습니다. 기존 정책은 내용·서식을 그대로 보존합니다. 비용 정책의 `{{USER_HOME}}`·`{{ACCOUNT_EMAIL}}`을 채운 뒤 `apply`를 다시 실행합니다. 개인정보는 사용자 홈에만 둡니다. `NAIA_COST_GUARD_POLICY`·`NAIA_SUBAGENT_MODEL_POLICY`는 적용한 홈의 정책을 가리킵니다.
- 비용·하위 모델 정책이 없거나 손상되면 해당 훅은 차단합니다. 초기 비용 견본도 사용자 값으로 채우기 전에는 차단합니다. 비용 훅은 확인된 계정 불일치를 차단하고, 미확인 사용량은 원본처럼 검토 안내를 냅니다. 사용량 수집기는 이 프로파일에 포함되지 않으며, 기존 수집기가 정책 폴더의 `meter.json`을 갱신해야 합니다.
- ADK 뿌리에 훅 파일이 없으면 `apply`·`check` 모두 오류(2)로 멈춥니다.
- `check`는 두 정책의 누락·잘못된 JSON·무효한 값·남은 자리표시를 차이로 알리고 1로 끝납니다. `apply`와 `check`는 같은 정책 검증 기준을 씁니다. 정책의 계정·한도 설정은 사용자 환경에 맞게 관리합니다. 관리 훅 목록과 템플릿 등록이 다르면 오류로 멈춥니다.
- 바꾸기 전 파일은 `<파일>.bak-<시각>` 으로 남깁니다.
- `CLAUDE.md` 는 표시 구간(`naia-adk claude-user-profile: begin/end`)만 바꿉니다. 표시가 짝이 맞지 않거나 표시 밖에 같은 최상위 제목이 있으면 적용을 중단하고 확인하도록 알립니다.
- 설정은 세션을 다시 켤 때부터 걸립니다.

## 역할 미션 파일

압축 뒤 다시 읽을 문서는 역할 폴더의 `.naia-role.json` 에 적습니다. 인스턴스마다 다르므로 공통 판에는 넣지 않습니다.

```json
{ "role": "dev", "read": ["/home/<사용자>/<역할>/index.md", "/home/<사용자>/<역할>/progress.md"] }
```

`.naia-role.json` 은 세션을 켠 폴더(cwd) 바로 그 자리에서만 찾습니다. 하위·상위 폴더는 보지 않습니다. 절대 경로이고 실제로 있는 파일만 싣습니다. 문서 내용은 싣지 않고 경로만 냅니다(20줄 이내).

## 판 맞추기

프로파일을 고치면 이 저장소를 고치고 각 서버에서 `apply` 를 다시 돌립니다. 서버에서 사용자 설정을 손으로 고치지 않습니다. `check` 가 다르다고 하면 그 서버가 공통 판에서 벗어난 것입니다.

## 등록된 공통 실행기 설치

등록된 검수 현장을 쓰는 인스턴스는 같은 정본 설치기에 SHA256으로 고정한 설치 descriptor를 전달합니다. 명시한 `--target claude` 또는 `--target codex`에서 지원하며 파일과 지문 두 옵션이 모두 필요합니다.

```bash
node scripts/adk-user-profile.mjs check --target claude \
  --home /home/operator --adk-root /opt/adk-template \
  --instance-root /srv/workspace \
  --registered-deploy-hooks /srv/installation/profile-hooks.json \
  --registered-deploy-hooks-sha256 <descriptor-sha256>
```

검토된 설치자가 `check` 결과를 확인한 뒤 같은 옵션으로 `apply`합니다. 설치기 script가 있는 사본, `--adk-root`의 기본 훅/템플릿 사본, 등록된 실행 엔진 사본은 서로 구분합니다. 설치기만 바뀌었다고 기존 실행 엔진의 검수 지문을 바꾸지 않습니다. 등록 설치기는 POSIX 호스트의 `/usr/bin/git`을 고정해 실행 엔진의 정본 경로·커밋·깨끗한 상태를 최초 검사와 쓰기 직전 재검사합니다. Git 자식 환경은 명시한 기본값만 전달하며 호출자의 `PATH`, `GIT_DIR`, `GIT_WORK_TREE`, 대체 인덱스와 Git 설정 환경 변수를 물려받지 않습니다. 사용자·시스템 Git 설정도 읽지 않으며, descriptor로 선택한 정확한 엔진 경로만 `safe.directory`로 허용해 관리자의 소유자가 다른 설치를 지원합니다.

설치 descriptor 형식은 `adk-registered-deploy-hooks/v1`입니다. 다음 항목만 받으며 command 문자열이나 임의 실행 인자는 받지 않습니다.

- `home`, `instanceRoot`: 명시한 설치 대상 절대 경로.
- `engine`: `root`, 깨끗한 Git 사본의 `commit`, 공식 `.agents/scripts/approval-plan.mjs`의 `entrySha256`.
- `registration`: 인스턴스 `.claude/deploy/registered-gate.json`의 `file`, `sha256`.
- `entries`: `global`과 `project` 두 `scope`에 대해 각각 등록된 `id`, 현장 `root`. ID는 해당 registration의 허용 집합에서 선택하며 특정 회사 이름으로 고정하지 않습니다. project 현장은 instanceRoot와 같아야 합니다.

공식 hook 명령은 `/usr/bin/node <engine>/.agents/scripts/approval-plan.mjs hook --registration <file> --sha256 <hash> --profile <id>`뿐입니다. 각 slot의 ID는 descriptor에 적힌 literal 값이며 stdin이나 환경 변수로 교체하지 않습니다. 설치기는 회사 정책 코드를 load하지 않고 설치 identity와 지문만 확인합니다. 실제 정책·계획·승인 판정은 하나의 공통 실행기가 담당합니다. 호출자의 신뢰할 수 있는 시작 환경은 별도로 준비·검수하는 전제입니다. 이 설치 옵션이 이미 시작된 shell이나 운영체제 전체의 환경을 정화한다는 뜻은 아닙니다.

등록 모드에서는 user/global의 기존 deploy 훅 하나와 project의 기존 deploy 훅 하나만 각 공식 entry로 교체합니다. 다른 15종 사용자 훅·다른 프로젝트 설정은 보존하고, 기존 파일 UID/GID/mode와 백업을 유지합니다. 같은 옵션의 재적용은 변경이 없습니다. 누락·변조된 descriptor/entry/registration, 잘못된 root/profile, 중복·모호한 기존 deploy 훅은 설정을 쓰기 전에 거절합니다. 등록 후 descriptor를 빼고 기본 apply를 실행해 옛 deploy 훅을 조용히 되살릴 수 없습니다. 기본 무등록 프로파일은 기존 16훅 동작을 유지합니다. 두 설정의 소유자·쓰기 경로를 먼저 확인하고 새 내용과 원본 복원 파일을 모두 준비한 뒤 각각 교체합니다. 둘째 교체가 실패하면 첫째 파일을 원래 bytes·UID/GID/mode로 복원합니다. 복원 자체가 실패하면 보존한 백업과 함께 오류를 보고합니다. 일반 사용자는 다른 소유자의 설정을 첫 쓰기 전에 거절하며 OS root 설치자는 원래 소유권을 보존할 수 있습니다. 사용자 설정 디렉터리의 `.registered-deploy-hooks.install.lock`으로 동시 설치를 직렬화하지만 두 파일을 읽는 모든 프로세스까지 잠그지는 않습니다. 실제 적용자는 hook 실행이 없는 hold 창에서 설치·검증하며 서비스나 모델을 재시작하지 않습니다.

설치 중단 뒤 lock이 남으면 `check`는 PID·시작 시각·boot identity를 읽기만 합니다. 소유 프로세스의 종료나 PID 재사용이 확인된 lock은 다음 등록 `apply`에서 기존 공통 PID lock 도구가 격리 보존한 뒤 회수합니다. 살아 있는 PID는 오래됐다는 이유로 해제하지 않습니다. 깨졌거나 소유자를 확인할 수 없는 lock은 자동 삭제하지 않습니다. 운영자는 먼저 reader hold를 유지하고 진행 중인 설치가 없는지 확인한 뒤 lock과 두 설정 백업을 보관해 복구합니다. 복구 기록은 같은 디렉터리의 PID lock 격리 기록에서 확인합니다.

등록 모드는 project JSON 손상을 오류로 거절합니다. 무등록 기본 프로파일은 원래 project 설정을 설치 대상으로 삼지 않으므로 읽기 불가·잘못된 JSON을 그대로 두며 user 프로파일만 처리합니다. 두 설정의 복원 범위에 rule·누락 정책 파일은 포함하지 않습니다. 이 파일들은 기존 정본 순서로 처리하므로 실패 시 보존한 설정 백업과 함께 실제 생성·변경 여부를 확인합니다.

### Native Codex 등록

같은 descriptor와 공식 명령을 `--target codex`에 전달하면 user의
`<home>/.codex/hooks.json`과 project의 `<instanceRoot>/.codex/hooks.json`에
각각 전용 PreToolUse/Bash 훅을 등록합니다. 기존 훅 정의는 유지하며, 이 모드에서는
SessionStart 훅을 추가하거나 Claude 설정을 바꾸지 않습니다. 두 파일의 쓰기·백업·
소유권·복원은 같은 paired writer를 사용하고 잠금은 `<home>/.codex`에 둡니다.
별도의 CODEX_HOME 경로로 우회하지 않으며 다른 codex-hooks-file을 함께 주면 거절합니다.

`check`는 설치할 두 경로의 차이만 확인합니다. 실제 Codex 신뢰 등록과 훅 실행을
증명하지 않습니다. 운영자는 공식 hooks/list에서 정확한 명령·출처·key·currentHash를
확인하고 새 두 정의만 config/batchWrite의 hooks.state로 신뢰 등록합니다. 기존 훅의
신뢰 상태는 그대로 보존하고 필요한 기존 훅이 미신뢰이면 별도 선행조건으로 보고합니다.
실제 세션의 시작 cwd가 프로젝트여야 하며, tool의 workdir만 바꾼 시험으로 대체하지
않습니다. 공식 hook/completed의 run.id에는 tool_use_id가 붙으므로 같은 도구 호출의
두 관문 완료를 묶을 수 있습니다. 설치 완료와 실제 수신 완료를 따로 기록합니다.

### Native Codex 등록 지문 교체

같은 engine·프로젝트·두 profile을 유지하며 등록 파일 지문만 바꿀 때는
`scripts/adk-user-profile.mjs`의 기존 `check`/`apply`에 다음 세 인자를 함께 줍니다.

```bash
--previous-registered-deploy-hooks /private/previous-descriptor.json \
--previous-registered-deploy-hooks-sha256 <previous-descriptor-sha256> \
--previous-registration-file /private/registered-gate.before.json
```

기본 `--registered-deploy-hooks`와 그 SHA는 새 descriptor를 가리켜야 하며,
고정 위치의 실제 등록 파일도 새 descriptor와 일치해야 합니다. 이전 등록 백업은
이전 descriptor에 적힌 SHA로 검증합니다. 세 입력은 canonical 일반 파일과 소유권·
크기·지문 검사를 거치며 실행 경로로 사용하지 않습니다. 두 descriptor의 home,
instance, engine root/commit/entry 지문, 등록 목적지와 두 profile id/scope/root가
같아야 합니다. 이전 입력을 생략하면 다른 등록 명령은 계속 거절합니다.

설치기는 검증한 이전 두 명령 또는 이미 같은 새 명령만 받아 기존 paired writer로
교체합니다. 다른 25개 등의 기존 정의·추가 설정은 유지하며, 누락·중복·다른 명령은
쓰기에 앞서 거절합니다. 설치 source와 등록된 engine root는 달라도 됩니다.
새 등록 파일과 두 hook의 교체가 끝날 때까지 실제 hook 호출자를 quiesce해야 합니다.
그 사이의 서로 다른 등록 지문을 준비 완료로 보고하지 않습니다. Gateway나 다른
수신기를 이 설치의 이유로 중지할 필요는 없습니다.

설치 후 공식 native discovery에서 바뀐 두 정의만 확인·신뢰 등록하고 기존 신뢰
상태는 보존합니다. 되돌릴 때도 이전·새 descriptor 역할을 바꾸고 교체 직전 등록의
정확한 백업을 제공하여 같은 검증과 paired writer를 사용합니다. 실제 native 수신,
권한 동의와 서비스 실행을 설치 성공으로 대신하지 않습니다.
