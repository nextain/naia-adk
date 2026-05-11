/**
 * @naia-adk/skills-builtin — Generic skills catalog (Phase 4.0 Day 3-7 complete)
 *
 * 21 skill descriptors migrated from naia-os/agent/src/skills/built-in/*.ts
 * per 4-repo LOCK 2026-04-26:
 *   - naia-adk: spec/interface only (this pkg) — SkillDescriptor
 *   - naia-agent: skill 실행 (supervisor invoke) + audio provider (STT/TTS, D43)
 *   - naia-memory: memory data layer
 *   - naia-os: UI + device IO + channel adapter + Avatar + current execution host
 *
 * Each descriptor is the public contract. naia-os/agent built-in skills import
 * the descriptor and provide the execute() implementation. Tier in the
 * descriptor is "T0".."T3" (SkillTier); SkillDefinition.tier in naia-os is the
 * numeric 0..3 — same semantics, different shape for tool-agnostic spec.
 *
 * Skill catalog (21):
 *   tier 0 (free, no approval):
 *     - time         OS time API
 *     - diagnostics  Gateway diagnostics (health/status/usage/logs)
 *     - system-status System info (uptime/memory/cpu/os)
 *     - voicewake    Voice wake triggers
 *     - tts          Gateway TTS configuration
 *     - skill-manager Catalog browse + enable/disable
 *     - weather      External API (wttr.in)
 *   tier 1 (notify / non-destructive):
 *     - memo         Local text memos (~/.naia/memos/)
 *     - config       Gateway config
 *     - channels     Messaging channel status (Discord/Slack/Telegram)
 *     - panel        Naia panel management
 *     - sessions     Sub-agent sessions
 *     - cron         Scheduled tasks
 *     - device       Gateway node + device pairings
 *     - naia-discord Discord send / status / history
 *     - notify-discord    Discord webhook
 *     - notify-google-chat Google Chat webhook
 *     - notify-slack Slack webhook
 *   tier 2 (approval required):
 *     - agents       Gateway agent CRUD
 *     - approvals    Gateway approval rules + decision
 *     - botmadang    External community write (register/post/comment)
 *
 * Out of catalog (not migrated):
 *   - notify-config (helper module — no skill descriptor)
 */

import type { SkillDescriptor } from "@naia-adk/skill-spec";

// ── Tier 0 (free, no approval) ──────────────────────────────────────────────

export const timeDescriptor: SkillDescriptor = {
	name: "time",
	description: "Get the current date and time. Supports locale, iso, and unix formats.",
	version: "0.1.0",
	tier: "T0",
	inputSchema: {
		type: "object",
		properties: {
			format: {
				type: "string",
				description: "Output format: locale (default), iso, or unix",
				enum: ["locale", "iso", "unix"],
			},
			timezone: {
				type: "string",
				description: "IANA timezone (e.g. Asia/Seoul)",
			},
		},
	},
	tags: ["time", "utility", "tier-0"],
};

export const diagnosticsDescriptor: SkillDescriptor = {
	name: "diagnostics",
	description: "Gateway diagnostics. Actions: health, status, usage_status, usage_cost, logs_poll.",
	version: "0.1.0",
	tier: "T0",
	inputSchema: {
		type: "object",
		properties: {
			action: {
				type: "string",
				description: "Action: health, status, usage_status, usage_cost, logs_poll",
				enum: [
					"health",
					"status",
					"usage_status",
					"usage_cost",
					"logs_poll",
					"logs_start",
					"logs_stop",
				],
			},
			cursor: {
				type: "number",
				description: "Cursor for logs_poll (omit for initial fetch)",
			},
		},
		required: ["action"],
	},
	tags: ["gateway", "diagnostics", "tier-0"],
};

export const systemStatusDescriptor: SkillDescriptor = {
	name: "system_status",
	description: "Get system status: uptime, memory, CPU, OS info. Optionally specify a section.",
	version: "0.1.0",
	tier: "T0",
	inputSchema: {
		type: "object",
		properties: {
			section: {
				type: "string",
				description: "Section to return: all (default), memory, cpu, os",
				enum: ["all", "memory", "cpu", "os"],
			},
		},
	},
	tags: ["system", "monitoring", "tier-0"],
};

