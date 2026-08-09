const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const gate = require("./session-contract-gate.cjs");
const contractCore = require("../../.agents/hooks/core/session-contract.js");

const repositoryRoot = contractCore.findProjectRoot(__dirname);
// Alpha's current cutover scope is Codex-only. Claude registration is validated
// in naia-adk and must not be inferred from this fork's disabled Claude profile.
assert.equal(typeof gate.main, "function", "host adapters must invoke the exported gate entrypoint");
const codexSettings = JSON.parse(fs.readFileSync(path.join(repositoryRoot, ".codex/hooks.json"), "utf8"));
const codexPreToolCommands = codexSettings.hooks.PreToolUse.flatMap((group) =>
	(group.hooks || []).map((hook) => hook.command),
);
assert.ok(
	codexPreToolCommands.some((command) => command.includes("session-contract-gate.cjs")),
	"Codex must register the same lightweight session gate before mutations",
);
const codexSessionGateGroup = codexSettings.hooks.PreToolUse.find((group) =>
	/exec_command/.test(group.matcher || "") && (group.hooks || []).some((hook) => hook.command.includes("session-contract-gate.cjs")),
);
assert.match(codexSessionGateGroup?.matcher || "", /exec_command/);
assert.match(codexSessionGateGroup?.matcher || "", /shell_command/);

for (const command of [
	"git branch new-name",
	"git branch -f main HEAD~1",
	"git branch --delete topic",
	"git checkout -b topic",
	"git diff --output=changed.patch",
	"git show HEAD:README.md -o copy.md",
	"rg --pre 'sh -c touch /tmp/escaped' needle file",
]) assert.equal(gate.readOnlyShell(command), false, command);

for (const command of [
	"git status --short",
	"git diff --stat",
	"git log -1",
	"git show HEAD:README.md",
	"git rev-parse --show-toplevel",
	"git branch --show-current",
	"Get-Content AGENTS.md",
]) assert.equal(gate.readOnlyShell(command), true, command);

function writeJson(filePath, value) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function runGate(cwd, toolName, toolInput, extraEnv = {}, resolvedRoot = cwd) {
	return gate.decide(
		{ cwd, session_id: "SESSION-1", tool_name: toolName, tool_input: toolInput },
		{ ...process.env, ADK_PROJECT_ROOT: "", AI_HARNESS: "", CLAUDE_HARNESS: "", CODEX_HARNESS: "", ...extraEnv },
		{ resolveHookProjectRoot: () => resolvedRoot },
	);
}

function fullJsonPatch(action, filePath, before, after) {
	const oldLines = before == null ? [] : JSON.stringify(before, null, 2).split("\n").map((line) => `-${line}`);
	const newLines = JSON.stringify(after, null, 2).split("\n").map((line) => `+${line}`);
	const body = action === "Add" ? newLines : ["@@", ...oldLines, ...newLines];
	return ["*** Begin Patch", `*** ${action} File: ${filePath}`, ...body, "*** End Patch", ""].join("\n");
}

