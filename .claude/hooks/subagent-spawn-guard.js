/**
 * Claude Code PreToolUse(Task) — subagent spawn budget.
 *
 * Peer of .codex/hooks/subagent-spawn-guard.cjs. Between 2026-08-01 and 08-07,
 * 72% of Codex input tokens came from subagents and one parent spawned 71
 * children; nothing capped the count, so per-call limits never bound the total.
 * Claude Code can fan out the same way, so the same default applies here.
 *
 * Claude transcripts do not carry the rollout token counters the Codex guard
 * reads, so the budget here is spawn count per session rather than lineage
 * tokens. Count is the axis that actually ran away; tokens were the symptom.
 *
 * Three conditions to spawn: an opt-in marker exists, the session is under its
 * spawn budget, and the guard is not explicitly disabled.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const OFF_VALUES = new Set(["off", "0", "false", "no"]);
const OPT_IN_FILE = "allow-subagents";
const MODEL_POLICY_FILE = "subagent-model-policy.json";
const DEFAULT_MODEL_POLICY = Object.freeze({
	allowedModels: Object.freeze(["haiku", "sonnet"]),
	requireExplicitModel: true,
	overrideFile: ".claude/allow-upper-subagent-until",
	hint: "",
});
// Both hosts' spawn tools. A name this set misses is a spawn the budget below
// never caps, and each guard used to know only its own host's names.
const SPAWN_TOOLS = new Set(["task", "agent", "spawn_agent", "multi_agent_v1", "multi_agent_v1__spawn_agent", "collaboration.spawn_agent", "collaborationspawn_agent"]);
const DEFAULT_MAX_SPAWNS = 4;
const HARD_MAX_SPAWNS = 8;

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
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function readModelPolicy(root) {
	const policyPath = path.join(root, ".claude", MODEL_POLICY_FILE);
	let parsed;
	try {
		parsed = JSON.parse(fs.readFileSync(policyPath, "utf8"));
	} catch {
		return { ...DEFAULT_MODEL_POLICY, allowedModels: [...DEFAULT_MODEL_POLICY.allowedModels] };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ...DEFAULT_MODEL_POLICY, allowedModels: [...DEFAULT_MODEL_POLICY.allowedModels] };
	}
	const allowedModels = Array.isArray(parsed.allowedModels) && parsed.allowedModels.every(
		(model) => typeof model === "string" && model.trim().length > 0,
	)
		? parsed.allowedModels.map((model) => model.trim())
		: [...DEFAULT_MODEL_POLICY.allowedModels];
	return {
		allowedModels,
		requireExplicitModel: typeof parsed.requireExplicitModel === "boolean"
			? parsed.requireExplicitModel
			: DEFAULT_MODEL_POLICY.requireExplicitModel,
		overrideFile: typeof parsed.overrideFile === "string" && parsed.overrideFile.trim()
			? parsed.overrideFile.trim()
			: DEFAULT_MODEL_POLICY.overrideFile,
		hint: typeof parsed.hint === "string" ? parsed.hint.trim() : DEFAULT_MODEL_POLICY.hint,
	};
}

function isoTimestamp(value) {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return null;
	const [year, month, day] = value.slice(0, 10).split("-").map(Number);
	const date = new Date(Date.UTC(year, month - 1, day));
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
	const time = value.slice(11, 19).split(":").map(Number);
	if (time[0] > 23 || time[1] > 59 || time[2] > 59) return null;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : null;
}

function readOverride(overridePath, now) {
	let raw;
	try {
		raw = fs.readFileSync(overridePath, "utf8");
	} catch {
		return { active: false, state: "missing" };
	}
	const timestampText = raw.endsWith("\r\n")
		? raw.slice(0, -2)
		: raw.endsWith("\n") ? raw.slice(0, -1) : raw;
	if (!timestampText || /[\r\n]/u.test(timestampText) || timestampText.trim() !== timestampText) {
		return { active: false, state: "invalid" };
	}
	const expiresAt = isoTimestamp(timestampText);
	if (expiresAt === null) return { active: false, state: "invalid" };
	if (expiresAt <= now) return { active: false, state: "expired", expiresAt };
	return { active: true, state: "active", expiresAt };
}

function oneLine(value) {
	return String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, 240);
}

function checkModel(model, root, now = Date.now()) {
	const policy = readModelPolicy(root);
	const requested = typeof model === "string" ? model.trim() : "";
	const normalizedAllowed = policy.allowedModels.map((item) => item.toLowerCase());
	const isMissing = model === undefined || model === null || (typeof model === "string" && requested.length === 0);
	const isAllowed = typeof model === "string" && normalizedAllowed.includes(requested.toLowerCase());
	if ((isMissing && !policy.requireExplicitModel) || isAllowed) return null;

	const overridePath = path.isAbsolute(policy.overrideFile)
		? policy.overrideFile
		: path.resolve(root, policy.overrideFile);
	const override = readOverride(overridePath, now);
	if (override.active) {
		const remainingSeconds = Math.ceil((override.expiresAt - now) / 1000);
		return {
			stderr: `[SUBAGENT GUARD] upper-model override active; ${remainingSeconds}s remain (until ${new Date(override.expiresAt).toISOString()}).`,
		};
	}

	const allowed = policy.allowedModels.length ? oneLine(policy.allowedModels.join(", ")) : "(none)";
	const hint = oneLine(policy.hint) || "(none)";
	const requestedLabel = typeof model === "string"
		? oneLine(requested) || "(empty)"
		: model === undefined ? "(missing)" : model === null ? "(null)" : oneLine(`${typeof model}: ${JSON.stringify(model)}`);
	const overrideLabel = oneLine(policy.overrideFile);
	const overrideState = override.state === "expired" ? "expired" : override.state === "invalid" ? "invalid" : "unavailable";
	return {
		reason: `[SUBAGENT GUARD] requested model: ${requestedLabel}; allowed models: ${allowed}; hint: ${hint}; exception file: ${overrideLabel} (${overrideState}).`,
	};
}

function counterPath(sessionId, tmpRoot) {
	const base = tmpRoot || path.join(os.tmpdir(), "claude-subagent-budget");
	const safe = String(sessionId || "unknown").replace(/[^\w.-]/g, "_");
	return path.join(base, `${safe}.json`);
}

function readCount(sessionId, tmpRoot) {
	try {
		const parsed = JSON.parse(fs.readFileSync(counterPath(sessionId, tmpRoot), "utf8"));
		return Number.isSafeInteger(parsed.spawns) && parsed.spawns >= 0 ? parsed.spawns : 0;
	} catch {
		return 0;
	}
}

/** Reserve one spawn while holding an exclusive per-session lock. */
function reserveSpawn(sessionId, limit, tmpRoot) {
	const target = counterPath(sessionId, tmpRoot);
	const lock = `${target}.lock`;
	let descriptor = null;
	let temporary = null;
	try {
		fs.mkdirSync(path.dirname(target), { recursive: true });
		descriptor = fs.openSync(lock, "wx");
		let used = 0;
		if (fs.existsSync(target)) {
			const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
			if (!Number.isSafeInteger(parsed.spawns) || parsed.spawns < 0) {
				throw new Error("invalid counter");
			}
			used = parsed.spawns;
		}
		if (used >= limit) return { ok: false, kind: "budget", used };

		temporary = `${target}.${process.pid}.tmp`;
		fs.writeFileSync(temporary, JSON.stringify({ spawns: used + 1, updatedAt: new Date().toISOString() }));
		fs.renameSync(temporary, target);
		temporary = null;
		return { ok: true, used: used + 1 };
	} catch {
		return { ok: false, kind: "counter", used: null };
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

/**
 * Returns { reason } to block, or null to pass. Counting happens only on the
 * pass path, so a denied spawn never inflates the session's own budget.
 */
function evaluate({ toolName, sessionId = null, root = process.cwd(), env = process.env, tmpRoot = null } = {}) {
	if (disabled(env)) return null;
	if (!isSpawn(toolName)) return null;

	const optIn = readOptIn(root);
	if (!optIn) {
		return {
			reason:
				"[SUBAGENT GUARD] 자동 서브에이전트 생성이 기본 차단이다. 2026-08-01~07 사이 " +
				"코덱스 입력 토큰의 72퍼센트가 서브에이전트에서 나왔고 한 부모가 자식 71개를 만들었다. " +
				`필요하면 사람이 \`.claude/${OPT_IN_FILE}\` 를 만들어 예산과 함께 허용한다. ` +
				"대부분의 작업은 직접 도구로 처리하는 편이 싸고 빠르다.",
		};
	}

	const requested = Number.isSafeInteger(optIn.maxSpawns) && optIn.maxSpawns >= 0
		? optIn.maxSpawns
		: DEFAULT_MAX_SPAWNS;
	const limit = Math.min(requested, HARD_MAX_SPAWNS);
	const reservation = reserveSpawn(sessionId, limit, tmpRoot);
	if (!reservation.ok && reservation.kind === "budget") {
		return {
			reason:
				`[SUBAGENT GUARD] 이 세션이 이미 서브에이전트 ${reservation.used}개를 생성했다 (상한 ${limit}). ` +
				"사람이 예산을 다시 정하기 전에는 더 생성하지 않는다. " +
				`예산은 \`.claude/${OPT_IN_FILE}\` 의 maxSpawns 로 조정한다.`,
		};
	}
	if (!reservation.ok) {
		return {
			reason:
				"[SUBAGENT GUARD] 워커 예산 카운터를 안전하게 예약할 수 없다. " +
				"동시 생성 또는 카운터 손상 가능성이 있어 생성을 차단한다.",
		};
	}
	return null;
}

// Keep the shared spawn-budget evaluator model-agnostic: the Codex adapter
// reuses it only for counting, while Claude has the model field at PreToolUse.
function evaluateClaudeSpawn({ toolName, model, sessionId = null, root = process.cwd(), env = process.env, tmpRoot = null, now = Date.now() } = {}) {
	if (disabled(env) || !isSpawn(toolName)) return evaluate({ toolName, sessionId, root, env, tmpRoot });
	const modelDecision = checkModel(model, root, now);
	if (modelDecision?.reason) return modelDecision;
	const budgetDecision = evaluate({ toolName, sessionId, root, env, tmpRoot });
	if (budgetDecision?.reason) return budgetDecision;
	return modelDecision?.stderr ? modelDecision : null;
}

async function main() {
	let raw = "";
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) raw += chunk;

	let data;
	try {
		data = JSON.parse(raw || "{}");
	} catch {
		process.exit(0);
	}

	const decision = evaluateClaudeSpawn({
		toolName: data.tool_name,
		model: data.tool_input?.model,
		sessionId: data.session_id || null,
		root: data.cwd || process.cwd(),
	});
	if (decision?.reason) {
		process.stdout.write(JSON.stringify({ decision: "block", reason: decision.reason }));
	} else if (decision?.stderr) {
		process.stderr.write(`${decision.stderr}\n`);
	}
	process.exit(0);
}

if (require.main === module) {
	main().catch(() => {
		process.stdout.write(JSON.stringify({
			decision: "block",
			reason: "[SUBAGENT GUARD] 가드 내부 오류로 워커 예산을 검증하지 못했다.",
		}));
	});
}

module.exports = {
	evaluate,
	evaluateClaudeSpawn,
	isSpawn,
	readOptIn,
	readModelPolicy,
	checkModel,
	isoTimestamp,
	readOverride,
	readCount,
	reserveSpawn,
	disabled,
	DEFAULT_MAX_SPAWNS,
	HARD_MAX_SPAWNS,
};
