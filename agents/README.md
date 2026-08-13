# Agents

This directory contains concrete runtime identities created by a workspace fork.
The public `naia-adk` boilerplate intentionally ships without a concrete agent.

Each `agents/<agent-id>/` directory must contain:

- `AGENTS.md` — identity, behavior, and information-scope instructions.
- `agent.json` — machine-readable runtime and information-scope declaration.

Register every concrete agent in `.agents/context/agent-registry.json` and verify it with:

```bash
node scripts/verify-agent-registry.mjs
```

Keep tokens, webhooks, credentials, customer data, and runtime state out of this directory.
