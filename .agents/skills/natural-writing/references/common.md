# Common Principles for Natural Writing

## 1. Reader and Purpose First

Before changing any sentence, identify who will read the document and why:

- **External documents** (user guides, announcements, release notes, proposals): Write clear, affirmative sentences that state what the system or policy does. Do not include unprompted defensive disclaimers. Require a human review pass before publishing.
- **Internal records** (work logs, incident notes, rough drafts): Keep revisions minimal so technical accuracy and original chronology stay intact.

Treat linter matches as candidates for review, not automatic deletions. Context decides whether a phrase carries necessary meaning.

## 2. Protected Regions

Never alter text inside protected spans when revising a document:

- Fenced code blocks (` ``` ` or `~~~`)
- Inline code spans (`` `...` ``)
- URLs and file paths
- Blockquotes (`> ...`)
- Direct quotations wrapped in double quotes (`"..."` or `“...”`)

Quoting an external source or command output requires exact fidelity even if the quoted phrasing contains translationese.

## 3. Fact-Preservation Checklist

Compare the original sentence and the revised sentence side by side. Verify that every item below remains unchanged:

- [ ] **Numbers and units**: Counts, percentages, latencies, versions, and prices are identical.
- [ ] **Dates and times**: Deadlines, timestamps, and sequence order are identical.
- [ ] **Names and identifiers**: Proper nouns, role titles, file names, and config keys are untouched.
- [ ] **Direct quotes**: Quoted strings and blockquotes match the source character for character.
- [ ] **Negation**: Prohibitions (`must not`, `하지 않는다`) and negative facts are not flipped or dropped.
- [ ] **Modality and conditions**: Possibility (`can`, `할 수 있다`), obligation (`must`, `해야 한다`), and conditional clauses (`if`, `~하면`) keep their exact condition. Do not turn a conditional possibility into an unconditional fact.
- [ ] **Causal direction and agency**: Who performed the action and what caused the outcome remain accurate. When converting passive voice to active voice, verify the actual actor before naming a subject.
- [ ] **Claim scope**: Qualifiers such as `some`, `in this test`, `일부`, or `특정 조건에서` are not broadened into universal claims.
