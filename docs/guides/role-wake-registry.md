# Role wake registry

One private instance file names the live workspace, the wake boxes and every
role. Role lookup, wake delivery, consumer checks, the role-session table and
wake-box retention use the workspace and role list from this registry.

Copy `config/role-wake.example.json` to a private path and pass it with
`--config` or `ADK_ROLE_WAKE_CONFIG`. Server differences live in this file
only; the script is the same on every server.

## Registry fields

| Field | Meaning |
|---|---|
| `root` | The one live workspace. `wake_root` and `retention.archive_dir` must stay inside it. |
| `retired_roots` | Old workspace copies. Any unit file, crontab line or process that still uses one is an error. |
| `unit_dirs` | Directories of timer and service files scanned for retired roots. |
| `roles.<id>.find.pane_id` | The session pane. The foreground program of this pane decides whether the session is alive and which tool it runs. |
| `roles.<id>.tool`, `tools` | First-choice tool and the ordered list a start script may fall back to. `tool` must equal `tools[0]`. |
| `roles.<id>.wake_subdir` | Folder under `wake_root`; `""` is the top-level box. |
| `roles.<id>.ledger` | Optional path to the role's JSON work ledger, relative to `root` or absolute. A role listed in `config/work-ledger.json` uses the standard ledger path when this field is omitted. |
| `roles.<id>.extra_boxes` | More boxes of the same role outside `root`: `[{ "path": "/abs", "via": ["sudo", "-n"] }]`. `via` is the command prefix that can read a box another account owns; without it the box is read directly. |
| `roles.<id>.dm_channels`, `dm_users` | DM rooms whose REST catch-up by [bot-mention-wake](bot-mention-wake.md) is checked: by room id, or by the id of the person on the other side when the room id is not known. |
| `roles.<id>.wait` | Optional in-session wait script, checked under the pane's own process tree. `mode: "nudge"` (default) marks a script the role depends on; `"observe"` is recorded only. |
| `roles.<id>.verify_submission` | Optional read-only command that checks the receiving session's acceptance of an interactive input. Its argument array supports `{role}` and `{pane}`. See “Verify interactive submissions” below. |
| `delivery.command` | Instance command that puts one wake file in front of a role (`{role}`, `{file}`). |
| `delivery.workHeader` | Set to `true` to prepend the role's work ledger summary to a private delivery copy. Defaults to `false`. |
| `delivery.busy_probe` | Optional command array with `{role}` and `{pane}` placeholders. At the start of a role's delivery attempts it may report `busy` or `idle` on stdout. The delivery summary records `true`, `false`, or `null` when the probe fails, times out after five seconds, or returns another value. Delivery proceeds in each case. |
| `delivery.retry_max_seconds` | Longest gap between retries of a file that failed (default 300). |
| `delivery.priority_user_ids` | Optional Discord user ids whose direct requests may precede older inputs. Defaults to `[]`. |
| `delivery.baseline_seen_file` | The old deliverer's record, one delivered path per line. Used when a box is first seen; see Migration order. |
| `dm_backup.max_age_seconds` | How old a DM room's last good catch-up may be (default 900). |
| `role_views` | Role lists other tools still keep (`l4-roles`, `wake-routes`, `liveness`, `session-health`, `bot-mention-wake`). Each entry `{ kind, path, roles? }` accepts an optional non-empty string array `roles` listing the role ids that view covers: when set, `role is missing` checks only those ids and any unknown id in `roles` is an error; when omitted, every registry role is required. Every row present in the file—even outside `roles`—is still checked against the registry for unknown roles and mismatched fields (`bot_id`, etc.). |

The role block keeps the keys the pane liveness tool already reads (`user`,
`find`, `tool`, `restart_cmd`, `wait`), so that tool can read the registry
file directly instead of a second list.

## Consumers do not depend on the tool

A wait script started inside a session exists only for tools that can run
background commands, and it stops whenever the session restarts or compacts.
The registry therefore requires a consumer that runs outside the session:

- `deliver` hands each new wake file to `delivery.command` in arrival order
  (file time, then name: box names mix clocks and free titles) and records it
  in `state_dir/delivered-<role>.jsonl`.
