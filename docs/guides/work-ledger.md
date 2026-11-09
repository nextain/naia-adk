# Work ledger

Keep one private `work-ledger.yaml` per server, copied from
[the example](../../config/work-ledger.example.yaml). Enter an instruction as
soon as it arrives. Assign a stable ID and role, one-line task, status, request
time, deadline, original instruction link, result link and last update time.
Use `진행 중`, `대기`, `막힘` or `끝`. On completion set `끝`, add the actual
result link and update the timestamp. Use ISO-8601 timestamps with an offset;
use null for an undecided deadline or a result that does not exist yet.

Already authorized, reversible work proceeds after checking the existing
instruction. Do not ask for the same permission again. When asking a person,
include “If I hear nothing within N minutes, I will proceed as follows” and the
planned action. Silence does not replace approval required for external sends,
production changes or spending. A `대기` card must include its next wake time in
`due_at` and describe what will be checked then.

The [work-ledger watcher](../common/work-ledger.md) separately detects a bot
asking a configured person in a channel, thread or configured direct channel. After the
configured wait (15 minutes by default), it wakes the mapped role once per
question while that person has not answered. The bot’s unrelated posts and replies
to other bots do not close the question. Human replies in the same channel, a
question thread or a reply reference close it; editing a question preserves
its original ordering. Split messages retain their shared addressee. The wake asks
the role to reread prior instructions, continue reversible authorized work, or
move a true approval request to the instance's work-request channel using its
`[분류]` form. This observation uses private IDs and does not send a reply.

The YAML is the single machine-readable source. Markdown is a human view:

| id | role | task | status | requested_at | due_at | evidence | result | updated_at |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| task-001 | role-a | Review a draft | 진행 중 | 2030-01-01T09:00:00Z | null | https://example.invalid/request/1 | null | 2030-01-01T09:00:00Z |

To migrate an existing `now.md`, inventory every current assignment, assign IDs,
copy the original instruction links and timestamps, and preserve unknown dates as
an explicit migration issue instead of inventing history. Fill required dates
before enabling observation. Compare every row with the original and retain a
backup before replacing any instance file (including symlink targets). Generate
or edit the Markdown view from YAML; direct table edits must be reconciled into
YAML before the next observation. Avoid maintaining two independent task lists.

Set top-level `workLedger` and `regularSchedule` absolute paths in the private
[session health config](../../config/session-health.example.json). Ledger roles
must match `roles[].id`. Only `진행 중` rows are assigned work. Each row's
`updated_at` is its progress evidence: unrelated commits, replies or another
row's edits cannot refresh it. A row older than `staleHours` is stalled.
Update it when actual progress occurs and attach the result when finished.
Legacy `workFiles` remain supported alongside the ledger.

Use ordinary block YAML mappings and sequences with two-space indentation,
scalar values and quoted strings. Advanced YAML features (anchors, tags, flow
collections except empty `[]`/`{}`, and multiline scalars) are unsupported by these standalone tools.
Whole-line comments are supported; quote scalar text containing `: ` or ` #`.
JSON documents are also accepted with standard JSON parsing semantics.
Keep names, links, paths and task contents in private instance files. Follow
[regular execution recording](regular-schedule-ledger.md) and
[server acceptance](server-wake-onboarding.md) for the second ledger and rollout.

When role work is tracked with [task cards](task-cards.md), already authorized
reversible work stays `doing`. Waiting requires one of the four documented
`wait_reason` values, a next wake time in card `recheck_at` (ledger `due_at`) within `maxRecheckHours`
(default four hours), and a nonempty `request_ref` for human approval. Use an
ISO-8601 timestamp with `Z` or an explicit offset; waiting timestamps without a timezone
are rejected. Card `due` remains the work deadline; the waiting ledger row uses
`due_at` for the next wake, matching the human-response watcher contract. Deferred cards use their revisit
date at UTC end of day as ledger `due_at`. Legacy offsetless work deadlines use
UTC consistently for parsing and display.

Only `session-health-run.sh`'s `to-ledger "$CARDS"` emits card wakes, using
cards archived from the latest remote branch. Configure that caller's absolute
central `wakeRoot` and `stateFile`. Wake files go directly under
`.agents/work/l4/wake/<file>` with `route-<role>`, including unconfigured roles.
Omit `taskCardsRoot` from session-health configuration. Role hooks run
`tick --no-wake`; manual local check/board calls also use `--no-wake`.
These observers and move/defer/done never update central wake receipts.

Legacy waiting cards remain readable. The first check groups their migration
wake by role rather than writing one file per card. Fill the waiting fields,
resume authorized work, record completion with a result, or defer with a reason
and a revisit date. Legacy notices do not suppress overdue or stale warnings.
The next check also reconciles wake state after direct card edits.
