/**
 * @naia-adk/skills-builtin — Generic skills catalog (Phase 4.0)
 *
 * 9 generic skills migrated from naia-os agent (R4 Phase 4.0 spec).
 * **Spec/interface only** — execution logic는 naia-agent supervisor가
 * 호출. data layer는 naia-memory / naia-os 자연 위임.
 *
 * Zero runtime deps — uses @naia-adk/skill-spec interface.
 *
 * 4-repo 책임 분리 (LOCK 2026-04-26):
 *   - naia-adk: spec/interface only (본 pkg)
 *   - naia-agent: skill 실행 (supervisor invoke) + audio provider (STT/TTS, D43)
 *   - naia-memory: memory data layer
 *   - naia-os: UI + device IO (mic/speaker) + channel adapter + Avatar
 *
 * D42 (Reference) — stub export pattern: 본 module은 skeleton 단계.
 * 실 구현은 Phase 4.0 Day 3-6. 그 동안 Phase 4.1 (naia-os wire)이
 * 본 stub을 import하여 독립 진행.
 *
 * Skills (TBD — Day 3-6 마이그레이션, 9 skills):
 *   - cron       Cron scheduler (spec). 실행=naia-agent. data=$ADK_ROOT/data/cron-jobs.json
 *   - memo       Memo write (spec). 실행=naia-agent. data=naia-memory
 *   - time       Pure utility (spec). 실행=naia-agent (OS time API)
 *   - weather    External API (spec). 실행=naia-agent. data=naia-memory cache
 *   - notify     Channel abstract (spec). 실행=naia-agent. adapter=naia-os/gateway
 *   - diagnostics System info (spec). 실행=naia-agent. data=naia-os OS query
 *   - sessions   Session 조회 (spec). 실행=naia-agent. data=naia-memory
 *   - skill-manager Skill catalog 관리 (spec). 실행=naia-agent. data=naia-adk catalog
 *   - config     Config (spec). 실행=naia-agent. data=naia-os config file
 *   - system-status OS info (spec). 실행=naia-agent. data=naia-os OS query
 *
 * **NOT in this catalog** (다른 layer):
 *   - TTS/STT      → naia-agent audio provider (Vercel AI SDK 패턴, D43, omni 호환)
 *   - Voicewake    → naia-os device IO (mic hardware)
 *   - Avatar       → naia-os UI (Three.js + lip-sync)
 *   - Channel adapter (Discord/GoogleChat/Slack) → naia-os/gateway
 */

// Phase 4.0 Day 0.5 — stub exports (D42 Multi-repo parallel gate)
export const PHASE_4_0_STUB = "skills-builtin pending Day 3-7" as const;

// First real descriptor (landed via naia-os#272 reconcile): weather is the
// simplest of the 10 skills — pure external API call (wttr.in), no naia-memory
// dep, no audio. Other descriptors follow the same shape and will land during
// Day 3-7.
import type { SkillDescriptor } from "@naia-adk/skill-spec";

export const weatherDescriptor: SkillDescriptor = {
	name: "weather",
	description: "Get current weather for a given location via wttr.in (external API).",
	version: "0.1.0",
	tier: "T0",
	inputSchema: {
		type: "object",
		properties: {
			location: {
				type: "string",
				description: "City name or coordinates (e.g. 'Seoul', 'Tokyo', '37.5,127.0').",
			},
		},
		required: ["location"],
	},
	tags: ["weather", "external-api", "tier-0"],
};
