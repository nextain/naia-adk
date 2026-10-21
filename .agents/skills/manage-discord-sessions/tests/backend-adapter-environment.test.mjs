import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertSupportedBackendVersion, getBackendAdapter, inspectBackendLine, parseBackendLine, readOnlyBackendOptions } from "../helper/adapters.mjs";
import { defaultRuntimeRoot, prepareChildEnvironment, resolveExecutionCwd } from "../helper/backend-child-environment.mjs";
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
	const controlCodex = getBackendAdapter("codex").command({ cwd: "/workspace", approvalPolicy: "never", costProfile: "control" });
	assert.equal(controlCodex.args.includes('model_reasoning_effort="medium"'), true);
	const networkCodex = getBackendAdapter("codex").command({ cwd: "/workspace", sandbox: "workspace-write", approvalPolicy: "never", networkAccess: true });
	assert.equal(networkCodex.args.includes("sandbox_workspace_write.network_access=true"), true);
	const credentialCodex = getBackendAdapter("codex").command({ cwd: "/workspace", childHome: "/runtime/children/attempt", sandbox: "workspace-write", approvalPolicy: "never", networkAccess: true });
	assert.equal(credentialCodex.args[credentialCodex.args.indexOf("--add-dir") + 1], "/runtime/children/attempt");
	assert.equal(networkCodex.args.includes("--add-dir"), false);
	assert.throws(() => getBackendAdapter("codex").command({ cwd: "/workspace", sandbox: "read-only", approvalPolicy: "never", networkAccess: true }), /requires writable access/);
	const trustedCodex = getBackendAdapter("codex").command({ cwd: "/workspace", sandbox: "danger-full-access", approvalPolicy: "never", networkAccess: true });
	assert.deepEqual(trustedCodex.args.slice(trustedCodex.args.indexOf("--sandbox"), trustedCodex.args.indexOf("--sandbox") + 2), ["--sandbox", "danger-full-access"]);
	assert.equal(trustedCodex.args.includes("sandbox_workspace_write.network_access=true"), false);
	assert.throws(() => getBackendAdapter("codex").command({ cwd: "/workspace", approvalPolicy: "never", costProfile: "unknown" }), /unsupported Codex cost profile/);
	assert.ok(claude.args.includes("stream-json"));
	assert.ok(claude.args.includes("plan"));
	assert.ok(claude.args.includes("--safe-mode"));
	const mutableClaude = getBackendAdapter("claude").command({ cwd: "/workspace", childHome: "/runtime/children/attempt", allowedPaths: ["/workspace", "/workspace/sibling"], permissionMode: "bypassPermissions", model: "claude-sonnet-4-5" });
	assert.ok(mutableClaude.args.includes("--dangerously-skip-permissions"));
	assert.equal(mutableClaude.args[mutableClaude.args.indexOf("--model") + 1], "claude-sonnet-4-5");
	assert.ok(mutableClaude.args.includes("/workspace/sibling"));
	assert.ok(mutableClaude.args.includes("/runtime/children/attempt"));
	assert.equal(claude.args.includes("--setting-sources"), false);
	assert.equal(assertSupportedBackendVersion("codex", "codex-cli 0.146.0"), "0.146.0");
	assert.equal(assertSupportedBackendVersion("claude", "2.1.220 (Claude Code)"), "2.1.220");
	assert.throws(() => assertSupportedBackendVersion("codex", "codex-cli 0.145.0"), /not supported/);
	assert.throws(() => getBackendAdapter("missing"), /unsupported backend/);
	assert.throws(() => commandOptionsForProfile({ backendId: "codex", permissionProfileEpoch: "managed-1", authorizationMode: "managed", access: "workspace-write" }), /invalid execution profile/);
	assert.equal(commandOptionsForProfile({ backendId: "claude", permissionProfileEpoch: "claude-1", authorizationMode: "never", access: "workspace-write" }).permissionMode, "bypassPermissions");
	// The Grok CLI reads a single-turn prompt from a real path. `--prompt-file -`
	// opens a file literally named `-` and exits before reading anything.
	assert.throws(() => getBackendAdapter("grok").command({ cwd: "/workspace" }), /staged prompt file/);
	const grok = getBackendAdapter("grok").command({ cwd: "/workspace", promptPath: "/runtime/children/attempt/prompt.txt" });
	assert.deepEqual(grok.args.slice(0, 11), ["--output-format", "streaming-messages-json", "--permission-mode", "plan", "--sandbox", "read-only", "--cwd", "/workspace", "--verbatim", "--prompt-file", "/runtime/children/attempt/prompt.txt"]);
	assert.equal(grok.args.includes("-"), false);
	assert.equal(grok.args[grok.args.indexOf("--reasoning-effort") + 1], "medium");
	// No model default is baked in; an unset config leaves the CLI's own choice.
	assert.equal(grok.args.includes("--model"), false);
	assert.equal(grok.args.includes("--no-subagents"), false);
	assert.equal(getBackendAdapter("grok").promptDelivery, "file");
	for (const backendId of ["codex", "claude", "opencode"]) assert.equal(getBackendAdapter(backendId).promptDelivery, undefined);
	const grokControl = getBackendAdapter("grok").command({ cwd: "/workspace", promptPath: "/runtime/children/attempt/prompt.txt", costProfile: "control", permissionMode: "bypassPermissions", model: "grok-4.6" });
	assert.equal(grokControl.args[grokControl.args.indexOf("--reasoning-effort") + 1], "high");
	assert.equal(grokControl.args[grokControl.args.indexOf("--model") + 1], "grok-4.6");
	assert.ok(grokControl.args.includes("bypassPermissions"));
	assert.deepEqual(grokControl.args.slice(grokControl.args.indexOf("--sandbox"), grokControl.args.indexOf("--sandbox") + 2), ["--sandbox", "workspace"]);
	const grokEconomy = getBackendAdapter("grok").command({ cwd: "/workspace", promptPath: "/runtime/children/attempt/prompt.txt", costProfile: "economy" });
	assert.equal(grokEconomy.args[grokEconomy.args.indexOf("--reasoning-effort") + 1], "low");
	assert.throws(() => getBackendAdapter("grok").command({ cwd: "/workspace", promptPath: "/runtime/children/attempt/prompt.txt", costProfile: "unknown" }), /unsupported Grok cost profile/);
	const grokWorkspaceOptions = commandOptionsForProfile({ backendId: "grok", permissionProfileEpoch: "grok-1", authorizationMode: "never", access: "workspace-write" });
	assert.deepEqual(grokWorkspaceOptions, { permissionMode: "bypassPermissions", sandbox: "workspace", approvalPolicy: "never" });
	const grokReadOnlyOptions = commandOptionsForProfile({ backendId: "grok", permissionProfileEpoch: "grok-2", authorizationMode: "never", access: "read-only" });
	assert.equal(grokReadOnlyOptions.sandbox, "read-only");
	assert.equal(readOnlyBackendOptions("grok", { permissionMode: "plan" }), false, "plan alone is not a sandbox claim");
	assert.equal(readOnlyBackendOptions("grok", grokReadOnlyOptions), true);
	assert.throws(() => getBackendAdapter("grok").command({ cwd: "/workspace", promptPath: "/runtime/children/attempt/prompt.txt", permissionMode: "plan", sandbox: "workspace" }), /requires read-only sandbox/);
	assert.throws(() => getBackendAdapter("grok").command({ cwd: "/workspace", promptPath: "/runtime/children/attempt/prompt.txt", permissionMode: "bypassPermissions", sandbox: "read-only" }), /requires workspace sandbox/);
	assert.equal(assertSupportedBackendVersion("grok", "grok 1.0.13"), "1.0.13");
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

