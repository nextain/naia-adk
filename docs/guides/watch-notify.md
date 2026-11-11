# Watch alert channel: Discord or messenger

The response watch (`scripts/response-watch.mjs`), session health
(`scripts/session-health.mjs`) and agent request watch
(`scripts/agent-request-watch.mjs`) send their alerts through one shared module,
`scripts/notify.mjs`. The `notify` block in each watch configuration picks where
alerts go. Observation does not change: the response watch and the request watch
still read Discord channels; only the alert post moves.

## Choosing the channel

- `"notify": { "kind": "discord" }` is the default and the same as leaving the
  block out. Alerts are posted to the Discord channel IDs already in the
  configuration with the bot token from `tokenEnv`.
- `"notify": { "kind": "messenger", ... }` posts to the Naia messenger through
  its agent API (`POST /api/portal/messenger/channels/<id>/messages`, header
  `X-AX-Agent-Token`). Issue the agent token with
  `scripts/messenger/issue-agent-token.mjs` and give that agent access to the
  target channel.

Messenger fields (see `config/watch-notify-messenger.example.json`):

- `url` or `urlEnv` (default `NAIA_MESSENGER_URL`): the API origin, http(s),
  without credentials, query or fragment.
- `tokenEnv` (default `NAIA_MESSENGER_TOKEN`): environment variable holding the
  agent token. The token is never written to configuration or state.
- `channel` (required): messenger channel name or ID for every alert.
- `threadId` (optional): post every alert as a reply in that thread.
- `routes` (optional): per-stage `channel` and `threadId`. Stage names are
  `nudge`, `escalate`, `siteFailure`, `siteRecovered` (response watch),
  `nudge`, `escalate` (session health) and `nudge`, `overdue`, `escalate`,
  `recovery` (request watch). A route with its own `channel` does not inherit
  the top-level `threadId`.
- `mentions` (optional): map from a configured ID to a messenger name. Message
  templates keep the Discord form `<@{user}>`; in messenger mode each `<@id>`
  becomes `@name`, so the person or role is mentioned there. Without a map
  entry, a role bot ID becomes the role ID and any other value is used as is.
  In messenger mode the escalation `userId` may be a messenger name directly,
  and the Discord notice channel IDs are no longer required.
- `retries` (optional, 0-5, default 2): in-process retries for HTTP 429 only.

## Receipts and failures

A posted alert stores the messenger message ID in the same state field that
holds the Discord message ID (`messageId` for the response and request
watches, `id` for session health). Failures keep the existing rules:

- HTTP 4xx other than 429 (or 429 after the retries), a missing token or URL,
  an unknown channel, or a failed channel lookup: nothing was posted. The
  stage is `rejected`, and the response watch and session health try again on
  the next run.
- Transport failure, HTTP 5xx or an unreadable receipt: the post may have
  landed. The stage is `uncertain` and is not resent; reconcile by hand.
- The request watch keeps its stricter rule: any failed post is `uncertain`.

The messenger API has no idempotency key, so only HTTP 429 is retried within a
run. Try a configuration against a local stand-in before pointing `url` at a
real server; `scripts/notify.test.mjs` shows one.
