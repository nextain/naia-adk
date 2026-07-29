# Development Model Assignment

This document defines the model assignment criteria for the Alpha ADK root collaboration procedure. Where possible, perform contracts and deterministic checks first, and use the least expensive role capable of safely handling the scoped work. Escalate to a higher role only when there is risk or unresolved lack of evidence. OpenCode and HY3 are not used for model assignment in this workspace.

## General Contract Layer

The canonical rules define the capabilities and evidence of the `coordinator · explorer · designer · implementer · tester · independent reviewer · arbitrator · translator`, rather than the model names of Codex or Claude. Specific CLI flags and model names are kept only in adapters. Therefore, other tools may also use this harness if they satisfy the same role capabilities, contract scope, identical revision hash, distinct roles · sessions · execution IDs, and blocking conditions on failure.

Before calling a model, perform deterministic checks first, then select the least expensive adapter that satisfies the required capabilities and risk level. If no adapter can provide a required independent role, block rather than replacing it with a self-check.

General roles are explicitly mapped in adapters. The implementer is connected to Codex's worker, while translation uses a low-cost fallback chain in the order Claude Haiku 4.5 → Codex GPT-5.6 Luna(low) → Claude Sonnet. All CLI calls use a shared stdin-based invocation function, so long prompts are not passed as command-line arguments.

## Codex Adapter

The default coordinator and final integration owner is Codex's `gpt-5.6-sol` (medium reasoning level). This role handles contract interpretation, integration decisions, final cleanup, and final file changes.

| Work | Model and reasoning level | Execution scope |
|---|---|---|
| Scoped exploration, context mapping, evidence collection | Codex Terra, low | Read-only |
| Implementation within the approved scope | Codex Terra, medium | Workspace write access allowed |
| Analysis of scoped design alternatives | Codex Terra, high | Read-only |
| Focused testing and validation evidence collection | Codex Terra, medium | Workspace write access allowed |
| Independent adversarial review of the revision | A model · provider different from the implementer where possible; the required panel is Codex Terra, high | Read-only |
| Arbitration of high-risk integration or unresolved review findings | Codex Sol, high | Read-only |

## Claude Adapter

Claude does not pin this contract to an outdated model ID with a specific date. Use the currently supported alias or model name from the installed Claude configuration.

- Lightweight roles: Use for mechanical classification, translation batches, and scoped exploration when supported by the installation configuration.
- General roles: Use for general analysis or implementation selected by the installation configuration.
- Higher-level roles: Use only for design, safety-critical decisions, or unresolved review evidence.

Claude likewise cannot serve concurrently as both the implementer and the adversarial reviewer of the same execution.

## Independent Adversarial Review

The implementer's self-check is useful, but it is not an adversarial review. Adversarial review is mandatory, and where possible, a model or provider different from the implementer is preferred. This preference never relaxes the following mandatory independence conditions.

- `session_id`
- `execution_id`

The reviewer examines the same immutable revision hash in read-only mode, rather than a previous or unclear state. Every change requires independent clean reviews from Codex Terra and Claude Sonnet while the revision remains unchanged. Session and execution IDs in local receipts are recalculated from the original CLI execution records preserved in `.agents/progress/review-evidence/`, and are not accepted based solely on a string written by the caller. The Sol arbitrator determines the evidence only when unresolved findings remain.

All review evidence must include the contract or requirement ID, revision hash, the implementer's and reviewer's session and execution IDs, and test records.

Local hooks are deterministic safeguards for tool paths exposed to Codex by hooks. Ambiguous shell writes are blocked unless the approval contract contains the exact command pattern. The boundary that guarantees the cryptographic authenticity of processes and models is the signed isolated review execution; general progress JSON or local hook files do not claim to guarantee authenticity at that level.

## Cost Control

Schema, hash, mirror, index, and record checks are deterministic checks that do not call an LLM. Translation and mechanical classification process only changed inputs in lightweight model batches with hash caching. Sol's high reasoning level is used only for arbitration or genuinely high-risk work.
