# Developer Agent Seat (`agents/developer-agent-adk/index.md`)

This folder (`agents/developer-agent-adk/`) is the example seat directory for `developer-agent` inside the group ADK, with `index.md` as its entry document (`agents/<id>-adk/index.md`).

- Because this directory exists without an `adk.json` manifest yet, `adk-link.mjs --check` reports it as an open slot: `seat without manifest`.
- Once the agent ADK (`kind: "agent"`) is initialized here with its own `adk.json` (`id: "developer-agent"` or `"developer-agent-adk"`), the seat counts as ready (`seats ready`).
- To make this seat ready, copy `templates/agent-skeleton/` here (it brings `adk.json`, `AGENTS.md`, `.agents/context/`, `persona/`, and `memory/`).
