#!/usr/bin/env node

const path = require("path");
const core = require(path.join(__dirname, "..", "..", ".agents", "hooks", "core", "harness-core.js"));
const contracts = require(path.join(__dirname, "..", "..", ".agents", "hooks", "core", "session-contract.js"));
const contextBudget = require(path.join(__dirname, "context-budget-guard.cjs"));

async function readInput() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

async function main() {
  const input = await readInput();
  if (input.hook_event_name === "UserPromptSubmit") {
    const guard = contextBudget.evaluate({ sessionId: input.session_id, eventName: input.hook_event_name, prompt: input.prompt });
    if (guard) process.stdout.write(JSON.stringify(guard));
    // SessionStart and PostCompact already supply the full, contract-bound
    // workflow state. Re-injecting it on every prompt repeats stale context.
    return;
  }
  const cwd = contracts.resolveHookProjectRoot(input.cwd || process.cwd(), process.env) || input.cwd || process.cwd();
  const result = core.buildSessionInject({
    cwd,
    sessionId: input.session_id || null,
    hooksDir: __dirname,
    env: process.env,
    optOutEnvVar: "CODEX_HARNESS",
    hostConfigDir: ".codex",
  });
  if (result && result.text) {
    process.stdout.write(JSON.stringify({ systemMessage: result.text }));
  }
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({
    systemMessage: `[HARNESS] session injection failed: ${error.message}`,
  }));
});
