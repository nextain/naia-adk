# Example Group ADK (`example-group`)

This repository is a Naia ADK 2.0 **group** instance (`kind: "group"`). It holds shared group members, projects, role-based AI agent seats, messenger channel bindings, and schedule/work documents using role-word placeholders (`example-group`, `group-owner`, `member-a`, `developer-agent`).

## Mandatory Reads

Read these before acting in this group ADK:

1. `.agents/context/agents-rules.json`
2. `.agents/context/project-index.yaml`
3. `index.md`

## Structure Map

- `adk.json`: Group ADK manifest (`kind: "group"`, `group_config` for members, projects, agents, calendar, channels).
- `index.md`: Human-facing overview and registration tables for the group ADK.
- `members/`: Member profile documents (`group-owner`, `member-a`, `member-b`).
- `projects/`: Project and 1-level sub-service documentation.
- `agents/<id>-adk/`: Role-holding agent seats (each seat is a folder `agents/<id>-adk/` with `index.md` inside, e.g. `agents/developer-agent-adk/index.md`).
- `calendar/`: Group milestone definitions (`calendar/milestones.example.json`).
- `docs/work/`: Document-based work items (one work document per task; document ID = work ID).
- `channels.yaml`: Role-based messenger channel wake and primary-role table (no raw numeric IDs or tokens).
- `keys/`: Isolated group secret directory (gitignored, never linked, injected into server sessions via environment variables only).

## Core Rules

1. **No Secrets in Repository**: Never commit tokens, passwords, API keys, or raw messenger numeric IDs. Keep secret material in the encrypted vault / isolated `keys/` directory (excluded from git) and use short `credential_ref` labels in manifests.
2. **Privacy & Group Isolation**: Keep real member names and internal details inside private group ADK instances only; never mix data, memory, or channels across different groups.
3. **Git for Source, Work Docs for Tasks**: Use git for source and document version control; track work in `docs/work/*.md` (one document per work item, front matter with `마일스톤:` and `기한:`, and a `## 할 일` table).
4. **Human Approval Boundary**: Production environment changes, payments/billing, and external communications require explicit human approval (`responsible_human`).
