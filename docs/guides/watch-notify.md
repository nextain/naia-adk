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
  without credentials, query or fragment. A value read from the environment is
  checked the same way when an alert is sent; a bad value is a setup failure.
- `tokenEnv` (default `NAIA_MESSENGER_TOKEN`): environment variable holding the
  agent token. The token is never written to configuration or state.
- `channel` (required): messenger channel name or ID for every alert.
- `threadId` (optional): post every alert as a reply in that thread.
- `routes` (optional): per-stage `channel` and `threadId`. Stage names are
  `nudge`, `escalate`, `siteFailure`, `siteRecovered` (response watch),
  `nudge`, `escalate` (session health) and `nudge`, `overdue`, `escalate`,
  `recovery` (request watch). A route with its own `channel` does not inherit
  the top-level `threadId`.
- `mentions`: map from a configured Discord ID to a messenger name (a person's
  name or a messenger role ID). Message templates keep the Discord form
  `<@{user}>`; in messenger mode each `<@id>` becomes `@name`. Where the
  messenger name comes from depends on the watch:
  - Response watch: required for every bot a nudge can mention
    (`defaultBotId`, each channel `botId`, each role `botId`). Its
    `guilds[].roles[].id` are Discord role IDs, so they are never used as
    messenger names; a missing entry fails configuration.
  - Session health and request watch: optional. Without an entry a role's bot
    ID becomes that role's `id`, which in these configurations is the messenger
    role ID.
  - Any other value without an entry is used as is.
- Escalation user: in messenger mode the escalation `userId` is the person's
  messenger name and is used as is, never looked up in `mentions` or the role
  defaults, so a person who shares an ID with a bot is still the one mentioned.
  The Discord notice channel IDs are no longer required.
- `retries` (optional, 0-5): in-process retries for HTTP 429 only. Default 2 for
  `messenger` and 0 for `discord`, so Discord sends once on 429 as before
  unless `retries` is set.

## Receipts and failures

A posted alert stores the messenger message ID in the same state field that
holds the Discord message ID (`messageId` for the response and request
watches, `id` for session health). Failures keep the existing rules:

- Setup failure (missing token or URL, a URL that is not http(s) or carries
  credentials, query or fragment, a failed channel lookup or an unknown
  channel): nothing was posted. Every watch records the stage as `rejected`
  and sends it again on the next run.
- HTTP 4xx other than 429 (or 429 after the retries): nothing was posted. The
  stage is `rejected`, and the response watch and session health try again on
  the next run. The request watch keeps its stricter rule and records it as
  `uncertain`.
- Transport failure, HTTP 5xx or an unreadable receipt: the post may have
  landed. The stage is `uncertain` and is not resent; reconcile by hand.

The messenger API has no idempotency key, so only HTTP 429 is retried within a
run, and on Discord only when `retries` is set. Try a configuration against a local stand-in before pointing `url` at a
real server; `scripts/notify.test.mjs` shows one.
