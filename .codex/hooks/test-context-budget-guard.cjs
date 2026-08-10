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
const event = (input, contextWindow = 258400) => JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: input }, model_context_window: contextWindow } } });
// 258,400-window model: limit scales to round(258400*0.6) = 155,040, not the bare 64,000 floor.
fs.writeFileSync(rollout, `${event(155_039)}\n`);
assert.equal(guard.evaluate({ sessionId: session, codexHome: home }), null, "native Codex compaction must remain available by default");
fs.appendFileSync(rollout, `${event(155_040)}\n`);
assert.equal(guard.evaluate({ sessionId: session, codexHome: home }), null, "native Codex compaction must remain available by default");
const enabledEnv = { CODEX_CONTEXT_GUARD: "on" };
const blocked = guard.evaluate({ sessionId: session, codexHome: home, env: enabledEnv });
assert.equal(blocked.decision, "block");
assert.match(blocked.reason, /155,040 input tokens/);
const promptBlocked = guard.evaluate({ sessionId: session, eventName: "UserPromptSubmit", codexHome: home, env: enabledEnv });
assert.equal(promptBlocked.decision, "block");
assert.match(promptBlocked.reason, /155,040 input tokens/);
assert.equal(guard.evaluate({ sessionId: session, eventName: "UserPromptSubmit", prompt: " /compact ", codexHome: home, env: enabledEnv }), null);
assert.equal(guard.evaluate({ sessionId: session, eventName: "UserPromptSubmit", prompt: "/compact now", codexHome: home, env: enabledEnv })?.decision, "block");

const unknownWindowSession = "session-unknown-window";
const unknownWindowRollout = path.join(directory, `rollout-2026-08-09T00-00-01-${unknownWindowSession}.jsonl`);
fs.writeFileSync(unknownWindowRollout, `${event(63_999, null)}\n`);
assert.equal(guard.evaluate({ sessionId: unknownWindowSession, codexHome: home, env: enabledEnv }), null, "an unknown context window must still use the 64,000 floor");
fs.appendFileSync(unknownWindowRollout, `${event(64_000, null)}\n`);
assert.equal(guard.evaluate({ sessionId: unknownWindowSession, codexHome: home, env: enabledEnv })?.decision, "block");
const adapter = spawnSync(process.execPath, [path.join(__dirname, "session-inject.cjs")], {
  input: JSON.stringify({ session_id: session, hook_event_name: "UserPromptSubmit" }),
  encoding: "utf8",
  env: { ...process.env, CODEX_HOME: home, CODEX_CONTEXT_GUARD: "on" },
});
assert.equal(adapter.status, 0, adapter.stderr);
assert.equal(JSON.parse(adapter.stdout).decision, "block", "the trusted session-inject hook must stop oversized user prompts");
const compact = spawnSync(process.execPath, [path.join(__dirname, "session-inject.cjs")], {
  input: JSON.stringify({ session_id: session, hook_event_name: "UserPromptSubmit", prompt: "/compact" }),
  encoding: "utf8",
  env: { ...process.env, CODEX_HOME: home, CODEX_CONTEXT_GUARD: "on" },
});
assert.equal(compact.status, 0, compact.stderr);
assert.equal(compact.stdout, "", "the exact /compact recovery prompt must remain available over budget");
const underBudget = spawnSync(process.execPath, [path.join(__dirname, "session-inject.cjs")], {
  input: JSON.stringify({ session_id: session, hook_event_name: "UserPromptSubmit" }),
  encoding: "utf8",
  env: { ...process.env, CODEX_HOME: home, CODEX_CONTEXT_GUARD: "on", CODEX_MAX_RETAINED_CONTEXT_TOKENS: "200000" },
});
assert.equal(underBudget.status, 0, underBudget.stderr);
assert.equal(underBudget.stdout, "", "ordinary prompts must not repeat the full session injection");
assert.equal(guard.evaluate({ sessionId: session, codexHome: home, env: { CODEX_CONTEXT_GUARD: "off" } }), null);
assert.equal(guard.evaluate({ sessionId: session, codexHome: home, env: { CODEX_CONTEXT_GUARD: "on", CODEX_MAX_RETAINED_CONTEXT_TOKENS: "200000" } }), null);
fs.rmSync(home, { recursive: true, force: true });
console.log("Codex context budget guard tests passed");
