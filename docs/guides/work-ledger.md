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

Use ordinary block YAML mappings and sequences with two-space indentation,
scalar values and quoted strings. Advanced YAML features (anchors, tags, flow
collections except empty `[]`/`{}`, and multiline scalars) are unsupported by these standalone tools.
Whole-line comments are supported; quote scalar text containing `: ` or ` #`.
JSON documents are also accepted with standard JSON parsing semantics.
Keep names, links, paths and task contents in private instance files. Follow
[regular execution recording](regular-schedule-ledger.md) and
[server acceptance](server-wake-onboarding.md) for the second ledger and rollout.
