const assert = require("node:assert/strict");
const gate = require("./session-contract-gate.cjs");

for (const command of [
  "git branch new-name",
  "git branch -f main HEAD~1",
  "git branch --delete topic",
  "git checkout -b topic",
]) assert.equal(gate.readOnlyShell(command), false, command);

for (const command of [
  "git status --short",
  "git diff --stat",
  "git log -1",
  "git show HEAD:README.md",
  "git rev-parse --show-toplevel",
  "Get-Content AGENTS.md",
]) assert.equal(gate.readOnlyShell(command), true, command);

console.log("session contract gate tests passed");