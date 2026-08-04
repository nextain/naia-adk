import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertSupportedBackendVersion, getBackendAdapter, inspectBackendLine, parseBackendLine } from "../helper/adapters.mjs";
import { prepareChildEnvironment, resolveExecutionCwd } from "../helper/backend-child-environment.mjs";
import { commandOptionsForProfile } from "../helper/execution-profile.mjs";
import { assertOwnerOnly, protectOwnerOnly } from "../helper/platform-security.mjs";

const roots = [];
const fakeBackendPath = fileURLToPath(new URL("./fixtures/fake-backend.mjs", import.meta.url));

afterEach(() => {
	while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

test("DSO-011 records cache evidence only when the provider reports complete integer usage", () => {
	const codex = inspectBackendLine({ backendId: "codex", attemptId: "attempt-cache-codex", lineNumber: 1, line: JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1200, cached_input_tokens: 900, output_tokens: 80 } }) });
	assert.deepEqual(codex.events.find((event) => event.kind === "prompt_cache_observed")?.safePayload, { backend: "codex", inputTokens: 1200, cacheReadInputTokens: 900, outputTokens: 80 });
	const claude = inspectBackendLine({ backendId: "claude", attemptId: "attempt-cache-claude", lineNumber: 1, line: JSON.stringify({ type: "result", subtype: "success", result: "ok", usage: { input_tokens: 2, cache_read_input_tokens: 17_618, cache_creation_input_tokens: 24_426, output_tokens: 60 } }) });
	assert.deepEqual(claude.events.find((event) => event.kind === "prompt_cache_observed")?.safePayload, { backend: "claude", inputTokens: 2, cacheReadInputTokens: 17_618, cacheCreationInputTokens: 24_426, outputTokens: 60 });
	const incompleteClaude = inspectBackendLine({ backendId: "claude", attemptId: "attempt-cache-claude-incomplete", lineNumber: 1, line: JSON.stringify({ type: "result", subtype: "success", result: "ok", usage: { input_tokens: 2, cache_read_input_tokens: 17_618, output_tokens: 60 } }) });
	assert.equal(incompleteClaude.events.some((event) => event.kind === "prompt_cache_observed"), false);
	const absent = inspectBackendLine({ backendId: "codex", attemptId: "attempt-cache-absent", lineNumber: 1, line: JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1200, output_tokens: 80 } }) });
	assert.equal(absent.events.some((event) => event.kind === "prompt_cache_observed"), false);
});

test("DSO-006 exposes independent Codex and Claude command contracts", () => {
	const probe = spawnSync(process.execPath, [fakeBackendPath, "exec"], { input: "probe", encoding: "utf8" });
	assert.equal(probe.status, 0, probe.stderr);
	assert.match(probe.stdout, /thread\.started/);
	const codex = getBackendAdapter("codex").command({ cwd: "/workspace", approvalPolicy: "never" });
	const claude = getBackendAdapter("claude").command({ cwd: "/workspace" });
	assert.deepEqual(codex.args.slice(0, 3), ["exec", "--json", "--ephemeral"]);
	assert.ok(codex.args.includes("--ignore-user-config"));
	assert.ok(codex.args.includes("--ignore-rules"));
	assert.ok(codex.args.includes("--strict-config"));
	assert.ok(codex.args.includes("project_doc_max_bytes=0"));
	assert.equal(codex.args[codex.args.indexOf("--config") + 1], 'approval_policy="never"');
	assert.equal(codex.args[codex.args.indexOf("--cd") + 1], "/workspace");
	const pinnedCodex = getBackendAdapter("codex").command({ cwd: "/workspace", approvalPolicy: "never", model: "gpt-5.4" });
	assert.equal(pinnedCodex.args[pinnedCodex.args.indexOf("--model") + 1], "gpt-5.4");
	assert.equal(pinnedCodex.args.includes('model_reasoning_effort="low"'), true);
	assert.ok(claude.args.includes("stream-json"));
	assert.ok(claude.args.includes("plan"));
	assert.ok(claude.args.includes("--safe-mode"));
	assert.equal(claude.args.includes("--setting-sources"), false);
	assert.equal(assertSupportedBackendVersion("codex", "codex-cli 0.146.0"), "0.146.0");
	assert.equal(assertSupportedBackendVersion("claude", "2.1.220 (Claude Code)"), "2.1.220");
	assert.throws(() => assertSupportedBackendVersion("codex", "codex-cli 0.145.0"), /not supported/);
	assert.throws(() => getBackendAdapter("missing"), /unsupported backend/);
	assert.throws(() => commandOptionsForProfile({ backendId: "codex", permissionProfileEpoch: "managed-1", authorizationMode: "managed", access: "workspace-write" }), /invalid execution profile/);
	assert.throws(() => commandOptionsForProfile({ backendId: "claude", permissionProfileEpoch: "claude-1", authorizationMode: "never", access: "workspace-write" }), /not supported/);
	assert.throws(() => resolveExecutionCwd("relative-workspace"), /must be absolute/);
});

