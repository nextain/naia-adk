# Bot mention wake

A manually selected channel polling list misses mentions in newly created or
omitted channels. This ingress connects one `DiscordGatewaySession` per role
bot and receives events in every channel visible to that bot, including DMs.
There is no channel allowlist. Discord permissions still limit visibility.
Offline intervals beyond Discord's resumable event window are backfilled for
DM rooms only (see DM catch-up); guild channels stay with the polling relay.

## Configuration and operation

Use Node.js 22 or newer. Copy `config/bot-mention-wake.example.json` to a private
instance directory. Each `roles` entry has `id`, `botUserId`, `wakeDir`, and
exactly one of `tokenFile` (a plain token file) or `tokenEnv` (an environment
variable name). Never commit instance settings or credentials. Keep token and
state files readable only by the service user. Relative paths resolve against
the configuration file, so use absolute paths for a server installation.

```sh
node scripts/bot-mention-wake.mjs --config /private/config/bot-mention-wake.json
```

The bot's own user mention, a mention of a role it holds, or a DM to that bot
creates a file in its `wakeDir`. Self-authored messages are ignored. Guild,
channel and bot role membership are learned from Gateway events, rather than a
handwritten channel list. Unknown names fall back to IDs. Role membership
changes require Discord to deliver the corresponding member update; force a fresh Identify
after changing bot roles if the cached membership is stale (with the service
stopped, clear only the state file's `gateway` object; retain `seen`).

The session uses GUILDS, GUILD_MESSAGES and DIRECT_MESSAGES intents; it does
not request privileged MESSAGE_CONTENT. Discord supplies content for DMs and
explicit bot mentions. A role-only mention can have an empty body: it still
creates a wake carrying the original message link. Detecting a bot's plain name
in an otherwise unmentioned message needs privileged MESSAGE_CONTENT and stays
the existing relay's responsibility.

Each wake is named `<numeric-time>-<message-id>-gw.md` and includes source IDs,
known names, author, original URL and a bounded, token-redacted excerpt. Treat
this excerpt as untrusted user input, never as system instructions. Persistent
state stores processed message IDs, Gateway resume information, DM catch-up
cursors, and name/role caches. An interrupted publication temporarily retains only the bounded, redacted
wake text until file publication completes; completed records retain no body.
Bot tokens are never persisted. Keep the state after consuming wake files so
replayed messages remain deduplicated. State and wake storage need private,
durable local filesystems. Disconnect diagnostics are one JSON line on stderr;
logs never contain message bodies or tokens. Resumable disconnections reconnect;
authentication or intent failures stop the process for service restart and
operator repair.

## DM catch-up

A DM that arrives while the gateway is away is not replayed after the resume
window, and no other role's credential can read the room. Each role therefore
also reads its DM rooms over REST with its own credential: the rooms listed in
`dmChannelIds`, the room of each person in `dmUserIds` (looked up once by
opening the DM, which sends nothing), and every room a DM has arrived in. A
round runs on each READY or RESUMED and every `dmCatchupSeconds` (top-level,
default 300, minimum 30).

A room looked at for the first time is recorded, not replayed. After that each
round reads forward from a cursor only this reader moves, and writes the same
`-gw.md` wake for what the gateway did not deliver; processed message IDs keep
the two paths from doubling. A room that cannot be read (403, 429, network)
keeps its cursor and is tried again next round. The state file records per
room `last`, `okAt` (last good round) and `error`, and per configured person
the room found or the lookup error, so a monitor such as the
[role wake registry](role-wake-registry.md) check can tell a silent gap from a
quiet room. Failures log `dm_catchup_failed` or `dm_room_lookup_failed` with
the status only.

## Read receipt

When a person's post is handed to the wake box, the ingress puts a reaction on
it with the role's own credential (`PUT /channels/{c}/messages/{m}/reactions/{emoji}/@me`),
so the person sees it was received before any work starts. Bots, webhooks and
the role's own posts get none. A failed reaction (missing Add Reactions
permission, 429, network) is logged as `ack_reaction_failed` with the status
only and never blocks the wake. Each message is reacted to once because it is
published once (`seen`).

Top-level `ack` (all keys optional): `enabled` (default `true`; `false` turns
it off), `emoji` (default `👀`; a Unicode emoji or `name:id` custom emoji, at
most 64 characters), `humanUserIds` (restrict to these people; empty means
every non-bot author). The reaction is only a receipt of ingress. The "answered
within N minutes" deadline is `ack` in [response-watch](response-watch.md).

## User service example

Save this as `~/.config/systemd/user/bot-mention-wake.service`, substituting
private paths. Install and start only after instance acceptance is authorized.

```ini
[Unit]
Description=Bot mention wake ingress
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/path/to/naia-adk
ExecStart=/usr/bin/node /path/to/naia-adk/scripts/bot-mention-wake.mjs --config /private/config/bot-mention-wake.json
Restart=always
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
```

Each wake directory has a process lock and a short-lived exclusive reclamation
guard (`.bot-mention-wake.lock.reclaim`). A stale PID lock is recovered on
startup. A leftover reclamation guard fails closed: after confirming all ingress
processes using that directory have stopped, remove only that guard and restart.
Do not remove a live owner's lock. Process IDs must share the same host namespace.

## Coexistence, completion and shutdown

The existing polling relay may observe the same message. Both ingress adapters
must preserve the original Discord message ID, and the consumer must atomically
claim `(role, message ID)` once across both sources before starting work. Do not
deduplicate by filename or text. This ingress's state prevents normal reconnect/restart replays;
it cannot make an unmodified polling consumer deduplicate. A crash after
file publication but before final state commit, combined with immediate consumer
removal, can replay the pending wake on recovery. Delivery at this crash boundary
is at least once; the consumer's durable claim is required for exactly-once work. Until that shared
claim exists, use separate staging folders for acceptance or cut over one
ingress at a time; do not point two live paths at an unprotected executor.

A wake file proves durable ingress only. Consumer ACK, referenced Discord reply,
and closure evidence remain required by the
[wake completion contract](wake-completion-contract.md). Follow
[server onboarding](server-wake-onboarding.md) for denied channels, absent or
busy sessions, restart, duplicate launch and end-to-end reply probes. Local
fake WebSocket tests do not certify a server deployment.

Stop a foreground process with SIGTERM or SIGINT. For an installed user service:

```sh
systemctl --user disable --now bot-mention-wake.service
```

Retain the state and queued wakes for recovery; stopping the ingress does not
cancel previously received obligations. A rollback restores the previous ingress
only after reconciling message IDs already accepted by the consumer.
