#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const contracts = require("../../.agents/hooks/core/session-contract.js");
const guard = require("./subagent-spawn-guard.cjs");

const projectRoot = path.resolve(__dirname, "..", "..");
const policy = {
	profile: "balanced",
	context_mode: "isolated",
	budget_started_at: "2026-08-08T00:00:00Z",
	root_input_token_baseline: 0,
	root_output_token_baseline: 0,
	maximum_risk: "medium",
	max_children: 4,
	max_active_children: 2,
	max_prompt_bytes: 16_384,
	max_delegated_prompt_bytes: 65_536,
	max_input_tokens: 256_000,
	max_output_tokens: 32_000,
};
const lineage = { rootId: "s", members: ["s"], children: 0, activeChildren: 0, delegatedPromptBytes: 0, inputTokens: 0, outputTokens: 0, ambiguous: false };
const exactValidator = "node .codex/hooks/test-subagent-spawn-guard.cjs";
const parentContract = {
	id: "parent-contract",
	contract_digest: "a".repeat(64),
	goal: "Keep delegated work bounded to the declared parent intent.",
	scope: ["Inspect or change only the declared hook path."],
	non_goals: ["Do not replace or complete the parent contract."],
	success_criteria: ["The exact validator passes."],
	source_refs: ["USR-TEST:E01"],
	allowed_paths: [".codex/**"],
	target_ownership: [".codex/**"],
	allowed_shell_commands: [exactValidator],
	subagent_policy: policy,
};
function task(role, overrides = {}) {
	const value = {
		schema_version: "delegation-task-v1",
		task_id: `task-${role}`,
		task_digest: "",
		parent_contract_id: parentContract.id,
		parent_contract_digest: parentContract.contract_digest,
		parent_intent_digest: contracts.parentIntentDigest(parentContract),
		role,
		project_root: projectRoot,
		worktree: projectRoot,
		scope: ["Inspect or change only the declared hook path."],
		allowed_paths: [".codex/hooks/subagent-spawn-guard.cjs"],
		success_criteria: ["The exact validator passes."],
		stop_condition: "Stop after the declared success criterion or on any scope ambiguity.",
		risk: ["implementation", "test", "translation", "worker", "generic_worker", "generic-worker", "mechanical_implementation", "mechanical-implementation", "mechanical_test", "mechanical-test"].includes(role) ? "low" : "medium",
		exact_validator: ["implementation", "test", "worker", "generic_worker", "generic-worker", "mechanical_implementation", "mechanical-implementation", "mechanical_test", "mechanical-test", "translation"].includes(role) ? exactValidator : null,
		read_only: ["explorer", "analysis", "design", "review"].includes(role),
		result_contract: {
			schema_version: "delegation-result-v1",
			completion_scope: "child_task_only",
			drift_action: "handoff_to_parent",
			required_fields: [
				"status", "task_digest", "parent_intent_digest", "changed_paths", "validator_results",
				"remaining_parent_obligations_preserved", "completion_scope", "handoff_reason",
			],
		},
		...overrides,
	};
	value.task_digest = guard.taskDigest(value);
	return value;
}
const brief = (role, overrides = {}) => JSON.stringify(task(role, overrides));
const baseInput = {
	message: brief("review"),
	model: "gpt-5.6-sol",
	reasoning_effort: "medium",
	fork_context: false,
};
const base = {
	toolName: "multi_agent_v1__spawn_agent",
	toolInput: baseInput,
	sessionId: "s",
	cwd: projectRoot,
	env: { ADK_PROJECT_ROOT: projectRoot, CODEX_AVAILABLE_BINDINGS: "sol,luna" },
	contractLookup: () => ({ status: contracts.STATES.BOUND, contract: parentContract }),
	sessionCollection: () => ({ sessions: [{ sessionId: "s", parentId: null, createdAt: 0, inputTokens: 0, outputTokens: 0, rolloutFile: "root" }], ambiguous: false }),
	lineageReserve: () => ({ ok: true }),
};

