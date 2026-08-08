#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const contracts = require("../../.agents/hooks/core/session-contract.js");
const guard = require("./subagent-spawn-guard.cjs");

const policy = {
	profile: "balanced",
	context_mode: "isolated",
	budget_started_at: "2026-08-09T00:00:00Z",
	root_input_token_baseline: 0,
	root_output_token_baseline: 0,
	max_children: 4,
	max_active_children: 2,
	max_prompt_bytes: 16_384,
	max_delegated_prompt_bytes: 65_536,
	max_input_tokens: 256_000,
	max_output_tokens: 32_000,
};
const lineage = { rootId: "s", members: ["s"], children: 0, activeChildren: 0, delegatedPromptBytes: 0, inputTokens: 0, outputTokens: 0, ambiguous: false };
const baseInput = {
	message: "[balanced-role:review]\nReview the bounded snapshot.",
	model: "gpt-5.6-sol",
	reasoning_effort: "medium",
	fork_turns: "none",
};
const base = {
	toolName: "spawn_agent",
	toolInput: baseInput,
	sessionId: "s",
	contractLookup: () => ({ status: contracts.STATES.BOUND, contract: { subagent_policy: policy } }),
	sessionCollection: () => ({ sessions: [{ sessionId: "s", parentId: null, createdAt: 0, inputTokens: 0, outputTokens: 0, rolloutFile: "root" }], ambiguous: false }),
	lineageReserve: () => ({ ok: true }),
};

assert.equal(guard.evaluate(base), null);
assert.equal(guard.evaluate({ ...base, toolInput: { ...baseInput, fork_context: false } }), null);
assert.equal(guard.evaluate({ ...base, toolInput: { ...baseInput, fork_turns: "all" } })?.decision, "block");
assert.equal(guard.evaluate({ ...base, contractLookup: () => ({ status: contracts.STATES.UNBOUND }) })?.decision, "block");
assert.equal(guard.evaluate({ ...base, contractLookup: () => ({ status: contracts.STATES.BOUND, contract: {} }) })?.decision, "block");
for (const value of ["all", true, 3, undefined]) {
	assert.equal(guard.evaluate({ ...base, toolInput: { ...baseInput, fork_context: value } })?.decision, "block");
}
assert.equal(guard.evaluate({ ...base, toolInput: { ...baseInput, fork_turns: undefined } })?.decision, "block");
assert.equal(guard.evaluate({ ...base, toolInput: { ...baseInput, items: [{ type: "text", text: "x" }] } })?.decision, "block");

for (const [role, model, effort, accepted] of [
	["secretary", "gpt-5.6-luna", "max", true],
	["issue_leader", "gpt-5.6-luna", "max", true],
	["analysis", "gpt-5.6-sol", "medium", true],
	["design", "gpt-5.6-sol", "medium", true],
	["review", "gpt-5.6-sol", "medium", true],
	["implementation", "gpt-5.6-luna", "medium", true],
	["test", "gpt-5.6-luna", "medium", true],
	["worker", "gpt-5.6-luna", "medium", true],
	["translation", "gpt-5.6-luna", "low", true],
	["translation", "gpt-5.6-luna", "medium", false],
	["secretary", "gpt-5.6-sol", "max", false],
	["review", "gpt-5.6-luna", "medium", false],
]) {
	const toolInput = { ...baseInput, message: `[balanced-role:${role}]\nBounded task.`, model, reasoning_effort: effort };
	assert.equal(guard.evaluate({ ...base, toolInput }) === null, accepted);
}
assert.equal(guard.evaluate({ ...base, toolInput: { ...baseInput, message: "review this" } })?.decision, "block");
assert.match(
	guard.evaluate({ ...base, toolInput: { ...baseInput, message: `[balanced-role:review]\n${"x".repeat(policy.max_prompt_bytes + 1)}` } })?.reason,
	/prompt byte ceiling exceeded/,
);
assert.equal(guard.evaluate({ ...base, sessionId: "child", sessionCollection: () => ({ sessions: [
	{ sessionId: "s", parentId: null, createdAt: 0, inputTokens: 0, outputTokens: 0, rolloutFile: "root" },
	{ sessionId: "child", parentId: "s", createdAt: Date.parse(policy.budget_started_at), inputTokens: 1, outputTokens: 1, delegatedPromptBytes: 1, finished: false, rolloutFile: "child" },
], ambiguous: false }) })?.decision, "block");
for (const [key, value] of [["children", 4], ["activeChildren", 2], ["delegatedPromptBytes", 65_536], ["inputTokens", 256_000], ["outputTokens", 32_000]]) {
	assert.equal(guard.evaluate({ ...base, sessionCollection: () => ({ sessions: [], ambiguous: true }), lineageReserve: () => ({ ok: true }) })?.decision, "block");
	assert.equal(require("../../scripts/codex-lineage-usage.cjs").evaluateLineage({ ...lineage, [key]: value }, { policy, spawningSessionId: "s", pendingPromptBytes: 1 }).ok, false);
}
assert.equal(guard.evaluate({ ...base, lineageReserve: () => ({ ok: false }) })?.decision, "block");
assert.equal(guard.evaluate({ ...base, toolName: "shell_command" }), null);
assert.equal(guard.isSpawn("mcp__codex__spawn-agent"), true);
assert.equal(guard.isSpawn("collaboration.spawn_agent"), true);
assert.equal(guard.isSpawn("functions.collaboration.spawn_agent"), true);
assert.equal(guard.isSpawn("unrelated_tool"), false);

const malformedAdapter = spawnSync(process.execPath, [path.join(__dirname, "subagent-spawn-guard.cjs")], {
	input: "{broken",
	encoding: "utf8",
});
assert.equal(malformedAdapter.status, 0, malformedAdapter.stderr);
assert.equal(JSON.parse(malformedAdapter.stdout).decision, "block");

console.log("subagent-spawn-guard: all tests passed");
