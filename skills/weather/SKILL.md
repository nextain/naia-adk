---
name: weather
version: "0.1.0"
description: >
  Get current weather or forecast for a location. External API call
  (provider-agnostic). Cache result via MemoryProvider (host responsibility).
tier: T1
triggers:
  - "weather"
  - "forecast"
  - "날씨"
input_schema:
  location:
    type: string
    required: true
    description: "City name or lat,lng"
  forecast:
    type: boolean
    required: false
    description: "True for 7-day forecast, false for current. Default: false"
  unit:
    type: string
    required: false
    enum: ["metric", "imperial"]
    description: "Default: metric"
tags: ["external-api"]
author: "naia-adk"
---

# weather

Spec only — execution by naia-agent (external API). Cache via naia-memory. Phase 4.0 spec stub.
