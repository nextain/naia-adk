# Session health observation

Run one local observer per instance every five minutes. This produces one private
Markdown status sheet for all configured roles. It observes evidence; a running AI
or a recent commit does not establish task correctness. Start with the
[work requirements and scenarios](../work/session-health.md).

## Evidence and decisions

- **Alive:** an adapter identifies the exact role window and AI process. Missing
  windows are `missing`; a shell without an AI descendant is `empty`. Output
  fingerprint changes and session-record mtime establish activity. No change for
  `idleMinutes` (default 30) is `stopped`, subject to the optional work check
  below. The first output sample establishes a baseline, not historical activity.
  Adapter/read failures are `unknown`.
- **Progress:** top-level `workLedger` supplies role-matched `진행 중` rows
  from the [canonical work ledger](work-ledger.md). Each row uses its own
  `updated_at`; unrelated commits, replies and other rows cannot refresh it. Any
  stale active row produces `stalled`. Invalid ledgers display unknown and retain
  existing episodes. Legacy configured Markdown work/todo files supply lines containing
  `진행 중` or `in progress` (case insensitive). Last workspace commit, work-file
  mtime and response-watch confirmed reply timestamp are separate evidence.
  Active tasks without evidence for `staleHours` (default 2) are `stalled`.
  With no progress evidence, time starts at the first observation. File edits or
  replies are only progress proxies; inspect actual deliverables separately.
- **Regular work:** top-level `regularSchedule` reads the
  [execution ledger](regular-schedule-ledger.md). Installed rows without a record
  covering the latest local due occurrence after `graceMinutes` show `안 돎`.
  Each missed occurrence has independent nudge/escalation receipts and the
  schedule signal has its own silent baseline. Invalid schedules remain unknown.
- **Drift:** compare SHA-256 of AGENTS.md, every tracked baseline/current
  `.agents/context/agents-rules*.json`, and the canonical JSON hooks object from
  `.claude/settings.json` against a full pinned `baselineSha` in `baselineRepo`.
  Added/deleted files are included. The sheet lists differing line numbers and
  hashes, never rule contents. `allowedOverrides` contains exact file paths;
  allowed differences stay visible and do not alert. Missing baseline data or
  invalid JSON is `unknown`, never a match. This checks files on disk at the
  declared session workspace, not the model's internal loaded context.
- **After compact:** optional normalized JSONL session records use
  `{"type":"compact","at":"<ISO-time>"}` and
  `{"type":"entry_read","path":"AGENTS.md","at":"<ISO-time>"}`.
  Only a later explicit read proves `confirmed`; compact without it is
  `not observed`; unsupported/absent records are `unknown`. Native session
  records must be normalized by an instance adapter; do not infer rereads from
  ordinary text mentioning AGENTS.md.

## Configuration and adapters

Use [the example](../../config/session-health.example.json) privately. All paths
are absolute. `roles[].workspace` must be the actual session rules root;
`baselineRepo` is a local upstream checkout containing the pinned commit (no
fetch occurs). Use a distinct state/report path from response-watch. Reports
contain task lines and must remain owner-private; default alerts contain only role IDs
and anomaly codes. Configured messages may also include descriptions and the report path. Keep credentials in the environment named by `tokenEnv`. To send alerts to the Naia messenger instead of Discord, set `notify.kind` to `messenger`; see `docs/guides/watch-notify.md`.

`adapter.kind: tmux` uses local list-panes, capture-pane and process descendant
inspection, matching the exact `session:window.pane` target. `aiPrograms` is an
exact executable-name allowlist. No keystrokes or session commands are injected.
`adapter.kind: herdr` executes a configured local `command` argv, without a shell,
which must emit the normalized snapshot below. Herdr CLI variants differ: the
instance wrapper must derive `aiRunning` from actual process evidence, not a
window label. `snapshot` reads a local JSON fixture/export with the same schema.
Commands have a timeout; snapshot producers must atomically replace their file.

```json
{"windows":[{"name":"<window>","aiRunning":true,"output":"<captured-output>"}]}
```

