#!/usr/bin/env node

const path = require("node:path");
const contracts = require("../../.agents/hooks/core/session-contract.js");
const usage = require("../../scripts/codex-lineage-usage.cjs");

const SPAWN_NAMES = new Set(["spawn_agent", "spawn-agent", "spawnagent", "spawn_subagent", "spawn-subagent"]);
const ROLES = Object.freeze({
	secretary: ["gpt-5.6-luna", ["max"]],
	issue_leader: ["gpt-5.6-luna", ["max"]],
	analysis: ["gpt-5.6-sol", ["medium"]],
	design: ["gpt-5.6-sol", ["medium"]],
	review: ["gpt-5.6-sol", ["medium"]],
	implementation: ["gpt-5.6-luna", ["medium"]],
	test: ["gpt-5.6-luna", ["medium"]],
	worker: ["gpt-5.6-luna", ["medium"]],
	translation: ["gpt-5.6-luna", ["low"]],
});

function isSpawn(name) {
	const value = String(name || "").trim().toLowerCase();
	const leaf = value.split(/__|[.:/]/).filter(Boolean).at(-1) || "";
	return SPAWN_NAMES.has(value) || SPAWN_NAMES.has(leaf);
}

function inputOf(input) {
	if (typeof input === "string") {
		try { return JSON.parse(input); } catch { return {}; }
	}
	if (input && typeof input === "object") {
		for (const key of ["arguments", "input"]) {
			if (typeof input[key] === "string") {
				try { return { ...input, ...JSON.parse(input[key]) }; } catch { return {}; }
			}
		}
		return input;
	}
	return {};
}

function block(reason) {
	return { decision: "block", reason: `[SUBAGENT GUARD] ${reason}` };
}

function roleOf(input) {
	if (typeof input.message !== "string") return null;
	return input.message.match(/^\[balanced-role:(secretary|issue_leader|analysis|design|review|implementation|test|worker|translation)\](?:\r?\n|$)/i)?.[1]?.toLowerCase() || null;
}

function contextOk(input) {
	return input.fork_turns === "none" &&
		(!Object.hasOwn(input, "fork_context") || input.fork_context === false);
}

function evaluate({
	toolName,
	toolInput = {},
	sessionId = null,
	cwd = process.cwd(),
	contractLookup = null,
	sessionCollection = null,
	lineageReserve = null,
} = {}) {
	if (!isSpawn(toolName)) return null;
	const input = inputOf(toolInput);
	const resolved = (contractLookup || ((value) => contracts.resolveSessionContract(value)))({ cwd, sessionId });
	if (resolved?.status !== contracts.STATES.BOUND) return block("a current session-bound contract is required");
	const policy = resolved.contract?.subagent_policy;
	if (contracts.validateSubagentPolicy(policy)) return block("a valid contract subagent_policy is required");
	if (!contextOk(input)) return block("fork_turns none is required and fork_context, when present, must be false");
	if (typeof input.message !== "string" || Object.hasOwn(input, "items")) return block("one bounded text brief is required");
	const role = roleOf(input);
	const rule = ROLES[role];
	if (!rule || input.model !== rule[0] || !rule[1].includes(input.reasoning_effort) || Object.hasOwn(input, "reasoning")) {
		return block("role, model, or reasoning effort is not permitted by Balanced");
	}
	const promptBytes = Buffer.byteLength(input.message, "utf8");
	const collected = (sessionCollection || (() => usage.collectSessions({
		since: Date.parse(policy.budget_started_at),
		includeSessionId: sessionId,
	})))();
	const lineage = usage.findLineage(collected, sessionId, policy);
	const evaluation = usage.evaluateLineage(lineage, { policy, spawningSessionId: sessionId, pendingPromptBytes: promptBytes });
	if (!evaluation.ok) return block(evaluation.reasons.join(" / "));
	const reserve = (lineageReserve || ((value) => usage.reserveLineageSpawn(value, policy, undefined, promptBytes)))(lineage, policy, promptBytes);
	if (!reserve?.ok) return block("lineage reservation failed closed");
	return null;
}

async function main() {
	let raw = "";
	for await (const chunk of process.stdin) raw += chunk;
	let input;
	try { input = JSON.parse(raw); } catch {
		process.stdout.write(JSON.stringify(block("malformed hook input; denied")));
		return;
	}
	if (!input || typeof input !== "object" || typeof input.tool_name !== "string" || !input.tool_name.trim()) {
		process.stdout.write(JSON.stringify(block("required hook evidence is missing; denied")));
		return;
	}
	const result = evaluate({
		toolName: input.tool_name,
		toolInput: input.tool_input,
		sessionId: input.session_id,
		cwd: input.cwd || process.cwd(),
	});
	if (result) process.stdout.write(JSON.stringify(result));
}

if (require.main === module) main().catch(() => process.stdout.write(JSON.stringify(block("guard error; denied"))));

module.exports = { ROLES, contextOk, evaluate, inputOf, isSpawn, roleOf };
