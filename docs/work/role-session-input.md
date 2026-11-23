# Existing role session input

## Architecture fit and scope

The request is to restore automatic wake delivery after a role finishes work and
make the repair reusable in Naia ADK. The parent structure is the existing role
wake registry, its single handover command, and stages 4 and 5 of the wake
completion contract. This change supplies a reusable consumer for that command.
Instance paths, users, pane ids, session ids and process identities are explicit
configuration. Model selection and session restart stay with the role manager.

The first implementation supports attached Codex sessions through Herdr and
Codex native JSONL acknowledgements. An instance can delegate only its configured
Codex roles to this consumer while retaining its existing Muse consumer.

## PL-SESSION-INPUT

An input is delivered to the configured existing role session. A successful
receipt requires a native user-message acknowledgement of the same payload.
Pending input survives a busy session, uncertain submission, and receiver restart.
Human drafts are preserved. Transport success alone leaves the input pending.

## UC and function contract

| Scenario | Observable result | Function |
| --- | --- | --- |
| A role finishes work and has a wrapped placeholder plus a long footer | The last input box is recognized as idle | Pure screen classification |
| Foreground reports sudo/bash while Codex is its child | The nearest real agent executable is selected | Transparent-wrapper process traversal |
| Native session is active or the input box contains a draft | Exit 75, original retained, reason recorded | Session and screen preconditions |
| A configured process/thread/cwd differs from the native session | Exit 75, no input | Explicit session binding validation |
| Herdr accepts an atomic prompt and a matching native user message appears | Exit 0, native evidence recorded | Atomic prompt and acknowledgement probe |
| Herdr reports success without native acknowledgement | Exit 75, uncertain attempt retained, no repeated paste | Durable attempt reconciliation |
| Receiver restarts after submission and acknowledgement appears later | Exit 0 without submitting again | Reconcile before replay |
| Another installation uses different users, paths and pane ids | Same behavior through its own configuration | Host adapter configuration |

Attempt records contain the source key, optional original-message id, payload
hash, first/last attempt time, reason and native evidence. They contain no message
body or credentials. A per-role receiver lock prevents concurrent submissions.

The existing dispatcher retains ownership of routing, priority, file retention
and source delivery receipts. The consumer returns 75 for normal deferral. It
creates no task, starts no worker and changes no model. Live activation and
reconciliation of a pre-existing composer draft require instance evidence.
