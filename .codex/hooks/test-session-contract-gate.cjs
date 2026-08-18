const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const gate = require("./session-contract-gate.cjs");
const contractCore = require("../../.agents/hooks/core/session-contract.js");

const repositoryRoot = contractCore.findProjectRoot(__dirname);
const trackedHostLocalState = execFileSync("git", [
	"ls-files", "-z", "--",
	":(glob).agents/progress/_rebind*.json",
	".agents/session-contracts/.session-map.json",
], { cwd: repositoryRoot, encoding: "utf8" }).split("\0").filter(Boolean);
assert.deepEqual(
	trackedHostLocalState,
	[],
	"host-local rebind and session-map state must never cross PCs through Git",
);
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

function writeJson(filePath, value) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function runGate(cwd, toolName, toolInput, extraEnv = {}, resolvedRoot = cwd) {
	return gate.decide(
		{ cwd, session_id: "SESSION-1", tool_name: toolName, tool_input: toolInput },
		{ ...process.env, ADK_PROJECT_ROOT: "", AI_HARNESS: "", CLAUDE_HARNESS: "", CODEX_HARNESS: "", ...extraEnv },
		{ resolveHookProjectRoot: () => resolvedRoot, processCwd: cwd },
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
		allowed_paths: ["product.txt", "nested/**"],
		target_ownership: ["product.txt", "nested/**"],
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
	const nested = path.join(fixture, "nested");
	writeJson(path.join(nested, ".agents", "context", "agents-rules.json"), {});
	writeJson(path.join(nested, ".codex", "hooks.json"), {});
	fs.writeFileSync(path.join(nested, "product.txt"), "nested\n");
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
		if (process.platform === "win32") {
			const mismatch = gate.decide(
				{ cwd: fixture, session_id: "SESSION-1", tool_name: "Bash", tool_input: { command: "git status --short" } },
				process.env,
				{ resolveHookProjectRoot: () => fixture, processCwd: repositoryRoot },
			);
			assert.match(mismatch?.reason, /login shell root mismatch/, `${client} relative shell evidence must fail closed when Windows runs in another project`);
		}
		assert.equal(
			runGate(fixture, "Bash", { command: "node .agents/harness/session-contract-recovery.cjs reclaim --contract orphan-job --session SESSION-1" }),
			null,
			`${client} exact owner-approved reclaim helper is gate-reachable`,
		);
		assert.equal(
			runGate(fixture, "Bash", { command: "node .agents/harness/session-contract-recovery.cjs reclaim --contract orphan-job --session OTHER" })?.decision,
			"block",
			`${client} reclaim cannot target another session`,
		);
		assert.match(
			runGate(fixture, "Bash", { command: "git status --short", workdir: nested })?.reason,
			/workdir/,
			`${client} ignored workdir must not silently inspect the parent repository`,
		);
		assert.equal(
			runGate(fixture, "Bash", { command: `git -C "${nested}" status --short`, workdir: nested }),
			null,
			`${client} explicitly scoped cross-project diagnostics remain available while unbound`,
		);
		assert.equal(
			runGate(fixture, "Bash", { command: "Get-Content -Raw -LiteralPath 'D:\\alpha-adk\\.agents\\session-contracts\\.session-map.json'", workdir: nested }),
			null,
			`${client} native Windows absolute PowerShell reads remain available when workdir is ignored`,
		);
		assert.equal(
			runGate(fixture, "Bash", { command: "Get-ChildItem -LiteralPath 'D:\\alpha-adk\\.agents\\session-contracts' -Force | Select-Object Name,Length", workdir: nested }),
			null,
			`${client} native Windows absolute PowerShell read pipelines remain available when workdir is ignored`,
		);
		assert.match(
			runGate(fixture, "Bash", { command: "Get-Content -LiteralPath .agents/session-contracts/.session-map.json", workdir: nested })?.reason,
			/workdir/,
			`${client} relative PowerShell reads stay blocked when workdir is ignored`,
		);
		assert.match(
			runGate(fixture, "Bash", { command: "Get-Content -LiteralPath 'D:\\alpha-adk\\.agents\\session-contracts\\.session-map.json' & Set-Content local.txt changed", workdir: nested })?.reason,
			/workdir/,
			`${client} appended PowerShell mutation cannot use the absolute-read exception`,
		);
		// Cross-platform fail-open gap (found jointly by win-claude/linux-codex,
		// 2026-08-09): an unbound session whose reported cwd cannot be resolved to
		// any governed project root must not blanket-allow. Read-only investigation
		// stays available; everything else fails closed.
		assert.equal(
			runGate(os.tmpdir(), "Bash", { command: `rm -rf ${path.join(fixture, "AGENTS.md")}` }, {}, os.tmpdir())?.decision,
			"block",
			`${client} mutation with an unresolvable cwd fails closed even when its target is inside a real project`,
		);
		assert.equal(
			runGate(os.tmpdir(), "Bash", { command: "git status --short" }, {}, os.tmpdir()),
			null,
			`${client} genuinely read-only shell remains available when cwd cannot be resolved to a project root`,
		);
		assert.equal(
			runGate(fixture, "Bash", { command: "rm -rf C:\\Windows\\System32\\whatever" })?.decision,
			"block",
			`${client} unbound mutation targeting outside the resolved project stays blocked by the existing unbound catch-all`,
		);
		assert.equal(runGate(fixture, "apply_patch", { command: "product mutation" })?.decision, "block", `${client} legacy shell blocked`);
		const governedBlock = runGate(fixture, "Bash", { command: "npm test" });
		assert.match(governedBlock?.reason, /드리프트 방지 장치/, `${client} explains contract purpose`);
		assert.match(governedBlock?.reason, /수정\/교체·재결박.*재시도하고 계속/, `${client} directs autonomous contract update and continuation`);
		assert.match(governedBlock?.reason, /권한 부족.*충돌.*무결성/, `${client} reserves stopping for genuine blockers`);
		// Ordinary project work is available while unbound. Restricting it to new
		// files under tmp/ left a marker-free checkout unable to write a document
		// or edit an existing file, so every session ran with the harness off
		// instead — a guard nobody can work under enforces nothing.
		assert.equal(
			runGate(fixture, "Write", { file_path: "tmp/new-report.md", content: "report" }),
			null,
			`${client} unbound sessions may create a new artifact without contract bootstrap`,
		);
		fs.mkdirSync(path.join(fixture, "tmp"), { recursive: true });
		fs.writeFileSync(path.join(fixture, "tmp", "existing-report.md"), "existing\n");
		assert.equal(runGate(fixture, "Write", { file_path: "tmp/existing-report.md", content: "replace" }), null, `${client} unbound sessions may rewrite an ordinary existing file`);
		assert.equal(runGate(fixture, "Write", { file_path: "src/new-code.js", content: "code" }), null, `${client} unbound sessions may create ordinary product code`);
		assert.equal(runGate(fixture, "Edit", { file_path: "tmp/new-report.md" }), null, `${client} unbound sessions may edit an ordinary file`);
		// The boundary that remains: nothing that lets this session widen its own
		// authority, and nothing unrecoverable.
		assert.equal(runGate(fixture, "Write", { file_path: ".agents/context/agents-rules.json", content: "{}" })?.decision, "block", `${client} unbound sessions never rewrite governance context`);
		assert.equal(runGate(fixture, "Write", { file_path: ".codex/hooks.json", content: "{}" })?.decision, "block", `${client} unbound sessions never rewrite the hook registry`);
		assert.equal(runGate(fixture, "Edit", { file_path: ".codex/hooks/session-contract-gate.cjs" })?.decision, "block", `${client} unbound sessions never edit the gate that governs them`);
		assert.equal(runGate(fixture, "Write", { file_path: ".claude/settings.json", content: "{}" })?.decision, "block", `${client} unbound sessions never rewrite host settings`);
		assert.equal(runGate(fixture, "Edit", { file_path: "AGENTS.md" })?.decision, "block", `${client} unbound sessions never edit an entrypoint`);
		assert.equal(
			runGate(fixture, "apply_patch", { command: "*** Begin Patch\n*** Delete File: tmp/existing-report.md\n*** End Patch\n" })?.decision,
			"block",
			`${client} deletion is not recoverable from the transcript and keeps needing a contract`,
		);
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
			}),
			null,
			`${client} apply_patch may add an ordinary product file while unbound`,
		);
		assert.equal(
			runGate(fixture, "apply_patch", {
				patch: "*** Begin Patch\n*** Add File: .codex/hooks/extra.cjs\n+evil\n*** End Patch\n",
			})?.decision,
			"block",
			`${client} apply_patch never adds a file to a governance directory while unbound`,
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
		processCwd: fixture,
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
		// An ordinary file outside the declared paths is fine — target_ownership
		// separates sessions, it does not shrink one. Governed paths still are not.
		assert.equal(runGate(fixture, "Write", { file_path: "other.txt", content: "ok" }), null,
			`${client} ordinary out-of-contract file allowed`);
		assert.equal(
			runGate(fixture, "Write", { file_path: ".agents/context/other.yaml", content: "no" })?.decision,
			"block",
			`${client} governed out-of-contract path blocked`,
		);
		assert.match(
			runGate(fixture, "Write", { file_path: "nested/product.txt", content: "no" })?.reason,
			/allowed_paths\/target_ownership/,
			`${client} a parent contract must not authorize a nested ADK project mutation`,
		);
		assert.equal(
			runGate(fixture, "Bash", { command: `git -C "${nested}" add product.txt` })?.decision,
			"block",
			`${client} a parent contract must not authorize nested Git mutation`,
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
		confirmed_by_session_id: "SESSION-1",
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

	// Enforcement was switched off repository-wide because an unbound session could
// not run its tests, its build, or a commit — the same actions the rules file
// authorizes as routine. These pin the carve-out and, just as importantly, that
// it did not become a way around the checks that stop destruction.
{
	const fsu = require("node:fs");
	const osu = require("node:os");
	const fixture = fsu.mkdtempSync(path.join(osu.tmpdir(), "unbound-routine-"));
	fsu.mkdirSync(path.join(fixture, ".agents", "context"), { recursive: true });
	fsu.copyFileSync(path.join(repositoryRoot, ".agents", "context", "agents-rules.json"), path.join(fixture, ".agents", "context", "agents-rules.json"));
	fsu.mkdirSync(path.join(fixture, "scripts"), { recursive: true });
	fsu.writeFileSync(path.join(fixture, "scripts", "run-tests.cjs"), "// test entrypoint\n");
	fsu.writeFileSync(path.join(fixture, "x.test.mjs"), "// test\n");
	const admits = (command) => runGate(fixture, "Bash", { command }) === null;
	for (const command of [
		"npm test","npm run build","pnpm test","yarn lint","node --test x.test.mjs","node scripts/run-tests.cjs",
		"git add -A","git commit -m x","git fetch origin","git merge upstream/main","git stash","git switch -c topic",
		// Languages the allow-list never enumerated, which is why it was the wrong shape.
		"pytest -q","cargo test","go test ./...","make build","ruff check .","mypy src","uv run pytest",
		// Ordinary investigation and local work.
		"gh issue view 332","gh pr list","curl -s https://example.com","aws s3 ls","docker compose up -d",
		"jq '.a | .b' data.json","rg -n 'x|y' file","sed -n '1,20p' file","find . -name '*.json' 2>/dev/null | head",
		"node -e \"process.exit(0)\"","ls $HOME","ffmpeg -i a.wav b.wav","tar -czf out.tgz dir","mkdir -p build",
		// Deployment is delegated to this workspace, so publishing work upward is
		// routine; only the forms that cannot be undone stay behind a contract.
		"git push origin main","git tag v1.2.0","gh pr create --title x","gh issue comment 3 -b done",
	]) {
		assert.equal(admits(command), true, `an unbound session must be able to run: ${command}`);
	}
	for (const command of [
		"git push --force origin main","git push --force-with-lease","git reset --hard HEAD~1","git clean -fd",
		"git branch -D old","rm -rf packages","curl https://example.com -o x",
		"ssh host deploy.sh","rsync -a data host:/backup","sudo systemctl restart nginx",
		"npm publish","cargo publish","pip install requests","gh repo delete foo",
		"docker push registry/img","kubectl apply -f x.yaml","terraform apply","gcloud run deploy svc",
		"curl -X POST https://x -d y",
		// A refused command must not be smuggled in behind an allowed one.
		"npm test && rm -rf x","npm test; rm -rf x","pytest | rm -rf x",
		// Substitution and interpreter -c hide the head the policy judges by.
		"eval \"$(cat cmd)\"","bash -c \"rm -rf /\"","claude -p hi",
	]) {
		assert.equal(admits(command), false, `an unbound session must still be refused: ${command}`);
	}
	// Binding a contract must not cost the ability to verify the work. Before this,
	// writing a contract in order to touch a governed file made npm test fail
	// again because it was not in allowed_shell_commands.
	const boundContract = {
		id: "gate-probe", contract_digest: "a".repeat(64), goal: "g", scope: ["s"], non_goals: ["n"],
		success_criteria: ["c"], allowed_paths: [".agents/context/**"], target_ownership: [".agents/context/**"],
		audiences: ["a"], source_refs: ["r"], session_bindings: [{ session_id: "SESSION-1", contract_digest: "a".repeat(64) }],
		progress_file: "p.json", allowed_shell_commands: ["node validator.mjs"],
	};
	const withContract = (reason) => (command) => gate.decide(
		{ cwd: fixture, session_id: "SESSION-1", tool_name: "Bash", tool_input: { command } },
		{ ...process.env, ADK_PROJECT_ROOT: "", AI_HARNESS: "", CLAUDE_HARNESS: "", CODEX_HARNESS: "" },
		{ resolveHookProjectRoot: () => fixture, processCwd: fixture, resolveSessionContract: () => ({ status: contractCore.STATES.BOUND, projectRoot: fixture, reason, contract: boundContract }) },
	) === null;
	const boundAdmits = withContract("explicit");
	for (const command of ["npm test", "git commit -m x", "node scripts/run-tests.cjs"]) {
		assert.equal(boundAdmits(command), true, `a bound session must still be able to run: ${command}`);
	}
	for (const command of ["rm -rf packages", "curl https://example.com -o x"]) {
		assert.equal(boundAdmits(command), false, `a bound session must still be refused: ${command}`);
	}
	// A delegated worker is the exception: its contract narrows the shell to its
	// one validator on purpose, so the routine allowance must not reopen it.
	const workerAdmits = withContract("derived_delegation_verified");
	assert.equal(workerAdmits("npm test"), false, "a derived worker stays narrowed to its declared validator");
	assert.equal(workerAdmits("node validator.mjs"), true, "the declared validator still runs");
	fsu.rmSync(fixture, { recursive: true, force: true });
}

// This workspace requires independent adversarial review, and the reviewer is
// invoked through skills/review-pass/scripts/invoke-reviewer.mjs. The nested
// runtime check read the reviewer name out of --tool and refused the invoker, so
// the required review could not run at all under enforcement.
{
	const fsr = require("node:fs");
	const osr = require("node:os");
	const fixture = fsr.mkdtempSync(path.join(osr.tmpdir(), "review-invoker-"));
	fsr.mkdirSync(path.join(fixture, ".agents", "context"), { recursive: true });
	fsr.copyFileSync(path.join(repositoryRoot, ".agents", "context", "agents-rules.json"), path.join(fixture, ".agents", "context", "agents-rules.json"));
	const invoker = path.join(fixture, ".agents", "skills", "review-pass", "scripts");
	fsr.mkdirSync(invoker, { recursive: true });
	fsr.writeFileSync(path.join(invoker, "invoke-reviewer.mjs"), "// invoker\n");
	const admits = (command) => runGate(fixture, "Bash", { command }) === null;
	assert.equal(admits("node .agents/skills/review-pass/scripts/invoke-reviewer.mjs --tool codex --repo ."), true,
		"the declared review invoker runs even though a reviewer name appears in its arguments");
	assert.equal(admits("node .agents/skills/review-pass/scripts/invoke-reviewer.mjs --tool opencode --repo ."), true);
	assert.equal(admits("node .agents/skills/review-pass/scripts/invoke-reviewer.mjs --tool codex && codex exec x"), false,
		"a second command joined onto the invoker is not carried by the exemption");
	assert.equal(admits("codex exec -m gpt-5.6-luna task"), false, "launching a runtime directly stays refused");
	assert.equal(admits("bash -c 'opencode run task'"), false, "wrapping a runtime stays refused");
	// The exemption itself must not be claimable by a script outside the project.
	// (Whether such a command passes on ordinary grounds is a separate question:
	// running a script is routine, and only the exemption is path-checked here.)
	assert.equal(gate.reviewInvokerCommand("node /etc/passwd --tool codex", fixture), false,
		"a script outside the project cannot claim the exemption");
	assert.equal(gate.reviewInvokerCommand("node .agents/skills/review-pass/scripts/invoke-reviewer.mjs --tool codex", fixture), true);
	fsr.rmSync(fixture, { recursive: true, force: true });
}

// The refusal tells the session to create and bind a contract, but only Write and
// apply_patch reached the bootstrap path, so editing a contract the ordinary way
// was refused by the same message that asked for it.
{
	const fse = require("node:fs");
	const contractsDir = path.join(repositoryRoot, ".agents", "session-contracts");
	const probePath = path.join(contractsDir, "gate-edit-probe.json");
	const sid = "GATE-EDIT-PROBE";
	const contract = {
		schema_version: "1.0", id: "gate-edit-probe", status: "active", project_root: ".", goal: "probe",
		scope: ["s"], non_goals: ["n"], success_criteria: ["c"], allowed_paths: ["packages/**"],
		target_ownership: ["packages/**"], audiences: ["agent"], source_refs: ["USR:1"],
		session_bindings: [{ session_id: sid, contract_digest: "" }],
		progress_file: ".agents/progress/gate-edit-probe.json", contract_digest: "",
	};
	const seal = (value) => {
		const copy = JSON.parse(JSON.stringify(value));
		copy.contract_digest = ""; copy.session_bindings[0].contract_digest = "";
		const digest = contractCore.contractDigest(copy);
		copy.contract_digest = digest; copy.session_bindings[0].contract_digest = digest;
		return copy;
	};
	const sealed = seal(contract);
	fse.writeFileSync(probePath, JSON.stringify(sealed, null, 2));
	try {
		assert.equal(gate.bootstrapMutationAllowed("Write", { file_path: probePath, content: JSON.stringify(sealed) }, repositoryRoot, sid), true,
			"writing a sealed contract that binds this session is admitted");
		const updated = seal({ ...sealed, goal: "probe updated" });
		const current = fse.readFileSync(probePath, "utf8");
		assert.equal(gate.bootstrapMutationAllowed("Edit", { file_path: probePath, old_string: current, new_string: JSON.stringify(updated, null, 2) }, repositoryRoot, sid), true,
			"editing that contract is admitted on the same terms as writing it");
		assert.equal(gate.bootstrapMutationAllowed("Edit", { file_path: probePath, old_string: current, new_string: "{}" }, repositoryRoot, sid), false,
			"an edit whose result is not a contract binding this session is refused");
		assert.equal(gate.bootstrapMutationAllowed("Edit", { file_path: probePath, old_string: "absent", new_string: "x" }, repositoryRoot, sid), false);
	} finally { fse.rmSync(probePath, { force: true }); }
}

// A project verifying its own work must not depend on which language it is
// written in, nor on whether the session's working directory is the workspace
// root or a submodule inside it.
{
	const submodule = path.join(repositoryRoot, "projects", "naia-agent");
	const routine = (command, cwd) => gate.routineCommandAllowed("Bash", { command }, cwd);
	for (const command of ["pytest -q", "cargo test", "go test ./...", "make test", "ruff check .", "npm test"]) {
		assert.equal(routine(command, repositoryRoot), true, `root: ${command}`);
		if (fs.existsSync(submodule)) assert.equal(routine(command, submodule), true, `submodule: ${command}`);
	}
	// Widening must not reach commands that install, publish or push.
	for (const command of ["cargo publish", "go install ./...", "pip install requests", "git push --force origin main"]) {
		assert.equal(routine(command, repositoryRoot), false, `root refuses: ${command}`);
		if (fs.existsSync(submodule)) assert.equal(routine(command, submodule), false, `submodule refuses: ${command}`);
	}
	// The path boundary must hold through the shell too. Refusing an Edit to a
	// hook while letting `touch` and `sed -i` reach the same file made it
	// decorative: a session could rewrite the rules that govern it.
	for (const command of [
		"touch .claude/allow-outbound",
		"sed -i s/a/b/ .agents/context/terminology.yaml",
		"cp x .codex/hooks/gate.cjs",
		"echo hi > CLAUDE.md",
		"node scripts/gen.js --out .claude/settings.json",
	]) assert.equal(routine(command, repositoryRoot), false, `governance write via shell: ${command}`);
	// Reading governance is how a session learns its own rules, and a progress
	// record is an account of work rather than authority.
	for (const command of [
		"cat .claude/settings.json",
		"grep -rn foo .agents/context",
		"node scripts/x.js .agents/progress/rec.json",
	]) assert.equal(routine(command, repositoryRoot), true, `governance read stays open: ${command}`);

	// The policy is deny-by-exception: routine unless a command is hard to undo.
	const allowance = gate.routineAllowance(repositoryRoot);
	assert.equal(allowance.default, "allow");
	assert.ok(allowance.contract_required_subcommands.git.includes("reset"));
	assert.ok(!allowance.contract_required_subcommands.git.includes("push"), "push is routine; only unrecoverable git forms are gated");
	assert.ok(Object.values(allowance.contract_required_heads).flat().includes("rm"));
}

// Investigation chained with && was judged a mutation, and find's -o operator
// was read as an output flag. Both refused ordinary inspection, and inspection
// of governance paths then hit the path guard on top of that.
{
	const routine = (command) => gate.routineCommandAllowed("Bash", { command }, repositoryRoot);
	for (const command of [
		"pwd && sed -n '1,240p' .agents/context/agents-rules.json",
		"wc -l .agents/context/agents-rules.json .agents/context/terminology.yaml",
		"rg -n foo .agents/context/project-index.yaml && find projects -maxdepth 2 -name 'AGENTS.md' -o -name 'CLAUDE.md'",
		"grep -o pattern file",
	]) assert.equal(routine(command), true, `chained investigation must run: ${command}`);
	for (const command of ["cat a && rm -rf b", "ls && sed -i s/a/b/ .agents/context/x.yaml", "curl https://x -o f"]) {
		assert.equal(routine(command), false, `chaining must not smuggle a mutation: ${command}`);
	}
}

// A contract whose stored digest stopped matching its content locked its owner
// out: the session could neither repair the contract nor rebind the registry,
// so only a human editing files by hand could release it.
{
	const owner = "SESSION-STALE-OWNER";
	const broken = { schema_version: "1.0", id: "broken", status: "active", project_root: ".", goal: "g",
		scope: ["s"], non_goals: ["n"], success_criteria: ["c"], allowed_paths: ["tmp/**"], target_ownership: ["tmp/**"],
		audiences: ["a"], source_refs: ["r"], progress_file: "p.json",
		session_bindings: [{ session_id: owner, contract_digest: "b".repeat(64) }], contract_digest: "b".repeat(64) };
	assert.equal(gate.contractNamesSession(broken, owner), true, "ownership survives a broken digest");
	assert.equal(gate.contractNamesSession(broken, "SOMEONE-ELSE"), false, "ownership is not granted to another session");
	assert.equal(gate.contractNamesSession(null, owner), false);
	assert.equal(gate.contractNamesSession({ session_bindings: "not-an-array" }, owner), false);
}

// A truncated write leaves the registry as broken JSON, every session resolves
// to UNBOUND, and the fresh-registry rule then forbids restoring the peers — so
// nobody can repair it and a human has to hand-edit the file. This happened
// three times on 2026-08-18.
{
	const fsr = require("node:fs");
	const osr = require("node:os");
	const root = fsr.mkdtempSync(path.join(osr.tmpdir(), "registry-repair-"));
	for (const dir of [[".agents", "session-contracts"], [".agents", "progress"], [".agents", "context"], [".git"]]) {
		fsr.mkdirSync(path.join(root, ...dir), { recursive: true });
	}
	fsr.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
	fsr.copyFileSync(path.join(repositoryRoot, ".agents", "context", "agents-rules.json"), path.join(root, ".agents", "context", "agents-rules.json"));
	const make = (id, session) => {
		const base = { schema_version: "1.0", id, status: "active", project_root: ".", goal: "g", scope: ["s"],
			non_goals: ["n"], success_criteria: ["c"], allowed_paths: ["tmp/**"], target_ownership: ["tmp/**"],
			audiences: ["a"], source_refs: ["r"], session_bindings: [{ session_id: session }], progress_file: `.agents/progress/${id}.json` };
		const digest = contractCore.contractDigest(base);
		fsr.writeFileSync(path.join(root, ".agents", "session-contracts", `${id}.json`),
			JSON.stringify({ ...base, contract_digest: digest, session_bindings: [{ session_id: session, contract_digest: digest }] }, null, 2));
		fsr.writeFileSync(path.join(root, ".agents", "progress", `${id}.json`), JSON.stringify({ contract_id: id, contract_digest: digest }, null, 2));
		return { contract_id: id, contract_path: `.agents/session-contracts/${id}.json`, contract_digest: digest };
	};
	const mine = make("mine", "ME");
	const theirs = make("theirs", "PEER");
	const registryPath = path.join(root, ".agents", "session-contracts", ".session-map.json");
	const intact = { schema_version: "1.0", bindings: { ME: mine, PEER: theirs } };
	const admits = (value) => gate.bootstrapWriteAllowed("Write", { file_path: registryPath, content: JSON.stringify(value, null, 2) }, root, "ME");

	fsr.writeFileSync(registryPath, '{"schema_version":"1.0","bindings":{ truncated');
	assert.equal(admits(intact), true, "a session must be able to repair a damaged registry");
	const tampered = JSON.parse(JSON.stringify(intact));
	tampered.bindings.PEER.contract_digest = "f".repeat(64);
	assert.equal(admits(tampered), false, "repair must not rewrite another session's binding");
	const invented = JSON.parse(JSON.stringify(intact));
	invented.bindings.GHOST = { contract_id: "ghost", contract_path: ".agents/session-contracts/ghost.json", contract_digest: "a".repeat(64) };
	assert.equal(admits(invented), false, "repair must not invent a binding");

	// With no file at all this is a first write, not a repair: only your own binding.
	fsr.unlinkSync(registryPath);
	assert.equal(admits({ schema_version: "1.0", bindings: { ME: mine } }), true);
	assert.equal(admits(intact), false, "a fresh registry may not be seeded with other sessions");
	fsr.rmSync(root, { recursive: true, force: true });
}

// target_ownership exists so two sessions do not edit the same files, not to
// shrink what one session may touch. Read as a whitelist it made a bound session
// narrower than an unbound one — binding a contract cost the ability to create
// an ordinary file the session could have created a moment earlier.
{
	const outside = (p) => gate.ordinaryTargetOutsideContract(p, repositoryRoot, "NOT-A-BOUND-SESSION");
	for (const target of ["scratchpad/tmp.txt", "docs/note.md", "packages/benchmark-contract/src/new.mjs"]) {
		assert.equal(outside(target), true, `ordinary file outside the contract: ${target}`);
	}
	for (const target of [".agents/context/terminology.yaml", ".claude/settings.json", "CLAUDE.md",
		".agents/session-contracts/x.json", ".agents/progress/x.json", "/tmp/outside.md"]) {
		assert.equal(outside(target), false, `still governed or out of project: ${target}`);
	}
	// A nested ADK project governs itself; work there happens inside it.
	const nested = fs.readdirSync(path.join(repositoryRoot, "projects"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && fs.existsSync(path.join(repositoryRoot, "projects", entry.name, ".agents")))
		.map((entry) => entry.name)[0];
	if (nested) assert.equal(outside(`projects/${nested}/src/new.ts`), false, "a parent contract does not reach into a nested project");

	// Whatever another active contract claims stays off limits.
	const contractsDir = path.join(repositoryRoot, ".agents", "session-contracts");
	const owned = fs.readdirSync(contractsDir)
		.filter((name) => name.endsWith(".json") && !name.startsWith(".") && name !== "schema.json")
		.map((name) => { try { return JSON.parse(fs.readFileSync(path.join(contractsDir, name), "utf8")); } catch { return null; } })
		.find((contract) => contract?.status === "active" && (contract.target_ownership || []).length > 0);
	if (owned) {
		const claimed = String(owned.target_ownership[0]).replace(/\*\*$/, "probe.txt").replace(/\/$/, "");
		assert.equal(outside(claimed), false, "another contract's ownership is respected");
	}
}

console.log("session contract gate parity: PASS");
} finally {
	fs.rmSync(fixture, { recursive: true, force: true });
}
