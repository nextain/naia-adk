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
- a best-effort immediate acknowledgement that never gates accepted model work;
- Discord Gateway receive with durable sequence/resume state; no REST message polling;
- explicit, read-only Discord REST history lookup for one uniquely authorized
  binding, plus exact-message attachment recovery with size and SHA-256 checks;
- exact DM, guild-channel, and thread bindings with default-deny users, configured participant profiles, and operator actions;
- schema-v2 project binding that snapshots a bounded mandatory context prefix at service start, verifies it again before every backend spawn, and runs the child in that exact project directory;
- one process-lifetime token-owner lock shared by named instances under the same OS user on one host, preventing two local Gateways from using the same bot token;
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
scripts/manage-discord-sessions.sh health-check [--json]
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
recovery key, runtime directory, instance lock, and service registration.
Credentials remain in the shared owner-only credential directory and are
selected by `credentialRef`. Managed Linux units derive one kernel-lock name
from the credential bytes, so the same token reaches the same lock across bot-ID
configuration mistakes and ADK roots. The service verifies that fingerprint
again after loading the credential and rejects a mismatched READY bot identity.
Every launch also acquires the same fail-closed owner-record lock, so managed,
direct, and Windows launches cannot split token ownership. A complete record
from this host and boot is atomically quarantined and reclaimed only when its
recorded PID is objectively absent. Incomplete records, identity conflicts,
permission-denied process checks, and PID reuse remain fail-closed. The default
non-XDG Unix `/tmp` fallback uses a boot-scoped directory, so an owner record
from a completed boot cannot permanently obstruct the next boot. Explicitly
configured shared directories and same-directory records from another boot or
host remain fail-closed.

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

Put the referenced Discord token in `naia-settings/.keys/messenger-sessions/<credentialRef>` with mode `0600`. The config itself must also be mode `0600`. Choose `backend.selected` as `codex` or `claude`; no Naia Agent or Naia Shell installation is required. Make that selection before the first `service install` for an unregistered instance. For an existing registration, changing `backend.selected` is a managed runtime change and must use the verified candidate cutover procedure below; do not overwrite it with an ordinary `service install` or restart.

The real config must set `runtime.approvalPolicy` explicitly to `never`;
`managed`, omission, and every other value are rejected because nobody is
available to click an unattended approval prompt. Change
`runtime.permissionProfileEpoch` whenever the parent execution profile changes.
Actions listed in `role.requiresApproval` are removed from the effective
unattended action set, so `allowedActions` cannot silently grant mutation access
that still requires approval. The helper compares the execution profile before
recovery or queued launch and creates a new child only from the current profile.
Legacy recovery envelopes without complete participant authority evidence always
become `recovery_review`; schema-v2 recovery requires an exact authority,
binding, configuration, context, and managed runtime-revision match and remains
read-only. The encrypted recovery envelope persists only the bounded current
request and binding digests, not the assembled project context prompt; an
eligible retry reconstructs that prompt from the current verified context
snapshot. Model-produced requests to send a separate Discord DM are rejected;
replies stay in the current bound conversation.

`noProgressInterventionSeconds` bounds one owned-child abort after silence. Each
accepted job arms its own `operatorResponseSeconds` acknowledgement timer
immediately after durable admission; it does not wait for the 60-second
supervisor or poll Discord. A durable sent-or-missed ACK is never repeated during
recovery. The acknowledgement is best-effort telemetry and never gates work.
Shutdown aborts and settles outstanding ACK/control/status-projection sends
before draining the Gateway, including PATCH and pin requests; a late send,
fallback, persistence update, or pin cannot escape service ownership. Backend
leader exit and inherited stream drain are bounded separately so descendants
cannot hold shutdown open. The production conversation-coordinator runtime,
activation branch, and new-database table creation are removed. Any
`runtime.conversationCoordinator` key is unsupported; pre-withdrawal recovery
envelopes are only quarantined, existing legacy database tables are left
untouched, and direct bounded execution is the supported path.

