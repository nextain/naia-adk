---
name: system-status
version: "0.1.0"
description: >
  Get high-level OS / runtime status — uptime, version, active services,
  recent errors. Read-only summary. Concrete OS query by host (naia-os).
tier: T0
triggers:
  - "status"
  - "system"
  - "running?"
  - "시스템 상태"
input_schema:
  detail:
    type: string
    required: false
    enum: ["summary", "full", "errors-only"]
    description: "Detail level. Default: summary"
tags: ["system", "read-only"]
author: "naia-adk"
---

# system-status

Spec only — execution by naia-agent (OS query helper by naia-os host). T0 read-only. Phase 4.0 spec stub.
