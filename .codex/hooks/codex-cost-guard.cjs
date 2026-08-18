#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const contracts = require("../../.agents/hooks/core/session-contract.js");
const harnessSwitch = require("../../.agents/hooks/core/harness-switch.js");
const usage = require("../../scripts/codex-lineage-usage.cjs");
const blockLog = require("../../.agents/hooks/core/harness-block-log.js");

// Same opt-out the session-contract gate and harness core honor. Without it
// this guard stayed live after an operator disabled the harness, so a session
// with no indexed lineage (a fresh clone, a brand-new session) kept being
// blocked by a harness that was supposed to be off.
const HARNESS_OFF = new Set(["off", "0", "false", "no"]);
const HARNESS_ENV_VARS = ["AI_HARNESS", "CLAUDE_HARNESS", "CODEX_HARNESS"];
const HARNESS_CONFIG_DIRS = [".claude", ".codex", ".pi"];

function harnessDisabled({ env = null, roots = [] } = {}) {
	return harnessSwitch.harnessDisabled({ roots, env, envVars: HARNESS_ENV_VARS, configDirs: HARNESS_CONFIG_DIRS });
}

function block(reason) {
	return { decision: "block", reason: `[CODEX COST GUARD] ${reason}` };
}

function canonicalJson(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
	return JSON.stringify(value);
}

function evaluate({ sessionId = null, cwd = process.cwd(), env = process.env, contractLookup = null, sessionCollection = null, sessionChainCollection = null } = {}) {
	const lookup = contractLookup || ((value) => contracts.resolveSessionContract(value));
	const projectRoot = contracts.resolveHookProjectRoot(cwd, env) || cwd;
	// The marker may sit at the session cwd or at the repository root. Injected
	// sources mean a test is driving this, so keep those deterministic and let
	// them exercise enforcement even from a checkout that carries a marker.
	const usesRuntimeSources = contractLookup === null && sessionCollection === null && sessionChainCollection === null;
	if (usesRuntimeSources && harnessDisabled({ env, roots: [cwd, projectRoot] })) return null;
	let boundSessionId = sessionId;
	let resolved = lookup({ cwd: projectRoot, sessionId });
	let policy = resolved?.status === contracts.STATES.BOUND ? resolved.contract?.subagent_policy : null;
	if (!policy) {
		const chain = (sessionChainCollection || ((value) => usage.collectSessionChain(value)))({ sessionId });
		if (chain.ambiguous) return block("session lineage is ambiguous");
		const current = chain.sessions?.find((item) => item.sessionId === sessionId);
		// Cost ceilings belong to governed descendant lineages. A fresh root
		// session has no contract or indexed parent yet and must remain usable.
		if (!current && resolved?.status === contracts.STATES.UNBOUND) return null;
		if (!current) return block("session lineage is missing or unindexed");
		if (!current.parentId && !current.isSubagent) return null;
		boundSessionId = usage.lineageRootId(chain, sessionId);
		if (!boundSessionId) return block("subagent lineage root is missing or ambiguous");
		resolved = lookup({ cwd: projectRoot, sessionId: boundSessionId });
		if (resolved?.status !== contracts.STATES.BOUND) return block("subagent lineage root contract is not bound");
		policy = resolved.contract?.subagent_policy;
		if (!policy) return block("subagent lineage root policy is missing");
	}
	if (contracts.validateSubagentPolicy(policy)) return block("contract subagent_policy is invalid");
	const collected = (sessionCollection || (() => usage.collectSessions({
		since: Date.parse(policy.budget_started_at),
		includeSessionIds: [sessionId, boundSessionId],
	})))();
	let lineage = usage.findLineage(collected, boundSessionId, policy);
	if (boundSessionId === sessionId && lineage?.rootId && lineage.rootId !== sessionId) {
		boundSessionId = lineage.rootId;
		resolved = lookup({ cwd: projectRoot, sessionId: boundSessionId });
		if (resolved?.status !== contracts.STATES.BOUND) return block("subagent lineage root contract is not bound");
		const rootPolicy = resolved.contract?.subagent_policy;
		if (!rootPolicy || contracts.validateSubagentPolicy(rootPolicy) || canonicalJson(rootPolicy) !== canonicalJson(policy)) return block("subagent lineage root policy is missing or mismatched");
		policy = rootPolicy;
		lineage = usage.findLineage(collected, boundSessionId, policy);
	}
	const verdict = usage.evaluateLineage(lineage, { policy });
	return verdict.ok ? null : block(verdict.reasons.join(" / "));
}

async function main() {
	let raw = "";
	for await (const chunk of process.stdin) raw += chunk;
	let input;
	try { input = JSON.parse(raw); } catch {
		process.stdout.write(JSON.stringify(block("malformed hook input; denied")));
		return;
	}
	if (!input || typeof input !== "object" || typeof input.session_id !== "string" || !input.session_id.trim()) {
		process.stdout.write(JSON.stringify(block("required hook evidence is missing; denied")));
		return;
	}
	const result = evaluate({
		sessionId: input.session_id,
		cwd: input.cwd || process.cwd(),
		env: process.env,
	});
	if (result) {
		blockLog.record({
			hook: "codex-cost-guard", tool: input.tool_name, cwd: input.cwd,
			sessionId: input.session_id, toolInput: input.tool_input, reason: result.reason,
		});
		process.stdout.write(JSON.stringify(result));
	}
}

if (require.main === module) {
	main().catch((error) => {
		// The refusal text alone ("guard error") says nothing about what threw.
		// Keep the stack so the next occurrence is diagnosable from the repository.
		blockLog.record({ hook: "codex-cost-guard", tool: null, cwd: process.cwd(), reason: `guard error: ${(error && error.stack) || error}` });
		process.stdout.write(JSON.stringify(block("guard error; denied")));
	});
}

module.exports = { block, evaluate, harnessDisabled };
