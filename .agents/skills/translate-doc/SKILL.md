---
name: translate-doc
description: Translate large TXT, Markdown, or PDF documents with a user's Naia account credits. Use when a user asks to translate a document through naia.land, inspect Naia-supported models or live prices, estimate translation cost, resume a long translation, or produce validated Markdown/HTML/PDF output without exposing the Naia API key.
---

# Translate Documents with Naia

Use the user's Naia API key and the OpenAI-compatible Naia gateway. The workflow is resumable, records model and token receipts, and keeps copyrighted source text out of the repository.

## Setup

Set the key in the process environment. Never put its value in YAML, Markdown, a command argument, logs, or Git.

```powershell
$env:NAIA_KEY = "gw-..."
```

Do not put a user-scoped Naia key in `.env.local`; that file is reserved for development-service configuration in this workspace. The translation CLI deliberately reads only the process environment and never searches workspace files for secrets.

`NAIA_KEY` is the public credential name. `NAIA_API_KEY` and `NAIA_ANYLLM_API_KEY` remain accepted as compatibility aliases. The default gateway is `https://api.nextain.io/v1`; override it with `NAIA_BASE_URL` only for an intentional alternate deployment.

Keep long-lived secrets in an OS credential manager. A private ADK fork may additionally keep its human-controlled backup in `data-private/key/` under the existing age-encrypted `key.age` vault. `naia-settings/llm.json` stores only non-secret provider/model settings and `apiKeyRef: "NAIA_KEY"`; it must never contain the key value. Unlocking or relocking `key.age` requires the owner to enter the passphrase in a real terminal by following the `secret-vault` skill.

## Workflow

1. Discover live models and prices. These catalog calls do not require a key.
2. Run `check` to validate the configured key and report its credit balance without making a paid model call.
3. Run `estimate` before a large job. Treat the result as an estimate, because tokenizer behavior and translated length vary.
4. Translate to a gitignored working directory. Do not commit purchased or confidential source/translation text.
5. If interrupted, run the same command again with the same `--output-dir`; completed chunks are reused only when their input hash and job settings match.
6. Inspect `manifest.json` and `receipt.json`, then use `verify` before handing off output.

## Commands

Run from the ADK root:

```powershell
python .agents/skills/translate-doc/scripts/naia_translate.py models
python .agents/skills/translate-doc/scripts/naia_translate.py pricing
python .agents/skills/translate-doc/scripts/naia_translate.py check
python .agents/skills/translate-doc/scripts/naia_translate.py estimate C:\path\book.pdf --model deepseek-v4-flash
python .agents/skills/translate-doc/scripts/naia_translate.py translate C:\path\book.pdf --output-dir tmp\book-ko --model deepseek-v4-flash --concurrency 4 --title "한국어 번역본"
python .agents/skills/translate-doc/scripts/naia_translate.py verify --output-dir tmp\book-ko
```

Use `--format markdown,html,pdf` to choose outputs. `--concurrency` is bounded to 1-16 and defaults to 4. Start at 4; a larger value can saturate the gateway queue and make even catalog or balance calls slower. Lower it if requests stall or the account/model reports rate limits. The PDF renderer requires PyMuPDF and a Korean-capable system font. Use `--source-text` when a trusted extraction already exists; the file hash still binds the job to the original input.

## Model selection and settings

Explicit `--model` wins. Otherwise the script checks `naia-settings/config.json` for `memoryLlmProvider: "naia"` and `memoryLlmModel`, then `NAIA_MODEL`, then selects a live text model from the catalog. Do not infer a model from an upstream cloud vendor: the Naia model key is the public contract.

Model availability and prices can change. Always use the live catalog immediately before estimating or starting a material job. Prices returned by `/v1/pricing` are the charged Naia prices; do not add markup a second time.

## Safety and completion rules

- Obtain or confirm authorization before translating content the user does not own or control.
- Keep source text, translated chunks, manifests containing filenames, and generated PDFs in a private or gitignored directory.
- The script must never print, persist, or transmit the API key except in the HTTPS authorization header.
- A successful API response is not completion. `verify` must confirm the input digest, chunk count, ordered non-empty chunk outputs, final output digests, and receipt.
- Preserve code blocks, URLs, headings, lists, tables, page markers, names, and numbers. Do not silently summarize or omit difficult passages.
- If live pricing is absent for the chosen model, report that cost cannot be estimated and require explicit `--allow-unpriced` before translation.

See [Naia gateway contract](references/naia-gateway.md) for endpoint and accounting details.
