# Naia ADK

AI development infrastructure for a solo developer. This repository is the
public base of the fork chain `naia-adk → {org}-adk → {user}-adk`.

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

## Session Boundaries

These shared entrypoints are repository indexes. They do not contain a work
goal, issue state, implementation sequence, completion claim, or artifact
wording.

Mutation authority comes from one explicit local contract in
`.agents/session-contracts/`. The registry pointer, contract digest,
`session_bindings`, and referenced progress record must agree. Progress
records do not grant authority, and parent or child projects are never searched
for an implicit binding. Read-only investigation remains available while
unbound.

Background context constrains agent work; it is not artifact content unless an
explicit source atom grants `derive`, `quote`, or `require` authority for
the declared output audience.

## Safety Boundaries

Follow `.agents/context/agents-rules.json` for authorization, destructive
actions, external communication, secrets, validation, and lifecycle rules.
Concurrent contracts must declare non-overlapping `target_ownership` paths.

## Mirrors

`AGENTS.md` is canonical. `CLAUDE.md` and `GEMINI.md` must be
byte-identical mirrors. Validate the candidate before synchronization with
`node .claude/hooks/sync-entry-points.js --check`.
