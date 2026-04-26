---
name: cron
version: "0.1.0"
description: >
  Schedule recurring or one-shot tasks using cron expressions.
  Persistence at $ADK_ROOT/data/cron-jobs.json (host responsibility).
tier: T2
triggers:
  - "schedule"
  - "remind"
  - "cron"
  - "정기"
  - "예약"
input_schema:
  action:
    type: string
    required: true
    enum: ["add", "list", "remove", "run-now"]
    description: "Cron operation"
  name:
    type: string
    required: false
    description: "Job name (required for add/remove/run-now)"
  schedule:
    type: string
    required: false
    description: "Cron expression (e.g. '0 9 * * 1' = Mon 9am)"
  command:
    type: string
    required: false
    description: "Command or skill invocation to run"
tags: ["scheduler", "automation"]
author: "naia-adk"
---

# cron

Spec only — execution by naia-agent supervisor. Data persistence by host (naia-os) at `$ADK_ROOT/data/cron-jobs.json`. Phase 4.0 spec stub; Phase 4.2 wires execution.
