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
const outsideFixture = fs.mkdtempSync(path.join(os.tmpdir(), "session-contract-gate-outside-"));
try {
	writeJson(path.join(fixture, ".agents", "context", "agents-rules.json"), {});
	writeJson(path.join(fixture, ".codex", "hooks.json"), {});
	const nested = path.join(fixture, "nested");
	writeJson(path.join(nested, ".agents", "context", "agents-rules.json"), {});
	writeJson(path.join(nested, ".codex", "hooks.json"), {});
	fs.writeFileSync(path.join(nested, "product.txt"), "nested\n");
	fs.writeFileSync(path.join(fixture, "deletion-target.txt"), "keep\n");
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
	execFileSync("git", ["init", "-q"], { cwd: fixture });
	execFileSync("git", ["config", "user.email", "gate@example.invalid"], { cwd: fixture });
	execFileSync("git", ["config", "user.name", "Gate Test"], { cwd: fixture });
	execFileSync("git", ["add", "."], { cwd: fixture });
	execFileSync("git", ["commit", "-qm", "fixture baseline"], { cwd: fixture });
	fs.writeFileSync(path.join(fixture, "product.txt"), "ordinary staged change\n");
	execFileSync("git", ["add", "product.txt"], { cwd: fixture });
	fs.symlinkSync(outsideFixture, path.join(fixture, "escape-link"), "dir");
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
			`${client} unbound mutation targeting outside the resolved project stays blocked`,
		);
		assert.equal(runGate(fixture, "apply_patch", { command: "product mutation" })?.decision, "block", `${client} legacy shell blocked`);
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
		assert.equal(runGate(fixture, "Write", { file_path: "escape-link/payload.txt", content: "escape" })?.decision, "block", `${client} ordinary writes cannot escape through an in-project symlink`);
		assert.equal(runGate(fixture, "Bash", { command: "touch escape-link/payload.txt" })?.decision, "block", `${client} shell writes cannot escape through an in-project symlink`);
		assert.equal(runGate(fixture, "Edit", { file_path: "tmp/new-report.md" }), null, `${client} unbound sessions may edit an ordinary file`);
		assert.equal(runGate(fixture, "Edit", { file_path: path.join(fixture, "tmp", "new-report.md") }), null, `${client} unbound sessions may edit an ordinary file by the absolute path Claude and opencode file tools send`);
		assert.equal(runGate(fixture, "Write", { file_path: path.join(fixture, "src", "abs-code.js"), content: "code" }), null, `${client} unbound sessions may create ordinary product code by absolute path`);
		if (path.sep !== "\\") {
			assert.equal(runGate(fixture, "Write", { file_path: "C:\\repo\\payload.txt", content: "x" })?.decision, "block", `${client} a Windows-style absolute path on a POSIX host stays blocked`);
		}
		assert.equal(runGate(fixture, "Bash", { command: "npm test" }), null, `${client} unbound sessions may run a project test suite`);
		assert.equal(runGate(fixture, "Bash", { command: "mkdir -p src/new" }), null, `${client} unbound sessions may create an ordinary project directory`);
		assert.equal(runGate(fixture, "Bash", { command: "cp product.txt tmp/copied.txt" }), null, `${client} unbound sessions may copy to an ordinary project path`);
		assert.equal(runGate(fixture, "Bash", { command: "curl -o tmp/download.txt https://example.invalid/report" }), null, `${client} read-only HTTP downloads may target an ordinary project path`);
		assert.equal(runGate(fixture, "Bash", { command: "npm test > /dev/null 2>&1" }), null, `${client} ordinary commands may discard output through the null device`);
		assert.equal(runGate(fixture, "Bash", { command: `mkdir -p ${path.join(os.tmpdir(), "outside-project")}` })?.decision, "block", `${client} unbound sessions cannot create outside the resolved project`);
		assert.equal(runGate(fixture, "Bash", { command: "git commit -m 'ordinary change'" }), null, `${client} unbound sessions may create a local commit containing only ordinary paths`);
		assert.equal(
			runGate(fixture, "Bash", { command: "git commit -m 'ordinary & local | message mentioning mkdir .agents/'" }),
			null,
			`${client} quoted commit message text is not mistaken for shell syntax or a governance mutation`,
		);
		assert.equal(
			runGate(fixture, "Bash", { command: "git commit -m 'ordinary' && touch .codex/authority-bypass" })?.decision,
			"block",
			`${client} an unbound local commit cannot chain a governance mutation`,
		);
		fs.unlinkSync(path.join(fixture, "deletion-target.txt"));
		execFileSync("git", ["add", "deletion-target.txt"], { cwd: fixture });
		assert.equal(runGate(fixture, "Bash", { command: "git commit -m 'staged deletion'" })?.decision, "block", `${client} unbound commits cannot smuggle a staged deletion`);
		execFileSync("git", ["restore", "--staged", "--worktree", "deletion-target.txt"], { cwd: fixture });
		// The boundary that remains: nothing that lets this session widen its own
		// authority, and nothing unrecoverable.
		assert.equal(runGate(fixture, "Write", { file_path: ".agents/context/agents-rules.json", content: "{}" })?.decision, "block", `${client} unbound sessions never rewrite governance context`);
		assert.equal(runGate(fixture, "Write", { file_path: ".codex/hooks.json", content: "{}" })?.decision, "block", `${client} unbound sessions never rewrite the hook registry`);
		assert.equal(runGate(fixture, "Edit", { file_path: ".codex/hooks/session-contract-gate.cjs" })?.decision, "block", `${client} unbound sessions never edit the gate that governs them`);
		assert.equal(runGate(fixture, "Write", { file_path: ".claude/settings.json", content: "{}" })?.decision, "block", `${client} unbound sessions never rewrite host settings`);
		assert.equal(runGate(fixture, "Edit", { file_path: "AGENTS.md" })?.decision, "block", `${client} unbound sessions never edit an entrypoint`);
		assert.equal(runGate(fixture, "Bash", { command: "git push --force origin main" })?.decision, "block", `${client} unbound sessions never force-push`);
		assert.equal(runGate(fixture, "Bash", { command: "git reset --hard origin/main" })?.decision, "block", `${client} unbound sessions never rewrite local history from a remote ref`);
		assert.equal(runGate(fixture, "Bash", { command: "curl -X POST https://example.invalid/jobs" })?.decision, "block", `${client} unbound sessions cannot create direct HTTP side effects`);
		assert.equal(runGate(fixture, "Bash", { command: "curl --data '{\"state\":\"changed\"}' https://example.invalid/jobs" })?.decision, "block", `${client} implicit curl POSTs remain contract-bound`);
		assert.equal(runGate(fixture, "Bash", { command: "curl -dstate=changed https://example.invalid/jobs" })?.decision, "block", `${client} attached curl data flags remain contract-bound`);
		assert.equal(runGate(fixture, "Bash", { command: "curl --json={} https://example.invalid/jobs" })?.decision, "block", `${client} curl JSON writes remain contract-bound`);
		assert.equal(runGate(fixture, "Bash", { command: "curl --request=POST https://example.invalid/jobs" })?.decision, "block", `${client} equals-form curl methods remain contract-bound`);
		assert.equal(runGate(fixture, "Bash", { command: "wget --body-data=x https://example.invalid/jobs" })?.decision, "block", `${client} wget request bodies remain contract-bound`);
		assert.equal(runGate(fixture, "Bash", { command: `install product.txt ${path.join(os.tmpdir(), "outside-install")}` })?.decision, "block", `${client} install cannot write outside the project`);
		assert.equal(runGate(fixture, "Bash", { command: `cp product.txt ${path.join(os.tmpdir(), "outside-copy")}` })?.decision, "block", `${client} copy cannot write outside the project`);
		assert.equal(runGate(fixture, "Bash", { command: `cp --target-directory=${os.tmpdir()} product.txt` })?.decision, "block", `${client} copy target-directory options cannot write outside the project`);
		assert.equal(runGate(fixture, "Bash", { command: `install -t ${os.tmpdir()} product.txt` })?.decision, "block", `${client} install target-directory options cannot write outside the project`);
		assert.equal(runGate(fixture, "Bash", { command: `rsync product.txt ${path.join(os.tmpdir(), "outside-rsync")}` })?.decision, "block", `${client} local rsync cannot write outside the project`);
		assert.equal(runGate(fixture, "Bash", { command: "rsync --delete src/ tmp/mirror/" })?.decision, "block", `${client} deleting rsync remains contract-bound`);
		assert.equal(runGate(fixture, "Bash", { command: `ln product.txt ${path.join(os.tmpdir(), "outside-link")}` })?.decision, "block", `${client} links cannot be created outside the project`);
		assert.equal(runGate(fixture, "Bash", { command: `dd if=product.txt of=${path.join(os.tmpdir(), "outside-dd")}` })?.decision, "block", `${client} dd cannot write outside the project`);
		assert.equal(runGate(fixture, "Bash", { command: `tee ${path.join(os.tmpdir(), "outside-tee")}` })?.decision, "block", `${client} tee cannot write outside the project`);
		assert.equal(runGate(fixture, "Bash", { command: `curl --output ${path.join(os.tmpdir(), "outside-download")} https://example.invalid/report` })?.decision, "block", `${client} HTTP downloads cannot write outside the project`);
		assert.equal(runGate(fixture, "Bash", { command: `wget -O ${path.join(os.tmpdir(), "outside-wget")} https://example.invalid/report` })?.decision, "block", `${client} wget downloads cannot write outside the project`);
		assert.equal(runGate(fixture, "Bash", { command: `npm test >&${path.join(os.tmpdir(), "outside-combined-output")}` })?.decision, "block", `${client} combined output redirection cannot write outside the project`);
		assert.equal(runGate(fixture, "Bash", { command: `npm test >|${path.join(os.tmpdir(), "outside-clobber-output")}` })?.decision, "block", `${client} clobber redirection cannot write outside the project`);
		assert.equal(runGate(fixture, "Bash", { command: "ssh deploy@example.invalid restart-service" })?.decision, "block", `${client} unbound sessions cannot execute remote shell commands`);
		assert.equal(runGate(fixture, "Bash", { command: "r\\m -f src/obsolete.js" })?.decision, "block", `${client} backslash-spliced deletion remains contract-bound`);
		assert.equal(runGate(fixture, "Bash", { command: "c\\url -X POST https://example.invalid/jobs" })?.decision, "block", `${client} backslash-spliced HTTP writes remain contract-bound`);
		assert.equal(runGate(fixture, "Bash", { command: "touch .co\\dex/authority-bypass" })?.decision, "block", `${client} backslash-spliced governance paths remain protected`);
		assert.equal(runGate(fixture, "Bash", { command: "aws s3 cp report.json s3://example-bucket/report.json" })?.decision, "block", `${client} cloud CLI effects remain contract-bound`);
		assert.equal(runGate(fixture, "Bash", { command: 'r"m" -f src/obsolete.js' })?.decision, "block", `${client} shell quote splicing cannot disguise a deletion command`);
		assert.equal(runGate(fixture, "Bash", { command: 'c"u"rl -X POST https://example.invalid/jobs' })?.decision, "block", `${client} shell quote splicing cannot disguise a network writer`);
		assert.equal(runGate(fixture, "Bash", { command: 'touch .cod"ex"/authority-bypass' })?.decision, "block", `${client} shell quote splicing cannot disguise a governed target`);
		assert.equal(runGate(fixture, "Bash", { command: "touch .codex/authority-bypass" })?.decision, "block", `${client} unbound shell cannot mutate governance paths`);
		assert.equal(runGate(fixture, "Bash", { command: "Set-Content .\\.codex\\hooks.json -Value changed" })?.decision, "block", `${client} native PowerShell paths cannot rewrite governance files`);
		assert.equal(runGate(fixture, "Bash", { command: "rm -f src/obsolete.js" })?.decision, "block", `${client} unbound shell deletion remains contract-bound`);
		assert.equal(runGate(fixture, "Bash", { command: "/bin/rm -f src/obsolete.js" })?.decision, "block", `${client} absolute deletion executables remain contract-bound`);
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
		assert.equal(
			runGate(fixture, "Write", { file_path: "other.txt", content: "no" })?.decision,
			"block",
			`${client} out-of-contract path blocked`,
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

	console.log("session contract gate parity: PASS");
} finally {
	fs.rmSync(fixture, { recursive: true, force: true });
	fs.rmSync(outsideFixture, { recursive: true, force: true });
}