- Configured priority users are recognized only from gateway files whose first
  Discord metadata block agrees with the filename's message id and recipient
  role. The metadata author must be configured, and the URL must identify a
  registered role DM or the original body must explicitly mention that role's
  bot. Quoted metadata, ledger notices and unrelated public messages retain
  their ordinary order. A route copy inherits its gateway group's priority.
  Priority groups run newest first. After three successful priority handovers,
  the oldest eligible ordinary input gets a turn. The per-role streak survives
  runner restarts; deferred or failed attempts do not consume this allowance.
  Original files and previous receipts are preserved.
- Gateway and route relays for the same Discord message are handed over once
  per role. Direct relay filenames or Discord wake metadata identify the message.
  The body is read before grouping so ledger notices retain their
  own delivery attempts, including stalled-card notices with a source id in
  the filename. Reference links inside ordinary notes keep their original
  meaning and do not identify the note itself. Agent-request observer notices
  retain their separate stage identity.
- A successful message handover adds a `message:<id>` receipt to the existing
  delivery ledger. A later relay for that id is recorded as `duplicate` without
  another handover. Old successful direct-relay filename receipts also supply
  message ids when read. First-seen `baseline` rows supply file history only.
- A merged input contains at most 32,768 characters. Larger groups are handed
  over as complete originals. These original-only file receipts carry
  `message_id: null`, so a run limit cannot discard the remaining originals.
  Merged spool files are created when a handover is
  attempted and removed after success or failure.
  When work headers are enabled, the original Discord metadata selects the
  matching work card before the merged input is formatted. Remote box reads
  are reused within a pass, while a retry reads the current work ledger.
- A delivery command that exits 75 defers the current input. Its originals
  remain pending, any old failures for those files are cleared, and that role
  stops handing over inputs for this pass. The next scheduled pass can retry
  without failure backoff. The summary counts deferred files separately and a
  deferred input does not make the delivery heartbeat fail.
- A file that fails is written to `state_dir/failed-<role>.json` and the run
  goes on to the files behind it and to the other roles. The file is retried
  after 60 seconds, doubling up to `retry_max_seconds`; new files go before
  retries and retries with fewer failures go first. Three failures in a row
  end that role's turn for the run (its session is probably down).
- On first inspection of a role's own box or a newly added extra box, the
  deliverer records the files already present. It delivers any new-format
  work-ledger escalation or worker-result notice, because the watcher issues
  each change only once. With `baseline_seen_file`, a listed path counts as
  delivered, including a card notice, and the remaining paths are delivered.
- A file in a box read through `via` is copied to `state_dir/spool/<role>/`,
  the copy is delivered, and the copy is removed. Extra boxes are never swept.
- The work-ledger watcher writes addressed files to the top-level wake box.
  A file ending in `-route-<role>.md` is eligible only for the named registered
  role, including roles with their own subdirectories. Untagged files belong to
  the role configured for their directory.
- A box that cannot be read is an error (`box-unreadable`), never an empty box.
- One run at a time: `state_dir/deliver.lock` carries the owner's pid and
  start time. An empty or damaged lock, a dead owner or a recycled pid is
  taken over; a lock whose owner cannot be verified holds for 30 minutes.
- `state_dir/deliver-heartbeat.json`: `at` says the runner ran, `ok_at` moves
  only when nothing failed. The check reads failures from their own records,
  so a run that fails is not hidden by a fresh `at`.
