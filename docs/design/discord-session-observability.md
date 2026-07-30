# Discord AI Session Observability

Status: observability sub-design for [issue #18](https://github.com/nextain/naia-adk/issues/18), not the complete issue design  
Scope mode: EXPANSION  
Requirements: DSO-001 through DSO-006

## 1. User outcome and boundaries

After a reboot, a user must be able to tell whether the Discord session helper is running, which Codex or Claude job is active, what externally observable action happened most recently, whether the job is waiting or suspected stalled, and which checks support a completion claim.

This is not a chain-of-thought viewer. It exposes actions, bounded output activity, tool transitions, process outcomes, approvals, delivery state, and verification evidence. It must not claim that recent activity proves semantic correctness.

Core constraints:

- `naia-adk` alone owns the skill, configuration contract, helper, durable state, and operator interface.
- `naia-agent` and `naia-shell` are optional later consumers.
- Codex and Claude use the same job/event contract and remain independently removable.
- Canonical configuration and recovery state live below `naia-settings/`.
- A new product CLI or duplicate Discord skill is out of scope.
- Direct attachment to a provider terminal and a web dashboard are deferred.

The parent issue additionally owns persona/role setup and preview, Discord Gateway resume, DM/channel/thread authorization, bounded REST reconciliation, exactly-one service ownership, and legacy polling migration. Those gates remain in the issue plan and later slices; DSO requirements cover only their shared observability and recovery evidence.

`<ADK_ROOT>` is the canonical real path of the workspace containing both `.agents/` and `naia-settings/`. The skill-local script derives and validates that root before any write. The setup operation creates `<ADK_ROOT>/naia-settings/messenger-sessions/config.json` from the tracked example with mode `0600`; the helper creates `<ADK_ROOT>/naia-settings/.sessions/messenger-sessions/` with mode `0700` and its files with mode `0600`. Config schema v1 requires `workspaceId`, persona, role/approval policy, selected backend, credential reference, operator IDs, explicit DM/channel/thread bindings, and timing limits. `naia-agent` and `naia-shell` paths or imports are invalid in this core configuration.

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

`suspected_stalled` is a warning, not an automatic failure. A backend that does not support structured progress must show `activityDetail: unsupported`; the helper must not invent phases from arbitrary prose.

### 3.3 Append-only event

Each job event contains:

```text
eventId, dedupeKey, jobId, attemptId, sequence, ordinal, kind, occurredAt,
source, safeSummary, metrics, redactionLevel
```

Initial event kinds:

```text
job_accepted, attempt_reserved, attempt_started, backend_ready,
phase_changed, output_activity, tool_started, tool_finished,
approval_required, checkpoint_saved, verification_recorded,
attempt_exited, attempt_succeeded, retry_scheduled, delivery_started,
delivery_confirmed, delivery_unknown, recovered,
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
| `phase_changed` | adapter | `phase`: `setup`, `planning`, `reading`, `editing`, `testing`, `reviewing`, `delivering`, or `recovering` |
| `output_activity` | adapter | non-negative integer `bytes` |
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
| `recovered` | core | `recoveryAction`: `resume`, `safe_retry`, or `manual_review` |
| `cancel_requested` | core | empty payload |
| `cancelled` | core | empty payload |
| `completed` | core | empty payload |
| `failed` | core | `reasonCode`: `timeout`, `process_exit`, `authorization`, `delivery_unknown`, or `internal_error` |

Unknown keys are rejected. Enum fields accept only the values listed above. `checkId` and verifier IDs use `[A-Za-z0-9_.:-]{1,64}` and additionally reject secret-like patterns. Persisted metrics allow only `bytes`, `count`, `durationMs`, `exitCode`, `passed`, `failed`, `missing`, `total`, and `queuePosition`; values are booleans or non-negative safe integers. An optional artifact digest is local-only and must be `sha256:` followed by exactly 64 lowercase hexadecimal characters. An encoded payload above 2 KiB is rejected before formatting.

The producer column is enforced, not descriptive. In particular, a backend cannot append lifecycle-authoritative `completed`, `failed`, or delivery events. Its success statement is stored only as `backend_claim` evidence; the helper owns lifecycle transitions after observing process and verification evidence.

Attempt ownership is also enforced. Once a new attempt becomes current, delayed events or evidence from an older attempt are rejected and cannot overwrite the job snapshot. A `delivery_unknown` job cannot return to `running` from a later adapter event; only a separate authorized operator or reconciliation decision may leave `recovery_review`.

### 3.4 Snapshot and freshness

Default timing is a 10-second helper heartbeat, stale after 30 seconds, and a 120-second soft-silence warning. A job-specific hard deadline is fixed at acceptance. In-process durations use a monotonic clock; persisted UTC timestamps support restart continuity. Wall-clock rollback or contradictory time evidence produces `unknown/clock_evidence_invalid`.

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
manage-discord-sessions.sh watch [--job <job-id>] [--jsonl]
manage-discord-sessions.sh cancel <job-id>
manage-discord-sessions.sh retry <job-id> [--confirm-delivery-risk]
```

The first implementation slice provides `status`, `jobs`, `job`, and `watch` over a local fake backend. `logs` is deferred until a bounded encrypted artifact contract exists. Control commands arrive only with the service state machine because a file-only command that cannot reach a running child would imply false control.

JSON output has an independent contract version (`schemaVersion: 1`); it does not inherit the internal SQLite migration version. Success exits 0, invalid arguments or unknown jobs exit 2, unavailable/corrupt/newer state exits 3, and internal failures exit 1. Empty `jobs` is a successful empty array. `watch` emits existing events once from ordinal 0, then resumes strictly after the last emitted ordinal at a 500 ms local interval; each ordinal appears at most once per process.

Discord provides two allowlisted projections. Before Slice 3, `config.json` must name operator Discord user IDs and conversation bindings. Default is deny: a participant can query only a matching DM/channel/thread binding, and only an operator can cancel, retry, or inspect cross-job metadata.

- a pinned operator status message updated on meaningful transitions;
- an optional job thread containing safe event summaries.

It does not post periodic “still alive” spam. After reboot it posts one recovery summary. A conversation participant may see only that conversation. Configured operators may see redacted cross-job metadata, never raw user content or full local paths.

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
- AI children receive only `PATH`, locale/terminal values, isolated XDG/TMP paths, the validated workspace path, and the one adapter-declared provider credential when needed. `HOME` points to a new mode-`0700` attempt directory under the user runtime directory, never the user's actual home or `naia-settings`. The source and destination authentication files are owner-only real files; the destination is created with no-follow/exclusive semantics and removed when the attempt ends. If a client cannot authenticate under that restriction, the backend is `not_ready`. Discord credentials, `CREDENTIALS_DIRECTORY`, systemd credential paths, and service-only file descriptors are removed.
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

The supported floor is Codex CLI `0.146.0` and Claude Code `2.1.220`; an older or unparseable version is `not_ready`. Codex runs with `--ephemeral`; Claude runs with `--no-session-persistence`. Slice 2 raw retention is `none`: prompt and raw stdout/stderr/tool payloads are neither stored nor encrypted. Reboot recovery therefore keeps the durable `jobId` but starts a new `attemptId` or requires manual review; it does not silently resume a provider-native transcript. A structured provider success marker plus process exit 0 produces `attempt_succeeded` and lifecycle `result_ready`. Only the Gateway may then record real delivery events; the runner never fabricates `delivery_confirmed`.

Verification: each real adapter contract, each-backend-removal test, cancellation/timeout/process-kill matrix.

### Slice 3 — Discord Gateway and projections

Gateway resume, DM/channel/thread scope separation, pinned status, job threads, redacted commands, delivery ambiguity, and single-credential ownership.

Verification: fake Discord Gateway plus real test bot; normal REST receive polling count is zero.

### Slice 4 — user service and reboot

Workspace-hashed user service, encrypted credential resolution, login/linger distinction, recovery timeline, and one recovery notice.

Inbound idempotency uses `adapter + scope + sourceMessageId`. Delivery allocates a durable `deliveryKey` and at-most-25-character nonce before send, then sends with Discord `enforce_nonce=true` and associates the returned Discord message ID. Timeout after send but before receipt persistence becomes `delivery_unknown`. Restart reads at most 100 recent messages from the exact stored channel after the persisted pre-send high-water mark and matches bot author ID plus nonce. A match becomes delivered; no match remains unknown because absence is not proof of non-delivery. Restart never auto-resends. A recovery notice has a unique `(bootId, generation)` key and is posted at most once.

Verification: actual reboot with the same job ID, new attempt ID, recovered event, exactly one helper/credential owner, Gateway resume or explicit fresh connection, one recovery notice, and zero automatic resend of `delivery_unknown`.

### Slice 5 — polling migration

Legacy high-water marks become observations rather than completion receipts. Failed or unreceipted messages become review candidates.

Verification: shadow comparison, single sender cutover, rollback without deleting the new ledger.

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
- Before Slice 2: local payload encryption and default message retention period
- Before Slice 3: exact Discord command registration and operator authorization bootstrap
- Whether direct read-only terminal attachment is worth the additional PTY proxy surface
