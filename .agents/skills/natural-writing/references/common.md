# Common Principles for Natural Writing

## 1. Reader and Purpose First

Before changing any sentence, identify who will read the document and why:

- **External documents** (user guides, announcements, release notes, proposals): Write clear, affirmative sentences that state what the system or policy does. Do not include unprompted defensive disclaimers. Require a human review pass before publishing.
- **Internal records** (work logs, incident notes, rough drafts): Keep revisions minimal so technical accuracy and original chronology stay intact.

Treat linter matches as starting candidates and review the full paragraph in context. Sentences not flagged by the regex linter should still be revised when they match the contextual checklist below.

## 2. Protected Regions

Never alter text inside protected spans when revising a document:

- Fenced code blocks (` ``` ` or `~~~`, including unclosed fences or fences closed by a longer marker of the same character)
- Inline code spans (`` `...` ``)
- URLs and file paths
- Blockquotes (`> ...`)
- Direct quotations wrapped in double quotes (`"..."` or `“...”`, single-line or multi-line within a paragraph)

Quoting an external source or command output requires exact fidelity even if the quoted phrasing contains translationese.

## 3. Fact-Preservation Checklist

Compare the original sentence and the revised sentence side by side. Across all documents, a human performs the final verification that every item below remains unchanged (and external-facing documents always require a human pass before publishing):

- [ ] **Numbers and units**: Counts, percentages, latencies, versions, and prices are identical.
- [ ] **Dates and times**: Deadlines, timestamps, and sequence order are identical.
- [ ] **Names and identifiers**: Proper nouns, role titles, file names, and config keys are untouched.
- [ ] **Direct quotes**: Quoted strings and blockquotes match the source character for character.
- [ ] **Negation**: Prohibitions (`must not`, `하지 않는다`) and negative facts are not flipped or dropped.
- [ ] **Modality and conditions**: Possibility (`can`, `할 수 있다`), obligation (`must`, `해야 한다`), and conditional clauses (`if`, `~하면`) keep their exact condition. Do not turn a conditional possibility into an unconditional fact.
- [ ] **Causal direction and agency**: Who performed the action and what caused the outcome remain accurate. When converting passive voice to active voice, verify the actual actor before naming a subject.
- [ ] **Claim scope**: Qualifiers such as `some`, `in this test`, `일부`, or `특정 조건에서` are not broadened into universal claims.

## 4. What the Linter Cannot Catch (Contextual Checklist)

Regular expressions only catch surface tokens. Inspect every paragraph against this checklist even when `lint-writing.mjs` reports zero findings:

- [ ] **Mechanical three-item lists**: Are adjectives, verbs, or nouns stacked in formulaic triads (e.g., `"빠르고, 쉽고, 안전합니다."` or `"fast, easy, and secure"`) without concrete measurements or facts?
- [ ] **Repetitive paragraph endings and cadence**: Do consecutive paragraphs end with the same verb ending or follow a cookie-cutter `"definition → three points → wrap-up summary"` template?
- [ ] **Ungrounded emphasis or vague authority**: Are claims padded with unsupported intensifiers or unnamed authorities instead of specific evidence?
- [ ] **Smooth generic filler**: Are there introductory platitudes, restatements of the heading, or empty hedging clauses that can be deleted without losing information?
- [ ] **Subject-predicate coherence across sentences**: Did a sentence switch subjects mid-way or hide the actor behind an awkward nominalized clause that regex rules did not match?