test("DSO-012 pins Claude plan tools and MCP configuration", () => {
	const plan = getBackendAdapter("claude").command({ cwd: "/workspace", approvalPolicy: "never" });
	const toolsIndex = plan.args.indexOf("--tools");
	assert.deepEqual(plan.args.slice(toolsIndex, toolsIndex + 2), ["--tools", "Read,Glob,Grep"]);
	const strictMcpIndex = plan.args.indexOf("--strict-mcp-config");
	assert.deepEqual(plan.args.slice(strictMcpIndex, strictMcpIndex + 3), ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']);
	for (const escapeFlag of ["--allowedTools", "--allowed-tools", "--settings", "--setting-sources", "--dangerously-skip-permissions"]) {
		assert.equal(plan.args.includes(escapeFlag), false, `plan argv must not include ${escapeFlag}`);
	}
	const writable = getBackendAdapter("claude").command({ cwd: "/workspace", permissionMode: "bypassPermissions" });
	assert.equal(writable.args.includes("--tools"), false);
	assert.equal(writable.args.includes("--strict-mcp-config"), false);
	assert.equal(writable.args.includes("--mcp-config"), false);
});

test("DSO-006 normalizes provider streams without retaining model content", () => {
	const secret = "fake-do-not-persist-this-prompt";
	const codex = parseBackendLine({ backendId: "codex", attemptId: "attempt-1", lineNumber: 1, line: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: secret } }) });
	const claude = parseBackendLine({ backendId: "claude", attemptId: "attempt-2", lineNumber: 1, line: JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: secret }] } }) });
	assert.deepEqual(codex.map((event) => event.kind), ["output_activity"]);
	assert.deepEqual(claude.map((event) => event.kind), ["output_activity"]);
	assert.ok(!JSON.stringify({ codex, claude }).includes(secret));
});

