# Role work intake and wake-with-work record

## Authority and scope

Common ADK change to make a role pane receive a human instruction as assigned
work and see that work on every wake. No deployment, no live sends from tests,
no private instance data. Baseline `717fc588`. Revision 2 after cross-model
review round 1 (FAIL, 9 high findings): reuse the existing watcher and the
existing single delivery point instead of adding parallel paths.

## Existing structure (analysed before change)

| Part | What it does now | Gap |
| --- | --- | --- |
| `scripts/work-ledger/ledger-watch.mjs` | Reads channels per role, filters configured humans/relays (`isHumanOrRelay`, ~l.834), re-wakes the role every 15 min while unanswered; registers `waiting_human` via `upsertWaitingHuman` (~l.259) only after the re-wake cap (~l.1183) or 24 h (~l.1245) | no `open` item on first receipt: an instruction the role ignores becomes work only hours later, and as "waiting for human", not as the role's task |
| `scripts/role-wake.mjs` `handOver` (~l.293) | the one place every wake file (liveness, session-health, bot-mention, ledger) is handed to the pane command | delivers the file body only; the role's ledger never travels with the wake |
| per-role JSON ledger (`ledger.mjs`) | lock (`withLock`), validation, atomic write; `due` required | intake must supply a due; null breaks validation |
| `ledger.mjs` `done` | `--result` required only for items with an instruction file; `confirm --as done` closes on owner confirmation | ordinary items close with no result |

Instance observation (2026-11-19, counts only): one role's ledger had 0 items
two hours after a named instruction; another had 25 open items with duplicated
"reopened" copies, most overdue; another 17 open, oldest 4 days overdue. The
pane wake text in that instance is built by a server-local composer that passes
the post and five previous posts; it is one of the role-wake sources.

Root causes: (1) first receipt creates no open item; (2) the delivery point
adds no work context; (3) ordinary close needs no result.

## PC-INTAKE — Promise

A configured human's post addressed to a role becomes that role's open item on
first observation, matched to an existing item when it follows one. Every wake
handed to a pane begins with that role's work header. Ordinary items close only
with a stored result reference.

## UC-INTAKE — Scenarios

| ID | Scenario | Expected |
| --- | --- | --- |
| UC-1 | Configured human mentions roleA with a task | on the next watcher run roleA has one `open` item: source channel+msg, title from post, `due` = receipt + `intake.defaultDueMinutes` (default 120) with `due_assumed: true` |
| UC-2 | One post mentions two roles | one item per mentioned role, using the watcher's existing per-role mapping |
| UC-3 | Reply / same-thread follow-up to a post that already has an item | no new item; that item's `updated_at` untouched; the wake header names it as the matched item |
| UC-4 | Post in a channel the watcher assigns to a role with no explicit mention | handled exactly as the watcher already decides responsibility; no new owner inference |
| UC-5 | Same post observed again (restart, replay), including after the item is `waiting_human`, `done` or `dropped` | no second item; source match is `channel+msg_id`, shared by intake, `add` and `upsertWaitingHuman` |
| UC-6 | Role has overdue items | header order: matched item → most recently updated open item → up to 3 overdue (oldest due first, duplicates by source removed) → "and N more" |
| UC-7 | Ordinary `done` without `--result` | refused with the correct command shown; `--human-msg-id` confirmation stays valid as evidence and is stored |
| UC-8 | Bot, other role, or unconfigured author | no item (existing `isHumanOrRelay`) |
| UC-9 | Ledger write fails / lock timeout | watcher keeps the post unprocessed for intake and retries next run; no partial cursor advance for that post |

## FR-INTAKE — Functions

| ID | Function | Where |
| --- | --- | --- |
| FR-1 | `upsertIntake` beside `upsertWaitingHuman`: same lock and source match, creates `open` on first observation; `upsertWaitingHuman` reuses an existing intake item instead of adding a copy | `ledger-watch.mjs`, shared `findBySource(channel,msg)` in `ledger.mjs` |
| FR-2 | Config `intake.enabled` (default false for upgrade safety, instance turns on), `intake.defaultDueMinutes` | watcher config + example |
| FR-3 | `wakeHeader(role, {channel,msg})` pure function returning text per UC-6 | `ledger.mjs` (reuses existing sort/link helpers) |
| FR-4 | `handOver` writes header + original body to the spool copy before delivery when `delivery.workHeader` is true; original wake file unchanged | `scripts/role-wake.mjs` |
| FR-5 | `done` on an ordinary item requires `--result <file|URL>` or `--human-msg-id`; stored in `result`; existing done rows stay valid | `ledger.mjs` |

## PR split

1. FR-1, FR-2, FR-3 + tests (intake, dedup across all source paths, header).
2. FR-4 + fake-delivery tests for every wake source (liveness, session-health, bot-mention, ledger, retry after restart).
3. FR-5 + updated existing tests and guide examples.

## Tests

`node --test scripts/work-ledger/*.test.mjs scripts/role-wake*.test.mjs` plus the
full suite compared with the baseline failure list at `717fc588`. Fixtures copy
the shape of the 25-item ledger (duplicates, equal dues, mixed statuses) without
private text.

## Out of scope

Rewriting existing items, instance rollout (separate step after merge),
wording filters, boards, deployment.

## Addendum (instance observation 20:05 KST, to fold into PR2)

| ID | Scenario | Expected |
| --- | --- | --- |
| UC-10 | Pane is inside one long turn (observed: 4 h, 11 wakes queued as "follow-up inputs", lead mentions among them) | delivery detects a busy pane; a lead's post is injected at the next tool boundary (steer) instead of queued behind the turn, and the watcher reports a role whose queued wakes are older than `busyQueueMinutes` (default 30) to the coordinator |

## Decision D1 (20:15 KST): approach change after two design-review FAILs

Rounds 1 (9 high) and 2 (1 critical, 12 high) both failed on a design that
spanned intake, delivery and close at once. Per the review cap, the work is cut
into three slices, each shipped with its own doc section, code and tests and
reviewed on the actual diff:

- Slice A — wake header at the role-wake delivery point (FR-3, FR-4, UC-6, UC-10 detection). Directly fixes "panes see only the latest mention".
- Slice B — intake on first observation (FR-1, FR-2, UC-1..5, 8, 9).
- Slice C — close with result (FR-5, UC-7).

Review-2 findings carried into slice A: cross-role routing test for shared boxes;
header source = the per-role JSON ledger via the existing reader (not role-wake's
delivery `readLedger`); missing/broken/unreadable ledger leaves the original wake
unchanged plus one diagnostic line; sorting falls back to `created_at`/`due` when
`updated_at` is absent; header shown only, existing per-item alerts and drive unchanged;
consumers that bypass `handOver` (wait-only roles, liveness in-session, drive notify,
Gateway router) are listed as not covered and left to later slices.
