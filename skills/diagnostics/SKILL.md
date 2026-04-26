---
name: diagnostics
version: "0.1.0"
description: >
  Run system diagnostics — health checks, resource usage, network status.
  OS-aware but POSIX-portable. Concrete OS query by host (naia-os).
tier: T1
triggers:
  - "diagnose"
  - "health"
  - "status check"
  - "진단"
input_schema:
  type:
    type: string
    required: false
    enum: ["all", "cpu", "memory", "disk", "network", "process"]
    description: "Diagnostic category. Default: all"
  process:
    type: string
    required: false
    description: "Process name filter (for type=process)"
tags: ["system", "monitoring"]
author: "naia-adk"
---

# diagnostics

Spec only — execution by naia-agent (OS query helper provided by naia-os host). Phase 4.0 spec stub.
