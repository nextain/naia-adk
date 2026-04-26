---
name: time
version: "0.1.0"
description: >
  Get current time in any timezone. Pure utility — no data, no hardware.
tier: T0
triggers:
  - "time"
  - "what time"
  - "지금 몇시"
  - "현재 시간"
input_schema:
  tz:
    type: string
    required: false
    description: "IANA timezone (e.g. Asia/Seoul, UTC). Default: system tz"
  format:
    type: string
    required: false
    enum: ["iso", "human", "epoch"]
    description: "Output format. Default: human"
tags: ["utility"]
author: "naia-adk"
---

# time

Spec only — execution by naia-agent supervisor (OS time API). Phase 4.0 spec stub.
