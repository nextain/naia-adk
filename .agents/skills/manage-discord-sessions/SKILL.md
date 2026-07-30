---
name: manage-discord-sessions
description: Configure, observe, and recover Discord AI jobs from the ADK workspace with either Codex or Claude. Use for Discord setup, background-job status, live activity, stalled-job diagnosis, reboot recovery, idle rotation, or session history.
---

# Manage Discord Sessions

Use this skill as the shared Codex and Claude operator surface. Do not create a separate product CLI. The deterministic script below reads durable state without launching another AI or requiring `naia-agent` or `naia-shell`.

## Current implementation status

The first two implementation slices provide the local observability core and backend execution contract:

- append-only SQLite job and safe-event history;
- service freshness and job activity-health projection;
- predeclared completion checks and trusted evidence;
- `status`, `jobs`, `job`, and `watch` commands.
- independent Codex `exec --json` and Claude `-p --output-format stream-json` adapters;
- isolated per-attempt child homes, minimum authentication copies, safe event normalization, timeout, cancellation, and signal-aware exit handling.

Discord Gateway, systemd installation, reboot execution, remote Discord projections, and legacy-poller migration remain later issue #18 slices. The backend runner is currently an internal module for the upcoming Gateway; do not claim that Discord can launch it yet.

## Natural-language operations

Translate requests such as these into the same script for both clients:

```text
Show Discord session status.
List active background jobs.
What is job <id> doing?
Watch job <id> live.
Show the evidence for job <id>.
```

Run from the skill directory or use the absolute skill path:

```bash
scripts/manage-discord-sessions.sh status [--json]
scripts/manage-discord-sessions.sh jobs [--active|--failed] [--json]
scripts/manage-discord-sessions.sh job <job-id> [--events] [--json]
scripts/manage-discord-sessions.sh watch [--job <job-id>] [--jsonl]
```

`watch` polls only the local SQLite event ledger. It is not Discord REST receive polling. Stop an interactive watch with `Ctrl-C`.

## Interpreting visibility

Report lifecycle and observed activity separately:

- `progressing`: a recent structured safe event exists;
- `running_no_detail`: the owned backend process is alive but exposes no detail;
- `waiting`: an explicit approval, queue, or retry wait exists;
- `suspected_stalled`: the soft silence threshold passed; this is a warning, not proof of failure;
- `unresponsive`: a hard deadline or objective process failure was observed;
- `unknown`: evidence is stale, missing, contradictory, or the clock moved backward;
- `not_applicable`: the job is terminal.

Recent activity does not prove that a result is correct. Show `completionAssessment` and its requirement/build/test/review checks separately. A backend's own success claim cannot verify itself.

## State and settings

The ADK workspace is the canonical location:

```text
naia-settings/messenger-sessions/config.json
naia-settings/.sessions/messenger-sessions/runtime.sqlite3
```

The real config and all session state are local and ignored by Git. Only `config.example.json` is tracked. Secret values never belong in config, events, status, or logs; config stores credential references only.

## Durable-session policy

1. Keep the lightweight Discord Gateway independent from model execution.
2. End the Codex or Claude child process after a completed turn.
3. Do not send model heartbeats merely to preserve a prompt cache.
4. Reuse bounded transient history only within the configured idle timeout.
5. Rotate transient history at or beyond the timeout; default to 30 minutes unless measured evidence supports another value.
6. Preserve jobs and recovery evidence in durable ADK state, not in a live terminal process.
7. Treat DM, guild channel, and thread bindings as separate authorization and conversation scopes.
8. Never automatically resend `delivery_unknown` after restart.

## Safety boundaries

- Safe events accept typed allowlisted payloads, not raw prompts, stdout, commands, paths, environments, or tool results.
- Discord-visible status is a narrower projection than local operator status.
- A participant sees only a matching conversation binding; operator actions are default-deny.
- AI children must not inherit Discord or service-only credentials.
- If service evidence is stale, say stale or unknown. Never repeat the last `running` value as current truth.

## Verification

Run:

```bash
pnpm test:discord-sessions
```

The deterministic suite covers persisted ordering and dedupe, fresh/stale/waiting/stalled/deadline distinctions, safe-event rejection, activity coalescing, trusted completion evidence, versioned CLI detail, and one-time watch output.

Design authority: `docs/design/discord-session-observability.md`. Requirements: `DSO-001` through `DSO-006`.
