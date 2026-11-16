#!/usr/bin/env node
"use strict";

const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
	evaluateMuseEvent,
	evaluateMusePreToolUse,
	expandPatchOperations,
	haltOutput,
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

function runShellCommand(shellCmd, stdinText, options = {}) {
	return cp.spawnSync("sh", ["-c", shellCmd], {
		input: stdinText,
		cwd: options.cwd || root,
		env: options.env || process.env,
		encoding: "utf8",
		timeout: options.timeout || 20_000,
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

function extractHookBasenames(groups, excludeAdapter = false) {
	const set = new Set();
	for (const group of groups || []) {
		for (const hook of group.hooks || []) {
			const cmd = String(hook.command || "");
			for (const match of cmd.matchAll(/(?:["$\w.{}/\\-]+)\/([A-Za-z0-9_.-]+\.(?:js|cjs))(?=["'\s)]|$)/g)) {
				const name = match[1];
				if (excludeAdapter && name === "muse-pretooluse-adapter.cjs") continue;
				set.add(name);
			}
		}
	}
	return set;
}

function renderMuseUserProfile(adkRoot, homeDir, instanceRoot = adkRoot) {
	const raw = fs.readFileSync(path.join(root, "templates/muse-user-profile/settings.json"), "utf8");
	return JSON.parse(
		raw
			.replaceAll("{{ADK_ROOT}}", adkRoot.replace(/\\/g, "/"))
			.replaceAll("{{INSTANCE_ROOT}}", instanceRoot.replace(/\\/g, "/"))
			.replaceAll("{{NODE}}", process.execPath.replace(/\\/g, "/"))
			.replaceAll("{{USER_HOME}}", homeDir.replace(/\\/g, "/")),
	);
}

function createRoleAdkFixture(t) {
	const base = fs.mkdtempSync(path.join(scratch, "fixture-"));
	t.after(() => fs.rmSync(base, { recursive: true, force: true }));
	const home = path.join(base, "home");
	const role = path.join(base, "role");
	const adk = path.join(base, "adk");
	const repo = path.join(base, "repo");
	const work = path.join(base, "work");
	fs.mkdirSync(path.join(home, ".claude/cost-guard"), { recursive: true });
	writeFile(path.join(home, ".claude/cost-guard/policy.json"), {
		configDir: path.join(home, ".claude"),
		expectedEmail: "account@example.invalid",
	});
	fs.copyFileSync(
		path.join(root, "templates/claude-user-profile/subagent-model.policy.example.json"),
		path.join(home, ".claude/subagent-model-policy.json"),
	);
	fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
	fs.mkdirSync(path.join(repo, ".agents/context"), { recursive: true });
	fs.copyFileSync(
		path.join(root, ".agents/context/request-contract.json"),
		path.join(repo, ".agents/context/request-contract.json"),
	);
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
	return { base, home, role, adk, repo, work };
}

test("translateInput maps Muse shell, file, multi_edit, apply_patch, subagent, workflow, and unknown/MCP tools", () => {
	const shell = translateInput({ tool_name: "exec_command", tool_input: { cmd: ["git", "status"] }, cwd: "/tmp/ws" });
	assert.equal(shell.payloads[0].tool_name, "Bash");
	assert.equal(shell.payloads[0].tool_input.command, "git status");

	const mcpShell = translateInput({ tool_name: "mcp__host__bash", tool_input: { command: "ls" }, cwd: "/tmp/ws" });
	assert.equal(mcpShell.payloads[0].tool_name, "Bash");
	assert.equal(mcpShell.payloads[0].tool_input.command, "ls");

	const camelShell = translateInput({ tool_name: "mcp__sh__runCommand", tool_input: { script: "pwd" }, cwd: "/tmp/ws" });
	assert.equal(camelShell.payloads[0].tool_name, "Bash");
	assert.equal(camelShell.payloads[0].tool_input.command, "pwd");

	const write = translateInput({ tool_name: "write_file", tool_input: { path: "a.txt", contents: "hi" } });
	assert.equal(write.payloads[0].tool_name, "Write");
	assert.equal(write.payloads[0].tool_input.file_path, "a.txt");
	assert.equal(write.payloads[0].tool_input.content, "hi");

	const edit = translateInput({
		tool_name: "edit_file",
		tool_input: { target_file: "a.txt", content: "decoy", find: "old", replace: "new" },
	});
	assert.equal(edit.payloads[0].tool_name, "Edit");
	assert.equal(edit.payloads[0].tool_input.file_path, "a.txt");
	assert.equal(edit.payloads[0].tool_input.old_string, "old");
	assert.equal(edit.payloads[0].tool_input.new_string, "new");
	assert.equal(edit.payloads[0].tool_input.content, undefined);

	const multi = translateInput({
		tool_name: "multi_edit",
		tool_input: {
			path: "m1.txt",
			content: "decoy",
			edits: [
				{ find: "x", replace: "y" },
				{ file_path: "m2.txt", old_string: "a", new_string: "b" },
			],
		},
	});
	assert.equal(multi.payloads.length, 2);
	assert.equal(multi.payloads[0].tool_name, "Edit");
	assert.equal(multi.payloads[0].tool_input.file_path, "m1.txt");
	assert.equal(multi.payloads[0].tool_input.old_string, "x");
	assert.equal(multi.payloads[0].tool_input.new_string, "y");
	assert.equal(multi.payloads[0].tool_input.content, undefined);
	assert.equal(multi.payloads[1].tool_name, "Edit");
	assert.equal(multi.payloads[1].tool_input.file_path, "m2.txt");
	assert.equal(multi.payloads[1].tool_input.new_string, "b");

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
	assert.equal(expanded.payloads.length, 3);
	assert.equal(expanded.payloads[0].tool_name, "Write");
	assert.equal(expanded.payloads[0].tool_input.file_path, "created.env");
	assert.equal(expanded.payloads[0].tool_input.content, "KEY=val");
	assert.equal(expanded.payloads[1].tool_name, "Edit");
	assert.equal(expanded.payloads[1].tool_input.file_path, "renamed.ts");
	assert.equal(expanded.payloads[1].tool_input.new_string, "const x = 1;");
	assert.equal(expanded.payloads[2].tool_name, "Edit");
	assert.equal(expanded.payloads[2].tool_input.file_path, "old.ts");

	const agent = translateInput({ tool_name: "subagent_spawn", tool_input: { message: "check code" }, agent_type: "worker" });
	assert.equal(agent.payloads[0].tool_name, "Agent");
	assert.equal(agent.payloads[0].tool_input.prompt, "check code");
	assert.equal(agent.payloads[0].agent_type, "worker");

	const workflow = translateInput({ tool_name: "workflow", tool_input: { name: "x", script: "step()" } });
	assert.equal(workflow.payloads[0].tool_name, "Workflow");

	const passthrough = translateInput({ tool_name: "read_file", tool_input: { path: "README.md" } });
	assert.equal(passthrough.payloads[0].tool_name, "read_file");
	assert.equal(passthrough.unknownTool, undefined);

	const benignUnknown = translateInput({ tool_name: "mcp__docs__lookup", tool_input: { query: "muse hooks" } });
	assert.equal(benignUnknown.unknownTool, "mcp__docs__lookup");
	assert.equal(benignUnknown.payloads[0].tool_name, "mcp__docs__lookup");
});

test("expandPatchOperations supports unified diffs, renames, deletions, and rejects empty input", () => {
	assert.deepEqual(expandPatchOperations(""), []);
	const ops = expandPatchOperations("--- a/foo.js\n+++ b/foo.js\n@@ -1 +1 @@\n-a\n+b\n");
	assert.equal(ops.length, 1);
	assert.equal(ops[0].tool_name, "Edit");
	assert.equal(ops[0].tool_input.file_path, "foo.js");

	const delOps = expandPatchOperations("--- a/goner.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n");
	assert.equal(delOps.length, 2);
	assert.equal(delOps[0].tool_name, "Edit");
	assert.equal(delOps[0].tool_input.file_path, "goner.js");
	assert.equal(delOps[1].tool_name, "apply_patch");
	assert.match(delOps[1].tool_input.patch, /^\*\*\* Delete File: goner\.js$/m);
});

test("[Blocker 1] catch-all PreToolUse blocks mcp__x__bash and unknown shell/write tools while allowing benign unknown tools with 1-line stderr warning", (t) => {
	const { home, role, repo } = createRoleAdkFixture(t);
	const repoHooks = JSON.parse(fs.readFileSync(path.join(root, ".muse/hooks.json"), "utf8"));
	assert.equal(repoHooks.hooks.PreToolUse.length, 1);
	assert.equal(repoHooks.hooks.PreToolUse[0].matcher, undefined, "repo PreToolUse must be catch-all without matcher");
	const repoCmd = repoHooks.hooks.PreToolUse[0].hooks[0].command;

	const env = { ...process.env, HOME: home, NAIA_ADK_ROOT: root };

	// 1. MCP-prefixed bash (`mcp__x__bash`) hits catch-all in .muse/hooks.json and is denied.
	const mcpBashRes = parseDecision(runShellCommand(
		repoCmd,
		JSON.stringify({
			session_id: "019daea9-5fd2-71c0-8dc6-0d9c92b0c2bf",
			hook_event_name: "PreToolUse",
			tool_name: "mcp__x__bash",
			tool_use_id: "call_mcp_bash_1",
			tool_input: { command: "rm -rf /" },
			cwd: role,
			permission_mode: "bypassPermissions",
		}),
		{ cwd: role, env },
	));
	assert.equal(mcpBashRes?.hookSpecificOutput?.permissionDecision, "deny");

	// 2. Unknown tool with `cmd`/`script` field (`mcp__custom__runner`) is classified as Bash and denied.
	const unknownExecRes = parseDecision(runShellCommand(
		repoCmd,
		JSON.stringify({
			session_id: "019daea9-5fd2-71c0-8dc6-0d9c92b0c2bf",
			hook_event_name: "PreToolUse",
			tool_name: "mcp__custom__runner",
			tool_use_id: "call_mcp_exec_1",
			tool_input: { cmd: ["git", "push", "--force", "origin", "main"] },
			cwd: role,
			permission_mode: "bypassPermissions",
		}),
		{ cwd: role, env },
	));
	assert.equal(unknownExecRes?.hookSpecificOutput?.permissionDecision, "deny");

	// 3. Unknown tool with `path` + `content` (`mcp__custom__put_blob`) writing to 3-layer blocked repo is classified as Write and denied.
	const unknownWriteRes = parseDecision(runShellCommand(
		repoCmd,
		JSON.stringify({
			session_id: "019daea9-5fd2-71c0-8dc6-0d9c92b0c2bf",
			hook_event_name: "PreToolUse",
			tool_name: "mcp__custom__put_blob",
			tool_use_id: "call_mcp_write_1",
			tool_input: { path: path.join(repo, "src/app.js"), content: "console.log('pwned')" },
			cwd: role,
			permission_mode: "bypassPermissions",
		}),
		{ cwd: role, env },
	));
	assert.equal(unknownWriteRes?.hookSpecificOutput?.permissionDecision, "deny");

	// 4. Benign unknown tool (`mcp__docs__lookup`) passes (`null`) and emits exactly 1 warning line on stderr.
	const benignRaw = runShellCommand(
		repoCmd,
		JSON.stringify({
			session_id: "019daea9-5fd2-71c0-8dc6-0d9c92b0c2bf",
			hook_event_name: "PreToolUse",
			tool_name: "mcp__docs__lookup",
			tool_use_id: "call_mcp_docs_1",
			tool_input: { query: "hook specification" },
			cwd: role,
			permission_mode: "bypassPermissions",
		}),
		{ cwd: role, env },
	);
	assert.equal(parseDecision(benignRaw), null);
	const stderrLines = benignRaw.stderr.trim().split("\n").filter(Boolean);
	assert.equal(stderrLines.length, 1, `expected 1-line warning, got: ${benignRaw.stderr}`);
	assert.match(stderrLines[0], /\[muse-gate-adapter\] Unknown tool passthrough: mcp__docs__lookup/);
});

test("[Blocker 2] multi_edit and apply_patch inspect every target file and deny if any 2nd/moved/deleted file is blocked", (t) => {
	const { home, role, repo, work } = createRoleAdkFixture(t);
	const repoCmd = JSON.parse(fs.readFileSync(path.join(root, ".muse/hooks.json"), "utf8")).hooks.PreToolUse[0].hooks[0].command;
	const env = { ...process.env, HOME: home, NAIA_ADK_ROOT: root };

	// 1. multi_edit: 1st file in allowed outside-repo work_dir, 2nd file in 3-layer blocked repo -> deny.
	const multiLeadOut = parseDecision(runShellCommand(
		repoCmd,
		JSON.stringify({
			session_id: "019daea9-5fd2-71c0-8dc6-0d9c92b0c2bf",
			hook_event_name: "PreToolUse",
			tool_name: "multi_edit",
			tool_use_id: "call_multi_1",
			tool_input: {
				edits: [
					{ file_path: path.join(work, "job/prompt.md"), old_string: "a", new_string: "b" },
					{ file_path: path.join(repo, "src/app.js"), old_string: "0", new_string: "1" },
				],
			},
			cwd: role,
			permission_mode: "bypassPermissions",
		}),
		{ cwd: role, env },
	));
	assert.equal(multiLeadOut?.hookSpecificOutput?.permissionDecision, "deny");

	// 2. multi_edit: decoy top-level `content: "safe"` cannot mask prod gateway URL in 2nd edit.
	const multiGatewayOut = parseDecision(runAdapter(
		["--when", "Edit|Write", "--hook", path.join(root, ".claude/hooks/prod-gateway-guard.js")],
		JSON.stringify({
			hook_event_name: "PreToolUse",
			tool_name: "multi_edit",
			tool_input: {
				content: "safe decoy",
				edits: [
					{ file_path: path.join(work, "notes.md"), old_string: "x", new_string: "y" },
					{ file_path: path.join(work, ".env.local"), old_string: "", new_string: "GATEWAY_URL=https://naia-gateway-123456.region" + ".run.app" },
				],
			},
			cwd: work,
			permission_mode: "bypassPermissions",
		}),
		{ cwd: work, env },
	));
	assert.equal(multiGatewayOut?.hookSpecificOutput?.permissionDecision, "deny");

	// 3. apply_patch: 1st file allowed (`work/ok.md`), 2nd file 3-layer blocked (`repo/src/app.js`) -> deny.
	const patchSecondBlocked = parseDecision(runShellCommand(
		repoCmd,
		JSON.stringify({
			session_id: "019daea9-5fd2-71c0-8dc6-0d9c92b0c2bf",
			hook_event_name: "PreToolUse",
			tool_name: "apply_patch",
			tool_use_id: "call_patch_2nd",
			tool_input: {
				patch: [
					"*** Begin Patch",
					`*** Add File: ${path.join(work, "job/ok.md")}`,
					"+hello",
					`*** Update File: ${path.join(repo, "src/app.js")}`,
					"+console.log(2);",
					"*** End Patch",
				].join("\n"),
			},
			cwd: role,
			permission_mode: "bypassPermissions",
		}),
		{ cwd: role, env },
	));
	assert.equal(patchSecondBlocked?.hookSpecificOutput?.permissionDecision, "deny");

	// 4. apply_patch Move to: destination is allowed (`work/moved.js`) while source is inside 3-layer blocked repo -> deny.
	const patchMoveBlocked = parseDecision(runShellCommand(
		repoCmd,
		JSON.stringify({
			session_id: "019daea9-5fd2-71c0-8dc6-0d9c92b0c2bf",
			hook_event_name: "PreToolUse",
			tool_name: "apply_patch",
			tool_use_id: "call_patch_move",
			tool_input: {
				patch: [
					"*** Begin Patch",
					`*** Update File: ${path.join(repo, "src/app.js")}`,
					`*** Move to: ${path.join(work, "job/moved.js")}`,
					"+console.log('moved');",
					"*** End Patch",
				].join("\n"),
			},
			cwd: role,
			permission_mode: "bypassPermissions",
		}),
		{ cwd: role, env },
	));
	assert.equal(patchMoveBlocked?.hookSpecificOutput?.permissionDecision, "deny");

	// 5. apply_patch `*** Delete File:` inside unbound repository is denied by session-contract-gate.js.
	const patchDeleteBlocked = parseDecision(runShellCommand(
		repoCmd,
		JSON.stringify({
			session_id: "019daea9-5fd2-71c0-8dc6-0d9c92b0c2bf",
			hook_event_name: "PreToolUse",
			tool_name: "apply_patch",
			tool_use_id: "call_patch_del",
			tool_input: {
				patch: `*** Begin Patch\n*** Delete File: ${path.join(repo, "src/app.js")}\n*** End Patch`,
			},
			cwd: repo,
			permission_mode: "bypassPermissions",
		}),
		{ cwd: repo, env },
	));
	assert.equal(patchDeleteBlocked?.hookSpecificOutput?.permissionDecision, "deny");
});

test("[Blocker 3] workflow tool hits subagent gates in both .muse/hooks.json and templates/muse-user-profile/settings.json", (t) => {
	const { home, role, adk } = createRoleAdkFixture(t);
	const repoCmd = JSON.parse(fs.readFileSync(path.join(root, ".muse/hooks.json"), "utf8")).hooks.PreToolUse[0].hooks[0].command;
	const userProfile = renderMuseUserProfile(root, home, adk);
	const userCmd = userProfile.hooks.PreToolUse[0].hooks[0].command;
	const env = { ...process.env, HOME: home, NAIA_ADK_ROOT: adk };

	// 1. Repository layer blocks `workflow` when `.claude/allow-subagents` is absent.
	const repoDeny = parseDecision(runShellCommand(
		repoCmd,
		JSON.stringify({
			session_id: "019daea9-5fd2-71c0-8dc6-0d9c92b0c2bf",
			hook_event_name: "PreToolUse",
			tool_name: "workflow",
			tool_use_id: "call_wf_repo",
			tool_input: { name: "fanout", script: "parallel()" },
			cwd: role,
			permission_mode: "bypassPermissions",
		}),
		{ cwd: role, env: { ...env, NAIA_ADK_ROOT: root } },
	));
	assert.equal(repoDeny?.hookSpecificOutput?.permissionDecision, "deny");
	assert.match(repoDeny?.hookSpecificOutput?.permissionDecisionReason, /Subagent|allow-subagents/i);

	// 2. User-profile layer blocks `workflow` via subagent-spawn-guard.js first, and even after opting into
	//    allow-subagents still enforces subagent-model-guard.cjs (model + brief requirement).
	const userDenySpawn = parseDecision(runShellCommand(
		userCmd,
		JSON.stringify({
			session_id: "019daea9-5fd2-71c0-8dc6-0d9c92b0c2bf",
			hook_event_name: "PreToolUse",
			tool_name: "workflow",
			tool_use_id: "call_wf_user_1",
			tool_input: { name: "fanout", script: "parallel()" },
			cwd: role,
			permission_mode: "bypassPermissions",
		}),
		{ cwd: role, env },
	));
	assert.equal(userDenySpawn?.hookSpecificOutput?.permissionDecision, "deny");

	writeFile(path.join(role, ".claude/allow-subagents"), "2\n");
	const userDenyWorkflowNoOverride = parseDecision(runShellCommand(
		userCmd,
		JSON.stringify({
			session_id: "019daea9-5fd2-71c0-8dc6-0d9c92b0c2bf",
			hook_event_name: "PreToolUse",
			tool_name: "workflow",
			tool_use_id: "call_wf_user_2",
			tool_input: { name: "fanout", script: "parallel()" },
			cwd: role,
			permission_mode: "bypassPermissions",
		}),
		{ cwd: role, env },
	));
	assert.equal(userDenyWorkflowNoOverride?.hookSpecificOutput?.permissionDecision, "deny");
	assert.match(userDenyWorkflowNoOverride?.hookSpecificOutput?.permissionDecisionReason, /SUBAGENT MODEL GUARD/);

	const futureIso = new Date(Date.now() + 2 * 3_600_000).toISOString();
	writeFile(path.join(home, ".claude/allow-upper-subagent-until"), `${futureIso}\n`);
	const userAllowValid = parseDecision(runShellCommand(
		userCmd,
		JSON.stringify({
			session_id: "019daea9-5fd2-71c0-8dc6-0d9c92b0c2bf",
			hook_event_name: "PreToolUse",
			tool_name: "workflow",
			tool_use_id: "call_wf_user_3",
			tool_input: { name: "fanout", script: "parallel()" },
			cwd: role,
			permission_mode: "bypassPermissions",
		}),
		{ cwd: role, env },
	));
	if (userAllowValid !== null) {
		assert.notEqual(userAllowValid?.hookSpecificOutput?.permissionDecision, "deny");
	}
});

test("[Blocker 4] internal cumulative deadline, SIGKILL on SIGTERM-ignoring gates, and shell wrapper fail-closed when node/adapter is missing", (t) => {
	const dir = fs.mkdtempSync(path.join(scratch, "deadline-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	const ignoreSigtermHook = path.join(dir, "ignore-sigterm.js");
	const mediumHook = path.join(dir, "medium.js");
	fs.writeFileSync(ignoreSigtermHook, "process.on('SIGTERM', () => {}); setTimeout(() => {}, 10000);\n");
	fs.writeFileSync(mediumHook, "const end = Date.now() + 110; while (Date.now() < end) {}\n");

	const payload = JSON.stringify({
		session_id: "019daea9-5fd2-71c0-8dc6-0d9c92b0c2bf",
		hook_event_name: "PreToolUse",
		tool_name: "bash",
		tool_use_id: "call_timeout_1",
		tool_input: { command: "ls" },
		cwd: dir,
	});

	// 1. Child ignoring SIGTERM is killed by SIGKILL within internal `--deadline-ms` and emits deny JSON (exit 0).
	const t0 = Date.now();
	const killedOut = parseDecision(runAdapter(["--deadline-ms", "160", "--hook", ignoreSigtermHook], payload));
	const elapsed = Date.now() - t0;
	assert.equal(killedOut?.hookSpecificOutput?.permissionDecision, "deny");
	assert.ok(elapsed < 3000, `expected fast SIGKILL termination before outer timeout, took ${elapsed}ms`);

	// 2. Cumulative deadline across multiple hooks denies before outer timeout expires.
	const cumOut = parseDecision(runAdapter(["--deadline-ms", "150", "--hook", mediumHook, mediumHook, mediumHook], payload));
	assert.equal(cumOut?.hookSpecificOutput?.permissionDecision, "deny");

	// 3. Every configured Muse command has `--deadline-ms` strictly below Muse outer `timeout * 1000`.
	const repoCfg = JSON.parse(fs.readFileSync(path.join(root, ".muse/hooks.json"), "utf8"));
	const userCfg = renderMuseUserProfile(root, dir);
	for (const [label, cfg] of [[".muse/hooks.json", repoCfg], ["templates/muse-user-profile/settings.json", userCfg]]) {
		for (const [eventName, groups] of Object.entries(cfg.hooks)) {
			for (const group of groups) {
				for (const hook of group.hooks) {
					const m = hook.command.match(/--deadline-ms\s+(\d+)/);
					assert.ok(m, `${label} ${eventName} missing --deadline-ms`);
					const deadlineMs = Number(m[1]);
					const outerMs = Number(hook.timeout) * 1000;
					assert.ok(deadlineMs > 0 && deadlineMs + 3000 <= outerMs, `${label} ${eventName}: deadline ${deadlineMs}ms too close to timeout ${outerMs}ms`);
				}
			}
		}
	}

	// 4. Shell wrapper fail-closed when adapter is missing or node binary is unavailable.
	const repoPreCmd = repoCfg.hooks.PreToolUse[0].hooks[0].command;
	const missingAdapterOut = parseDecision(runShellCommand(repoPreCmd, payload, {
		cwd: dir,
		env: { ...process.env, NAIA_ADK_ROOT: path.join(dir, "missing-adk") },
	}));
	assert.equal(missingAdapterOut?.hookSpecificOutput?.permissionDecision, "deny");

	const missingNodeRepoOut = parseDecision(runShellCommand(repoPreCmd, payload, {
		cwd: root,
		env: { ...process.env, NAIA_ADK_ROOT: root, NAIA_NODE_BIN: path.join(dir, "no-such-node") },
	}));
	assert.equal(missingNodeRepoOut?.hookSpecificOutput?.permissionDecision, "deny");

	const userPreCmd = userCfg.hooks.PreToolUse[0].hooks[0].command;
	const missingNodeUserOut = parseDecision(runShellCommand(userPreCmd, payload, {
		cwd: dir,
		env: { ...process.env, NAIA_NODE_BIN: path.join(dir, "no-such-node") },
	}));
	assert.equal(missingNodeUserOut?.hookSpecificOutput?.permissionDecision, "deny");

	// 5. Note 1: NAIA_ADK_ROOT takes precedence over ADK_PROJECT_ROOT in .muse/hooks.json.
	const precedenceOut = parseDecision(runShellCommand(
		repoPreCmd,
		JSON.stringify({
			session_id: "019daea9-5fd2-71c0-8dc6-0d9c92b0c2bf",
			hook_event_name: "PreToolUse",
			tool_name: "read_file",
			tool_use_id: "call_read_1",
			tool_input: { path: "README.md" },
			cwd: dir,
		}),
		{
			cwd: dir,
			env: { ...process.env, NAIA_ADK_ROOT: root, ADK_PROJECT_ROOT: path.join(dir, "broken-root") },
		},
	));
	assert.equal(precedenceOut, null);

	// 6. Event-specific Muse output translation (PreCompact continue:false, PostCompact systemMessage, UserPromptSubmit decision:block).
	assert.deepEqual(haltOutput("PreCompact", "compact blocked"), { continue: false, stopReason: "compact blocked" });
	assert.deepEqual(haltOutput("UserPromptSubmit", "prompt blocked"), { decision: "block", reason: "prompt blocked" });
	assert.deepEqual(haltOutput("PostCompact", "post compact note"), { systemMessage: "post compact note" });
	const preCompactConverted = interpretClaudeOutput(
		JSON.stringify({ decision: "block", reason: "unsealed contract" }),
		{},
		"request-contract.js",
		"PreCompact",
	);
	assert.deepEqual(preCompactConverted, { action: "halt", output: { continue: false, stopReason: "unsealed contract" } });
	const postCompactContext = evaluateMuseEvent(
		{ hook_event_name: "PostCompact", session_id: "s1", cwd: dir },
		parseArgs(["--event", "PostCompact", "--hook", path.join(root, ".claude/hooks/post-compact-context.js")]),
	);
	assert.equal(postCompactContext?.hookSpecificOutput, undefined, "Muse PostCompact forbids hookSpecificOutput.additionalContext");
	assert.match(postCompactContext?.systemMessage || "", /Context compacted or new session started/);
});

test("[Blocker 5 — User Layer] templates/muse-user-profile/settings.json matches templates/claude-user-profile/settings.json event-for-event and file-for-file", (t) => {
	// Explicit exception map: `{ "<Event>:<script>": "<documented reason>" }`.
	// Empty because every Claude user-profile event and hook has a 1:1 Muse counterpart.
	const USER_LAYER_EXCEPTIONS = {};

	const claudeUser = JSON.parse(fs.readFileSync(path.join(root, "templates/claude-user-profile/settings.json"), "utf8"));
	const museUser = JSON.parse(fs.readFileSync(path.join(root, "templates/muse-user-profile/settings.json"), "utf8"));

	const claudeEvents = Object.keys(claudeUser.hooks || {}).sort();
	const museEvents = Object.keys(museUser.hooks || {}).sort();
	assert.deepEqual(museEvents, claudeEvents, "user-layer hook events must match Claude user profile");

	for (const eventName of claudeEvents) {
		const claudeSet = extractHookBasenames(claudeUser.hooks[eventName], false);
		const museSet = extractHookBasenames(museUser.hooks[eventName], true);
		for (const [key, reason] of Object.entries(USER_LAYER_EXCEPTIONS)) {
			assert.ok(reason && reason.length >= 10, `exception ${key} requires an explicit reason`);
			const [excEvent, excScript] = key.split(":");
			if (excEvent === eventName) {
				claudeSet.delete(excScript);
				museSet.delete(excScript);
			}
		}
		assert.deepEqual(
			[...museSet].sort(),
			[...claudeSet].sort(),
			`user-layer ${eventName} hook script set mismatch`,
		);
	}

	// Verify specific Blocker 5 user-layer invariants:
	const userPreHooks = extractHookBasenames(museUser.hooks.PreToolUse, true);
	assert.ok(userPreHooks.has("cost-guard.cjs"), "user layer must include cost-guard.cjs");
	assert.ok(userPreHooks.has("subagent-model-guard.cjs"), "user layer must include subagent-model-guard.cjs");
	assert.equal(userPreHooks.has("session-contract-gate.js"), false, "user layer must NOT include repo-only session-contract-gate.js");

	// Verify runtime parity outside any repository: normal work dir write succeeds (like Claude Code),
	// while 3-layer role session still blocks repo writes and dangerous commands.
	const { home, role, adk, repo, work } = createRoleAdkFixture(t);
	const rendered = renderMuseUserProfile(root, home, adk);
	const userPreCmd = rendered.hooks.PreToolUse[0].hooks[0].command;
	const env = { ...process.env, HOME: home, NAIA_ADK_ROOT: adk };

	const plainWorkWrite = parseDecision(runShellCommand(
		userPreCmd,
		JSON.stringify({
			session_id: "019daea9-5fd2-71c0-8dc6-0d9c92b0c2bf",
			hook_event_name: "PreToolUse",
			tool_name: "write_file",
			tool_use_id: "call_outside_repo_write",
			tool_input: { path: path.join(work, "job/prompt.md"), content: "# worker task\n" },
			cwd: work,
			permission_mode: "bypassPermissions",
		}),
		{ cwd: work, env },
	));
	if (plainWorkWrite !== null) {
		assert.notEqual(plainWorkWrite?.hookSpecificOutput?.permissionDecision, "deny");
	}

	const roleRepoWrite = parseDecision(runShellCommand(
		userPreCmd,
		JSON.stringify({
			session_id: "019daea9-5fd2-71c0-8dc6-0d9c92b0c2bf",
			hook_event_name: "PreToolUse",
			tool_name: "write_file",
			tool_use_id: "call_role_repo_write",
			tool_input: { path: path.join(repo, "src/app.js"), content: "console.log(99)" },
			cwd: role,
			permission_mode: "bypassPermissions",
		}),
		{ cwd: role, env },
	));
	assert.equal(roleRepoWrite?.hookSpecificOutput?.permissionDecision, "deny");
});

test("[Blocker 5 — Repo Layer] .muse/hooks.json matches .claude/settings.json across PreToolUse and all lifecycle events", (t) => {
	// Explicit exception map: `{ "<Event>:<script>": "<documented reason>" }`.
	// Empty because Muse 1.4.20 supports all 7 events in `.claude/settings.json` (including PostToolUse cascade-check.js).
	const REPO_LAYER_EXCEPTIONS = {};

	const claudeRepo = JSON.parse(fs.readFileSync(path.join(root, ".claude/settings.json"), "utf8"));
	const museRepo = JSON.parse(fs.readFileSync(path.join(root, ".muse/hooks.json"), "utf8"));

	const claudeEvents = Object.keys(claudeRepo.hooks || {}).sort();
	const museEvents = Object.keys(museRepo.hooks || {}).sort();
	assert.deepEqual(museEvents, claudeEvents, "repo-layer hook events must match .claude/settings.json");

	for (const eventName of claudeEvents) {
		const claudeSet = extractHookBasenames(claudeRepo.hooks[eventName], false);
		const museSet = extractHookBasenames(museRepo.hooks[eventName], true);
		for (const [key, reason] of Object.entries(REPO_LAYER_EXCEPTIONS)) {
			assert.ok(reason && reason.length >= 10, `exception ${key} requires an explicit reason`);
			const [excEvent, excScript] = key.split(":");
			if (excEvent === eventName) {
				claudeSet.delete(excScript);
				museSet.delete(excScript);
			}
		}
		assert.deepEqual(
			[...museSet].sort(),
			[...claudeSet].sort(),
			`repo-layer ${eventName} hook script set mismatch`,
		);
	}

	// Verify every `$root/...` script referenced in `.muse/hooks.json` exists on disk.
	for (const [eventName, groups] of Object.entries(museRepo.hooks)) {
		for (const group of groups) {
			if (eventName === "PreToolUse") {
				assert.equal(group.matcher, undefined, ".muse/hooks.json PreToolUse must be catch-all");
			}
			for (const hook of group.hooks) {
				assert.equal(hook.type, "command");
				assert.ok(hook.command.includes("muse-pretooluse-adapter.cjs"));
				for (const m of hook.command.matchAll(/\$root\/([^"\s)]+\.(?:js|cjs))/g)) {
					assert.ok(fs.existsSync(path.join(root, m[1])), `missing script in .muse/hooks.json (${eventName}): ${m[1]}`);
				}
			}
		}
	}

	// Smoke-run all 6 non-PreToolUse lifecycle event commands from `.muse/hooks.json` in an isolated repo.
	const { home, repo } = createRoleAdkFixture(t);
	const env = { ...process.env, HOME: home, NAIA_ADK_ROOT: root };
	const lifecyclePayloads = {
		SessionStart: { session_id: "019daea9-5fd2-71c0-8dc6-0d9c92b0c2bf", hook_event_name: "SessionStart", source: "startup", cwd: repo },
		UserPromptSubmit: { session_id: "019daea9-5fd2-71c0-8dc6-0d9c92b0c2bf", hook_event_name: "UserPromptSubmit", prompt: "inspect status", cwd: repo },
		PostToolUse: {
			session_id: "019daea9-5fd2-71c0-8dc6-0d9c92b0c2bf",
			hook_event_name: "PostToolUse",
			tool_name: "write_file",
			tool_use_id: "call_post_1",
			tool_input: { path: path.join(repo, "src/app.js"), content: "console.log(1);\n" },
			tool_response: { ok: true },
			cwd: repo,
		},
		PreCompact: { session_id: "019daea9-5fd2-71c0-8dc6-0d9c92b0c2bf", hook_event_name: "PreCompact", trigger: "auto", cwd: repo },
		PostCompact: { session_id: "019daea9-5fd2-71c0-8dc6-0d9c92b0c2bf", hook_event_name: "PostCompact", trigger: "auto", cwd: repo },
		Stop: { session_id: "019daea9-5fd2-71c0-8dc6-0d9c92b0c2bf", hook_event_name: "Stop", cwd: repo },
	};
	for (const [eventName, payload] of Object.entries(lifecyclePayloads)) {
		const cmd = museRepo.hooks[eventName][0].hooks[0].command;
		const out = parseDecision(runShellCommand(cmd, JSON.stringify(payload), { cwd: repo, env }));
		if (out !== null) {
			assert.notEqual(out.continue, false, `${eventName} unexpectedly halted: ${JSON.stringify(out)}`);
			assert.notEqual(out.decision, "block", `${eventName} unexpectedly blocked: ${JSON.stringify(out)}`);
		}
	}
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
