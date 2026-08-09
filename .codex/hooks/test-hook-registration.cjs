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
const encodedWindowsPrefix = "powershell -NoProfile -NonInteractive -EncodedCommand ";
function decodeWindowsCommand(command) {
  assert.ok(command.startsWith(encodedWindowsPrefix), "Windows Stop hook must use an encoded PowerShell command");
  return Buffer.from(command.slice(encodedWindowsPrefix.length), "base64").toString("utf16le");
}
const stopHooks = registry.hooks.Stop.flatMap((entry) => entry.hooks || []);
const stopContractHook = stopHooks.find((hook) => /request-contract\.cjs/.test(hook.command));
const stopTranslationHook = stopHooks.find((hook) => /context-translation-batch\.cjs/.test(hook.command));
const stopRecoveryHook = stopHooks.find((hook) => /session-contract-recovery\.cjs/.test(hook.command));

assert.ok(stopContractHook);
assert.ok(stopTranslationHook);
assert.ok(stopRecoveryHook);
assert.equal(stopHooks.length, 3, "Stop must retain the contract gate, translation flush, and recovery lease update");
for (const [hook, marker] of [
  [stopContractHook, /stop_hook_unavailable/],
  [stopTranslationHook, /--flush/],
  [stopRecoveryHook, /event Stop/],
]) {
  assert.match(hook.command, marker);
  assert.match(hook.command, /exit 0/);
  assert.match(decodeWindowsCommand(hook.commandWindows), marker);
  assert.match(decodeWindowsCommand(hook.commandWindows), /exit 0/);
}

assert.equal(requestContract.clientRegistrySupports(root, "codex"), true, "Codex registry must satisfy its lifecycle contract");

for (const eventName of lifecycleEvents) {
  const hooks = registry.hooks[eventName].flatMap((entry) => entry.hooks || []);
  assert.equal(hooks.length, 3, `${eventName} must retain session injection, request contract, and recovery hooks`);
  for (const hook of hooks.slice(0, 2)) {
    assert.match(hook.command, /git rev-parse --show-toplevel 2>\/dev\/null\) \|\| exit 0/);
    assert.match(hook.command, /registry=\"\$root\/\.codex\/hooks\.json\"/);
    assert.match(hook.command, /if \[ ! -f \"\$hook\" \]; then/);
    assert.match(hook.command, /node \"\$hook\"/);
    assert.ok(hook.commandWindows.startsWith(windowsPrefix));
    assert.match(hook.commandWindows, /\$LASTEXITCODE -ne 0/);
    assert.match(hook.commandWindows, /Test-Path -LiteralPath \$hook/);
  }
  assert.match(hooks[2].command, /session-contract-recovery\.cjs/);
  assert.match(hooks[2].command, new RegExp(`event ${eventName}`));
  assert.ok(hooks[2].commandWindows.startsWith(windowsPrefix));
}

const stopScratch = fs.mkdtempSync(path.join(os.tmpdir(), "codex-stop-resilience-"));
try {
  const stopInput = JSON.stringify({ hook_event_name: "Stop", session_id: "deterministic-stop-resilience", cwd: stopScratch });
  const stopWithoutRoot = spawnSync("sh", ["-c", stopContractHook.command], { cwd: stopScratch, input: stopInput, encoding: "utf8" });
  assert.equal(stopWithoutRoot.status, 0, stopWithoutRoot.stderr);
  assert.equal(JSON.parse(stopWithoutRoot.stdout).decision, "block");
  for (const hook of [stopTranslationHook, stopRecoveryHook]) {
    const result = spawnSync("sh", ["-c", hook.command], { cwd: stopScratch, input: stopInput, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    if (hook === stopRecoveryHook) assert.equal(result.stdout, "", "recovery Stop hook must not corrupt the host JSON stream");
  }
} finally {
  fs.rmSync(stopScratch, { recursive: true, force: true });
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
    for (const hook of stopHooks) {
      const result = spawnSync(hook.commandWindows, { cwd: outsideRepo, input: "{}", encoding: "utf8", shell: true });
      assert.equal(result.status, 0, `encoded Stop hook failed: ${result.stderr}`);
    }
    for (const cwd of [foreignRepo, outsideRepo]) {
      for (const eventName of lifecycleEvents) {
        for (const hook of registry.hooks[eventName].flatMap((entry) => entry.hooks || [])) {
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
