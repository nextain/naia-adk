# naia-settings

Fork-root, backup-unit settings for the Naia workspace. **Canonical (정본)**
location consumed by `naia-agent`.

## `llm.json` — LLM role configuration (SoT)

3-role object. Each role is `{ provider, baseUrl, model }` plus optional
`apiKeyRef` (keyed providers) and `dims` (embedding role).

| Role | Purpose | Consumed by |
|---|---|---|
| `main` | The conversational Agent LLM | `naia-agent` direct mode (drives the running agent) |
| `sub` | Reviewer / auxiliary subagent LLM | subagent calls (two-tier) |
| `embedded` | Embedding model for memory recall | memory host / conversational recall |

```jsonc
{
  "version": 1,
  "main":     { "provider": "openai-compat", "baseUrl": "...", "model": "...", "apiKeyRef": "OPENAI_API_KEY" },
  "sub":      { "provider": "openai-compat", "baseUrl": "...", "model": "..." },
  "embedded": { "provider": "ollama-embed", "baseUrl": "...", "model": "...", "dims": 1024 }
}
```

`provider`: `openai-compat` | `ollama-embed` | `anthropic` | `glm`
(local Ollama/vLLM = `openai-compat`/`ollama-embed`, no auth).

## Secret policy — **no plaintext, ever**

`llm.json` is a git-tracked backup unit. It **must never contain a raw
API key**. Keyed providers reference a secret by name only:

- `apiKeyRef` = an OS-keychain entry name **or** an environment variable
  name. The actual secret lives in the OS keychain (device-key
  encrypted) or the process env — **never in this file, never on disk in
  plaintext** (cleanroom deep-audit F8/§128: keytar / OS keychain
  required; in-memory Map / plaintext forbidden).
- Local Ollama / vLLM need no key — omit `apiKeyRef`.

## Resolution priority (naia-agent)

```
process.env  >  naia-settings/llm.json  >  ./naia-agent.env  >  ~/.naia-agent
```

`naia-agent` finds this file via `NAIA_ADK_PATH` (the naia-adk workspace
root). `main` maps onto the existing provider resolution; `sub` /
`embedded` are exposed as `NAIA_SUB_*` / `NAIA_EMBED_*`.
