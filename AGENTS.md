# Naia ADK

AI development infrastructure for a solo developer. This repository is a
public, forkable governance baseline. Individuals may fork it directly; an
organization may maintain a separate organization-family fork and its own
descendant workspaces. Those are two possible lineages, not one required chain.

## Repository Index

- Repository structure, fork rules, and RBAC: `.agents/context/repo-structure-standard.yaml`
- Work type to workflow routing: `.agents/context/ai-work-index.yaml`
- Context and subproject index: `.agents/context/project-index.yaml`
- AI skill index: `.agents/context/skills-index.yaml`
- Product requirement index: `.agents/requirements/_index.yaml`
- Fork-specific additions belong in `FORK.md`, not this shared entrypoint.

## Mandatory Reads

Read these before acting in this repository:

1. `.agents/context/agents-rules.json`
2. `.agents/context/ai-work-index.yaml`
3. `.agents/context/project-index.yaml`
4. `.agents/context/terminology.yaml`

When planning or reviewing feature-level work, also read
`.agents/requirements/_index.yaml` and `.agents/context/skills-index.yaml`.

## Context Routing

Load only the on-demand context sections selected by
`.agents/context/project-index.yaml`. Before any action inside a nested
project, read that project's own entrypoint and mandatory context. A parent
workspace does not substitute for a nested project's rules.

Durable repository rules belong in `.agents/context/`. Per-work execution
evidence and handoff state belong in `.agents/progress/`.

Agents resend this file, every file they read, and the whole conversation on
every model call. A root session coordinates; investigation and edits run in
fresh contexts (subagents or one-shot headless calls) that return a summary.
Waiting and watching is a script, not a model session. Read long output in
slices. Rules: `.agents/context/agents-rules.json` `token_budget_policy`.

Rule files hold prohibitions and requirements, one line each. Incident
lessons, procedures, and measured history go to `docs/` (history to
`docs/archive/`) with a one-line rule and a link. Never append an incident
section to a rule file. `.agents/context/context-budget.json` sets byte budgets
per read set; when a set is over, split content instead of raising the budget.

## Session Boundaries

These shared entrypoints are repository indexes. They do not contain a work
goal, issue state, implementation sequence, completion claim, or artifact
wording.

An unbound session may create and edit ordinary reversible files inside its
resolved project boundary and may run policy-approved routine local commands
such as inspection, tests, builds, and non-destructive Git work. Governance and
host-policy files, these shared entrypoints, deletion, destructive or remote
commands, external effects, and changes that could expand the session's own
authority require one explicit local contract in `.agents/session-contracts/`.
When bound, the registry pointer,
contract digest, `session_bindings`, and referenced progress record must agree.
Progress records do not grant authority, and parent or child projects are never
searched for an implicit binding.

Background context constrains agent work; it is not artifact content unless an
explicit source atom grants `derive`, `quote`, or `require` authority for
the declared output audience.

## Safety Boundaries

Follow `.agents/context/agents-rules.json` for authorization, destructive
actions, external communication, secrets, validation, and lifecycle rules.
Concurrent contracts must declare non-overlapping `target_ownership` paths.

## Mirrors

`AGENTS.md` is canonical and stays under 12,000 bytes. `CLAUDE.md` and
`GEMINI.md` are the one-line import `@AGENTS.md`, so tools that attach both
files do not pay for the text twice. Validate with
`node .claude/hooks/sync-entry-points.js --check`.
