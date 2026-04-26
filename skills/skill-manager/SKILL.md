---
name: skill-manager
version: "0.1.0"
description: >
  Manage the skill catalog — list available skills, install new ones from
  registry, uninstall, or update. Operates on naia-adk skill directory.
tier: T1
triggers:
  - "skill"
  - "install skill"
  - "list skills"
  - "스킬 목록"
input_schema:
  action:
    type: string
    required: true
    enum: ["list", "install", "uninstall", "update", "info"]
    description: "Operation"
  name:
    type: string
    required: false
    description: "Skill name (for install/uninstall/update/info)"
  source:
    type: string
    required: false
    description: "Source URL or registry id (for install)"
tags: ["meta", "catalog"]
author: "naia-adk"
---

# skill-manager

Spec only — execution by naia-agent manipulates naia-adk skills/ catalog (read-write filesystem). Tier T1 — install/uninstall require user awareness but no per-action approval. Phase 4.0 spec stub.