{
	// Baseline gate: a bound session whose contract declares `baseline` must
	// re-read that baseline (via the ack command) after session start or
	// compaction — and, with reack_after_mutations set, periodically — before
	// the gate lets governed mutations through. Read-only work and the ack
	// command itself always pass, so re-grounding is always reachable.
	const fs = require("node:fs");
	const path = require("node:path");
	const os = require("node:os");
	const gate = require("./session-contract-gate.cjs");
	const contractCore = require("../../.agents/hooks/core/session-contract.js");
	const sessionBaseline = require("../../.agents/harness/session-baseline.cjs");

	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-baseline-"));
	const write = (relative, value) => {
		const target = path.join(root, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value, null, 2));
	};
	write(".agents/context/agents-rules.json", "{}");
	write(".codex/hooks.json", "{}");
	write("docs/intent.md", "the single durable intent\n");
	const contract = {
		schema_version: "1.0",
		id: "baseline-contract",
		status: "active",
		project_root: ".",
		goal: "baseline gate parity",
		scope: ["product.txt"],
		non_goals: [],
		success_criteria: ["deterministic re-ground"],
		allowed_paths: ["product.txt"],
		target_ownership: ["product.txt"],
		audiences: ["developer"],
		source_refs: ["USR-TEST:BASELINE"],
		session_bindings: [{ session_id: "SESSION-1" }],
		progress_file: ".agents/progress/baseline.json",
		baseline: {
			schema_version: "session-baseline-v1",
			intent: "keep the session on its original goal across compaction",
			flow: { current: "build", next: "verify", done_when: "gate blocks unacked mutations" },
			required_reads: ["docs/intent.md"],
			reack_after_mutations: 2,
		},
	};
	const digest = contractCore.contractDigest(contract);
	contract.contract_digest = digest;
	contract.session_bindings[0].contract_digest = digest;
	write(".agents/session-contracts/baseline-contract.json", contract);
	write(".agents/progress/baseline.json", { contract_id: contract.id, contract_digest: digest, current_phase: "build" });
	write(".agents/session-contracts/.session-map.json", {
		schema_version: "1.0",
		bindings: { "SESSION-1": { contract_id: contract.id, contract_path: ".agents/session-contracts/baseline-contract.json", contract_digest: digest } },
	});

	const run = (toolName, toolInput, extra = {}) => gate.decide(
		{ cwd: root, session_id: "SESSION-1", tool_name: toolName, tool_input: toolInput, ...extra },
		{ ...process.env, ADK_PROJECT_ROOT: "", AI_HARNESS: "", CLAUDE_HARNESS: "", CODEX_HARNESS: "" },
		{ resolveHookProjectRoot: () => root, processCwd: root },
	);

	const unacked = run("Write", { file_path: path.join(root, "product.txt"), content: "x" });
	assert.equal(unacked?.decision, "block", "unacked session must not mutate governed files");
	assert.match(unacked?.reason || "", /BASELINE/, "refusal names the baseline gate");
	assert.match(unacked?.reason || "", /session-baseline\.cjs ack --session SESSION-1/, "refusal names the exact ack door");

	assert.equal(run("Bash", { command: "git status --short" }), null, "read-only investigation passes while unacked");
	assert.equal(
		run("Bash", { command: "node .agents/harness/session-baseline.cjs ack --session SESSION-1" }),
		null,
		"the ack command itself passes while unacked",
	);
	assert.notEqual(
		run("Bash", { command: "node .agents/harness/session-baseline.cjs ack --session SESSION-2" }),
		null,
		"another session's ack command stays blocked",
	);

	const ackOutput = sessionBaseline.ack(root, "SESSION-1", contractCore);
	assert.match(ackOutput, /keep the session on its original goal/, "ack prints the intent");
	assert.match(ackOutput, /the single durable intent/, "ack prints the required file content into context");

	assert.equal(run("Write", { file_path: path.join(root, "product.txt"), content: "x" }), null, "acked session mutates freely (mutation 1)");
	assert.equal(run("Write", { file_path: path.join(root, "product.txt"), content: "y" }), null, "mutation 2 reaches the reack threshold");
	const rearmed = run("Write", { file_path: path.join(root, "product.txt"), content: "z" });
	assert.equal(rearmed?.decision, "block", "reack_after_mutations re-arms the gate without any host compaction event");

	sessionBaseline.ack(root, "SESSION-1", contractCore);
	assert.equal(run("Write", { file_path: path.join(root, "product.txt"), content: "w" }), null, "re-ack unlocks again");

	sessionBaseline.bumpEpoch(root, "SESSION-1", "post_compact");
	const afterCompact = run("Write", { file_path: path.join(root, "product.txt"), content: "v" });
	assert.equal(afterCompact?.decision, "block", "a host compaction bump forces a fresh ack");

	// Grok Build reads the Claude hook registry and sends Claude-compatible
	// payloads under its own tool names; a mirrored registry may deliver the
	// same call twice, distinguished only by its tool-use id.
	sessionBaseline.ack(root, "SESSION-1", contractCore);
	assert.equal(run("run_terminal_command", { command: "git status --short" }), null, "grok read-only shell passes");
	const grokEdit = { file_path: path.join(root, "product.txt"), old_string: "a", new_string: "b" };
	assert.equal(run("search_replace", grokEdit, { tool_use_id: "grok-call-1" }), null, "grok search_replace is a governed file mutation (mutation 1)");
	assert.equal(run("search_replace", grokEdit, { tool_use_id: "grok-call-1" }), null, "a redelivered tool-use id is not counted twice");
	assert.equal(run("search_replace", grokEdit, { tool_use_id: "grok-call-2" }), null, "mutation 2 reaches the threshold");
	assert.equal(run("search_replace", grokEdit, { tool_use_id: "grok-call-3" })?.decision, "block", "re-armed after two distinct tool-use ids, not after three deliveries");

	// The ack is bound to the contract digest: editing the contract re-arms.
	sessionBaseline.ack(root, "SESSION-1", contractCore);
	const revised = { ...contract, goal: "baseline gate parity — revised", session_bindings: [{ session_id: "SESSION-1" }] };
	delete revised.contract_digest;
	const revisedDigest = contractCore.contractDigest(revised);
	revised.contract_digest = revisedDigest;
	revised.session_bindings[0].contract_digest = revisedDigest;
	write(".agents/session-contracts/baseline-contract.json", revised);
	write(".agents/progress/baseline.json", { contract_id: contract.id, contract_digest: revisedDigest, current_phase: "build" });
	write(".agents/session-contracts/.session-map.json", {
		schema_version: "1.0",
		bindings: { "SESSION-1": { contract_id: contract.id, contract_path: ".agents/session-contracts/baseline-contract.json", contract_digest: revisedDigest } },
	});
	const afterEdit = run("Write", { file_path: path.join(root, "product.txt"), content: "u" });
	assert.equal(afterEdit?.decision, "block", "a contract edited after the ack re-arms the gate");
	assert.match(afterEdit?.reason || "", /contract_digest/, "refusal says the contract changed");
	sessionBaseline.ack(root, "SESSION-1", contractCore);
	assert.equal(run("Write", { file_path: path.join(root, "product.txt"), content: "t" }), null, "re-ack against the edited contract unlocks");

	fs.rmSync(root, { recursive: true, force: true });
	console.log("baseline gate: PASS");
}
