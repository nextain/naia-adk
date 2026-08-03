# naia-settings

Fork-root, backup-unit settings for the Naia workspace. **Canonical (정본)**
location consumed by `naia-agent`.

`naia-settings` is also the canonical workspace-relative location for the
provider-neutral Discord session skill. That skill does not require
`naia-agent` or `naia-shell`.

## `messenger-sessions/` — Discord AI session configuration

Tracked example:

```text
naia-settings/messenger-sessions/config.example.json
```

Local configuration and recovery state:

```text
naia-settings/messenger-sessions/config.json
naia-settings/.sessions/messenger-sessions/runtime.sqlite3
```

The real config is ignored because persona instructions, Discord IDs, bindings,
and operator IDs may be private. It stores `credentialRef` only, never a bot
token. Durable job/event/evidence state is also ignored and remains available
after helper or machine restart.

Use the existing `manage-discord-sessions` skill from Codex or Claude. It works
without `naia-agent` or `naia-shell`: Discord Gateway receives events, the
selected Codex or Claude CLI runs in an isolated child environment. Linux uses
a user systemd unit. Windows prefers one limited ONLOGON Task Scheduler task;
when local policy denies task creation it uses a verified owner-only hidden
per-user Startup launcher. Both paths pin an owner-only native launcher.

```bash
.agents/skills/manage-discord-sessions/scripts/manage-discord-sessions.sh service install
.agents/skills/manage-discord-sessions/scripts/manage-discord-sessions.sh service status
.agents/skills/manage-discord-sessions/scripts/manage-discord-sessions.sh service restart
.agents/skills/manage-discord-sessions/scripts/manage-discord-sessions.sh status
.agents/skills/manage-discord-sessions/scripts/manage-discord-sessions.sh jobs --active
.agents/skills/manage-discord-sessions/scripts/manage-discord-sessions.sh job <id> --events
.agents/skills/manage-discord-sessions/scripts/manage-discord-sessions.sh watch --job <id>
.agents/skills/manage-discord-sessions/scripts/manage-discord-sessions.sh latest --channel <channel-id> --author <user-id>
.agents/skills/manage-discord-sessions/scripts/manage-discord-sessions.sh attachment --channel <channel-id> --message <message-id> --attachment <attachment-id> --output <absolute-path> --expected-sha256 <hex>
.agents/skills/manage-discord-sessions/scripts/manage-discord-sessions.sh reply --channel <channel-id> --content-file <owner-only-absolute-path>
```

After `service install`, use the generated `naia` command on Linux or
`naia.cmd` on Windows. `history`/`latest` perform one explicit REST read for a
uniquely authorized binding; they are not a polling receive path. Attachment
recovery is bound to the exact authorized message, Discord CDN host, advertised
size, and optional expected SHA-256.
`reply` requires the reply role and one exact operator binding, reads an
owner-only content file, suppresses mentions, and does not retry an unknown
receipt.

Provider result records marked `unknown`, or lacking an explicit supported
success marker, remain unsuccessful and are never sent as completed answers.

The service intentionally does not open a terminal. Its durable safe-event
ledger is the visibility surface. A prompt is stored only as authenticated
ciphertext protected by an owner-only local recovery key. After reboot, valid
recovery material starts a new attempt under the same job ID; missing or corrupt
material becomes `recovery_review`. An uncertain Discord delivery is never
auto-resubmitted.

For unattended Discord work, set `runtime.approvalPolicy` explicitly to `never`; managed or omitted policies fail closed. Actions in `role.requiresApproval` are removed from the effective unattended action set. Run `naia health-check --json` for the read-only health projection. `service install` also installs an independent 60-second supervisor which writes only its own atomic snapshot outside SQLite. Interactive AI polling is not continuous monitoring, and collaboration subagents remain outside this harness (`foreignAgentSupervision=unsupported`).
The supervisor registration is verified before the main service starts. A failed timer/task registration quarantines the main registration, and `service status` checks both identities.

Also
advance `runtime.permissionProfileEpoch` whenever the parent execution policy
changes. Recovery compares that profile before it launches a child, discards
historical command options, and uses the current no-prompt profile only.
`noProgressInterventionSeconds` bounds one owned-child abort;
`operatorResponseSeconds` bounds the safe channel acknowledgement before an
explicit `recovery_review` handoff. A changed no-prompt profile can replace a
previous guarded mutation attempt, but unchanged mutation recovery remains a
review handoff. The helper rejects relative workspaces and binds every child
to the requested absolute workspace rather than an ambient caller working
directory.

## `llm.json` — LLM role configuration (SoT)

3-role object. Each role is `{ provider, baseUrl, model }` plus optional
`apiKeyRef` (keyed providers) and `dims` (embedding role).

