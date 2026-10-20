# Group ADK Skeleton (`kind: "group"`)

This directory is the public skeleton for a Naia ADK 2.0 **group** instance (a team, company, or customer working together). All values use role-word placeholders (`example-group`, `group-owner`, `member-a`, `developer-agent`).

- **Human entry**: `index.md` (this file)
- **AI entry**: [`AGENTS.md`](AGENTS.md) (`CLAUDE.md` and `GEMINI.md` point to `@AGENTS.md`), with mandatory context in `.agents/context/agents-rules.json` and `.agents/context/project-index.yaml`.

## How to Fill This Skeleton

1. **Identity (`adk.json`)**:
   - Set `id`, `name`, `owner`, and `responsible_human` (must match one `group_config.members[].user_id`).
2. **Members (`group_config.members[]` & `members/`)**:
   - Replace placeholder `user_id` entries (`group-owner`, `member-a`, `member-b`) with your group's member identifiers.
   - Change `access` from `"unset"` to `"owner"`, `"admin"`, `"member"`, or `"viewer"`.
3. **Calendar & Milestones (`group_config.calendar` & `calendar/`)**:
   - Define milestones with unique `id`, `name`, `due` (`YYYY-MM-DD` or `null`), and `done_when`.
   - Optionally set `work_docs_dir` to validate work documents (`마일스톤:`, `기한:`, and `## 할 일` table).
4. **Projects & Services (`group_config.projects[]` & `projects/`)**:
   - Fill canonical repository URLs/paths and change `repo_status` from `"undecided"` to `"canonical"`.
5. **Agent Seats (`group_config.agents[]` & folder `agents/<id>-adk/` with `index.md`)**:
   - Real running instances are group ADKs, and each agent seat is a folder `agents/<id>-adk/` with `index.md` inside (`group_config.agents[].seat`, defaulting to `agents/<id>-adk`, and `group_config.agents[].file` set to `agents/<id>-adk/index.md` when the seat folder exists).
   - Missing seat directories are reported as `seat not created` (warning), seat directories without `adk.json` (like the example `agents/developer-agent-adk/`) are reported as `seat without manifest` (warning), and seats with a valid `kind: "agent"` `adk.json` count as `seats ready`.
   - Configure each agent role seat and update `bot.status` from `"planned"` to `"active"` (or `"none"`). Keep actual bot tokens inside isolated `keys/` only and reference them by label in `bot.credential_ref`.

## Verification

```bash
node scripts/adk-link.mjs --check templates/group-skeleton
```
