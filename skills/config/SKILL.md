---
name: config
version: "0.1.0"
description: >
  Read or update configuration values. Filesystem persistence via host
  (naia-os config file path convention).
tier: T2
triggers:
  - "config"
  - "settings"
  - "설정"
input_schema:
  action:
    type: string
    required: true
    enum: ["get", "set", "list", "unset"]
    description: "Operation"
  key:
    type: string
    required: false
    description: "Config key (dotted path, e.g. 'voice.tts.provider')"
  value:
    type: string
    required: false
    description: "New value (for set)"
  scope:
    type: string
    required: false
    enum: ["user", "instance", "session"]
    description: "Config scope. Default: instance"
tags: ["meta", "config"]
author: "naia-adk"
---

# config

Spec only — execution by naia-agent. Filesystem path by naia-os host (e.g. `$ADK_ROOT/data/config/`). Tier T2 (write requires approval). Phase 4.0 spec stub.
