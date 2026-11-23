# Input to an existing role session

`node scripts/role-session-input.mjs` is a reusable consumer for an instance's
`delivery.command`. It sends input to an existing Herdr pane and accepts delivery
only when the configured Codex native session records the same new user input.
It starts no model, changes no model, and restarts no session.

The instance keeps its existing formatter: Discord context, original reply ids,
attachments and monitor notices must be preserved before transport. Write the
final formatted text to a private file and pass that file to this consumer.
Route only configured Codex sessions here; an instance may retain another
consumer for Muse and other tools. This version does not claim native
acknowledgements for those tools.

## Private configuration

```json
{
  "state_dir": "/private/instance/input-state",
  "pane": { "bin": "/installed/bin/herdr" },
  "roles": {
    "writer": {
      "pane_id": "w2:p6",
      "session": {
        "kind": "codex-jsonl",
        "pid": 12345,
        "process_start": "123456789",
        "thread_id": "configured-existing-thread-id",
        "native_path": "/private/user/.codex/sessions/current-session.jsonl",
        "cwd": "/private/user/project"
      }
    }
  }
}
```

Bind the actual process id and `/proc/PID/stat` start time to its native
`session_meta.id` and `session_meta.cwd`; the process cwd must also agree. Do not
select a session by newest file modification time or desired restart model.
A transparent sudo/shell wrapper is traversed to its nearest actual agent
executable. An optional `session.read_prefix` command array, such as
`["sudo", "-n", "-u", "instance-user"]`, runs the read-only native probe as the
account that owns the configured session. The prefix receives this same Node
CLI path and JSON on stdin; it must be authorized to read only the intended
process/session. A reused PID, other thread/cwd, symlink, rotation or truncation
leaves the input pending.

Run a read-only check before enabling delivery:

```sh
node scripts/role-session-input.mjs probe --config /private/input.json --role writer
```

It returns the binding, current native state, screen classification and reason.
`ready` exits 0; active, draft or unknown exits 75. It injects no input. Preserve
human drafts and any pre-existing uncertain system draft for separate recovery.

## Delivery and verification

```sh
node scripts/role-session-input.mjs --config /private/input.json --role writer \
  --file /private/formatted-wake.txt --source-sha256 ORIGINAL_FILE_SHA256
node scripts/role-session-input.mjs verify --config /private/input.json --role writer
```

The dispatcher supplies `ADK_WAKE_ATTEMPT`, `ADK_WAKE_PAYLOAD_SHA256`,
`ADK_WAKE_ROLE` and `ADK_WAKE_PANE`. The attempt is the canonical key; the SHA is
the bytes handed to the instance receiver, before optional host formatting.
The receiver records that digest alongside the original-source digest and the
actual formatted payload digest. No independent attempt nonce is generated.
Without these environment fields, a standalone invocation uses `--key` (or the
input path) and the input-file digest. The role and pane must agree with config.

A dispatcher attempt that is deferred before submission records an explicit
`not_submitted` phase. That canonical attempt is terminal: it can never submit
later. The dispatcher verifies its rejection and creates a fresh attempt for a
retry, which may carry updated work/context headers.
After submission begins, the stored actual payload remains fixed. The receiver
uses Herdr's atomic `pane run PANE PAYLOAD` operation and then
checks for a matching native `response_item` user record after the attempt's
baseline offset. Old identical messages do not acknowledge a new attempt.
An uncertain retry reconciles the saved payload and never pastes again.

`verify` is read-only with respect to input, native files and attempt records.
It uses the same temporary role mutex as delivery so an in-flight sender cannot
be mistaken for an absent or rejected attempt. Its
stdout is `{status,attempt,sha256,role,pane,session,receipt,reason,code}`. Accepted
means the same attempt and actual payload have native user-input evidence in
the same bound session. Rejected requires an explicit persisted canonical `not_submitted` phase and
means that terminal attempt never submitted; retry requires a fresh attempt id.
A missing journal, held role mutex or unknown phase is not negative proof and
returns unknown 75, preserving the original. The receipt is a compact `codex-jsonl:THREAD:OFFSET:PAYLOAD_SHA256` reference
(or `not-submitted:KEY_SHA256` for rejected). The separate `evidence` object joins
source and formatted-payload digests, first-attempt time and native thread/offset.

## Observations and limits

Private attempt records under `state_dir/role-input/` keep first/last attempt
times, source key/id, hashes, reason, process/session binding and native evidence.
They contain no body. Reasons distinguish screen busy, draft, unknown session,
native read failure and unconfirmed submission. A shared atomic PID/start-time
lock prevents concurrent input and recovers empty, torn, dead or recycled locks.

A native probe reads at most a 64 KiB header and 512 KiB event window. Before
submission, the tail must contain a current native task-state event; otherwise
it defers until a subsequent completion/state event becomes visible. After
submission it reads incrementally from the saved offset. Read-only verification
traverses from that offset to a fixed EOF snapshot in bounded windows, so an ACK
after the first window is found without repeatedly probing only that window. Split append records
retain their starting offset; an unfinished record exceeding 512 KiB is an
explicit read error. No entire large log is repeatedly parsed.

The native acknowledgement proves input reception, not completion of the work.
A transport timeout after paste remains uncertain, including after receiver
restart. Resolving an indefinitely uncertain attempt requires native evidence
or a separate operator recovery; it must not silently re-paste. The original
cause of individual legacy PTY key loss is not established by this adapter.

Validation and use-case mapping: [work contract](../work/role-session-input.md).

## Attempt-state matrix and upgrades

