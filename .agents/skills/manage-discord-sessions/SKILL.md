---
name: manage-discord-sessions
description: Configure, observe, and recover Discord AI jobs from the ADK workspace with either Codex or Claude. Use for Discord setup, background-job status, live activity, stalled-job diagnosis, reboot recovery, idle rotation, or session history.
---

# Manage Discord Sessions

Use this skill as the shared Codex and Claude operator surface. Do not create a separate product CLI. The deterministic script below reads durable state without launching another AI or requiring `naia-agent` or `naia-shell`.

## What this provides

The implementation is usable with `naia-adk` alone from either Codex or Claude:

- append-only SQLite job and safe-event history;
- service freshness and job activity-health projection;
- predeclared completion checks and trusted evidence;
- `status`, `jobs`, `job`, `watch`, `history`, `latest`, verified
  `attachment` recovery, and explicit `reply` commands.
- independent Codex `exec --json` and Claude `-p --output-format stream-json` adapters;
- isolated per-attempt child homes, minimum authentication copies, safe event normalization, timeout, cancellation, and signal-aware exit handling.
- fresh permission-profile checks that replace stale child settings, force no-prompt child execution, and reject an approval UI instead of waiting unattended;
- a bounded no-progress watchdog plus a Discord channel-response deadline that creates an explicit operator handoff;
- a confirmed-acknowledgement gate that does not start model work until Discord confirms the acceptance message;
- Discord Gateway receive with durable sequence/resume state; no REST message polling;
- explicit, read-only Discord REST history lookup for one uniquely authorized
  binding, plus exact-message attachment recovery with size and SHA-256 checks;
- exact DM, guild-channel, and thread bindings with default-deny users and operator actions;
- user-systemd startup, reconnect with bounded backoff, and single-service locking;
- reboot recovery that preserves job IDs and marks interrupted work `recovery_review` without replaying private prompts or uncertain deliveries;
- scoped Discord commands: `!naia status`, `!naia jobs`, and `!naia job <id>`.

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
scripts/manage-discord-sessions.sh history --channel <channel-id> [--author <user-id>] [--limit 20] [--json]
scripts/manage-discord-sessions.sh latest --channel <channel-id> [--author <user-id>] [--json]
scripts/manage-discord-sessions.sh attachment --channel <channel-id> --message <message-id> --attachment <attachment-id> --output <absolute-path> [--expected-sha256 <hex>]
scripts/manage-discord-sessions.sh reply --channel <channel-id> --content-file <owner-only-absolute-path> [--json]
scripts/manage-discord-sessions.sh service install
scripts/manage-discord-sessions.sh service status
scripts/manage-discord-sessions.sh service restart
```

After `service install`, the same deterministic script is available on the
interactive user `PATH` as `naia`, for example `naia status`, `naia jobs
--active`, and `naia job <job-id> --events`. This is a generated launcher for
the skill script, not a separate runtime or product CLI.

Run more than one bot or persona from the same ADK with a named instance. The
default instance keeps the commands and paths above; a named instance is placed
between `naia` and the command:

```bash
naia alpha status
naia alpha jobs --active
naia alpha job <job-id> --events
naia alpha watch --job <job-id>
naia alpha service install
naia alpha service restart
```

Each instance has an independent config, SQLite ledger, Gateway resume state,
recovery key, runtime directory, lock, and systemd unit. Credentials remain in
the shared owner-only credential directory and are selected by `credentialRef`.

`watch` polls only the local SQLite event ledger. It is not Discord REST receive polling. Stop an interactive watch with `Ctrl-C`.
`history` and `latest` are explicit operator reads, never a receive loop: they
require exactly one `operatorActions` binding, the `read` role, and an optional
author already allowed by that binding. `attachment` first re-reads the exact
authorized message, accepts Discord CDN hosts only, enforces the advertised
size, and can require an expected SHA-256 before creating an owner-only file.
`reply` requires the `reply` role and exactly one operator binding. It reads an
owner-only local content file, suppresses mentions, and returns a confirmed,
failed, or unknown delivery receipt. Never automatically retry an unknown
receipt.

## Interpreting visibility

Report lifecycle and observed activity separately:

- `progressing`: a recent structured safe event exists;
- `running_no_detail`: the owned backend process is alive but exposes no detail;
- `waiting`: an explicit approval, queue, or retry wait exists;
- `suspected_stalled`: the soft silence threshold passed; it is a warning, and the configured watchdog makes one bounded intervention rather than silently preserving a running label;
- `unresponsive`: a hard deadline or objective process failure was observed;
- `unknown`: evidence is stale, missing, contradictory, or the clock moved backward;
- `not_applicable`: the job is terminal.

Recent activity does not prove that a result is correct. Show `completionAssessment` and its requirement/build/test/review checks separately. A backend's own success claim cannot verify itself.

## State and settings

The ADK workspace is the canonical location:

```text
naia-settings/messenger-sessions/config.json
naia-settings/.sessions/messenger-sessions/runtime.sqlite3

