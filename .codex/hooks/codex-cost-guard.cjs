#!/usr/bin/env node

const contracts = require("../../.agents/hooks/core/session-contract.js");
const usage = require("../../scripts/codex-lineage-usage.cjs");

function block(reason) {
	return { decision: "block", reason: `[CODEX COST GUARD] ${reason}` };
}

function evaluate({ sessionId = null, cwd = process.cwd(), contractLookup = null, sessionCollection = null, sessionChainCollection = null } = {}) {
	const lookup = contractLookup || ((value) => contracts.resolveSessionContract(value));
	let boundSessionId = sessionId;
	let resolved = lookup({ cwd, sessionId });
	let policy = resolved?.status === contracts.STATES.BOUND ? resolved.contract?.subagent_policy : null;
	if (resolved?.status === contracts.STATES.BOUND && !policy) return null;
	if (!policy) {
		const chain = (sessionChainCollection || ((value) => usage.collectSessionChain(value)))({ sessionId });
		const current = chain.sessions?.find((item) => item.sessionId === sessionId);
		if (!current) return chain.ambiguous ? block("session lineage is ambiguous") : null;
		if (!current.parentId && !current.isSubagent) return null;
		boundSessionId = usage.lineageRootId(chain, sessionId);
		if (!boundSessionId) return block("subagent lineage root is missing or ambiguous");
		resolved = lookup({ cwd, sessionId: boundSessionId });
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
		resolved = lookup({ cwd, sessionId: boundSessionId });
		if (resolved?.status !== contracts.STATES.BOUND) return block("subagent lineage root contract is not bound");
		const rootPolicy = resolved.contract?.subagent_policy;
		if (!rootPolicy || contracts.validateSubagentPolicy(rootPolicy) || rootPolicy.budget_started_at !== policy.budget_started_at) return block("subagent lineage root policy is missing or mismatched");
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
	});
	if (result) process.stdout.write(JSON.stringify(result));
}

if (require.main === module) main().catch(() => process.stdout.write(JSON.stringify(block("guard error; denied"))));

module.exports = { block, evaluate };
