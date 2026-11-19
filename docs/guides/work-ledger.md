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

To have an overdue item start its own worker from an instruction file, see the
drive section of the [work-ledger watcher](../common/work-ledger.md). It extends
the JSON ledger the watcher already reads; there is no separate drive ledger.

When a role launches a worker process directly via `systemd-run --user`, use
`scripts/work-ledger/worker-run.mjs` so each run is recorded in the same JSON
ledger (`kind: "worker"`, `status: "running" -> "done" | "failed"`). See the
[worker-run ledger contract](../common/worker-run-ledger-contract.md).

### Publishing a read-only board projection

The board can consume a separate export directory instead of accessing private
ledger files. Create an instance-local JSON config (keep it outside the public
repository), with an absolute output directory and one source per role:

```json
{
  "outputDir": "/srv/ledger-board",
  "sources": [
    { "role": "lead", "path": "/srv/lead/.agents/work/ledger/lead.json" },
    { "role": "assistant", "path": "/srv/assistant/.agents/work/ledger/assistant.json" }
  ]
}
```

Create the output directory in advance. Each source owner needs read access to
its ledger, read access to the config and exporter, and permission to create and
rename files in the output directory. The dashboard account needs traverse and
read access. Use a shared group for the directory; files are published as 0644.
Protect access to the output directory according to the sensitivity of task
names and channel/message identifiers. The exporter writes only active items
(`open`, `waiting_human`, `escalated_human`), their board fields, and a worker's
explicit `alive` boolean if present. Titles default to `작업`; set `public_title` only for text approved for the board. The exporter masks email and recognizable secret patterns as a further precaution. Unknown worker liveness remains unknown.
The update time is `updated_at`, falling back to `checked_at`; missing times
remain unknown. It omits notes, original quotations and worker file paths.
The output directory must not be a source ledger directory or its ancestor; resolved symlink paths are checked before writing. Each file is written to a fresh temporary file and renamed into place. A missing
or malformed source fails the command and leaves its previous export untouched;
other selected roles are still attempted. Monitor cron failures and export age.

Example crontabs for the two source owners (replace paths and roles for the
instance; use absolute executable and config paths):

```cron
* * * * * /usr/bin/node /srv/naia-adk/scripts/work-ledger/export.mjs --config /srv/ledger-board-config.json --role lead
* * * * * /usr/bin/node /srv/naia-adk/scripts/work-ledger/export.mjs --config /srv/ledger-board-config.json --role assistant
```

Install the first line in the lead source owner's crontab and the second in the
assistant source owner's crontab. Repeat `--role` for additional roles owned by
the same user. Configure the dashboard's export directory to match `outputDir`.

Point the API server at the projection with `config/work-board.json` in its
workspace or set `NAIA_WORK_BOARD_CONFIG` to a JSON file. For example:

```json
{
  "exportDir": "/srv/ledger-board",
  "roles": ["lead", "assistant"],
  "guildId": "optional-discord-guild-id"
}
```

The configured roles determine the columns; `guildId` is optional and permits
links to source messages. A relative `exportDir` is resolved against the board
configuration file's directory. The portal ledger API reads only this export,
not `work-ledger.json` or the original ledger files. Without a board config,
the work page falls back to the legacy board. The API also serves the task
badge and schedule projection, which therefore use the same active-only export;
notes, result links and closed items are not included in the export.
