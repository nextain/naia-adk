범위: 공통
상태: 1판(2026-11-05). 역할 세션 사용자 설정의 공통 판

# Claude 사용자 프로파일

역할 세션은 ADK 저장소 밖 역할 폴더(예: `/home/<사용자>/<역할>`)에서 돕니다(`agent-role-sessions.md`). 그 자리에서는 저장소의 `.claude/settings.json` 이 걸리지 않아, 압축 기준·압축 뒤 다시 읽기 훅이 하나도 없습니다. 이 프로파일은 모든 서버의 사용자 설정(`~/.claude/`)에 같은 판을 넣습니다.

## 담긴 것

`templates/claude-user-profile/`

| 파일 | 넣는 곳 | 내용 |
| --- | --- | --- |
| `settings.json` | `~/.claude/settings.json` | 압축 기준 `CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000`, `CLAUDE_CODE_GOAL_CHECKIN_MINUTES=0`, `CLAUDE_CODE_RETRY_WATCHDOG=0`, 세션 시작·압축 뒤 `role-compact-brief.js` 훅(ADK 뿌리 절대 경로) |
| `CLAUDE.md` | `~/.claude/CLAUDE.md` 의 표시 구간 | 압축할 때 남길 것(미션·원문 지시·답 안 한 질문·경로) |

압축 기준이 없으면 세션은 모델 최대 창까지 맥락을 키운 뒤에야 압축합니다. 부를 때마다 보내는 맥락이 커져 비용이 늘고 중간 내용을 놓치는 일이 커집니다.

## 넣는 법

서버의 세션 사용자마다 한 번, ADK 를 받은 뒤에 돌립니다.

```bash
node scripts/adk-user-profile.mjs apply              # 지금 사용자
node scripts/adk-user-profile.mjs apply --home /home/<다른 사용자>
node scripts/adk-user-profile.mjs check              # 다르면 경로를 찍고 1로 끝남
```

- 있던 설정은 그대로 두고 프로파일 키만 덮습니다. 같은 훅은 두 번 넣지 않습니다.
- 바꾸기 전 파일은 `<파일>.bak-<시각>` 으로 남깁니다.
- `CLAUDE.md` 는 표시 구간(`naia-adk claude-user-profile: begin/end`)만 바꿉니다.
- 설정은 세션을 다시 켤 때부터 걸립니다.

## 역할 미션 파일

압축 뒤 다시 읽을 문서는 역할 폴더의 `.naia-role.json` 에 적습니다. 인스턴스마다 다르므로 공통 판에는 넣지 않습니다.

```json
{ "role": "dev", "read": ["/home/<사용자>/<역할>/index.md", "/home/<사용자>/<역할>/progress.md"] }
```

절대 경로이고 실제로 있는 파일만 싣습니다. 문서 내용은 싣지 않고 경로만 냅니다(20줄 이내).

## 판 맞추기

프로파일을 고치면 이 저장소를 고치고 각 서버에서 `apply` 를 다시 돌립니다. 서버에서 사용자 설정을 손으로 고치지 않습니다. `check` 가 다르다고 하면 그 서버가 공통 판에서 벗어난 것입니다.
