#!/usr/bin/env node
"use strict";

// Node-only port of the user's Bash RunPod guard; no account configuration.
const fs = require("node:fs");

function evaluate(command) {
  if (typeof command !== "string" || !command) return null;
  if (/(runpodctl|runpod\s+(create|api)).*\bpod\b.*\bcreate\b/.test(command) || /runpodctl\s+pod\s+create/.test(command)) {
    return "RunPod pod create — billing-critical. Confirm one-shot creation and target GPU.";
  }
  if (/(auto-validate\.sh|retry-validate\.sh)/.test(command)) {
    return "Auto/retry validation script — explicit confirmation required.";
  }
  if (/(nohup|disown|&\s*$)/.test(command) && /runpod|start-pod\.sh/.test(command)) {
    return "Background loop touching RunPod — explicit confirmation required.";
  }
  if (/(while|for)\b/.test(command) && /pod\s+create/.test(command)) {
    return "Loop over pod create — explicit confirmation required.";
  }
  return null;
}

function main() {
  let reason;
  try { reason = evaluate(JSON.parse(fs.readFileSync(0, "utf8")).tool_input?.command); }
  catch { reason = "RunPod guard input could not be verified."; }
  if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason,
  } }) + "\n");
}

module.exports = { evaluate };
if (require.main === module) main();
