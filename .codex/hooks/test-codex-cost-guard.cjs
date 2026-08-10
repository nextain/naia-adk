#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const contracts = require("../../.agents/hooks/core/session-contract.js");
const guard = require("./codex-cost-guard.cjs");

const policy = {
	profile: "balanced", context_mode: "isolated", budget_started_at: "2026-08-08T00:00:00Z",
	root_input_token_baseline: 10, root_output_token_baseline: 2,
	maximum_risk: "medium",
	max_children: 4, max_active_children: 2, max_prompt_bytes: 16_384,
	max_delegated_prompt_bytes: 65_536, max_input_tokens: 256_000, max_output_tokens: 32_000,
};
const bound = () => ({ status: contracts.STATES.BOUND, contract: { subagent_policy: policy } });
const sessions = (inputTokens = 1, outputTokens = 1, ambiguous = false) => ({ ambiguous, sessions: [
	{ sessionId: "root", parentId: null, createdAt: 0, inputTokens: 999_999, outputTokens: 99_999, rolloutFile: "root" },
	{ sessionId: "child", parentId: "root", createdAt: Date.parse(policy.budget_started_at), inputTokens, outputTokens, delegatedPromptBytes: 20, finished: false, rolloutFile: "child" },
] });

assert.equal(guard.evaluate({ sessionId: "root", contractLookup: bound, sessionCollection: () => sessions() }), null);
assert.equal(guard.evaluate({ sessionId: "child", contractLookup: bound, sessionCollection: () => sessions() }), null);
assert.equal(guard.evaluate({ sessionId: "child", contractLookup: bound, sessionCollection: () => sessions(policy.max_input_tokens) })?.decision, "block");
assert.equal(guard.evaluate({ sessionId: "child", contractLookup: bound, sessionCollection: () => sessions(1, policy.max_output_tokens) })?.decision, "block");
assert.equal(guard.evaluate({ sessionId: "child", contractLookup: bound, sessionCollection: () => sessions(1, 1, true) })?.decision, "block");
const rootLookup = ({ sessionId }) => sessionId === "root" ? bound() : ({ status: contracts.STATES.UNBOUND });
const chain = () => ({ ambiguous: false, sessions: [
	{ sessionId: "child", parentId: "root", isSubagent: true },
	{ sessionId: "root", parentId: null, isSubagent: false },
] });
assert.equal(guard.evaluate({ sessionId: "child", contractLookup: rootLookup, sessionChainCollection: chain, sessionCollection: () => sessions() }), null);
assert.equal(guard.evaluate({ sessionId: "child", contractLookup: rootLookup, sessionChainCollection: chain, sessionCollection: () => sessions(policy.max_input_tokens) })?.decision, "block");
const childContractWithoutPolicy = ({ sessionId }) => sessionId === "root" ? bound() : ({ status: contracts.STATES.BOUND, contract: {} });
assert.equal(guard.evaluate({ sessionId: "child", contractLookup: childContractWithoutPolicy, sessionChainCollection: chain, sessionCollection: () => sessions() }), null, "a child contract without policy must inherit the governed root policy");
const mismatchedChildPolicy = ({ sessionId }) => sessionId === "root" ? bound() : ({ status: contracts.STATES.BOUND, contract: { subagent_policy: { ...policy, max_children: 3 } } });
assert.match(guard.evaluate({ sessionId: "child", contractLookup: mismatchedChildPolicy, sessionCollection: () => sessions() })?.reason || "", /mismatched/, "a child policy must not silently replace its root policy");
assert.equal(guard.evaluate({
	sessionId: "child",
	contractLookup: rootLookup,
	sessionChainCollection: () => ({ ambiguous: false, sessions: [{ sessionId: "child", parentId: "missing", isSubagent: true }] }),
})?.decision, "block");
assert.equal(guard.evaluate({ sessionId: "none", contractLookup: () => ({ status: contracts.STATES.UNBOUND }), sessionChainCollection: () => ({ sessions: [], ambiguous: false }) })?.decision, "block", "an unindexed hook session must fail closed");
const indexedRootChain = () => ({ sessions: [{ sessionId: "root", parentId: null, isSubagent: false }], ambiguous: false });
assert.equal(guard.evaluate({ sessionId: "root", contractLookup: () => ({ status: contracts.STATES.BOUND, contract: {} }), sessionChainCollection: indexedRootChain }), null);
assert.equal(guard.evaluate({ sessionId: "root", contractLookup: () => ({ status: contracts.STATES.UNBOUND }), sessionChainCollection: indexedRootChain }), null, "an indexed ordinary root remains outside descendant budgeting");

const repositoryRoot = contracts.findProjectRoot(__dirname);
assert.equal(guard.evaluate({
	sessionId: "unindexed-recovery-session",
	cwd: repositoryRoot,
}), null, "a repository no-harness marker must bypass cost enforcement");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cost-guard-scratch-"));
try {
	let lookupCwd = null;
	assert.equal(guard.evaluate({
		sessionId: "root",
		cwd: scratch,
		env: { ADK_PROJECT_ROOT: repositoryRoot },
		contractLookup: ({ cwd }) => {
			lookupCwd = cwd;
			return { status: contracts.STATES.BOUND, contract: {} };
		},
		sessionChainCollection: indexedRootChain,
	}), null);
	assert.equal(lookupCwd, fs.realpathSync(repositoryRoot), "contract lookup must use the inherited project root");
	assert.throws(
		() => guard.evaluate({ sessionId: "root", cwd: scratch, env: { ADK_PROJECT_ROOT: "." } }),
		/ADK_PROJECT_ROOT must be absolute/,
	);
} finally {
	fs.rmSync(scratch, { recursive: true, force: true });
}

const malformedAdapter = spawnSync(process.execPath, [path.join(__dirname, "codex-cost-guard.cjs")], {
	input: "{broken",
	encoding: "utf8",
});
assert.equal(malformedAdapter.status, 0, malformedAdapter.stderr);
assert.equal(JSON.parse(malformedAdapter.stdout).decision, "block");

console.log("codex-cost-guard: all tests passed");
