[English](adk-2.0-structure.en.md) | [한국어](adk-2.0-structure.md)

Scope: common
Status: 1st edition (2026-10-21). The common part of Naia ADK 2.0, the parts
instances override, the 4-layer role structure, and the promises naia-shell
receives, in one place.

# Naia ADK 2.0 structure at a glance

Naia ADK is the base edition that packs "how AI reads and follows work" into
one repository. Companies, teams, and individuals take this base edition,
build their own instance on it, and pull again when the base improves. Three
things changed in 2.0:

1. Units of collaboration are split into **four kinds**
   (user · group · agent · project), distinguished by the manifest
   `adk.json`'s `kind`.
2. The boundary between **common** (this repository) and **instance overrides**
   (each company/individual repository) is fixed. Common holds no person,
   company, device, or model names — only roles.
3. AI work is divided into **layers 1–4**. Work starts at the lower layers,
   and only what cannot be solved there rises to an upper layer.

## 1. Four kinds

| Kind | `kind` | Skeleton | What goes there |
|---|---|---|---|
| User | `user` | `templates/user-skeleton/` | One person's settings, work docs, groups they belong to |
| Group | `group` | `templates/group-skeleton/` | Company or team: members, permissions, project list, agent seats, channel table, schedule |
| Agent | `agent` | `templates/agent-skeleton/` | A role document, personality, and memory (no work ledger) for one AI role |
| Project | `project` | `templates/project-skeleton/` | One thing being built: spec chain, source, tests |

How to connect them is in [the four-kind ADK skeleton](adk-four-kinds.en.md);
how to launch agent seats as live sessions is in
[role session operations](agent-role-sessions.md).

## 2. Common vs instance overrides

| Area | Common (this repo) | Where instances override |
|---|---|---|
| Entrypoint | `AGENTS.md` (canonical), one-line `CLAUDE.md` · `GEMINI.md` | Instance adds only its own index to its `AGENTS.md` |
| Rules | `.agents/context/` (one-line rules, path tables, terminology), `rules/` (rule catalog) | `FORK.md`: facts stable for that instance only |
| Role models | Only the conditions roles and models must meet (e.g. "a review model from a different family than implementation") | Actual models and accounts, in an override location like `FORK.md` |
| Skills · schemas · skeletons | `skills/`, `.agents/skills/`, `schemas/`, `templates/` | Instance-only skills live in the instance repository |
| Check tools | `scripts/` (link check, context budget, OSS-readiness checks, …) | Used as-is, not modified |
| Display defaults | `naia-settings/` (character · background · music default bundles) | Instance changes or adds files; folder names stay |
| Company · people data | None (only role-word placeholders) | `data-company/`, group ADK member/channel tables |
| Keys · secrets | None | `keys/` (excluded from git, never linked) |
| Work records | None | `.agents/progress/`, work docs in `docs/` |

How to keep the boundary:

- Never write person names, company names, device names, or actual model
  names into common. Mark common documents with `Scope: common` at the top
  and use placeholders like `alice`, `company-a`, `<member>` in examples.
- To change a common rule for an instance, propose it to this repository and
  fix common — do not touch the instance-side file. Values that belong only
  to that instance go to `FORK.md`.
- Before going public, all mandatory checks of
  `node scripts/oss-readiness.mjs .` (secret values, personal data, personal
  paths, internal leaks, tracked-but-ignored files) must pass.

## 3. Layers 1–4

Layer numbers count from the bottom up (reorganized 2026-10-20). Documents
written before 2026-10-20 count top-down, so old numbers are flipped:
layer 1↔4, layer 2↔3. File, script, and config key names (`layer4-*`,
`l4-*`, `tier1_*`, `tier4_*`) keep the old names for compatibility.

| Layer | Does | Model condition | Rules |
|---|---|---|---|
| Layer 1 sensor | Watches messenger, work completion, silence, and document memos; wakes upper layers only when needed | No model, or a light fast model, two alternating providers | [`rules/layer4-sensor-and-memo-loop.md`](../../rules/layer4-sensor-and-memo-loop.md) |
| Layer 2 execution · review | Implementation and independent review | Implementation and review models are from different families | [`rules/evidence-driven-process.md`](../../rules/evidence-driven-process.md) |
| Layer 3 coordination | Role sessions: analyze, plan, delegate, judge results. No mass implementation directly | Upper coordinating model | [`rules/multi-cli-account-management.md`](../../rules/multi-cli-account-management.md) |
| Layer 4 advisory | Adversarial review by an upper reasoning model, only for hard problems layer 3 cannot solve or on user request (one family among several) | Upper reasoning model | [`rules/evidence-driven-process.md`](../../rules/evidence-driven-process.md) §3.4 (the `/top-model-review` skill still lives only in instances) |

## 4. Lineage and sync

- The base edition number lives in `VERSION` and in `adk.json`'s
  `adk_version` (now `2.0.0`).
- Instances record the upstream repository (`upstream_repo`), the last commit
  they matched (`upstream_commit`), and the edition at that time
  (`upstream_version`) in `.agents/upstream-sync.yaml`. If that value does not
  match the actual common ancestor, it is drift.
- Group/user ADK manifests record the base edition they were built from in
  `base_commit`.
- Sync with the `sync-upstream` skill; on conflict, the upstream repository
  structure wins first (`conflict_policy: upstream-structure-first`).

## 5. What naia-shell relies on

naia-shell (the desktop app) does not clone this repository directly. A fresh
install receives `nextain/naia-template-project`, and when finding an
existing workspace it checks the following. Do not change this list when
editing common:

1. Workspace detection: `AGENTS.md` or `CLAUDE.md`,
   `.agents/context/agents-rules.json`, and a `package.json` whose `name` is
   exactly `naia-adk`. All three must exist.
2. Search locations: `projects/naia-adk`, `naia-adk`, the home folder, `~/dev`.
3. Display assets: the `vrm-files`, `background`, `bgm-musics`, `nva-files`
   folder names under `naia-settings/`, plus the default character file name.
4. Skills: `skills/<name>/SKILL.md` and its frontmatter format.
5. Path table: `.agents/context/project-index.yaml` must be readable YAML.

`adk.json` and `VERSION` are not read by naia-shell. For a common cleanup to
reach app users, the same change must also be reflected in
`naia-template-project`.

## 6. Applying 2.0 to an instance, in order

1. Set `VERSION` and `adk.json` (`kind`, `adk_version`, `base_commit`).
2. Match `.agents/upstream-sync.yaml` to the actual common-ancestor commit.
3. For a company/team, build a group ADK (`kind: group`) and record agent
   seats and members.
4. Record role-specific actual models, accounts, and devices only in
   `FORK.md`.
5. Move rule files copied from common and rewritten back to common; keep only
   the differing parts in `FORK.md`.
6. Run the checks below.

```bash
node scripts/adk-link.mjs --check <ADK folder>
node scripts/check-context-budget.mjs
node .claude/hooks/sync-entry-points.js --check
node scripts/oss-readiness.mjs .
```
