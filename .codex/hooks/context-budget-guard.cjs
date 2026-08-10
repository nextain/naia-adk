#!/usr/bin/env node
/*
 * Refuse additional work when a Codex TUI session has grown beyond the
 * retained-context budget. It stops the next user prompt before a new model
 * request, and also blocks local tools for clients that are already mid-turn.
 * This is a rotation guard, not an account budget breaker: `/compact` or a
 * new session immediately restores normal work.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ON_VALUES = new Set(["on", "1", "true", "yes"]);
// Floor used when the model's context window is unknown and as the minimum
// for known windows. Leaves headroom for one final tool result and the
// handoff/compaction turn; the previous 80k boundary could already be
// exceeded by one large read.
const DEFAULT_LIMIT = 64_000;
// Fraction of the model's actual context window retained before blocking.
// A fixed absolute limit ignored the window entirely and throttled large-
// window models (e.g. 258,400) at the same point as small-window ones.
const WINDOW_RATIO = 0.6;

function parseInput(raw) {
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

function configuredLimit(contextWindow, env = process.env) {
  const raw = String(env.CODEX_MAX_RETAINED_CONTEXT_TOKENS || "").trim();
  if (raw) {
    const value = Number(raw);
    if (Number.isSafeInteger(value) && value >= 16_000) return value;
  }
  if (Number.isSafeInteger(contextWindow) && contextWindow > 0) {
    return Math.max(DEFAULT_LIMIT, Math.round(contextWindow * WINDOW_RATIO));
  }
  return DEFAULT_LIMIT;
}

function disabled(env = process.env) {
  // Codex performs native automatic compaction. This cost guard is an
  // operator opt-in because blocking before the host compaction threshold
  // leaves the agent unable to continue without a user-entered slash command.
  return !ON_VALUES.has(String(env.CODEX_CONTEXT_GUARD || "").trim().toLowerCase());
}

function recoveryPrompt(prompt) {
  return String(prompt || "").trim() === "/compact";
}

function findRollout(sessionsRoot, sessionId) {
  if (!sessionId || !fs.existsSync(sessionsRoot)) return null;
  const stack = [sessionsRoot];
  let best = null;
  while (stack.length) {
    const directory = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) stack.push(candidate);
      else if (entry.isFile() && entry.name.endsWith(`-${sessionId}.jsonl`)) {
        const stat = fs.statSync(candidate);
        if (!best || stat.mtimeMs > best.mtimeMs) best = { path: candidate, mtimeMs: stat.mtimeMs };
      }
    }
  }
  return best?.path || null;
}

function tail(filePath, bytes = 512 * 1024) {
  const descriptor = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(descriptor).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(descriptor, buffer, 0, length, Math.max(0, size - length));
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function latestUsage(filePath) {
  const lines = tail(filePath).split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const row = JSON.parse(lines[index]);
      const info = row?.type === "event_msg" && row?.payload?.type === "token_count" ? row.payload.info : null;
      const input = info?.last_token_usage?.input_tokens;
      if (Number.isSafeInteger(input) && input >= 0) return { inputTokens: input, contextWindow: info.model_context_window ?? null };
    } catch {}
  }
  return null;
}

function evaluate({ sessionId, eventName = "PreToolUse", prompt = "", codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), env = process.env } = {}) {
  if (disabled(env)) return null;
  if (eventName === "UserPromptSubmit" && recoveryPrompt(prompt)) return null;
  const rollout = findRollout(path.join(codexHome, "sessions"), sessionId);
  if (!rollout) return null;
  const usage = latestUsage(rollout);
  if (!usage) return null;
  const limit = configuredLimit(usage.contextWindow, env);
  if (usage.inputTokens < limit) return null;
  const reason = `[COST GUARD] This session is replaying ${usage.inputTokens.toLocaleString("en-US")} input tokens per turn (limit ${limit.toLocaleString("en-US")}). Run /compact or start a new Codex session before more work. The exact /compact recovery prompt remains allowed. This guard prevents long-context repetition; it does not stop needed work after rotation.`;
  if (eventName === "UserPromptSubmit") return { decision: "block", reason };
  return { decision: "block", reason };
}

async function main() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  const input = parseInput(raw);
  const result = evaluate({ sessionId: input.session_id, eventName: input.hook_event_name, prompt: input.prompt });
  if (result) process.stdout.write(JSON.stringify(result));
}

if (require.main === module) main().catch(() => process.exit(0));

module.exports = { configuredLimit, disabled, findRollout, latestUsage, recoveryPrompt, evaluate };
