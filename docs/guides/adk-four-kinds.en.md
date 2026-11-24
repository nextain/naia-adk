[English](adk-four-kinds.en.md) | [한국어](adk-four-kinds.md)

Scope: common
Status: 1st edition. The four-kind (user · group · agent · project) ADK
skeleton layout and how the kinds attach to each other.

# The four-kind ADK skeleton and connections

Naia ADK 2.0 splits the units of collaboration into four kinds. Each kind has
a skeleton under `templates/`, and the manifest (`adk.json`) `kind`
distinguishes them. All checks use the same command:

```bash
node scripts/adk-link.mjs --check <ADK folder>
```

## 1. Four kinds

| Kind | `kind` | Skeleton | What goes there | Work ledger |
|---|---|---|---|---|
| User | `user` | `templates/user-skeleton/` | One person's settings, personal work docs, group memberships | Kept (`docs/work/`) |
| Group | `group` | `templates/group-skeleton/` | Members and permissions, project list, agent seats, channel table, schedule and work docs | Kept (`docs/work/`) |
| Agent | `agent` | `templates/agent-skeleton/` | A role document, personality, and memory for one agent role | Not kept |
| Project | `project` | `templates/project-skeleton/` | One thing being built: spec chain, source, tests | Kept |

Agent ADKs hold no work ledger (manifest `work_ledger_policy`). Work an agent
does is recorded in the work documents of its group or project. Pass the
folder of the user, group, or project that owns the work to
`ledger.mjs --root`; the card is recorded on that role's ledger line. An old
ledger of an agent seat can be read with `list` to compare against the
original card.

## 2. What every skeleton has in common

- Entrypoint document `AGENTS.md`, plus `CLAUDE.md` · `GEMINI.md` holding
  only the one line `@AGENTS.md`
- Human entrypoint `index.md`
- Manifest `adk.json`: `owner`, `responsible_human` (a person),
  `permissions` (allowed/forbidden folders, actions), `links`
- Minimal rules `.agents/context/agents-rules.json` and the path table
  `.agents/context/project-index.yaml`
- `keys/` isolation: excluded from git, never linked, and `keys` must always
  be in the forbidden folders

## 3. How to attach them

| From | What | How | Where |
|---|---|---|---|
| Group | Agent | Copy the agent skeleton into a seat folder inside the group | `agents/<id>-adk/` |
| Agent | Group | Only the group identifier text (no link, to avoid circular connections) | `adk.json` `agent_config.groups` |
| User | Group | Record the identifier and permissions; on the same machine, a relative symlink | `user_config.groups`, `groups/<group>` |
| Group · agent · user | Project | Relative symlink | `projects/<project>` |

### 3-1. Making an agent seat in a group

1. Record the identifier, role, description, and bot seat in the group
   manifest `group_config.agents[]`.
2. Copy the agent skeleton into the seat folder.

   ```bash
   cp -r <naia-adk>/templates/agent-skeleton <group ADK>/agents/<id>-adk
   ```

3. In the copied `adk.json`, set `id` to `<id>-adk` (or `<id>`), and
   `owner` · `responsible_human` · `agent_config.groups` to that group's
   values. Fill the role document into `index.md`.
4. Check that the seat counts as `seats ready` in the group check. A seat
   without a manifest stays `seat without manifest`; a folder-less seat stays
   `seat not created`.

### 3-2. Attaching a project

For a project ADK (`kind: "project"`) on the same machine, attach it with
the link command. The command creates the relative symlink and the `links[]`
entry together.

```bash
node scripts/adk-link.mjs --link --from <group or agent ADK> --to <project ADK>
```

- The link sits at `projects/<project identifier>`. It does not clash with
  the group's `projects/<identifier>.md` intro document.
- When attached from an agent, also record the identifier in
  `agent_config.projects`.
- After receiving on another machine, rebuild the links recorded in
  `links[]` with `node scripts/adk-link.mjs --link <ADK folder>`.
- With no project ADK yet, manage it with the group `projects/<identifier>.md`
  and `group_config.projects[]` only, without links.

### 3-3. Attaching a user to a group

1. Record `group_id` and `access` (matching the group manifest's
   permissions) in the user manifest `user_config.groups[]`.
2. If the group ADK is on the same machine, link it.

   ```bash
   node scripts/adk-link.mjs --link --from <user ADK> --to <group ADK>
   ```

## 4. Rules to keep

- Links use relative paths only. Absolute-path links and links pointing at
  `keys/` fail the check.
- Public skeletons hold only role-word placeholders. Real person names,
  contacts, accounts, device addresses, and secrets live only in private
  instances.
- Agents do not create links into group folders. Membership is recorded as
  identifier text only.
- Do not mix another group's memory, data, channels, or keys.

How to launch agent seats as live sessions is in
[role session operations](agent-role-sessions.md).

The full 2.0 structure (common/instance boundary, layers 1–4, what naia-shell
relies on) is in
[Naia ADK 2.0 structure at a glance](adk-2.0-structure.en.md).
