---
name: cron
version: "0.1.0"
description: >
  Schedule recurring or one-shot skill invocations using cron expressions.
  Persistence at $ADK_ROOT/data/cron-jobs.json (host responsibility).
  **Invocation only** — execute another naia skill, NOT shell commands (security: P0-1 fix).
tier: T3
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
    pattern: "^[a-z0-9_-]+$"
    description: "Job name (lowercase alphanumeric + hyphen/underscore)"
  schedule:
    type: string
    required: false
    pattern: "^[0-9*/,\\- ]+$"
    description: "Cron expression (5 or 6 fields, e.g. '0 9 * * 1' = Mon 9am)"
  invoke:
    type: object
    required: false
    description: "Skill invocation envelope (NOT shell command). RCE 방지."
    properties:
      skill:
        type: string
        pattern: "^[a-z0-9_-]+$"
        description: "Target skill name (must exist in catalog)"
      args:
        type: object
        description: "Args passed to target skill"
tags: ["scheduler", "automation", "T3"]
author: "naia-adk"
---

# cron

**Tier T3 (deny-by-default)** — 시간 기반 자동 실행은 사전 승인 절차가 더 엄격해야.

## 보안 정책 (P0-1 fix)

- ❌ **Shell command 직접 실행 금지** — `command: string` 필드 제거됨
- ✓ **Skill invocation 만** — `invoke: { skill: "name", args: {...} }` 형태로 다른 naia skill 호출
- ✓ Target skill의 tier 정책 cascade (예: cron으로 T2 skill 호출 → T2 approval 추가 발생)

Spec only — 실행은 naia-agent supervisor. Phase 4.0 spec; Phase 4.2 wires execution + cascade tier check.
