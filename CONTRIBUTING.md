[English](CONTRIBUTING.md) | [한국어](CONTRIBUTING.ko.md)

<!-- Copyright 2026 Nextain Inc. -->

# Contributing to Naia ADK

How to contribute to Naia ADK, for AI agents and for people using AI tools.
The rules AI agents refer to live in [`.agents/context/`](.agents/context/);
the detailed human-readable mirror lives in [`.users/context/`](.users/context/).

## Language

Write issues, PRs, and discussions in whatever language you are comfortable
with; AI mediates the communication. Keep the git record in English.

| Target | Language |
|--------|----------|
| Code and context files | English |
| Commit messages | English |
| Issues / PRs / discussions | Free |

## Read before starting

New contributors (AI agents included) read these files in order:

1. `.agents/context/agents-rules.json` — core project rules (single source of truth)
2. `.agents/context/ai-work-index.yaml` — workflow index by work type
3. `.agents/context/project-index.yaml` — entrypoint index by submodule

When working inside a submodule, read that submodule's entrypoint rules first.

## Development flow

Feature work defaults to issue-driven development. The big picture is:

```
issue → plan → implement (tests first) → verify → clean up → commit
```

The full flow and approval gates are documented in [AGENTS.md](AGENTS.md),
the [work index](.agents/context/ai-work-index.yaml), the
[skill index](.agents/context/skills-index.yaml), and
[`.agents/workflows/`](.agents/workflows/). The core rules:

- **Tests first** — write a failing test (RED) first, then the minimal
  implementation (GREEN), then refactor.
- **Verify by actually running it** — type checks are not enough. Boot the app
  or server and check the behavior.
- **Minimal changes** — change only what is needed. Avoid sweeping refactors.

## Contribution procedure

1. **Issue first** — create or pick a GitHub issue before coding.
2. **Fork and branch** — work on a branch named `issue-{number}-{description}`:

   ```bash
   git clone https://github.com/nextain/naia-adk.git
   cd naia-adk
   git checkout -b issue-{number}-{description}
   ```

3. **Tests** — write tests and verify them before opening a PR.
4. **Single PR** — bundle code, tests, and related context changes into one PR.

### PR title

```
type(scope): description
```

Types: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`.

### Checklist

- [ ] Tests pass
- [ ] Verified by actual execution
- [ ] Context files updated together when the architecture changed

## Skill contributions

A skill is defined by a single `SKILL.md` file with YAML frontmatter.

- **Location** — `.agents/skills/{skill-name}/SKILL.md` (source of truth)
- **Mirror** — skills humans need to read are mirrored at
  `.users/skills/{skill-name}/SKILL.md`. Not every skill is mirrored; only
  some are today.
- **Names** — kebab-case, no prefix (e.g. `review-pass`, `merge-worktree`)
- **Registration** — after adding one, run `/manage-skills` to register it in
  the entrypoint docs.
- **Verification** — invoke it directly as `/<skill-name>` in a live session.

## Context contributions

`.agents/` is the source and `.users/` is the human-readable mirror. When you
change a rules file, update the mirror together (propagation order:
self → parent → siblings → children → mirror).

The intended license for AI context files is CC-BY-SA 4.0 (the `license` entry
in [`.agents/context/contributing.yaml`](.agents/context/contributing.yaml)).
Most context files currently carry only a `Copyright 2026 Nextain Inc.` style
header and do not yet match the per-file SPDX header notation. New files follow
the existing header convention of neighboring files.

## Contribution types

Translations, skills, features, bug reports, code/PRs, docs, tests,
design/UX, security reports, and context work are all welcome.

## License

Code contributions follow Apache License 2.0; context contributions follow
CC-BY-SA 4.0.

## Contributor License Agreement

Before we can merge your pull request:

1. **Individual contributors:** sign the [Individual CLA](CLA.md) once through
   the automated CLA check on your first pull request.
2. **Contributing on behalf of an employer or company:** your company must sign
   the [Corporate CLA](CLA-CORPORATE.md) (covering the company and its
   Affiliates) and list your GitHub account as a designated contributor, and
   you must also confirm agreement to [CLA.md](CLA.md) (including Section 4 on
   moral rights) and name the company in your pull request.
3. **Trivial documentation or formatting changes** (typos, broken links, or
   formatting-only edits of 10 lines or fewer that contain no functional code):
   after signing the [Individual CLA](CLA.md) (or
   [Corporate CLA](CLA-CORPORATE.md)) (or, for a first-time trivial change, by
   expressly submitting under Sections 1 to 6 of [CLA.md](CLA.md) as quoted
   below), you may sign off commits with a `Signed-off-by:` line
   ([DCO](https://developercertificate.org/)). Submitting with a
   `Signed-off-by:` line in this repository confirms that the contribution is
   governed by Sections 1 to 6 of [CLA.md](CLA.md) as well as the DCO; a DCO
   sign-off never replaces the CLA. For a first-time trivial pull request,
   include the following line in the pull request description:
   > `By adding Signed-off-by for this trivial change, I agree that this commit is governed by Sections 1 to 6 of CLA.md.`

Do not contribute code that you cannot license under these terms. Patent
questions: see [`PATENTS.md`](PATENTS.md).
