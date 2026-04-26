/**
 * @naia-adk/skills-builtin — Generic skills catalog (Phase 4.0)
 *
 * 10 generic skills migrated from naia-os agent (R4 Phase 4.0 spec).
 * Zero runtime deps — uses @naia-adk/skill-spec interface.
 *
 * D42 (Reference) — stub export pattern: 본 module은 skeleton 단계.
 * 실 구현은 Phase 4.0 Day 3-7. 그 동안 Phase 4.1 (naia-os wire)이
 * 본 stub을 import하여 독립 진행.
 *
 * Skills (TBD — Day 3-7 마이그레이션):
 *   - tts        TTS (5 provider abstraction: Edge/Google/OpenAI/ElevenLabs/Nextain)
 *   - cron       Cron scheduler ($ADK_ROOT/data/cron-jobs.json)
 *   - memo       Memo write (MemoryProvider DI)
 *   - time       Pure utility
 *   - weather    External API skill
 *   - notify     Channel abstract (adapter는 naia-os/gateway)
 *   - diagnostics System info utility
 *   - sessions   Session 조회 (read-only)
 *   - skill-manager Skill catalog 관리
 *   - config     Config skill
 *   - system-status OS info (POSIX-portable subset)
 */

// Phase 4.0 Day 0.5 — stub exports (D42 Multi-repo parallel gate)
export const PHASE_4_0_STUB = "skills-builtin pending Day 3-7" as const;

// Stub: real exports will be added in Day 3-7 migration.
// Until then, naia-os wire (Phase 4.1) imports this constant to verify
// the package resolution chain works (file: dep → tsconfig refs → typecheck).
