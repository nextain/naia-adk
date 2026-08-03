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
and suspend the failed coordinator. Select, subject to adversarial review.

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
3. Suspend the failed coordinator path. Reject
   `runtime.conversationCoordinator=true`, withdraw DSO-008, and remove its
   activation guidance. Dormant code deletion is separate so this patch does
   not become a router rewrite.
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
   connection proof are attention/unknown and never guessed into health.
5. Add one external deterministic observer that runs the same pure projection
   every 60 seconds and atomically writes only a bounded
   `supervisor-status.json` beside the runtime state. Linux installs a separate
   systemd timer/oneshot identity; Windows requires a separate least-privilege
   one-minute Task Scheduler identity and fails installation closed when that
   identity cannot be verified. Supervisor registration is verified first and
   a partial failure quarantines the main service; status verifies both. It
   never writes SQLite, sends, restarts,
   or replays. Install/reboot tests stop Discord and observe two newer snapshots
   to prove failure-domain separation. Existing OS `Restart=always` remains
   crash recovery; this is service-health evidence, not continuous curation.
6. Change the skill contract: manual polling may be used for bounded diagnosis,
   but must never be promised as continuous curation. Collaboration subagents
   have no receipt interface in this version. Status exposes
   `foreignAgentSupervision=unsupported`; their lifecycle is never inferred and
   must be reconciled directly before reporting them active or using results.

## Complexity budget and deferred rollback

- No new model turn, queue, lifecycle state machine, or database writer.
- At most two small deterministic modules: one pure read-only projection and
  one one-shot observer, plus small CLI/service-manager surfaces.
- Reuse current status projection and instance path resolution.
- Do not enable the disabled conversation coordinator.
- Every new state must be derived from existing durable timestamps or explicit
  version metadata; no inferred prose state.

The Linux and Windows launchers currently execute helper files from a mutable
checkout. Restoring a prior unit or config therefore cannot restore prior code.
A real last-known-good rollback needs an owner-only immutable release bundle,
an unchanging launcher, atomic current/previous pointers, and an old-helper DB
compatibility probe. That is deferred rather than represented by a misleading
partial rollback command.

## Validation

- Unit fault injection for each DSO-009 criterion.
- The changed deterministic tests must be green and the full Discord suite
  must show no new regression relative to its recorded baseline. Existing
  baseline failures and platform skips are reported rather than relabeled.
- Test an absent service, stale heartbeat, alive service with overdue work,
  historical ambiguity as attention, managed config, approval UI, stale entry
  gates, coordinator enablement, and observer snapshot while comparing the
  ledger digest before/after.
- Development and integration adversarial reviews receive this plan, DSO-007,
  DSO-009, the incident evidence, implementation diff, and tests.
