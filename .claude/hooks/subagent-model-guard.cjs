#!/usr/bin/env node
"use strict";

// Standalone Claude Code PreToolUse model and delegation-policy guard.
// This file is copied to ~/.claude and intentionally uses only Node built-ins.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const POLICY_FILE = "subagent-model-policy.json";
const OFF_VALUES = new Set(["off", "0", "false", "no"]);
const DEFAULT_POLICY = Object.freeze({
	allowedModels: Object.freeze(["haiku", "sonnet"]),
	requireExplicitModel: true,
	requireBrief: true,
	overrideFile: "allow-upper-subagent-until",
	maxOverrideHours: 24,
});
const TARGET_TOOLS = new Set(["agent", "task", "workflow"]);
const MAX_DATE_MS = 8.64e15;

function disabled(env = process.env) {
	return OFF_VALUES.has(String(env.CLAUDE_SUBAGENT_MODEL_GUARD || "").trim().toLowerCase());
}

function isTargetTool(toolName) {
	return TARGET_TOOLS.has(String(toolName || "").trim().toLowerCase());
}

function normalizeOverrideFile(value) {
	if (typeof value !== "string") return DEFAULT_POLICY.overrideFile;
	const file = value.trim();
	if (!file || file === "." || file === ".." || path.isAbsolute(file) || /[\\/]/u.test(file)) {
		return DEFAULT_POLICY.overrideFile;
	}
	return file;
}

function normalizePolicy(value) {
	const parsed = value && typeof value === "object" && !Array.isArray(value) ? value : {};
	const candidateModels = Array.isArray(parsed.allowedModels)
		? parsed.allowedModels.filter((model) => typeof model === "string" && model.trim()).map((model) => model.trim())
		: [];
	const hours = parsed.maxOverrideHours;
	const maxOverrideHours = typeof hours === "number" && Number.isFinite(hours) && hours > 0 &&
		hours * 3_600_000 <= MAX_DATE_MS
		? hours
		: DEFAULT_POLICY.maxOverrideHours;
	return {
		allowedModels: candidateModels.length ? candidateModels : [...DEFAULT_POLICY.allowedModels],
		requireExplicitModel: typeof parsed.requireExplicitModel === "boolean"
			? parsed.requireExplicitModel
			: DEFAULT_POLICY.requireExplicitModel,
		requireBrief: typeof parsed.requireBrief === "boolean"
			? parsed.requireBrief
			: DEFAULT_POLICY.requireBrief,
		overrideFile: normalizeOverrideFile(parsed.overrideFile),
		maxOverrideHours,
	};
}

function exists(filePath) {
	try {
		return fs.existsSync(filePath);
	} catch {
		return false;
	}
}