| Persisted state | Verification | Further input under the same canonical attempt |
| --- | --- | --- |
| No record or unknown/old phase | Unknown 75 | No inference of non-submission |
| Sender currently holds role mutex | Unknown 75 | Serialized behind sender |
| Explicit canonical `not_submitted` | Rejected reference | Never; use a fresh attempt |
| `submitting` or `submitted_unconfirmed` | Unknown 75 until exact native ACK | Never repeated |
| Accepted native ACK | Accepted reference | Never repeated |

Without `ADK_WAKE_ATTEMPT`, a standalone file invocation may retry a pre-submit
deferral under the same `--key`. Such a legacy, nonterminal attempt can receive
an accepted native ACK but cannot issue a rejected proof for the dispatcher.
Use canonical environment fields for distributed delivery.

Older journals lacking explicit phase/binding fields stay unknown after upgrade.
Do not silently migrate absence into rejection. An operator must preserve the
original and old records, establish the actual prior consumer version and its
pre-submission evidence, then reconcile that specific attempt. Native ACK
evidence takes precedence when input may already have been received.

## Pane transport and agent metadata

The configured existing Codex process is authenticated by foreground PID/start,
thread, cwd and native session evidence. It need not have been started through
Herdr's managed-agent interface. Stale tool labels or absent agent registration
therefore do not authorize or prevent this consumer's input. The adapter does
not call agent start, change lifecycle authority or replace the current model.

In [Herdr 0.8.0's CLI](https://github.com/herdrdev/herdr/blob/v0.8.0/src/cli/pane.rs),
`pane run` maps one literal payload argument to `pane.send_input` with Enter.
The [server handler](https://github.com/herdrdev/herdr/blob/v0.8.0/src/app/api/panes.rs)
queues the combined buffer once, and its
[encoder](https://github.com/herdrdev/herdr/blob/v0.8.0/src/app/api_helpers.rs)
uses the terminal's live bracketed-paste and keyboard protocol. No shell parses
the payload. Native user-input ACK remains required after transport success.

A structured `pane_not_found` or `invalid_key` response is a definitive failure
before queueing input and records terminal `not_submitted`. Other failures,
including an unstructured exit or timeout, remain uncertain. The journal keeps
only the safe API error code and exit status, never raw stderr or error messages.
Older uncertain attempts are never reset just because this adapter changed.

## Explicit mentions during an active Codex turn

A role may accept an explicitly addressed human Discord message from outside its home channels while the same Codex turn is working. This mode requires the credentialed Gateway, the dispatcher and the receiver to agree on the source. Ordinary priority still controls delivery order. A priority flag, a quoted mention and a Markdown header cannot authorize active input.

In the private bot-mention Gateway configuration, set the role's `activeMentionOriginDir` to a canonical absolute directory outside the wake box. Give the authenticated Gateway exclusive write access. The dispatcher and receiver need read access. The owner of the root, role subdirectory and record must agree. Group and world writes are rejected. An incoming guild message must have a human author, the bot's user ID in Discord's structured mention list and the explicit bot mention in its text. On receipt the Gateway writes a record containing identity fields and a digest of the exact wake bytes before it publishes the wake. The proof contains no message body. Retain proofs while pending messages may still need them.

Configure the same role's existing `bot_id`, `verify_submission` and the dispatcher's `delivery.priority_user_ids`. Register the same policy in the CLI receiver. This example uses a private Unix socket.

```json
{
  "active_mentions": {
    "origin_dir": "/private/gateway-origin",
    "home_channels": ["300000000000000001"],
    "app_server": { "socket_path": "/private/codex/app-server.sock" }
  }
}
```

The normal dispatcher and receiver can share their private `state_dir`. If the receiver keeps its own state directory, set `active_mentions.dispatcher_state_dir` to the dispatcher's private directory. The receiver checks the pending attempt, pane, role, original gateway digest and exact submitted bytes. It also rechecks the Gateway record and configured human IDs. The standard dispatcher can add its work header or group copies of the original message. If a private wrapper reformats the payload, register its deterministic, read-only formatter as `active_mentions.format_command`, an argv array starting with an absolute executable. It receives the original on stdin and emits the formatted UTF-8 bytes on stdout. The wrapper passes the original dispatcher spool filename with `--source-file` and its formatted file with `--file`. The receiver matches both digests before granting active input. An unavailable or differing rendering retains the wake for ordinary idle delivery.

Use the existing owning Codex app-server endpoint. Its Unix domain socket and any Codex-created alias must reside in directories owned by the socket owner. Both directories must restrict writes to that owner, and either the socket or its directory must exclude other users. The adapter uses the project's locked `ws` package to connect directly to that socket. An installation with an authenticated loopback app server can instead register `app_server.url` such as `ws://127.0.0.1:4500` and an absolute `app_server.token_file` containing its capability token. Keep the token file private. The receiver does not start or resume a session.

The adapter reads thread identity, working directory, rollout path and the latest in-progress turn. It calls `turn/steer` with that thread and its expected turn ID. The operation leaves the terminal composer untouched, including an unsent human draft. A matching RPC response is recorded in the private attempt journal. Delivery is accepted only after the native rollout records a new `UserMessage` with the submitted digest, same thread, same turn and a native item ID. An interrupted or unconfirmed transport retains its attempt for read-only reconciliation after restart. Without a verified Gateway origin, an available owning endpoint or an eligible active turn, the original remains in the local wake queue under the usual idle delivery rules.

The active transport was exercised with Codex 0.170.0 and a disposable private terminal session. Sites must confirm their deployed role and owning endpoint, including whether the installed CLI exposes this protocol. Other providers continue through their installed receiver.
