const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const gate = require("./session-contract-gate.cjs");
const contractCore = require("../../.agents/hooks/core/session-contract.js");

const repositoryRoot = contractCore.findProjectRoot(__dirname);
const settings = JSON.parse(fs.readFileSync(path.join(repositoryRoot, ".claude/settings.json"), "utf8"));
const claudePreToolCommands = settings.hooks.PreToolUse.flatMap((group) =>
	(group.hooks || []).map((hook) => hook.command),
);
assert.ok(
	claudePreToolCommands.some((command) => command.includes(".claude/hooks/session-contract-gate.js")),
	"Claude must register the same lightweight session gate before mutations",
);
assert.equal(typeof gate.main, "function", "host adapters must invoke the exported gate entrypoint");
const codexSettings = JSON.parse(fs.readFileSync(path.join(repositoryRoot, ".codex/hooks.json"), "utf8"));
const codexPreToolCommands = codexSettings.hooks.PreToolUse.flatMap((group) =>
	(group.hooks || []).map((hook) => hook.command),
);
assert.ok(
	codexPreToolCommands.some((command) => command.includes("session-contract-gate.cjs")),
	"Codex must register the same lightweight session gate before mutations",
);

for (const command of [
	"git branch new-name",
	"git branch -f main HEAD~1",
	"git branch --delete topic",
	"git checkout -b topic",
	"git diff --output=changed.patch",
	"git show HEAD:README.md -o copy.md",
]) assert.equal(gate.readOnlyShell(command), false, command);

for (const command of [
	"git status --short",
	"git diff --stat",
	"git log -1",
	"git show HEAD:README.md",
	"git rev-parse --show-toplevel",
	"Get-Content AGENTS.md",
]) assert.equal(gate.readOnlyShell(command), true, command);

function writeJson(filePath, value) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function runGate(cwd, toolName, toolInput) {
	return gate.decide(
		{ cwd, session_id: "SESSION-1", tool_name: toolName, tool_input: toolInput },
		{ ...process.env, AI_HARNESS: "", CLAUDE_HARNESS: "", CODEX_HARNESS: "" },
	);
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
		allowed_shell_commands: ["pnpm test", "node .claude/hooks/sync-entry-points.js --apply candidate.md"],
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
			runGate(fixture, "Write", {
				file_path: ".agents/session-contracts/.session-map.json",
				content: JSON.stringify({ schema_version: "1.0", bindings: { "SESSION-1": bootstrapPointer, OTHER: bootstrapPointer } }),
			})?.decision,
			"block",
			`${client} initial registry cannot claim another session`,
		);
	}
	fs.unlinkSync(path.join(fixture, ".agents", "session-contracts", "bootstrap-contract.json"));
	fs.unlinkSync(path.join(fixture, ".agents", "progress", "bootstrap.json"));

	bind(fixture);
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

	const registryPath = path.join(fixture, ".agents", "session-contracts", ".session-map.json");
	const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
	registry.bindings["SESSION-1"].contract_digest = "0".repeat(64);
	writeJson(registryPath, registry);
	assert.equal(runGate(fixture, "apply_patch", { command: "product mutation" })?.decision, "block", "stale digest blocked");

	console.log("session contract gate parity: PASS");
} finally {
	fs.rmSync(fixture, { recursive: true, force: true });
}
