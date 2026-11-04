# Wake and response reliability work record

## Authority and scope

The bounded request authorizes common wake completion documentation, a configurable
human-response observer, a regular schedule ledger, onboarding procedures, tests,
and entrypoint/index synchronization. Local branch and commit only. No deployment,
remote push, live messages, credentials, or private instance data are authorized.
The original request is retained outside the public tree; public wording derives
only the generic requirements below. Work is document-driven; no hosted issue is
required to start, track, or finish this work.

## PC-WAKE — Promise

A human request must be traceable from receipt through confirmed reply, across
restarts. A generated wake file or a running process alone is insufficient.
Preserve existing Gateway, admission, permission, ACK and job watchdog behavior.

## UC-WAKE — Scenarios

1. A mention, configured role/name or assigned-channel request is recorded with
   a durable channel cursor, assigned and delivered to an executable session.
2. Missing session, denied channel, busy model, restart and uncertain delivery
   retain the failed stage and recovery ownership instead of claiming completion.
3. First observer run baselines existing posts without sending alerts. Later
   requests without expected-bot replies trigger one nudge at 10 minutes and one
   owner notice at 30 minutes, including after observer restart.
4. Unaddressed human-to-human replies and requests addressed to another bot are excluded;
   unrelated bot chatter cannot satisfy an assigned bot's response obligation.
5. DRY mode previews without posts or state changes. Read failures retain cursor.
6. A proposed schedule is recorded but never installed or activated automatically.

## RQ-WAKE — Acceptance requirements

| ID | Requirement | Feature | Verification |
| --- | --- | --- | --- |
| RQ-WAKE-1 | Seven-stage wake contract and failures | FE-WAKE-1: guide | guide review |
| RQ-WAKE-2 | Configurable scope, routing, exclusions and thresholds | FE-WAKE-2: response-watch | fake Discord API tests |
| RQ-WAKE-3 | Baseline, durable cursor, deduplication, DRY, error records | FE-WAKE-2 | persistence/failure/DRY tests |
| RQ-WAKE-4 | Expected-bot responses and human conversations | FE-WAKE-2 | reply/conversation tests |
| RQ-WAKE-5 | Site probes and safe unattended launch examples | FE-WAKE-2 | site tests and guide review |
| RQ-WAKE-6 | Ledger statuses, conversion and last-result evidence | FE-WAKE-3: schedule procedure | ledger/checklist review |
| RQ-WAKE-7 | Sync/setup/test/watch/schedule acceptance procedure | FE-WAKE-1 | checklist and entrypoint check |

## FE-WAKE — Design fixed before implementation

The independent REST observer sits above the Gateway job lifecycle and never
admits jobs or injects input into sessions. State contains per-channel last-seen
IDs, pending requests and per-stage delivery receipts. Page until the stored
cursor, process oldest first, advance only after successful complete reads.
Expected bot mentions, configured role/name and unaddressed assigned-channel
posts create obligations. Unaddressed human replies and mentions to other bots do
not. An expected bot's explicit reply closes its referenced request; an
unreferenced expected bot post records activity but does not prove a reply.
First observation per channel is a baseline. Excluded channels stay untouched.
Persist state atomically; reject concurrent runners. Store a sending intention
before external posts; uncertain sends require operator reconciliation rather
than automatic retry. HTTP errors never become successful receipts.
DRY uses a copy, makes no posts, probes configured sites and leaves state intact.
Site probes alert after consecutive failures, then emit one recovery notice.
No message body, user display name, credential or raw API error body is logged.

Schedules use a YAML ledger and a documented reviewed conversion procedure,
not a new scheduler. Only explicitly approved rows with confirmed execution
mechanisms become timers or bounded wakes; `제안` and `사람` remain off.

## Work and evidence

| Step | Authorization | Status |
| --- | --- | --- |
| Design, requirements and scenarios | bounded user request | written before code |
| Implementation and tests | bounded user request | 21 fake API tests pass |
| Documentation/index synchronization | bounded user request | entrypoint/context-budget checks pass |
| Local review and commit | bounded user request | same-family findings corrected; cross-family review not run |

UT/IT evidence: `scripts/response-watch.test.mjs` (fake API, no live Discord).
QC: local adversarial review against PC-WAKE and the onboarding acceptance list;
record reviewer availability and actual results without claiming unavailable
independent model review. Repository docs and reusable operator guidance are
updated by the guides linked below; a separate product UI manual is N/A because
this change adds an operator script, not a UI surface.

## QC and verification record

Same-family read-only adversarial review found uncertain-send replay, lost error
records, misleading healthy exit, deleted-reference cursor stalls and role-name
boundary errors. Each was corrected with regression coverage. Two final clean
reads assess the final result; this does not claim independent model-family QC.
The optional cross-family review receipt remains NOT_RUN.

Observer: 21 tests pass, including threshold boundaries, baseline, references,
human conversation, role/route configuration, pagination, state corruption, DRY,
concurrency, rejected/uncertain sends, site baseline/failure/recovery and deleted
references. Entrypoint mirrors, context budget and whitespace checks pass.
Complexity preflight needs named review only because the existing session skill
is already oversized; the added section is ten link/contract lines. New script
and tests remain below warning thresholds. No complexity waiver was added.

Existing Discord regression suite: results and any retry/cancellation detail are
kept in the external execution report; no live-server validation is claimed.
Documentation impact receipt: `wake-response-doc-impact.json`.
