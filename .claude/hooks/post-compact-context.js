// PostCompact / SessionStart hook: re-read project context — Claude Code adapter.
// THIN ADAPTER. Canonical message lives in the tool-agnostic core:
//   .agents/hooks/core/harness-core.js → compactReminderMessage()
// Generic for all naia-adk forks — subprojects add their own specifics.
// (G-OC01 part1, scope A — pure refactor, behavior byte-identical.)
const path = require("path");
// Fail-safe: a missing/broken core must not error the session.
let core;
try {
  core = require(path.join(__dirname, "..", "..", ".agents", "hooks", "core", "harness-core.js"));
} catch {
  process.exit(0);
}

console.log(JSON.stringify({
  additionalContext: core.compactReminderMessage(),
}));
