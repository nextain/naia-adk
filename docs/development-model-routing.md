# Development Model Routing

## Purpose

This document defines development-process LLM roles for `naia-adk` and its forks. It is separate from runtime conversation and embedding settings in `naia-settings/llm.json`.

Codex retains integration authority: it owns workspace commands, final file changes, and integration decisions. A role can prepare work but cannot replace that authority.

## P01: user scenarios

| ID | Scenario | Expected outcome |
| --- | --- | --- |
| UC-DMR-1 | A normal development task is delegated. | The task routes to `main` for orchestration or `sub` for a bounded implementation through OpenCode/OpenRouter HY3. |
| UC-DMR-2 | A task changes an architecture, cross-repository contract, public API, or has security/data-loss risk. | The workflow automatically escalates to the `expert` Sol role before implementation proceeds. |
| UC-DMR-3 | A maintainer asks for status or routine communication. | The `monitoring` Terra role is used; it does not silently become the expert role. |
| UC-DMR-4 | A completed change needs hostile review. | Terra high and HY3 high review the same snapshot in parallel; each has a role, session, and execution distinct from every producer and the peer reviewer. |
| UC-DMR-5 | A translated human-facing artifact needs review. | Claude Haiku and HY3 medium review it in parallel; each has a role, session, and execution distinct from the translator and peer reviewer. |

## P02: test coverage map

| Scenario | Deterministic coverage |
| --- | --- |
| UC-DMR-1 | Router tests assert OpenCode/HY3 argv construction and dry-run non-execution. |
| UC-DMR-2 | The tracked configuration test verifies automatic escalation mode and all escalation triggers. |
| UC-DMR-3 | Router tests assert the Codex/Terra command shape. |
| UC-DMR-4 | `review.json` names both Terra high and HY3 high reviewers for every substantive review stage. |
| UC-DMR-5 | Router tests assert Claude's prompt is supplied on stdin rather than interpolated into a shell command, and model routing records the two translation reviewers. |

## P03: requirements

The normative requirement is `REQ-051-development-model-routing.yaml`.

## Configuration and execution

The tracked default is `naia-settings/development-models.json`. Forks may replace model identifiers or reasoning effort locally, but must preserve the role names and route semantics.

```text
node scripts/development-model-router.cjs --config naia-settings/development-models.json --role sub --prompt-file tmp/task.md --repo .
```

The command is dry-run by default and prints an argv envelope. Add `--execute` only after the calling workflow has completed its applicable approval and scope gates. The router passes arguments directly to child processes; it does not construct a shell command.

## Boundaries

- This is the ADK collaboration route only. `naia-shell` and `naia-agent` use their embedded Pi route and do not inherit OpenCode execution.
- `main` and `sub` may name the same model. Their different authority, context, and reasoning effort are intentional.
- `memory` remains a functional runtime role, not a development tier.
- Substantive adversarial review uses Terra high and HY3 high in parallel. Each reviewer is a separate role, session, and execution from every artifact producer it reviews and from the peer reviewer; HY3 high may review HY3 medium output when those boundaries differ.
- Translation uses HY3 low. Claude Haiku and HY3 medium perform parallel translation review and both must report clean.
- The P0 no-runner evaluator validates digest-bound receipt evidence and configured role/session/execution boundaries. It neither starts providers/runners nor proves that review processes ran in parallel. A defect invalidates the affected generation; a fourth rerun is rejected (`maxReruns: 3`).
