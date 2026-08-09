#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const guard = require("./context-budget-guard.cjs");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-context-guard-"));
const session = "session-under-test";
const directory = path.join(home, "sessions", "2026", "08", "09");
fs.mkdirSync(directory, { recursive: true });
const rollout = path.join(directory, `rollout-2026-08-09T00-00-00-${session}.jsonl`);
const event = (input) => JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: input }, model_context_window: 258400 } } });
fs.writeFileSync(rollout, `${event(63_999)}\n`);
assert.equal(guard.evaluate({ sessionId: session, codexHome: home }), null);
fs.appendFileSync(rollout, `${event(64_000)}\n`);
const blocked = guard.evaluate({ sessionId: session, codexHome: home });
assert.equal(blocked.decision, "block");
assert.match(blocked.reason, /64,000 input tokens/);
const promptBlocked = guard.evaluate({ sessionId: session, eventName: "UserPromptSubmit", codexHome: home });
assert.equal(promptBlocked.decision, "block");
assert.match(promptBlocked.reason, /64,000 input tokens/);
assert.equal(guard.evaluate({ sessionId: session, eventName: "UserPromptSubmit", prompt: " /compact ", codexHome: home }), null);
assert.equal(guard.evaluate({ sessionId: session, eventName: "UserPromptSubmit", prompt: "/compact now", codexHome: home })?.decision, "block");
const adapter = spawnSync(process.execPath, [path.join(__dirname, "session-inject.cjs")], {
  input: JSON.stringify({ session_id: session, hook_event_name: "UserPromptSubmit" }),
  encoding: "utf8",
  env: { ...process.env, CODEX_HOME: home },
});
assert.equal(adapter.status, 0, adapter.stderr);
assert.equal(JSON.parse(adapter.stdout).decision, "block", "the trusted session-inject hook must stop oversized user prompts");
const compact = spawnSync(process.execPath, [path.join(__dirname, "session-inject.cjs")], {
  input: JSON.stringify({ session_id: session, hook_event_name: "UserPromptSubmit", prompt: "/compact" }),
  encoding: "utf8",
  env: { ...process.env, CODEX_HOME: home },
});
assert.equal(compact.status, 0, compact.stderr);
assert.equal(compact.stdout, "", "the exact /compact recovery prompt must remain available over budget");
const underBudget = spawnSync(process.execPath, [path.join(__dirname, "session-inject.cjs")], {
  input: JSON.stringify({ session_id: session, hook_event_name: "UserPromptSubmit" }),
  encoding: "utf8",
  env: { ...process.env, CODEX_HOME: home, CODEX_MAX_RETAINED_CONTEXT_TOKENS: "130000" },
});
assert.equal(underBudget.status, 0, underBudget.stderr);
assert.equal(underBudget.stdout, "", "ordinary prompts must not repeat the full session injection");
assert.equal(guard.evaluate({ sessionId: session, codexHome: home, env: { CODEX_CONTEXT_GUARD: "off" } }), null);
assert.equal(guard.evaluate({ sessionId: session, codexHome: home, env: { CODEX_MAX_RETAINED_CONTEXT_TOKENS: "130000" } }), null);
fs.rmSync(home, { recursive: true, force: true });
console.log("Codex context budget guard tests passed");
