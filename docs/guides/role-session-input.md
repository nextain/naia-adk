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

Before submission, a busy session may retry with updated work/context headers.
After submission begins, the stored actual payload remains fixed. The receiver
uses Herdr's atomic `agent prompt ... --wait --until working` operation and then
checks for a matching native `response_item` user record after the attempt's
baseline offset. Old identical messages do not acknowledge a new attempt.
An uncertain retry reconciles the saved payload and never pastes again.

`verify` is read-only: it never submits input or writes attempt records. Its
stdout is `{status,attempt,sha256,role,pane,session,receipt,reason,code}`. Accepted
means the same attempt and actual payload have native user-input evidence in
the same bound session. Rejected means no submission occurred and retry is
safe. Unknown exits 75 and preserves the original. The receipt joins source
and formatted-payload digests, first-attempt time and native thread/offset.

## Observations and limits

Private attempt records under `state_dir/role-input/` keep first/last attempt
times, source key/id, hashes, reason, process/session binding and native evidence.
They contain no body. Reasons distinguish screen busy, draft, unknown session,
native read failure and unconfirmed submission. A shared atomic PID/start-time
lock prevents concurrent input and recovers empty, torn, dead or recycled locks.

A native probe reads at most a 64 KiB header and 512 KiB event window. Before
submission, the tail must contain a current native task-state event; otherwise
it defers until a subsequent completion/state event becomes visible. After
submission it reads incrementally from the saved offset. Split append records
retain their starting offset; an unfinished record exceeding 512 KiB is an
explicit read error. No entire large log is repeatedly parsed.

The native acknowledgement proves input reception, not completion of the work.
A transport timeout after paste remains uncertain, including after receiver
restart. Resolving an indefinitely uncertain attempt requires native evidence
or a separate operator recovery; it must not silently re-paste. The original
cause of individual legacy PTY key loss is not established by this adapter.

Validation and use-case mapping: [work contract](../work/role-session-input.md).
