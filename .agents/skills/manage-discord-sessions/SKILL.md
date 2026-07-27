---
name: manage-discord-sessions
description: Manage long-idle Discord AI conversations without keeping a Codex model session alive. Use when designing, operating, or testing Discord-to-Codex session history, prompt-cache cost controls, idle rotation, compaction, or resume behavior.
---

# Manage Discord Sessions

Keep the Discord Gateway listener independent from model execution. Never send
model heartbeats merely to preserve a prompt cache.

## Policy

1. Keep the lightweight Discord Gateway connected while idle.
2. End the Codex process or app-server peer after each completed turn.
3. Reuse bounded transient history only while the session is within its idle
   timeout.
4. At or beyond the timeout, rotate by clearing transient message history before
   dispatching the new user message.
5. Preserve durable task state through project files, Git state, approved memory,
   or an explicit checkpoint. Do not treat a live terminal process as a
   checkpoint.
6. Default the production idle timeout to 30 minutes unless the host has a
   measured reason to choose another value.

## Implementation boundaries

- Put reusable policy, schemas, and operator instructions in `naia-adk`.
- Put Discord ingress, clocks, history storage, and rotation execution in the
  runtime agent.
- Put settings and observability in the client shell.
- Keep bot credentials and user message content out of tracked files and
  diagnostic logs.

## Verification

Inject a short timeout and a fake clock; do not wait in real time.

Verify all three cases:

1. A second message before the timeout receives the bounded prior history.
2. A message exactly at or after the timeout receives only the new user message.
3. Another channel or user retains an independent history and timer.

Also verify that idle time causes no provider call and that rotation emits only
bounded metadata such as the reason and previous message count.
