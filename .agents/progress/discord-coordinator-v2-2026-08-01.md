# Discord conversation coordinator v2

Issue: [nextain/naia-adk#18](https://github.com/nextain/naia-adk/issues/18)
Scope mode: `SELECTIVE_EXPANSION`
Requirements: `DSO-007`, `DSO-008`

## Outcome

Each authorized Discord DM, channel, or thread has one provider-neutral local
coordinator record. Short isolated model turns answer ordinary dialogue using
bounded authorized Discord history and durable open-work summaries; actual work is delegated
to isolated Codex or Claude workers. No provider transcript is the source of
continuity. No receipt, status message, worker failure, or uncertain delivery
can block later user messages.

## Gap analysis

| User outcome | Current implementation | Gap |
|---|---|---|
| One continuing manager per scope | `codex --ephemeral` / Claude `--no-session-persistence` for every message | Coordinator identity is discarded |
| Work goes to subagents | Every message directly launches the full worker | No coordinator/worker separation |
| Conversation remains responsive during work | A same-scope job owns the lane until completion | Long work blocks questions and follow-ups |
| Receipt is informational | Confirmed receipt is a hard launch gate | Discord REST outage discards accepted work |
| Failure is contained | `operator_response_missed` and `delivery_unknown` become terminal review states | Transport failure becomes conversation failure |
| Status reflects user success | Process heartbeat dominates projection | Live process can hide a nonfunctional bot |
| Tests protect the user journey | DSG-015 asserts the worker must not start when receipt fails | Deterministic green suite preserves the regression |

Operational evidence on 2026-08-01: 94 accepted jobs, 44 completed/delivered,
37 `recovery_review`, and 13 failed. Twenty-one requests were stopped by the
acknowledgement gate before useful work could begin.

## Target flow

```text
Discord Gateway
  -> durable ingress per scope
  -> local coordinator queue (one short isolated decision at a time)
       -> reply
       -> delegate bounded worker task
  -> independent worker pool
       -> safe progress -> coordinator
       -> result/failure -> coordinator
  -> best-effort Discord delivery
```

The Gateway process remains always on and its dispatch callback performs only
bounded durable admission. Coordinator model processes and workers are
ephemeral. The local harness owns continuity, policy revision, and open-work
state. Discord remains the conversation transcript source of truth; a REST
history outage degrades context for that turn but never blocks admission.
Workers receive no Discord credentials or unrelated private transcript.

## Build phases and verification

1. **Contract correction** — make acknowledgements non-blocking and define a
   durable coordinator. Verify with contract tests and planning review.
2. **Coordinator persistence** — store one provider-neutral scope record,
   policy revision, and bounded encrypted continuity envelope. Verify restart
   and provider-switch behavior.
3. **Reply/delegate routing** — structured coordinator decision, separate
   worker pool, and result synthesis. Verify burst messages and active-worker
   status queries.
4. **Failure containment** — REST-down, DNS failure, timeout, worker crash, and
   service restart tests. Every later message must still receive a coordinator
   turn.
5. **Truthful operations** — distinguish service, conversation, worker, and
   delivery health; historical unresolved work is not a queue.
6. **Integration** — full suite, build, two clean adversarial review rounds,
   then an isolated test-bot E2E before per-instance rollout.

## Error and recovery map

| Failure | Recovery | User-visible rule |
|---|---|---|
| Coordinator continuity missing/corrupt | Rebuild a local record from bounded authorized history and open-work metadata | Report continuity recovery once |
| Coordinator turn fails | Record the turn failure; retain scope queue; retry only on a new event or bounded internal retry | Never claim work started |
| Worker fails | Return failure to the coordinator and keep the scope available | Coordinator reports cause and next safe action |
| Discord delivery unknown | Preserve unsent result reference; never block the scope or auto-resend ambiguous content | Status says delivery unknown |
| Service restart | Recover coordinator IDs and queued ingress; running mutation workers require review | No historical blind replay |
