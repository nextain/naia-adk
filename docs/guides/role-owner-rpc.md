# Active-turn RPC as the registered role account

The existing active-turn client can run through an explicitly configured owner
account helper. This supports a central dispatcher whose UID cannot open a role's
private socket. The helper uses the same common source for each installation;
role names, UID, endpoint, executable and session paths remain private settings.

This adapter does not create or attach an app server. A normal authorized launch
must already have registered the frontend and the server owning the exact loaded
thread. See [registration](role-session-registration.md) and the
[phase-2 contract](../work/role-session-owner-rpc.md).

## Fixed installation commands

In each owner's private receiver configuration, register the Unix backend and
the fixed probe command. `probe-thread` runs before lease publication, verifies
the configured UID and endpoint/thread/cwd/path, then performs only `thread/read`
with `includeTurns: false`. It does not resolve a lease recursively or load a
saved thread. Both idle and active already-loaded threads can be observed.

```json
{
  "registration": {
    "uid": 1234,
    "backend": {
      "kind": "unix",
      "socket_path": "/private/owner/codex.sock",
      "server_executable": "/installed/codex/native/codex",
      "probe_command": [
        "/usr/bin/node", "/installed/adk/scripts/role-owner-rpc.mjs",
        "probe-thread", "--config", "/private/owner/input.json", "--role", "writer"
      ]
    }
  }
}
```

The central profile additionally selects the owner RPC with absolute trusted
argv. This is independent of its native-read and registration-resolve commands.
The fixed owner configuration must describe the same role policy. An authorized
account adapter may supply the UID switch without granting arbitrary shell
commands or opening private directories to other users.

```json
{
  "active_mentions": {
    "origin_dir": "/private/gateway/origins",
    "dispatcher_state_dir": "/private/dispatcher/state",
    "app_server": {
      "command": [
        "/usr/bin/sudo", "-n", "-u", "role-owner", "/usr/bin/node",
        "/installed/adk/scripts/role-owner-rpc.mjs", "rpc",
        "--config", "/private/owner/input.json", "--role", "writer"
      ]
    }
  }
}
```

Keep the existing `bot_id`, Gateway origin policy, dispatcher priority authors,
source-file formatter and canonical attempt settings. The account helper is only
the transport. Without `app_server.command`, existing local socket/token profiles
retain the direct client. Other providers retain their installed receiver.

## Identity and result

`role-owner-rpc/v1` JSON on stdin binds the configured role, exact frontend and
owner PID/start/UID, lease generation/launch ID, native file identity and endpoint
identity. The helper loads its fixed config, verifies its effective UID, resolves
that current lease and compares the binding before opening its endpoint. A known
registered frontend is selected only inside the actual foreground ancestry;
sibling process order cannot select an unrelated worker.

`inspect` returns only the current in-progress turn and never sends input.
`steer` uses the exact expected turn and passes text as one JSON value. No shell
parses it. Replies contain hashes, turn and result metadata, with no body, token
or raw error. Requests are limited to 1 MiB, replies to 64 KiB and child execution
to six seconds. Slow calls defer; they do not restart a role or choose a new turn.

A successful RPC is transport evidence. The central receiver still requires a
new native `item_completed` UserMessage for the same thread, expected turn and
exact actual-payload digest. Without it, the canonical attempt remains uncertain.
Repeated verify or delivery for that attempt sends no further input. A late
matching native ACK completes it; another turn or payload cannot.

Only a correlated helper report proving it never sent a steer, or failure to
launch its executable, establishes non-submission. Timeout, crash, malformed
reply and generic nonzero exit after helper launch remain uncertain. Existing
opaque attempts are preserved rather than reset during upgrade.

## Rollout and recovery

Validate one fixed source with registration, existing idle/active/legacy tests,
two account policies and real helper/Unix/native-ACK fixtures before deployment.
The fixtures use temporary shell and Node processes, never a production model.
Linux `/proc`, UID and Unix-endpoint fixture suites skip other platforms; pure
protocol tests remain platform-independent. Active inspection requests thread
metadata without turns, followed by one latest turn with items not loaded. A
multi-megabyte history fixture verifies that these responses stay bounded.
Install the dependency closure from the same lockfile; verify `ws` resolution as
both execution accounts. Source archives without dependencies are insufficient.

At a coordinated normal lifecycle window, preserve the explicit resume thread
and profile-selected model, then run the intent/watch hook before the existing
literal exec. Publish a new lease only after that launch proves both identities.
Do not revive an old PID/start binding during rollback. Restore saved launcher
and command settings if needed and hold the affected role's automatic delivery
until the current existing session is explicitly rebound. A separately reviewed
idle-only receiver remains a fallback; active delivery requires its own lease.
Preserve pending originals, attempt journals and uncertain records throughout.

Operating acceptance requires normal scheduled idle delivery after a normal
start, a real human mention during a working turn and a deferred stalled-card
continuation. Each needs the bound native ACK. Test-source readiness alone does
not claim those live lifecycle or work-completion results.