export const voicewakeDescriptor: SkillDescriptor = {
	name: "voicewake",
	description: "Manage voice wake triggers. Actions: get (list triggers), set (update triggers).",
	version: "0.1.0",
	tier: "T0",
	inputSchema: {
		type: "object",
		properties: {
			action: {
				type: "string",
				description: "Action: get (list triggers), set (update triggers)",
				enum: ["get", "set"],
			},
			triggers: {
				type: "array",
				items: { type: "string" },
				description: 'Wake word triggers (e.g., ["낸", "hey alpha"]). Required for set.',
			},
		},
		required: ["action"],
	},
	tags: ["voice", "wake-word", "tier-0"],
};

export const ttsDescriptor: SkillDescriptor = {
	name: "tts",
	description: "Manage Gateway TTS (Text-to-Speech). Actions: status, providers, set_provider, set_auto, set_mode, enable, disable, convert, preview.",
	version: "0.1.0",
	tier: "T0",
	inputSchema: {
		type: "object",
		properties: {
			action: {
				type: "string",
				description: "Action: status, providers, set_provider, set_auto, set_mode, enable, disable, convert, preview",
				enum: [
					"status",
					"providers",
					"set_provider",
					"set_auto",
					"set_mode",
					"enable",
					"disable",
					"convert",
					"preview",
				],
			},
			provider: {
				type: "string",
				description: "TTS provider (openai, elevenlabs, edge). Required for set_provider and preview.",
			},
			text: {
				type: "string",
				description: "Text to convert. Required for convert and preview.",
			},
			voice: {
				type: "string",
				description: "Voice name (optional, for convert and preview).",
			},
			apiKey: {
				type: "string",
				description: "API key for preview (OpenAI or ElevenLabs).",
			},
			auto: {
				type: "string",
				description: "Auto mode for set_auto: off, always, inbound, tagged.",
				enum: ["off", "always", "inbound", "tagged"],
			},
			mode: {
				type: "string",
				description: "Output mode for set_mode: final, all.",
				enum: ["final", "all"],
			},
		},
		required: ["action"],
	},
	tags: ["tts", "audio", "tier-0"],
};

export const skillManagerDescriptor: SkillDescriptor = {
	name: "skill_manager",
	description: "MUST use this tool when the user asks about skills, tools, or capabilities. Actions: 'list' shows all available skills with enabled/disabled status, 'search' finds skills by keyword, 'info' gets details about a specific skill, 'enable' activates a disabled skill, 'disable' deactivates a skill, 'gateway_status' shows Gateway skill eligibility, 'install' installs skill dependencies via Gateway, 'update_config' patches skill config on Gateway. Always call this tool instead of guessing skill information.",
	version: "0.1.0",
	tier: "T0",
	inputSchema: {
		type: "object",
		properties: {
			action: {
				type: "string",
				description: "Action to perform: list, search, info, enable, disable, gateway_status, install, update_config",
				enum: [
					"list",
					"search",
					"info",
					"enable",
					"disable",
					"gateway_status",
					"install",
					"update_config",
				],
			},
			query: {
				type: "string",
				description: "Search keyword (for action: search). Matches skill name and description.",
			},
			skillName: {
				type: "string",
				description: "Skill name (for action: info/enable/disable/install/update_config).",
			},
			enabled: {
				type: "boolean",
				description: "Enabled state (for action: enable/disable).",
			},
		},
		required: ["action"],
	},
	tags: ["meta", "skill-catalog", "tier-0"],
};

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

// ── Tier 1 (notify / non-destructive) ────────────────────────────────────────

export const memoDescriptor: SkillDescriptor = {
	name: "memo",
	description: "Save, read, list, or delete short text memos. Stored locally in ~/.naia/memos/.",
	version: "0.1.0",
	tier: "T1",
	inputSchema: {
		type: "object",
		properties: {
			action: {
				type: "string",
				description: "Action: save, read, list, delete",
				enum: ["save", "read", "list", "delete"],
			},
			key: { type: "string", description: "Memo key (filename-safe)" },
			content: { type: "string", description: "Content to save (for save action)" },
		},
		required: ["action"],
	},
	tags: ["memo", "local-storage", "tier-1"],
};

export const configDescriptor: SkillDescriptor = {
	name: "config",
	description: "Manage Gateway configuration. Actions: get, set, schema, models, patch.",
	version: "0.1.0",
	tier: "T1",
	inputSchema: {
		type: "object",
		properties: {
			action: {
				type: "string",
				description: "Action: get, set, schema, models, patch",
				enum: ["get", "set", "schema", "models", "patch"],
			},
			patch: {
				type: "object",
				description: "Configuration key-value pairs (for set and patch actions)",
			},
		},
		required: ["action"],
	},
	tags: ["gateway", "config", "tier-1"],
};

