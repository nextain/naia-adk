#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const core = require("./harness-core.js");

const repoRoot = path.resolve(__dirname, "..", "..", "..");

function workspace() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "naia-harness-inject-"));
	fs.mkdirSync(path.join(cwd, ".agents", "progress"), { recursive: true });
	return cwd;
}

function writeProgress(cwd, name, value) {
	fs.writeFileSync(
		path.join(cwd, ".agents", "progress", name),
		JSON.stringify(value, null, 2),
	);
}

function runNode(script, input) {
	return spawnSync(process.execPath, [script], {
		input: JSON.stringify(input),
		encoding: "utf8",
		timeout: 3000,
		env: {
			...process.env,
			CLAUDE_HARNESS: "",
			CODEX_HARNESS: "",
		},
	});
}

function assertSilent(result, label) {
	assert.strictEqual(result.status, 0, `${label} exited ${result.status}: ${result.stderr}`);
	assert.strictEqual(result.stdout, "", `${label} exposed internal unbound state`);
	assert.strictEqual(result.stderr, "", `${label} wrote unexpected stderr`);
}

{
	const cwd = workspace();
	writeProgress(cwd, "other.json", {
		issue: "Unrelated active work",
		current_phase: "build",
		session_id: "OTHER",
	});

	const result = core.buildSessionInject({
		cwd,
		sessionId: "CURRENT",
		hooksDir: path.join(repoRoot, ".codex", "hooks"),
		optOutEnvVar: "CODEX_HARNESS",
		hostConfigDir: ".codex",
		env: {},
	});
	assert.strictEqual(result, null, "core must be silent for an unbound session");

	assertSilent(
		runNode(path.join(repoRoot, ".codex", "hooks", "session-inject.cjs"), {
			cwd,
			session_id: "CURRENT",
		}),
		"Codex UserPromptSubmit adapter",
	);
	assertSilent(
		runNode(path.join(repoRoot, ".claude", "hooks", "session-inject.js"), {
			cwd,
			session_id: "CURRENT",
		}),
		"Claude UserPromptSubmit adapter",
	);
}

{
	const cwd = workspace();
	writeProgress(cwd, "bound.json", {
		issue: "Bound work",
		current_phase: "build",
		session_id: "CURRENT",
		gates_cleared: ["plan"],
	});
	const result = core.buildSessionInject({
		cwd,
		sessionId: "CURRENT",
		hooksDir: path.join(repoRoot, ".codex", "hooks"),
		optOutEnvVar: "CODEX_HARNESS",
		hostConfigDir: ".codex",
		env: {},
	});
	assert.match(result.text, /HARNESS: SESSION STATE/);
	assert.match(result.text, /Bound work/);
}

{
	const gate = require(path.join(repoRoot, ".codex", "hooks", "session-contract-gate.cjs"));
	assert.strictEqual(
		gate.readOnlyShell("touch customer-data"),
		false,
		"mutation must remain outside the unbound read-only allowlist",
	);
	assert.strictEqual(
		gate.readOnlyShell("git status"),
		true,
		"unbound read-only inspection must remain allowed",
	);
}

console.log("harness session injection: PASS");
