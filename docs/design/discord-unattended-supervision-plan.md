# Discord unattended supervision and recovery plan

## Incident evidence

The AIPOL session is evidence about the generic harness, not about the AIPOL
product agent. The root session promised periodic channel curation, performed
ad-hoc REST/SQLite polling inside the same conversational turn, later shifted
attention to implementation, and silently stopped observing Discord. It also
continued to describe delegated agents as active after child termination or
quota exhaustion. The durable Discord status subsequently showed a stopped,
stale service and unresolved review/delivery records while human channel
messages remained unanswered.

The existing implementation already owns useful boundaries: Gateway ingress,
scope authorization, an owner-only SQLite ledger, isolated provider children,
delivery nonces, and recovery review. The observed failures are above and
beside those boundaries:

1. `watchdog()` is in the Discord service process, so it cannot report when
   that process is absent.
2. Heartbeat freshness says that the service loop ran; it does not prove that
   accepted messages received a response or that a promised curation mission
   still has an owner.
3. An interactive model turn is not a scheduler. Repeating REST or SQLite reads
   from that turn is not durable monitoring.
4. Codex collaboration subagents are outside this harness. Treating them as
   harness-owned workers produces false supervision.
5. No-prompt child CLI flags coexist with `requiresApproval` and a `managed`
   execution-profile state. That split permits conversational re-approval or a
   misleading wait even though an unattended user cannot answer it.
6. The coordinator path expanded one request into three model turns and was
   disabled after live timeouts. Adding another orchestration layer would
   repeat the failure pattern.

## Options evaluated

### A. Extend the coordinator and add durable mission/subagent states

This could represent every promise and child explicitly, but requires an
adapter for collaboration-agent lifecycle, more recovery transitions, and
cross-process ownership. It increases the highest-risk part of the current
system and still cannot observe a provider child that publishes no receipt.
Reject for this change.

### B. Add multiple model watchers

Watchers sharing the same session, quota, context, or process failure domain do
not provide independent evidence. Recursive watcher supervision also grows
state without improving the underlying observation. Reject.

### C. Minimal deterministic observer plus fail-closed boundaries

Keep the existing transport/security core and the default one-turn execution
path. Add one read-only, instance-scoped health check runnable by systemd or an
operator timer. It judges only durable facts and reports absent Gateway proof
as unknown. It never sends messages or launches work. Make no-prompt a
fail-closed config invariant, reconcile the contradictory entry-point gates,
and remove the failed coordinator from production while quarantining its legacy
recovery state. Select, subject to adversarial review.

### D. Documentation-only instruction to keep polling

This is the mechanism that failed. Reject.

## Proposed minimal changes

1. Reconcile `AGENTS.md` and its mirrors with the workflow SoT. Understand,
   Scope, Plan, Sync, and Close are internal checkpoints after a bounded
   request; only a material unresolved choice pauses for the user. Add a
   deterministic mirror/wording regression. Set this workstation's Codex
   default `approval_policy="never"` so newly launched root sessions fail
   instead of opening an approval UI.
2. Replace the unattended `managed|never` choice with a validation invariant:
   enabled Discord services require `runtime.approvalPolicy=never`.
   The effective unattended action set is exactly `allowedActions -
   requiresApproval`; prompts and sandbox access use that set, so removal of
   managed approval never expands authority. Direct and worker prompts carry
   the already-bounded routine authority and report absent authority as a
   limitation without asking for a click. This is a prompt contract, not a
   claim that every possible model sentence can be classified perfectly.
3. Remove the failed coordinator from the production runtime. Reject
   any `runtime.conversationCoordinator` key, withdraw DSO-008, delete the router
   activation branch and coordinator module, and retain only the compatibility
   table plus quarantine of pre-withdrawal recovery envelopes. Direct bounded
   execution remains the only production request path.
4. Add `health-check --json` to the existing CLI. It opens SQLite read-only and
   returns `healthy`, `attention`, or `unhealthy`. Stopped/stale service and
   queued jobs silent since `acceptedAt`, owned running jobs silent since
   `lastProgressAt ?? startedAt`, and retry/result/delivery states silent since
   `updatedAt`, beyond `noProgressInterventionSeconds` are unhealthy. An
   approval-wait lifecycle is immediately unhealthy. Missing/conflicting child
   evidence takes precedence. Gateway ACK freshness uses a separate bounded
   threshold derived from service heartbeat policy. Terminal
   records are excluded, and future/missing timestamps are attention/unknown.
   Historical `recovery_review`, `delivery_unknown`, and absent Gateway
   connection proof are attention/unknown and never guessed into health. The
   repeating paths select at most 256 nonterminal jobs oldest first and obtain
   the total active count and historical attention through aggregate queries
   backed by partial indexes. Active overflow is explicitly unhealthy rather
   than silently omitted; bounded operator pages handle detailed history.
5. Add one external deterministic observer that runs the same pure projection
   every 60 seconds and atomically writes only a bounded
   `supervisor-status.json` beside the runtime state. Linux installs a separate
   systemd timer/oneshot identity; Windows requires a separate least-privilege
   one-minute Task Scheduler identity and fails installation closed when that
   identity cannot be verified. Supervisor registration is verified first and
   a partial failure quarantines both the main service and timer; status verifies both. It
   never writes SQLite, sends, restarts,
   or replays. Install/reboot tests stop Discord and observe two newer snapshots
   to prove failure-domain separation. Existing OS `Restart=always` remains
   crash recovery; this is service-health evidence, not continuous curation.