test("DSO-011 disables provider-native project instruction discovery", () => {
	const codex = getBackendAdapter("codex").command({ cwd: "/workspace", approvalPolicy: "never" });
	assert.ok(codex.args.includes("--ignore-rules"));
	assert.ok(codex.args.includes("--strict-config"));
	assert.ok(codex.args.includes("project_doc_max_bytes=0"));
	const claude = getBackendAdapter("claude").command({ cwd: "/workspace", approvalPolicy: "never" });
	assert.ok(claude.args.includes("--safe-mode"));
	assert.equal(claude.args.includes("--setting-sources"), false);
});

test("DSO-006 normalizes provider streams without retaining model content", () => {
	const secret = "do-not-persist-this-prompt";
	const codex = parseBackendLine({ backendId: "codex", attemptId: "attempt-1", lineNumber: 1, line: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: secret } }) });
	const claude = parseBackendLine({ backendId: "claude", attemptId: "attempt-2", lineNumber: 1, line: JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: secret }] } }) });
	assert.deepEqual(codex.map((event) => event.kind), ["output_activity"]);
	assert.deepEqual(claude.map((event) => event.kind), ["output_activity"]);
	assert.ok(!JSON.stringify({ codex, claude }).includes(secret));
});

test("DSO-013 normalizes reasoning presence and tool phases without content", () => {
	const secret = "never-persist-provider-reasoning-or-tool-results";
	const codexReasoning = inspectBackendLine({
		backendId: "codex", attemptId: "attempt-trace-codex", lineNumber: 1,
		line: JSON.stringify({ type: "item.started", item: { id: "reasoning-1", type: "reasoning", text: secret } }),
	});
	assert.deepEqual(codexReasoning.events.map(({ kind, safePayload }) => ({ kind, safePayload })), [
		{ kind: "phase_changed", safePayload: { phase: "planning" } },
	]);
	const codexRead = inspectBackendLine({
		backendId: "codex", attemptId: "attempt-trace-codex", lineNumber: 2,
		line: JSON.stringify({ type: "item.started", item: { id: "tool-1", type: "file_read", path: `/tmp/${secret}` } }),
	});
	assert.deepEqual(codexRead.events.map(({ kind, safePayload }) => ({ kind, safePayload })), [
		{ kind: "phase_changed", safePayload: { phase: "reading" } },
		{ kind: "tool_started", safePayload: { toolCategory: "file_read" } },
	]);
	for (const [lineNumber, type, phase, toolCategory] of [
		[3, "file_change", "editing", "file_edit"],
		[4, "web_search", "reading", "network"],
		[5, "command_execution", "executing", "command"],
		[6, "mcp_tool_call", null, "other"],
	]) {
		const event = inspectBackendLine({
			backendId: "codex", attemptId: "attempt-trace-codex", lineNumber,
			line: JSON.stringify({ type: "item.started", item: { id: `tool-${lineNumber}`, type, text: secret } }),
		});
		const expected = phase ? [
			{ kind: "phase_changed", safePayload: { phase } },
			{ kind: "tool_started", safePayload: { toolCategory } },
		] : [{ kind: "tool_started", safePayload: { toolCategory } }];
		assert.deepEqual(event.events.map(({ kind, safePayload }) => ({ kind, safePayload })), expected);
		assert.equal(JSON.stringify(event).includes(secret), false);
	}

	const adapterState = {};
	const claudeStart = inspectBackendLine({
		backendId: "claude", attemptId: "attempt-trace-claude", lineNumber: 1, adapterState,
		line: JSON.stringify({ type: "assistant", message: { content: [
			{ type: "thinking", thinking: secret },
			{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: `/tmp/${secret}` } },
		] } }),
	});
	assert.deepEqual(claudeStart.events.slice(0, 3).map(({ kind, safePayload }) => ({ kind, safePayload })), [
		{ kind: "phase_changed", safePayload: { phase: "planning" } },
		{ kind: "phase_changed", safePayload: { phase: "reading" } },
		{ kind: "tool_started", safePayload: { toolCategory: "file_read" } },
	]);
	const claudeFinish = inspectBackendLine({
		backendId: "claude", attemptId: "attempt-trace-claude", lineNumber: 2, adapterState,
		line: JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: secret }] } }),
	});
	assert.deepEqual(claudeFinish.events.map(({ kind, safePayload }) => ({ kind, safePayload })), [
		{ kind: "tool_finished", safePayload: { toolCategory: "file_read" } },
	]);
	const claudeWeb = inspectBackendLine({
		backendId: "claude", attemptId: "attempt-trace-claude", lineNumber: 3, adapterState,
		line: JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_2", name: "WebSearch", input: { query: secret } }] } }),
	});
	assert.deepEqual(claudeWeb.events.slice(0, 2).map(({ kind, safePayload }) => ({ kind, safePayload })), [
		{ kind: "phase_changed", safePayload: { phase: "reading" } },
		{ kind: "tool_started", safePayload: { toolCategory: "network" } },
	]);
	assert.equal(JSON.stringify({ codexReasoning, codexRead, claudeStart, claudeFinish, claudeWeb }).includes(secret), false);
});

