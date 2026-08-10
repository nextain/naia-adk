#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..", "..");
const registry = JSON.parse(fs.readFileSync(path.join(root, ".codex", "hooks.json"), "utf8"));
const requestContract = require(path.join(root, ".agents", "hooks", "core", "request-contract.js"));
const lifecycleEvents = ["SessionStart", "UserPromptSubmit"];
const windowsPrefix = "powershell -NoProfile -NonInteractive -EncodedCommand ";
const quietPrefix = "$ProgressPreference='SilentlyContinue'; ";
function decodeWindowsCommand(command) {
  assert.ok(command.startsWith(windowsPrefix), "every Windows hook must use an encoded PowerShell command");
  return Buffer.from(command.slice(windowsPrefix.length), "base64").toString("utf16le");
}
const preToolEntries = registry.hooks.PreToolUse;
const preToolHooks = preToolEntries.flatMap((entry) => entry.hooks || []);
const entryFor = (statusMessage) => preToolEntries.find((entry) => entry.hooks?.some((hook) => hook.statusMessage === statusMessage));
const contextBudgetEntry = entryFor("Checking retained context budget");
const sessionContractEntry = entryFor("Checking ADK session contract");
const spawnEntry = entryFor("Checking subagent spawn budget");
const costEntry = entryFor("Checking Codex lineage cost");
const enforcingEntry = entryFor("Enforcing Codex descendant cost ceilings");
const sessionContractHook = preToolHooks.find((hook) => hook.statusMessage === "Checking ADK session contract");
const spawnHook = preToolHooks.find((hook) => hook.statusMessage === "Checking subagent spawn budget");
const costHook = preToolHooks.find((hook) => hook.statusMessage === "Checking Codex lineage cost");
const enforcingHook = preToolHooks.find((hook) => hook.statusMessage === "Enforcing Codex descendant cost ceilings");
const postToolHooks = registry.hooks.PostToolUse.flatMap((entry) => entry.hooks || []);
const resultHook = postToolHooks.find((hook) => hook.statusMessage === "Checking subagent result contract");
const stopHooks = registry.hooks.Stop.flatMap((entry) => entry.hooks || []);
const stopContractHook = stopHooks.find((hook) => /request-contract\.cjs/.test(hook.command));
const stopTranslationHook = stopHooks.find((hook) => /context-translation-batch\.cjs/.test(hook.command));
const stopRecoveryHook = stopHooks.find((hook) => /session-contract-recovery\.cjs/.test(hook.command));
const allHooks = Object.values(registry.hooks).flatMap((entries) => entries.flatMap((entry) => entry.hooks || []));
assert.ok(spawnHook);
assert.ok(sessionContractHook);
assert.ok(costHook);
assert.ok(enforcingHook);
assert.ok(resultHook);
assert.ok(stopContractHook);
assert.ok(stopTranslationHook);
assert.ok(stopRecoveryHook);
assert.equal(stopHooks.length, 3, "Stop must retain the contract gate, retryable context translation flush, and recovery lease");
assert.match(stopContractHook.command, /stop_hook_unavailable/);
assert.match(stopContractHook.command, /exit 0/);
assert.match(decodeWindowsCommand(stopContractHook.commandWindows), /stop_hook_unavailable/);
assert.match(decodeWindowsCommand(stopContractHook.commandWindows), /exit 0/);
assert.match(stopTranslationHook.command, /--flush/);
assert.match(stopTranslationHook.command, /exit 0/);
assert.match(decodeWindowsCommand(stopTranslationHook.commandWindows), /exit 0/);
assert.ok(contextBudgetEntry,"retained-context budget guard must remain registered");
assert.equal(contextBudgetEntry.matcher,undefined,"context budget applies to every pre-tool event");
assert.equal(sessionContractEntry.matcher,"Bash|shell_command|exec_command|(?:.*[.:/]exec_command)|(?:.*[.:/]shell_command)|Edit|Write|NotebookEdit|apply_patch");
assert.equal(spawnEntry.matcher,undefined,"spawn tool aliases require an unfiltered guard");
assert.equal(costEntry.matcher,undefined,"lineage cost enforcement applies to every tool");
assert.equal(enforcingEntry,costEntry,"cost check and watchdog must share the same unfiltered entry");
assert.match(spawnHook.command, /subagent-spawn-guard\.cjs/);
assert.match(costHook.command, /codex-cost-guard\.cjs/);
assert.match(enforcingHook.command, /codex-cost-watchdog\.mjs.*--enforce/);
assert.match(resultHook.command, /subagent-spawn-guard\.cjs/);
assert.ok(registry.hooks.UserPromptSubmit.flatMap((entry) => entry.hooks || []).some((hook) => hook.statusMessage === "Checking Codex lineage cost"));
assert.ok(registry.hooks.UserPromptSubmit.flatMap((entry) => entry.hooks || []).some((hook) => hook.statusMessage === "Enforcing Codex descendant cost ceilings"));
for (const hook of allHooks) {
  assert.match(hook.command, /ADK_PROJECT_ROOT/, "every POSIX hook must retain the inherited root fallback");
  assert.match(hook.command, /git rev-parse --show-toplevel/, "every POSIX hook must retain the local repository fallback");
  if (hook.commandWindows) {
    const source = decodeWindowsCommand(hook.commandWindows);
    assert.ok(source.startsWith(quietPrefix), "every Windows hook must suppress PowerShell progress protocol noise");
    assert.match(source, /ADK_PROJECT_ROOT/, "every Windows hook must retain the inherited root fallback");
  }
}

