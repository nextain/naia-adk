# @naia-adk/skills-builtin

10 generic skills catalog for Naia instances (Phase 4.0 spec).

## 4-repo 책임 분리

| layer | 책임 |
|---|---|
| **naia-adk** (본 pkg) | skill **spec/manifest only** (SKILL.md frontmatter) |
| **naia-agent** | skill 실행 (supervisor invoke) — Phase 4.2 wire |
| **naia-memory** | data layer (memo / sessions / weather cache) |
| **naia-os** | host (filesystem / OS query / channel adapter / device IO) |

## skills (10)

| Skill | Tier | data/IO 위임 |
|---|:---:|---|
| **cron** | **T3** | $ADK_ROOT/data/cron-jobs.json (naia-os) — invocation envelope only (NO shell, P0-1) |
| memo | T1 | naia-memory MemoryProvider |
| time | T0 | OS time API (naia-agent) |
| weather | T1 | external API + naia-memory cache |
| **notify** | **T3** | naia-os/gateway adapter (Discord/Slack/GoogleChat) — external data leak |
| diagnostics | T1 | naia-os OS query |
| sessions | T0 | naia-memory session store (read-only) |
| skill-manager | T2 | naia-adk skills/ filesystem — registry:// or fs:// only (P0-2) |
| config | T2 | naia-os config file |
| system-status | T0 | naia-os OS query |

### Tier 분포

- T0 (3): time / sessions / system-status (read-only)
- T1 (3): memo / weather / diagnostics
- T2 (2): skill-manager / config (write/effect)
- **T3 (2): cron / notify** (deny-by-default — RCE/data-leak risk)

## 보안 정책 (Paranoid review P0 fix)

### cron (P0-1)
- ❌ shell command 실행 금지 → invocation envelope (`{ skill: "name", args: {} }`) only
- tier T3 + cascade tier check (cron이 호출하는 target skill의 tier도 확인)

### skill-manager (P0-2)
- ❌ HTTP/HTTPS URL 직접 다운로드 금지
- ✓ `registry://` 또는 `fs://` URI scheme만 허용
- name regex `^[a-z0-9_-]+$` (path traversal 차단)
- GPG signature 검증 = Phase 4.2 정식

### notify (Paranoid P1-1)
- tier T3 (data leak to third-party)
- channel은 host registered adapter only (Phase 4.2 enum 검증)

### config (Paranoid P1-2)
- key enum 권고 (Phase 4.2에서 schema-based validation)

### multi-instance namespace (Paranoid P0-5)
- 다른 사용자 (alpha-adk + bob-adk) fork 시 skills/ 충돌 가능
- Phase 4.2: skill `persona_scope` 옵션 또는 instance-specific subdir 권고

## Multilingual triggers (Reference P0-1 note)

각 SKILL.md `triggers`는 한국어+영어 mix. naia-agent supervisor가 router 시 BCP-47 locale 또는 fuzzy-match 정책 결정 (Phase 4.2).

## Phase 4.0 → 4.2 전환

본 pkg = spec only. 실행은 naia-agent supervisor가 SkillLoader.invoke() 호출 시:
1. SKILL.md frontmatter parse
2. input validation (zod from input_schema)
3. tier check (T2/T3 → ApprovalBroker)
4. dispatch:
   - data → naia-memory
   - filesystem/OS → naia-os
   - channel → naia-os/gateway
   - audio → naia-agent audio provider (TTS/STT, D43)

## TTS/STT 제외 (D43)

TTS/STT는 본 catalog X — naia-agent **audio provider layer** (Vercel AI SDK 패턴).
이유: omni model (vllm-omni / GPT-4o realtime) 호환을 위해 audio stream을 naia-agent 1급 시민으로 처리.
