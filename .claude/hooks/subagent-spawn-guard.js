/**
 * Claude Code subagent concurrency guard (PreToolUse / PostToolUse / PostToolUseFailure / SubagentStop).
 *
 * Peer of .codex/hooks/subagent-spawn-guard.cjs. Between 2026-08-01 and 08-07,
 * 72% of Codex input tokens came from subagents and one parent spawned 71
 * children; nothing capped parallel fan-out, so per-call limits never bound
 * memory or credit burn rate.
 *
 * Earlier versions tracked cumulative spawns (or a sliding launch window),
 * which permanently locked long-running sessions even when 0 subagents were
 * active. This guard tracks only concurrently running subagents: PreToolUse
 * reserves a slot keyed by tool_use_id, PostToolUse (foreground completion or
 * async_launched agentId binding), PostToolUseFailure, and SubagentStop release
 * slots when work ends, and unclosed slots expire after a stale timeout.
 * Default concurrency scales conservatively from host MemTotal when unset, and
 * launches are rejected if /proc/meminfo MemAvailable falls below reserve + 1 slot.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const OFF_VALUES = new Set(["off", "0", "false", "no"]);
const OPT_IN_FILE = "allow-subagents";
// Both hosts' spawn tools. A name this set misses is a spawn the budget below
// never caps, and each guard used to know only its own host's names.
const SPAWN_TOOLS = new Set([
	"task",
	"agent",
	"spawn_agent",
	"multi_agent_v1",
	"multi_agent_v1__spawn_agent",
	"collaboration.spawn_agent",
	"collaborationspawn_agent",
]);
const OPT_IN_KEYS = new Set([
	"maxConcurrent",
	"maxSpawns",
	"windowMinutes",
	"reserveMemGb",
	"memPerSubagentGb",
	"estimatedSessions",
	"defaultMaxConcurrentCap",
]);
const DEFAULT_MAX_CONCURRENT = 4;
const HARD_MAX_CONCURRENT = 40;
const DEFAULT_RESERVE_MEM_GB = 4;
const DEFAULT_MEM_PER_SUBAGENT_GB = 0.5;
const DEFAULT_ESTIMATED_SESSIONS = 2;
const DEFAULT_MEM_AVAIL_MARGIN_GB = 1;
const KB_PER_GB = 1024 * 1024;
const BYTES_PER_GB = 1024 * 1024 * 1024;
const DEFAULT_STALE_MINUTES = 30;
const DEFAULT_STALE_MS = DEFAULT_STALE_MINUTES * 60 * 1000;
const RELEASE_EVENTS = new Set(["PostToolUse", "PostToolUseFailure", "SubagentStop"]);
const KNOWN_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "SubagentStop"]);
const LOCK_RETRY_MS = 15;
const LOCK_WAIT_LIMIT_MS = 1500;
const LOCK_STALE_MS = 10000;
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

function sleepMs(ms) {
	Atomics.wait(SLEEP_CELL, 0, 0, ms);
}

function disabled(env) {
	return OFF_VALUES.has(
		String((env || process.env).CLAUDE_SUBAGENT_GUARD || "").trim().toLowerCase(),
	);
}

function isSpawn(toolName) {
	// Hosts namespace the same tool differently (functions.multi_agent_v1).
	const value = String(toolName || "").trim().toLowerCase();
	return SPAWN_TOOLS.has(value) || SPAWN_TOOLS.has(value.split(/[.:/]/).pop());
}

function normalizeId(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed || null;
}

function truncateText(text, maxChars = 60) {
	const cleaned = String(text || "").replace(/\s+/g, " ").trim();
	if (!cleaned) return "";
	if (cleaned.length <= maxChars) return cleaned;
	return `${cleaned.slice(0, maxChars - 1)}…`;
}

function describeSpawn(toolInput) {
	const input = toolInput && typeof toolInput === "object" ? toolInput : {};
	const desc = truncateText(input.description, 60);
	if (desc) return desc;
	const rawPrompt = typeof input.prompt === "string"
		? input.prompt
		: (typeof input.message === "string" ? input.message : "");
	const firstLine = rawPrompt
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean) || "";
	return truncateText(firstLine, 60);
}

function formatSlotLabel(slot) {
	const type = typeof slot.subagentType === "string" ? slot.subagentType.trim() : "";
	const desc = typeof slot.description === "string" ? slot.description.trim() : "";
	if (type && desc) {
		return desc.startsWith(`[${type}]`) ? desc : `[${type}] ${desc}`;
	}
	if (desc) return desc;
	if (type) return `[${type}]`;
	return "(설명 없음)";
}

/**
 * The opt-in marker may hold a JSON budget. A malformed or empty file still
 * counts as opt-in but falls back to the default rather than silently granting
 * an unlimited one.
 */
