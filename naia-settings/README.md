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

## `review.json` — cross-review reviewer panel + tier policy (SoT)

`llm.json` 의 형제. **실질 적대 검증(substantive review) 역할의 정본** — `main`/`sub` 단일 모델과 달리 **플래그십 다중 독립 리뷰어 패널**을 표현한다. `review-pass` 스킬 + naia-agent 가 소비.

| 키 | 의미 |
|---|---|
| `tier_policy` | 활동별 모델 tier (naia-agent 원조 2계층 정규화): 머리쓰기·설계·실질검증=`flagship` / 형식검증=`light` / 구조=`deterministic` |
| `reviewers[]` | 플래그십 리뷰어 패널 (`claude` · `codex` · `glm-5.1`), 각 `{id, tier, command, stdin, parse}` |
| `excluded` | 제외 도구 + 사유 (gemini-CLI = 응답 불안정) |
| `stages` | 단계별 리뷰어·수렴 (review-pass 정합) |

> **tier 정책**: 리뷰어 = 플래그십(검증=고위험, 강한 모델). 형식검증·번역·미러·드리프트 검출 = 라이트(`sub`). 구조검사 = LLM 무(스크립트). 상세 = `naia-template-project/docs/llm-roles.md` 3-레벨 표.
> **secret 정책 동일**: 이 파일도 git-tracked backup — 키 값 금지, `apiKeyRef`(이름)만.

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