test("DSO-001 records only explicit provider tool categories and keeps unknown tools generic", () => {
	const codexKnown = parseBackendLine({
		backendId: "codex", attemptId: "attempt-tool-1", lineNumber: 1,
		line: JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "private" } }),
	});
	const codexUnknown = parseBackendLine({
		backendId: "codex", attemptId: "attempt-tool-2", lineNumber: 1,
		line: JSON.stringify({ type: "item.started", item: { type: "mcp_tool_call", name: "ReadPrivateFile" } }),
	});
	const claudeKnown = parseBackendLine({
		backendId: "claude", attemptId: "attempt-tool-3", lineNumber: 1,
		line: JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/private" } }] } }),
	});
	assert.deepEqual(codexKnown[0].safePayload, { toolCategory: "command_execution" });
	assert.deepEqual(codexUnknown[0].safePayload, {});
	assert.deepEqual(claudeKnown[0].safePayload, { toolCategory: "read" });
	assert.equal(JSON.stringify({ codexKnown, codexUnknown, claudeKnown }).includes("ReadPrivateFile"), false);
	assert.equal(JSON.stringify({ codexKnown, codexUnknown, claudeKnown }).includes("/private"), false);
});

test("DSO-001 maps OpenCode tool names without throwing on an unmapped one", () => {
	// parseOpencode called an undefined `toolCategory`, so the first tool line
	// of a real OpenCode job threw inside the stream reader and terminated the
	// attempt as internal_error. Every message shape has to survive parsing.
	const read = inspectBackendLine({ backendId: "opencode", attemptId: "attempt-oc", lineNumber: 1, line: JSON.stringify({ type: "tool_use", part: { type: "tool", tool: "read", state: { status: "completed" } } }) });
	assert.deepEqual(read.events.map((event) => ({ kind: event.kind, safePayload: event.safePayload })), [{ kind: "tool_finished", safePayload: { toolCategory: "read" } }]);
	const bash = inspectBackendLine({ backendId: "opencode", attemptId: "attempt-oc", lineNumber: 2, line: JSON.stringify({ type: "tool_use", part: { type: "tool", tool: "bash", state: { status: "running" } } }) });
	assert.deepEqual(bash.events[0], { ...bash.events[0], kind: "tool_started", safePayload: { toolCategory: "command_execution" } });
	for (const tool of ["todowrite", "task", "somethingelse"]) {
		const unknown = inspectBackendLine({ backendId: "opencode", attemptId: "attempt-oc", lineNumber: 3, line: JSON.stringify({ type: "tool_use", part: { type: "tool", tool, state: { status: "completed" } } }) });
		assert.deepEqual(unknown.events[0].safePayload, {}, `${tool} must stay generic rather than invent a category`);
	}
	// The whole stream shape a real run produces must parse without throwing.
	for (const line of [
		JSON.stringify({ type: "step_start" }),
		JSON.stringify({ type: "text", part: { text: "working" } }),
		JSON.stringify({ type: "tool_use", part: { type: "tool", tool: "webfetch", state: { status: "error" } } }),
		JSON.stringify({ type: "step_finish" }),
	]) assert.doesNotThrow(() => inspectBackendLine({ backendId: "opencode", attemptId: "attempt-oc", lineNumber: 4, line }));
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
	mkdirSync(join(authRoot, ".local", "share", "com.vercel.cli"), { recursive: true });
	mkdirSync(join(authRoot, ".local", "share", "opencode"), { recursive: true });
	mkdirSync(join(authRoot, ".config", "opencode"), { recursive: true });
	mkdirSync(join(authRoot, ".ssh"), { recursive: true });
	mkdirSync(join(authRoot, ".config", "gcloud", "logs"), { recursive: true });
	mkdirSync(join(authRoot, ".azure", "cache"), { recursive: true });
	writeFileSync(join(authRoot, ".codex", "auth.json"), "codex-auth", { mode: 0o600 });
	writeFileSync(join(authRoot, ".codex", "config.toml"), "must-not-copy", { mode: 0o600 });
	writeFileSync(join(authRoot, ".claude", ".credentials.json"), "claude-auth", { mode: 0o600 });
	writeFileSync(join(authRoot, ".claude", "settings.json"), "must-not-copy", { mode: 0o600 });
	writeFileSync(join(authRoot, ".local", "share", "com.vercel.cli", "auth.json"), "vercel-auth", { mode: 0o600 });
	writeFileSync(join(authRoot, ".local", "share", "opencode", "auth.json"), "opencode-auth", { mode: 0o600 });
	const opencodeConfigSource = join(authRoot, ".config", "opencode", "opencode.jsonc");
	writeFileSync(opencodeConfigSource, JSON.stringify({ provider: { "azure-foundry": { options: { baseURL: "https://example.invalid" } } }, model: "azure-foundry/deepseek-v4-pro", small_model: "azure-foundry/deepseek-v4-pro" }), { mode: 0o644 });
	// The copy path deliberately accepts a group-readable provider config, so
	// the fixture must actually be group-readable regardless of umask.
	chmodSync(opencodeConfigSource, 0o644);
	writeFileSync(join(authRoot, ".ssh", "id_ed25519"), "ssh-auth", { mode: 0o600 });
	writeFileSync(join(authRoot, ".config", "gcloud", "credentials.db"), "gcloud-auth", { mode: 0o600 });
	writeFileSync(join(authRoot, ".config", "gcloud", "logs", "large.log"), "must-not-copy", { mode: 0o600 });
	writeFileSync(join(authRoot, ".azure", "azureProfile.json"), "azure-auth", { mode: 0o600 });
	writeFileSync(join(authRoot, ".azure", "cache", "large.cache"), "must-not-copy", { mode: 0o600 });
	for (const directory of [authRoot, join(authRoot, ".codex"), join(authRoot, ".claude"), join(authRoot, ".local"), join(authRoot, ".local", "share"), join(authRoot, ".local", "share", "com.vercel.cli"), join(authRoot, ".local", "share", "opencode"), join(authRoot, ".config"), join(authRoot, ".config", "opencode"), join(authRoot, ".ssh")]) protectOwnerOnly(directory, "directory", "test auth directory");
	for (const file of [join(authRoot, ".codex", "auth.json"), join(authRoot, ".claude", ".credentials.json"), join(authRoot, ".local", "share", "com.vercel.cli", "auth.json"), join(authRoot, ".local", "share", "opencode", "auth.json"), join(authRoot, ".ssh", "id_ed25519")]) protectOwnerOnly(file, "file", "test auth file");
	const parentEnv = { PATH: `${process.env.PATH}${delimiter}${join(root, "workspace/node_modules/.bin")}${delimiter}.`, LANG: "C.UTF-8", DISCORD_TOKEN: "discord-secret", CODEX_API_KEY: "codex-key", OPENAI_API_KEY: "wrong-key" };
	const codex = prepareChildEnvironment({ backendId: "codex", attemptId: "codex-attempt", runtimeRoot: join(root, "runtime"), parentEnv, authRoot });
	const codexOauth = prepareChildEnvironment({ backendId: "codex", attemptId: "codex-oauth-attempt", runtimeRoot: join(root, "runtime"), parentEnv: { PATH: process.env.PATH }, authRoot });
	const claude = prepareChildEnvironment({ backendId: "claude", attemptId: "claude-attempt", runtimeRoot: join(root, "runtime"), parentEnv, authRoot });
	const codexVercel = prepareChildEnvironment({ backendId: "codex", attemptId: "codex-vercel-attempt", runtimeRoot: join(root, "runtime"), parentEnv, authRoot, credentialProfiles: ["vercel"] });
	const codexSsh = prepareChildEnvironment({ backendId: "codex", attemptId: "codex-ssh-attempt", runtimeRoot: join(root, "runtime"), parentEnv, authRoot, credentialProfiles: ["ssh-naia-corp"] });
	const codexCloud = prepareChildEnvironment({ backendId: "codex", attemptId: "codex-cloud-attempt", runtimeRoot: join(root, "runtime"), parentEnv, authRoot, credentialProfiles: ["gcloud", "az"] });
	const claudeCloud = prepareChildEnvironment({ backendId: "claude", attemptId: "claude-cloud-attempt", runtimeRoot: join(root, "runtime"), parentEnv, authRoot, credentialProfiles: ["gcloud", "az"] });
	const opencodeCloud = prepareChildEnvironment({ backendId: "opencode", attemptId: "opencode-cloud-attempt", runtimeRoot: join(root, "runtime"), parentEnv, authRoot, credentialProfiles: ["gcloud", "az"] });
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
	assert.equal(readFileSync(join(codexVercel.env.XDG_DATA_HOME, "com.vercel.cli", "auth.json"), "utf8"), "vercel-auth");
	assert.equal(codexVercel.env.VERCEL_TELEMETRY_DISABLED, "1");
	assert.equal(readFileSync(join(codexSsh.childHome, ".ssh", "id_ed25519"), "utf8"), "ssh-auth");
	assert.equal(statSync(join(codexSsh.childHome, ".ssh", "id_ed25519")).mode & 0o777, 0o600);
	assert.equal(codexSsh.env.TMPDIR, "/tmp");
	assert.equal(readFileSync(join(codexCloud.childHome, ".config", "gcloud", "credentials.db"), "utf8"), "gcloud-auth");
	assert.equal(readFileSync(join(codexCloud.childHome, ".azure", "azureProfile.json"), "utf8"), "azure-auth");
	assert.equal(codexCloud.env.CLOUDSDK_CONFIG, join(codexCloud.childHome, ".config", "gcloud"));
	assert.equal(codexCloud.env.AZURE_CONFIG_DIR, join(codexCloud.childHome, ".azure"));
	assert.equal(readdirSync(join(codexCloud.childHome, ".config", "gcloud")).includes("logs"), false);
	assert.equal(readdirSync(join(codexCloud.childHome, ".azure")).includes("cache"), false);
	assert.equal(readFileSync(join(claudeCloud.childHome, ".config", "gcloud", "credentials.db"), "utf8"), "gcloud-auth");
	assert.equal(readFileSync(join(opencodeCloud.childHome, ".azure", "azureProfile.json"), "utf8"), "azure-auth");
	assert.equal(readFileSync(join(opencodeCloud.env.XDG_CONFIG_HOME, "opencode", "opencode.jsonc"), "utf8"), JSON.stringify({ provider: { "azure-foundry": { options: { baseURL: "https://example.invalid" } } }, model: "azure-foundry/deepseek-v4-pro", small_model: "azure-foundry/deepseek-v4-pro" }));
	assert.equal(readFileSync(join(opencodeCloud.env.XDG_DATA_HOME, "opencode", "auth.json"), "utf8"), "opencode-auth");
	assert.equal(statSync(join(opencodeCloud.env.XDG_CONFIG_HOME, "opencode", "opencode.jsonc")).mode & 0o777, 0o600);
	assert.equal(opencodeCloud.authenticationPrepared, true);
	assert.throws(() => prepareChildEnvironment({ backendId: "codex", attemptId: "bad-profile", runtimeRoot: join(root, "runtime"), parentEnv, authRoot, credentialProfiles: ["unknown"] }), /unsupported credential profile/);
});

