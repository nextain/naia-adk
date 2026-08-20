[한국어](README.md) | [English](README.en.md)

# Naia ADK

**A pre-arranged workspace scaffold for AI coding agents to work in.**

When you use AI coding tools like Claude Code or Codex, every tool keeps its rule
files in a different place, and questions like "can this document be published?"
or "where do skills go?" get answered ad hoc. Naia ADK lays out that skeleton in
advance. Just as you set up a dev environment on a new laptop, it hands an AI
agent a tidy desk to start from. It also ships a dashboard so you can see the
workspace state at a glance.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

## Up and running in 5 minutes

You need **Node 22+** and **pnpm 9+**.

```bash
pnpm install    # install workspace dependencies
pnpm dev        # run the API server (:3141) and dashboard (:3142) together
```

Open `http://localhost:3142` in your browser to see the dashboard. Three things
are visible right away:

- **Workspace** — projects and submodules, the file tree, and each item's
  disclosure level.
- **Skills catalog** — the list of skills registered in this workspace, and their
  content.
- **Settings / monitoring** — server config, client status, data directories.

The dashboard forwards `/api/*` requests to the API server on port 3141. To run
just one of them, use `pnpm dev:server` (→ 3141) or `pnpm dev:dashboard`
(→ 3142). The launcher scripts `./start.sh` (Linux/macOS) and `start.bat`
(Windows) both run `pnpm dev`. The server CLI accepts `--port`, `--host`, and
`--root`; for example, point it at another workspace with
`pnpm serve -- --root /path/to/workspace`.

## What's inside

### The workspace scaffold

It gives an AI agent a set of directories with fixed places for everything, so it
can start working immediately. AI-facing context lives in `.agents/` (English,
JSON/YAML), and a human-readable mirror lives in `.users/` (Korean, Markdown).
That mirror is partial, not a full copy — it holds the documents a human needs
to read (for example, skills are canonical under `.agents/skills/`, and only some
are mirrored into `.users/skills/`). Skills, data, and projects all have
designated locations, so the workspace looks the same no matter which tool opens
it.

### Dashboard and API

A Next.js dashboard manages the workspace visually, backed by a Fastify API
server. The API exposes workspace metadata (`/api/workspace`), the skill catalog
(`/api/skills`), file read/write (`/api/files`), and a WebSocket that streams
file-change events (`/api/ws`). Thanks to this API, programs other than the
dashboard can reach the workspace too.

### Skill system

Repeated tasks are bundled into reusable skills. Each skill is defined by a single
`SKILL.md`, and the API server scans `skills/` to build the catalog. If even one
skill violates the format, the whole catalog throws an error (fail-closed): rather
than silently dropping the broken skill and serving the rest, the operator is made
to fix it on the spot. It's a deliberate choice to prevent shipping an
incomplete catalog by accident.

### What is in the skill tree today

The skills fall into four groups. So that a session does not have to reread
every `SKILL.md` to find out what exists, `.agents/context/skills-index.yaml`
carries one line per skill saying what it does and when to reach for it. The
list below is that index's table of contents.

**Documents and outward work** — things a person will read.
`doc-coauthoring` (specs, proposals, design documents), `read-doc`,
`translate-doc`, `press-release`, `weekly-report`, `copyright-reg`,
`patent-draft` and `patent-pipeline`, `youtube-upload` (video and subtitles).

**Running the workspace** — the hands that touch the repository itself.
`project-create`, `project-migration`, `merge-worktree`, `migrate-ctx`,
`session-resume`, `sync-upstream`, `manage-skills`, and `secret-vault` for the
encrypted secret vault.

**Verification gates** — the places that ask for evidence instead of a claim.
`verify-implementation`, `verify-contract-conformance`,
`verify-request-contract`, `verify-product-preservation`,
`verify-benchmark-contract`, `verify-review-gate`, `webapp-testing`, and
`review-pass` for adversarial review.

**Operations and experiments** — work that reaches outside or handles models.
`manage-discord-sessions` for the Discord gateway, `payroll`, and
`finetune-persona` for character LoRA training.

Start a new skill from `SKILL_TEMPLATE.md`, and add its line to the index once
it exists. When the index drifts from the tree, the next session rebuilds a
skill it already had.

### Rules and minimum governance

Even a workspace you use alone needs some minimal rules the moment AI and
automation touch it. Naia ADK separates `read`, `write`, `execute`, and `publish`
as distinct concerns, and attaches a disclosure level to each document.
Hard-to-undo actions — production changes, secret handling, public-facing
claims — are split off from ordinary local edits and routed through approval
gates.

Disclosure has four levels. `public` is safe to ship as-is to a public site or
open-source repo; `controlled` can be shared externally after review; `internal`
stays inside the workspace; `confidential` covers sensitive material like
contracts, credentials, and personal data. Credentials usually live outside git,
but by level they are still `confidential`.