assert.equal(guard.evaluate(base), null);
assert.equal(guard.evaluate({ ...base, toolInput: Object.fromEntries(Object.entries(baseInput).filter(([key]) => key !== "fork_context")) })?.decision, "block");
assert.equal(guard.evaluate({ ...base, toolInput: { ...baseInput, fork_turns: "all" } })?.decision, "block");
assert.equal(guard.evaluate({ ...base, toolInput: { ...baseInput, fork_turns: "none" } }), null);
assert.equal(guard.contextOk({ prompt: brief("review"), fork_turns: "none" }, "collaboration"), true);
assert.equal(guard.contextOk({ prompt: brief("review") }, "collaboration"), false);
assert.match(guard.evaluate({
	...base,
	toolName: "collaboration.spawn_agent",
	toolInput: { prompt: brief("review"), model: "gpt-5.6-sol", reasoning_effort: "medium", fork_turns: "none" },
})?.reason, /no registered result-envelope adapter/);
// The unbound verdict depends on the opt-in marker, so it must never read the
// real checkout's marker state — Windows caught this passing or failing based
// on whether .claude/allow-subagents happened to exist. Both directions are
// pinned against hermetic roots: no marker blocks, a marker admits one spawn.
{
	const fsh = require("node:fs");
	const osh = require("node:os");
	const bareRoot = fsh.mkdtempSync(path.join(osh.tmpdir(), "spawn-bare-"));
	const markedRoot = fsh.mkdtempSync(path.join(osh.tmpdir(), "spawn-marked-"));
	fsh.mkdirSync(path.join(markedRoot, ".claude"), { recursive: true });
	fsh.writeFileSync(path.join(markedRoot, ".claude", "allow-subagents"), JSON.stringify({ maxSpawns: 1 }));
	const uidh = `${process.pid}-${Date.now()}-h`;
	const unboundLookup = () => ({ status: contracts.STATES.UNBOUND });
	assert.equal(guard.evaluate({ ...base, cwd: bareRoot, env: {}, sessionId: `bare-${uidh}`, contractLookup: unboundLookup })?.decision, "block", "unbound without an opt-in marker stays blocked");
	assert.equal(guard.evaluate({ ...base, cwd: markedRoot, env: {}, sessionId: `marked-${uidh}`, contractLookup: unboundLookup }), null, "unbound with an opt-in marker admits a budgeted spawn");
	fsh.rmSync(bareRoot, { recursive: true, force: true });
	fsh.rmSync(markedRoot, { recursive: true, force: true });
}
assert.equal(guard.evaluate({ ...base, contractLookup: () => ({ status: contracts.STATES.BOUND, contract: {} }) })?.decision, "block");
for (const value of ["all", true, 3]) {
	assert.equal(guard.evaluate({ ...base, toolInput: { ...baseInput, fork_context: value } })?.decision, "block");
}
assert.equal(guard.evaluate({ ...base, toolInput: { ...baseInput, items: [{ type: "text", text: "x" }] } })?.decision, "block");

for (const [role, model, effort, accepted] of [
	["secretary", "gpt-5.6-luna", "max", true],
	["gateway", "gpt-5.6-luna", "max", true],
	["issue_leader", "gpt-5.6-luna", "max", true],
	["issue_manager", "gpt-5.6-luna", "max", true],
	["explorer", "gpt-5.6-luna", "low", true],
	["analysis", "gpt-5.6-sol", "medium", true],
	["design", "gpt-5.6-sol", "medium", true],
	["review", "gpt-5.6-sol", "medium", true],
	["implementation", "gpt-5.6-luna", "medium", true],
	["test", "gpt-5.6-luna", "low", true],
	["worker", "gpt-5.6-luna", "medium", true],
	["mechanical-implementation", "gpt-5.6-luna", "medium", true],
	["mechanical-test", "gpt-5.6-luna", "low", true],
	["generic_worker", "gpt-5.6-luna", "medium", true],
	["translation", "gpt-5.6-luna", "low", true],
	["translation", "gpt-5.6-luna", "medium", false],
	["secretary", "gpt-5.6-sol", "max", false],
	["gateway", "gpt-5.6-luna", "medium", false],
	["issue_manager", "gpt-5.6-sol", "max", false],
	["review", "gpt-5.6-luna", "medium", false],
]) {
	const toolInput = { ...baseInput, message: brief(role), model, reasoning_effort: effort };
	assert.equal(guard.evaluate({ ...base, toolInput }) === null, accepted, `${role}/${model}/${effort}`);
}

