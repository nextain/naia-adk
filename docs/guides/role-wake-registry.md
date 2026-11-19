# Role wake registry

One private instance file names the live workspace, the wake boxes and every
role. `scripts/role-wake.mjs` reads only that file, so role lookup, wake
delivery, consumer checks, the role-session table and wake-box retention cannot
point at different trees or different role lists.

Copy `config/role-wake.example.json` to a private path and pass it with
`--config` or `ADK_ROLE_WAKE_CONFIG`. Server differences live in this file
only; the script is the same on every server.

## Registry fields

| Field | Meaning |
|---|---|
| `root` | The one live workspace. `wake_root` and `retention.archive_dir` must stay inside it. |
| `retired_roots` | Old workspace copies. Any unit file, crontab line or process that still uses one is an error. |
| `unit_dirs` | Directories of timer and service files scanned for retired roots. |
| `roles.<id>.pane_label` | Exact `herdr pane list` label used when no instance pane adapter or `find.pane_id` is configured. Defaults to the role's first `names` entry. |
| `roles.<id>.find.pane_id` | Optional exact pane ID; without an adapter it takes precedence over the label and must exist in `herdr pane list`. |
| `pane.adapter` | Optional command that maps `{role}` to one plain pane ID. The adapter must only look up and print that ID; it does not receive the wake file or choose a tool or keys. |
| `roles.<id>.tool`, `tools` | First-choice tool and the ordered list a start script may fall back to. Names are compared lowercase; `tool` must equal normalized `tools[0]`. |
| `tool_caps` | Per-tool wake behavior. Capabilities follow the tool name, not the role name; absent values use the defaults below. |
| `roles.<id>.wake_subdir` | Folder under `wake_root`; `""` is the top-level box. |
| `roles.<id>.extra_boxes` | More boxes of the same role outside `root`: `[{ "path": "/abs", "via": ["sudo", "-n"] }]`. `via` is the command prefix that can read a box another account owns; without it the box is read directly. |
| `roles.<id>.dm_channels`, `dm_users` | DM rooms whose REST catch-up by [bot-mention-wake](bot-mention-wake.md) is checked: by room id, or by the id of the person on the other side when the room id is not known. |
| `roles.<id>.wait` | Optional in-session wait script, checked under the pane's own process tree. `mode: "nudge"` (default) marks a script the role depends on; `"observe"` is recorded only. |
| `delivery` | Common runner settings (`heartbeat_max_age_seconds`, `max_per_run`, `lag_seconds`, `retry_max_seconds`, and optional `baseline_seen_file`). `scripts/role-wake.mjs` reads the file, selects the pane, detects the tool, and delivers directly. |
| `delivery.retry_max_seconds` | Longest gap between retries of a file that failed (default 300). |
| `delivery.baseline_seen_file` | The old deliverer's record, one delivered path per line. Used when a box is first seen; see Migration order. |
| `dm_backup.max_age_seconds` | How old a DM room's last good catch-up may be (default 900). |
| `role_views` | Role lists other tools still keep (`l4-roles`, `wake-routes`, `liveness`, `session-health`, `bot-mention-wake`). Each entry `{ kind, path, roles? }` accepts an optional non-empty string array `roles` listing the role ids that view covers: when set, `role is missing` checks only those ids and any unknown id in `roles` is an error; when omitted, every registry role is required. Every row present in the file—even outside `roles`—is still checked against the registry for unknown roles and mismatched fields (`bot_id`, etc.). |

The role block may keep `user`, `find`, `tool`, `restart_cmd`, and `wait` for
the instance's liveness tool. When `pane.adapter` is set, its command is the
only role-to-pane lookup used by the common deliverer. Without it, the common
deliverer matches `find.pane_id` if present, or matches `pane_label` against `herdr pane list` labels. A configured
adapter failure is an error; it does not fall through to another pane lookup.
An adapter command can be configured like this:

```json
"pane": {
  "kind": "herdr",
  "bin": "/<home>/.local/bin/herdr",
  "adapter": ["python3", "/<private>/liveness.py", "--config", "/<private>/agent-roles.json", "resolve-pane", "{role}"]
}
```

The final output must be one pane ID followed by an optional newline. The
adapter receives the role ID only; the common deliverer passes no wake path,
body, selected tool, or submit keys to it.

## Tool capability table / 도구 능력 표

