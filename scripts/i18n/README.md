<!-- Copyright 2026 Nextain Inc. All rights reserved. -->

# scripts/i18n — context-doc translation pipeline

Small-model KO→EN translation for the **hand-curated** root context docs.

## Why this exists

Two different doc-mirror conventions live in this workspace:

- **ADK series** (`naia-adk`, `naia-business-adk`, `naia-corp-adk`):
  `.users/context/*.md` is a *mechanical* JSON→MD render of
  `.agents/context/*.json`, kept in sync by the wired
  `agents-context-mirror.js` PostToolUse hook. Same language, no translation.
  **Not handled here** — it is self-maintaining.

- **Root `alpha-adk`**: `.users/context/*.md` is **hand-curated** Korean
  human documentation (governance / philosophy / rules guides, with a
  Copyright banner — *not* a hook render). Its English counterpart
  `.users/context/en/*.md` had **no automation** and drifted (only
  `contributing.md` + `philosophy.md` existed, ~28 days stale).

This pipeline is the "translate on context update via a small model" step:
it regenerates `.users/context/en/<name>.md` from the Korean source with a
small LLM, pinning NAIA terminology and preserving Markdown structure.

## Usage

```bash
# from repo root
python3 scripts/i18n/translate-ctx.py            # translate changed sources
python3 scripts/i18n/translate-ctx.py --force    # re-translate everything
python3 scripts/i18n/translate-ctx.py --dry-run  # show what would run
python3 scripts/i18n/translate-ctx.py --only philosophy,readme
```

Idempotent: a content-hash sidecar (`.users/context/en/.translate-state.json`)
records source and output hashes per managed file; unchanged sources are skipped.
Re-running after editing a Korean doc re-translates only that doc. Deleting or
renaming a managed source also removes its stale English output and receipt;
English-only files without translation receipts are preserved.

## Backends

| Env | Effect |
|-----|--------|
| `I18N_BACKEND=cli` (default) | `LLM_CLI=gemini` (default) \| `claude` \| `codex` — no API key, matches `naia-sing/scripts/translate.py` convention |
| `I18N_BACKEND=http` | OpenAI-compatible POST to `I18N_ENDPOINT` (e.g. naia-serve `http://localhost:8002/v1/chat/completions`) with `I18N_MODEL` — fully local / private |

`gemini` is a small model (Flash-class); naia-serve gives a fully-local
option. Translating **public** contributor docs with a model is acceptable;
this pipeline never sends private memory or `.agents` reasoning content.

`glossary.md` pins product/term renderings and the public-surface tone rule;
it is injected into every prompt.

## Wiring

Claude Code and Codex use the same portable Node hook. PostToolUse only
queues changed `.users/context/*.md` names in sorted, deduplicated form;
it never calls a model per edit. Queue updates and translation execution use
separate atomic locks, so concurrent edits remain enqueueable while only one
translator drains every claimed batch. A failed batch keeps the previous
English files intact and merges its claim back for retry. Stop routes the
batch through Haiku 4.5, Codex Luna (low reasoning), then Sonnet. Every
adapter is built by the shared shell-free invocation helper and receives the
prompt on stdin rather than in command-line arguments.

Windows runs this flow natively with Python and Node. WSL, Cygwin, MSYS2,
Linux VMs, and Linux containers are not Windows dependencies.

## Scope / not yet covered

- `naia-os` uses a *triple-mirror* where English is the **source** and
  `ko/` is the derived mirror — the inverse direction. Not handled here;
  tracked separately.
