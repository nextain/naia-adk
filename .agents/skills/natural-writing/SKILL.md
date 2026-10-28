---
name: natural-writing
description: Detect and revise translationese (번역체/번역투) and AI-generated writing habits (AI체) in Korean and English documents with per-language selection. Use when asked to polish prose, remove AI-sounding phrasing, fix Korean translationese, humanize text, proofread Korean/English drafts, or run natural-writing checks ("번역체 줄이기", "AI체 다듬기", "문장 다듬기", "자연스럽게 고쳐줘", "humanize", "translationese", "proofread Korean/English").
argument-hint: "[--lang ko|en] [--strict] [--json] [--config <file>] <files-or-dirs...>"
---

# Natural Writing

Find translationese and formulaic AI phrasing in Markdown or text documents using both the candidate linter and the selected language's contextual checklist, revising unnatural passages while preserving every factual detail. Rules are organized as language packs (`ko`, `en`) that can be toggled per project or per command.

## Workflow

1. **Set reader and purpose**: Decide whether the text is external communication (guides, announcements, release notes, proposals) or internal notes.
2. **Load references**: Read [`references/common.md`](references/common.md) and the target language guide ([`references/ko.md`](references/ko.md) or [`references/en.md`](references/en.md)), including the "What the Linter Cannot Catch" contextual checklist.
3. **Run the linter**: Run `lint-writing.mjs` on the target files to list candidate lines and paragraphs without modifying the source.
   ```bash
   node .agents/skills/natural-writing/scripts/lint-writing.mjs <file-or-dir>
   node .agents/skills/natural-writing/scripts/lint-writing.mjs --lang ko --strict docs/
   ```
4. **Review full paragraphs with linter candidates + contextual checklist**: Inspect each paragraph as a whole using both the linter's candidate matches and the selected language guide's contextual checklist (three-item formulaic lists such as `"빠르고, 쉽고, 안전합니다."`, identical paragraph endings, ungrounded emphasis, and smooth generic filler). Sentences not flagged by the regex linter can and should still be revised when caught by the checklist. Never modify protected regions (fenced code, inline code, URLs, blockquotes, direct quotes).
5. **Compare before and after (final human verification)**: Check the revised text side by side against the original. Across all documents, a human performs the final check to verify that numbers, dates, names, direct quotes, negation, modality (possibility vs. certainty), causal direction, and claim scope remain intact. External-facing documents always require a final human pass.

## Related Principle

- Write external documents in affirmative statements rather than unprompted defensive disclaimers (see `docs/guides/external-writing.md`).

## Output Format and Column Numbering

- Default text output: `<file>:<line>:<column> [<rule-id>] <match> — <message> (<suggest>)`
- `--json` output: JSON array of `{ file, line, column, id, lang, severity, match, message, suggest }`.
- **Column definition**: `column` is the **1-based Unicode code-point index from the start of the line**, where a tab (`\t`) or a non-BMP character (such as an emoji) counts as 1 column. For example, in `"😀 적용되어졌다."`, `"되어졌다"` starts at column `5`.

## Language Configuration

Configuration priority (highest first):

1. CLI flag: `--lang <code>` (e.g., `--lang ko` or `--lang en`) or `--config <path>`
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

### Language Detection (`detect`) and Same-Script Rule

Each pack in `scripts/packs/<lang>.json` defines a top-level `detect` object alongside `rules`:

- `script`: Regular expression matching characters of that language's writing system (e.g., `[\uAC00-\uD7A3\u3131-\u318E]` for `ko`, `[A-Za-z]` for `en`).
- `minChars`: Minimum count of `script` characters required in a line or paragraph (`2` for `ko`, `3` for `en`).
- `minRatio`: Minimum ratio of `script` characters to total Unicode letters (`\p{L}`) in that line or paragraph (`0.15` for `ko` so Korean sentences containing English technical terms are still checked as Korean; `0.6` for `en` so Korean lines with a few English words are not misclassified as English).

When `--lang` is omitted, the linter runs every enabled language pack whose `detect` thresholds match the line or paragraph. Rules for disabled languages never run.

- **Same-script languages (e.g., multiple Latin-script packs enabled)**: When two or more enabled languages share the same character script (such as `en` and `fr`), character script alone cannot separate them without a lexicon, so **all enabled packs whose `detect` criteria match the line or paragraph are executed**. To run only one specific language pack on a single-language document, pass `--lang <code>` or disable the other language in config.

### Adding a New Language

1. Add `scripts/packs/<lang>.json` with `{ "detect": { "script": "...", "minChars": 3, "minRatio": 0.6 }, "rules": [...] }`.
2. Add `references/<lang>.md` with before/after examples, revision notes, and a contextual checklist.
3. Enable `"<lang>": true` in `languages` (via `.agents/context/natural-writing.json` or `defaults.json`). No changes to `scripts/lint-writing.mjs` are needed.

## Key Files

| File | Purpose |
|------|---------|
| `defaults.json` | Default enabled languages, file globs, and protected regions |
| `scripts/lint-writing.mjs` | Read-only CLI linter (Node standard library only) |
| `scripts/packs/ko.json` | Korean detection thresholds and translationese/AI-habit rules |
| `scripts/packs/en.json` | English detection thresholds and AI-habit rules |
| `references/common.md` | Audience/purpose check, protected spans, fact-preservation & contextual checklists |
| `references/ko.md` | Korean translationese (30 types), AI-style guide, and contextual checklist |
| `references/en.md` | English AI-style patterns, before/after pairs, and contextual checklist |
| `references/sources.md` | Reference materials and URLs |