The optional top-level `tool_caps` map records capabilities by tool name:
`tool_caps.bg_notify.<tool>` is a boolean, and
`tool_caps.submit_keys.<tool>` is a non-empty list of key names. An omitted
entry uses the defaults in this table; unknown tools default to
`bg_notify: false` and `submit_keys: ["Enter"]`. Tool names are normalized to
lowercase. Unknown tool names are allowed and use those generic defaults; an
inspection emits one `tool-capability-fallback` warning for an active unknown
tool. The registry does not guess whether a name is a misspelling. A capability
key that no role declares in `tool` or `tools` remains a validation error.

| Tool | `bg_notify` | `submit_keys` |
|---|---:|---|
| `claude` | `true` | `["Enter"]` |
| `codex` | `false` | `["Enter", "Tab"]` |
| `agy` | `false` | `["Enter"]` |
| `gemini` | `false` | `["Enter"]` |
| `muse` | `false` | `["Enter"]` |
| `opencode` | `false` | `["Enter"]` |

The values in this table are the single documented default source. `agy` keeps
the inspected instance configuration's `false`/`Enter` values. Gemini, Muse,
and OpenCode use the same conservative defaults. The example registry records
Muse explicitly because one role allows it as a fallback tool.

For every file, the common deliverer resolves one pane ID, reads that pane's
foreground process list, detects the running tool, resolves that tool's
capabilities, then uses the same pane ID for input. It sends the file body with
`herdr pane send-text <pane-id> <body>` and sends each configured key in order
with `herdr pane send-keys <pane-id> <key>`. The pane adapter never receives
the body or capability values and cannot choose a different input pane.

Tool detection uses exact executable names in the configured `tools` lists, including descendants of the foreground process and Node `.js` entry points. A shell
launcher name such as `claude-start.sh` does not identify the running tool. If
the foreground process has no configured tool executable, the tool is
`unknown`; delivery uses `bg_notify: false` and `submit_keys: ["Enter"]` and
`check` reports one `tool-capability-fallback` warning. A process that is only
a shell is still a down session.

`bg_notify: true` uses the wake file only when the role declares a
`wait.script` with `mode: "nudge"`, that file exists, and the wait process is
running under the same pane's foreground process tree and is not stopped or a zombie. In all other cases the
common deliverer sends the body and keys directly to the resolved pane. A file
being present in a wake box, by itself, is not a successful delivery. A wait
entry with `mode: "observe"` is not a delivery consumer. Files read from
`extra_boxes` also use direct pane input because the role's wait process cannot
be assumed to read another box. The old
`ROLE_WAKE_TOOL`, `ROLE_WAKE_SUBMIT_KEYS`, and `ROLE_WAKE_BG_NOTIFY` variables
are no longer emitted and have no effect on delivery.

The `validate` command preserves its existing role-ID list and adds one compact
capability row per role under `tool_caps`.

When changing a role's tool, check in one pass that `tool` equals `tools[0]`,
the wake body still reaches the intended pane through the configured wake path,
and the startup script still loads the memory index.

## Consumers do not depend on the tool

A wait script started inside a session exists only for tools that can run
background commands, and it stops whenever the session restarts or compacts.
The common deliverer is every role's direct pane consumer. A live declared
wait process can handle a `bg_notify: true` wake; otherwise delivery falls
back to direct pane input:

- `deliver` sends each new wake file in arrival order
  (file time, then name: box names mix clocks and free titles) and records it
  in `state_dir/delivered-<role>.jsonl`.
- A file that fails is written to `state_dir/failed-<role>.json` and the run
  goes on to the files behind it and to the other roles. The file is retried
  after 60 seconds, doubling up to `retry_max_seconds`; new files go before
  retries and retries with fewer failures go first. Three failures in a row
  end that role's turn for the run (its session is probably down).
- A box seen for the first time is recorded, not replayed: the role's own box
  on the first run, an extra box whenever it is added. With
  `baseline_seen_file`, only the files that record lists count as delivered
  and the rest are delivered.
- A file in a box read through `via` is copied to `state_dir/spool/<role>/`,
  the copy is delivered, and the copy is removed. Extra boxes are never swept.
