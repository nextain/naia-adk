# Personal schedule

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
selects one user; leave it unset in a multi-user installation.
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
The calendar uses the browser's local time zone; the work-board projection uses
the server runtime's local time zone. For example:

```yaml
user: "person"
items:
  - id: "meeting-1"
    title: "Planning"
    start: "2026-11-11 10:00"
    end: "2026-11-11 11:00"
    allDay: false
    memo: ""
```

The dashboard's `/schedule-personal` endpoint reads and modifies only the
resolved user's file. Parsing warnings are returned to the caller and block
writes with HTTP 409, so unsupported or invalid content is not silently lost.
GET returns a `revision` string. Every POST, PUT, PATCH and DELETE must send
the latest revision in the `If-Match` header; missing or malformed values are
rejected with 428, and a revision from an older file produces 409. Reload after
a conflict before applying the change again. Messenger or other future clients
must follow the same read-then-write contract.
Comments also produce warnings and block screen edits because rewriting the
file would discard them; edit such files directly or preserve the comments
elsewhere before removing them. Dashboard writes use an exclusive lock and
compare the file identity and bytes around the read and immediately before
replacement. If the file changed, the API returns 409 and leaves the changed
file in place. An external editor that does not use the lock can still write
between the final comparison and replacement, so the comparison cannot promise
an atomic compare-and-replace. Coordinate external edits with dashboard writes
or stop writes while editing the file.

If a dashboard process exits while holding the lock, its `<user>.yaml.lock`
file may remain and subsequent writes return `personal-schedule-busy`. Before
removing a stale lock, confirm that no dashboard process is currently writing
that user's file; preserve the schedule file and inspect it for incomplete
external edits. Do not remove a lock merely because it is old.
The shared `readPersonalSchedule(userKey, dir)` function in `@naia-adk/core`
is read-only; server-side consumers can use it without introducing a second
write path. A future messenger integration can consume this boundary.

The [regular schedule ledger](regular-schedule-ledger.md) is a separate record
of recurring work, approvals and execution results. Personal calendar entries
do not create timers, approve work or alter that ledger.

The messenger side (reminder posts, schedule links in messages and the
"일정에 넣기" action) is described in [schedule and messenger](schedule-messenger.md).