> **Session-contract enforcement ships disabled in this release.** A
> `.claude/no-harness` marker is committed, so the session-contract gate blocks
> nothing. With it on, a session without a contract is blocked from every mutating
> shell command — including `npm test` — so a fresh clone cannot even run its own
> test suite. The file-edit path was opened up for that same reason; the shell path
> has not been given the same treatment yet. Force-push, destructive-git, deploy, and
> outbound-messaging guards are unaffected and still run. Progress is tracked in
> [#34](https://github.com/nextain/naia-adk/issues/34), with details in
> `.claude/no-harness`. The Session Boundaries section of `AGENTS.md` describes the
> intended design, not current runtime behavior.

### Where secrets live

You cannot commit API keys and certificates to git. But keeping them only on
each laptop means they vanish when the machine changes, and nobody can say who
holds what. Naia ADK threads that needle by committing **exactly one file**: the
folder of secrets, archived and encrypted. The decrypted contents are never seen
by git at all.

Concretely, the `key/` folder is tarred and encrypted with
[age](https://github.com/FiloSottile/age) into a single `key.age`. `key/` is in
`.gitignore`, so it cannot be committed by accident. The only thing that ever
lands in a commit is `key.age`.

A person types the passphrase. The AI neither receives it nor enters it on
anyone's behalf. So opening and sealing the vault happen in the user's own
terminal, while the checks and the backup — which need no passphrase — can be
delegated. That boundary is drawn command by command inside the skill.

```bash
bash .agents/skills/secret-vault/scripts/vault.sh init     # create a vault in a new repo
bash .agents/skills/secret-vault/scripts/vault.sh unlock   # open it (passphrase)
bash .agents/skills/secret-vault/scripts/vault.sh lock     # seal it again (passphrase)
bash .agents/skills/secret-vault/scripts/vault.sh status   # is the backup current?
bash .agents/skills/secret-vault/scripts/vault.sh sync     # commit key.age and push
```

`status` exists because the mistakes have a fixed shape. You add a key and
forget to seal it, or you seal it and forget to push, or a temporary file is
left behind. `status` looks for all three at once. When someone asks whether the
keys are backed up, answer with that command rather than from memory.

`lock` writes the new ciphertext, **decrypts it again to check**, and only then
replaces the old file — so a half-finished seal never leaves a broken vault.

The pattern's standard consumer is a private repository such as `data-private`,
but any repository with a `key.age` and a gitignored `key/` can use it. Override
`VAULT` and `PLAIN_DIR` to rename either side.

### LLM adapter (naia-anyllm)

For features that need to reach an LLM, the `naia-anyllm` adapter is built in. It
connects through the [any-llm](https://github.com/nextain/any-llm) gateway, or
directly to providers such as OpenAI, Anthropic, and Google. It ships with a
default provider config, but to actually make a call you must set that
provider's API key as an environment variable; without the key the adapter
throws right away. To switch providers or models, copy
[`.agents/context/llm-config.yaml.example`](.agents/context/llm-config.yaml.example),
and keep API keys in environment variables, not in the config file (see
[`.env.example`](.env.example)).

## Why it's built this way

### The format is the contract

The heart of Naia ADK is not a particular tool but a **format**. The directory
layout (`.agents/`, `.users/`, `skills/`, `data-*/`) and the file schemas
(`agents-rules.json`, `SKILL.md`) are a fixed agreement, and any tool that can
read that agreement can consume the same workspace. Claude Code, opencode, Codex,
and naia-agent each read the same workspace without embedding one another's code.
So you can swap tools or mix several, and the workspace keeps working.

The rule enforcement itself is tool-agnostic too. A host-neutral core
(`.agents/hooks/core/`) and policies (`.agents/hooks/policies/`) drive both the
Claude Code hooks and the pi extension with the same rules.

### A personal base before it grows into a team

Naia ADK is strictly single-user, for personal use. Company org charts, tenant
rules, and delegated approval chains belong to a higher layer. What it does give
you is a single place to write down context discipline before the workspace grows
to team or company scale.

When you need team collaboration and shared knowledge, extend to
[Naia Business ADK](https://nextain.io/adk). That extension widens the baseline
into asset, process, and permission governance, and adds team ownership and
delegated approvals.

### The fork chain

Naia ADK is meant to be forked into your own. Individuals fork `naia-adk`
directly; organizations go through `naia-business-adk` to instantiate company and
member workspaces.

```
naia-adk                  ← personal base (public, Apache 2.0)
  └── {org}-adk           ← org fork: company data + business submodules
        └── {user}-adk    ← personal fork: personal data + project submodules
```

Nextain's actual chain runs
`naia-adk → naia-business-adk → nextain-adk → alpha-adk`.

## Structure

The repository divides into runtime code (`packages/`), rules and context
(`.agents/`, `.users/`), skills (`skills/`, `.agents/skills/`), and the data
directories each fork fills in.

| Directory | Purpose |
|-----------|---------|
| `.agents/` | AI-facing context (English, JSON/YAML) — single source of truth for rules |
| `.users/` | Human-readable mirror (Korean, Markdown) |
| `.claude/` | Claude Code config, hooks, skill symlinks |
| `skills/` | Operational/runtime skills (served by the dashboard API) |
| `scripts/` | Utility scripts |
| `templates/` | Document templates |
| `docs/` | Architecture docs, design specs |
| `packages/` | Runtime packages (pnpm workspace) |

### Runtime packages (packages/, 10 of them)

Three are actual running programs; the rest are thin packages that define formats
and specs.

- `core` — the engine that parses the workspace and skills.
- `server` — the Fastify REST/WebSocket API.
- `dashboard` — the Next.js dashboard UI.
- `skill-spec` — the tool-agnostic skill format contract (`SkillDescriptor`,
  `SkillLoader`).
- `skills-builtin` — the generic skills catalog.
- `openclaw-compat` — a tool that migrates OpenClaw skills into the naia format.
- `persona` — the system-prompt convention spec.
- `process` — the workflow pattern spec (review → decide → execute, issue-driven
  development, and so on).
- `naia-anyllm` — the any-llm gateway / direct-provider LLM adapter.
- `artifacts-spec` — the standard schema for permission (RBAC) and development
  lifecycle (SDLC) artifacts. It defines 15 artifact types as JSON Schema and
  specifies, for each, whether the instance is git-tracked or session-scoped.

### Data directories (gitignored, filled per fork)

These four never get committed. Whoever forks the repo fills in their own data.

| Directory | Scope | Content |
|-----------|-------|---------|
| `data-company/` | Company | Company-wide docs, shared resources |
| `data-teams/` | Team | Team documents (strategy, accounting, etc.) |
| `data-private/` | Personal | Personal data, env files, private docs |
| `projects/` | Personal | Project repos (submodules) |

### Two skill trees

Skills live in two places, consumed by different parties.

- `.agents/skills/` — AI-assist and workflow skills. Claude Code uses them via the
  `.claude/skills/` symlink. Includes review (`review-pass`), verification
  (`verify-implementation`), worktree merge (`merge-worktree`), document
  extraction (`read-doc`), business skills like patent/copyright/payroll, and
  others such as `finetune-persona`, `secret-vault`, and `youtube-upload`.
- `skills/` — operational/runtime skills. The API server scans
  `skills/**/SKILL.md` and serves them to the dashboard. These include email/SMS/
  notification sending, channel management, service and web monitoring, and
  document generation; `skills/business/` holds org skills such as
  `press-release`.

The most accurate list is the skill catalog in the dashboard. A text table is
also kept in [AGENTS.en.md](AGENTS.en.md#skills).

## Getting started

### Personal

1. Fork `naia-adk` into your own account (private if you can).
2. Clone it: `git clone https://github.com/YOUR-USER/your-adk.git && cd your-adk`
3. Add the upstream: `git remote add upstream https://github.com/nextain/naia-adk.git`
4. Create data directories: `mkdir -p data-private projects`
5. Add projects, configure `.agents/`, and start working.
6. Sync periodically: `git fetch upstream && git merge upstream/main`

### Company

1. [Contact us](https://nextain.io/contact) for access to `naia-business-adk`.
2. Fork `naia-business-adk` privately into your org account, then clone it.
3. Add the upstream: `git remote add upstream https://github.com/nextain/naia-business-adk.git`
4. Fill in company data and project submodules: `mkdir -p data-company projects`,
   `git submodule add <repo> projects/<name>`
5. Each member forks the org ADK again as their personal workspace.

### Naia OS integration (optional)

If you use the [Naia OS](https://github.com/nextain/naia-os) desktop app, point
its workspace path at your ADK directory. Skills and data are served over the API.

## Contributing

Write issues, PRs, and discussions in whatever language you're comfortable with;
AI mediates the communication. Just keep the git record (commits, context, shared
artifacts) in English. For the full process and rules, see
[CONTRIBUTING.md](CONTRIBUTING.md). Development defaults to issue-driven
development; the detailed flow lives in [AGENTS.en.md](AGENTS.en.md) and
[`.agents/workflows/`](.agents/workflows/).

## Roadmap

The following is planned, not a feature that works today.

- **Knowledge atoms** — today's context is file-based, so finding one piece of
  information means loading the whole file and wasting tokens. The idea is to
  break context into the smallest meaningful units, link them with tags, and pull
  out only the exact piece you need. Access would go through the CLI or MCP so it
  stays tool-agnostic.

## License

Apache License 2.0. See [LICENSE](LICENSE) for details.

```
Copyright 2026 Nextain Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0
```

## Links

- **Naia OS** — [github.com/nextain/naia-os](https://github.com/nextain/naia-os)
- **Nextain** — [nextain.io](https://nextain.io)
- **Naia Dashboard** — [naia.nextain.io](https://naia.nextain.io)
