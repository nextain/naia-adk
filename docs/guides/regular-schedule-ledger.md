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
