# Schedule and messenger

The dashboard schedule ([personal schedule](personal-schedule.md)) and the
messenger work together in three ways. None of them adds a new store: reminders
read the existing personal schedule files and the work-board projection, and
"일정에 넣기" writes through the existing `/schedule-personal` API.

## 1. Reminders as messenger posts

`scripts/schedule/schedule-notify.mjs` runs once and exits. It posts:

- personal items: a morning notice on the start day (`morning`, default
  `08:30`) and a notice `beforeMinutes` before a timed item starts. All-day
  items get only the morning notice. A timed item that starts before the
  morning time gets only the before-start notice.
- milestones: a morning notice on the due date, skipped when complete. The
  script reads `milestones.source` (normally the dashboard's
  `/board-schedule`); when the board is not configured it logs and continues.

Each post ends with a `[일정에서 보기]` link to the item's detail on the
schedule screen.

A notice is sent only while the current time is inside
`[notice time, notice time + graceMinutes)`. A run after a long stop does not
flood the channel with old notices. `graceMinutes` and `beforeMinutes` must be
positive whole numbers (not strings such as `"30"`); any other value stops
the script before it reads the state file or posts.

### Configuration

Copy `config/schedule-notify.example.json` to an instance-private file and
fill in:

| Key | Meaning |
| --- | --- |
| `timeZone` | Required. IANA zone for schedule wall-clock values (for example `Asia/Seoul`); the script stops if it is missing or unknown |
| `morning` | Morning notice time `HH:mm`; default `08:30` |
| `beforeMinutes` | Array of positive whole minutes before a timed item starts; default `[10]` |
| `graceMinutes` | Positive whole minutes a notice stays sendable after its time; default `30` |
| `personal[]` | `user` (the personal schedule key), `channel` (messenger channel name or id), optional `mention` text |
| `milestones` | `channel` and `source` URL; omit the block to skip milestones |
| `dashboardUrl` | Origin prefixed to links; empty keeps links relative (`/schedule?...`) |
| `messenger` | `url` (or `NAIA_MESSENGER_URL`) and `tokenFile` (or `NAIA_MESSENGER_TOKEN`) |
| `stateFile` | Receipt file; default `$XDG_STATE_HOME/naia-adk/schedule-notify.json` |
| `personalDir` | Personal schedule directory; default `NAIA_PERSONAL_SCHEDULE_DIR` or the dashboard default |

Issue the token with `scripts/messenger/issue-agent-token.mjs` for a role that
may post in the chosen channels. Personal reminders reveal item titles to
everyone in the channel: point each person at a channel only they (and the
posting role) can read.

### Receipts and duplicates

The state file keeps one receipt per notice key
(`personal:<user>:<id>:<start>:morning|before<N>` or
`milestone:<id>:<due>:morning`) with the messenger message id. A key with a
receipt is never posted again. Moving an item to a new start time makes a new
key.

Before posting, the script records the key as `pending`. If the process dies
after the post but before the receipt is written, the next run reports the key
as `unknown` and does not post it again: a missed reminder is preferred over a
duplicate. If the messenger answers with an HTTP error, the pending mark is
removed and the next run retries. A lock file next to the state file keeps two
runs from overlapping; it is created atomically with the holder's pid, and a
lock is cleared only when its process is gone (or, for an empty lock, after ten
minutes). Receipts older than 14 days are pruned.

Each result is one JSON line on stdout (`sent`, `skipped`, `unknown`,
`failed`, `dry-run`); the exit code is 1 when any post failed. Check a
configuration without posting:

```sh
node scripts/schedule/schedule-notify.mjs --config <file> --dry-run --now 2026-11-12T08:30:00+09:00
```

### Running it

This repository ships only the runner. Run it every five minutes from cron:

```cron
*/5 * * * * cd /path/to/workspace && node scripts/schedule/schedule-notify.mjs --config /path/to/schedule-notify.json >> "$HOME/.local/state/naia-adk/schedule-notify.log" 2>&1
```

or record it in the [regular schedule ledger](regular-schedule-ledger.md) as a
`mechanism.kind: timer` row whose `timer` names that cron entry (status `새로`
until approved and verified). Keep `graceMinutes` larger than the interval.

## 2. Schedule links in messages

`/schedule?item=<layer>:<id>&date=YYYY-MM-DD` (built by `scheduleDetailHref`
in `@naia-adk/core`) opens the schedule screen on that date, turns the layer on
and opens the item's detail once its data loads. Layers are `personal`,
`milestone`, `work` and `queue`.

In the messenger, links to `/schedule` that are relative or on the dashboard's
own origin open inside the dashboard (same tab). Links to other origins stay
ordinary external links.

## 3. "일정에 넣기"

Each message has a calendar button. It opens a side panel with a draft: the
first line as the title, a date (`YYYY-MM-DD` or `M월 D일`) and time (`HH:mm`,
`오후 3시`, `3시 반`) found in the body, and the message link plus body as the
memo. Without a date the draft is today, all day. A timed item lasts one hour.

Saving follows the personal schedule read-then-write contract: GET
`/schedule-personal` for the revision, then POST with `If-Match`; on a
revision conflict it retries once. The request carries no user name. The API
resolves the user from the gate-verified identity header, so the line always
goes to the viewer's own schedule, never the author's or anyone else's.

For the messenger and the schedule to agree on who the viewer is, set
`NAIA_SCHEDULE_USER_HEADER=x-ax-account-key` (the login gate's account header
that the messenger already trusts) alongside `NAIA_GATE_SECRET_FILE`. Without
a verified identity the panel shows the API's refusal and writes nothing.