Use schema v2 for every new or migrated instance. `workspace.path` is relative to
the ADK root and names the child working directory; `workspace.entrypoint` plus
`workspace.contextFiles` are bounded, non-symlink project files read once into a
deterministic stable prompt prefix. The same files are hashed again immediately
before every child spawn. A change requires a service restart and the job fails
closed. Codex project-document loading and Claude customization loading are
disabled for child runs, so unhashed `AGENTS.md`/`CLAUDE.md` discovery cannot
bypass the explicit prefix. Provider tool descriptions and explicitly invoked
capability skills are not part of this context hash and cannot expand the
configured action profile. The workspace is passed as both process cwd and
Codex `--cd`.

`discord.participantProfiles` must exactly cover the union of every binding's
`allowedUserIds`. Profiles use configured labels and relationships; Discord
guild role claims never grant authority. Every schema-v2 participant must also
be listed in `operatorUserIds`, meaning they are trusted at the same level as
the host OS user. Participant profiles are conversation context and action
limits, not filesystem tenant isolation: Codex read-only and Claude plan mode do
not confine reads to one workspace. Effective actions are the intersection
of global unattended actions and the current participant profile. Schema v2
grants `read` and `reply` together. Mutation is one deliberately coarse
`write`+`execute` bundle and additionally requires both membership in
`operatorUserIds` and `binding.operatorActions: true`; asymmetric mutation
configurations are rejected. Claude instances are read/reply only until an
unattended mutation canary proves a stronger CLI contract. Every schema-v2 binding explicitly chooses
`historyVisibility`: `none`, `requester_only`, or `shared`. Requester-only
history excludes other people and all earlier bot replies; shared history is an
explicit opt-in and labels only configured participants.

Guild and thread bindings default to `respondWhen: "mentioned"`. A binding may
use `respondWhen: "always"` only with `discord.messageContentIntent: true` and a
Discord application that has the Message Content privileged intent. Automated
senders and webhooks remain rejected. Gateway admission persists first and
returns without waiting for a model turn or Discord REST response. A failed or
missed acknowledgement is recorded once by that job's deadline but does not
cancel the accepted turn. It is independent of the supervisor schedule. A failed or
unknown final delivery is reported separately from completed worker execution.
Ambiguous deliveries are never automatically resent.

## Reboot and actual-work visibility

The service does not open a terminal automatically after login or reboot. A terminal window is not evidence that a background AI is healthy. Visibility comes from three durable projections:

1. `status` shows whether the service process is fresh and whether Gateway resume state exists.
2. `jobs` and `job <id> --events` show lifecycle, last safe activity, child-process ownership, delivery state, and why work is waiting or suspected stalled.
3. `completionAssessment` separately shows requirement/build/test/review evidence. Recent activity means only that the process is active; it does not prove the work is correct.

Use `watch --job <id>` for a live local event stream, or the scoped `!naia` commands in Discord. The local watch polls SQLite, not Discord. Journald contains service reason codes only; raw prompts, model stdout, final answers, secrets, commands, and local paths are not stored.

With `service.startAt=login`, recovery begins after login. With `startAt=boot`, installation enables user lingering so recovery begins at boot. Gateway and the supervisor reconnect automatically. Only the bounded current request and binding digests are retained as authenticated ciphertext protected by an owner-only local recovery key; the assembled context prompt is reconstructed from current verified files. Legacy envelopes always become `recovery_review`. When schema-v2 `recovery.autoRetry=true`, only a read-only job with an exact participant, binding, configuration, context, and managed runtime-revision match may start a new attempt under the same job ID; mutation-capable, disabled, changed, missing, or corrupt recovery state becomes `recovery_review`. An uncertain Discord delivery also becomes `recovery_review` and is never automatically resent.

`service install` resolves the selected Codex or Claude executable from the
interactive installer `PATH`. Linux materializes an owner-only Git runtime
artifact, verifies its revision, runtime-tree ID, digest, and unit bytes, and
pins both service and supervisor to that copy; restart never executes a changed
target checkout under the old revision label. Windows
pins the native executable and Node paths in an owner-only launcher registered
as one limited ONLOGON Task Scheduler task. If local policy denies task
creation, it installs an owner-only hidden per-user Startup launcher instead;
`service status`, `start`, `stop`, `restart`, `enable`, and `disable` operate on
the verified registration actually installed. It also installs `naia.cmd` in
the interactive user path. For an existing registration, a
`backend.selected` change must go through the verified candidate cutover path
below; an ordinary `service install` or restart is not an upgrade path.
The independent supervisor is stricter: Linux requires its separate timer and
Windows requires a verified least-privilege one-minute Task Scheduler task.
Supervisor registration is verified before the main service starts; failure
quarantines both the main registration and supervisor timer rather than leaving
either half of a partial pair active.
`service status` verifies both identities.

