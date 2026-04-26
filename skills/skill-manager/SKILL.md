---
name: skill-manager
version: "0.1.0"
description: >
  Manage the skill catalog — list available skills, install from trusted
  registry, uninstall, or update. Supply-chain trust model required (P0-2).
tier: T2
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
    pattern: "^[a-z0-9_-]+$"
    description: "Skill name (path traversal 방지: lowercase alphanumeric + hyphen/underscore)"
  source:
    type: string
    required: false
    pattern: "^(registry|fs)://[a-zA-Z0-9_/.-]+(@[0-9.]+)?$"
    description: "Source URI — registry:// or fs:// only. URL/HTTP 직접 다운로드 금지 (P0-2 supply-chain 방어)"
tags: ["meta", "catalog"]
author: "naia-adk"
---

# skill-manager

**Tier T2** — install/uninstall은 supply-chain 위험 있어 사용자 확인 강제.

## 보안 정책 (P0-2 fix)

- ❌ **HTTP/HTTPS URL 직접 다운로드 금지** — attacker가 임의 코드 배포 가능
- ✓ **registry:// 또는 fs:// 만 허용** — `source: registry://skill-name@1.0.0` 또는 `source: fs:///local/path`
- ⚠ **GPG/Ed25519 signature 검증** = naia-agent 또는 registry 책임 (Phase 4.2 spec 정식 / 본 spec은 source URI 형식만)
- name regex로 path traversal 차단

Spec only — 실행 + 검증은 naia-agent. Phase 4.0 spec; Phase 4.2 정식 trust model.
