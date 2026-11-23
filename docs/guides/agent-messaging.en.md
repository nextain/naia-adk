# Receiving and replying to work on a messenger

When a person or another role assigns work, reply to the original message before starting the work. Use the requester's language. Mention them, identify what you received and give an estimated completion time. If the timing depends on a missing fact, explain what you will check and when you will update them.

Send the result as a reply to the original message or to its recorded acknowledgment. Include evidence and keep the card open while any required outcome is pending. For example, a role asked to check a deployment can acknowledge the request immediately and post its verified build and acceptance results later.

## Addressing a request

Mention the recipient using the platform's actual identifier. For Discord, use the configured bot or person's mention in the message body. Include the task, the reply location and, for role-to-role work, the configured sender and recipient in the message header. A mention notifies the recipient. A reply reference connects the messages for tracking. Use both on directed replies. Broadcasts and unrelated replies to your own posts can omit a mention.

## What the observers record

The gateway records arrival and can react to a human post. A running role sends its own acknowledgment when it reads the request. Only a result with the required evidence satisfies the work card. See the [wake completion contract](wake-completion-contract.md).

The [role request observer](agent-request-followup.md) tracks requests between configured bot roles. By default it recalls a role after ten minutes without a reply and notifies the requester after thirty. A reply may correlate by mention or by reference to the request or its recorded acknowledgment. An ambiguous unreferenced reply leaves the requests pending. The shared writing rule requires both the mention and the reference. Relaxing `requireMentionInReply` requires an explicit instance setting.

Use a single deadline in the format supported by the instance. The Korean parser recognizes `HH:MM까지` and `내일 HH:MM까지` in the configured `timezoneOffsetMinutes`. After a dated acknowledgment, the observer watches for a result and by default notifies the requesting role twenty minutes after the deadline. For a changed deadline, close the previous request with its actual result and agree the new deadline on a linked request. An acknowledgment without a deadline records receipt only.

## Waiting for a person

Read the earlier thread and proceed with authorized, reversible work. If a decision is necessary, mention the person on the original thread, explain the choice and state when you will check again. Use explicit authorization for actions that require approval. Record the reason and recheck time on the waiting card and link the approval request when applicable. The [work ledger](../common/work-ledger.md) describes the separate observation of unanswered questions.

The [Korean guide](agent-messaging.md) includes message examples and the optional instance-specific name and routing patterns.