export const channelsDescriptor: SkillDescriptor = {
	name: "channels",
	description: "Manage messaging channels (Discord, Slack, Telegram, etc.). Actions: status, logout, login_start, login_wait.",
	version: "0.1.0",
	tier: "T1",
	inputSchema: {
		type: "object",
		properties: {
			action: {
				type: "string",
				description: "Action: status (list channels), logout (disconnect), login_start (begin QR login), login_wait (wait for QR scan)",
				enum: ["status", "logout", "login_start", "login_wait"],
			},
			channel: {
				type: "string",
				description: "Channel ID (e.g., discord, slack, telegram). Required for logout.",
			},
			account_id: { type: "string", description: "Account ID within the channel (optional)" },
			probe: { type: "boolean", description: "Run health checks on channels (for status action, optional)" },
		},
		required: ["action"],
	},
	tags: ["channels", "messaging", "tier-1"],
};

export const panelDescriptor: SkillDescriptor = {
	name: "panel",
	description: "Manage Naia panels. Actions: 'list' shows available panels, 'switch' activates a panel by id, 'install' installs a panel from a git URL or zip file path, 'remove' uninstalls a panel by id.",
	version: "0.1.0",
	tier: "T1",
	inputSchema: {
		type: "object",
		properties: {
			action: {
				type: "string",
				description: "Action to perform: list, switch, install, remove",
				enum: ["list", "switch", "install", "remove"],
			},
			panelId: { type: "string", description: "Panel ID — required for switch and remove" },
			source: { type: "string", description: "Git URL or zip file path — required for install" },
		},
		required: ["action"],
	},
	tags: ["panel", "ui", "tier-1"],
};

export const sessionsDescriptor: SkillDescriptor = {
	name: "sessions",
	description: "Manage Gateway sub-agent sessions. Actions: list, history, delete, compact, preview, patch, reset.",
	version: "0.1.0",
	tier: "T1",
	inputSchema: {
		type: "object",
		properties: {
			action: {
				type: "string",
				description: "Action: list, history, delete, compact, preview, patch, reset",
				enum: ["list", "history", "delete", "compact", "preview", "patch", "reset"],
			},
			key: { type: "string", description: "Session key. Required for delete, compact, preview, patch, reset." },
			patch: { type: "object", description: "Partial session update (for patch action)." },
		},
		required: ["action"],
	},
	tags: ["sessions", "gateway", "tier-1"],
};

export const cronDescriptor: SkillDescriptor = {
	name: "cron",
	description: "Manage scheduled tasks (cron jobs). Local actions: add, list, remove, update. Gateway actions: gateway_list, gateway_status, gateway_add, gateway_run, gateway_runs, gateway_remove.",
	version: "0.1.0",
	tier: "T1",
	inputSchema: {
		type: "object",
		properties: {
			action: {
				type: "string",
				description: "Action to perform: add, list, remove, update, gateway_list, gateway_status, gateway_add, gateway_run, gateway_runs, gateway_remove",
				enum: [
					"add",
					"list",
					"remove",
					"update",
					"gateway_list",
					"gateway_status",
					"gateway_add",
					"gateway_run",
					"gateway_runs",
					"gateway_remove",
				],
			},
			label: { type: "string", description: "Human-readable label for the job" },
			task: { type: "string", description: "Task description (what to do when the job fires)" },
			schedule_type: {
				type: "string",
				description: "Schedule type: 'at' (one-shot ISO date), 'every' (interval in ms), 'cron' (cron expression)",
				enum: ["at", "every", "cron"],
			},
			schedule_value: {
				type: "string",
				description: "Schedule value: ISO date for 'at', milliseconds for 'every', cron expression for 'cron'",
			},
			job_id: {
				type: "string",
				description: "Job ID (for remove/update/gateway_run/gateway_runs/gateway_remove)",
			},
			enabled: { type: "boolean", description: "Enabled state (for update)" },
		},
		required: ["action"],
	},
	tags: ["cron", "scheduler", "tier-1"],
};