6. Give each durably admitted job one in-process ACK timer. It races one safe
   acknowledgement attempt against `operatorResponseSeconds`, records exactly
   one sent-or-missed outcome, and never gates worker launch. It neither polls
   Discord nor waits for the 60-second supervisor tick. The underlying send is
   abortable at the deadline, and shutdown aborts and settles all ACK/control
   sends before draining the Gateway.
7. On Linux, launch through nested kernel `flock` locks for the shared bot token
	 and named instance. The service process holds both locks and the kernel
	 releases them on exit or crash; `%t` keeps token ownership shared even with
	 `PrivateTmp=yes`. The service then acquires the same fail-closed owner record
	 used by direct and Windows launches, preventing cross-launch split ownership.
	 It atomically reclaims only a complete same-host, same-boot record whose PID
	 is objectively absent; every ambiguous or conflicting record remains closed.
8. Change the skill contract: manual polling may be used for bounded diagnosis,
   but must never be promised as continuous curation. Collaboration subagents
   have no receipt interface in this version. Status exposes
   `foreignAgentSupervision=unsupported`; their lifecycle is never inferred and
   must be reconciled directly before reporting them active or using results.

## Complexity budget and bounded rollback

- No new model turn, queue, lifecycle state machine, or database writer.
- New production modules must each own one bounded concern. This change adds
  deterministic context assembly, rollback verification, and the non-systemd
  token-lock fallback; it does not add another model turn, queue, or lifecycle
  state machine. Prefer deleting a module or branch before adding another.
- Reuse current status projection and instance path resolution.
- Keep the production conversation coordinator removed; compatibility state is
  passive and can only force legacy recovery into review.
- Every new state must be derived from existing durable timestamps or explicit
  version metadata; no inferred prose state.

Linux cutover uses an owner-only rollback bundle created before target mutation
from a separate clean candidate checkout. The bundle contains the previous
executable helper tree, config, service and supervisor units, source/tree
identity, byte digests, a source-runtime config-loader receipt, and database compatibility evidence. One absolute
candidate `cli.mjs` path owns `cutover prepare`, `verify`, `canary`, and
`rollback`; neither canary nor recovery executes the mutable target CLI.
Normal Linux installation reuses the same Git archive/materialization and
verification path, so service and supervisor execute an owner-only immutable
artifact rather than a mutable checkout under an install-time revision label.
Both require an explicit managed-systemd mode and complete artifact markers
before reading config, taking token ownership, or observing state. Replacing an
existing registration through `service install` is allowed only when the active
bundle proves the installed source and deployed candidate under the clean
candidate controller; a normal first-install command cannot become an unchecked
upgrade.

The first managed cutover also has one narrow legacy-adoption path. It accepts
only the exact mutable service/supervisor/timer format previously generated by
this skill, canonical executables, owner-only files, matching credential,
known registration state, an owned live process when active, and an idle
ledger. Prepare binds those legacy unit hashes and install rechecks them before
replacement. Arbitrary legacy units remain unsupported. Failed install
preparation removes a new runtime only when no unit references it. Explicit
`artifacts list`/`prune` retains the installed runtime and active rollback
bundle and removes only re-verified unreferenced copies. Install, cutover
prepare, rollback, and prune share a per-instance Linux kernel lock that is
released with its holder process, so stale inventory cannot race an artifact
into active use without a stale-record reclamation protocol or readiness-file
leak. `autoStart=false` explicitly stops and disables the Linux service. Windows
install remains first-install-only until versioned cutover exists; any existing
main-service or supervisor registration blocks installation before launcher
creation. The disabled path publishes no runnable main task, and manual task
lifecycle commands share one fail-closed containment transition.

Canary is strict. `continue` requires the active bundle to verify, the external
supervisor to be fresh with healthy service and Gateway evidence, the current
read-only ledger to show a live owned candidate-generation service process at
evaluation time, exact installed unit bytes plus enabled/active service and
timer registrations, and exact equality among the job acceptance, execution,
current service, and supervisor generations. The named schema-v2 read-only job
must carry durable instance, agent/workspace, context, participant-authority,
config, and read-only access evidence that recomputes exactly from the current
host config, then complete with both ACK and final delivery confirmed. Missing,
fabricated, malformed, stale, nonterminal, recovery-review,
approval-UI, or unconfirmed evidence returns `stop`. Manual rollback re-verifies
the bundle before mutation, stops the service, refuses a non-idle ledger,
revalidates the prior config with the copied source runtime loader, atomically restores it, installs the versioned units, and only
then restarts. A failed callback stops all later phases. SQLite is preserved;
Windows versioned rollback is explicitly unsupported.
Historical attention remains visible but is not a current-canary fault.
Containment commands inspect the installed registration without first parsing
candidate configuration.

## Validation

- Unit fault injection for each DSO-009 criterion.
- The changed deterministic tests must be green and the full Discord suite
  must show no new regression relative to its recorded baseline. Existing
  baseline failures and platform skips are reported rather than relabeled.
- Test an absent service, stale heartbeat, alive service with overdue work,
  historical ambiguity as attention, managed config, approval UI, stale entry
  gates, coordinator enablement and legacy-envelope quarantine, per-job ACK
  deadline independent of supervisor cadence, kernel lock contention, strict
  canary stop conditions, rollback callback ordering, and observer snapshot
  while comparing the ledger digest before/after.
- Development and integration adversarial reviews receive this plan, DSO-007,
  DSO-009, the incident evidence, implementation diff, and tests.