| Role | Purpose | Consumed by |
|---|---|---|
| `main` | The conversational Agent LLM | `naia-agent` direct mode (drives the running agent) |
| `sub` | Reviewer / auxiliary subagent LLM | subagent calls (two-tier) |
| `embedded` | Embedding model for memory recall | memory host / conversational recall |

```jsonc
{
  "version": 1,
  "main":     { "provider": "openai-compat", "baseUrl": "...", "model": "...", "apiKeyRef": "OPENAI_API_KEY" },
  "sub":      { "provider": "openai-compat", "baseUrl": "...", "model": "..." },
  "embedded": { "provider": "ollama-embed", "baseUrl": "...", "model": "...", "dims": 1024 }
}
```

`provider`: `openai-compat` | `ollama-embed` | `anthropic` | `glm`
(local Ollama/vLLM = `openai-compat`/`ollama-embed`, no auth).

## `review.json` — cross-review reviewer panel + tier policy (SoT)

`llm.json` 의 형제. **실질 적대 검증(substantive review) 역할의 정본** — `main`/`sub` 단일 모델과 달리 **플래그십 다중 독립 리뷰어 패널**을 표현한다. `review-pass` 스킬 + naia-agent 가 소비.

| 키 | 의미 |
|---|---|
| `tier_policy` | 활동별 모델 tier (naia-agent 원조 2계층 정규화): 머리쓰기·설계·실질검증=`flagship` / 형식검증=`light` / 구조=`deterministic` |
| `reviewers[]` | 플래그십 리뷰어 패널 (`claude` · `codex` · `glm-5.1`), 각 `{id, tier, command, stdin, parse}` |
| `excluded` | 제외 도구 + 사유 (gemini-CLI = 응답 불안정) |
| `stages` | 단계별 리뷰어·수렴 (review-pass 정합) |

> **tier 정책**: 리뷰어 = 플래그십(검증=고위험, 강한 모델). 형식검증·번역·미러·드리프트 검출 = 라이트(`sub`). 구조검사 = LLM 무(스크립트). 상세 = `naia-template-project/docs/llm-roles.md` 3-레벨 표.
> **secret 정책 동일**: 이 파일도 git-tracked backup — 키 값 금지, `apiKeyRef`(이름)만.

## Secret policy — **no plaintext, ever**

`llm.json` is a git-tracked backup unit. It **must never contain a raw
API key**. Keyed providers reference a secret by name only:

- The canonical public reference for a user-issued Naia account key is
  `NAIA_KEY`. `NAIA_API_KEY` and `NAIA_ANYLLM_API_KEY` are migration aliases;
  `NAIA_PROD_KEY` and `NAIA_DEV_KEY` are private-fork developer names and are
  not part of the public workspace contract.

- `apiKeyRef` = an environment variable name **(Slice A, now)** or an OS
  keychain entry name **(Slice B, device-key encrypted — in progress)**.
  The actual secret lives in the process env or the OS keychain — **never
  in this file** (cleanroom deep-audit F8/§128: plaintext forbidden).
- **Enforced, not just convention**: the `naia-agent` reader actively
  rejects the whole `llm.json` (warn + skip; value never logged) if any
  role carries a plaintext-secret-looking key (`apiKey`/`key`/`token`/…)
  or value (`sk-…`/`AIza…`/40-hex/…). A raw key here is refused, not
  silently consumed into git.
- Local Ollama / vLLM need no key — omit `apiKeyRef` (a loopback/private
  `baseUrl` gets a dummy key automatically; remote URLs do **not**).

## Configure via `naia-agent login`

```
pnpm naia-agent login --adk <this-workspace> \
  --main "openai-compat|http://127.0.0.1:11434/v1|gemma3n:e4b" \
  --embedded "ollama-embed|http://127.0.0.1:11434/v1|bge-m3|1024" \
  [--key ANTHROPIC_API_KEY=sk-…]   # → OS keychain, never written here
```

Writes this `llm.json` (config only) + `~/.naia-agent/config.json`
(`naiaAdkPath`, so later runs need no `NAIA_ADK_PATH`). `--key` is stored
device-key-encrypted in the OS keychain; if unavailable, login refuses
(no plaintext) and tells you to `export` it as an env var instead.

## Resolution priority (naia-agent)

```
process.env  >  naia-settings/llm.json  >  ./naia-agent.env  >  ~/.naia-agent
```

`naia-agent` finds this file via `NAIA_ADK_PATH` (the naia-adk workspace
root). `main` maps onto the existing provider resolution; `sub` /
`embedded` are exposed as `NAIA_SUB_*` / `NAIA_EMBED_*`.