function readOptIn(root) {
	const markerPath = path.join(root, ".claude", OPT_IN_FILE);
	if (!fs.existsSync(markerPath)) return null;
	try {
		const raw = fs.readFileSync(markerPath, "utf8").trim();
		if (!raw) return {};
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function defaultReadMemInfo() {
	try {
		return fs.readFileSync("/proc/meminfo", "utf8");
	} catch {
		return null;
	}
}

function parseMemInfo(raw) {
	if (!raw) return { memTotalKb: null, memAvailableKb: null };
	if (typeof raw === "string") {
		const totalMatch = raw.match(/^MemTotal:\s*(\d+)\s*kB/m);
		const availMatch = raw.match(/^MemAvailable:\s*(\d+)\s*kB/m);
		return {
			memTotalKb: totalMatch ? Number(totalMatch[1]) : null,
			memAvailableKb: availMatch ? Number(availMatch[1]) : null,
		};
	}
	if (typeof raw === "object" && !Array.isArray(raw)) {
		const total = raw.memTotalKb ?? raw.MemTotal;
		const avail = raw.memAvailableKb ?? raw.MemAvailable;
		return {
			memTotalKb: Number.isFinite(total) && total >= 0 ? total : null,
			memAvailableKb: Number.isFinite(avail) && avail >= 0 ? avail : null,
		};
	}
	return { memTotalKb: null, memAvailableKb: null };
}

function readMemoryStatus({ readMemInfo = defaultReadMemInfo, totalMemBytes = os.totalmem } = {}) {
	let raw = null;
	if (typeof readMemInfo === "function") {
		try { raw = readMemInfo(); } catch { raw = null; }
	}
	const snapshot = parseMemInfo(raw);
	let totalBytes = null;
	if (snapshot.memTotalKb === null) {
		try {
			totalBytes = typeof totalMemBytes === "function" ? totalMemBytes() : totalMemBytes;
		} catch { totalBytes = null; }
	}
	const memTotalGb = snapshot.memTotalKb !== null
		? snapshot.memTotalKb / KB_PER_GB
		: (Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes / BYTES_PER_GB : null);
	const memAvailableGb = snapshot.memAvailableKb !== null
		? snapshot.memAvailableKb / KB_PER_GB
		: null;
	return { memTotalGb, memAvailableGb };
}

function resolveMemoryConfig(optIn = {}) {
	const reserveMemGb = Number.isFinite(optIn.reserveMemGb) && optIn.reserveMemGb >= 0
		? optIn.reserveMemGb
		: DEFAULT_RESERVE_MEM_GB;
	const memPerSubagentGb = Number.isFinite(optIn.memPerSubagentGb) && optIn.memPerSubagentGb > 0
		? optIn.memPerSubagentGb
		: DEFAULT_MEM_PER_SUBAGENT_GB;
	const estimatedSessions = Number.isFinite(optIn.estimatedSessions) && optIn.estimatedSessions > 0
		? optIn.estimatedSessions
		: DEFAULT_ESTIMATED_SESSIONS;
	const defaultMaxConcurrentCap = Number.isSafeInteger(optIn.defaultMaxConcurrentCap) && optIn.defaultMaxConcurrentCap >= 0
		? Math.min(optIn.defaultMaxConcurrentCap, HARD_MAX_CONCURRENT)
		: null;
	return { reserveMemGb, memPerSubagentGb, estimatedSessions, defaultMaxConcurrentCap };
}

function computeAutoConcurrentLimit(memTotalGb, memConfig) {
	if (memConfig.defaultMaxConcurrentCap === 0) return 0;
	if (!Number.isFinite(memTotalGb) || memTotalGb <= 0) {
		return memConfig.defaultMaxConcurrentCap ?? DEFAULT_MAX_CONCURRENT;
	}
	const usableGb = Math.max(0, memTotalGb - memConfig.reserveMemGb);
	const computed = Math.max(1, Math.floor(usableGb / memConfig.memPerSubagentGb / memConfig.estimatedSessions));
	const ceiling = memConfig.defaultMaxConcurrentCap ?? HARD_MAX_CONCURRENT;
	return Math.min(ceiling, computed, HARD_MAX_CONCURRENT);
}

function resolveLimit(optIn = {}, memStatus = null) {
	if (Number.isSafeInteger(optIn.maxConcurrent) && optIn.maxConcurrent >= 0) {
		return Math.min(optIn.maxConcurrent, HARD_MAX_CONCURRENT);
	}
	if (Number.isSafeInteger(optIn.maxSpawns) && optIn.maxSpawns >= 0) {
		return Math.min(optIn.maxSpawns, HARD_MAX_CONCURRENT);
	}
	return computeAutoConcurrentLimit(memStatus?.memTotalGb ?? null, resolveMemoryConfig(optIn));
}

function resolveProjectContext(root = process.cwd(), env = process.env, tmpRoot = null) {
	const projectDir = (env && env.CLAUDE_PROJECT_DIR) || root;
	const roleState = fs.existsSync(path.join(projectDir, ".naia-role.json"));
	const optInRoot = roleState ? projectDir : root;
	// Keep role counters scoped under the role directory so distinct roles
	// reusing the same session_id stay isolated.
	const budgetDir = tmpRoot || (roleState ? path.join(path.resolve(projectDir), ".claude", "subagent-budget") : null);
	return { projectDir, roleState, optInRoot, budgetDir };
}

function counterPath(sessionId, tmpRoot) {
	const base = tmpRoot || path.join(os.tmpdir(), "claude-subagent-budget");
	const safe = String(sessionId || "unknown").replace(/[^\w.-]/g, "_");
	return path.join(base, `${safe}.json`);
}

function parseTimestampMs(isoOrMs) {
	if (Number.isFinite(isoOrMs)) return isoOrMs;
	if (typeof isoOrMs === "string" && isoOrMs) {
		const parsed = Date.parse(isoOrMs);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

function normalizeActiveEntry(entry, now, staleMs) {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
	const updatedAtMs = parseTimestampMs(entry.updatedAtMs) ?? parseTimestampMs(entry.updatedAt) ?? parseTimestampMs(entry.startedAtMs) ?? parseTimestampMs(entry.startedAt);
	if (updatedAtMs === null || now - updatedAtMs >= staleMs) return null;
	const startedAtMs = parseTimestampMs(entry.startedAtMs) ?? parseTimestampMs(entry.startedAt) ?? updatedAtMs;
	const toolUseId = normalizeId(entry.toolUseId);
	const agentId = normalizeId(entry.agentId);
	const id = normalizeId(entry.id) || toolUseId || agentId;
	if (!id) return null;
	return {
		id,
		toolUseId,
		agentId,
		startedAt: typeof entry.startedAt === "string" && entry.startedAt ? entry.startedAt : new Date(startedAtMs).toISOString(),
		startedAtMs,
		updatedAt: typeof entry.updatedAt === "string" && entry.updatedAt ? entry.updatedAt : new Date(updatedAtMs).toISOString(),
		updatedAtMs,
		description: typeof entry.description === "string" ? entry.description : "",
		subagentType: typeof entry.subagentType === "string" ? entry.subagentType : "",
		runInBackground: Boolean(entry.runInBackground),
	};
}

function normalizeRecentlyStopped(rawMap, now, staleMs) {
	const out = {};
	if (!rawMap || typeof rawMap !== "object" || Array.isArray(rawMap)) return out;
	const entries = Object.entries(rawMap)
		.filter(([key, ts]) => typeof key === "string" && key && Number.isFinite(ts) && now - ts < staleMs)
		.sort((a, b) => a[1] - b[1])
		.slice(-64);
	for (const [key, ts] of entries) out[key] = ts;
	return out;
}

/**
 * Parse active slot state. Legacy cumulative (`{spawns:n}`) and sliding-window
 * (`{spawns:n, times:[...]}`) counter files are accepted as 0 running slots so
 * upgrading never locks out sessions on stale counters.
 */
function parseState(parsed, now = Date.now(), staleMs = DEFAULT_STALE_MS) {
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("invalid counter");
	}
	if (Array.isArray(parsed.active)) {
		const active = [];
		for (const item of parsed.active) {
			const normalized = normalizeActiveEntry(item, now, staleMs);
			if (normalized) active.push(normalized);
		}
		return {
			active,
			recentlyStopped: normalizeRecentlyStopped(parsed.recentlyStopped, now, staleMs),
		};
	}
	if ((Number.isSafeInteger(parsed.spawns) && parsed.spawns >= 0) || Array.isArray(parsed.times)) {
		return { active: [], recentlyStopped: {} };
	}
	throw new Error("invalid counter");
}

function readCount(sessionId, tmpRoot, now = Date.now(), staleMs = DEFAULT_STALE_MS) {
	try {
		const parsed = JSON.parse(fs.readFileSync(counterPath(sessionId, tmpRoot), "utf8"));
		return parseState(parsed, now, staleMs).active.length;
	} catch {
		return 0;
	}
}

function acquireLock(lockPath, now) {
	const deadline = Date.now() + LOCK_WAIT_LIMIT_MS;
	for (;;) {
		try {
			return fs.openSync(lockPath, "wx");
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			try {
				const stat = fs.statSync(lockPath);
				if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
					fs.unlinkSync(lockPath);
					continue;
				}
			} catch { /* retry or fail on next openSync */ }
			if (Date.now() >= deadline) throw error;
			sleepMs(LOCK_RETRY_MS);
		}
	}
}

function withBudgetLock(target, { createDir = true, now = Date.now(), staleMs = DEFAULT_STALE_MS }, handler) {
	const lock = `${target}.lock`;
	let descriptor = null;
	let temporary = null;
	try {
		if (!createDir && !fs.existsSync(target)) return { ok: true, skipped: true };
		fs.mkdirSync(path.dirname(target), { recursive: true });
		descriptor = acquireLock(lock, now);
		let state = { active: [], recentlyStopped: {} };
		if (fs.existsSync(target)) {
			const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
			state = parseState(parsed, now, staleMs);
		}
		const result = handler(state);
		if (result.write) {
			temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
			fs.writeFileSync(temporary, JSON.stringify({
				version: 2,
				active: state.active,
				recentlyStopped: state.recentlyStopped,
				updatedAt: new Date(now).toISOString(),
			}));
			fs.renameSync(temporary, target);
			temporary = null;
		}
		return result.value;
	} catch {
		return { ok: false, kind: "counter", used: null, active: [] };
	} finally {
		if (temporary) {
			try { fs.unlinkSync(temporary); } catch { /* best effort */ }
		}
		if (descriptor !== null) {
			try { fs.closeSync(descriptor); } catch { /* best effort */ }
			try { fs.unlinkSync(lock); } catch { /* best effort */ }
		}
	}
}

/** Reserve one concurrent subagent slot while holding an exclusive session lock. */
function reserveSpawn(sessionId, limit, tmpRoot, now = Date.now(), meta = {}) {
	const staleMs = Number.isFinite(meta.staleMs) && meta.staleMs > 0 ? meta.staleMs : DEFAULT_STALE_MS;
	const target = counterPath(sessionId, tmpRoot);
	const toolUseId = normalizeId(meta.toolUseId);
	return withBudgetLock(target, { createDir: true, now, staleMs }, (state) => {
		const timestamp = new Date(now).toISOString();
		// Same-tool_use_id reservation is idempotent so dual repo + user profile
		// hook registrations never count one spawn twice.
		if (toolUseId) {
			const existing = state.active.find((slot) => slot.toolUseId === toolUseId);
			if (existing) {
				existing.updatedAt = timestamp;
				existing.updatedAtMs = now;
				return { write: true, value: { ok: true, id: existing.id, used: state.active.length, active: [...state.active], duplicate: true } };
			}
		}
		if (typeof meta.memoryCheck === "function") {
			const memResult = meta.memoryCheck(state.active.length);
			if (memResult && !memResult.ok) {
				return {
					write: false,
					value: {
						ok: false,
						kind: "memory",
						availableGb: memResult.availableGb,
						requiredGb: memResult.requiredGb,
						used: state.active.length,
						active: [...state.active],
					},
				};
			}
		}
		if (state.active.length >= limit) {
			return {
				write: false,
				value: { ok: false, kind: "budget", used: state.active.length, active: [...state.active] },
			};
		}
		const id = toolUseId || `slot-${now}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
		const toolInput = meta.toolInput && typeof meta.toolInput === "object" ? meta.toolInput : {};
		state.active.push({
			id,
			toolUseId,
			agentId: null,
			startedAt: timestamp,
			startedAtMs: now,
			updatedAt: timestamp,
			updatedAtMs: now,
			description: typeof meta.description === "string" ? meta.description : describeSpawn(toolInput),
			subagentType: typeof meta.subagentType === "string"
				? meta.subagentType
				: (typeof toolInput.subagent_type === "string" ? toolInput.subagent_type.trim() : ""),
			runInBackground: Boolean(toolInput.run_in_background),
		});
		return { write: true, value: { ok: true, id, used: state.active.length, active: [...state.active] } };
	});
}

function isAsyncLaunchResponse(toolResponse) {
	if (!toolResponse || typeof toolResponse !== "object" || Array.isArray(toolResponse)) return false;
	return toolResponse.status === "async_launched" || toolResponse.isAsync === true;
}

function responseAgentId(toolResponse) {
	if (!toolResponse || typeof toolResponse !== "object" || Array.isArray(toolResponse)) return null;
	return normalizeId(toolResponse.agentId || toolResponse.agent_id);
}

function updateOnPostToolUse({ sessionId, tmpRoot, toolUseId, toolResponse, now = Date.now(), staleMs = DEFAULT_STALE_MS }) {
	const target = counterPath(sessionId, tmpRoot);
	const normalizedToolUseId = normalizeId(toolUseId);
	const agentId = responseAgentId(toolResponse);
	const asyncLaunch = isAsyncLaunchResponse(toolResponse);
	return withBudgetLock(target, { createDir: false, now, staleMs }, (state) => {
		const before = state.active.length;
		if (asyncLaunch) {
			const idx = normalizedToolUseId
				? state.active.findIndex((slot) => slot.toolUseId === normalizedToolUseId)
				: -1;
			if (idx === -1) return { write: false, value: { ok: true, changed: false, activeCount: before } };
			const slot = state.active[idx];
			const stoppedAt = agentId ? state.recentlyStopped[agentId] : undefined;
			// Background subagent finished before PostToolUse ran.
			if (agentId && Number.isFinite(stoppedAt) && stoppedAt >= slot.startedAtMs) {
				state.active.splice(idx, 1);
				delete state.recentlyStopped[agentId];
				return { write: true, value: { ok: true, changed: true, released: true, activeCount: state.active.length } };
			}
			slot.runInBackground = true;
			if (agentId) slot.agentId = agentId;
			slot.updatedAt = new Date(now).toISOString();
			slot.updatedAtMs = now;
			return { write: true, value: { ok: true, changed: true, released: false, boundAgentId: slot.agentId, activeCount: state.active.length } };
		}

		// Foreground Agent/Task completed: release slot by tool_use_id or agentId.
		state.active = state.active.filter((slot) => {
			if (normalizedToolUseId && slot.toolUseId === normalizedToolUseId) return false;
			if (agentId && slot.agentId === agentId) return false;
			return true;
		});
		if (agentId) delete state.recentlyStopped[agentId];
		return {
			write: state.active.length !== before || Boolean(agentId),
			value: { ok: true, changed: state.active.length !== before, released: true, activeCount: state.active.length },
		};
	});
}

function releaseOnFailure({ sessionId, tmpRoot, toolUseId, agentId, now = Date.now(), staleMs = DEFAULT_STALE_MS }) {
	const target = counterPath(sessionId, tmpRoot);
	const normalizedToolUseId = normalizeId(toolUseId);
	const normalizedAgentId = normalizeId(agentId);
	if (!normalizedToolUseId && !normalizedAgentId) return { ok: true, skipped: true };
	return withBudgetLock(target, { createDir: false, now, staleMs }, (state) => {
		const before = state.active.length;
		state.active = state.active.filter((slot) => {
			if (normalizedToolUseId && slot.toolUseId === normalizedToolUseId) return false;
			if (normalizedAgentId && slot.agentId === normalizedAgentId) return false;
			return true;
		});
		return {
			write: state.active.length !== before,
			value: { ok: true, changed: state.active.length !== before, released: state.active.length !== before, activeCount: state.active.length },
		};
	});
}

function releaseOnSubagentStop({ sessionId, tmpRoot, agentId, now = Date.now(), staleMs = DEFAULT_STALE_MS }) {
	const target = counterPath(sessionId, tmpRoot);
	const normalizedAgentId = normalizeId(agentId);
	if (!normalizedAgentId) return { ok: true, skipped: true };
	return withBudgetLock(target, { createDir: false, now, staleMs }, (state) => {
		const before = state.active.length;
		state.active = state.active.filter((slot) => slot.agentId !== normalizedAgentId);
		const matched = before - state.active.length;
		if (matched === 0) {
			// Either a foreground subagent whose PostToolUse will clean up by toolUseId,
			// or a fast background agent racing ahead of PostToolUse(async_launched).
			state.recentlyStopped[normalizedAgentId] = now;
		}
		return {
			write: true,
			value: { ok: true, released: matched > 0, matched, activeCount: state.active.length },
		};
	});
}

function formatBlockReason(used, limit, active, staleMs) {
	const staleMinutes = Math.max(1, Math.round(staleMs / 60000));
	const lines = active.map((slot) => `- ${slot.startedAt || "?"} | ${formatSlotLabel(slot)}`);
	const listSection = lines.length ? `\n구동 목록:\n${lines.join("\n")}\n` : " ";
	return (
		`[SUBAGENT GUARD] 지금 동시 ${used}개 구동 중(상한 ${limit}).` +
		`${listSection}하나가 끝나거나 ${staleMinutes}분 시한이 지나면 다시 열 수 있다. ` +
		`예산은 \`.claude/${OPT_IN_FILE}\` 의 maxConcurrent 로 조정한다(옛 maxSpawns 도 지원).`
	);
}

function formatMemoryBlockReason(availableGb, requiredGb, memConfig, activeCount, limit) {
	const displayAvail = (Math.floor(Math.max(0, availableGb) * 100) / 100).toFixed(2);
	const displayReq = requiredGb.toFixed(2);
	const marginGb = Math.max(DEFAULT_MEM_AVAIL_MARGIN_GB, memConfig.memPerSubagentGb);
	return (
		`[SUBAGENT GUARD] 남은 가용 메모리 ${displayAvail}GB가 최소 기준 ${displayReq}GB` +
		`(예비 ${memConfig.reserveMemGb}GB + 최소 여유 ${marginGb}GB)보다 적어 ` +
		`서브에이전트 생성을 거부한다 (현재 동시 ${activeCount}개 구동 중, 세션 상한 ${limit}).`
	);
}

/**
 * Returns { reason } to block, or null to pass. Reserving happens only on the
 * pass path, so a denied spawn never occupies a concurrency slot.
 */
function evaluate({
	toolName,
	toolInput = null,
	toolUseId = null,
	sessionId = null,
	root = process.cwd(),
	env = process.env,
	tmpRoot = null,
	now = Date.now(),
	staleMs = DEFAULT_STALE_MS,
	readMemInfo = defaultReadMemInfo,
	totalMemBytes = os.totalmem,
} = {}) {
	if (disabled(env)) return null;
	if (!isSpawn(toolName)) return null;

	const { optInRoot, budgetDir } = resolveProjectContext(root, env, tmpRoot);
	const optIn = readOptIn(optInRoot);
	if (!optIn) {
		return {
			reason:
				"[SUBAGENT GUARD] 자동 서브에이전트 생성이 기본 차단이다. 2026-08-01~07 사이 " +
				"코덱스 입력 토큰의 72퍼센트가 서브에이전트에서 나왔고 한 부모가 자식 71개를 만들었다. " +
				`필요하면 사람이 \`.claude/${OPT_IN_FILE}\` 를 만들어 예산과 함께 허용한다. ` +
				"대부분의 작업은 직접 도구로 처리하는 편이 싸고 빠르다.",
		};
	}

	const unknownKeys = Object.keys(optIn).filter((key) => !OPT_IN_KEYS.has(key));
	if (unknownKeys.length) {
		return {
			reason:
				`[SUBAGENT GUARD] \`.claude/${OPT_IN_FILE}\` 에 모르는 키가 있다: ${unknownKeys.join(", ")}. ` +
				`예산 키는 maxConcurrent(또는 maxSpawns)다. 예: { "maxConcurrent": 8 } (상한 ${HARD_MAX_CONCURRENT}).`,
		};
	}

	const memConfig = resolveMemoryConfig(optIn);
	const memStatus = readMemoryStatus({ readMemInfo, totalMemBytes });
	const limit = resolveLimit(optIn, memStatus);
	const requiredAvailGb = memConfig.reserveMemGb + Math.max(DEFAULT_MEM_AVAIL_MARGIN_GB, memConfig.memPerSubagentGb);
	const reservation = reserveSpawn(sessionId, limit, budgetDir, now, {
		toolInput,
		toolUseId,
		staleMs,
		memoryCheck: () => {
			if (memStatus.memAvailableGb === null) return { ok: true };
			if (memStatus.memAvailableGb < requiredAvailGb) {
				return { ok: false, availableGb: memStatus.memAvailableGb, requiredGb: requiredAvailGb };
			}
			return { ok: true };
		},
	});
	if (!reservation.ok && reservation.kind === "memory") {
		return {
			reason: formatMemoryBlockReason(reservation.availableGb, reservation.requiredGb, memConfig, reservation.used, limit),
		};
	}
	if (!reservation.ok && reservation.kind === "budget") {
		return {
			reason: formatBlockReason(reservation.used, limit, reservation.active, staleMs),
		};
	}
	if (!reservation.ok) {
		return {
			reason:
				"[SUBAGENT GUARD] 워커 동시 구동 슬롯을 안전하게 예약할 수 없다. " +
				"동시 접근 충돌 또는 카운터 손상 가능성이 있어 생성을 차단한다.",
		};
	}
	return null;
}

function handleEvent({
	hookEventName = "PreToolUse",
	toolName,
	toolInput = null,
	toolResponse = null,
	toolUseId = null,
	agentId = null,
	sessionId = null,
	root = process.cwd(),
	env = process.env,
	tmpRoot = null,
	now = Date.now(),
	staleMs = DEFAULT_STALE_MS,
	readMemInfo = defaultReadMemInfo,
	totalMemBytes = os.totalmem,
} = {}) {
	if (!KNOWN_EVENTS.has(hookEventName)) return null;
	if (hookEventName === "PreToolUse") {
		return evaluate({ toolName, toolInput, toolUseId, sessionId, root, env, tmpRoot, now, staleMs, readMemInfo, totalMemBytes });
	}
	const { budgetDir } = resolveProjectContext(root, env, tmpRoot);
	if (hookEventName === "PostToolUse") {
		if (!isSpawn(toolName)) return null;
		updateOnPostToolUse({ sessionId, tmpRoot: budgetDir, toolUseId, toolResponse, now, staleMs });
		return null;
	}
	if (hookEventName === "PostToolUseFailure") {
		if (!isSpawn(toolName)) return null;
		releaseOnFailure({ sessionId, tmpRoot: budgetDir, toolUseId, agentId, now, staleMs });
		return null;
	}
	if (hookEventName === "SubagentStop") {
		releaseOnSubagentStop({ sessionId, tmpRoot: budgetDir, agentId, now, staleMs });
		return null;
	}
	return null;
}

async function main() {
	const argEvent = process.argv[2] && KNOWN_EVENTS.has(process.argv[2]) ? process.argv[2] : null;
	let raw = "";
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) raw += chunk;

	let data;
	try {
		data = JSON.parse(raw || "{}");
	} catch {
		if (argEvent && RELEASE_EVENTS.has(argEvent)) {
			process.exit(0);
		}
		process.stdout.write(JSON.stringify({
			decision: "block",
			reason: "[SUBAGENT GUARD] 가드 입력 JSON을 해석하지 못해 차단합니다 (fail-closed).",
		}));
		process.exit(0);
	}

	const eventName = typeof data?.hook_event_name === "string" && data.hook_event_name
		? data.hook_event_name
		: (argEvent || "PreToolUse");
	const decision = handleEvent({
		hookEventName: eventName,
		toolName: data?.tool_name,
		toolInput: data?.tool_input,
		toolResponse: data?.tool_response,
		toolUseId: data?.tool_use_id || null,
		agentId: data?.agent_id || data?.agentId || null,
		sessionId: data?.session_id || null,
		root: data?.cwd || process.cwd(),
		env: { ...process.env, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR || process.cwd() },
	});
	if (decision && eventName === "PreToolUse") {
		process.stdout.write(JSON.stringify({ decision: "block", reason: decision.reason }));
	}
	process.exit(0);
}

if (require.main === module) {
	main().catch(() => {
		const argEvent = process.argv[2] && KNOWN_EVENTS.has(process.argv[2]) ? process.argv[2] : null;
		if (argEvent && RELEASE_EVENTS.has(argEvent)) {
			process.exit(0);
		}
		process.stdout.write(JSON.stringify({
			decision: "block",
			reason: "[SUBAGENT GUARD] 가드 내부 오류로 워커 예산을 검증하지 못했다.",
		}));
	});
}

module.exports = {
	evaluate,
	handleEvent,
	isSpawn,
	readOptIn,
	readCount,
	reserveSpawn,
	updateOnPostToolUse,
	releaseOnFailure,
	releaseOnSubagentStop,
	disabled,
	resolveLimit,
	DEFAULT_MAX_CONCURRENT,
	HARD_MAX_CONCURRENT,
	DEFAULT_MAX_SPAWNS: DEFAULT_MAX_CONCURRENT,
	HARD_MAX_SPAWNS: HARD_MAX_CONCURRENT,
	DEFAULT_RESERVE_MEM_GB,
	DEFAULT_MEM_PER_SUBAGENT_GB,
	DEFAULT_ESTIMATED_SESSIONS,
	DEFAULT_MEM_AVAIL_MARGIN_GB,
	DEFAULT_STALE_MINUTES,
	DEFAULT_STALE_MS,
	resolveMemoryConfig,
	computeAutoConcurrentLimit,
	readMemoryStatus,
	parseMemInfo,
};