const invalidTasks = [
	"review this",
	JSON.stringify({}),
	brief("implementation", { exact_validator: null }),
	brief("implementation", { exact_validator: "node undeclared-validator.cjs" }),
	brief("review", { exact_validator: exactValidator }),
	brief("review", { read_only: false }),
	brief("explorer", { risk: "high" }),
	brief("review", { allowed_paths: ["packages/**"] }),
	brief("review", { parent_contract_digest: "b".repeat(64) }),
	brief("review", { scope: [] }),
	brief("review", { scope: ["Invent a broader task."] }),
	brief("review", { success_criteria: [] }),
	brief("review", { success_criteria: ["Claim success without parent authority."] }),
	brief("review", { stop_condition: "" }),
];
for (const message of invalidTasks) assert.equal(guard.evaluate({ ...base, toolInput: { ...baseInput, message } })?.decision, "block");

const lowRiskContract = { ...parentContract, subagent_policy: { ...policy, maximum_risk: "low" } };
assert.match(guard.evaluate({ ...base, contractLookup: () => ({ status: contracts.STATES.BOUND, contract: lowRiskContract }) })?.reason, /risk exceeds/);
assert.equal(guard.evaluate({
	...base,
	contractLookup: () => ({ status: contracts.STATES.BOUND, contract: lowRiskContract }),
	toolInput: { ...baseInput, message: brief("review", { risk: "low" }) },
}), null);
assert.equal(guard.evaluate({ ...base, env: { ADK_PROJECT_ROOT: projectRoot, CODEX_AVAILABLE_BINDINGS: "sol" } }), null);
assert.match(guard.evaluate({
	...base,
	env: { ADK_PROJECT_ROOT: projectRoot, CODEX_AVAILABLE_BINDINGS: "sol" },
	toolInput: { ...baseInput, message: brief("implementation"), model: "gpt-5.6-luna", reasoning_effort: "medium" },
})?.reason, /binding is unavailable/);
for (const declared of ["none", "[]", ""]) {
	assert.match(guard.evaluate({ ...base, env: { ADK_PROJECT_ROOT: projectRoot, CODEX_AVAILABLE_BINDINGS: declared } })?.reason, /binding is unavailable/);
}
assert.match(guard.evaluate({ ...base, env: { ADK_PROJECT_ROOT: projectRoot, CODEX_AVAILABLE_BINDINGS: "unknown" } })?.reason, /availability is invalid/);