test("DSO-006 never promotes an unknown provider result to success", () => {
	const codex = inspectBackendLine({ backendId: "codex", attemptId: "attempt-unknown-codex", lineNumber: 1, line: JSON.stringify({ type: "turn.completed", status: "unknown" }) });
	const claude = inspectBackendLine({ backendId: "claude", attemptId: "attempt-unknown-claude", lineNumber: 1, line: JSON.stringify({ type: "result", subtype: "unknown", result: "must-not-deliver" }) });
	assert.equal(codex.outcome, null);
	assert.equal(claude.outcome, null);
	assert.equal(claude.transientResult, null);
});

test("DSO-005 creates a private minimal child environment and copies only provider auth", () => {
	const root = mkdtempSync(join(tmpdir(), "naia-child-env-"));
	roots.push(root);
	const authRoot = join(root, "auth-source");
	mkdirSync(join(authRoot, ".codex"), { recursive: true });
	mkdirSync(join(authRoot, ".claude"), { recursive: true });
	writeFileSync(join(authRoot, ".codex", "auth.json"), "codex-auth", { mode: 0o600 });
	writeFileSync(join(authRoot, ".codex", "config.toml"), "must-not-copy", { mode: 0o600 });
	writeFileSync(join(authRoot, ".claude", ".credentials.json"), "claude-auth", { mode: 0o600 });
	writeFileSync(join(authRoot, ".claude", "settings.json"), "must-not-copy", { mode: 0o600 });
	for (const directory of [authRoot, join(authRoot, ".codex"), join(authRoot, ".claude")]) protectOwnerOnly(directory, "directory", "test auth directory");
	for (const file of [join(authRoot, ".codex", "auth.json"), join(authRoot, ".claude", ".credentials.json")]) protectOwnerOnly(file, "file", "test auth file");
	const parentEnv = { PATH: `${process.env.PATH}${delimiter}${join(root, "workspace/node_modules/.bin")}${delimiter}.`, LANG: "C.UTF-8", DISCORD_TOKEN: "discord-secret", CODEX_API_KEY: "codex-key", OPENAI_API_KEY: "wrong-key" };
	const codex = prepareChildEnvironment({ backendId: "codex", attemptId: "codex-attempt", runtimeRoot: join(root, "runtime"), parentEnv, authRoot });
	const codexOauth = prepareChildEnvironment({ backendId: "codex", attemptId: "codex-oauth-attempt", runtimeRoot: join(root, "runtime"), parentEnv: { PATH: process.env.PATH }, authRoot });
	const claude = prepareChildEnvironment({ backendId: "claude", attemptId: "claude-attempt", runtimeRoot: join(root, "runtime"), parentEnv, authRoot });
	assert.equal(codex.env.DISCORD_TOKEN, undefined);
	assert.equal(codex.env.OPENAI_API_KEY, undefined);
	assert.equal(codex.env.CODEX_API_KEY, "codex-key");
	assert.ok(!codex.env.PATH.includes("node_modules"));
	assert.ok(!codex.env.PATH.split(delimiter).includes("."));
	if (process.platform === "win32") assert.doesNotThrow(() => assertOwnerOnly(codex.childHome, "directory", "child home"));
	else assert.equal(statSync(codex.childHome).mode & 0o777, 0o700);
	assert.deepEqual(readdirSync(join(codex.childHome, ".codex")).sort(), []);
	assert.deepEqual(readdirSync(join(codexOauth.childHome, ".codex")).sort(), ["auth.json"]);
	assert.equal(readFileSync(join(codexOauth.childHome, ".codex", "auth.json"), "utf8"), "codex-auth");
	assert.deepEqual(readdirSync(join(claude.childHome, ".claude")).sort(), [".credentials.json"]);
});

