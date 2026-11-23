# Registering the same role session after normal startup

The optional registration adapter renews a role's existing Codex PID/start binding
after an authorized normal startup. It selects no model, starts no app server,
resumes no thread itself and sends no wake text. Fixed profiles and other
providers keep their current path unless explicitly opted in.

The [work contract and use cases](../work/role-session-registration.md) distinguish
source fixtures from installing a launcher hook or validating a live restart.

## Explicit role policy

Add `registration` to the existing input-consumer role profile. All paths and the
UID belong to the installation. The frontend executable is the actual native
Codex binary; `node_entry` identifies its known JavaScript launcher when Node
spawns the native child instead of replacing itself.

```json
{
  "pane_id": "w2:p7",
  "session": {
    "kind": "codex-jsonl",
    "thread_id": "11111111-2222-4333-8444-555555555555",
    "cwd": "/private/role/project",
    "native_path": "/private/role/current-thread.jsonl"
  },
  "registration": {
    "uid": 1234,
    "state_dir": "/private/role/registration",
    "launcher_executable": "/usr/bin/bash",
    "frontend_executable": "/installed/codex/native/codex",
    "node_entry": "/installed/codex/bin/codex.js",
    "backend": { "kind": "embedded" }
  }
}
```

The role account owns its canonical 0700 directory and 0600 records. Intent and
lease contain boot identity, generation, launch ID, process and root-file identity,
and argument digests. They contain no prompt bodies or model arguments. A new
thread or UID requires an explicit policy change and a fresh registration.

## Existing launcher hook

Run `intent` after the launcher's normal `cd`, immediately before its existing
literal Codex exec. Stdin is the exact planned argv as a JSON array, including
the explicit resume UUID and existing model settings. Preserve the literal exec
line used by static prompt checks. Do not use a last-session picker or rewrite
model/effort flags in this adapter.

```sh
node /installed/adk/scripts/role-session-registration.mjs intent \
  --config /private/role/input.json --role writer --launcher-pid "$LAUNCHER_PID"
# Planned argv JSON is supplied on stdin. Retain intent.launch_id from stdout.
node /installed/adk/scripts/role-session-registration.mjs watch \
  --config /private/role/input.json --role writer --launch-id "$LAUNCH_ID" \
  --timeout-ms 30000
```

Intent creation must succeed before the opted-in launcher proceeds. The CLI
retries a transient role mutex at most three times with 100 ms pauses. Start the
bounded watcher in the background before exec, with detached stdin and private
stdout/stderr logs. It must not consume the TUI's input. `observe` checks once;
`watch` retries for at most thirty seconds. A timeout or ineligible observation
returns 75 with its reason, without fabricating a lease or starting another role.

Boot identity is Linux `/proc/sys/kernel/random/boot_id`. The frontend is the
same launcher PID after exec, or its known Node wrapper's nearest native child.
Changed PID/start, executable, UID/cwd, argv or root rollout leave input pending.
Intent creation, generation recheck plus atomic lease rename, and pair resolution
share one per-role PID/start-time mutex. Slow process/endpoint validation runs
outside that mutex; resolution reacquires it and compares the entire intent and
lease before returning. A superseded observer cannot publish an older lease.

## Separate owning server

Embedded mode requires the frontend to hold the configured root rollout itself.
For a separate existing private endpoint, replace `backend` with:

```json
{
  "kind": "unix",
  "socket_path": "/private/role/app-server.sock",
  "server_executable": "/installed/codex/native/codex",
  "probe_command": ["/installed/role/read-owning-thread"]
}
```

The frontend must explicitly name that endpoint with `--remote unix://PATH`.
Its owner may be outside the frontend's ancestry and use another process cwd.
The configured UID/PID/start must own both that listener inode and the exact
root rollout. The socket and canonical/alias parents retain private same-owner
write permissions. Listener and process identity are checked again after probing.

The absolute fixed probe argv is a trusted, read-only installation component.
It reads `{socket_path,thread_id,native_path,cwd}` JSON on stdin and returns
`{thread:{id,cwd,path,status:{type:"idle"|"active"}}}`. It inspects the already
owning server only; it must not start a server, load/resume a saved thread or
change a turn. An unloaded saved thread cannot prove ownership. Implicit daemon
selection or embedded fallback cannot be inferred from a TUI PID.

This phase implements registration. The standard owner-side active RPC adapter,
owning endpoint installation and actual normal-restart acceptance are separate
integration gates.

## Reading private state from another account

A central consumer in another UID needs an independent explicit
`registration.resolve_command`, for example:

```json
[
  "/usr/bin/sudo", "-n", "-u", "role-owner",
  "/usr/bin/node", "/installed/adk/scripts/role-session-registration.mjs",
  "resolve-stdin"
]
```

It receives only `{role,profile}` metadata, never a wake body. The owner-account
helper reads and revalidates its private lease and returns exact session metadata.
The consumer keeps its configured thread/cwd/native path, foreground checks and
native ACK requirement. Existing `session.read_prefix` does not implicitly grant
registration access. No private directory or socket permissions are widened.

Use `probe --config FILE --role ROLE` for local owner-side read-only resolution.
Resolution may take a temporary mutex but never rewrites intent, lease or native
data. Missing, malformed, superseded or inaccessible state returns 75. A fresh
input deferred before submission retains terminal negative proof; an existing
uncertain submission remains uncertain and never pastes again after renewal.

Native headers, process/FD probes and replies are bounded. Repeated endpoint
validation uses the recorded owner hint, not a full search for the newest file.
Actual acceptance still requires two authorized normal starts and fresh normal-pump
native ACK after current work and collaboration children finish.

The source's model-free OS/CLI tests exercise exec-in-place, a Node foreground
wrapper with a separate native child, and an unrelated endpoint owner. They use
disposable shell/Node fixtures and a fake pane adapter, never a production Codex
process. The consumer checks the registered frontend against the foreground
ancestry; the registration resolver independently checks the native owner.