- A role with neither `delivery` nor `wait` is rejected when the file loads.
- `wait` stays optional. A stopped `nudge` wait script is an error whether or
  not delivery runs, because the role depends on it (it may be the only reader
  of the box, or the role's channel poller); so is a wait state that cannot be
  read. An `observe` script only warns.

## Work ledger at delivery

With `delivery.workHeader` enabled and a ledger configured for the role,
`deliver` places the header and a blank line before the original body in a
private spool copy. A missing, unreadable or invalid ledger gives the wake
a single `[장부 읽기 실패: …]` line and its original body. The deliverer reads
the ledger as its own OS user, including when `via` reads the wake file.
Retries keep the original wake's key and read the current ledger each time.
For a stalled-card wake addressed to the receiving role, the header lists
the named card first, including on repeat and escalated wakes.
For an instance acceptance check, confirm that the configured delivery
command forwards the spool copy's header to the pane along with the body.

The header applies to `delivery.command`. Wait-only consumers, in-session
liveness wakes, drive notifications (`drive.notify.command`), and the Gateway
router use their own delivery paths. The optional busy probe records status
while the configured delivery command handles queuing.

For roles using the delivery command alone, a successful exit records a
handover. A process killed between sending and recording the handover can
leave an uncertain delivery. The per-run limit bounds attempts in one pass.

## Verify interactive submissions

On an interactive role whose adapter can observe accepted input, set
`"verify_submission": ["/private/adapter", "verify", "{role}", "{pane}"]`
in that role's registry entry. The delivery command keeps its `{role}` and
`{file}` arguments. The pump passes both commands `ADK_WAKE_ATTEMPT`,
`ADK_WAKE_PAYLOAD_SHA256`, `ADK_WAKE_ROLE`, and `ADK_WAKE_PANE`. The digest
covers the exact private copy handed over, including any work header or
merged messages. The pump saves the attempt before calling the delivery command.

The verifier reads the receiver's native input history or acknowledgement
store. On exit 0 it can return one JSON object with `status` equal to
`accepted`, the matching `attempt`, `sha256`, `role` and `pane`, and opaque
`session` and `receipt` identifiers. Before typing, persist the receiving
session identity and its native input cursor alongside the attempt. Use a
native correlation ID, or a newly accepted user input beyond that cursor
whose payload and origin uniquely match this attempt. Retain that mapping
across restarts. A displayed draft, successful keystroke, or unrelated turn leaves
the attempt pending. Use identifiers free of message content. The identifier
fields accept 1–256 ASCII letters, digits, or `_.:@+/-`.

The common composer classifier recognizes a clipped Codex empty-input hint only
when it is one nonblank row, an exact prefix of `Ask Codex to do anything`
containing at least the complete `Ask Codex` token, and every non-whitespace
payload character has explicit dim styling. That token is nine ASCII characters
including its internal space. Plain or partially styled text, shorter prefixes,
paste markers, disabled-input hints and additional input rows retain their
previous classification. RGB/indexed color parameters alone do not establish dim.
Busy/native-active checks, existing complete-hint compatibility and native ACK
requirements remain unchanged. `screenState` keeps its original receiver import
path; its pure implementation shares `composer-screen.mjs` with the CLI.

If the adapter finds a busy pane **before it types**, record a terminal
`rejected` decision for this attempt and exit 75. The verifier returns the
same correlated fields with that decision and its receipt. The next pump
pass may present the work when the pane is ready. Report `rejected` only
when this attempt cannot still produce an accepted input. After typing or a
timeout, return no conclusive receipt until the receiving session settles
the attempt. The verifier may exit 75 while waiting. The pump keeps the
originals pending and checks again on the next pass without repeating input.
An absent history entry alone is insufficient for a terminal rejection.

Accepted receipts are kept with the original filenames in the delivery
ledger. An unresolved attempt stays in `state_dir/submissions/<role>.json`.
Keep its verifier available through configuration changes. During installation,
test busy-to-idle delivery, a late native receipt after a pump restart, and
two successive inputs with the same text. Check the native receipt IDs
against the delivery ledger. [Wake completion contract](wake-completion-contract.md)

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
   existing files and delivers one-shot card notices) and then stop it; a file that
   arrives in between is delivered twice rather than lost. Never leave both
   running. Remove `baseline_seen_file` once every role has a ledger.
5. Install `watch --repair` on a separate scheduler.
6. Run `sweep`, review the counts, then `sweep --apply`.
7. Retire an old DM poller only after `dm-backup-stale` is clear for the rooms
   it covered.
8. Retire units that `retired-root-in-use` names, following
   [server onboarding](server-wake-onboarding.md) backup rules.
