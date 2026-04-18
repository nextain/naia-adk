---
name: channel-management
version: "0.1.0"
description: Manage Discord/Slack channels — create, archive, notify, summarize.
triggers:
  - "channel management"
  - "디스코드 관리"
  - "슬랙 관리"
  - "채널"
input_schema:
  action:
    type: enum
    values: [create, archive, notify, summarize, list]
    required: true
  platform:
    type: enum
    values: [discord, slack, google-chat]
    required: true
  channel:
    type: string
    required: false
  message:
    type: string
    required: false
output:
  side_effects:
    - description: "Channel operations via webhook adapter"
      adapter: "channel"
steps:
  - id: "validate"
    action: "Check platform adapter configured"
  - id: "execute"
    action: "Perform channel action"
  - id: "log"
    action: "Record operation"
failure_policy:
  retry: true
  rollback: false
  on_failure: "notify"
idempotency: true
---

# Channel Management

Super-individual operates multiple communication channels from one place.
