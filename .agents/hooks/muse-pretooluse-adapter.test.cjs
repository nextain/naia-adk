#!/usr/bin/env node
"use strict";

const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
	evaluateMusePreToolUse,
	expandPatchOperations,
	interpretClaudeOutput,
	parseArgs,
	translateInput,
} = require("./muse-pretooluse-adapter.cjs");

const root = path.resolve(__dirname, "..", "..");
const adapterPath = path.join(__dirname, "muse-pretooluse-adapter.cjs");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "naia-muse-adapter-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function runAdapter(args, stdinText, options = {}) {
	return cp.spawnSync(process.execPath, [adapterPath, ...args], {
		input: stdinText,
		cwd: options.cwd || root,
		env: options.env || process.env,
		encoding: "utf8",
		shell: false,
		timeout: options.timeout || 15_000,
	});
}

function parseDecision(res) {
	assert.equal(res.error, undefined, res.error?.message);
	assert.equal(res.status, 0, res.stderr);
	if (!res.stdout.trim()) return null;
	return JSON.parse(res.stdout);
}

function writeFile(file, content) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
}

function createRoleAdkFixture(t) {
	const base = fs.mkdtempSync(path.join(scratch, "fixture-"));
	t.after(() => fs.rmSync(base, { recursive: true, force: true }));
	const role = path.join(base, "role");
	const adk = path.join(base, "adk");
	const repo = path.join(base, "repo");
	const work = path.join(base, "work");
	fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
	writeFile(path.join(repo, "src/app.js"), "console.log(0);\n");
	fs.mkdirSync(work, { recursive: true });
	writeFile(path.join(role, ".naia-role.json"), {
		role: "pm",
		read: [],
		lead_guard: { enabled: true, work_dir: work, approver_label: "tester" },
	});
	writeFile(path.join(adk, ".agents/context/project-index.yaml"), "submodules: {}\n");
	writeFile(path.join(adk, ".agents/context/agents-rules.json"), {});
	writeFile(path.join(adk, ".agents/progress/work.json"), { current_phase: "build" });
	writeFile(path.join(adk, ".claude/deploy/config.json"), { projects: {} });
	writeFile(path.join(adk, ".claude/hooks/gcs-guard.config.json"), { buckets: { "example-archive": "archive" } });
	return { base, role, adk, repo, work };
}

