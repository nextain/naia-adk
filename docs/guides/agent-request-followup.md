# Agent request follow-up

The independent `scripts/agent-request-watch.mjs` observer tracks requests between
configured role bots using Discord REST. It uses addressing, timestamps and reply
relationships; it does not ask a model to classify prose. Existing human
[response observation](response-watch.md) and [session health](session-health.md)
continue to serve their own scopes.

## Request, receipt and result rules

A request is a normal message or reply authored by a configured bot, addressed
to another configured role by any of these forms:

- Discord bot mention, such as `<@BOT_ID>`.
- Message heading `[A → B]`, using configured IDs or aliases for both roles.
- Body addressing `B에게`, `B께`, or a line beginning `- B:`.

A plain occurrence of a name creates no request. Human posts, unknown bots,
webhooks and self-addressing are ignored. Each addressed target gets its own
obligation. These are addressing rules: even a greeting with a direct mention
counts. Use unaddressed prose for commentary that needs no receipt.

A receipt must come from the expected target bot in the same configured channel
or thread. It must explicitly reply to the request (or its recorded receipt),
or mention the requesting bot. An unreferenced mention is accepted only when
exactly one open request matches; use a referenced reply when several are open.
A receipt is consumed before new requests are detected so it does not create a
reverse obligation. Threads must be explicitly allowlisted; parent history does
not include their posts.

A receipt without a readable end time closes receipt tracking. It proves receipt,
not completion. A receipt with one readable end time remains tracked until the
next correlated reply by the expected target. That reply is the deterministic
result signal; the observer does not assess result quality. Executors should send
one receipt with a deadline and then one referenced result. Extra progress replies
can satisfy this signal, so use a separate uncorrelated status stream if needed.

Only `HH:MM까지` and `내일 HH:MM` (optionally followed by `까지`) are parsed.
Hours and minutes must be two digits and valid. Multiple matching times, malformed
times and other wording give no deadline. `timezoneOffsetMinutes` supplies the
fixed offset from UTC (for example 540 for Korean time); daylight-saving zones
require an instance-specific offset update. A same-day time already passed is
immediately overdue; use `내일` for tomorrow. No natural-language inference occurs.

## Follow-up stages

| Trigger | Action | Recipient |
| --- | --- | --- |
| No receipt after 10 minutes | Re-call and read-only session-health check | Target bot |
| Health says missing, empty or stopped | Ask recovery owner to restore session | Configured recovery role |
| No receipt after 30 minutes | “아직 답 없음 — 다시 부를지·다른 역할인지” | Requesting bot |
| Receipt deadline passed without result | Re-call and health check | Target bot |
| Still no result 20 minutes after deadline | Ask whether to re-call or change role | Requesting bot |

The deadline escalation delay is `escalateMinutes - nudgeMinutes` (20 by default).
Thresholds are measured from the source timestamp, not the time first observed.
Delivery occurs on the next successful poll. Health errors are unknown evidence,
produce a degraded run, and are retried; unknown is never declared dead. Recovery
is a notification to an accountable role, not an automatic process restart.

## Configuration and safety

Copy [the example](../../config/agent-request-watch.example.json) to a private
instance path and replace placeholders. Configure:

- `roles`: unique `id`, `botId`, optional `aliases`, and optional `wakeDir`.
- `guilds[].id` and `guilds[].channels[].id`: explicit allowed channels/threads.
- `stateFile`: private durable observer state, separate from other observers.
- `sessionHealthConfig`: existing valid session-health configuration with matching
  role IDs; checks run in dry mode without writing health state or sending notices.
- `recovery.roleId`: role accountable for restoring stopped target sessions.
- `tokenEnv`: protected environment variable, default `DISCORD_BOT_TOKEN`.
- `thresholds`, `timezoneOffsetMinutes`, `maxPages`: timing and history limits.
- `messages`: instance wording; example Korean messages are included in the config.

A role with `wakeDir` receives a Markdown wake file in the bot-mention-wake shape.
The wake file uses a deterministic synthetic decimal `Message ID` for each stage,
with `Original Message ID` and the original URL retained. Consumers must use the
synthetic ID only for deduplication and the original URL for Discord replies;
verify this adapter behavior during instance acceptance. Otherwise the observer
posts a bot mention in the original channel. Keep the
observer identity distinct from all executor identities, to prevent self-generated
requests. Give it only read-history access to the allowlist and send access when
Discord delivery is selected. Tokens belong in a protected environment, never JSON.

```sh
node scripts/agent-request-watch.mjs --config <private-config.json> --dry
node scripts/agent-request-watch.mjs --config <private-config.json>
```

`--dry` (or `DRY_RUN=1`) reads and previews without writing state, locks, wake files
or messages. First real observation baselines each channel at its latest message;
old history generates no alerts. Preserve state across upgrades. History is paged
back to the durable cursor; incomplete scans retain that cursor and obligations.

Each request keeps independent per-stage intent and confirmed/uncertain receipts.
An uncertain delivery is never automatically replayed. Inspect the destination,
back up the state, then reconcile only the affected stage using actual delivery
evidence. Keep pending requests, source IDs and cursor intact. Closed requests are
retained for audit; review state growth during maintenance. Malformed state fails
closed. Atomic writes and a state-file `.lock` protect real runs from overlap.
After a crash, confirm the exact owning process has stopped and back up the state
before removing a stale lock. Never remove a live lock to force another run.

Logs contain structured stages, trace IDs, safe reasons and durations. Rotate
captured logs with the host journal or existing log policy. Exit codes: 0 complete,
2 degraded, 1 startup/fatal failure. A wake file proves publication, while consumer
ACK and channel reply remain separate [completion evidence](wake-completion-contract.md).

## Three-server rollout procedure

Perform this checklist separately on each of the three instances; configuration
and acceptance are per server. This repository change installs no service.

1. Select one owner per channel scope and observer state; avoid overlapping watchers
   on multiple servers. Copy the generic config to a private path on that instance.
2. Fill its local role bot IDs, aliases, wake directories, guild/channel allowlist,
   recovery role, session-health path and fixed timezone offset. Back up any
   existing destination config and its symlink target before replacing it.
3. Supply the observer token through an owner-only environment file. Review a dry
   run and first-run baseline. Verify read permissions and all five role mappings.
4. In an authorized test channel, exercise explicit addressing, receipt, two open
   requests, 10/30-minute follow-up, deadline result, stopped session, restart and
   duplicate execution. Confirm the actual wake consumer accepts every stage.
5. After operator authorization, use the user systemd service/timer pattern in
   [response-watch](response-watch.md), replacing its CLI/config/unit names with
   `agent-request-watch`; poll once per minute with `UMask=0077`. Choose either
   systemd or cron, with exactly one runner for each state file.
6. Record each server's config location, baseline, wake-consumer ACK, channel reply,
   recovery-owner receipt and timer owner. Complete the
   [server acceptance checklist](server-wake-onboarding.md). Roll back by stopping
   that observer timer while retaining state and restoring the backed-up config.

Local verification:

```sh
TMPDIR=<run-directory>/tmp node --test scripts/agent-request-watch.test.mjs
```
