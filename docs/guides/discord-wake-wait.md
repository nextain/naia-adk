# One service for Discord and routed wake requests

## User scenarios

An operator starts the existing Discord service once. Direct channel messages
arrive through its Gateway connection, and a local relay publishes requests
under that instance's `wake/` directory. Both routes use the same router and
operator authorization. Restarting the service retains the inbox cursor and
the SQLite ingress deduplication record.

The operator can enable a 30-minute unanswered-request summary for the already
configured proactive DM recipient. A later response from any configured team
bot resolves pending requests in the same channel and guild. A health check
observes the service process's actual working directory and ownership evidence.

## Requirements and tests

| Requirement | Observable result | Test |
| --- | --- | --- |
| UWW-001 | One service receives Gateway messages and direct inbox files; files from already watched source channels are skipped | `wake-inbox.test.mjs`: service timer and restart scenarios |
| UWW-002 | Persist the seen filename/content digest; stable request identity deduplicates admission across cursor-write interruption | `wake-inbox.test.mjs`: restart, retry, and stable identity scenarios |
| UWW-003 | Reject malformed or oversized input; ignore partial files, nested directories, and symlinks; preserve operator authorization | `wake-inbox.test.mjs`; `discord-router-execution.test.mjs` owner-controlled submission scenario |
| UWW-004 | Summaries include requests aged 30 minutes through two hours; configured team bot responses clear them | `unanswered-digest.test.mjs`: age boundary and team bot scenarios |
| UWW-005 | Send link-only summaries to the configured operator; delivery failure preserves eligibility and job health checks | `unanswered-digest.test.mjs`: watchdog delivery scenarios |
| UWW-006 | Observe Linux process cwd together with boot ID and process start identity, independently of command spelling | `wake-inbox.test.mjs`: SQLite heartbeat and child process scenario |

The test files live under `.agents/skills/manage-discord-sessions/tests/`.
Run `pnpm test:discord-sessions` with `TMPDIR` pointing to the execution's
scratch directory. The service integration test uses a fake Gateway socket
and HTTP delivery and runs status commands without launching a model.

## Implementation

`helper/service-runtime.mjs` keeps its Gateway connection and polls the inbox
from the existing 250 ms control timer. `helper/wake-inbox.mjs` implements the
bounded inbox reader. `helper/instance-paths.mjs` provides instance-scoped paths:

```text
naia-settings/.sessions/messenger-sessions/wake/
naia-settings/.sessions/messenger-sessions/wake-seen.json
```

Named instances use `messenger-sessions/instances/<instance>/` instead.
The relay writes an owner-only temporary file and atomically renames it to a
new `*.json` file directly under `wake/`. A request has this shape; replace
the placeholders with locally configured Discord IDs:

```json
{
  "schemaVersion": 1,
  "requestId": "<UNIQUE_REQUEST_ID>",
  "sourceChannelId": "<SOURCE_CHANNEL_ID>",
  "channelId": "<BOUND_OPERATOR_CHANNEL_ID>",
  "authorId": "<OPERATOR_USER_ID>",
  "content": "<REQUEST_TEXT>",
  "access": "read-only"
}
```

`requestId` is 1–128 letters, digits, underscores, or hyphens; IDs are
17–20 digit strings. `sourceChannelId` identifies the relay's source for
overlap checking; `channelId` selects the existing destination binding.
The reader compares the source against configured channel and thread IDs,
then calls `DiscordMessageRouter.submitOperatorRequest`. The destination must
allow that configured operator to start conversations and perform operator
actions. `access` can narrow authority to read-only or be omitted to retain
the destination's existing policy.

The cursor stores filename/content SHA-256 pairs using an atomic rename.
A stable synthetic ingress ID derived from `requestId` also uses the existing
SQLite deduplication path. Keep each request ID unique and publish immutable
files. Correcting malformed JSON changes its digest and permits another read.
The reader accepts files up to 32 KiB, request text up to 4,000 characters,
and up to 4,096 inbox JSON names. The owner can remove processed files;
their cursor entries are pruned on subsequent polls. A corrupt cursor stops
service startup for operator review. Poll failures emit a bounded error code
and leave the ordinary control and stop paths available.

`helper/unanswered-digest.mjs` stores timestamps for at most 1,000 accepted
human requests in memory. `discord.unansweredDigest: true` enables it and
requires the existing `discord.proactiveDmRecipientUserId` to name a configured
operator. `discord.teamBotUserIds` lists other trusted team bots. The service's
own bot also counts as a responder. Bot observations only update notification
state; ordinary bot job admission remains rejected. Summaries contain up to ten
message links and mark entries sent only after confirmed delivery. Entries
older than two hours are removed before observation and delivery. Restart
starts an empty notification queue; durable job recovery remains in SQLite.
Synthetic local submissions are excluded because they have no Discord message
link.

`helper/store-job-writer.mjs` records the Linux process cwd with its heartbeat.
`helper/projector.mjs` compares `/proc/<pid>/cwd`, boot ID, and process start
identity when projecting health. A cwd change within the same generation
is rejected by the heartbeat writer. This accepts relative executable names
while retaining ownership checks. Existing rows without cwd evidence and
platforms without Linux `/proc` retain their boot/start-identity checks;
Windows cwd observation is outside this implementation.