- A box that cannot be read is an error (`box-unreadable`), never an empty box.
- One run at a time: `state_dir/deliver.lock` carries the owner's pid and
  start time. An empty or damaged lock, a dead owner or a recycled pid is
  taken over; a lock whose owner cannot be verified holds for 30 minutes.
- `state_dir/deliver-heartbeat.json`: `at` says the runner ran, `ok_at` moves
  only when nothing failed. The check reads failures from their own records,
  so a run that fails is not hidden by a fresh `at`.
- `wait` stays optional for direct pane input. A stopped `nudge` wait script is
  an error whether or not delivery runs, because the role depends on it; so is
  a wait state that cannot be read. An `observe` script only warns and never
  counts as the consumer for `bg_notify`.

## DM rooms

The gateway does not replay what it missed beyond its resume window, and one
credential cannot read another role's DM room. [bot-mention-wake](bot-mention-wake.md)
therefore reads each role's DM rooms over REST with that role's own credential
and writes the last good time per room to its state file in the role's box.
List the rooms a role must not miss under `dm_channels` or `dm_users`; the
check raises `dm-backup-stale` when a room has no recent catch-up, and
`role-view-drift` when the gateway tool's own list (`role_views` kind
`bot-mention-wake`) does not name the same rooms.

## Commands

| Command | Effect |
|---|---|
| `validate` | Load and check the registry. |
| `check [--json]` | Read-only. Exit 1 on any error finding. |
| `watch --repair` | `check`, then run `deliver` once if the delivery heartbeat is stale, then send error findings through `notify.command` once per `repeat_seconds`. |
| `board` | Print the role-session table for a status page. |
| `deliver [--role id]` | Run one delivery pass. Install exactly one periodic runner. |
| `sweep [--apply]` | Dry by default. Moves delivered files older than `retention.delivered_days` to `archive_dir/<role>/<yyyymmdd>/`. |
| `view --kind l4-roles\|wake-routes` | Print the role list in an older tool's shape during migration. |

Findings: `retired-root-in-use`, `role-view-missing`, `role-view-drift`,
`session-down`, `pane-unreadable`, `tool-drift`, `tool-fallback`,
`wait-script-missing`, `wait-down`, `wait-unknown`, `delivery-stale`,
`delivery-error`, `delivery-failed`, `delivery-lag`, `box-unreadable`,
`box-backlog`, `dm-backup-stale`.

`deliver` exits 1 when any file failed or any role could not be worked
through. A delivery command that refuses a file for good keeps
`delivery-failed` raised until that file is removed from the box.

Run `watch --repair` from a scheduler other than the one that runs `deliver`
(for example the pane liveness cadence), so one stopped timer cannot hide the
other. Pane restart and the in-session wait nudge remain with the pane
liveness tool; this script does not type into panes.

## Retention

`sweep` never deletes. It moves only files the delivery ledger records, and
leaves undelivered files where they are however old. A name already in the
archive keeps both files (`<name>.dup1.md`), and one file or role in trouble
does not stop the rest. Removing archive folders is a separate decision for
the workspace owner.

## Migration order

1. Write the private registry; run `validate` and `check`. Expect
   `delivery-stale` until step 3.
2. List every other role list under `role_views` and clear each
   `role-view-drift` by making that tool read the registry or by regenerating
   its list with `view`.
3. List every way a wake reaches a role today (makers, deliverers, in-session
   pollers, boxes outside `root`, DM rooms) and map each to the registry:
   `extra_boxes` for outside boxes, `dm_channels`/`dm_users` for DM rooms,
   `wait` for scripts a role still depends on. Do not stop an old path that has
   no row.
4. Stop the old deliverer, set `baseline_seen_file` to its record, then install
   the periodic runner. The first run takes only what that record lists as
   delivered and delivers the rest, so nothing the old deliverer left behind is
   swallowed and nothing it delivered is replayed. Without such a record, run
   `deliver` once while the old deliverer still runs (the first run records
   the existing box contents without replay) and then stop it; a file that
   arrives in between is delivered twice rather than lost. Never leave both
   running. Remove `baseline_seen_file` once every role has a ledger.
5. Install `watch --repair` on a separate scheduler.
6. Run `sweep`, review the counts, then `sweep --apply`.
7. Retire an old DM poller only after `dm-backup-stale` is clear for the rooms
   it covered.
8. Retire units that `retired-root-in-use` names, following
   [server onboarding](server-wake-onboarding.md) backup rules.