The watchdog and independent supervisor read at most 256 nonterminal jobs,
oldest first, on their hot paths and use aggregate counts plus partial indexes
for active totals and the two historical review/delivery attention counts. If
more than 256 jobs are active, the omitted count is explicit and unattended
health is fail-closed as `operational_jobs_truncated`.
`jobs` is paged to 100 records by default; use `jobs --limit <1-1000>` for an
explicit bounded operator page. Durable history is not scanned every second.

Linux systemd launches the service through nested `/usr/bin/flock` calls: one
kernel advisory lock derived from the token fingerprint in the shared user-manager runtime
directory (`%t`), then one for the named instance. These locks are held for the
service process lifetime and the kernel releases them on exit or crash;
`PrivateTmp=yes` therefore cannot split same-token ownership between named
services. Managed Linux validates the unit-provided fingerprint and then
acquires the same owner-record lock used by direct and Windows paths. A
kernel-lock conflict exits in the outer launcher with code 78 before
the service can write a reason file, so the supervisor reports the service as
stopped and journald carries the bounded exit status. Failures reached inside
the service use bounded reason codes in journald and `supervisor-status.json`.

Before changing code, config schema, or units, create and verify an owner-only
rollback bundle from a separate, clean candidate checkout while the target is
still on the prior revision. The installed old CLI cannot bootstrap or safely
control a command it does not yet contain. Resolve one absolute candidate
`cli.mjs` path and use that same file for every phase:

```bash
node /absolute/candidate/.agents/skills/manage-discord-sessions/helper/cli.mjs \
  --adk-root /absolute/target --instance <instance> cutover prepare
node /absolute/candidate/.agents/skills/manage-discord-sessions/helper/cli.mjs \
  --adk-root /absolute/target --instance <instance> cutover verify
node /absolute/candidate/.agents/skills/manage-discord-sessions/helper/cli.mjs \
  --adk-root /absolute/target --instance <instance> cutover canary --job <job-id>
node /absolute/candidate/.agents/skills/manage-discord-sessions/helper/cli.mjs \
  --adk-root /absolute/target --instance <instance> cutover rollback
```

The first managed cutover may adopt the exact legacy mutable registration
created by this skill. Prepare verifies its three unit files, canonical Node and
backend executables, credential-derived token, registration state, owned live
process when active, and idle ledger, then binds the legacy unit digests before
replacement. Arbitrary or partially matching legacy units fail closed.

Both candidate and target Discord runtime trees must be clean and at different
commits. The manifest binds the prior commit, its Git runtime-tree ID, copied
runtime digest, config, a receipt from the materialized source runtime's actual
config loader, service/supervisor units, database compatibility, and canary
stop criteria. Marker-free or partial-marker systemd launches fail before
configuration reads, token ownership, or observation; explicit direct launch
remains separate. `service install` cannot replace an existing registration
unless the active rollback bundle, installed source, deployed candidate, and
clean candidate controller all verify. Verify before changing the target and
again before relying on rollback. Canary is fail-closed: `continue` requires the verified active
bundle; exact installed service/supervisor/timer bytes; enabled and active
Linux service and timer registrations; a fresh independent supervisor reporting
healthy service and Gateway; exact equality between the job acceptance,
execution, current service, and supervisor generations; and the named
schema-v2 read-only job to carry exact host-recomputed instance, agent,
workspace, context, participant-authority, config, and access evidence and be terminal-completed with both
acknowledgement and final delivery confirmed. Missing, stale, malformed,
nonterminal, recovery-review, approval-UI, or unconfirmed evidence returns
`stop`. A stop verdict requires rollback through the candidate CLI. Rollback
re-verifies the bundle before mutation, then stops the service and refuses to
hand the database to the prior runtime while any job is nonterminal. It restores
the prior config and versioned service/supervisor units before restart; a failed
phase aborts all later phases. Do not cut over if any verification fails.
Windows versioned rollback is not supported.

