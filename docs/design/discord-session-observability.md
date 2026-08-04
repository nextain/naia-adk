# Discord AI Session Observability

Status: observability sub-design for [issue #18](https://github.com/nextain/naia-adk/issues/18), not the complete issue design
Scope mode: EXPANSION
Requirements: DSO-001 through DSO-013

## 1. User outcome and boundaries

After a reboot, a user must be able to tell whether the Discord session helper is running, which Codex or Claude job is active, what externally observable action happened most recently, whether the job is waiting or suspected stalled, and which checks support a completion claim.

This is not a chain-of-thought viewer. It exposes actions, bounded output activity, tool transitions, process outcomes, approvals, delivery state, and verification evidence. Provider-exposed reasoning presence may become the enum phase `planning`, but reasoning text, prompts, commands, tool results, final answers, environments, and absolute paths never enter the ledger. Missing safe detail is explicit rather than reconstructed. It must not claim that recent activity proves semantic correctness.

The owner-facing `watch --verbose` view uses the same owner-only OS-account,
`0600` config/database, and `0700` state-directory boundary as the existing
read-only ledger. It adds no Discord authorization path or observer process.
An optional `persona.shortName` supplies a safe 24-code-point display label;
otherwise the concise instance name is used. This presentation-only field is
excluded from execution and recovery authority revisions.

Core constraints:

- `naia-adk` alone owns the skill, configuration contract, helper, durable state, and operator interface.
- `naia-agent` and `naia-shell` are optional later consumers.
- Codex and Claude use the same job/event contract and remain independently removable.
- Canonical configuration and recovery state live below `naia-settings/`.
- A new product CLI or duplicate Discord skill is out of scope.
- Direct attachment to a provider terminal and a web dashboard are deferred.

The parent issue additionally owns persona/role setup and preview, Discord Gateway resume, DM/channel/thread authorization, bounded REST reconciliation, exactly-one service ownership, and legacy polling migration. Those gates remain in the issue plan and later slices; DSO requirements cover only their shared observability and recovery evidence.

`<ADK_ROOT>` is the canonical real path of the workspace containing both `.agents/` and `naia-settings/`. The skill-local script derives and validates that root before any write. The setup operation creates `<ADK_ROOT>/naia-settings/messenger-sessions/config.json` from the tracked example with mode `0600`; the helper creates `<ADK_ROOT>/naia-settings/.sessions/messenger-sessions/` with mode `0700` and its files with mode `0600`. Config schema v1 requires `workspaceId`, persona, role/approval policy, selected backend, credential reference, operator IDs, explicit DM/channel/thread bindings, timing limits, and a permission-profile epoch. `naia-agent` and `naia-shell` paths or imports are invalid in this core configuration.

## 2. Architecture and data flow

```text
Discord Gateway
      │ normalized message
      ▼
policy check ──reject──► safe rejection event
      │ accept
      ▼
SQLite transaction: job + job_accepted
      │
      ├──► Codex adapter ─┐
      └──► Claude adapter ├──► normalized safe events
                          │
                          ▼
                  append-only job_events
                          │
             ┌────────────┴─────────────┐
             ▼                          ▼
      local skill interface      Discord projection
 status/jobs/job/watch/logs   pinned status + job thread
```

The Gateway accepts an event only after its durable transaction commits. Backend output is never copied directly to Discord. An adapter emits allowlisted events and explicitly declares whether it supports structured progress, text activity only, or no activity detail.

## 3. Durable model

### 3.1 Job lifecycle and allowed transitions

| From | Allowed next states |
|---|---|
| `queued` | `running`, `cancelled`, `failed`, `recovery_review` |
| `running` | `waiting_approval`, `retry_wait`, `result_ready`, `delivering`, `failed`, `cancelled`, `recovery_review` |
| `waiting_approval` | `running`, `cancelled`, `failed`, `recovery_review` |
| `retry_wait` | `queued`, `running`, `cancelled`, `failed`, `recovery_review` |
| `result_ready` | `delivering`, `cancelled`, `failed`, `recovery_review` |
| `delivering` | `completed`, `retry_wait`, `recovery_review`, `failed` |
| `recovery_review` | `queued`, `completed`, `failed`, `cancelled` after an explicit operator or read-only reconciliation decision |
| terminal states | no further transition; retry creates a new job linked to the terminal predecessor |

An invalid transition fails closed and appends no event. A hard deadline first produces activity health `unresponsive`; the owning service then records a timeout action and a durable `failed` event. After reboot, an old PID alone is never adopted. Service and child ownership bind PID to boot ID and process-start identity observed directly by the helper; heartbeat callers cannot supply those identity fields. A reused PID therefore becomes `ownership_conflict`, not `running`, and a heartbeat within the same generation must preserve the exact owner tuple. A new generation may take over automatically only when the helper itself observes a real boot-ID boundary or the previous owner is objectively stopped/stale. Otherwise the job enters `recovery_review`.

Lifecycle says what transition is allowed. Activity health says what was recently observed. They are never collapsed into one field.

### 3.2 Activity health

| Value | Meaning | Required evidence |
|---|---|---|
| `progressing` | A recent structured progress, tool, or bounded output-activity event exists | event timestamp and reason code |
| `running_no_detail` | The child is owned and alive but the backend exposes no recent progress detail | generation/lease, process observation, and capability declaration |
| `waiting` | Approval, retry time, rate limit, or another explicit wait exists | waiting reason and target time |
| `suspected_stalled` | The soft silence threshold passed without an explicit wait | last activity and threshold |
| `unresponsive` | The hard deadline passed or child termination could not be collected | deadline or process evidence |
| `unknown` | Available evidence is missing, stale, or contradictory | missing/stale reason |
| `not_applicable` | Activity health does not apply because lifecycle is terminal | terminal event |

`suspected_stalled` is a warning, not proof of a semantic failure. The owning helper nevertheless performs one bounded watchdog intervention after the configured no-progress deadline: it records the intervention, aborts the owned child, and records a safe failure. A child that the helper cannot own is never silently retained as running. A backend that does not support structured progress must show `activityDetail: unsupported`; the helper must not invent phases from arbitrary prose.

### 3.3 Append-only event

Each job event contains:

```text
eventId, dedupeKey, jobId, attemptId, sequence, ordinal, kind, occurredAt,
source, safeSummary, metrics, redactionLevel
```

Initial event kinds:

```text
job_accepted, attempt_reserved, attempt_started, backend_ready,
phase_changed, output_activity, prompt_cache_observed, tool_started, tool_finished,
approval_required, checkpoint_saved, verification_recorded,
attempt_exited, attempt_succeeded, retry_scheduled, delivery_started,
delivery_confirmed, delivery_unknown, delivery_failed, recovered, profile_replaced,
recovery_review_required, watchdog_intervened, operator_response_sent, operator_response_missed,
cancel_requested, cancelled, completed, failed
```

`sequence` increases within one job. `ordinal` is the database-wide watch cursor. The adapter must allocate a stable `dedupeKey` and current `attemptId` before an externally caused event is appended; Codex, Claude, and fake-backend events missing either are rejected. `(jobId, dedupeKey)` is unique, so an exact retry returns the existing event even after a newer attempt starts, while a new delayed event from the old attempt is rejected. Only transaction-internal core events may receive an automatically generated key. `eventId` is a UUID and collision fails closed. Rejected ingress has no job and therefore uses a separate `IngressAuditEvent`.

The safe timeline does not accept raw prompt, stdout, stderr, command, full path, environment, or tool result fields. `safeSummary` is at most 512 normalized characters and is produced from event-kind-specific fields, not backend prose. `redactionLevel` is `metadata_only` for Discord-safe events or `local_safe` for operator-only metadata. Large or sensitive local artifacts are a later encrypted, bounded feature and are not required for the first slice.

Closed payload contract:

| Event kind | Producer | Allowed source fields |
|---|---|
| `job_accepted` | core | `jobType`: `conversation`, `issue_work`, `review`, `maintenance`, or `unknown` |
| `attempt_reserved` | core | `backend`: `codex`, `claude`, or `fake`; atomically binds the job before a process is spawned |
| `attempt_started` | core | `backend`: `codex`, `claude`, or `fake` |
| `backend_ready` | adapter | `backend`: `codex`, `claude`, or `fake` |
| `phase_changed` | adapter | `phase`: `setup`, `planning`, `reading`, `editing`, `executing`, `testing`, `reviewing`, `delivering`, or `recovering` |
| `output_activity` | adapter | non-negative integer `bytes` |
| `prompt_cache_observed` | adapter | provider-native raw integer counters: `backend`, `inputTokens`, `cacheReadInputTokens`, optional `cacheCreationInputTokens`, and `outputTokens`; absence is not inferred as zero |
| `tool_started` | adapter | `toolCategory`: `file_read`, `file_edit`, `command`, `test`, `build`, `network`, or `other`; no command/path |
| `tool_finished` | adapter | same `toolCategory` enum |
| `approval_required` | adapter | `approvalType`: `read`, `write`, `execute`, `cancel`, or `retry` |
| `checkpoint_saved` | adapter or core | `checkpointType`: `job_state` |
| `verification_recorded` | core verifier | `checkId`: safe identifier |
| `attempt_exited` | core process observer | either `{ terminationKind: exited, exitCode }` or `{ terminationKind: signaled, signal }`; signal is a platform-reported Node.js OS signal name |
| `attempt_succeeded` | core | empty payload; structured provider success plus exit code 0 was observed, and the result is ready for delivery |
| `retry_scheduled` | core | non-negative integer `delayMs` |
| `delivery_started` | core | empty payload |
| `delivery_confirmed` | core | empty payload |
| `delivery_unknown` | core | empty payload |
| `delivery_failed` | core | `reasonCode`; terminal only for delivery, not for work |
| `recovered` | core | `recoveryAction`: `resume`, `safe_retry`, or `manual_review` |
| `profile_replaced` | core | empty; historical child settings were rejected before launch |
| `recovery_review_required` | core | empty; recovered work needs a fresh operator request |
| `cancel_requested` | core | empty payload |
| `watchdog_intervened` | core | `watchdogReason`: `no_progress`; Discord delivery never owns worker lifecycle |
| `operator_response_sent` | core | empty; safe Discord acknowledgement was delivered |
| `operator_response_missed` | core | empty; the accepted job's own acknowledgement timer expired before confirmation; it never changes worker lifecycle |
| `cancelled` | core | empty payload |
| `completed` | core | empty payload |
| `failed` | core | `reasonCode`: `timeout`, `process_exit`, `authorization`, `delivery_unknown`, `no_progress_timeout`, `approval_ui_detected`, `context_changed_restart_required`, or `internal_error`; delivery has an independent state |

Unknown keys are rejected. Enum fields accept only the values listed above. `checkId` and verifier IDs use `[A-Za-z0-9_.:-]{1,64}` and additionally reject secret-like patterns. Persisted metrics allow only `bytes`, `count`, `durationMs`, `exitCode`, `passed`, `failed`, `missing`, `total`, `queuePosition`, `inputTokens`, `cachedInputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, and `outputTokens`; values are booleans or non-negative safe integers. An optional artifact digest is local-only and must be `sha256:` followed by exactly 64 lowercase hexadecimal characters. An encoded payload above 2 KiB is rejected before formatting.

The producer column is enforced, not descriptive. In particular, a backend cannot append lifecycle-authoritative `completed`, `failed`, or delivery events. Its success statement is stored only as `backend_claim` evidence; the helper owns lifecycle transitions after observing process and verification evidence.

Attempt ownership is also enforced. Once a new attempt becomes current, delayed events or evidence from an older attempt are rejected and cannot overwrite the job snapshot. A `delivery_unknown` record affects only the delivery projection and never changes a conversation or worker lifecycle. Ambiguous content is not automatically resent.

### 3.4 Snapshot and freshness

Default timing is a 10-second helper heartbeat, stale after 30 seconds, and a 120-second soft-silence warning. `noProgressInterventionSeconds` is at least the soft-silence threshold and bounds one owned-child abort. Immediately after durable admission, each job arms one in-process `operatorResponseSeconds` timer and races it against its single acknowledgement attempt. This is neither Discord polling nor the 60-second external supervisor: the first outcome records exactly one `operator_response_sent` or `operator_response_missed`, and neither outcome gates worker launch. A job-specific hard deadline is fixed at acceptance. In-process durations use a monotonic clock; persisted UTC timestamps support restart continuity. Wall-clock rollback or contradictory time evidence produces `unknown/clock_evidence_invalid`.

Every launch derives an execution profile from `permissionProfileEpoch`, authorization mode, backend, and access level. The child receives `approvalPolicy=never`: Codex receives an explicit `approval_policy="never"` override and Claude receives its noninteractive mode. A queued in-process item is re-derived immediately before launch; a mismatch records `profile_replaced` and uses the current profile. A recovery envelope is evidence only and never supplies command options. Automatic recovery requires an exact schema-v2 participant, binding, configuration, context, and read-only profile match; any mismatch or mutation-capable recovery becomes `recovery_review` and needs a fresh request. Approval requests are detected from bounded stdout and stderr chunks as well as structured events, then terminated as `approval_ui_detected`; they are never held in a hidden UI.

`activityHealth` is `{ value, reasonCode, observedAt, evidenceAt }`. `activityDetail` is exactly `structured`, `text_activity`, or `unsupported`.

`JobSnapshotV1` contains:

```text
jobId, attemptId, lifecycle, activityHealth,
backendId, backendCapabilities, activityDetail,
acceptedAt, startedAt, updatedAt, lastProgressAt,
silenceDurationMs, softSilenceThresholdMs, hardDeadlineAt,
currentActivity, waitingReason, retryAt, queuePosition,
childState, deliveryState, recoveryState, latestSafeError,
completionAssessment, allowedActions
```

`ServiceStatusV1` contains:

```text
owner, bootId, generation, restartCount,
serviceState, serviceReasonCode, heartbeatAt, heartbeatAgeMs,
gateway { state, heartbeatAckAt, heartbeatAckAgeMs, resumeCount, reconnectCount },
effectivePolicy { persona, role, backend, bindings },
backendReadiness, queueDepth, oldestQueuedAgeMs,
lastReceivedAt, lastAcceptedAt, lastCompletedAt, lastFailedAt,
projectionUpdatedAt, projectionGeneration, projectionFreshness
```

Service status cross-checks in fail-closed precedence:

1. explicit systemd inactive or missing owned process means `stopped`;
2. lock owner, boot ID, or generation conflict means `degraded/ownership_conflict`;
3. heartbeat older than 30 seconds means `stale`;
4. unavailable systemd is `unsupported`, not failure, if lock/generation/process/heartbeat evidence agrees;
5. Gateway and backend readiness remain separate from helper service health;
6. missing or contradictory evidence means `unknown`, never `running`.

A JSON projection is a cache, never the authority. It is written using a private temporary file, flush, and atomic rename. A stale projection is displayed as stale even if its last value said `running`.

## 4. Operator surfaces

The existing skill owns one deterministic script:

```text
manage-discord-sessions.sh status [--json]
manage-discord-sessions.sh jobs [--active|--failed] [--json]
manage-discord-sessions.sh job <job-id> [--events] [--json]
manage-discord-sessions.sh watch [--job <job-id>] [--verbose|--jsonl]
manage-discord-sessions.sh history --channel <channel-id> [--author <user-id>] [--limit 20] [--json]
manage-discord-sessions.sh latest --channel <channel-id> [--author <user-id>] [--json]
manage-discord-sessions.sh attachment --channel <channel-id> --message <message-id> --attachment <attachment-id> --output <absolute-path> [--expected-sha256 <hex>]
manage-discord-sessions.sh reply --channel <channel-id> --content-file <owner-only-absolute-path> [--json]
manage-discord-sessions.sh cancel <job-id>
manage-discord-sessions.sh retry <job-id> [--confirm-delivery-risk]
```

The first implementation slice provides `status`, `jobs`, `job`, and `watch` over a local fake backend. `logs` is deferred until a bounded encrypted artifact contract exists. Control commands arrive only with the service state machine because a file-only command that cannot reach a running child would imply false control.

JSON output has an independent contract version (`schemaVersion: 1`); it does not inherit the internal SQLite migration version. Success exits 0, invalid arguments or unknown jobs exit 2, unavailable/corrupt/newer state exits 3, and internal failures exit 1. Empty `jobs` is a successful empty array. `watch` emits existing events once from ordinal 0, then resumes strictly after the last emitted ordinal at a 500 ms local interval; each ordinal appears at most once per process. Default human watch output remains unchanged. JSONL preserves the complete event and job identity and adds explicit stable instance and bounded profile metadata. Verbose human output uses a short `앞8~뒤4` job reference accepted by `job <reference>` and ledger-derived elapsed time; ambiguous references fail closed. It formats only allowlisted phase, tool, lifecycle, blocker, and verification evidence. `--verbose` and `--jsonl` are mutually exclusive.

`history` and `latest` are explicit operator reads, not a receive loop. They
require the `read` role and exactly one operator-enabled binding for the target,
filter to its allowlisted non-bot authors, sanitize the bounded response, and
persist none of the message content. Attachment recovery first authorizes and
re-reads the exact message, accepts only Discord CDN hosts, verifies metadata
size and an optional expected SHA-256, and creates an owner-only local file.
Explicit reply requires the `reply` role and one exact operator binding. It
reads an owner-only content file, disables mentions, and never retries an
unknown delivery receipt automatically.
Windows owner-only state uses native ACL verification; its service launcher is
registered as one limited ONLOGON Task Scheduler task rather than systemd. If
machine policy denies task creation, installation uses one owner-only hidden
per-user Startup launcher. Service control first validates the installed task
XML or exact Startup launcher bytes and process ownership; both registrations
must never coexist. An `unknown` provider completion marker is not success and
cannot produce a Discord result delivery.

Linux systemd uses nested `/usr/bin/flock --no-fork --nonblock` invocations for
the shared bot-token identity and named-instance identity. These are kernel
advisory locks held for the service process lifetime and released by the kernel
on exit or crash. The token lock lives under the systemd user-manager runtime
directory, so `PrivateTmp=yes` does not create a second ownership namespace.

Discord provides two allowlisted projections. Before Slice 3, `config.json` must name operator Discord user IDs and conversation bindings. Default is deny: a participant can query only a matching DM/channel/thread binding, and only an operator can cancel, retry, or inspect cross-job metadata.

- a pinned operator status message updated on meaningful transitions;
- an optional job thread containing safe event summaries.

It does not post periodic “still alive” spam. After reboot it posts one recovery summary. A conversation participant may see only that conversation. Configured operators may see redacted cross-job metadata, never raw user content or full local paths.

For each accepted conversation, the helper makes one best-effort safe
acknowledgement attempt under that job's own timer and records its delivery state
independently. A missed acknowledgement never gates worker launch or later
messages, and transport failure cannot abort model work. DSO-008 is withdrawn:
the production coordinator runtime and activation branch are removed. Only the
compatibility table and quarantine of pre-withdrawal recovery envelopes remain;
new requests use the direct bounded execution path.

## 5. Completion evidence

Activity and correctness are separate:

```text
backend claim: completed
required checks: 4
passed: 3
failed: 0
missing: 1
assessment: partial
```

The host fixes a unique required-check set before backend execution. Evidence kinds initially include `requirement`, `build`, `test`, and `review`. Each record has `checkId`, attempt/revision, generated safe label, required flag, result (`passed|failed|missing`), producer (`host_verifier|backend_claim|human_review`), verifier identity/version, observed time, and optional bounded artifact digest/metrics. Only `host_verifier` or `human_review` evidence for the current attempt and revision may satisfy required checks; backend claims remain visible but untrusted. A new attempt or source revision marks prior required evidence stale unless the predeclared check explicitly allows reuse.

Assessment values are `unverified`, `partial`, `failed`, and `verified`. No required checks means `unverified`; any required failure means `failed`; any required missing/stale check means `partial`; every required trusted check passing for the current revision means `verified`. Optional failures remain visible but do not change the required-check assessment. `job --json` returns every check individually.

## 6. Privacy and process isolation

- Safe summaries are event-kind-specific allowlisted data, not arbitrary output with best-effort regex masking. Unknown payload and metric keys are rejected.
- Job metadata is also closed: backend is `codex`, `claude`, or `fake`; revision and IDs use the safe-identifier contract; capabilities are booleans limited to `structuredProgress`, `textActivity`, `cancellation`, and `checkpointResume`.
- Local operator and Discord projections are separate functions and authorization paths.
- AI children receive only `PATH`, locale/terminal values, isolated XDG/TMP paths, the validated absolute workspace path, and the one adapter-declared provider credential when needed. Relative paths are rejected. The helper binds that exact path as both process `cwd` and Codex `--cd`, so an outer tool's ambient workdir cannot redirect the child. `HOME` points to a new mode-`0700` attempt directory under the user runtime directory, never the user's actual home or `naia-settings`. The source and destination authentication files are owner-only real files; the destination is created with no-follow/exclusive semantics and removed when the attempt ends. If a client cannot authenticate under that restriction, the backend is `not_ready`. Discord credentials, `CREDENTIALS_DIRECTORY`, systemd credential paths, and service-only file descriptors are removed.
- Unauthorized messages retain only deduplication metadata and rejection reason.
- State directories are `0700`; the database, WAL, and shared-memory sidecars are `0600`; symbolic-link and owner checks precede writes. SQLite opens under a restrictive creation mask and sidecar permissions are rechecked after transactions.
- `safeSummary` is 512 characters; an encoded typed payload is at most 2 KiB; metrics use the closed list above; `output_activity` is coalesced to one safe event per UTC second bucket per attempt. Oversized or unknown input is rejected before SQLite. Retention and encrypted raw artifacts must be fixed before Slice 2 stores resumable message payloads.
- Normal Discord receive uses Gateway events; local `watch` polling of SQLite is not Discord REST polling.

## 7. Delivery sequence and verification

### Slice 1 — observable core

- SQLite job/event/evidence schema
- lifecycle/activity projection
- safe-summary validation
- `status`, `jobs`, `job`, `watch`
- fake clock and fake backend events

Verification: deterministic Node tests for fresh/stale service, lifecycle/health separation, secret rejection, unverified completion, event ordering, and persisted query after reopen.

| Method/step | Failure mode | Recovery action | User visible? |
|---|---|---|:---:|
| SQLite open/migrate | corrupt or newer schema | fail closed; preserve file; report recovery path | YES |
| append event | partial write or duplicate sequence | one transaction; unique constraints; retry only before commit result | YES |
| status projection | stale heartbeat | show `unknown/stale`, never reuse healthy value | YES |
| watch | terminal disappears | reconnect to DB and resume strictly after the last global `ordinal` | NO |

### Slice 2 — backend adapters

Codex, Claude, and fake adapters map capabilities and process outcomes into the same event contract. Child environment isolation is tested.

The supported floor is Codex CLI `0.146.0` and Claude Code `2.1.220`; an older
or unparseable version is `not_ready`. Each model turn is isolated; Codex and
Claude session identities are not continuity sources. A schema-v2 recovery
envelope contains only the bounded current request plus exact participant,
binding, configuration, execution-profile, and deterministic-context evidence.
It is owner-only authenticated ciphertext. Raw worker stdout/stderr/tool payload
retention remains `none`. Reboot recovery starts a new read-only attempt only
when all evidence still matches; pre-withdrawal coordinator envelopes and every
mutation-capable or ambiguous envelope are quarantined as `recovery_review`.
A structured worker success marker plus process exit 0 produces
`attempt_succeeded` and lifecycle `result_ready`. Only the Gateway may then
record real delivery events; a worker never fabricates `delivery_confirmed`.

Verification: each real adapter contract, each-backend-removal test, no-prompt approval rejection from structured, stderr, and no-newline streams, explicit absolute workspace binding, cancellation/timeout/process-kill matrix.

### Slice 3 — Discord Gateway and projections

Gateway resume, DM/channel/thread scope separation, pinned status, job threads, redacted commands, delivery ambiguity, and single-credential ownership.

Verification: fake Discord Gateway plus real test bot; normal REST receive polling count is zero.

### Slice 4 — user service and reboot

Workspace-hashed user service, encrypted credential resolution, login/linger distinction, recovery timeline, and one recovery notice.

Inbound idempotency uses `adapter + scope + sourceMessageId`. Delivery allocates a durable `deliveryKey` and at-most-25-character nonce before send, then sends with Discord `enforce_nonce=true` and associates the returned Discord message ID. Timeout after send but before receipt persistence becomes `delivery_unknown`. Restart reads at most 100 recent messages from the exact stored channel after the persisted pre-send high-water mark and matches bot author ID plus nonce. A match becomes delivered; no match remains unknown because absence is not proof of non-delivery. Restart never auto-resends. A recovery notice has a unique `(bootId, generation)` key and is posted at most once.

Verification: actual reboot with the same job ID, new attempt ID, recovered event, exactly one helper/credential owner, Gateway resume or explicit fresh connection, one recovery notice, and zero automatic resend of `delivery_unknown`.

### Slice 5 — polling migration and reversible cutover

Legacy high-water marks become observations rather than completion receipts.
Failed or unreceipted messages become review candidates. The 60-second
read-only supervisor is health evidence, not a response scheduler; admission
uses the per-job ACK timer described above.
The watchdog and supervisor project at most 256 nonterminal jobs, oldest first,
and use aggregate counts for the active total and historical attention. An
active overflow is an explicit `operational_jobs_truncated` unhealthy result,
not silent loss or an invitation to scan unbounded history.

All cutover control comes from one absolute CLI path in a separate clean
candidate checkout, including recovery:

```text
node /absolute/candidate/.../helper/cli.mjs --adk-root /absolute/target --instance <instance> cutover prepare
node /absolute/candidate/.../helper/cli.mjs --adk-root /absolute/target --instance <instance> cutover verify
node /absolute/candidate/.../helper/cli.mjs --adk-root /absolute/target --instance <instance> cutover canary --job <job-id>
node /absolute/candidate/.../helper/cli.mjs --adk-root /absolute/target --instance <instance> cutover rollback
```

Prepare requires clean, distinct candidate and target Discord runtime trees and
creates an owner-only bundle containing the prior executable runtime, config,
versioned service/supervisor units, source/tree identity, byte digests, and
database compatibility plus a receipt from the copied source runtime's actual
config loader. Managed service and supervisor launches require complete
artifact markers before config reads or token ownership, and an existing
registration cannot be overwritten without the verified cutover binding.
Windows has no versioned cutover yet, so first install rejects either a main
service or supervisor registration before creating any launcher.
The first conversion from the skill's legacy mutable units is allowed only
after exact unit-byte, executable, credential, registration-state, live-owner,
and idle-ledger verification; its source hashes are rebound before install.
Verify re-hashes every artifact. Canary is fail-closed:
`continue` requires a verified bundle, exact installed unit bytes, enabled and
active Linux service/timer registrations, fresh healthy supervisor/service/Gateway,
one exact service generation across job acceptance, execution, current owner,
and supervisor evidence, and a real router-admitted schema-v2 read-only job
whose instance, agent/workspace, context, participant-authority, config, and
access evidence exactly recomputes on the host before confirmed ACK and delivery;
missing, fabricated, malformed, stale, nonterminal, recovery-review, approval-UI, or
unconfirmed evidence is `stop`. Rollback re-verifies before mutation, stops the
service, requires an idle ledger, revalidates the config with the copied source
loader, restores config and versioned units, and then
restarts. Any failed phase prevents later phases. The durable database is
preserved and is never rewritten by rollback.

Historical attention is reported but does not veto a healthy current canary.
`service status`, `stop`, and `disable` remain available when candidate config
is malformed. Managed copies are retained for recovery until the explicit
`artifacts prune` command re-verifies them as unreferenced; installed and active
rollback artifacts are always retained.

Verification: shadow comparison, one sender, strict canary stop matrix, bundle
tamper tests, rollback callback-failure ordering, and ledger preservation.

## 8. Alternatives rejected

- Auto-open a Codex or Claude terminal after reboot: provider-specific, unavailable on headless hosts, and not a durable source of truth.
- Keep each backend inside a permanent terminal multiplexer: useful for manual debugging but couples recovery to a terminal process and retains costly or stale model state.
- Start with a web dashboard: duplicates the future Shell surface and delays the ADK-only contract.
- Copy raw backend output to Discord: leaks sensitive data and mistakes prose for structured progress.
- Infer correctness from recent output: activity is not verification.

## 9. Adversarial pre-mortem

1. **The dashboard says running after the helper died.** Mitigation: freshness is computed from systemd/lock/heartbeat/process evidence, not the last JSON value.
2. **A tool output leaks a token into Discord.** Mitigation: allowlisted event fields and separate remote projection; raw output is not accepted by the safe ledger.
3. **A quiet but valid long task is killed as stalled.** Mitigation: soft silence produces `suspected_stalled`; only hard deadlines or objective process failure produce terminal failure.

## 10. Decisions required before their owning slice

- Minimum supported Codex and Claude versions and their structured-output capability matrix
- Before Slice 3: exact Discord command registration and operator authorization bootstrap
- Whether direct read-only terminal attachment is worth the additional PTY proxy surface
