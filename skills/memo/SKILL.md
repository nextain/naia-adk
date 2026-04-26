---
name: memo
version: "0.1.0"
description: >
  Write a memo to long-term memory. Persists via MemoryProvider DI
  (naia-memory layer). Useful for explicit user-requested notes.
tier: T1
triggers:
  - "remember"
  - "memo"
  - "기억해"
  - "메모"
input_schema:
  content:
    type: string
    required: true
    description: "Memo content"
  tags:
    type: "string[]"
    required: false
    description: "Optional tags for categorization"
  importance:
    type: number
    required: false
    description: "Importance 0~1 (memory weighting)"
tags: ["memory", "note"]
author: "naia-adk"
---

# memo

Spec only — execution by naia-agent supervisor invokes `MemoryProvider.encode()` (naia-memory). Phase 4.0 spec stub; Phase 4.2/4.3 wires.
