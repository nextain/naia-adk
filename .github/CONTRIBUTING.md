<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->
# Contributing to Naia ADK

> Naia ADK is a **workspace scaffold + governance baseline** for AI-assisted work — a
> structured directory layout, skills, context files, and a dashboard that AI coding
> tools use as their working environment.
> This guide explains *what* you can help with and *how*.

## First time here? — your first contribution in 15 minutes

Don't be intimidated by the workflow below. The Issue-Driven workflow and structure rules
are for **new features**. **Small changes — typos, docs, translations, small fixes — need
none of that**; an issue is enough.

Setup: [Node.js](https://nodejs.org/) 22+, [pnpm](https://pnpm.io/) (`corepack enable`),
then `pnpm install`. The dashboard is Next.js and the other packages are plain TypeScript,
so **no native build tools (Rust, C++) are needed** for most work.

Using an AI coding tool (Cursor, Claude Code, …)? Open this folder and paste:

> Read this repo's `.github/CONTRIBUTING.md`, `README.md`, and `.agents/context/agents-rules.json`,
> then suggest 3 'good first issue' candidates I could finish in 30 minutes, which files to edit
> for each, and whether each needs the full contribution workflow.

Stuck? Ask on [Discord](https://discord.gg/FGYJN7auty).

## 1. No permission needed

Clone the repo and open it in your AI coding tool (Claude Code, Cursor, opencode,
Codex, Gemini CLI, …):

```bash
git clone https://github.com/nextain/naia-adk.git
cd naia-adk
```

Then ask your AI tool, in your own language:

> What is this project, and what is a good first thing I could help with?

The [`.agents/`](../.agents/) directory holds the project's vision, structure, and rules.
Your AI tool reads it and explains the project **in your language**, so you don't have to
read everything first. Stuck? Ask on [Discord](https://discord.gg/FGYJN7auty).

## 2. Any language is welcome

- **Issues, pull requests, discussions** — write in any language; maintainers read via AI translation.
- **Code comments, commit messages, [`.agents/`](../.agents/) context files** — English preferred. If English is hard, submit in your language and a maintainer will help polish it in review.

## 3. The fork chain

Naia ADK is the **base** of a fork chain — you usually *fork* it rather than commit to it directly:

```
naia-adk            ← base (this repo, public, Apache 2.0)
  └── {org}-adk     ← organization fork (company data + business submodules)
        └── {user}-adk  ← personal fork (personal data + project submodules)
```

Contributions to the **base** are improvements that benefit everyone: the scaffold,
skills, context standards, the server, and the dashboard. Fork-specific data (under
`data-*/`, `projects/`) lives in your fork, never here.

## 4. Ways to contribute

| Type | Difficulty | Where to start |
|---|---|---|
| Bug report | low | [GitHub Issues](https://github.com/nextain/naia-adk/issues) with repro steps |
| Docs | low | [`README.md`](../README.md), [`docs/`](../docs/), [`.users/`](../.users/) |
| Translation | low | [`.users/`](../.users/) language mirrors |
| Skills | medium | [`skills/`](../skills/) — reusable AI procedures |
| Dashboard / server | medium–high | [`packages/dashboard`](../packages/dashboard), [`packages/server`](../packages/server) |
| Context / governance | medium | [`.agents/`](../.agents/) — one good context file prevents 100 low-quality AI PRs |

> **Security issues** — do not open a public issue. See the [security policy](SECURITY.md) and email `security@nextain.io`.

## 5. Development

Requirements: [Node.js](https://nodejs.org/) 22+, [pnpm](https://pnpm.io/).

```bash
pnpm install     # install dependencies
pnpm build       # build all packages (pnpm -r build)
pnpm test        # run all package test suites (pnpm -r test)
pnpm dev         # run the server + dashboard together
```

The workspace is a pnpm monorepo: `core` (workspace introspection), `server` (Fastify
API), `dashboard` (Next.js UI), `skill-spec` / `skills-builtin` (skills), plus
adapters like `openclaw-compat` and `naia-anyllm`.

## 6. Contribution workflow

Naia ADK follows **Issue-Driven Development** — for non-trivial changes, capture the
intent first so humans and AI stay aligned:

1. Pick or open a [GitHub Issue](https://github.com/nextain/naia-adk/issues).
2. Make the change. Keep it minimal and never break working code.
3. Add or update tests, and run `pnpm test`.
4. Open a PR with the title format `type(scope): summary` referencing the issue.

**PR checklist**

- [ ] Tests pass (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] Commit messages are in English, `type(scope): summary`
- [ ] No personal/fork data (`data-*/`, machine-specific paths) added

## 7. AI tools

Using AI tools is welcomed and encouraged. If you used one, add a trailer to the commit
message (recommended, not required):

```
feat(server): add workspace skills endpoint

Assisted-by: Claude Code
```

## 8. License

- **Source code** — [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0)
- **AI context** (`.agents/`, `.users/`) — [CC-BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)

By contributing, you agree your contribution is licensed under these terms.