function findPolicyFile({ cwd, home, env = process.env } = {}) {
	const workingDirectory = path.resolve(cwd || process.cwd());
	const envPath = typeof env.CLAUDE_SUBAGENT_MODEL_POLICY === "string"
		? env.CLAUDE_SUBAGENT_MODEL_POLICY.trim()
		: "";
	if (envPath) {
		const candidate = path.resolve(workingDirectory, envPath);
		if (exists(candidate)) return candidate;
	}

	let current = workingDirectory;
	while (true) {
		const candidate = path.join(current, ".claude", POLICY_FILE);
		if (exists(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	const homeDirectory = path.resolve(home || env.HOME || os.homedir());
	const homePolicy = path.join(homeDirectory, ".claude", POLICY_FILE);
	return exists(homePolicy) ? homePolicy : null;
}

function readPolicy(options = {}) {
	const policyPath = findPolicyFile(options);
	if (!policyPath) return { ...normalizePolicy(null), policyPath: null };
	try {
		const parsed = JSON.parse(fs.readFileSync(policyPath, "utf8"));
		return { ...normalizePolicy(parsed), policyPath };
	} catch {
		return { ...normalizePolicy(null), policyPath };
	}
}

function parseIsoTimestamp(value) {
	if (typeof value !== "string") return null;
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
	if (!match) return null;
	const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match;
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	const hour = Number(hourText);
	const minute = Number(minuteText);
	const second = Number(secondText);
	if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
	const calendar = new Date(Date.UTC(year, month - 1, day));
	if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
	if (zone !== "Z") {
		const offset = /[+-](\d{2}):(\d{2})$/u.exec(zone);
		if (!offset || Number(offset[1]) > 23 || Number(offset[2]) > 59) return null;
	}
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : null;
}

function readOverride(overridePath, now, maxOverrideHours) {
	let raw;
	try {
		raw = fs.readFileSync(overridePath, "utf8");
	} catch {
		return { active: false, state: "missing" };
	}
	let timestampText = raw;
	if (timestampText.endsWith("\r\n")) timestampText = timestampText.slice(0, -2);
	else if (timestampText.endsWith("\n")) timestampText = timestampText.slice(0, -1);
	if (!timestampText || /[\r\n]/u.test(timestampText) || timestampText.trim() !== timestampText) {
		return { active: false, state: "invalid" };
	}
	const expiresAt = parseIsoTimestamp(timestampText);
	if (expiresAt === null) return { active: false, state: "invalid" };
	if (expiresAt <= now) return { active: false, state: "expired", expiresAt };
	const latestAllowed = now + maxOverrideHours * 3_600_000;
	if (!Number.isFinite(latestAllowed) || expiresAt > latestAllowed) {
		return { active: false, state: "too_far", expiresAt };
	}
	return { active: true, state: "active", expiresAt };
}

function overrideCandidates(policy, home) {
	const candidates = [];
	if (policy.policyPath) {
		let policyDirectory = path.dirname(policy.policyPath);
		if (path.basename(policyDirectory) !== ".claude") policyDirectory = path.join(policyDirectory, ".claude");
		candidates.push(path.join(policyDirectory, policy.overrideFile));
	}
	if (home) candidates.push(path.join(home, ".claude", policy.overrideFile));
	return [...new Set(candidates)];
}

function findActiveOverride(policy, { home, env, now }) {
	const homeDirectory = path.resolve(home || env.HOME || os.homedir());
	const results = overrideCandidates(policy, homeDirectory)
		.map((filePath) => ({ filePath, ...readOverride(filePath, now, policy.maxOverrideHours) }))
		.filter((result) => result.active);
	if (!results.length) return null;
	return results.reduce((latest, current) => current.expiresAt > latest.expiresAt ? current : latest);
}

function hasRequiredBrief(prompt, label) {
	if (typeof prompt !== "string") return false;
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	const line = new RegExp(`^[ \\t]*(?:#{1,6}[ \\t]+|>[ \\t]*|[-*][ \\t]+)?${escaped}[ \\t]*:[ \\t]*\\S.*$`, "mu");
	return line.test(prompt);
}

function formatOverridePath(policy, home) {
	const candidates = overrideCandidates(policy, path.resolve(home || os.homedir()));
	return candidates[0] || path.join(home || os.homedir(), ".claude", policy.overrideFile);
}

function evaluate({ toolName, toolInput = {}, cwd = process.cwd(), home, env = process.env, now = Date.now() } = {}) {
	if (disabled(env) || !isTargetTool(toolName)) return null;
	const tool = String(toolName).trim();
	const input = toolInput && typeof toolInput === "object" && !Array.isArray(toolInput) ? toolInput : {};
	const policy = readPolicy({ cwd, home, env });
	const homeDirectory = path.resolve(home || env.HOME || os.homedir());
	const override = findActiveOverride(policy, { home: homeDirectory, env, now });
	const overridePath = formatOverridePath(policy, homeDirectory);
	const overrideLog = override
		? `[SUBAGENT MODEL GUARD] 긴급 예외 표지 활성 — ${Math.ceil((override.expiresAt - now) / 1000)}초 남음 (${new Date(override.expiresAt).toISOString()}).`
		: null;
	const urgentHint = `긴급 예외는 ${overridePath}에 허용 시간 이내의 ISO 시각 한 줄을 적으세요.`;
	const implementationHint = "구현·검수는 바깥 모델 대본으로 진행하세요.";

	if (tool.toLowerCase() === "workflow") {
		if (!override) {
			return {
				reason: `[SUBAGENT MODEL GUARD] 여러 하위 작업 묶음 실행은 긴급 예외 때만 허용됩니다. 일반 하위 작업은 Agent/Task에 model haiku/sonnet과 두 안내 줄을 지정하세요. ${urgentHint} ${implementationHint}`,
			};
		}
		return { stderr: overrideLog };
	}

	const isFork = input.subagent_type === "fork";
	if (isFork && !override) {
		return {
			reason: `[SUBAGENT MODEL GUARD] subagent_type=fork는 부모 모델을 그대로 물려받습니다. Agent/Task에 model을 haiku/sonnet으로 지정하고 prompt에 상위 목표: 및 막히면 올림: 줄을 넣으세요. ${urgentHint} ${implementationHint}`,
		};
	}

	const requestedModel = input.model;
	const missingModel = requestedModel === undefined || requestedModel === null ||
		(typeof requestedModel === "string" && requestedModel.trim() === "");
	const allowed = typeof requestedModel === "string" &&
		policy.allowedModels.some((model) => model.toLowerCase() === requestedModel.trim().toLowerCase());
	let modelProblem = null;
	if (missingModel && policy.requireExplicitModel) modelProblem = "model이 지정되지 않았습니다";
	else if (!missingModel && !allowed) modelProblem = `허용 목록 밖 model(${String(requestedModel).slice(0, 80)})입니다`;
	if (modelProblem && !override) {
		return {
			reason: `[SUBAGENT MODEL GUARD] ${tool} 도구 거부: ${modelProblem}. model을 ${policy.allowedModels.join("/")} 중 하나로 지정하세요. ${implementationHint} ${urgentHint}`,
		};
	}

	if (policy.requireBrief) {
		const missing = [];
		if (!hasRequiredBrief(input.prompt, "상위 목표")) missing.push("상위 목표:");
		if (!hasRequiredBrief(input.prompt, "막히면 올림")) missing.push("막히면 올림:");
		if (missing.length) {
			return {
				reason: `[SUBAGENT MODEL GUARD] ${tool} prompt에 ${missing.join(" 및 ")} 줄이 필요합니다. 두 줄을 추가하세요. 긴급 예외 표지로도 이 드리프트 방지 규칙은 풀리지 않습니다. 구현·검수는 바깥 모델 대본으로 진행하세요.`,
			};
		}
	}

	return override && (isFork || modelProblem) ? { stderr: overrideLog } : null;
}

async function main() {
	let raw = "";
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) raw += chunk;
	let data;
	try {
		data = JSON.parse(raw || "{}");
	} catch {
		return;
	}
	if (!data || typeof data !== "object" || !isTargetTool(data.tool_name)) return;
	let decision;
	try {
		decision = evaluate({
			toolName: data.tool_name,
			toolInput: data.tool_input,
			cwd: data.cwd || process.cwd(),
			env: process.env,
		});
	} catch {
		decision = { reason: "[SUBAGENT MODEL GUARD] 대상 하위 작업을 안전하게 판정하지 못해 거부했습니다." };
	}
	if (decision?.reason) process.stdout.write(JSON.stringify({ decision: "block", reason: decision.reason }));
	else if (decision?.stderr) process.stderr.write(`${decision.stderr}\n`);
}

if (require.main === module) {
	main().catch(() => {});
}

module.exports = {
	DEFAULT_POLICY,
	disabled,
	evaluate,
	findPolicyFile,
	hasRequiredBrief,
	isTargetTool,
	normalizePolicy,
	parseIsoTimestamp,
	readOverride,
	readPolicy,
};
