# Session health work record

## PC-HEALTH and scope

Provide evidence for role session liveness, task progress and rule drift on one
private sheet every five minutes. Local implementation and commit only; no live
servers, credentials, posts, timers or push. Public requirements derive generic
behavior from the bounded request; private original wording remains outside Git.

## Requirements and scenarios (REQ-WAKE-001 extension)

| Requirement | Scenario | Implementation / verification |
| --- | --- | --- |
| RQ-HEALTH-1 | tmux/herdr role absent, shell only, AI active, unchanged for 30m; output or log changes | collectWindow / observeRole; fake windows and logs |
| RQ-HEALTH-2 | active work exceeds 2h; commit/doc/referenced reply updates | observeRole; fake Git/work files/response state |
| RQ-HEALTH-3 | pinned rules match, change, disappear or are allowed; compact reread unavailable | compareRules / compactEvidence; fake pinned repository |
| RQ-HEALTH-4 | baseline silent, same episode once/stage, recovery/reoccurrence, restart, DRY, overlapping runs | runHealth; persistence/notification/lock tests |
| RQ-HEALTH-5 | malformed state, failed probes or uncertain send cannot imply health | runHealth; negative tests |

## Design before code

Use bounded local adapters; normalize evidence without retaining terminal or
session content. Separate status from anomaly notifications. State stores output
hashes, observation times and anomaly episode receipts. Render private task
lines only in the Markdown report. Compare full files except settings (hooks
only); differences expose line numbers rather than private contents. Reuse
response-watch explicit reply timestamps and alert destinations. Persist intent
before posting, never automatically replay uncertain sends. First observations
establish baselines without announcing historical anomalies.

## Documentation impact

Operator manual: docs/guides/session-health.md. Reusable onboarding: session
health acceptance checklist. Repository index and REQ-WAKE-001 updated together.
Tests use only fixtures/local repositories under the external run tmp directory.
QC and actual test totals are recorded in the external execution report; local
fixtures do not certify installed instances. Independent model-family review is
not claimed.

## Local verification receipt

Session health: 23 tests; response-watch including reply progress regressions:
23 tests. All 46 pass with zero failures, cancellation or skips. Fixture windows,
process trees, records and repositories run under the external run tmp folder.
Two static review passes are clean after fixing missing tmux-server handling,
independent progress sources, per-signal baseline/recovery and provisional reply
rollback. Entrypoint and context-budget checks pass. The canonical entrypoint
digest was synchronized only for the authorized new guide link. Complexity
preflight is clean. No live instance acceptance or independent model-family QC
is claimed.
