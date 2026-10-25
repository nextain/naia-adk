const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const guard = require("../subagent-spawn-guard.js");

const tempBase = path.resolve(process.env.SUBAGENT_GUARD_TEST_TMP || os.tmpdir());
fs.mkdirSync(tempBase, { recursive: true });
const suiteRoot = fs.mkdtempSync(path.join(tempBase, "subagent-model-guard-"));
const countersRoot = path.join(suiteRoot, "counters");
const guardPath = path.resolve(__dirname, "../subagent-spawn-guard.js");
const fixedNow = Date.parse("2026-10-26T00:00:00.000Z");
let passed = 0;

function fixture(name, { policy, override, maxSpawns = 4 } = {}) {
	const root = path.join(suiteRoot, name);
	const claudeDir = path.join(root, ".claude");
	fs.mkdirSync(claudeDir, { recursive: true });
	fs.writeFileSync(path.join(claudeDir, "allow-subagents"), JSON.stringify({ maxSpawns }));
	if (policy !== undefined) fs.writeFileSync(path.join(claudeDir, "subagent-model-policy.json"), policy);
	if (override !== undefined) fs.writeFileSync(path.join(claudeDir, "allow-upper-subagent-until"), override);
	return root;
}

function evaluate(root, model, options = {}) {
	return guard.evaluateClaudeSpawn({
		toolName: "Task",
		model,
		sessionId: options.sessionId || path.basename(root),
		root,
		env: options.env || {},
		tmpRoot: countersRoot,
		now: options.now ?? fixedNow,
	});
}

function check(condition, message) {
	assert.ok(condition, message);
	passed += 1;
}

async function runConcurrentAttempts(root) {
	const childSource = [
		`const guard = require(${JSON.stringify(guardPath)});`,
		`const result = guard.evaluate({ toolName: "Task", model: "haiku", sessionId: "concurrent", root: ${JSON.stringify(root)}, env: {}, tmpRoot: ${JSON.stringify(countersRoot)} });`,
		"process.stdout.write(JSON.stringify(result));",
	].join("\n");
	const attempts = Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["-e", childSource], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) return reject(new Error(`concurrent guard child exited ${code}: ${stderr}`));
			try { resolve(JSON.parse(stdout || "null")); } catch (error) { reject(error); }
		});
	}));
	return Promise.all(attempts);
}

