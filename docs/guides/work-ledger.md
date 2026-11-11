# Work ledger

Keep one private `work-ledger.yaml` per server, copied from
[the example](../../config/work-ledger.example.yaml). Enter an instruction as
soon as it arrives. Assign a stable ID and role, one-line task, status, request
time, deadline, original instruction link, result link and last update time.
Use `진행 중`, `대기`, `막힘` or `끝`. On completion set `끝`, add the actual
result link and update the timestamp. Use ISO-8601 timestamps with an offset;
use null for an undecided deadline or a result that does not exist yet.

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

## Time promises

Record a promise in this same ledger before sending it. The command requires an
existing valid ledger, the responsible role, a future ISO-8601 deadline with an
offset, the source channel identifier and the original message reference:

```sh
node scripts/promise-ledger.mjs add --ledger /private/work-ledger.yaml --role role-a --title 'Send the draft' --due 2030-01-01T13:00:00Z --channel channel-a --message message-reference
node scripts/promise-ledger.mjs check --ledger /private/work-ledger.yaml --channel channel-a --text-file /private/message.txt
```

The added row has status `진행 중` and stores `source_channel` and
`source_message`; `evidence` also stores the message reference. Use the same
channel identifier in the check. The `checkPromise` and `containsPromise`
exports provide the same check to a sender without binding it to a messenger.
The CLI prints a JSON decision and exits 0 when allowed, 2 when blocked, and 1
when inputs cannot be read or validated. A sender must treat both nonzero exits
as a refusal and run the check immediately before sending. Merely installing
this command does not intercept existing senders.

The check detects common Korean and English time-commitment phrases. An optional
`--patterns-file` points to a JSON array of regular-expression strings that
replaces the defaults; supply trusted expressions appropriate to the instance.
Language detection is heuristic and cannot prove all promises are detected.
For a detected promise, any `진행 중` row with the same `source_channel` and a
strictly future deadline permits sending. This reproduces the source guard's
channel-level condition: it does not establish that the row describes the same
promise, nor compare the promised time with the row's deadline. Operators must
verify those details. A missing, malformed or unreadable ledger is an error.
The add command locks and atomically replaces the regular ledger file, refuses
symlinks and duplicate IDs, and rewrites its YAML without comments. Coordinate
other writers using the same `<ledger>.lock` and retain any required backup.

Session health reports `work-overdue:<row hash>:<deadline milliseconds>` for
each `진행 중` work row whose deadline has passed, including promise rows.
With notifications configured, its existing nudge and escalation mechanism
alerts the role and then the escalation recipient. The first successful ledger
observation establishes a silent baseline; an overdue row is alerted on the
next successful run. The session health report maps each code to the row ID,
task and deadline. Alert episodes survive unreadable ledgers and close when
the row is no longer overdue or active. `대기`, `막힘` and `끝` rows are not
treated as open; choose status deliberately when a promise remains outstanding.

Use ordinary block YAML mappings and sequences with two-space indentation,
scalar values and quoted strings. Advanced YAML features (anchors, tags, flow
collections except empty `[]`/`{}`, and multiline scalars) are unsupported by these standalone tools.
Whole-line comments are supported; quote scalar text containing `: ` or ` #`.
JSON documents are also accepted with standard JSON parsing semantics.
Keep names, links, paths and task contents in private instance files. Follow
[regular execution recording](regular-schedule-ledger.md) and
[server acceptance](server-wake-onboarding.md) for the second ledger and rollout.
