import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./install-user-subagent-guard.mjs", import.meta.url));
const SOURCE_HOOK = fileURLToPath(new URL("../.claude/hooks/subagent-model-guard.cjs", import.meta.url));

function run(args) {
	const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
	assert.equal(result.status, 0, `installer failed: ${result.stderr}`);
	assert.equal(result.stderr, "", "successful installer should not write stderr");
	assert.equal(result.stdout.trim().split("\n").length, 1, "installer should emit exactly one JSON line");
	const report = JSON.parse(result.stdout);
	Object.defineProperty(report, "stdout", { value: result.stdout, enumerable: false });
	return report;
}

function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function listBackups(filePath) {
	const dir = path.dirname(filePath);
	const prefix = `${path.basename(filePath)}.bak-`;
	return fs.readdirSync(dir).filter((name) => name.startsWith(prefix)).map((name) => path.join(dir, name));
}

test("user-level installer applies idempotently and preserves settings", () => {
	const tempBase = path.resolve(process.env.TMPDIR || os.tmpdir());
	fs.mkdirSync(tempBase, { recursive: true });
	const suiteRoot = fs.mkdtempSync(path.join(tempBase, "install-user-subagent-guard-"));
	try {
		const emptyHome = path.join(suiteRoot, "empty-home");
		const emptyCheck = run(["--check", "--home", emptyHome]);
		assert.equal(emptyCheck.mode, "check");
		assert.deepEqual(emptyCheck.hook, { exists: false, sameContent: false });
		assert.equal(emptyCheck.registered, false);
		assert.equal(emptyCheck.policy.exists, false);
		assert.equal(emptyCheck.compactWindow, null);
		assert.equal(emptyCheck.defaultModel, null);
		assert.equal(fs.existsSync(path.join(emptyHome, ".claude")), false, "check must not create config files");

		const firstApply = run(["--apply", "--home", emptyHome]);
		assert.deepEqual(firstApply.changed, ["hook", "policy", "settings"]);
		assert.deepEqual(firstApply.backups, []);
		assert.deepEqual(firstApply.hook, { exists: true, sameContent: true });
		assert.equal(firstApply.registered, true);
		assert.equal(firstApply.registrationCount, 1);

		const emptyClaude = path.join(emptyHome, ".claude");
		const installedHook = path.join(emptyClaude, "hooks", "subagent-model-guard.cjs");
		assert.deepEqual(fs.readFileSync(installedHook), fs.readFileSync(SOURCE_HOOK), "installer should copy the standalone hook exactly");
		const initialPolicy = readJson(path.join(emptyClaude, "subagent-model-policy.json"));
		assert.deepEqual(initialPolicy, {
			allowedModels: ["haiku", "sonnet"],
			requireExplicitModel: true,
			requireBrief: true,
			overrideFile: "allow-upper-subagent-until",
			maxOverrideHours: 24,
		});
		const firstSettings = readJson(path.join(emptyClaude, "settings.json"));
		assert.equal(firstSettings.hooks.PreToolUse[0].matcher, "Agent|Task|Workflow");
		assert.equal(firstSettings.hooks.PreToolUse[0].hooks[0].type, "command");
		assert.ok(firstSettings.hooks.PreToolUse[0].hooks[0].command.includes(process.execPath));
		assert.ok(firstSettings.hooks.PreToolUse[0].hooks[0].command.includes(installedHook));
		assert.equal(firstSettings.hooks.PreToolUse[0].hooks[0].timeout, 10);
		assert.equal(firstSettings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "200000");
		assert.equal(Object.hasOwn(firstSettings, "model"), false, "installer should leave the default model unchanged unless requested");
		assert.equal(fs.statSync(path.join(emptyClaude, "settings.json")).mode & 0o777, 0o600, "new settings should be private");

		const secondApply = run(["--apply", "--home", emptyHome]);
		assert.deepEqual(secondApply.changed, [], "second apply should make no changes");
		assert.deepEqual(secondApply.backups, []);
		assert.equal(readJson(path.join(emptyClaude, "settings.json")).hooks.PreToolUse.length, 1, "repeated apply should keep exactly one hook entry");
		fs.writeFileSync(installedHook, "previous user hook bytes\n");
		const hookReplacement = run(["--apply", "--home", emptyHome]);
		assert.deepEqual(hookReplacement.changed, ["hook"], "changed installed hook should be replaced");
		const hookBackups = listBackups(installedHook);
		assert.equal(hookBackups.length, 1, "existing hook should be backed up before replacement");
		assert.equal(fs.readFileSync(hookBackups[0], "utf8"), "previous user hook bytes\n");
		assert.deepEqual(fs.readFileSync(installedHook), fs.readFileSync(SOURCE_HOOK));

		const preserveHome = path.join(suiteRoot, "preserve-home");
		const preserveClaude = path.join(preserveHome, ".claude");
		fs.mkdirSync(preserveClaude, { recursive: true });
		const otherHook = { type: "command", command: "node '/tmp/other-hook.cjs'", timeout: 5 };
		const beforeHook = { type: "command", command: "node '/tmp/before.cjs'", timeout: 2 };
		const afterHook = { type: "command", command: "node '/tmp/after.cjs'", timeout: 3 };
		const installedHookPath = path.join(preserveClaude, "hooks", "subagent-model-guard.cjs");
		const backupLikeHook = { type: "command", command: `node '${installedHookPath}.backup'`, timeout: 7 };
		const targetHook = { type: "command", command: `node '${installedHookPath}'`, timeout: 2 };
		const initial = {
			model: "sonnet",
			hooks: { PreToolUse: [
				{ matcher: "Bash", hooks: [otherHook, backupLikeHook] },
				{ matcher: "Task", hooks: [beforeHook, targetHook, afterHook] },
			] },
			env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "123456", OTHER_TOKEN: "super-secret-value", KEEP: "preserved" },
		};
		const settingsPath = path.join(preserveClaude, "settings.json");
		const initialRaw = `${JSON.stringify(initial, null, 2)}\n`;
		fs.writeFileSync(settingsPath, initialRaw, { mode: 0o600 });
		fs.chmodSync(settingsPath, 0o600);

		const preserveApply = run(["--apply", "--home", preserveHome, "--compact-window", "300000"]);
		assert.equal(preserveApply.registered, true);
		assert.equal(preserveApply.registrationCount, 1);
		assert.equal(preserveApply.compactWindow, "123456", "existing compact-window setting should be preserved");
		assert.equal(preserveApply.defaultModel, "sonnet", "existing default model should be preserved");
		assert.deepEqual(preserveApply.envKeys, ["CLAUDE_CODE_AUTO_COMPACT_WINDOW", "KEEP", "OTHER_TOKEN"]);
		assert.equal(preserveApply.stdout?.includes("super-secret-value"), false, "installer result must not expose secret env values");
		const preserveSettings = readJson(settingsPath);
		assert.deepEqual(preserveSettings.hooks.PreToolUse[0], initial.hooks.PreToolUse[0], "unrelated hooks, including a similar path, should keep their position and contents");
		assert.deepEqual(preserveSettings.hooks.PreToolUse[1].hooks, [beforeHook], "preceding hook should retain its position and content");
		assert.equal(preserveSettings.hooks.PreToolUse[2].matcher, "Agent|Task|Workflow", "existing target hook should be corrected in place");
		assert.deepEqual(preserveSettings.hooks.PreToolUse[3].hooks, [afterHook], "following hook should retain its position and content");
		assert.equal(preserveSettings.env.OTHER_TOKEN, "super-secret-value");
		assert.equal(preserveSettings.env.KEEP, "preserved");
		assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o600, "settings permission should remain 600");
		const settingsBackups = listBackups(settingsPath);
		assert.equal(settingsBackups.length, 1, "settings should be backed up before replacement");
		assert.equal(fs.readFileSync(settingsBackups[0], "utf8"), initialRaw, "settings backup should contain the previous bytes");
		assert.equal(fs.statSync(settingsBackups[0]).mode & 0o777, 0o600, "settings backup should preserve the original permission");
		assert.equal(preserveApply.stdout?.includes("super-secret-value"), false, "installer output must not expose secret env values");

		const policyPath = path.join(preserveClaude, "subagent-model-policy.json");
		fs.writeFileSync(policyPath, "{\"allowedModels\":[\"custom\"]}\n");
		const policyBytes = fs.readFileSync(policyPath);
		run(["--apply", "--home", preserveHome]);
		assert.deepEqual(fs.readFileSync(policyPath), policyBytes, "existing policy should not be overwritten");

		const checkBefore = {
			settings: fs.readFileSync(settingsPath),
			hook: fs.readFileSync(path.join(preserveClaude, "hooks", "subagent-model-guard.cjs")),
			policy: fs.readFileSync(policyPath),
			backups: fs.readdirSync(preserveClaude).sort(),
		};
		const preserveCheck = run(["--check", "--home", preserveHome]);
		assert.equal(preserveCheck.registered, true);
		assert.deepEqual(fs.readFileSync(settingsPath), checkBefore.settings, "check must not change settings");
		assert.deepEqual(fs.readFileSync(path.join(preserveClaude, "hooks", "subagent-model-guard.cjs")), checkBefore.hook, "check must not change hook files");
		assert.deepEqual(fs.readFileSync(policyPath), checkBefore.policy, "check must not change policy files");
		assert.deepEqual(fs.readdirSync(preserveClaude).sort(), checkBefore.backups, "check must not create backups");

		const modelHome = path.join(suiteRoot, "model-home");
		const modelApply = run(["--apply", "--home", modelHome, "--default-model", "opus"]);
		assert.equal(modelApply.defaultModel, "opus", "--default-model should update the top-level model when supplied");
		assert.equal(readJson(path.join(modelHome, ".claude", "settings.json")).model, "opus");
	} finally {
		fs.rmSync(suiteRoot, { recursive: true, force: true });
	}
});
