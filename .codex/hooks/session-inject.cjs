#!/usr/bin/env node

const path = require("path");
const core = require(path.join(__dirname, "..", "..", ".agents", "hooks", "core", "harness-core.js"));

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
  const result = core.buildSessionInject({
    cwd: input.cwd || process.cwd(),
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