Managed runtime copies and rollback bundles are retained for manual recovery.
Inspect them with `naia <instance> artifacts list`; after confirming the active
registration and rollback pointer, remove only re-verified unreferenced copies
with `naia <instance> artifacts prune`. The installed runtime, active rollback
bundle, invalid artifacts, and legacy or ambiguous registrations are never
pruned. Install, cutover prepare, rollback, and prune share one per-instance
Linux kernel lock that releases with its helper process, so prune cannot race an
artifact into active use and no stale owner record needs reclamation.
A failed install removes its new artifact only when no installed unit references
it. Linux `service.autoStart=false` explicitly stops and disables the service.
Until versioned Windows cutover exists, Windows install is first-install only:
an existing main-service or supervisor registration is rejected before any
launcher is created, and `autoStart=false` publishes only a disabled Startup
fallback rather than a runnable main task. Windows stop, disable,
restart, and quarantine use one verified fail-closed containment transition.
Historical attention remains visible
but does not by itself veto a later healthy canary. Candidate config is not parsed before `service status`,
`stop`, or `disable`, so containment remains available when that config is bad.

Backend completion is fail-closed. Provider records with an absent or
`unknown` result are not promoted to success and are not delivered to Discord.

## Durable-session policy

1. Keep the lightweight Discord Gateway independent from model execution.
2. End the Codex or Claude child process after a completed turn.
3. Do not send model heartbeats merely to preserve a prompt cache.
4. Preserve jobs and recovery evidence in durable ADK state, not in a live terminal process.
5. Treat DM, guild channel, and thread bindings as separate authorization and conversation scopes.
6. Never automatically resend `delivery_unknown` after restart.

Each provider call remains ephemeral and receives a new isolated child home.
Cacheability comes only from the byte-identical deterministic prefix at the
start of the prompt, not from retaining a model session. When a provider reports
input-token cache usage, the ledger records bounded raw counters as
`prompt_cache_observed`. `input`, `cache-read`, and Claude `cache-created` are
independent provider fields; the ledger does not present one as a subset of
another or infer a total. If the provider reports no complete cache receipt, cache benefit
is `not proven`; do not infer it from latency or the existence of a context hash.

## Continuous monitoring contract

When the user explicitly assigns periodic or continuous Discord monitoring:

1. Never represent polling performed inside an interactive AI turn as durable monitoring. A turn, context window, or delegated agent can end without notice to Discord.
2. Install the Discord service and its independent deterministic supervisor. The supervisor runs every 60 seconds outside both the model turn and Discord process, reads SQLite without writing it, and atomically updates only `supervisor-status.json`.
3. Use `health-check --json` or the supervisor snapshot to distinguish stopped/stale service, overdue active work, historical attention, and unknown Gateway evidence. A fresh process heartbeat alone is not proof that accepted work is healthy.
4. The supervisor never sends, replays, restarts, mutates the ledger, or claims continuous curation. Recovery remains an explicit operator action except for the service manager's existing process restart policy.
5. Collaboration subagents are outside this harness and have no receipt interface. Status reports `foreignAgentSupervision=unsupported`; reconcile their actual lifecycle directly before describing them as active or relying on their output.

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

The deterministic suite covers persisted ordering and dedupe, Gateway commit ordering and resume state, DM/channel/thread authorization, participant-bound action intersection, isolated history modes, deterministic context drift, provider-native instruction disabling, token-owner races and fail-closed abnormal owners, cache receipts, legacy-profile quarantine, no-prompt approval rejection, no-progress intervention, operator-channel response telemetry, explicit workspace binding, delivery nonce and unknown outcomes, reboot recovery, systemd unit isolation, activity health, safe-event rejection, trusted completion evidence, rollback failure paths, and CLI visibility.

Design authority: `docs/design/discord-session-observability.md`. Requirements: `DSO-001` through `DSO-012`.
