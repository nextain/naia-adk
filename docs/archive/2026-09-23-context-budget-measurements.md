# Context budget measurements (2026-09-23)

These measurements motivated `token_budget_policy` in
`.agents/context/agents-rules.json` and the read-set budgets in
`.agents/context/context-budget.json`.

- One two-day Claude Code root session averaged 513K input tokens per model
  call and used 63% of a week's input across 16 sessions. The fixed base per
  call (system prompt, tools, entrypoint) was about 55K tokens, so session
  length dominated.
- A downstream workspace kept a 59KB entrypoint mirrored into `AGENTS.md`,
  `CLAUDE.md` and `GEMINI.md`. Grok attached both `AGENTS.md` and `CLAUDE.md`,
  and a 75-minute root session made 131 model calls with 20.3M input tokens;
  per-call input grew from 84K to 216K.
- The rule file grew because each incident appended a lesson section to it.
- Grok 4.7 has a 500K window and compacts at 85% by default; requests above
  200K tokens are billed at the long-context rate, so the user-level
  threshold was set to 36%.
