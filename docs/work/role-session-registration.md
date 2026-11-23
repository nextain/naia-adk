# Rebinding a resumed role session after normal startup

## Architecture fit

The original request is to restore automatic role wake delivery at the Naia ADK
level, including normal watchdog recovery without manual PID edits. The parent
structure is the existing role launcher and stage 4 session binding of the wake
completion contract. This work adds explicit launch registration to that
boundary; delivery, scheduling and model selection stay with their current
owners. The already deployed existing-session receiver remains unchanged while
this separate branch is validated.

## PL-SESSION-REGISTRATION

When an authorized launcher resumes the same configured Codex thread, a common
registration adapter records the new actual native process identity and binds
it to that thread's native metadata. The consumer reads the registration as
runtime state, without rewriting instance configuration. New threads require
an explicit registration generation. Old, incomplete, ambiguous or mismatched
registrations leave input pending; an absent registration cannot authorize an
arbitrary latest process or log file.

## Observed launch boundary

Existing role scripts retain literal `exec codex ... resume THREAD` commands.
The installed Codex JavaScript entrypoint uses `process.execve` where available,
and otherwise spawns the native executable as a child. Registration must cover
both forms without confusing the Node wrapper with the native consumer. A
foreground process can own several native session files, including subagents;
file recency or the last open file is therefore not proof of the root thread.

A bounded registration watcher can preserve the existing exec topology: the
launcher records an intent before exec with its PID/start, role, pane, expected
resume thread, target UID and cwd. A script then observes the same frontend or
its known Codex wrapper's nearest native frontend child. The frontend argv must
explicitly resume the expected thread, and its UID/cwd/start identity, exact
argv digest and the configured native session metadata must agree. Planned and
observed argv are metadata only; prompt bodies are never written to the lease.

The frontend and native owner are separate identities. An instance declares
either an embedded backend or an explicit private Unix endpoint. In embedded
mode the frontend must hold the exact configured root rollout. In endpoint mode
the frontend must explicitly name that endpoint with --remote; the server need
not be its child and need not use the role project as its process cwd. Instead,
the configured private socket's exact listener inode must be held by the owner
server PID/start under the declared role UID. That server must hold the exact
root rollout; a read-only thread/read response must agree on the configured
thread, native path, cwd and loaded status. The lease records both identities.
Revalidate endpoint inode and process starts after the probe before publishing.
Other native files or same-UID daemons cannot select ownership.

Implicit daemon discovery and embedded fallback are not inferred from a frontend
PID. Endpoint mode requires an explicit launch policy and actual --remote argv;
embedded mode requires positive root-FD evidence. Existing roles without either
registration proof keep their current fixed profile until a normal opted-in
startup. This adapter never starts a server or resumes a thread to discover it.

The launch intent and ready registration carry a monotonically increasing
role generation and an unpredictable launch id. A late watcher may publish only
while its intent remains current. Intent creation and lease publication use the
same per-role PID/start-time mutex; publication rechecks generation/launch ID
inside that mutex immediately before atomic rename. Resolution reads the
intent/lease pair under that mutex, validates slow process/endpoint evidence
outside it, then reacquires and rechecks both records. A consumer rejects a lease from an older
generation or a different launch id, including after PID recycling. Instance
policy defines the private state path and its trusted UID; another account's
lease is resolved by an explicitly configured `registration.resolve_command`.
This owner-account argv returns only exact registration metadata on stdout; it
does not receive wake bodies. The existing `session.read_prefix` native-log
contract does not implicitly authorize reading private registration files.

## UC matrix

| Scenario | Required result |
| --- | --- |
| Existing script execs the native CLI in place | Same launch PID/start plus explicit resume thread registers |
| Node entrypoint spawns native child | Nearest native Codex under that launcher registers, not Node or a subagent |
| Daemon owns the role thread outside the frontend ancestry | Frontend and owner leases bind through explicit endpoint, listener inode, UID and exact root rollout |
| Another same-UID server exposes another saved thread | Wrong endpoint or root rollout/loaded-thread evidence rejects registration |
| Endpoint is replaced or owner restarts during registration | Changed socket inode or owner PID/start rejects the observation |
| Implicit daemon connect falls back to embedded | No guessed endpoint lease; declared backend needs its own positive evidence |
| Same configured thread resumes after normal recovery | New PID/start lease enables normal delivery without configuration edits |
| Process argv names another thread or has an empty resume selector | Registration rejected; no log recency inference |
| Target UID or cwd differs | Registration rejected |
| PID is recycled while a watcher waits | Old launch intent rejected |
| A second launch supersedes a waiting watcher | Previous generation cannot overwrite the new intent or lease |
| An older lease is restored | Consumer rejects generation regression or launch-id mismatch |
| A new thread is desired | Explicit policy registration is required before input |
| Two installations have different UIDs, paths and wrappers | Same common code and isolated instance state produce equivalent results |

## Implementation boundary and acceptance

This branch may first add common pure validation, an intent/register CLI, a runtime
lease resolver and fake-process fixtures. Owner-side active RPC follows as a
separate phase after these identities are reviewed. Host configs remain operator-owned.
No existing role is restarted, no model is invoked and no live process is used
to prove startup. Acceptance requires fake two-installation cases, native
same-process and Node-child forms, recycled PID, wrong thread and stale lease
rejection, then independent review before any instance launcher adoption.

Open design detail: the role account can own its registration state and expose
it through an independently configured owner-resolution argv, avoiding a
privileged global config writer. Launcher integration must preserve the
role-prompt checker's literal exec inspection. Source fixtures do not install
any launcher hook or demonstrate a live restart.

Configuration and common commands: [registration guide](../guides/role-session-registration.md).
The installation retains its separate normal-launch and restoration runbook.

Topology evidence uses the installed 0.170.0 CLI help and its exact tagged primary
source: [backend selection and startup](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/tui/src/lib.rs)
and [endpoint connection](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/tui/src/app_server_connection.rs).
A separate model-free OS fixture demonstrated an embedded owner and a sibling
server owning the listener/root rollout while its frontend holds neither.
It launched Python test children only; current Codex roles were untouched.
