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
const windowsPrefix = "powershell -NoProfile -Command ";
const preToolEntries = registry.hooks.PreToolUse;
const preToolHooks = preToolEntries.flatMap((entry) => entry.hooks || []);
const entryFor = (statusMessage) => preToolEntries.find((entry) => entry.hooks?.some((hook) => hook.statusMessage === statusMessage));
const contextBudgetEntry = entryFor("Checking retained context budget");
const sessionContractEntry = entryFor("Checking ADK session contract");
const spawnEntry = entryFor("Checking subagent spawn budget");
const costEntry = entryFor("Checking Codex lineage cost");
const enforcingEntry = entryFor("Enforcing Codex descendant cost ceilings");
const spawnHook = preToolHooks.find((hook) => hook.statusMessage === "Checking subagent spawn budget");
const costHook = preToolHooks.find((hook) => hook.statusMessage === "Checking Codex lineage cost");
const enforcingHook = preToolHooks.find((hook) => hook.statusMessage === "Enforcing Codex descendant cost ceilings");
assert.ok(spawnHook);
assert.ok(costHook);
assert.ok(enforcingHook);
assert.ok(contextBudgetEntry,"retained-context budget guard must remain registered");
assert.equal(contextBudgetEntry.matcher,undefined,"context budget applies to every pre-tool event");
assert.equal(sessionContractEntry.matcher,"Bash|shell_command|Edit|Write|NotebookEdit|apply_patch");
assert.equal(spawnEntry.matcher,undefined,"spawn tool aliases require an unfiltered guard");
assert.equal(costEntry.matcher,undefined,"lineage cost enforcement applies to every tool");
assert.equal(enforcingEntry,costEntry,"cost check and watchdog must share the same unfiltered entry");
assert.match(spawnHook.command, /subagent-spawn-guard\.cjs/);
assert.match(costHook.command, /codex-cost-guard\.cjs/);
assert.match(enforcingHook.command, /codex-cost-watchdog\.mjs.*--enforce/);
assert.ok(registry.hooks.UserPromptSubmit.flatMap((entry) => entry.hooks || []).some((hook) => hook.statusMessage === "Checking Codex lineage cost"));
assert.ok(registry.hooks.UserPromptSubmit.flatMap((entry) => entry.hooks || []).some((hook) => hook.statusMessage === "Enforcing Codex descendant cost ceilings"));

const deniedInput = JSON.stringify({
  tool_name: "spawn_agent",
  session_id: "deterministic-unregistered-session",
  tool_input: { role: "review", model: "gpt-5.6-sol", reasoning_effort: "medium", fork_context: false, fork_turns: "none", message: "test" },
});
const denied = spawnSync("sh", ["-c", spawnHook.command], { cwd: root, input: deniedInput, encoding: "utf8" });
assert.equal(denied.status, 0, denied.stderr);
assert.match(denied.stdout, /SUBAGENT GUARD/);
const unrelated = spawnSync("sh", ["-c", spawnHook.command], { cwd: root, input: JSON.stringify({ tool_name: "unrelated_tool", session_id: "deterministic-unregistered-session", tool_input: {} }), encoding: "utf8" });
assert.equal(unrelated.status, 0, unrelated.stderr);
assert.equal(unrelated.stdout, "");

assert.equal(requestContract.clientRegistrySupports(root, "codex"), true, "Codex registry must satisfy its lifecycle contract");

for (const eventName of lifecycleEvents) {
  const hooks = registry.hooks[eventName].flatMap((entry) => entry.hooks || []);
  assert.equal(hooks.length, eventName === "UserPromptSubmit" ? 4 : 2, `${eventName} must retain its registered hooks`);
  for (const hook of hooks) {
    assert.match(hook.command, /git rev-parse --show-toplevel 2>\/dev\/null\) \|\| exit 0/);
    assert.match(hook.command, /registry=\"\$root\/\.codex\/hooks\.json\"/);
    if (hook.statusMessage === "Enforcing Codex descendant cost ceilings") {
      assert.match(hook.command, /if \[ ! -f \"\$watchdog\" \]; then/);
      assert.match(hook.command, /node \"\$watchdog\" --enforce/);
    } else {
      assert.match(hook.command, /if \[ ! -f \"\$hook\" \]; then/);
      assert.match(hook.command, /node \"\$hook\"/);
    }
		if (hook.statusMessage === "Enforcing Codex descendant cost ceilings") {
			assert.equal(hook.commandWindows, undefined, "the Linux /proc watchdog must not claim Windows enforcement");
		} else {
			assert.ok(hook.commandWindows.startsWith(windowsPrefix));
			assert.match(hook.commandWindows, /\$LASTEXITCODE -ne 0/);
			assert.match(hook.commandWindows, /Test-Path -LiteralPath \$hook/);
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
          const quotedScript = hook.commandWindows.slice(windowsPrefix.length);
          const script = quotedScript.slice(1, -1);
          const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
            cwd,
            input: "{}",
            encoding: "utf8",
          });
          assert.equal(result.status, 0, `${eventName} failed in ${cwd}: ${result.stderr}`);
          assert.equal(result.stderr, "", `${eventName} emitted stderr in ${cwd}`);
        }
      }
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

console.log("Codex hook registration guard tests passed");
