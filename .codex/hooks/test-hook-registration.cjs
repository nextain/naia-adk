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

assert.equal(requestContract.clientRegistrySupports(root, "codex"), true, "Codex registry must satisfy its lifecycle contract");

for (const eventName of lifecycleEvents) {
  const hooks = registry.hooks[eventName].flatMap((entry) => entry.hooks || []);
  assert.equal(hooks.length, 2, `${eventName} must retain both registered hooks`);
  for (const hook of hooks) {
    assert.match(hook.command, /git rev-parse --show-toplevel 2>\/dev\/null\) \|\| exit 0/);
    assert.match(hook.command, /registry=\"\$root\/\.codex\/hooks\.json\"/);
    assert.match(hook.command, /if \[ ! -f \"\$hook\" \]; then/);
    assert.match(hook.command, /node \"\$hook\"/);
    assert.ok(hook.commandWindows.startsWith(windowsPrefix));
    assert.match(hook.commandWindows, /\$LASTEXITCODE -ne 0/);
    assert.match(hook.commandWindows, /Test-Path -LiteralPath \$hook/);
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