test("translateInput maps Muse shell, file, patch, and subagent tools to Claude Code PreToolUse", () => {
	const shell = translateInput({ tool_name: "exec_command", tool_input: { cmd: ["git", "status"] }, cwd: "/tmp/ws" });
	assert.equal(shell.payloads[0].tool_name, "Bash");
	assert.equal(shell.payloads[0].tool_input.command, "git status");

	const mcpShell = translateInput({ tool_name: "mcp__host__bash", tool_input: { command: "ls" }, cwd: "/tmp/ws" });
	assert.equal(mcpShell.payloads[0].tool_name, "Bash");
	assert.equal(mcpShell.payloads[0].tool_input.command, "ls");

	const write = translateInput({ tool_name: "write_file", tool_input: { path: "a.txt", contents: "hi" } });
	assert.equal(write.payloads[0].tool_name, "Write");
	assert.equal(write.payloads[0].tool_input.file_path, "a.txt");
	assert.equal(write.payloads[0].tool_input.content, "hi");

	const edit = translateInput({ tool_name: "edit_file", tool_input: { target_file: "a.txt", find: "old", replace: "new" } });
	assert.equal(edit.payloads[0].tool_name, "Edit");
	assert.equal(edit.payloads[0].tool_input.file_path, "a.txt");
	assert.equal(edit.payloads[0].tool_input.old_string, "old");
	assert.equal(edit.payloads[0].tool_input.new_string, "new");

	const multi = translateInput({
		tool_name: "multi_edit",
		tool_input: { path: "m.txt", edits: [{ find: "x", replace: "y" }] },
	});
	assert.equal(multi.payloads[0].tool_name, "MultiEdit");
	assert.equal(multi.payloads[0].tool_input.edits[0].file_path, "m.txt");
	assert.equal(multi.payloads[0].tool_input.edits[0].old_string, "x");
	assert.equal(multi.payloads[0].tool_input.edits[0].new_string, "y");

	const patchText = [
		"*** Begin Patch",
		"*** Add File: created.env",
		"+KEY=val",
		"*** Update File: old.ts",
		"*** Move to: renamed.ts",
		"+const x = 1;",
		"*** End Patch",
	].join("\n");
	const rawPatch = translateInput({ tool_name: "apply_patch", tool_input: { patch: patchText } }, { expandPatch: false });
	assert.equal(rawPatch.payloads[0].tool_name, "apply_patch");

	const expanded = translateInput({ tool_name: "apply_patch", tool_input: { patch: patchText } }, { expandPatch: true });
	assert.equal(expanded.payloads.length, 2);
	assert.equal(expanded.payloads[0].tool_name, "Write");
	assert.equal(expanded.payloads[0].tool_input.file_path, "created.env");
	assert.equal(expanded.payloads[0].tool_input.content, "KEY=val");
	assert.equal(expanded.payloads[1].tool_name, "Edit");
	assert.equal(expanded.payloads[1].tool_input.file_path, "renamed.ts");
	assert.equal(expanded.payloads[1].tool_input.new_string, "const x = 1;");

	const agent = translateInput({ tool_name: "subagent_spawn", tool_input: { message: "check code" }, agent_type: "worker" });
	assert.equal(agent.payloads[0].tool_name, "Agent");
	assert.equal(agent.payloads[0].tool_input.prompt, "check code");
	assert.equal(agent.payloads[0].agent_type, "worker");

	const workflow = translateInput({ tool_name: "workflow", tool_input: { name: "x" } });
	assert.equal(workflow.payloads[0].tool_name, "Workflow");

	const passthrough = translateInput({ tool_name: "read_file", tool_input: { path: "README.md" } });
	assert.equal(passthrough.payloads[0].tool_name, "read_file");
});

test("expandPatchOperations supports unified diffs and rejects empty input", () => {
	assert.deepEqual(expandPatchOperations(""), []);
	const ops = expandPatchOperations("--- a/foo.js\n+++ b/foo.js\n@@ -1 +1 @@\n-a\n+b\n");
	assert.equal(ops.length, 1);
	assert.equal(ops[0].tool_name, "Edit");
	assert.equal(ops[0].tool_input.file_path, "foo.js");
});

test("real Claude gates allow safe Muse tool calls and lead-write-guard passes subagents and non-repo work files", (t) => {
	const { role, adk, repo, work } = createRoleAdkFixture(t);
	const bashAllow = parseDecision(runAdapter(
		[
			"--adk-root", adk,
			"--hook",
			path.join(root, ".claude/hooks/destructive-git-guard.js"),
			path.join(root, ".claude/hooks/catastrophic-delete-guard.js"),
			path.join(root, ".claude/hooks/git-push-guard.js"),
			path.join(root, ".claude/hooks/commit-guard.js"),
			path.join(root, ".claude/hooks/deploy-guard.js"),
			path.join(root, ".claude/hooks/remote-identity-gate.js"),
			path.join(root, ".claude/hooks/gcs-guard.js"),
		],
		JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "bash", tool_input: { command: "ls" }, cwd: role, permission_mode: "bypassPermissions" }),
		{ cwd: role, env: { PATH: process.env.PATH } },
	));
	assert.equal(bashAllow, null);

	const leadAllowRead = parseDecision(runAdapter(
		["--adk-root", adk, "--hook", path.join(root, ".claude/hooks/lead-write-guard.js")],
		JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "read_file", tool_input: { path: "README.md" }, cwd: role, permission_mode: "bypassPermissions" }),
		{ cwd: role, env: { PATH: process.env.PATH } },
	));
	assert.equal(leadAllowRead, null);

	const leadAllowWork = parseDecision(runAdapter(
		["--adk-root", adk, "--hook", path.join(root, ".claude/hooks/lead-write-guard.js")],
		JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "write_file", tool_input: { file_path: path.join(work, "job/prompt.md"), content: "# task" }, cwd: role, permission_mode: "bypassPermissions" }),
		{ cwd: role, env: { PATH: process.env.PATH } },
	));
	assert.equal(leadAllowWork, null);

	const leadAllowSubagent = parseDecision(runAdapter(
		["--adk-root", adk, "--hook", path.join(root, ".claude/hooks/lead-write-guard.js")],
		JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "edit_file", tool_input: { file_path: path.join(repo, "src/app.js"), old_string: "0", new_string: "1" }, cwd: role, agent_type: "worker", permission_mode: "bypassPermissions" }),
		{ cwd: role, env: { PATH: process.env.PATH } },
	));
	assert.equal(leadAllowSubagent, null);
});