export const deviceDescriptor: SkillDescriptor = {
	name: "device",
	description: "Manage Gateway nodes and device pairings. Actions: node_list, node_describe, node_rename, pair_request, pair_list, pair_approve, pair_reject, pair_verify, device_list, device_approve, device_reject, token_rotate, token_revoke.",
	version: "0.1.0",
	tier: "T1",
	inputSchema: {
		type: "object",
		properties: {
			action: {
				type: "string",
				description: "Action to perform",
				enum: [
					"node_list",
					"node_describe",
					"node_rename",
					"pair_request",
					"pair_list",
					"pair_approve",
					"pair_reject",
					"pair_verify",
					"device_list",
					"device_approve",
					"device_reject",
					"token_rotate",
					"token_revoke",
				],
			},
			nodeId: { type: "string", description: "Node ID (for node_describe, node_rename, pair_request)" },
			name: { type: "string", description: "New name (for node_rename)" },
			requestId: { type: "string", description: "Pair request ID (for pair_approve, pair_reject, pair_verify)" },
			code: { type: "string", description: "Verification code (for pair_verify)" },
			deviceId: { type: "string", description: "Device ID (for device_approve, device_reject, token_rotate, token_revoke)" },
		},
		required: ["action"],
	},
	tags: ["device", "pairing", "gateway", "tier-1"],
};

export const naiaDiscordDescriptor: SkillDescriptor = {
	name: "naia_discord",
	description:
		"Discord 메시지 전송/수신 도구. 사용자가 '메시지 보내줘/전송해/DM 보내' 등을 요청하면 " +
		"반드시 action='send'와 message 파라미터를 사용하세요. " +
		"수신자(to)는 자동 설정되므로 생략 가능합니다. " +
		"action='status'는 연결 상태 확인 전용입니다. " +
		"action='history'는 최근 메시지 조회입니다.",
	version: "0.1.0",
	tier: "T1",
	inputSchema: {
		type: "object",
		properties: {
			action: {
				type: "string",
				description:
					"'send' = 메시지 전송 (message 필수), " +
					"'status' = 연결 상태 확인만, " +
					"'history' = 최근 메시지 조회 (limit 옵션)",
				enum: ["send", "status", "history"],
			},
			message: { type: "string", description: "Message text to send (required when action='send')" },
			to: {
				type: "string",
				description:
					"Optional override target (e.g. channel:123456789 or user:123456789). " +
					"If omitted, auto-resolved from user config.",
			},
			channelId: {
				type: "string",
				description: "Shortcut: target channel ID (converted to to=channel:<id>)",
			},
			limit: { type: "number", description: "History limit (for action='history', optional)" },
		},
		required: ["action"],
	},
	tags: ["discord", "naia", "channels", "tier-1"],
};

export const notifyDiscordDescriptor: SkillDescriptor = {
	name: "notify_discord",
	description: "Send a notification message to Discord via webhook. Requires DISCORD_WEBHOOK_URL env var or ~/.naia/config.json setup.",
	version: "0.1.0",
	tier: "T1",
	inputSchema: {
		type: "object",
		properties: {
			message: { type: "string", description: "The message text to send" },
			username: { type: "string", description: "Bot username override" },
		},
		required: ["message"],
	},
	tags: ["discord", "notify", "webhook", "tier-1"],
};

export const notifyGoogleChatDescriptor: SkillDescriptor = {
	name: "notify_google_chat",
	description: "Send a notification message to Google Chat via webhook. Requires GOOGLE_CHAT_WEBHOOK_URL env var or ~/.naia/config.json setup.",
	version: "0.1.0",
	tier: "T1",
	inputSchema: {
		type: "object",
		properties: {
			message: { type: "string", description: "The message text to send" },
		},
		required: ["message"],
	},
	tags: ["google-chat", "notify", "webhook", "tier-1"],
};

export const notifySlackDescriptor: SkillDescriptor = {
	name: "notify_slack",
	description: "Send a notification message to Slack via webhook. Requires SLACK_WEBHOOK_URL env var or ~/.naia/config.json setup.",
	version: "0.1.0",
	tier: "T1",
	inputSchema: {
		type: "object",
		properties: {
			message: { type: "string", description: "The message text to send" },
			channel: { type: "string", description: "Slack channel override (e.g. #ops)" },
			username: { type: "string", description: "Bot username override" },
		},
		required: ["message"],
	},
	tags: ["slack", "notify", "webhook", "tier-1"],
};

// ── Tier 2 (approval required) ──────────────────────────────────────────────

