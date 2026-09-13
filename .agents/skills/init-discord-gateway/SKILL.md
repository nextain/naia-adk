---
name: init-discord-gateway
description: naia-adk 워크스페이스에 Discord 게이트웨이 인스턴스를 초기화·설정할 때 반드시 사용. "디스코드 게이트웨이 초기화", "디스코드 봇 설정", "messenger-sessions 만들어", "naia-settings에 디스코드 설정" 요청 시 사용. 설정은 항상 그 ADK의 naia-settings 아래에 둔다. naia-shell·data-private를 쓰지 않는다.
argument-hint: "[--instance <id>] [--backend opencode|codex|claude]"
---

# Init Discord Gateway

`naia-adk` 안에서 Discord 게이트웨이를 켜기 위한 초기화 스킬이다. 설정 정본은
그 ADK 루트의 `naia-settings/` 다. `data-private` 가 아니고, `naia-shell` 경로도
아니다. 나중에 셸이 붙을 때도 셸은 ADK 경로만 넘긴다.

운영·감시·재시작은 `manage-discord-sessions` 가 맡는다. 이 스킬은 설정 파일을
만들고 다음 손을 알려 주는 일만 한다.

## 경로

| 역할 | 경로 |
|------|------|
| 추적되는 예시 | `naia-settings/messenger-sessions/config.example.json` |
| 기본 인스턴스 설정 | `naia-settings/messenger-sessions/config.json` |
| 이름 있는 인스턴스 | `naia-settings/messenger-sessions/instances/<id>/config.json` |
| 봇 토큰 (직접 넣음) | `naia-settings/.keys/messenger-sessions/<credentialRef>` |
| 작업 장부 | `naia-settings/.sessions/messenger-sessions/` |

설정 파일은 `credentialRef` 만 들고, 토큰 본문은 넣지 않는다.

## 워크플로우

1. ADK 루트를 정한다. `--adk-root` 또는 `naia-settings/messenger-sessions/config.example.json` 이 보이는 현재 워크스페이스.
2. 스크립트를 실행한다. 이미 파일이 있으면 `--force` 없이 덮지 않는다.
3. 출력된 `tokenPath` 에 봇 토큰을 소유자 전용(0600)으로 넣는다.
4. `manage-discord-sessions` 로 `service install` 한다.

```bash
node .agents/skills/init-discord-gateway/scripts/init-discord-gateway.mjs \
  --adk-root . \
  --instance alpha \
  --backend opencode \
  --bot-user-id <snowflake> \
  --operator-user-id <snowflake> \
  --guild-id <snowflake> \
  --channel-id <snowflake> \
  --repo owner/name
```

## 검증

```bash
node --test .agents/skills/init-discord-gateway/tests/init-discord-gateway.test.mjs
```