test("real Claude gates deny dangerous shell commands, prod gateway leaks, lead writes, and subagent spawns via Muse payloads", (t) => {
	const { role, adk, repo } = createRoleAdkFixture(t);
	const minimalEnv = { PATH: process.env.PATH };

	const cases = [
		[
			"catastrophic-delete-guard.js",
			["--adk-root", adk, "--hook", path.join(root, ".claude/hooks/catastrophic-delete-guard.js")],
			{ hook_event_name: "PreToolUse", tool_name: "bash", tool_input: { command: "rm -rf /" }, cwd: role, permission_mode: "bypassPermissions" },
		],
		[
			"destructive-git-guard.js",
			["--adk-root", adk, "--hook", path.join(root, ".claude/hooks/destructive-git-guard.js")],
			{ hook_event_name: "PreToolUse", tool_name: "shell", tool_input: { command: "git reset --hard" }, cwd: role, permission_mode: "bypassPermissions" },
		],
		[
			"git-push-guard.js",
			["--adk-root", adk, "--hook", path.join(root, ".claude/hooks/git-push-guard.js")],
			{ hook_event_name: "PreToolUse", tool_name: "exec_command", tool_input: { command: "git push --force" }, cwd: role, permission_mode: "bypassPermissions" },
		],
		[
			"deploy-guard.js (with NAIA_ADK_ROOT from --adk-root)",
			["--adk-root", adk, "--hook", path.join(root, ".claude/hooks/deploy-guard.js")],
			{ hook_event_name: "PreToolUse", tool_name: "bash", tool_input: { command: "vercel --prod" }, cwd: role, permission_mode: "bypassPermissions" },
		],
		[
			"gcs-guard.js",
			["--adk-root", adk, "--hook", path.join(root, ".claude/hooks/gcs-guard.js")],
			{ hook_event_name: "PreToolUse", tool_name: "bash", tool_input: { command: "gsutil cp ./x gs://example-archive/x" }, cwd: role, permission_mode: "bypassPermissions" },
		],
		[
			"remote-identity-gate.js",
			["--adk-root", adk, "--hook", path.join(root, ".claude/hooks/remote-identity-gate.js")],
			{ hook_event_name: "PreToolUse", tool_name: "bash", tool_input: { command: "gh repo create example/sample --public" }, cwd: role, permission_mode: "bypassPermissions" },
		],
		[
			"prod-gateway-guard.js on write_file",
			["--adk-root", adk, "--hook", path.join(root, ".claude/hooks/prod-gateway-guard.js")],
			{
				hook_event_name: "PreToolUse",
				tool_name: "write_file",
				tool_input: { file_path: ".env.local", content: "GATEWAY_URL=https://naia-gateway-123456.region" + ".run.app" },
				cwd: role,
				permission_mode: "bypassPermissions",
			},
		],
		[
			"prod-gateway-guard.js on apply_patch --expand-patch",
			["--adk-root", adk, "--expand-patch", "--hook", path.join(root, ".claude/hooks/prod-gateway-guard.js")],
			{
				hook_event_name: "PreToolUse",
				tool_name: "apply_patch",
				tool_input: {
					patch: "*** Begin Patch\n*** Update File: .env.local\n+GATEWAY_URL=https://naia-gateway-123456.region" + ".run.app\n*** End Patch",
				},
				cwd: role,
				permission_mode: "bypassPermissions",
			},
		],
		[
			"lead-write-guard.js on role write_file",
			["--adk-root", adk, "--hook", path.join(root, ".claude/hooks/lead-write-guard.js")],
			{
				hook_event_name: "PreToolUse",
				tool_name: "write_file",
				tool_input: { file_path: path.join(repo, "src/app.js"), content: "console.log(1)" },
				cwd: role,
				permission_mode: "bypassPermissions",
			},
		],
		[
			"lead-write-guard.js on role apply_patch",
			["--adk-root", adk, "--hook", path.join(root, ".claude/hooks/lead-write-guard.js")],
			{
				hook_event_name: "PreToolUse",
				tool_name: "apply_patch",
				tool_input: { patch: `*** Begin Patch\n*** Add File: ${path.join(repo, "a.js")}\n+x\n*** End Patch` },
				cwd: role,
				permission_mode: "bypassPermissions",
			},
		],
		[
			"subagent-spawn-guard.js",
			["--adk-root", adk, "--hook", path.join(root, ".claude/hooks/subagent-spawn-guard.js")],
			{
				hook_event_name: "PreToolUse",
				tool_name: "subagent_spawn",
				tool_input: { prompt: "do work" },
				cwd: role,
				permission_mode: "bypassPermissions",
			},
		],
	];

	for (const [label, args, payload] of cases) {
		const out = parseDecision(runAdapter(args, JSON.stringify(payload), { cwd: role, env: minimalEnv }));
		assert.equal(out?.hookSpecificOutput?.hookEventName, "PreToolUse", label);
		assert.equal(out?.hookSpecificOutput?.permissionDecision, "deny", `${label}: ${JSON.stringify(out)}`);
		assert.ok(out?.hookSpecificOutput?.permissionDecisionReason?.length > 0, label);
	}
});