# named instance, for example "alpha"
naia-settings/messenger-sessions/instances/alpha/config.json
naia-settings/.sessions/messenger-sessions/instances/alpha/runtime.sqlite3
```

The real config and all session state are local and ignored by Git. Only `config.example.json` is tracked. Secret values never belong in config, events, status, or logs; config stores credential references only.

Put the referenced Discord token in `naia-settings/.keys/messenger-sessions/<credentialRef>` with mode `0600`. The config itself must also be mode `0600`. Choose `backend.selected` as `codex` or `claude`; no Naia Agent or Naia Shell installation is required.

Set `runtime.approvalPolicy` to `never` for unattended Discord work and change `runtime.permissionProfileEpoch` whenever the parent execution profile changes. The helper compares this profile before recovery or queued launch, discards stale command options, and creates a new child only from the current profile. A changed no-prompt profile may replace a prior guarded mutation attempt; an unchanged mutation recovery still requires review. `noProgressInterventionSeconds` bounds one owned-child abort after silence, while `operatorResponseSeconds` bounds the safe acknowledgement or an explicit `recovery_review` handoff. The child workspace must be an absolute real directory and is passed as both process cwd and Codex `--cd`; relative or ambient caller workdirs are rejected.

Guild and thread bindings default to `respondWhen: "mentioned"`. A binding may
use `respondWhen: "always"` only with `discord.messageContentIntent: true` and a
Discord application that has the Message Content privileged intent. Automated
senders and webhooks remain rejected. An accepted job does not start its model
child until the acknowledgement POST returns a confirmed Discord receipt; an
unknown or failed receipt is retried with the same Discord nonce up to four
times by the response watchdog and then fails closed instead of running
silently. Reusing the nonce prevents duplicate acknowledgement messages when a
successful POST response was lost in transit.

## Reboot and actual-work visibility

The service does not open a terminal automatically after login or reboot. A terminal window is not evidence that a background AI is healthy. Visibility comes from three durable projections:

1. `status` shows whether the service process is fresh and whether Gateway resume state exists.
2. `jobs` and `job <id> --events` show lifecycle, last safe activity, child-process ownership, delivery state, and why work is waiting or suspected stalled.
3. `completionAssessment` separately shows requirement/build/test/review evidence. Recent activity means only that the process is active; it does not prove the work is correct.

Use `watch --job <id>` for a live local event stream, or the scoped `!naia` commands in Discord. The local watch polls SQLite, not Discord. Journald contains service reason codes only; raw prompts, model stdout, final answers, secrets, commands, and local paths are not stored.

With `service.startAt=login`, recovery begins after login. With `startAt=boot`, installation enables user lingering so recovery begins at boot. Gateway and the supervisor reconnect automatically. A prompt is retained only as authenticated ciphertext protected by an owner-only local recovery key. When `recovery.autoRetry=true`, only a read-only/plan-mode job may start a new attempt under the same job ID; mutation-capable, disabled, missing, or corrupt recovery state becomes `recovery_review`. An uncertain Discord delivery also becomes `recovery_review` and is never automatically resent.

`service install` resolves the selected Codex or Claude executable from the
interactive installer `PATH`. Linux pins it in a user systemd unit. Windows
pins the native executable and Node paths in an owner-only launcher registered
as one limited ONLOGON Task Scheduler task. If local policy denies task
creation, it installs an owner-only hidden per-user Startup launcher instead;
`service status`, `start`, `stop`, `restart`, `enable`, and `disable` operate on
the verified registration actually installed. It also installs `naia.cmd` in
the interactive user path. After changing `backend.selected`, run `service
install` again rather than only restarting so the new executable is pinned.

Backend completion is fail-closed. Provider records with an absent or
`unknown` result are not promoted to success and are not delivered to Discord.

## Durable-session policy

1. Keep the lightweight Discord Gateway independent from model execution.
2. End the Codex or Claude child process after a completed turn.
3. Do not send model heartbeats merely to preserve a prompt cache.
4. Preserve jobs and recovery evidence in durable ADK state, not in a live terminal process.
5. Treat DM, guild channel, and thread bindings as separate authorization and conversation scopes.
6. Never automatically resend `delivery_unknown` after restart.

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

The deterministic suite covers persisted ordering and dedupe, Gateway commit ordering and resume state, DM/channel/thread authorization, stale-profile replacement, no-prompt approval rejection, no-progress intervention, operator-channel response SLA, explicit workspace binding, delivery nonce and unknown outcomes, reboot recovery, systemd unit isolation, activity health, safe-event rejection, trusted completion evidence, and CLI visibility.

Design authority: `docs/design/discord-session-observability.md`. Requirements: `DSO-001` through `DSO-007`.
