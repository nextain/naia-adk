---
name: notify
version: "0.1.0"
description: >
  Send notification to a channel. Channel-agnostic spec — concrete adapter
  (Discord/Slack/GoogleChat/etc) is provided by host (naia-os/gateway).
tier: T2
triggers:
  - "notify"
  - "send to"
  - "알림"
input_schema:
  channel:
    type: string
    required: true
    description: "Channel id/name (e.g. discord:general, slack:#dev)"
  message:
    type: string
    required: true
    description: "Notification message"
  priority:
    type: string
    required: false
    enum: ["info", "warn", "urgent"]
    description: "Default: info"
  attachments:
    type: "path[]"
    required: false
    description: "File paths to attach (if supported by channel)"
tags: ["channel", "messaging"]
author: "naia-adk"
---

# notify

Spec only — execution by naia-agent dispatches to channel adapter (naia-os/gateway: Discord/Slack/GoogleChat). Log persistence via naia-memory. Phase 4.0 spec stub.