const tampered = task("review");
tampered.scope = ["A different, unhashed task."];
assert.match(guard.evaluate({ ...base, toolInput: { ...baseInput, message: JSON.stringify(tampered) } })?.reason, /digest mismatch/);
assert.equal(guard.evaluate({ ...base, env: {} })?.decision, "block", "missing inherited root must fail closed");
assert.equal(guard.evaluate({ ...base, env: { ADK_PROJECT_ROOT: path.dirname(projectRoot) } })?.decision, "block", "mismatched inherited root must fail closed");
assert.match(
	guard.evaluate({ ...base, toolInput: { ...baseInput, message: brief("review", { stop_condition: "x".repeat(policy.max_prompt_bytes + 1) }) } })?.reason,
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
assert.equal(guard.evaluate({ ...base, toolName: "shell_command", toolInput: { command: "git status --short" } }), null);
for (const name of ["followup_task", "functions.collaboration.resume-agent", "mcp__codex__send_input", "mcp__codex__send_message", "functions.collaboration.send-message"]) {
	assert.equal(guard.evaluate({ ...base, toolName: name })?.decision, "block", name);
}
assert.equal(guard.evaluate({ ...base, toolName: "send_input", toolInput: { id: "agent-1", message: "continue" } })?.decision, "block");
assert.equal(guard.evaluate({ ...base, toolName: "send_message", toolInput: { channel_id: "discord-1", message: "hello" } }), null);
assert.equal(guard.evaluate({ ...base, toolName: "discord.send_message", toolInput: { channel_id: "discord-1", message: "hello" } }), null);
assert.equal(guard.evaluate({ ...base, toolName: "send_input", toolInput: { channel_id: "connector-1", message: "hello" } }), null);
for (const [name, toolInput] of [
	["mcp__provider__delegate_agent", { prompt: "work", model: "gpt-5.6-luna" }],
	["mcp__provider__launch_worker", { prompt: "work", model: "gpt-5.6-luna", reasoning_effort: "medium" }],
	["mcp__provider__opaque", { message: "work", model: "gpt-5.6-luna", fork_context: false }],
]) {
	assert.match(guard.evaluate({ ...base, toolName: name, toolInput })?.reason, /unrecognized delegation-capable wrapper/, name);
}
assert.equal(guard.evaluate({ ...base, toolName: "mcp__provider__read_issue", toolInput: { issue: 1 } }), null);
assert.equal(guard.isSpawn("multi_agent_v1__spawn_agent"), true);
assert.equal(guard.isSpawn("collaboration.spawn_agent"), true);
assert.equal(guard.isSpawn("spawn_agent"), true);
assert.equal(guard.isSpawn("mcp__codex__spawn-agent"), false);
assert.equal(guard.isSpawn("functions.collaboration.spawn_agent"), false);
assert.equal(guard.isSpawn("other.spawn_agent"), false);
assert.equal(guard.isSpawn("unrelated_tool"), false);
assert.equal(guard.isWait("multi_agent_v1__wait_agent"), true);
assert.equal(guard.isWait("other.wait_agent"), false);
assert.equal(guard.isFollowup("mcp__codex__send_message"), true);
assert.equal(guard.isFollowup("discord.send_message"), false);
assert.equal(guard.isFollowup("send_message"), false);
assert.equal(guard.isFollowup("send_input", { id: "agent-1", message: "continue" }), true);
assert.equal(guard.patternCovers(".codex/**", ".codex/hooks/file.cjs"), true);
assert.equal(guard.patternCovers(".codex/hooks/file.cjs", ".codex/hooks/file.cjs"), true);
assert.equal(guard.patternCovers(".codex/hooks/file.cjs", ".codex/hooks/other.cjs"), false);

const resultTask = task("review");
const validResult = {
	status: "completed",
	task_digest: resultTask.task_digest,
	parent_intent_digest: resultTask.parent_intent_digest,
	changed_paths: [],
	validator_results: [],
	remaining_parent_obligations_preserved: true,
	completion_scope: "child_task_only",
	handoff_reason: null,
};
const resultBase = {
	toolName: "multi_agent_v1__wait_agent",
	toolInput: { targets: ["child"] },
	toolResponse: { status: { child: { completed: JSON.stringify(validResult) } }, timed_out: false },
	sessionId: "s",
	cwd: projectRoot,
	env: { ADK_PROJECT_ROOT: projectRoot },
	contractLookup: () => ({ status: contracts.STATES.BOUND, contract: parentContract }),
	sessionChainLookup: () => ({ ambiguous: false, sessions: [
		{ sessionId: "child", parentId: "s", isSubagent: true, delegatedPrompt: JSON.stringify(resultTask) },
		{ sessionId: "s", parentId: null, isSubagent: false },
	] }),
};
assert.equal(guard.evaluateResult(resultBase), null);
assert.match(guard.evaluateResult({
	...resultBase,
	toolName: "collaboration.wait_agent",
	toolInput: { ids: ["child"] },
	toolResponse: { messages: [] },
})?.reason, /no registered result-envelope adapter/);
assert.equal(guard.evaluateResult({ ...resultBase, toolResponse: { timed_out: true, status: {} } }), null);
assert.match(guard.evaluateResult({
	...resultBase,
	toolResponse: { status: { child: { completed: JSON.stringify({ ...validResult, completion_scope: "parent_contract" }) } }, timed_out: false },
})?.reason, /parent_obligations_not_preserved/);
assert.match(guard.evaluateResult({
	...resultBase,
	toolResponse: { status: { child: { completed: `\`\`\`json\n${JSON.stringify(validResult)}\n\`\`\`` } }, timed_out: false },
})?.reason, /result is invalid/);
assert.match(guard.evaluateResult({
	...resultBase,
	sessionChainLookup: () => ({ ambiguous: false, sessions: [
		{ sessionId: "child", parentId: "other", isSubagent: true, delegatedPrompt: JSON.stringify(resultTask) },
		{ sessionId: "other", parentId: null, isSubagent: false },
	] }),
})?.reason, /not a direct child/);

const malformedAdapter = spawnSync(process.execPath, [path.join(__dirname, "subagent-spawn-guard.cjs")], {
	input: "{broken",
	encoding: "utf8",
});
assert.equal(malformedAdapter.status, 0, malformedAdapter.stderr);
assert.equal(JSON.parse(malformedAdapter.stdout).decision, "block");

// A spawn tool must get the same answer from either guard. Each one used to
// know only its own host's names and waved the other's through, so the
// effective fan-out cap depended on which host was running — Codex let Claude's
// Task past, Claude let multi_agent_v1 past.
{
	const repoRoot = path.resolve(__dirname, "..", "..");
	// Symmetry is asserted for the default-deny state, so the working root must
	// be hermetic — an opt-in marker in the real checkout flipped one guard and
	// not the other depending on leftover budget counters.
	const fss = require("node:fs");
	const oss = require("node:os");
	const symRoot = fss.mkdtempSync(path.join(oss.tmpdir(), "spawn-sym-"));
	const guards = {
		claude: path.join(repoRoot, ".claude", "hooks", "subagent-spawn-guard.js"),
		codex: path.join(repoRoot, ".codex", "hooks", "subagent-spawn-guard.cjs"),
	};
	const env = { ...process.env, ADK_PROJECT_ROOT: "", AI_HARNESS: "", CLAUDE_HARNESS: "", CODEX_HARNESS: "" };
	for (const [toolName, toolInput] of [
		["Task", { prompt: "w" }],
		["Agent", { prompt: "w" }],
		["functions.multi_agent_v1", { message: "t" }],
		["collaborationspawn_agent", { prompt: "w" }],
		["Read", { file_path: "a" }],
	]) {
		const verdicts = Object.entries(guards).map(([host, guardPath]) => {
			const run = spawnSync(process.execPath, [guardPath], {
				input: JSON.stringify({ session_id: "parent", cwd: symRoot, hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput }),
				encoding: "utf8", cwd: symRoot, env,
			});
			assert.equal(run.status, 0, `${host} ${toolName}: ${run.stderr}`);
			return [host, (run.stdout || "").trim() ? "block" : "allow"];
		});
		assert.equal(verdicts[0][1], verdicts[1][1], `${toolName}: ${verdicts.map(([h, v]) => `${h}=${v}`).join(" ")}`);
	}
	fss.rmSync(symRoot, { recursive: true, force: true });
}

// The Windows Codex host passes the flattened name collaborationspawn_agent.
// While unbound it must reach the opt-in budget path, not "unrecognized
// wrapper", and the context-inheritance invariant must still gate it first.
{
	const fsx = require("node:fs");
	const osx = require("node:os");
	const optRoot = fsx.mkdtempSync(path.join(osx.tmpdir(), "spawn-optin-"));
	fsx.mkdirSync(path.join(optRoot, ".claude"), { recursive: true });
	fsx.writeFileSync(path.join(optRoot, ".claude", "allow-subagents"), JSON.stringify({ maxSpawns: 1 }));
	const unbound = { contractLookup: () => ({ status: contracts.STATES.UNBOUND }), cwd: optRoot, env: {} };
	// The budget counter persists in os.tmpdir across runs; unique ids keep this hermetic.
	const uid = `${process.pid}-${Date.now()}`;
	assert.match(
		guard.evaluate({ ...base, ...unbound, sessionId: `flat-a-${uid}`, toolName: "collaborationspawn_agent", toolInput: { prompt: "w" } })?.reason || "",
		/fork_context/, "flattened collaboration spawn without explicit context flags stays blocked by the context invariant");
	assert.equal(
		guard.evaluate({ ...base, ...unbound, sessionId: `flat-b-${uid}`, toolName: "collaborationspawn_agent", toolInput: { prompt: "w", fork_context: false, fork_turns: "none" } }),
		null, "flattened collaboration spawn reaches the unbound opt-in budget path");
	assert.match(
		guard.evaluate({ ...base, ...unbound, sessionId: `flat-b-${uid}`, toolName: "collaborationspawn_agent", toolInput: { prompt: "w", fork_context: false, fork_turns: "none" } })?.reason || "",
		/1개를 생성/, "the second flattened spawn is stopped by the budget");
	fsx.rmSync(optRoot, { recursive: true, force: true });
}

console.log("subagent-spawn-guard: all tests passed");
