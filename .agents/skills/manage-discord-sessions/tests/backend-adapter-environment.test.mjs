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
	writeFileSync(join(authRoot, ".config", "opencode", "opencode.jsonc"), "opencode-config", { mode: 0o644 });
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
	assert.equal(readFileSync(join(opencodeCloud.env.XDG_CONFIG_HOME, "opencode", "opencode.jsonc"), "utf8"), "opencode-config");
	assert.equal(readFileSync(join(opencodeCloud.env.XDG_DATA_HOME, "opencode", "auth.json"), "utf8"), "opencode-auth");
	assert.equal(statSync(join(opencodeCloud.env.XDG_CONFIG_HOME, "opencode", "opencode.jsonc")).mode & 0o777, 0o600);
	assert.equal(opencodeCloud.authenticationPrepared, true);
	assert.throws(() => prepareChildEnvironment({ backendId: "codex", attemptId: "bad-profile", runtimeRoot: join(root, "runtime"), parentEnv, authRoot, credentialProfiles: ["unknown"] }), /unsupported credential profile/);
});

test("DSO-005 rejects insecure auth permissions and cleans the partial child home", () => {
	const root = mkdtempSync(join(tmpdir(), "naia-insecure-auth-"));
	roots.push(root);
	const authRoot = join(root, "auth-source");
	mkdirSync(join(authRoot, ".codex"), { recursive: true });
	writeFileSync(join(authRoot, ".codex", "auth.json"), "unsafe", { mode: 0o644 });
	const runtimeRoot = join(root, "runtime");
	assert.throws(() => prepareChildEnvironment({ backendId: "codex", attemptId: "bad-auth", runtimeRoot, parentEnv: { PATH: process.env.PATH }, authRoot }), /owner-only|permissions/);
	assert.deepEqual(readdirSync(join(runtimeRoot, "children")), []);
});
