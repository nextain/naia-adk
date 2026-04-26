---
name: notify
version: "0.1.0"
description: >
  Send notification to a channel. Channel-agnostic spec — concrete adapter
  (Discord/Slack/GoogleChat/etc) provided by host (naia-os/gateway).
  External-channel data leak risk → tier T3 (deny-by-default).
tier: T3
triggers:
  - "notify"
  - "send to"
  - "알림"
input_schema:
  channel:
    type: string
    required: true
    description: "Channel id with adapter prefix (e.g. discord:general, slack:#dev). Host에 등록된 adapter만 허용 (Phase 4.2 enum 검증)."
  message:
    type: string
    required: true
    maxLength: 4000
    description: "Notification message"
  priority:
    type: string
    required: false
    enum: ["info", "warn", "urgent"]
    description: "Default: info"
  attachments:
    type: "path[]"
    required: false
    description: "File paths to attach (host에서 path traversal 검증)"
tags: ["channel", "messaging", "T3"]
author: "naia-adk"
---

# notify

**Tier T3 (deny-by-default)** — 외부 채널로 데이터 송신은 privacy/data-residency risk.

## 보안 정책 (P1-1 fix from paranoid review)

- ⚠ **데이터 누출 위험**: Discord/Slack/GoogleChat 등 third-party 서버에 message 송신
- ✓ **channel은 host adapter 등록 list 검증** (naia-os/gateway가 supported_channels 제공, Phase 4.2)
- attachments 는 host에서 path traversal 검증

## supported channels (host 책임)

naia-os/gateway가 제공하는 adapter 목록:
- `discord:*` — Discord channel
- `slack:*` — Slack channel
- `google-chat:*` — Google Chat space

Phase 4.2에서 host가 spec에 supported_channels enum 동적 wire (Reference P0-2 fix).

Spec only — 실행은 naia-agent supervisor → naia-os/gateway adapter dispatch.
