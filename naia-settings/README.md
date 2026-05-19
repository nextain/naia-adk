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

- `apiKeyRef` = an environment variable name **(Slice A, now)** or an OS
  keychain entry name **(Slice B, device-key encrypted — in progress)**.
  The actual secret lives in the process env or the OS keychain — **never
  in this file** (cleanroom deep-audit F8/§128: plaintext forbidden).
- **Enforced, not just convention**: the `naia-agent` reader actively
  rejects the whole `llm.json` (warn + skip; value never logged) if any
  role carries a plaintext-secret-looking key (`apiKey`/`key`/`token`/…)
  or value (`sk-…`/`AIza…`/40-hex/…). A raw key here is refused, not
  silently consumed into git.
- Local Ollama / vLLM need no key — omit `apiKeyRef` (a loopback/private
  `baseUrl` gets a dummy key automatically; remote URLs do **not**).

## Configure via `naia-agent login`

```
pnpm naia-agent login --adk <this-workspace> \
  --main "openai-compat|http://127.0.0.1:11434/v1|gemma3n:e4b" \
  --embedded "ollama-embed|http://127.0.0.1:11434/v1|bge-m3|1024" \
  [--key ANTHROPIC_API_KEY=sk-…]   # → OS keychain, never written here
```

Writes this `llm.json` (config only) + `~/.naia-agent/config.json`
(`naiaAdkPath`, so later runs need no `NAIA_ADK_PATH`). `--key` is stored
device-key-encrypted in the OS keychain; if unavailable, login refuses
(no plaintext) and tells you to `export` it as an env var instead.

## Resolution priority (naia-agent)

```
process.env  >  naia-settings/llm.json  >  ./naia-agent.env  >  ~/.naia-agent
```

`naia-agent` finds this file via `NAIA_ADK_PATH` (the naia-adk workspace
root). `main` maps onto the existing provider resolution; `sub` /
`embedded` are exposed as `NAIA_SUB_*` / `NAIA_EMBED_*`.
