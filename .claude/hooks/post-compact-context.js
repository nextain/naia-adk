// PostCompact / SessionStart hook: re-read project context
// Generic for all naia-adk forks — subprojects add their own specifics.
const msg = [
  '⚠️ Context compacted or new session started.',
  '',
  'MANDATORY — read before any action:',
  '  1. .agents/context/agents-rules.json',
  '  2. .agents/context/project-index.yaml',
  '',
  'If working inside a subproject (projects/<name>/):',
  '  Read projects/<name>/AGENTS.md FIRST.',
  '  Do not assume context from root — each subproject carries its own truth.',
  '',
  'Context placement rule:',
  '  Root context  → .agents/context/ or CLAUDE.md',
  '  Project context → projects/<name>/AGENTS.md or .agents/context/',
  '  Do NOT cross-pollinate.',
].join('\n');

console.log(JSON.stringify({
  additionalContext: msg,
}));
