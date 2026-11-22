# Personal schedule

Open `/schedule` for the calendar. Existing `/work?view=schedule` bookmarks
redirect there and keep the query, including the item and date in a calendar link.

The dashboard schedule combines a personal calendar with work items and
milestones from the work board. The personal layer is stored separately for
each authenticated user as `schedule/personal/<user>.yaml`. Configure
`NAIA_PERSONAL_SCHEDULE_DIR` to select that directory; otherwise the dashboard
server uses `packages/dashboard/data/schedule/personal`. Keep personal
data private and outside version control.

The dashboard accepts a configured identity header only after its entry guard
has verified the gate secret and the requesting peer. Configure
`NAIA_GATE_SECRET_FILE`, `NAIA_SCHEDULE_USER_HEADER` (or
`NAIA_NOTE_USER_HEADER`), and, when necessary, `NAIA_IDENTITY_TRUSTED_PROXIES`.
The secret file must be an absolute path to a regular file with mode `0600`
and at least 32 characters. Without verified identity, the personal API
returns 403. For a single-user device, `NAIA_SCHEDULE_SINGLE_USER` explicitly
selects one user; leave it unset in a multi-user installation. When
`NAIA_GATE_SECRET_FILE` is set, `NAIA_SCHEDULE_SINGLE_USER` is ignored and a
request without a verified identity header returns 403.
The gateway must remove every client-supplied copy of the configured identity
header and replace it with the authenticated user's own value. A shared gate
secret alone does not prove that a forwarded user header is authentic.
Identity values must be 1–40 characters: lowercase ASCII letters, digits,
Korean syllables, period, underscore or hyphen; the first character must be a
lowercase letter, digit or Korean syllable, and `..` is not allowed. Uppercase
ASCII and email addresses are rejected. The gateway must send a unique,
canonical lowercase key for each account, including on case-insensitive file
systems, and never map different accounts to the same key.

For an HTTPS gateway that forwards requests to the dashboard over HTTP, set
`NAIA_SCHEDULE_PUBLIC_ORIGIN` to the exact external origin, including scheme
and any non-default port, for example `https://dashboard.example.test`. The
gateway must pass the external `Host` header. When an `Origin` header is
present, writes require it to match the validated Host and configured public
origin. Add a public hostname to `NAIA_DASHBOARD_HOSTS` when the host guard
does not already allow it. Without this setting, writes use the request URL's protocol and the
validated Host. Forwarded-protocol headers alone do not grant this trust.

The file contains an `items` list. Dates are local calendar values, expressed
as `YYYY-MM-DD` for all-day events or `YYYY-MM-DD HH:mm` for timed events.
Items may also include an optional `beforeMinutes` positive integer for
per-item reminder lead time. The calendar uses the browser's local time zone;
the work-board projection uses the server runtime's local time zone. For example:

```yaml
user: "person"
items:
  - id: "meeting-1"
    title: "Planning"
    start: "2026-11-11 10:00"
    end: "2026-11-11 11:00"
    allDay: false
    memo: ""
    beforeMinutes: 15
```

The dashboard's `/schedule-personal` endpoint reads and modifies only the
resolved user's file. Parsing warnings are returned to the caller and block
writes with HTTP 409, so unsupported or invalid content is not silently lost.
GET returns a `revision` string. Every POST, PUT, PATCH and DELETE must send
the latest revision in the `If-Match` header; missing or malformed values are
rejected with 428, and a revision from an older file produces 409. Reload after
a conflict before applying the change again. Both dashboard and CLI writes share
the same storage, locking and permission rules.
Comments also produce warnings and block screen edits because rewriting the
file would discard them; edit such files directly or preserve the comments
elsewhere before removing them. Writes ensure the personal schedule directory
is `0700` (non-symlink) and write `<user>.yaml` via an `0600` temp file and
atomic `rename` after comparing the file identity and bytes around the read and
immediately before replacement. If the file changed, writes abort with conflict
and leave the changed file in place. An external editor that does not use the
lock can still write between the final comparison and replacement, so coordinate
external edits with scheduled writes or stop writes while editing the file.

Both `/schedule-personal` and the secretary CLI use an exclusive `<user>.yaml.lock`
file (`O_CREAT | O_EXCL`, mode `0600`, `O_NOFOLLOW`, rejecting symlinks). If a
writer crashes while holding the lock, the lock stays blocking (`personal-schedule-busy`)
for 30 seconds; locks older than 30 seconds are safely reclaimed via a verified
lock-break check before re-acquiring, and each writer only removes the lock whose
device and inode it created.
The shared `readPersonalSchedule(userKey, dir)` function in `@naia-adk/core`
is read-only; server-side and notification consumers read through it without
bypassing the write lock contract.

## Secretary CLI and Delegation ACL

Secretary agents write to a user's personal schedule through
`scripts/schedule/personal-schedule-cli.mjs` rather than editing `<user>.yaml`
directly:

```sh
node scripts/schedule/personal-schedule-cli.mjs read \
  --dir /path/to/personal --user luke

node scripts/schedule/personal-schedule-cli.mjs add \
  --dir /path/to/personal --user luke --actor-role alpha \
  --title "1:1 Sync" --start "2026-11-20 14:00" --end "2026-11-20 15:00" \
  --before-minutes 15 --memo "Room B"

node scripts/schedule/personal-schedule-cli.mjs update \
  --dir /path/to/personal --user luke --actor-role alpha \
  --if-match '"<64-hex-sha256>"' --id ps-... --title "Updated Sync"

node scripts/schedule/personal-schedule-cli.mjs delete \
  --dir /path/to/personal --user luke --actor-role alpha \
  --if-match '"<64-hex-sha256>"' --id ps-...
```

- **Directory and target validation**: `--dir` defaults to
  `NAIA_PERSONAL_SCHEDULE_DIR` (or `packages/dashboard/data/schedule/personal`).
  `--user` is checked with `safeUserKey` (canonical lowercase, no `..`, `/`,
  or symlinks).
- **Optimistic concurrency**: `update` and `delete` require `--if-match <revision>`;
  `add` optionally accepts `--if-match <revision>` to guard against concurrent
  changes. Commented or warned YAML files are never overwritten.
- **Delegation ACL (`NAIA_SCHEDULE_DELEGATES` / `--delegates`)**: Every write
  (`add`, `update`, `delete`) requires `--actor-role <role>` and an explicit
  `(actorRole -> targetUser)` entry in `NAIA_SCHEDULE_DELEGATES` (for example
  `alpha:luke,jina:luke`) or `--delegates` (comma-separated pairs, JSON string,
  or non-symlink JSON file path; wildcards are rejected). Unlisted pairs fail
  immediately with exit code `1` and `403 Forbidden: role not delegated`.
- **Audit log and output**: Each authorized write appends one line to
  `<dir>/.audit.jsonl` (mode `0600`, `O_NOFOLLOW`) with
  `{ "at", "action", "actor": "role:<role>", "user", "itemId" }` and prints JSON
  containing `{ "ok": true, "id", "revision", "href": "/schedule?item=personal%3A<id>&date=<YYYY-MM-DD>" }`.

The [regular schedule ledger](regular-schedule-ledger.md) is a separate record
of recurring work, approvals and execution results. Personal calendar entries
do not create timers, approve work or alter that ledger.

The messenger side (reminder posts, schedule links in messages and the
"일정에 넣기" action) is described in [schedule and messenger](schedule-messenger.md).