async function main() {
	try {
		const missing = fixture("missing-model");
		const missingResult = evaluate(missing, undefined);
		check(Boolean(missingResult?.reason), "missing model must block by default");
		check(/requested model: \(missing\)/u.test(missingResult.reason) && /allowed models: haiku, sonnet/u.test(missingResult.reason), "missing-model block must report the request and default allow list");
		check(/hint: \(none\); exception file: \.claude\/allow-upper-subagent-until/u.test(missingResult.reason), "model block must report hint and exception path");

		const opus = fixture("opus");
		const opusResult = evaluate(opus, "opus");
		check(Boolean(opusResult?.reason) && /requested model: opus/u.test(opusResult.reason), "opus must block by default and name the request");

		const haiku = fixture("haiku");
		check(evaluate(haiku, "haiku") === null, "haiku must pass and preserve the spawn budget path");
		check(guard.readCount(path.basename(haiku), countersRoot) === 1, "allowed spawn must still reserve one concurrent-spawn slot");

		const custom = fixture("custom-policy", {
			policy: JSON.stringify({ allowedModels: ["opus"], requireExplicitModel: true, overrideFile: ".claude/allow-upper-subagent-until", hint: "instance policy" }),
		});
		check(evaluate(custom, "opus") === null, "policy allowedModels must replace the defaults");
		const customDenied = evaluate(custom, "haiku");
		check(Boolean(customDenied?.reason) && /allowed models: opus/u.test(customDenied.reason), "policy allow list must be reported on denial");
		check(/hint: instance policy/u.test(customDenied.reason), "policy hint must be reported on denial");

		const optional = fixture("optional-model", {
			policy: JSON.stringify({ allowedModels: ["haiku"], requireExplicitModel: false }),
		});
		check(evaluate(optional, undefined) === null, "an omitted model may pass when requireExplicitModel is false");
		const invalidOptional = evaluate(optional, 42);
		check(Boolean(invalidOptional?.reason) && /requested model: number: 42/u.test(invalidOptional.reason), "non-string models must block and be identified even when omission is optional");

		const future = new Date(fixedNow + 3_600_000).toISOString();
		const overridden = fixture("future-override", { override: `${future}\n` });
		const overrideResult = evaluate(overridden, "opus");
		check(Boolean(overrideResult?.stderr) && /3600s remain/u.test(overrideResult.stderr), "future override must pass with remaining time on stderr");
		check(guard.readCount(path.basename(overridden), countersRoot) === 1, "override pass must continue through the existing spawn counter");

		const past = fixture("past-override", { override: `${new Date(fixedNow - 1).toISOString()}\n` });
		const pastResult = evaluate(past, "opus");
		check(Boolean(pastResult?.reason) && /exception file: \.claude\/allow-upper-subagent-until \(expired\)/u.test(pastResult.reason), "past override must not bypass the model block");

		const malformedOverride = fixture("malformed-override", { override: "next week\n" });
		const malformedOverrideResult = evaluate(malformedOverride, "opus");
		check(Boolean(malformedOverrideResult?.reason) && /\(invalid\)/u.test(malformedOverrideResult.reason), "malformed override must not bypass the model block");

		const malformedPolicy = fixture("malformed-policy", { policy: "{ invalid json" });
		check(evaluate(malformedPolicy, "haiku") === null, "malformed policy must use the default allowed models");
		const malformedPolicyDenied = evaluate(malformedPolicy, "opus");
		check(Boolean(malformedPolicyDenied?.reason) && /allowed models: haiku, sonnet/u.test(malformedPolicyDenied.reason), "malformed policy must use the blocking default for disallowed models");

		const disabled = fixture("guard-disabled");
		check(evaluate(disabled, "opus", { env: { CLAUDE_SUBAGENT_GUARD: "off" } }) === null, "existing guard off switch must bypass the model check");
		const sharedBudget = fixture("shared-budget-only");
		check(guard.evaluate({ toolName: "Task", root: sharedBudget, sessionId: "shared-budget-only", env: {}, tmpRoot: countersRoot }) === null, "shared budget evaluator must remain model-agnostic for the Codex adapter");

		const cliBlockRoot = fixture("cli-block");
		const cliBlock = spawnSync(process.execPath, [guardPath], {
			input: JSON.stringify({ tool_name: "Task", tool_input: { model: "opus" }, session_id: "cli-block", cwd: cliBlockRoot }),
			encoding: "utf8",
			env: { PATH: process.env.PATH || "", TMPDIR: tempBase, CLAUDE_SUBAGENT_GUARD: "on" },
		});
		check(cliBlock.status === 0 && cliBlock.stderr === "", "Claude PreToolUse block must exit cleanly without stderr");
		const cliBlockOutput = JSON.parse(cliBlock.stdout);
		check(cliBlockOutput.decision === "block" && /allowed models: haiku, sonnet/u.test(cliBlockOutput.reason), "Claude PreToolUse must use the standard block JSON envelope");

		const cliOverrideRoot = fixture("cli-override", { override: `${new Date(Date.now() + 60_000).toISOString()}\n` });
		const cliOverride = spawnSync(process.execPath, [guardPath], {
			input: JSON.stringify({ tool_name: "Task", tool_input: { model: "opus" }, session_id: "cli-override", cwd: cliOverrideRoot }),
			encoding: "utf8",
			env: { PATH: process.env.PATH || "", TMPDIR: tempBase, CLAUDE_SUBAGENT_GUARD: "on" },
		});
		check(cliOverride.status === 0 && cliOverride.stdout === "", "active override must leave PreToolUse unblocked");
		check(/^\[SUBAGENT GUARD\] upper-model override active; .* remain \(until .*\)\.\n$/u.test(cliOverride.stderr), "active override must emit exactly one stderr line");

		const concurrentRoot = fixture("concurrent-budget", { maxSpawns: 3 });
		const concurrentResults = await runConcurrentAttempts(concurrentRoot);
		const concurrentPasses = concurrentResults.filter((result) => result === null).length;
		const reserved = guard.readCount("concurrent", countersRoot);
		check(concurrentPasses <= 3 && reserved <= 3 && reserved >= 1, "parallel attempts must never exceed the configured spawn cap");

		console.log(`subagent spawn guard tests passed (${passed} checks; concurrent cap 3/8 attempts)`);
	} finally {
		fs.rmSync(suiteRoot, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error.stack || error);
	process.exitCode = 1;
});