`stoppedRequiresWork` is a top-level boolean, defaulting to `false` for existing
behavior. Set it to `true` to report a quiet running AI as `idle` when a
successfully read `workLedger` has no `진행 중` row matching the role ID and
response-watch has no pending human request for that role's `botId`. `idle`
appears only in the status report and does not create a stopped notification.
An active ledger row or pending request keeps the quiet session `stopped`.
An omitted `workLedger`, unreadable ledger file or invalid ledger also keeps
`stopped`; legacy `workFiles` alone cannot establish that a role has no work.
This option leaves `missing`, `empty`, and independent progress, schedule and
drift anomalies unchanged.

A role waiting on a human can declare when it will look again. Any line in one
of its `workFiles` that starts with `기다림` or `Waiting` and contains
`다음 확인` or `next check` followed by a time turns a quiet `stopped` session
into `waiting` until that time. The time is either ISO 8601 with an offset
(`2026-11-11T00:30:00Z`) or `M/D HH:MM KST|UTC` (the year closest to now). A past
time, or one more than `waitMaxHours` (positive, default 24) ahead, is ignored.
`waiting` creates no notification; `missing`, `empty` and the other anomalies are
unchanged.

`responseWatchState` reuses the observer's `replies[botId].at` confirmed explicit
reply evidence. Missing older response-watch state has no reply evidence.
With `stoppedRequiresWork: true`, pending requests are read from
`channels[channelId].pending[messageId].botId` and matched to `roles[].botId`.
An omitted `responseWatchState` contributes no pending requests. A configured
state that cannot be read or whose pending-request evidence is invalid or
unavailable keeps the quiet session `stopped` and exposes the read error.
`notifications` uses the same nudgeChannelId and escalation.channelId/userId as
response-watch; `roles[].botId` routes the internal recall. No healthy or recovery
notifications are sent. First successful observation of each signal is silent; a failed independent
probe cannot suppress alerts from known signals. Each new
anomaly episode sends one nudge and one escalation after `escalateMinutes`
(default 30); a baseline anomaly remains eligible on the next observation.
Intent is saved before sending; ambiguous delivery stays blocked until an operator
backs up state and reconciles that exact receipt. Known HTTP 4xx rejection may
retry. Restart preserves episodes and receipts. Probe errors remain visible and
exit 2, without converting unknown into an anomaly claim.

### Alert wording

Optional top-level `messages.nudge` and `messages.escalate` customize each stage,
including Korean or another language. Omitted stages keep the exact legacy
`<@{user}> Session health {role}: {code}` wording. Both support:

| Placeholder | Value |
| --- | --- |
| `{user}` | Target user ID: role bot for nudge, escalation user for escalate; use `<@{user}>` for a mention |
| `{role}` | Role ID |
| `{code}` | Full anomaly code, including a missed schedule occurrence |
| `{codeText}` | Description from top-level `codeText`, falling back to the raw code |
| `{report}` | Absolute `reportFile` path, not report contents |

`codeText` maps codes to plain descriptions with the problem and the responsible
person's next action. Exact code matches take priority; `schedule-missed` covers
all `schedule-missed:<occurrence>` codes. Descriptions are inserted literally,
without recursively expanding placeholders. See the example configuration for
Korean wording. Including `{report}` discloses its path to the configured channel;
choose wording appropriate for that channel. Discord mentions remain restricted
to the stage's target user.

`messages` must be an object containing only `nudge`/`escalate`, with non-empty
string values and the placeholders listed above. `codeText` must be an object
mapping non-empty codes to non-empty strings. Invalid settings fail validation
before evidence collection or notification delivery.

```sh
node scripts/session-health.mjs --config <private-config.json> --dry
node scripts/session-health.mjs --config <private-config.json>
```

DRY (`DRY_RUN=1` also supported) reads evidence and previews status/alert counts,
without writing files, locking, or posting. Real runs use an exclusive state lock
and atomic state/report replacement. On a stale lock, confirm the recorded PID
and start time no longer own a runner before backing up state and removing only
that lock. Malformed state fails closed. Use owner-only parent directories and
platform journal rotation. Configure the response-watch service example with
this script/config, a distinct unit name, and `OnUnitInactiveSec=5min` (or cron
`*/5 * * * *`); install only after authorized instance acceptance. Stop the timer
to roll back and retain state. No timers are installed by this repository.
