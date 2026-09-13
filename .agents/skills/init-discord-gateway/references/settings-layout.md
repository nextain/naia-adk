# Discord gateway settings layout

The Discord gateway is a naia-adk skill. Its live settings live under that ADK's
`naia-settings/`, not under `data-private`, and not under `naia-shell`.

`naia-shell` later takes only the ADK workspace path. From that path it can
see `naia-settings/messenger-sessions/` the same way it already sees
`naia-settings/config.json`.

## What belongs where

- Portable behaviour: `.agents/skills/manage-discord-sessions/` in naia-adk.
- Initialization: `.agents/skills/init-discord-gateway/`.
- Instance config, IDs, backend choice: `naia-settings/messenger-sessions/`.
- Bot token and recovery key: `naia-settings/.keys/messenger-sessions/`.
- Job ledger and managed runtime: `naia-settings/.sessions/messenger-sessions/`.
- Character archive / private persona research: `data-private/` — not Discord
  gateway config.

## After init

```bash
.agents/skills/manage-discord-sessions/scripts/manage-discord-sessions.sh \
  --instance <id> service install
```
