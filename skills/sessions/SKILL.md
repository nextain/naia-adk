---
name: sessions
version: "0.1.0"
description: >
  List, query, or summarize past conversation sessions. Read-only.
  Data via MemoryProvider session history (naia-memory).
tier: T0
triggers:
  - "sessions"
  - "history"
  - "이전 대화"
  - "세션"
input_schema:
  action:
    type: string
    required: true
    enum: ["list", "get", "summarize", "search"]
    description: "Operation"
  sessionId:
    type: string
    required: false
    description: "Specific session id (for get/summarize)"
  query:
    type: string
    required: false
    description: "Search query (for search)"
  limit:
    type: number
    required: false
    description: "Max results. Default: 20"
tags: ["memory", "history"]
author: "naia-adk"
---

# sessions

Spec only — execution by naia-agent reads naia-memory session store. Read-only (T0). Phase 4.0 spec stub.
