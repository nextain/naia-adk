---
name: natural-writing
description: Detect and revise translationese (번역체/번역투) and AI-generated writing habits (AI체) in Korean and English documents with per-language selection. Use when asked to polish prose, remove AI-sounding phrasing, fix Korean translationese, humanize text, proofread Korean/English drafts, or run natural-writing checks ("번역체 줄이기", "AI체 다듬기", "문장 다듬기", "자연스럽게 고쳐줘", "humanize", "translationese", "proofread Korean/English").
argument-hint: "[--lang ko|en] [--strict] [--json] [--config <file>] <files-or-dirs...>"
---

# Natural Writing

Find translationese and formulaic AI phrasing in Markdown or text documents and revise only the flagged passages while preserving every factual detail. Rules are organized as language packs (`ko`, `en`) that can be toggled per project or per command.

## Workflow

1. **Set reader and purpose**: Decide whether the text is external communication (guides, announcements, release notes, proposals) or internal notes.
2. **Load references**: Read [`references/common.md`](references/common.md) and the target language guide ([`references/ko.md`](references/ko.md) or [`references/en.md`](references/en.md)).
3. **Run the linter**: Run `lint-writing.mjs` on the target files to list candidate lines without modifying the source.
   ```bash
   node .agents/skills/natural-writing/scripts/lint-writing.mjs <file-or-dir>
   node .agents/skills/natural-writing/scripts/lint-writing.mjs --lang ko --strict docs/
   ```
4. **Revise only flagged spans**: Rewrite the unnatural phrase in context. Keep numbers, dates, names, direct quotes, negation, modality (possibility vs. certainty), causal direction, and claim scope intact.
5. **Compare before and after**: Check the revised text side by side against the original to verify none of the items in step 4 changed. External-facing documents require a final human pass.

## Related Principle

- Write external documents in affirmative statements rather than unprompted defensive disclaimers (see `docs/guides/external-writing.md`).

## Language Configuration

Configuration priority (highest first):

1. CLI flag: `--lang <code`> (e.g., `--lang ko` or `--lang en`) or `--config <path>`
2. Project config: `.agents/context/natural-writing.json` (optional; create only when a project needs custom settings)
3. Skill defaults: [`.agents/skills/natural-writing/defaults.json`](defaults.json)

Example `.agents/context/natural-writing.json`:

```json
{
  "languages": { "ko": true, "en": true },
  "include": ["**/*.md"],
  "exclude": ["node_modules/**", ".git/**"],
  "protect": ["code", "inline_code", "url", "blockquote", "quoted"]
}
```

When `--lang` is omitted, the linter inspects each line's character script among enabled languages and skips ambiguous lines. Rules for disabled languages never run.

### Adding a New Language

1. Add `scripts/packs/<lang>.json` with rule objects (`id`, `pattern`, `flags`, `severity`, `message`, `suggest`, `bad`, `good`).
2. Add `references/<lang>.md` with before/after examples and revision notes.
3. Enable `"<lang>": true` in `languages` (and ensure the script range is listed in `SCRIPT_RANGES` inside `scripts/lint-writing.mjs`).

## Key Files

| File | Purpose |
|------|---------|
| `defaults.json` | Default enabled languages, file globs, and protected regions |
| `scripts/lint-writing.mjs` | Read-only CLI linter (Node standard library only) |
| `scripts/packs/ko.json` | Korean translationese and AI-habit rule pack |
| `scripts/packs/en.json` | English AI-habit rule pack |
| `references/common.md` | Audience/purpose check, protected spans, fact-preservation checklist |
| `references/ko.md` | Korean translationese (30 types) and AI-style revision guide |
| `references/en.md` | English AI-style patterns and before/after pairs |
| `references/sources.md` | Reference materials and URLs |
