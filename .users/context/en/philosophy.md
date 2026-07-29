<!-- Copyright 2026 Nextain Inc. All rights reserved. -->

# Naia OS Project Philosophy

This is a human-readable guide to `.agents/context/philosophy.yaml`.

## Purpose

This document explains the core philosophy of the Naia OS project — **“why we are building this.”**
It is the reason the project exists, separate from the architecture (what) and workflows (how).

---

## Core Principles

### 1. AI Sovereignty

**“Users choose their AI — no vendor lock-in”**

- Support for multiple LLM providers (Vertex AI, Anthropic, xAI, local models)
- Users own their AI configuration and can switch freely
- No dependency on a single provider in the core architecture

### 2. privacy-by-default

**“Local execution by default — the cloud is optional”**

- Desktop-first architecture (Tauri, not Electron cloud)
- User data remains on the device unless explicitly shared
- Local LLM support (Ollama) treated as a first-class citizen

### 3. Transparency

**“Open source — verify by reading the code”**

- All core logic is open source (Apache 2.0)
- AI context is open and forkable (CC-BY-SA 4.0)
- No hidden telemetry or data collection

### 4. Assembly over Invention

**“Assemble verified components — do not reinvent the wheel”**

- Use upstream projects as building blocks (OpenClaw, Tauri, etc.)
- Contribute to upstream whenever possible
- Learn from and track through reference submodules (ref-*)

### 5. Always On

**“The AI companion is a daemon — always present, always ready”**

- Background agent architecture (Node.js daemon)
- Gateway process management (spawn, restart, health check)
- AI character state that persists across sessions

### 6. Avatar-Centric

**“The AI is a living character — not merely a tool”**

- Naia: an AI character with a name, personality, and voice
- 3D avatar with TTS and emotional expression
- Character identity defined in SOUL.md

### 7. Vibe Coding Era

**“AI context files are the new contribution infrastructure”**

- The `.agents/` directory encodes the project philosophy, rather than serving merely as configuration
- Context quality determines the quality of AI collaboration
- Dual-directory architecture: AI-optimized + human-readable versions
- Preserve the contribution chain through the CC-BY-SA license

---

## Related Files

- **SoT**: `.agents/context/philosophy.yaml`
- **English mirror**: `.users/context/en/philosophy.md`

---