const deniedInput = JSON.stringify({
  tool_name: "spawn_agent",
  session_id: "deterministic-unregistered-session",
  tool_input: { role: "review", model: "gpt-5.6-sol", reasoning_effort: "medium", fork_context: false, fork_turns: "none", message: "test" },
});
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hook-scratch-"));
const stopInput = JSON.stringify({
  hook_event_name: "Stop",
  session_id: "deterministic-stop-resilience",
  cwd: scratch,
});
try {
 if (process.platform !== "win32") {
  const denied = spawnSync("sh", ["-c", spawnHook.command], { cwd: root, input: deniedInput, encoding: "utf8" });
  assert.equal(denied.status, 0, denied.stderr);
  assert.match(denied.stdout, /SUBAGENT GUARD/);
  const unrelated = spawnSync("sh", ["-c", spawnHook.command], { cwd: root, input: JSON.stringify({ tool_name: "unrelated_tool", session_id: "deterministic-unregistered-session", tool_input: {} }), encoding: "utf8" });
  assert.equal(unrelated.status, 0, unrelated.stderr);
  assert.equal(unrelated.stdout, "");
  const inherited = spawnSync("sh", ["-c", spawnHook.command], { cwd: scratch, env: { ...process.env, ADK_PROJECT_ROOT: root }, input: deniedInput, encoding: "utf8" });
  assert.equal(inherited.status, 0, inherited.stderr);
  assert.match(inherited.stdout, /SUBAGENT GUARD/, "the inherited root must keep the spawn guard active from scratch cwd");
  const gateInput = JSON.stringify({
    cwd: scratch,
    tool_name: "apply_patch",
    session_id: "deterministic-unregistered-session",
    tool_input: { command: "*** Begin Patch\n*** Update File: product.txt\n@@\n-old\n+new\n*** End Patch\n" },
  });
  const inheritedGate = spawnSync("sh", ["-c", sessionContractHook.command], { cwd: scratch, env: { ...process.env, ADK_PROJECT_ROOT: root }, input: gateInput, encoding: "utf8" });
  assert.equal(inheritedGate.status, 0, inheritedGate.stderr);
  const recoveryOptOut = [".claude", ".codex", ".pi"].some((dir) => fs.existsSync(path.join(root, dir, "no-harness")));
  if (recoveryOptOut) {
    assert.equal(inheritedGate.stdout, "", "the inherited root must honor repository recovery opt-out from scratch cwd");
  } else {
    assert.match(inheritedGate.stdout, /HARNESS/, "the inherited root must keep the session contract gate active from scratch cwd");
  }
  const noInheritedEnvironment = { ...process.env };
  delete noInheritedEnvironment.ADK_PROJECT_ROOT;
  const missing = spawnSync("sh", ["-c", spawnHook.command], { cwd: scratch, env: noInheritedEnvironment, input: deniedInput, encoding: "utf8" });
  assert.notEqual(missing.status, 0, "scratch cwd without an inherited root must fail closed");
  const relative = spawnSync("sh", ["-c", spawnHook.command], { cwd: scratch, env: { ...process.env, ADK_PROJECT_ROOT: "." }, input: deniedInput, encoding: "utf8" });
  assert.notEqual(relative.status, 0, "a relative inherited root must fail closed");

  const stopWithoutRoot = spawnSync("sh", ["-c", stopContractHook.command], {
    cwd: scratch,
    env: noInheritedEnvironment,
    input: stopInput,
    encoding: "utf8",
  });
  assert.equal(stopWithoutRoot.status, 0, stopWithoutRoot.stderr);
  assert.equal(JSON.parse(stopWithoutRoot.stdout).decision, "block", "an unavailable Stop contract gate must block structurally without failing the hook process");

  const stopWithRelativeRoot = spawnSync("sh", ["-c", stopContractHook.command], {
    cwd: scratch,
    env: { ...process.env, ADK_PROJECT_ROOT: "." },
    input: stopInput,
    encoding: "utf8",
  });
  assert.equal(stopWithRelativeRoot.status, 0, stopWithRelativeRoot.stderr);
  assert.equal(JSON.parse(stopWithRelativeRoot.stdout).decision, "block");

  const incompleteRoot = path.join(scratch, "incomplete-installation");
  fs.mkdirSync(path.join(incompleteRoot, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(incompleteRoot, ".codex", "hooks.json"), "{}\n");
  const stopWithoutAdapter = spawnSync("sh", ["-c", stopContractHook.command], {
    cwd: scratch,
    env: { ...process.env, ADK_PROJECT_ROOT: incompleteRoot },
    input: stopInput,
    encoding: "utf8",
  });
  assert.equal(stopWithoutAdapter.status, 0, stopWithoutAdapter.stderr);
  assert.equal(JSON.parse(stopWithoutAdapter.stdout).decision, "block");

  const translationWithoutRoot = spawnSync("sh", ["-c", stopTranslationHook.command], {
    cwd: scratch,
    env: noInheritedEnvironment,
    input: stopInput,
    encoding: "utf8",
  });
  assert.equal(translationWithoutRoot.status, 0, translationWithoutRoot.stderr);
 }

  const isolatedCodexHook = path.join(scratch, "isolated-codex", ".codex", "hooks", "request-contract.cjs");
  fs.mkdirSync(path.dirname(isolatedCodexHook), { recursive: true });
  fs.copyFileSync(path.join(root, ".codex", "hooks", "request-contract.cjs"), isolatedCodexHook);
  const missingCodexCore = spawnSync(process.execPath, [isolatedCodexHook, "Stop"], { input: stopInput, encoding: "utf8" });
  assert.equal(missingCodexCore.status, 0, missingCodexCore.stderr);
  assert.equal(JSON.parse(missingCodexCore.stdout).decision, "block", "Codex adapter load failures must remain machine-readable");

  const isolatedClaudeHook = path.join(scratch, "isolated-claude", ".claude", "hooks", "request-contract.js");
  fs.mkdirSync(path.dirname(isolatedClaudeHook), { recursive: true });
  fs.copyFileSync(path.join(root, ".claude", "hooks", "request-contract.js"), isolatedClaudeHook);
  const missingClaudeCore = spawnSync(process.execPath, [isolatedClaudeHook, "Stop"], { input: stopInput, encoding: "utf8" });
  assert.equal(missingClaudeCore.status, 0, missingClaudeCore.stderr);
  assert.equal(JSON.parse(missingClaudeCore.stdout).decision, "block", "Claude adapter load failures must remain machine-readable");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

assert.equal(requestContract.clientRegistrySupports(root, "codex"), true, "Codex registry must satisfy its lifecycle contract");

for (const eventName of lifecycleEvents) {
  const hooks = registry.hooks[eventName].flatMap((entry) => entry.hooks || []);
  assert.equal(hooks.length, eventName === "UserPromptSubmit" ? 5 : 3, `${eventName} must retain its registered hooks and recovery lease`);
  for (const hook of hooks) {
    assert.match(hook.command, /ADK_PROJECT_ROOT/);
    assert.match(hook.command, /git rev-parse --show-toplevel 2>\/dev\/null\) \|\| exit 1/);
    if (/session-contract-recovery\.cjs/.test(hook.command)) {
      assert.match(hook.command, new RegExp(`event ${eventName}`));
      assert.match(decodeWindowsCommand(hook.commandWindows), /session-contract-recovery\.cjs/);
      continue;
    }
    assert.match(hook.command, /registry=\"\$root\/\.codex\/hooks\.json\"/);
    if (hook.statusMessage === "Enforcing Codex descendant cost ceilings") {
      assert.match(hook.command, /if \[ ! -f \"\$watchdog\" \]; then/);
      assert.match(hook.command, /node \"\$watchdog\" --enforce/);
    } else {
      assert.match(hook.command, /if \[ ! -f \"\$hook\" \]; then/);
      assert.match(hook.command, /node \"\$hook\"/);
    }
		if (hook.statusMessage === "Enforcing Codex descendant cost ceilings") {
			assert.ok(hook.commandWindows.startsWith(windowsPrefix));
			assert.match(decodeWindowsCommand(hook.commandWindows), /ADK_PROJECT_ROOT/);
			assert.match(decodeWindowsCommand(hook.commandWindows), /\$LASTEXITCODE -ne 0/);
			assert.match(decodeWindowsCommand(hook.commandWindows), /Test-Path -LiteralPath \$watchdog/);
		} else {
			assert.ok(hook.commandWindows.startsWith(windowsPrefix));
			assert.match(decodeWindowsCommand(hook.commandWindows), /ADK_PROJECT_ROOT/);
			assert.match(decodeWindowsCommand(hook.commandWindows), /\$LASTEXITCODE -ne 0/);
			assert.match(decodeWindowsCommand(hook.commandWindows), /Test-Path -LiteralPath \$hook/);
		}
  }
}

if (process.platform === "win32") {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hook-guard-"));
  const foreignRepo = path.join(tempRoot, "foreign-repo");
  const outsideRepo = path.join(tempRoot, "outside-repo");
  fs.mkdirSync(foreignRepo);
  fs.mkdirSync(outsideRepo);
  const init = spawnSync("git", ["init", "--quiet"], { cwd: foreignRepo, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);

  try {
    for (const cwd of [foreignRepo, outsideRepo]) {
      for (const eventName of lifecycleEvents) {
		for (const hook of registry.hooks[eventName].flatMap((entry) => entry.hooks || [])) {
			if (!hook.commandWindows) continue;
          const result = spawnSync(hook.commandWindows, {
            cwd,
            input: "{}",
            encoding: "utf8",
            shell: true,
            timeout: 15_000,
          });
          assert.notEqual(result.status, 0, `${eventName} must fail closed without an inherited root in ${cwd}`);
          const inherited = spawnSync(hook.commandWindows, {
            cwd,
            env: { ...process.env, ADK_PROJECT_ROOT: root },
            input: "{}",
            encoding: "utf8",
            shell: true,
            timeout: 15_000,
          });
          assert.equal(inherited.status, 0, `${eventName} failed with an inherited root in ${cwd}: ${inherited.stderr}`);
          assert.equal(inherited.stderr, "", `${eventName} emitted protocol-breaking stderr in ${cwd}`);
          assert.doesNotMatch(inherited.stdout, /^\$root=/, `${eventName} printed its PowerShell source instead of executing it`);
        }
      }
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

console.log("Codex hook registration guard tests passed");