test("DSO-005 canonicalizes only the automatic temp root and rejects a user runtime symlink", () => {
	if (process.platform === "win32") return;
	const root = mkdtempSync(join(tmpdir(), "naia-runtime-root-"));
	roots.push(root);
	const automaticTarget = join(root, "real-temp");
	mkdirSync(automaticTarget);
	const automaticLink = join(root, "linked-temp");
	symlinkSync(automaticTarget, automaticLink, "dir");
	const uid = typeof process.getuid === "function" ? process.getuid() : "user";
	assert.equal(defaultRuntimeRoot({}, automaticLink), join(realpathSync(automaticTarget), `naia-adk-${uid}`, "messenger-sessions"));

	const userTarget = join(root, "user-runtime-target");
	mkdirSync(userTarget);
	const userLink = join(root, "user-runtime-link");
	symlinkSync(userTarget, userLink, "dir");
	assert.throws(
		() => prepareChildEnvironment({ backendId: "codex", attemptId: "symlink-runtime", runtimeRoot: userLink, parentEnv: { PATH: process.env.PATH }, authRoot: root }),
		/private path contains a symbolic link/,
	);
});

test("DSO-012 gives an OpenCode read-only child a real tool denial configuration", () => {
	const root = mkdtempSync(join(tmpdir(), "naia-opencode-readonly-"));
	roots.push(root);
	const authRoot = join(root, "auth-source");
	mkdirSync(join(authRoot, ".config", "opencode"), { recursive: true });
	mkdirSync(join(authRoot, ".local", "share", "opencode"), { recursive: true });
	const providerConfig = join(authRoot, ".config", "opencode", "opencode.jsonc");
	// The source is JSONC and intentionally contains hostile agent/tool/MCP
	// entries. Provider/model resolution survives; those owner-controlled
	// execution surfaces must not enter a read-only child.
	const providerConfigSource = `{
		// provider and model fields are the only copied resolution inputs
		"provider": { "azure-foundry": { "options": { "baseURL": "https://example.invalid" }, "models": { "deepseek-v4-pro": { "name": "DeepSeek V4 Pro" } } } },
		"model": "azure-foundry/deepseek-v4-pro",
		"small_model": "azure-foundry/deepseek-v4-pro",
		"agent": { "build": { "permission": { "*": "allow", "bash": "allow", "edit": "allow", "write": "allow", "task": "allow" }, "prompt": "hostile-agent-secret" } },
		"default_agent": "build",
		"tools": { "*": true, "bash": true, "edit": true, "write": true, "task": true },
		"mcp": { "hostile": { "type": "remote", "url": "https://example.invalid/mcp", "headers": { "Authorization": "hostile-mcp-secret" } } },
		"plugin": ["hostile-plugin-secret"],
		"literal": "slashes // and delimiters ,} stay inside this string",
	}
// valid EOF comment`;
	writeFileSync(providerConfig, providerConfigSource, { mode: 0o644 });
	chmodSync(providerConfig, 0o644);
	writeFileSync(join(authRoot, ".local", "share", "opencode", "auth.json"), "opencode-auth", { mode: 0o600 });
	for (const directory of [authRoot, join(authRoot, ".config"), join(authRoot, ".config", "opencode"), join(authRoot, ".local"), join(authRoot, ".local", "share"), join(authRoot, ".local", "share", "opencode")]) protectOwnerOnly(directory, "directory", "test auth directory");
	protectOwnerOnly(join(authRoot, ".local", "share", "opencode", "auth.json"), "file", "test auth file");
	const parentEnv = { PATH: process.env.PATH };
	const runtimeRoot = join(root, "runtime");
	const readOnly = prepareChildEnvironment({ backendId: "opencode", attemptId: "opencode-read-only", runtimeRoot, parentEnv, authRoot, readOnly: true });
	const writable = prepareChildEnvironment({ backendId: "opencode", attemptId: "opencode-writable", runtimeRoot, parentEnv, authRoot, readOnly: false });
	// `opencode run` has no permission flag, so configuration is the only
	// denial surface. Verified against opencode 1.18.26 with
	// `opencode debug config`: the overlay alone loses to a workspace
	// opencode.json, and the disable flag alone loses to the operator's global
	// config, so both are required.
	assert.equal(typeof readOnly.env.OPENCODE_CONFIG, "string");
	assert.equal(readOnly.env.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
	assert.deepEqual(JSON.parse(readFileSync(readOnly.env.OPENCODE_CONFIG, "utf8")), {
		permission: { "*": "deny", read: "allow", glob: "allow", grep: "allow", list: "allow" },
		agent: { build: { mode: "primary", permission: { "*": "deny", read: "allow", glob: "allow", grep: "allow", list: "allow" } } },
		plugin: [],
	});
	if (process.platform === "win32") assert.doesNotThrow(() => assertOwnerOnly(readOnly.env.OPENCODE_CONFIG, "file", "read-only overlay"));
	else assert.equal(statSync(readOnly.env.OPENCODE_CONFIG).mode & 0o777, 0o600);
	assert.equal(readOnly.env.OPENCODE_CONFIG.startsWith(readOnly.childHome), true);
	const sanitizedProvider = readFileSync(join(readOnly.env.XDG_CONFIG_HOME, "opencode", "opencode.jsonc"), "utf8");
	assert.deepEqual(JSON.parse(sanitizedProvider), {
		provider: { "azure-foundry": { options: { baseURL: "https://example.invalid" }, models: { "deepseek-v4-pro": { name: "DeepSeek V4 Pro" } } } },
		model: "azure-foundry/deepseek-v4-pro",
		small_model: "azure-foundry/deepseek-v4-pro",
	});
	for (const forbidden of ["hostile-agent-secret", "hostile-mcp-secret", "hostile-plugin-secret", "default_agent", "tools", "mcp", "plugin", "permission"]) assert.equal(sanitizedProvider.includes(forbidden), false, `sanitized provider config retained ${forbidden}`);
	assert.equal(readFileSync(join(writable.env.XDG_CONFIG_HOME, "opencode", "opencode.jsonc"), "utf8"), providerConfigSource);
	assert.equal(writable.env.OPENCODE_CONFIG, undefined);
	assert.equal(writable.env.OPENCODE_DISABLE_PROJECT_CONFIG, undefined);
	const opencodePathProbe = spawnSync(process.platform === "win32" ? "where" : "which", ["opencode"], {
		env: { PATH: process.env.PATH ?? "" },
		encoding: "utf8",
	});
	if (opencodePathProbe.status === 0) {
		const debug = spawnSync("opencode", ["debug", "agent", "build", "--pure"], {
			cwd: root,
			env: { PATH: process.env.PATH, ...readOnly.env },
			encoding: "utf8",
		});
		assert.equal(debug.status, 0, debug.stderr);
		const resolvedAgent = JSON.parse(debug.stdout.trim());
		assert.equal(resolvedAgent.name, "build");
		for (const tool of ["bash", "edit", "write", "task", "todowrite", "webfetch", "websearch", "skill"]) assert.notEqual(resolvedAgent.tools?.[tool], true, `${tool} must be denied by the native debug agent`);
		for (const tool of ["read", "glob", "grep"]) assert.equal(resolvedAgent.tools?.[tool], true, `${tool} must remain readable`);
	}
	const malformedAuthRoot = join(root, "malformed-auth-source");
	mkdirSync(join(malformedAuthRoot, ".config", "opencode"), { recursive: true });
	const malformedMarker = "unterminated-provider-secret";
	writeFileSync(join(malformedAuthRoot, ".config", "opencode", "opencode.jsonc"), `{"model":"azure-foundry/deepseek-v4-pro", /* ${malformedMarker}`);
	chmodSync(join(malformedAuthRoot, ".config", "opencode", "opencode.jsonc"), 0o644);
	for (const directory of [malformedAuthRoot, join(malformedAuthRoot, ".config"), join(malformedAuthRoot, ".config", "opencode")]) protectOwnerOnly(directory, "directory", "malformed test auth directory");
	assert.throws(() => prepareChildEnvironment({ backendId: "opencode", attemptId: "opencode-malformed", runtimeRoot: join(root, "malformed-runtime"), parentEnv, authRoot: malformedAuthRoot, readOnly: true }), (error) => error.message === "OpenCode provider configuration is invalid" && !error.message.includes(malformedMarker));
	assert.deepEqual(readdirSync(join(root, "malformed-runtime", "children")), []);
	// Missing the flag entirely must not silently widen a child: the default is
	// the denied one.
	const defaulted = prepareChildEnvironment({ backendId: "opencode", attemptId: "opencode-default", runtimeRoot, parentEnv, authRoot });
	assert.equal(defaulted.env.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
});

test("DSO-005 isolates a Grok child home and its own CLI credential", () => {
	const root = mkdtempSync(join(tmpdir(), "naia-grok-env-"));
	roots.push(root);
	const authRoot = join(root, "auth-source");
	mkdirSync(join(authRoot, ".grok"), { recursive: true });
	writeFileSync(join(authRoot, ".grok", "auth.json"), "grok-auth", { mode: 0o600 });
	for (const directory of [authRoot, join(authRoot, ".grok")]) protectOwnerOnly(directory, "directory", "test auth directory");
	protectOwnerOnly(join(authRoot, ".grok", "auth.json"), "file", "test auth file");
	const runtimeRoot = join(root, "runtime");
	// Without a vendor API key the CLI's own credential file is copied into the
	// isolated child home, exactly as the Codex and Claude branches do.
	const oauth = prepareChildEnvironment({ backendId: "grok", attemptId: "grok-oauth", runtimeRoot, parentEnv: { PATH: process.env.PATH }, authRoot });
	assert.equal(oauth.env.GROK_HOME, join(oauth.childHome, ".grok"));
	assert.equal(readFileSync(join(oauth.childHome, ".grok", "auth.json"), "utf8"), "grok-auth");
	assert.equal(oauth.authenticationPrepared, true);
	// A configured vendor key satisfies authentication on its own; only the
	// backend's own key reaches the child.
	const keyed = prepareChildEnvironment({ backendId: "grok", attemptId: "grok-keyed", runtimeRoot, parentEnv: { PATH: process.env.PATH, DISCORD_TOKEN: "discord-secret", XAI_API_KEY: "xai-key", ANTHROPIC_API_KEY: "wrong-key" }, authRoot });
	assert.equal(keyed.env.XAI_API_KEY, "xai-key");
	assert.equal(keyed.env.ANTHROPIC_API_KEY, undefined);
	assert.equal(keyed.env.DISCORD_TOKEN, undefined);
	assert.equal(keyed.authenticationPrepared, true);
	// Nothing personal to a downstream fork leaks into a generic Grok child.
	for (const child of [oauth, keyed]) {
		assert.equal(child.env.CODEX_DEVELOPMENT_PROFILE, undefined);
		assert.equal(child.env.CODEX_AVAILABLE_BINDINGS, undefined);
		if (process.platform === "win32") assert.doesNotThrow(() => assertOwnerOnly(child.childHome, "directory", "child home"));
		else assert.equal(statSync(child.childHome).mode & 0o777, 0o700);
	}
});

test("DSO-005 rejects insecure auth permissions and cleans the partial child home", () => {
	const root = mkdtempSync(join(tmpdir(), "naia-insecure-auth-"));
	roots.push(root);
	const authRoot = join(root, "auth-source");
	mkdirSync(join(authRoot, ".codex"), { recursive: true });
	const unsafeAuth = join(authRoot, ".codex", "auth.json");
	writeFileSync(unsafeAuth, "unsafe", { mode: 0o644 });
	// writeFileSync applies the process umask, so a session running under
	// umask 0077 would silently create an owner-only file and this test would
	// assert nothing. Force the insecure mode the case is about.
	chmodSync(unsafeAuth, 0o644);
	const runtimeRoot = join(root, "runtime");
	assert.throws(() => prepareChildEnvironment({ backendId: "codex", attemptId: "bad-auth", runtimeRoot, parentEnv: { PATH: process.env.PATH }, authRoot }), /owner-only|permissions/);
	assert.deepEqual(readdirSync(join(runtimeRoot, "children")), []);
});
