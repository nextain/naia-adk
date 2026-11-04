# Regular schedule ledger

Maintain one instance-private `regular-schedule.yaml`, starting from
[the example](../../config/regular-schedule.example.yaml). This is the source
of truth for intended regular work. A timer inventory is evidence of installed
mechanisms; the ledger also captures work that people do or have only proposed.

Each row requires a stable `id`, responsible `role`, `task`, `cadence`, local
`time`, `status`, `mechanism` and `last_result`. Declare an IANA `timezone` at
the top, and use ISO-8601 timestamps including offset for result/approval times.
Use distinct IDs for different roles or cadences; never overload one timer name.

| Status | Meaning | Conversion behavior |
| --- | --- | --- |
| 있음 | mechanism installed and verified | retain; compare installed schedule and last actual result |
| 부분 | only part works | document missing part and repair plan; no automatic activation |
| 새로 | accepted new work, mechanism not verified | explicit approval and test required before installation |
| 사람 | human owns execution | record reminders separately; no automatic execution |
| 제안 | proposal awaiting decision | never generate, install or enable a timer/wake |

`mechanism.kind` is `wake`, `timer` or `manual`. Its `target` identifies an
exact permitted binding or local command mapping; `timer` names the installed
unit/cron entry. Keep executable commands in reviewed instance configuration,
not free-form task text. `approval` records decision time, authority reference
and exact accepted row revision. `last_result` records `at`, `outcome` and a
local document/artifact `evidence` reference. Timer exit zero or a generated
wake alone does not mean the task produced its promised result.

## Reviewed conversion procedure

1. Validate IDs, role/binding, timezone, cadence/time and all five status values.
   Compare each row to installed timers before creating anything. Capture the
   original units/cron and real symlink targets in a timestamped backup.
2. Export a review table: row ID, status, approval reference, intended timer,
   next three fire times (including daylight-saving transitions) and target.
   `제안`/`사람` rows have **no generated execution entry**. `부분` remains a
   documented repair, not an enable instruction.
3. For an explicitly approved `새로` row, translate cadence to systemd
   `OnCalendar` or cron in the ledger timezone. For example daily UTC 22:00
   becomes `OnCalendar=*-*-* 22:00:00 UTC`; weekly Monday 18:30 UTC becomes
   `OnCalendar=Mon *-*-* 18:30:00 UTC`. Validate with `systemd-analyze calendar`.
   Define catch-up policy (`Persistent`), overlap lock and missed-run behavior.
   For monthly/annual conditions, specify exact date semantics and test them.
4. Generate a local draft unit or a bounded wake to the existing approved
   ingress. A schedule has no permission to bypass admission or deploy code.
   Inspect the diff; if copying, run `rsync --dry-run` and review overwrite paths
   first. Never install from unreviewed task text.
5. Run once in a permitted test scope, verify wake delivery, referenced reply
   and actual task artifact. Only then install/enable the chosen mechanism and
   change the row to `있음`; record approval, timer name and result evidence.
6. Reconcile ledger and installed inventory after edits and at each review.
   Disable/replace only the exact reviewed old mechanism after saving rollback
   instructions. Failures update `last_result` and a repair work document.

The procedure intentionally produces reviewable drafts; the ledger itself does
not activate work. Follow [server onboarding](server-wake-onboarding.md) for
rollout evidence and [wake completion](wake-completion-contract.md) for results.

## Record each actual execution

The installed timer/cron wrapper calls the recorder after the task completes,
including on failure. The recorder does not execute task text or install timers:

```sh
node scripts/schedule-record.mjs <private-regular-schedule.yaml> <row-id> success
node scripts/schedule-record.mjs <private-regular-schedule.yaml> <row-id> failed
```

It updates `last_result.at` to the current offset-bearing UTC timestamp and
`last_result.outcome` to the supplied result, retaining evidence and unrelated
rows. Record the actual artifact in `last_result.evidence`; an exit code alone
is not proof of the promised deliverable. Run the task even when the previous
record is missing, capture its exit status, and call the recorder for both
success and failure paths; propagate recording failures to the timer journal.
Writes use an exclusive lock and atomic replacement. The file must be a regular
file; use the resolved target when a ledger is a symlink. Comments and formatting
may normalize. Back up before migration or manual reconciliation. A stale lock
requires verifying its owner has exited before removal.

Connect the absolute path as top-level `regularSchedule` in session health.
`있음` rows support `daily` or `weekly:MON` through `weekly:SUN`, an IANA
`timezone`, `HH:mm` local time and nonnegative `graceMinutes` (default 15).
During a repeated daylight-saving hour, the latest already-passed matching
occurrence is used; a nonexistent local time skips that date. Match this policy
to the installed timer during acceptance. Unsupported installed cadences are unknown and require an instance-specific
calendar adapter before monitoring. At the latest due occurrence plus grace,
no covering execution record means **안 돎** after the boundary. `not-run`
is not an execution; failed executions count as runs and require separate repair.
The observer reports each role's rows and uses the same internal/owner alert
receipts, silent first successful baseline and one alert per stage per missed
occurrence. Proposals, manual and unverified rows stay outside execution checks.

Maintain the [work ledger](work-ledger.md) for one-off instructions and repairs.
