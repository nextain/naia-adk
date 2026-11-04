# Independent human-response observer

This Node 22 tool observes explicit configured channels with Discord REST and
retains pending human requests. The Gateway remains the only job admission
path. Read [wake completion](wake-completion-contract.md) before configuring.

## Configuration and first run

Copy [the example](../../config/response-watch.example.json) to a private local
configuration path. Replace every placeholder; placeholders deliberately fail
ID validation. Set `stateFile` to an absolute owner-private path and give the
service its token via the environment variable named by `tokenEnv`. Keep tokens
out of JSON, shell history, logs and repository files. Use a dedicated observer
bot, with history/read permissions for watched channels and send permission
only for alert channels.

- `guilds[].id`, `channels[].id`: explicit allowlist, including thread IDs if
  needed. Metadata must match the configured guild. `excludeChannelIds` wins.
- `defaultBotId`: expected executor, overridden by `channels[].botId`.
  `roles` maps role mentions and literal `@<role-name>` to expected bot IDs.
- `mode: mentions` (default) observes addressed requests only. `all-human`
  explicitly assigns otherwise unaddressed posts in a responsibility channel.
  Unaddressed replies to people and mentions to other bots are ignored.
- `nudgeChannelId`: internal re-call destination. `escalation.channelId` and
  `escalation.userId`: accountable-owner notice destination and person.
- `thresholds`: default 10/30 minutes since the source post. With a one-minute
  timer, delivery occurs at the next successful poll after each threshold.
- `sites`: URL and notice `channelId`, optional `failureThreshold` (default 2).
  Probes accept successful HTTP responses, reject redirects and use a timeout.
  URLs must have no credentials, query or fragment. Site checks prove HTTP
  reachability, not application correctness; use a suitable health endpoint.
- `maxPages`: default 100 pages of 100 messages. Reaching the cap records failure
  and retains the cursor; increase deliberately after investigating the gap.

Run with the token already supplied through the authorized environment:

```sh
node scripts/response-watch.mjs --config <private-config.json> --dry
node scripts/response-watch.mjs --config <private-config.json>
```

`--dry` or `DRY_RUN=1` reads/probes and logs preview events without sending or
writing state. The first real successful observation **per channel** stores
only its latest message ID, sending no historical request notices. Site checks
start counting failures silently on first observation, even at threshold 1;
later observations apply the threshold. Adding a new
channel later baselines only that channel. Preserve state across upgrades.

Subsequent scans page back to the durable cursor and process oldest first.
Only an expected bot's explicit Discord reply referencing the original post
closes a pending request. Configure the executor to use that reference. Bot
chatter and another bot's reply do not prove response. A receipt may acknowledge
an unfinished task; assess the actual work result separately.

## State, failures and recovery

State version 1 contains channel cursors, pending request identifiers, timestamps,
stage receipts and site counters. Optional `replies[botId].at` retains the latest
confirmed referenced-reply timestamp (milliseconds since epoch) for
[session progress observation](session-health.md); older version-1 state remains
compatible. Reply progress is committed only with a successful channel scan. It stores no message content or display names.
Pending requests are not silently aged out. Review unresolved requests and state
size during routine maintenance. Keep the directory owner-only and back it up
before manual changes. Atomic rename protects writes. Malformed existing state
fails closed rather than resetting the baseline.

Each message stage is persisted before sending, with a deterministic nonce.
Confirmed sends record Discord message IDs. Known rejected sends can retry on a
later run. A transport/ambiguous send, or interruption after intent, requires
reconciliation and is never automatically replayed. Check the destination for
the notice; after a state backup, record the actual receipt as confirmed or
remove only the exact failed stage when absence is established. Preserve the
source request and cursor. Uncertain site failure/recovery notices follow the
same reconciliation rule.

A state-file `.lock` excludes concurrent real runners. After a crash it may
remain deliberately. Inspect its PID/start time, confirm that exact process is
gone and no other timer/cron runner owns the state, then back up the state and
remove only that stale lock. Never delete a live lock to force progress.
DRY runs have no lock because they never mutate state.

Structured JSON events include trace, stage, result, duration and safe reasons.
Read/permission/pagination failures retain the last cursor and pending work.
Exit codes are 0 for complete, 2 for degraded (including failed site probes),
and 1 for startup/fatal failure. Investigate degraded runs instead of treating
timer process existence as health.
Rotate captured logs with the platform journal or an instance log-rotation policy;
never add raw API bodies or message text to debugging output.

## User systemd example

Create these instance-local user units after reviewing the paths. The referenced
environment file is local, owner-only and never tracked. No unit is installed by
this repository change.

```ini
# response-watch.service
[Unit]
Description=Human response observation
[Service]
Type=oneshot
WorkingDirectory=<adk-path>
EnvironmentFile=%h/.config/response-watch/environment
ExecStart=<node-path> <adk-path>/scripts/response-watch.mjs --config <private-config-path>
UMask=0077
NoNewPrivileges=true
```

```ini
# response-watch.timer
[Unit]
Description=Observe human responses every minute
[Timer]
OnBootSec=1min
OnUnitInactiveSec=1min
Unit=response-watch.service
[Install]
WantedBy=timers.target
```

After configuration and baseline acceptance, an authorized instance operator can
run `systemctl --user daemon-reload` and
`systemctl --user enable --now response-watch.timer`. Inspect
`journalctl --user -u response-watch.service`. Roll back by stopping/disabling
that timer, retaining state and restoring the saved configuration if needed.

## Cron alternative

Choose cron **or** systemd for the same scope. A private wrapper supplies the
existing protected credential environment and absolute paths; it must not echo
its token. Example crontab entry:

```cron
* * * * * <private-wrapper-path> >> <private-log-path> 2>&1
```

The wrapper runs the exact CLI above; retain the state lock and configure log
rotation. Test fake API behavior locally with:

```sh
RESPONSE_WATCH_TEST_TMP=<run-directory>/tmp node --test scripts/response-watch.test.mjs
```

Finish the [server acceptance checklist](server-wake-onboarding.md) before
claiming an instance is aligned.

## Message text

Each instance may set `messages.nudge`, `messages.escalate`, `messages.siteFailure` and `messages.siteRecovered` in its config, for example in its team language or with a prefix its wake sensor recognises. Placeholders: `{bot}`, `{user}`, `{link}`, `{site}`. Missing keys fall back to the English defaults.