test("guard-runpod-create.cjs returns ask interactively and escalates ask -> deny under bypassPermissions", () => {
	const hook = path.join(root, "templates/claude-user-profile/hooks/guard-runpod-create.cjs");
	const askOut = parseDecision(runAdapter(
		["--hook", hook],
		JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "bash", tool_input: { command: "runpodctl pod create --gpu test" }, cwd: root, permission_mode: "default" }),
	));
	assert.equal(askOut?.hookSpecificOutput?.permissionDecision, "ask");

	const denyOut = parseDecision(runAdapter(
		["--hook", hook],
		JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "bash", tool_input: { command: "runpodctl pod create --gpu test" }, cwd: root, permission_mode: "bypassPermissions" }),
	));
	assert.equal(denyOut?.hookSpecificOutput?.permissionDecision, "deny");
	assert.match(denyOut?.hookSpecificOutput?.permissionDecisionReason, /bypassPermissions/);
});

test("adapter fails closed on invalid stdin, missing args, crashes, exit 2, malformed gate stdout, and timeouts", (t) => {
	const dir = fs.mkdtempSync(path.join(scratch, "fail-closed-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	const crashHook = path.join(dir, "crash.js");
	const exit2Hook = path.join(dir, "exit2.js");
	const garbageHook = path.join(dir, "garbage.js");
	const slowHook = path.join(dir, "slow.js");
	fs.writeFileSync(crashHook, "process.stderr.write('boom\\n'); process.exit(1);\n");
	fs.writeFileSync(exit2Hook, "process.stderr.write('blocked by exit 2'); process.exit(2);\n");
	fs.writeFileSync(garbageHook, "process.stdout.write('not-json');\n");
	fs.writeFileSync(slowHook, "setTimeout(() => {}, 5000);\n");

	const basePayload = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "bash", tool_input: { command: "ls" }, cwd: dir });
	const assertDenied = (out, label) => {
		assert.equal(out?.hookSpecificOutput?.hookEventName, "PreToolUse", label);
		assert.equal(out?.hookSpecificOutput?.permissionDecision, "deny", `${label}: ${JSON.stringify(out)}`);
	};

	assertDenied(parseDecision(runAdapter(["--hook", crashHook], "")), "empty stdin");
	assertDenied(parseDecision(runAdapter(["--hook", crashHook], "{bad")), "invalid stdin json");
	assertDenied(parseDecision(runAdapter(["--hook", crashHook], "[]")), "non-object stdin json");
	assertDenied(parseDecision(runAdapter(["--hook", crashHook], JSON.stringify({ hook_event_name: "PreToolUse" }))), "missing tool_name");
	assertDenied(parseDecision(runAdapter([], basePayload)), "missing --hook");
	assertDenied(parseDecision(runAdapter(["--unknown-flag", "--hook", crashHook], basePayload)), "unknown cli flag");
	assertDenied(parseDecision(runAdapter(["--hook", path.join(dir, "missing.js")], basePayload)), "missing hook script");
	assertDenied(parseDecision(runAdapter(["--hook", crashHook], basePayload)), "child exit 1");

	const exit2Out = parseDecision(runAdapter(["--hook", exit2Hook], basePayload));
	assertDenied(exit2Out, "child exit 2");
	assert.match(exit2Out.hookSpecificOutput.permissionDecisionReason, /blocked by exit 2/);

	assertDenied(parseDecision(runAdapter(["--hook", garbageHook], basePayload)), "malformed gate stdout");
	assertDenied(parseDecision(runAdapter(["--timeout-ms", "80", "--hook", slowHook], basePayload)), "gate timeout");

	assertDenied(parseDecision(runAdapter(
		["--expand-patch", "--hook", path.join(root, ".claude/hooks/prod-gateway-guard.js")],
		JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { patch: "unparseable patch" }, cwd: dir }),
	)), "malformed apply_patch");

	assertDenied(interpretClaudeOutput(JSON.stringify({ decision: "block", reason: "nope" }), {}, "dummy.js").output, "legacy block");
	assertDenied(interpretClaudeOutput(JSON.stringify({ continue: false, stopReason: "halt" }), {}, "dummy.js").output, "continue: false");
	assertDenied(evaluateMusePreToolUse({ tool_name: "bash", tool_input: { command: "ls" } }, parseArgs(["--timeout-ms", "0", "--hook", crashHook])), "invalid timeout option");
});

test(".muse/hooks.json references valid hook scripts and compilable matchers", () => {
	const cfg = JSON.parse(fs.readFileSync(path.join(root, ".muse/hooks.json"), "utf8"));
	assert.ok(Array.isArray(cfg?.hooks?.PreToolUse) && cfg.hooks.PreToolUse.length >= 4);
	for (const group of cfg.hooks.PreToolUse) {
		if (group.matcher !== undefined) {
			assert.doesNotThrow(() => new RegExp(group.matcher), `invalid regex: ${group.matcher}`);
		}
		for (const hook of group.hooks) {
			assert.equal(hook.type, "command");
			assert.ok(hook.command.includes("muse-pretooluse-adapter.cjs"));
			for (const m of hook.command.matchAll(/\$root\/([^"\s]+\.(?:js|cjs))/g)) {
				assert.ok(fs.existsSync(path.join(root, m[1])), `missing script in .muse/hooks.json: ${m[1]}`);
			}
		}
	}
});