test("DSO-005 accepts the official Windows Codex sandbox read ACL while keeping the child copy owner-only", (context) => {
	if (process.platform !== "win32") return context.skip("Windows ACL contract");
	const root = mkdtempSync(join(tmpdir(), "naia-windows-codex-auth-"));
	roots.push(root);
	const authRoot = join(root, "auth-source");
	mkdirSync(join(authRoot, ".codex"), { recursive: true });
	const authPath = join(authRoot, ".codex", "auth.json");
	writeFileSync(authPath, "codex-auth");
	const aclScript = String.raw`
$ErrorActionPreference='Stop'
$path=$env:NAIA_TEST_AUTH_PATH
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$sandbox=([Security.Principal.NTAccount]::new($env:COMPUTERNAME,'CodexSandboxUsers')).Translate([Security.Principal.SecurityIdentifier])
$acl=Get-Acl -LiteralPath $path
$acl.SetOwner($identity.User)
$acl.SetAccessRuleProtection($true,$false)
foreach($rule in @($acl.Access)){[void]$acl.RemoveAccessRuleSpecific($rule)}
function Add-Rule($sid,$rights){
	$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,$rights,[Security.AccessControl.InheritanceFlags]::None,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
	[void]$acl.AddAccessRule($rule)
}
Add-Rule $identity.User ([Security.AccessControl.FileSystemRights]::FullControl)
Add-Rule ([Security.Principal.SecurityIdentifier]'S-1-5-18') ([Security.AccessControl.FileSystemRights]::FullControl)
Add-Rule ([Security.Principal.SecurityIdentifier]'S-1-5-32-544') ([Security.AccessControl.FileSystemRights]::FullControl)
Add-Rule $sandbox ([Security.AccessControl.FileSystemRights]::ReadAndExecute)
Set-Acl -LiteralPath $path -AclObject $acl`;
	const powershell = join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
	const configured = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", aclScript], { encoding: "utf8", env: { ...process.env, NAIA_TEST_AUTH_PATH: authPath } });
	if (configured.status !== 0 && /CodexSandboxUsers/i.test(configured.stderr)) return context.skip("Codex sandbox group is unavailable");
	assert.equal(configured.status, 0, configured.stderr);
	const prepared = prepareChildEnvironment({ backendId: "codex", attemptId: "official-windows-acl", runtimeRoot: join(root, "runtime"), parentEnv: { PATH: process.env.PATH }, authRoot });
	assert.equal(prepared.authenticationPrepared, true);
	assert.doesNotThrow(() => assertOwnerOnly(join(prepared.childHome, ".codex", "auth.json"), "file", "child Codex authentication"));
});

test("DSO-005 rejects insecure auth permissions and cleans the partial child home", () => {
	const root = mkdtempSync(join(tmpdir(), "naia-insecure-auth-"));
	roots.push(root);
	const authRoot = join(root, "auth-source");
	mkdirSync(join(authRoot, ".codex"), { recursive: true });
	writeFileSync(join(authRoot, ".codex", "auth.json"), "unsafe", { mode: 0o644 });
	const runtimeRoot = join(root, "runtime");
	assert.throws(() => prepareChildEnvironment({ backendId: "codex", attemptId: "bad-auth", runtimeRoot, parentEnv: { PATH: process.env.PATH }, authRoot }), /private|owner-only|permissions/);
	assert.deepEqual(readdirSync(join(runtimeRoot, "children")), []);
});
