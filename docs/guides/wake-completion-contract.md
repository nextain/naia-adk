# Wake completion contract

Use this contract with [manage-discord-sessions](../../.agents/skills/manage-discord-sessions/SKILL.md).
It adds an independent observation of unanswered human posts above Gateway,
admission, 30-second ACK and 120-second channel intervention. Those fast job
controls remain responsible for admitted jobs. The observer does not run a
second Gateway, admit work, bypass permissions or replace session recovery.
A transport ACK proves receipt; it does not prove a useful final answer.

## Stages and evidence

All adapters, including an existing queue consumer, must expose the same
completion evidence. Correlate every record by guild/channel/message, role,
job and attempt. Record UTC time, stage, result, reason code and evidence
reference; store identifiers and safe diagnostics rather than message bodies.
This is an adapter conformance contract; the observer alone does not implement
or certify delivery to a session.

| Stage | Success evidence | Failure and recovery |
| --- | --- | --- |
| 1. Receive | human mention, configured role/name or assigned channel matches | forbidden/unreadable channel: record receive failure; fix scope/permissions |
| 2. Durable cursor | last seen message ID per channel saved atomically with pending request | storage/page failure: retain old cursor, stop affected channel |
| 3. Select owner | exact configured role and bot, route version recorded | ambiguous/missing owner: operator handoff; never guess from bot chatter |
| 4. Deliver | executable child/session identity, cwd and attempt recorded | absent session, busy model, stale profile: bounded recovery or queue; retain obligation |
| 5. Confirm delivery | consumer ACK tied to attempt and original message | queue file alone insufficient; uncertain input must be reconciled before replay |
| 6. Confirm reply | Discord send receipt ID referencing original human message | failed send retries only when known rejected; uncertain send needs reconciliation |
| 7. Close | reply evidence linked to request; remaining work/result recorded separately | ACK/heartbeat is not task completion; failed checks retain open work |

Restart and compression must reload the same entrypoint and durable obligations.
A channel cursor is an observation boundary, not a completion flag. Persist
pending work before advancing it. A restart must neither discard pending work
nor blindly repeat input. Duplicate timers must share one state/lock per observer.
Threads require explicit channel IDs and read permissions; do not assume a
parent-channel history contains thread messages.

## Human-response observation

The [response observer](response-watch.md) detects requests independent of job
admission. Default thresholds are 10 minutes for an internal re-call and 30
minutes for accountable-owner notification. These are measured from the human
post timestamp; they are distinct from the 30-second/120-second job deadlines.
Only configured expected-bot explicit replies prove the reply relationship.
Unreferenced bot activity does not close a pending request. Human replies to
humans and explicitly addressed other bots do not create obligations.
Configure channel-wide responsibility only in channels where it is intended.

Nudges carry original-message links and expected-owner mentions. They ask for a
receipt and expected finishing time in the source channel. They must not copy
private message text into the alert channel. Keep the observer bot separate
from executor identities, and exclude internal alert channels from observation.
If the Gateway already handed off a failed job, correlate by source message
before acting on the observer notice; do not launch a second job automatically.

## Acceptance probe

In a permitted test channel, record time and send one authorized role mention.
Verify all stages and a referenced bot reply inside the instance's declared N
minutes. Repeat with absent session, busy model, restart/compression, denied
channel, uncertain send, duplicate timer and thread binding. Missing evidence
fails that stage even if the process is running. The local fake API tests cover
observer behavior; live adapter conformance remains an instance acceptance task.

Agent-to-agent requests use the deterministic [request follow-up observer](agent-request-followup.md).
