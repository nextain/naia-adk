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

사용자 설정에는 파괴적 Git, 최상위 삭제, 강제 푸시, 메일 발송 훅과 아래 여섯 훅을 등록합니다. 매처는 저장소 설정과 같습니다. 여섯 훅의 역할 모드는 `CLAUDE_PROJECT_DIR`(없으면 cwd) 바로 아래에 `.naia-role.json`이 있을 때만 켭니다. 역할 파일이 없는 세션은 `NAIA_ADK_ROOT` 환경 변수가 있어도 기존 저장소 훅과 같은 판정을 내립니다. `NAIA_ADK_ROOT`는 정책·기록을 찾을 ADK 절대 경로만 지정합니다. 저장소 안에서 연 세션에는 같은 훅이 저장소 설정과 사용자 설정에서 두 번 걸립니다. 둘 다 막는 쪽으로 판정하므로 위험은 없고 실행만 두 번입니다.

| 훅 | 매처 | 역할 폴더에서 읽는 것 |
| --- | --- | --- |
| `commit-guard.js` | `Bash` | ADK 뿌리 기준 `P.commit` 정책 판정. 진행 기록이 없는 작업 공간은 기존 정책대로 통과 |
| `deploy-guard.js` | `Bash` | ADK 배포 설정·승인·감사 기록. 승인 없는 운영 배포 차단 |
| `remote-identity-gate.js` | `Bash` | ADK 저장소 목록·공개 저장소 승인. 실제 Git 대상 경로도 검사 |
| `gcs-guard.js` | `Bash` | ADK 버킷 정책. 정책 누락·손상 시 버킷 작업 차단 |
| `heavy-search-guard.js` | `Bash` | `.claude/projects/`의 JSONL 검색·폴더 재귀 검색에 `timeout <초>` 요구. 권장: `timeout 60 nice -n 19 grep -m 5 -F ...`. 큰 문맥 정규식(`.{100}` 이상)은 `-F`·`-m`이 없으면 시간 제한이 있어도 경고 |
| `prod-gateway-guard.js` | `Edit|Write` | 편집 입력의 운영 게이트웨이 값. 외부 정책 불필요 |
| `subagent-spawn-guard.js` | `Task|Agent` | 역할 폴더의 `.claude/allow-subagents`와 생성 한도. 역할마다 카운터 분리 |

대화 검색 관문은 파일 내용 대신 경로·파일 종류 메타데이터만 확인합니다. 검색은 JSONL 파일과 재귀 검색 폴더를 대상으로 하며, 글로브와 여러 읽기 명령도 검사합니다. 시간 제한은 0보다 크고 최대 600초여야 하며 신호 0은 허용하지 않습니다. `cd` 뒤 상대 경로, 경로를 생략한 재귀 검색, `bash -c` 안의 명령에도 같은 규칙이 적용됩니다. 이 관문은 실수로 오래 실행되는 작업을 줄이기 위한 것이며 보안 경계가 아닙니다. 심볼릭 링크 별칭은 추적하지 않고, Bash 외의 Read·Grep 도구는 검사하지 않습니다.

추가 사용자 훅은 비용 이벤트 일곱 개(`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Stop`, `PreCompact`), GPU 생성 확인(`PreToolUse`, `Bash`), 하위 모델 제한(`PreToolUse`, `Task|Agent|Workflow`)입니다. GPU 훅은 원본처럼 생성·재시도·백그라운드 실행에 확인을 요청합니다. 하위 모델 훅은 기본 `haiku`·`sonnet`과 `상위 목표:`·`막히면 올림:` 안내 줄을 요구합니다. 생성 허용 표지가 있어도 모델 검사는 함께 적용됩니다.

역할 모드의 커밋도 `P.commit`에 위임합니다. 가장 최근 기록 하나나 별도 단계 목록으로 판정하면 다른 작업의 기록과 새 단계 이름이 커밋을 막을 수 있기 때문입니다. 정책 모듈을 읽지 못하면 역할 모드에서는 차단합니다.

## 넣는 법

서버의 세션 사용자마다 ADK를 받은 뒤 **정책 채우기 → apply → check → 역할 세션 다시 시작** 순서로 적용합니다.

1. 위 표의 두 정책 견본을 사용자 홈의 지정 경로에 준비합니다. 비용 정책의 `configDir`와 `expectedEmail`을 해당 사용자의 설정 디렉터리와 계정으로 채웁니다. 하위 모델 견본은 기본값 그대로 쓸 수 있으며, 수정했다면 자리표시 없이 유효한 정책인지 확인합니다.
2. `apply`로 사용자 설정을 적용합니다.
3. `check`가 차이 없이 종료하는지 확인합니다.
4. 역할 세션을 다시 시작합니다.

```bash
node scripts/adk-user-profile.mjs apply              # 지금 사용자
node scripts/adk-user-profile.mjs apply --home /home/<다른 사용자>
node scripts/adk-user-profile.mjs check              # 다르면 경로를 찍고 1로 끝남
```

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
