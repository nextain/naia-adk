# Task cards

`scripts/task-cards.mjs` keeps each piece of work a role has taken on as one
card file, checks the cards on a schedule, and can post card events and check
results to Discord or the Naia messenger. Agents that focus on one task tend to
forget the others; the cards keep the list in front of them and in front of the
people who assigned the work.

## Rules

- One card per piece of work: `<cardsDir>/<role>/<YYYYMMDD>-<slug>.md`.
- Cards are never deleted. Work that cannot be done now is deferred with a
  reason and a revisit date. Finished work keeps a result link.
- Every change is appended to `<cardsDir>/ledger.jsonl`. Nothing rewrites it.

Front matter fields: `id`, `title`, `owner`, `status` (`doing`, `waiting`,
`deferred`, `done`), `source` (where the request came from), `received`, `due`,
`next`, `moved`, `calendar` (`yes`/`no`), `progress`, `defer_reason`, `revisit`,
`defer_count`, `result`.

## Commands

```bash
node scripts/task-cards.mjs new --role <role> --title "Release" --source <message link> --due 2026-11-16T09:00 --next "fix the failing test"
node scripts/task-cards.mjs move <id> --next "review" [--status waiting] [--due ...] [--calendar yes]
node scripts/task-cards.mjs defer <id> --reason "urgent work first" --revisit 2026-11-20
node scripts/task-cards.mjs done <id> --result <result link>
node scripts/task-cards.mjs ack --role <role> --ref <message id> --reason "answered in chat, no card"
node scripts/task-cards.mjs list --role <role>
node scripts/task-cards.mjs check [--role <role>] [--json] [--notify]
node scripts/task-cards.mjs board
node scripts/task-cards.mjs tick --role <role> --session <session id>
```

`done` prints the remaining cards by due date and the role's check, so the next
task is picked from the list. `board` writes `<cardsDir>/index.md`. `tick` is
for a session hook: it prints the role's cards at most once per `--every-min`
(default 60) and never fails.

Times are UTC. A bare date means the end of that day.

## Session hook

`.claude/hooks/task-cards-tick.js` runs `tick` from a Claude Code session, so
an agent working on one task sees its other cards once an hour. It is not a
gate: inside the interval it prints nothing, and it exits 0 on any failure.

The role comes from `ADK_AGENT_ROLE`, else from
`.agents/work/task-cards/session-roles.json` (`{"<session id>": "<role>"}`).
Without a role the hook does nothing. The hook is not registered by default;
add it to `.claude/settings.json` on both events:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/task-cards-tick.js\" UserPromptSubmit", "timeout": 5 }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/task-cards-tick.js\" PostToolUse", "timeout": 5 }] }
    ]
  }
}
```

## What check reports

| Kind | When |
|---|---|
| overdue | an open card is past `due` |
| stale | a `doing` card has not moved for `staleHours` |
| revisit date passed | a deferred card's `revisit` has passed |
| missing field | `done` without `result`, `deferred` without reason or revisit, `doing` without `moved` |
| vanished card | the ledger names a card whose file is gone |
| leader request without card | an inbox message from `inbox.leaderIds` has no card `source` or `ack` with its message or event ID (only with `inbox`) |
| not on calendar | an open card has `due` but `calendar` is not `yes` (only with `requireCalendar`) |
| keeps slipping | deferred twice or more, or more than two days past due: add a role or hand the work over |

Inbox links use message IDs and `evt-` event IDs only, read from the
`- Message:` header line. Channel IDs never link, so a card whose source is a
channel URL does not cover every request in that channel. The sender comes from
the `- From: name (id)` header line.

## Configuration

Optional file `config/task-cards.json` (or `--config <file>`); without it the
defaults below apply and nothing is posted. Example:
`config/task-cards.example.json`.

- `cardsDir` (default `docs/team/cards`): relative path inside the repository.
- `staleHours` (24), `sinceHours` (72, how far back the inbox is read).
- `requireCalendar` (false).
- `inbox` (optional): `dir` (relative, one folder per role) and `leaderIds`.
- `notify`: the shared alert block from `docs/guides/watch-notify.md`
  (`kind`, messenger `url`/`urlEnv`, `tokenEnv`, `channel`, `threadId`,
  `routes`, `retries`). Stage names are `event` (card events) and `check`.
- `alerts` (turns posting on):
  - `events` (default `["new", "defer", "done"]`, may add `move`).
  - `owners`: role → recipient mentioned on that role's posts. In messenger
    mode a messenger name (posted as `@name`); in Discord mode a user ID.
  - `linkBase` (optional): https base the card path is appended to, so the
    post links to the card. Without it the post shows the repository path.
  - Discord only: `channelId` and `tokenEnv` (default `DISCORD_BOT_TOKEN`).

## Alerts

A card event posts one line, for example:

```text
[task card] @ops ops/20261112-Release new: Release | due 2026-11-16T09:00 | next: fix the failing test | https://docs.example/repo/docs/team/cards/ops/20261112-Release.md
```

`check --notify` posts one summary (up to 15 problems, then a count) to the
`check` route and posts nothing when there are no problems. Run it from a
schedule (cron or a systemd timer) to get the watch on the messenger.

Failures follow `docs/guides/watch-notify.md`, with one difference: the card
change is already written, so a failed event post prints
`[warn] alert not sent (...)` and the command still exits 0. A failed
`check --notify` prints the check, reports the failure on stderr and exits 3 so
the scheduler shows it. Card events are not resent; `check` reports what
matters on its next run.
