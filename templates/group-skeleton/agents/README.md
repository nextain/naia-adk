# Group Agent Seats (`agents/`)

List each role-holding AI agent seat in `group_config.agents[]` inside `adk.json`. Real running instances are group ADKs, and each agent seat is a folder `agents/<id>-adk/` with `index.md` inside (`agents/<id>-adk/index.md`).

## Rules

- Each agent has a unique `id`, a short `role` word (e.g. `developer`, `marketer`, `business`, `support`), and a non-empty `description`.
- `seat` is the relative path to the agent's seat directory inside the group ADK (default when omitted: `agents/<id>-adk`). It must be a relative path under `agents/` without `..` or `keys/`.
- When the seat folder exists, the agent's entry document `file` should live inside its seat at `agents/<id>-adk/index.md` (if `file` points outside an existing seat folder, `--check` emits a warning `agent doc should live in its seat`). For agents whose seat folder is not created yet, keep `file` pointing at `agents/README.md` or omit `file`.
- In `--check` mode:
  - If the seat folder does not exist yet (`marketer-agent`, `business-agent`, `support-agent` in this skeleton), it is reported as an open slot `seat not created` (warning, not error).
  - If the seat folder exists without `adk.json` (`agents/developer-agent-adk/` in this skeleton), it is reported as an open slot `seat without manifest` (warning, not error).
  - If the seat folder contains `adk.json`, that manifest must be valid with `kind: "agent"` (and `id` equal to `<id>` or `<id>-adk`) to count as `seats ready`.
- `bot.status` is one of `"planned"`, `"active"`, or `"none"`. Planned bots are reported as open slots by `adk-link.mjs --check`.
- `bot.credential_ref` is a short reference label only (never a raw token and never a path into `keys/`).
- Group keys live only in the isolated `keys/` directory and are injected into server sessions via environment variables (`env_only`).

## Running Seats as Sessions

To run each seat as a live agent session on the group development server (pane naming, first role instruction, the per-seat `## 세션` record, message hand-off, and shared-folder rules), follow the Naia ADK guide `docs/guides/agent-role-sessions.md`.