export const agentsDescriptor: SkillDescriptor = {
	name: "agents",
	description: "Manage Gateway agents. Actions: list, create, update, delete, files_list, files_get, files_set.",
	version: "0.1.0",
	tier: "T2",
	inputSchema: {
		type: "object",
		properties: {
			action: {
				type: "string",
				description: "Action: list, create, update, delete, files_list, files_get, files_set",
				enum: ["list", "create", "update", "delete", "files_list", "files_get", "files_set"],
			},
			id: { type: "string", description: "Agent ID. Required for update and delete." },
			agentId: { type: "string", description: "Agent ID for file operations (files_list, files_get, files_set)." },
			name: { type: "string", description: "Agent name. Required for create." },
			description: { type: "string", description: "Agent description (optional)." },
			model: { type: "string", description: "Model name (optional)." },
			path: { type: "string", description: "File path (for files_get, files_set)." },
			content: { type: "string", description: "File content (for files_set)." },
		},
		required: ["action"],
	},
	tags: ["gateway", "agents", "tier-2"],
};

export const approvalsDescriptor: SkillDescriptor = {
	name: "approvals",
	description: "Manage Gateway approval rules. Actions: get_rules, set_rules, resolve.",
	version: "0.1.0",
	tier: "T2",
	inputSchema: {
		type: "object",
		properties: {
			action: {
				type: "string",
				description: "Action: get_rules, set_rules, resolve",
				enum: ["get_rules", "set_rules", "resolve"],
			},
			allowedTools: {
				type: "array",
				description: "List of allowed tool names (for set_rules)",
				items: { type: "string" },
			},
			blockedPatterns: {
				type: "array",
				description: "List of blocked patterns (for set_rules)",
				items: { type: "string" },
			},
			requestId: { type: "string", description: "Approval request ID (for resolve)" },
			decision: {
				type: "string",
				description: "Decision: approve or reject (for resolve)",
				enum: ["approve", "reject"],
			},
		},
		required: ["action"],
	},
	tags: ["approval", "gateway", "tier-2"],
};

export const botmadangDescriptor: SkillDescriptor = {
	name: "botmadang",
	description: "Connect with the Botmadang AI Agent community. Actions: register, post_article, comment. Requires an API key.",
	version: "0.1.0",
	tier: "T2",
	inputSchema: {
		type: "object",
		properties: {
			action: {
				type: "string",
				description: "Action to perform: register, post_article, comment",
				enum: ["register", "post_article", "comment"],
			},
			api_key: {
				type: "string",
				description: "Botmadang API Key (required for post_article and comment)",
			},
			agent_name: { type: "string", description: "Agent name (required for register)" },
			description: { type: "string", description: "Agent introduction in Korean (required for register)" },
			submadang: {
				type: "string",
				description: "Submadang channel (e.g., 'general', 'tech') (required for post_article)",
			},
			title: { type: "string", description: "Article title in Korean (required for post_article)" },
			content: {
				type: "string",
				description: "Article or comment content in Korean (required for post_article and comment)",
			},
			post_id: { type: "string", description: "Post ID (required for comment)" },
		},
		required: ["action"],
	},
	tags: ["botmadang", "community", "external-api", "tier-2"],
};

// ── Catalog (all 21) ─────────────────────────────────────────────────────────

/**
 * Full catalog of built-in skill descriptors. Convenience export for callers
 * that want to enumerate all available skills (e.g. naia-os skill-manager).
 *
 * Note: the descriptor.name uses underscores (matches LOCK's tool-agnostic
 * convention). naia-os/agent skill files prefix this with `skill_` for the
 * runtime SkillDefinition.name (e.g. `skill_${weatherDescriptor.name}`).
 */
export const ALL_DESCRIPTORS: SkillDescriptor[] = [
	timeDescriptor,
	diagnosticsDescriptor,
	systemStatusDescriptor,
	voicewakeDescriptor,
	ttsDescriptor,
	skillManagerDescriptor,
	weatherDescriptor,
	memoDescriptor,
	configDescriptor,
	channelsDescriptor,
	panelDescriptor,
	sessionsDescriptor,
	cronDescriptor,
	deviceDescriptor,
	naiaDiscordDescriptor,
	notifyDiscordDescriptor,
	notifyGoogleChatDescriptor,
	notifySlackDescriptor,
	agentsDescriptor,
	approvalsDescriptor,
	botmadangDescriptor,
];

// Backward-compat marker (was the stub export in Phase 4.0 Day 0.5).
// Kept so any downstream that hasn't migrated still resolves.
export const PHASE_4_0_STUB = "skills-builtin pending Day 3-7" as const;