function bind(root) {
	const contract = {
		schema_version: "1.0",
		id: "gate-contract",
		status: "active",
		project_root: ".",
		goal: "test explicit binding",
		scope: ["product.txt"],
		non_goals: [],
		success_criteria: ["gate parity"],
		allowed_paths: ["product.txt"],
		target_ownership: ["product.txt"],
		allowed_shell_commands: ["pnpm test", "node .claude/hooks/sync-entry-points.js --apply candidate.md", "codex exec -m gpt-5.6-luna task", "bash -c 'opencode run task'", "rg --pre 'sh -c touch /tmp/escaped' needle file"],
		audiences: ["developer"],
		source_refs: ["USR-TEST:E01"],
		session_bindings: [{ session_id: "SESSION-1" }],
		progress_file: ".agents/progress/gate.json",
	};
	const digest = contractCore.contractDigest(contract);
	contract.contract_digest = digest;
	contract.session_bindings[0].contract_digest = digest;
	writeJson(path.join(root, ".agents", "session-contracts", "gate-contract.json"), contract);
	writeJson(path.join(root, ".agents", "progress", "gate.json"), {
		contract_id: contract.id,
		contract_digest: digest,
		current_phase: "build",
	});
	writeJson(path.join(root, ".agents", "session-contracts", ".session-map.json"), {
		schema_version: "1.0",
		bindings: {
			"SESSION-1": {
				contract_id: contract.id,
				contract_path: ".agents/session-contracts/gate-contract.json",
				contract_digest: digest,
			},
		},
	});
}

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "session-contract-gate-"));
try {
	writeJson(path.join(fixture, ".agents", "context", "agents-rules.json"), {});
	writeJson(path.join(fixture, ".codex", "hooks.json"), {});
	fs.mkdirSync(path.join(fixture, ".agents", "progress"), { recursive: true });
	fs.writeFileSync(path.join(fixture, ".agents", "progress", "legacy.md"), "---\nsession_id: SESSION-1\n---\n");
	const bootstrapContract = {
		schema_version: "1.0",
		id: "bootstrap-contract",
		status: "active",
		project_root: ".",
		goal: "bootstrap current session only",
		scope: ["bootstrap.txt"],
		non_goals: [],
		success_criteria: ["explicit binding"],
		allowed_paths: ["bootstrap.txt"],
		target_ownership: ["bootstrap.txt"],
		audiences: ["developer"],
		source_refs: ["USR-TEST:E01"],
		session_bindings: [{ session_id: "SESSION-1" }],
		progress_file: ".agents/progress/bootstrap.json",
		contract_digest: "",
	};
	bootstrapContract.contract_digest = contractCore.contractDigest(bootstrapContract);
	bootstrapContract.session_bindings[0].contract_digest = bootstrapContract.contract_digest;
	writeJson(path.join(fixture, ".agents", "session-contracts", "bootstrap-contract.json"), bootstrapContract);
	writeJson(path.join(fixture, ".agents", "progress", "bootstrap.json"), {
		contract_id: bootstrapContract.id,
		contract_digest: bootstrapContract.contract_digest,
	});
	const bootstrapPointer = {
		contract_id: bootstrapContract.id,
		contract_path: ".agents/session-contracts/bootstrap-contract.json",
		contract_digest: bootstrapContract.contract_digest,
	};
	const existingRegistry = { schema_version: "1.0", bindings: { OTHER: bootstrapPointer } };
	writeJson(path.join(fixture, ".agents", "session-contracts", ".session-map.json"), existingRegistry);
	const nextRegistry = {
		schema_version: "1.0",
		bindings: { ...existingRegistry.bindings, "SESSION-1": bootstrapPointer },
	};

	for (const client of ["claude", "codex"]) {
		assert.equal(runGate(fixture, "Bash", { command: "git status --short" }), null, `${client} read-only`);
		assert.equal(runGate(fixture, "apply_patch", { command: "product mutation" })?.decision, "block", `${client} legacy shell blocked`);
		assert.equal(
			runGate(fixture, "apply_patch", { command: "*** Begin Patch\n*** Update File: AGENTS.md\n@@\n-old\n+new\n*** End Patch\n" })?.decision,
			"block",
			`${client} direct entrypoint patch blocked`,
		);
		assert.equal(
			runGate(fixture, "Bash", { command: "cp candidate.md AGENTS.md" })?.decision,
			"block",
			`${client} shell entrypoint bypass blocked`,
		);
		assert.equal(
			runGate(fixture, "Bash", { command: "node evil-sync-entry-points.js --apply candidate.md && cp candidate.md AGENTS.md" })?.decision,
			"block",
			`${client} lookalike or chained helper bypass blocked`,
		);
		assert.equal(
			runGate(fixture, "Write", { file_path: ".agents/session-contracts/bootstrap-contract.json", content: JSON.stringify(bootstrapContract) }),
			null,
			`${client} bootstrap`,
		);
		assert.equal(
			runGate(fixture, "apply_patch", {
				patch: fullJsonPatch("Update", ".agents/session-contracts/.session-map.json", existingRegistry, nextRegistry),
			}),
			null,
			`${client} apply_patch registry bootstrap`,
		);
		assert.equal(
			runGate(fixture, "apply_patch", {
				patch: fullJsonPatch("Add", ".agents/session-contracts/invalid.json", null, { nope: true }),
			})?.decision,
			"block",
			`${client} invalid apply_patch bootstrap blocked`,
		);
		assert.equal(
			runGate(fixture, "apply_patch", {
				patch: "*** Begin Patch\n*** Add File: product.txt\n+changed\n*** End Patch\n",
			})?.decision,
			"block",
			`${client} apply_patch product mutation remains blocked`,
		);
		assert.equal(
			runGate(fixture, "Write", {
				file_path: ".agents/session-contracts/.session-map.json",
				content: JSON.stringify({ schema_version: "1.0", bindings: { "SESSION-1": bootstrapPointer, OTHER: bootstrapPointer, EXTRA: bootstrapPointer } }),
			})?.decision,
			"block",
			`${client} initial registry cannot claim another session`,
		);
	}
	fs.unlinkSync(path.join(fixture, ".agents", "session-contracts", "bootstrap-contract.json"));
	fs.unlinkSync(path.join(fixture, ".agents", "progress", "bootstrap.json"));

	bind(fixture);
	const readOnlyResolution = {
		status: contractCore.STATES.BOUND,
		contract: {
			allowed_paths: ["product.txt"], target_ownership: ["product.txt"], allowed_shell_commands: [],
		},
		progress: {},
		derivedTask: { read_only: true },
	};
	const readOnlyDependencies = {
		resolveHookProjectRoot: () => fixture,
		resolveSessionContract: () => readOnlyResolution,
	};
	assert.match(gate.decide(
		{ cwd: fixture, session_id: "CHILD", tool_name: "Write", tool_input: { file_path: "product.txt", content: "no" } },
		{ ...process.env, ADK_PROJECT_ROOT: "" }, readOnlyDependencies,
	)?.reason, /read_only/);
	assert.match(gate.decide(
		{ cwd: fixture, session_id: "CHILD", tool_name: "Write", tool_input: { file_path: ".agents/session-contracts/child.json", content: "{}" } },
		{ ...process.env, ADK_PROJECT_ROOT: "" }, {
			...readOnlyDependencies,
			resolveSessionContract: () => ({ ...readOnlyResolution, reason: "derived_delegation_verified" }),
		},
	)?.reason, /read_only/, "a derived worker must not bootstrap over its parent-owned authority");
	assert.match(gate.decide(
		{ cwd: fixture, session_id: "CHILD", tool_name: "Bash", tool_input: { command: "pnpm test" } },
		{ ...process.env, ADK_PROJECT_ROOT: "" }, readOnlyDependencies,
	)?.reason, /read_only/);
	assert.equal(gate.decide(
		{ cwd: fixture, session_id: "CHILD", tool_name: "Bash", tool_input: { command: "git status --short" } },
		{ ...process.env, ADK_PROJECT_ROOT: "" }, readOnlyDependencies,
	), null);
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "session-contract-gate-scratch-"));
	try {
		assert.equal(
			runGate(scratch, "Bash", { command: "pnpm test" }, {}, fixture),
			null,
			"resolved root must resolve the bound contract from scratch cwd",
		);
		assert.equal(
			runGate(scratch, "Write", { file_path: "product.txt", content: "ok" }, {}, fixture),
			null,
			"relative mutation targets must resolve against the verified project root",
		);
		assert.equal(
			contractCore.resolveHookProjectRoot(scratch, { ADK_PROJECT_ROOT: repositoryRoot }),
			fs.realpathSync(repositoryRoot),
			"installed root identity may be inherited from scratch cwd",
		);
		assert.throws(
			() => contractCore.resolveHookProjectRoot(scratch, { ADK_PROJECT_ROOT: "." }),
			(error) => error.code === "inherited_project_root_invalid",
			"relative inherited roots must fail closed",
		);
		assert.throws(
			() => contractCore.resolveHookProjectRoot(scratch, { ADK_PROJECT_ROOT: path.join(scratch, "missing") }),
			(error) => error.code === "inherited_project_root_invalid",
			"missing inherited roots must fail closed",
		);
		assert.throws(
			() => contractCore.resolveHookProjectRoot(scratch, { ADK_PROJECT_ROOT: fixture }),
			(error) => error.code === "inherited_project_root_mismatch",
			"marker-compatible impostor roots must not replace the installed harness",
		);
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
	for (const client of ["claude", "codex"]) {
		const progressContent = fs.readFileSync(path.join(fixture, ".agents", "progress", "gate.json"), "utf8");
		assert.equal(
			runGate(fixture, "Write", { file_path: ".agents/progress/gate.json", content: progressContent }),
			null,
			`${client} bound progress evidence write`,
		);
		assert.equal(
			runGate(fixture, "apply_patch", { command: "*** Begin Patch\n*** Update File: product.txt\n@@\n-old\n+new\n*** End Patch\n" }),
			null,
			`${client} bound owned path`,
		);
		assert.equal(runGate(fixture, "apply_patch", { command: "product mutation" })?.decision, "block", `${client} unresolved target blocked`);
		assert.equal(runGate(fixture, "Bash", { command: "pnpm test" }), null, `${client} declared shell command`);
		for (const command of [
			"claude --version", "npx @anthropic-ai/claude-code --help", "npx @google/gemini-cli",
			"npx @openai/codex-cli", "opencode-ai run", "name=codex; $name", "echo $(claude)",
			"echo `gemini`", "printf '\\141'", "eval 'claude'", "echo codex | xargs -I{} {}",
			"sh -c 'claude'", "bash -c 'codex'", "zsh -c 'gemini'",
			"node -e \"require('child_process').spawn('claude')\"",
		]) assert.equal(runGate(fixture, "exec_command", { command })?.decision, "block", `${client} unsafe launch blocked: ${command}`);
		assert.match(runGate(fixture, "Bash", { command: "codex exec -m gpt-5.6-luna task" })?.reason, /중첩 실행/, `${client} declared Codex shell launch remains blocked`);
		assert.match(runGate(fixture, "Bash", { command: "bash -c 'opencode run task'" })?.reason, /중첩 실행/, `${client} wrapped OpenCode shell launch remains blocked`);
		for (const command of ["c''odex exec task", 'co"de"x exec task', "c\\odex exec task"]) {
			assert.match(runGate(fixture, "Bash", { command })?.reason, /중첩 실행/, `${client} shell-spliced model runtime remains blocked: ${command}`);
		}
		assert.equal(runGate(fixture, "Bash", { command: "rg --pre 'codex exec task' needle file" })?.decision, "block", `${client} rg preprocessor model runtime remains blocked`);
		assert.match(runGate(fixture, "Bash", { command: "rg --pre 'sh -c touch /tmp/escaped' needle file" })?.reason, /전처리기/, `${client} allowlisted rg preprocessor mutation remains blocked`);
		assert.equal(runGate(fixture, "Bash", { command: "echo changed > product.txt" })?.decision, "block", `${client} undeclared mutating shell blocked`);
		assert.equal(
			runGate(fixture, "Write", { file_path: "other.txt", content: "no" })?.decision,
			"block",
			`${client} out-of-contract path blocked`,
		);
		assert.equal(
			runGate(fixture, "Bash", { command: "node .claude/hooks/sync-entry-points.js --apply candidate.md" }),
			null,
			`${client} dedicated entrypoint helper allowed`,
		);
		const registryPath = path.join(fixture, ".agents", "session-contracts", ".session-map.json");
		const tamperedRegistry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
		tamperedRegistry.bindings.OTHER = tamperedRegistry.bindings["SESSION-1"];
		assert.equal(
			runGate(fixture, "Write", { file_path: ".agents/session-contracts/.session-map.json", content: JSON.stringify(tamperedRegistry) })?.decision,
			"block",
			`${client} cannot add or alter another session registry entry`,
		);
	}

	const governedContractPath = path.join(fixture, ".agents", "session-contracts", "gate-contract.json");
	const governedProgressPath = path.join(fixture, ".agents", "progress", "gate.json");
	const governedRegistryPath = path.join(fixture, ".agents", "session-contracts", ".session-map.json");
	const governedContract = JSON.parse(fs.readFileSync(governedContractPath, "utf8"));
	governedContract.allowed_paths = ["product.txt", "secondary.txt"];
	governedContract.target_ownership = ["product.txt", "secondary.txt"];
	governedContract.subagent_policy = {
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
		orchestrator_execution: {
			mode: "delegate_required",
			owner_direct_override: true,
			technical_failure_fallback: {
				enabled: true,
				minimum_failed_attempts: 1,
				allowed_failure_kinds: ["spawn_guard_incompatible"],
				scope: "same_task_only",
				auto_close_on: ["delegation_success", "task_complete", "handoff"],
			},
		},
	};
	governedContract.contract_digest = contractCore.contractDigest(governedContract);
	for (const binding of governedContract.session_bindings) binding.contract_digest = governedContract.contract_digest;
	writeJson(governedContractPath, governedContract);
	const governedProgress = JSON.parse(fs.readFileSync(governedProgressPath, "utf8"));
	governedProgress.contract_digest = governedContract.contract_digest;
	governedProgress.status = "active";
	writeJson(governedProgressPath, governedProgress);
	const governedRegistry = JSON.parse(fs.readFileSync(governedRegistryPath, "utf8"));
	governedRegistry.bindings["SESSION-1"].contract_digest = governedContract.contract_digest;
	writeJson(governedRegistryPath, governedRegistry);

	assert.match(
		runGate(fixture, "Write", { file_path: "product.txt", content: "blocked until delegated" })?.reason,
		/오케스트레이터 직접 구현은 차단/,
		"delegate-required contract must block root implementation without validated fallback",
	);
	const fallbackTask = {
		schema_version: "orchestrator-fallback-task-v1",
		scope: [governedContract.scope[0]],
		success_criteria: [governedContract.success_criteria[0]],
		allowed_paths: ["product.txt"],
		exact_validators: ["pnpm test"],
	};
	const fallbackTaskDigest = crypto.createHash("sha256").update(JSON.stringify(contractCore.stableValue(fallbackTask))).digest("hex");
	const activatedAt = new Date(Date.now() - 60_000).toISOString();
	const expiresAt = new Date(Date.now() + 20 * 60_000).toISOString();
	const fallback = {
		status: "active",
		activation_kind: "owner_override",
		task_digest: fallbackTaskDigest,
		confirmed_by: "bound_orchestrator",
		owner_authorization_ref: governedContract.source_refs[0],
		allowed_paths: ["product.txt"],
		exact_validators: ["pnpm test"],
		auto_close_on: ["delegation_success", "task_complete", "handoff"],
		task: fallbackTask,
		activated_at: activatedAt,
		expires_at: expiresAt,
	};
	governedProgress.orchestrator_fallback = fallback;
	assert.equal(
		runGate(fixture, "Write", { file_path: ".agents/progress/gate.json", content: JSON.stringify(governedProgress) }),
		null,
		"bound orchestrator may bootstrap valid fallback evidence",
	);
	const malformedFallbackProgress = JSON.parse(JSON.stringify(governedProgress));
	delete malformedFallbackProgress.orchestrator_fallback.owner_authorization_ref;
	assert.equal(
		runGate(fixture, "Write", { file_path: ".agents/progress/gate.json", content: JSON.stringify(malformedFallbackProgress) })?.decision,
		"block",
		"malformed fallback evidence must fail closed",
	);
	writeJson(governedProgressPath, governedProgress);
	assert.equal(contractCore.resolveSessionContract({ cwd: fixture, sessionId: "SESSION-1" }).status, contractCore.STATES.BOUND);
	assert.equal(runGate(fixture, "Write", { file_path: "product.txt", content: "bounded direct fallback" }), null);
	assert.match(runGate(fixture, "Write", { file_path: "secondary.txt", content: "outside task" })?.reason, /직접 우회 범위 밖/);
	assert.equal(runGate(fixture, "Bash", { command: "pnpm test" }), null);
	assert.match(
		runGate(fixture, "Bash", { command: "node .claude/hooks/sync-entry-points.js --apply candidate.md" })?.reason,
		/exact_validators/,
		"declared contract command outside the fallback validator set must remain blocked",
	);

	const sharedContractPath = path.join(fixture, ".agents", "session-contracts", "gate-contract.json");
	const sharedContract = JSON.parse(fs.readFileSync(sharedContractPath, "utf8"));
	sharedContract.session_bindings.push({ session_id: "PEER" });
	sharedContract.contract_digest = contractCore.contractDigest(sharedContract);
	for (const binding of sharedContract.session_bindings) binding.contract_digest = sharedContract.contract_digest;
	writeJson(sharedContractPath, sharedContract);
	const sharedProgressPath = path.join(fixture, ".agents", "progress", "gate.json");
	const sharedProgress = JSON.parse(fs.readFileSync(sharedProgressPath, "utf8"));
	sharedProgress.contract_digest = sharedContract.contract_digest;
	writeJson(sharedProgressPath, sharedProgress);
	const sharedRegistryPath = path.join(fixture, ".agents", "session-contracts", ".session-map.json");
	const sharedRegistry = JSON.parse(fs.readFileSync(sharedRegistryPath, "utf8"));
	sharedRegistry.bindings["SESSION-1"].contract_digest = sharedContract.contract_digest;
	writeJson(sharedRegistryPath, sharedRegistry);
	const changedShared = JSON.parse(JSON.stringify(sharedContract));
	changedShared.goal = "one session cannot rewrite a shared contract";
	changedShared.contract_digest = contractCore.contractDigest(changedShared);
	for (const binding of changedShared.session_bindings) binding.contract_digest = changedShared.contract_digest;
	assert.equal(
		gate.bootstrapWriteAllowed("Write", { file_path: ".agents/session-contracts/gate-contract.json", content: JSON.stringify(changedShared) }, fixture, "SESSION-1"),
		false,
		"shared multi-session contracts require coordinated external replacement",
	);

	const registryPath = sharedRegistryPath;
	const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
	registry.bindings["SESSION-1"].contract_digest = "0".repeat(64);
	writeJson(registryPath, registry);
	assert.equal(runGate(fixture, "apply_patch", { command: "product mutation" })?.decision, "block", "stale digest blocked");

	console.log("session contract gate parity: PASS");
} finally {
	fs.rmSync(fixture, { recursive: true, force: true });
}
