---
name: review-pass
version: "3.0"
description: >
  Stage-gated multi-AI cross-validation review with optional REQ-ID traceability.
  4 stages (planning, development, test, integration) with configurable reviewers,
  finding consensus, and convergence loop. Fully project-agnostic and distributable.
triggers:
  - "/review-pass"
  - "review pass"
  - "리뷰 패스"
input_schema:
  stage:
    type: enum
    values: [planning, development, test, integration]
    required: true
    description: "Review stage — determines lenses, reviewers, and convergence"
  files:
    type: "string[]"
    required: true
    description: "File paths to review"
  request_contract_bundle:
    type: string
    required: false
    description: "Exact review-bundle JSON exported by scripts/request-contract.cjs; mandatory in governed mode"
  source_artifacts:
    type: "string[]"
    required: false
    description: "Immutable original human-source artifacts; mandatory for planning and integration"
  baseline_ref:
    type: string
    required: false
    description: "Immutable commit/tree identifying the working product before the change; mandatory for planning and integration"
  preservation_contract:
    type: string
    required: false
    description: "Contract with top-level preservation.baseline_ref/intent/surfaces/vendor_sources and schema-valid surface evidence/authority fields; mandatory for planning and integration"
  incident_history:
    type: string
    required: false
    description: "Prior corrections and known drift; mandatory when any correction or failed review exists, otherwise explicit 'none'"
  context:
    type: string
    required: false
    description: "What was implemented/changed, which issue it addresses"
  req_ids:
    type: "string[]"
    required: false
    description: "REQ-IDs to validate coverage against"
  deferred_req_ids:
    type: "string[]"
    required: false
    description: "REQ-IDs intentionally deferred (won't block convergence)"
  reviewers:
    type: "string[]"
    required: false
    description: "Override default reviewers (e.g. gemini,opencode,codex,claude)"
  "--light":
    type: boolean
    required: false
    description: "Reduce convergence to 1 clean round, skip non-essential lenses"
output:
  documents: []
  records:
    - name: "review_log"
      path: "configurable via review-pass.yaml, default: review-log.json"
  side_effects:
    - description: "Auto-fixes CONFIRMED findings (with safety guard)"
      adapter: "file_system"
steps:
  - id: "validate_inputs"
    action: "Check CLI tools available, load profile, resolve reviewers"
  - id: "complexity_preflight"
    action: "Run deterministic file-size/growth gate and bind its report into every code review"
  - id: "round_loop"
    action: "Run review rounds until convergence"
    gate: false
  - id: "report"
    action: "Output final report"
failure_policy:
  retry: true
  rollback: true
  on_failure: "abort"
idempotency: false
---

# Review Pass v3 — Stage-Gated Multi-AI Cross-Validation

## Purpose

Multi-AI cross-validation review that adapts review power, perspective, and
convergence criteria to the current development stage. Optional REQ-ID
traceability for requirements-driven projects.

**Core principles:**
- **Project-agnostic**: No hardcoded paths, tools, or conventions. All configurable.
- **Independent roles**: Four evidence-separated review executions reduce shared-context blind spots; adapters and model providers are configurable
- **Stage-aware**: Planning, development, test, and integration have different needs
- **Convergent**: Automated loop until at least 2 consecutive clean rounds for every standard stage
- **Traceable**: REQ-ID coverage validated at every stage (when applicable, optional)
- **Source-complete**: In governed mode the exact source chain and full current/prior scope history are mandatory review inputs; caller-selected files cannot redefine scope
- **Baseline-preserving**: Planning and integration compare the current product with an immutable baseline and an explicit surface-preservation contract
- **Evidence-separated**: Source, baseline, implementation/test, and authority/release reviewers receive different evidence views to prevent shared anchoring
- **Safe**: Auto-fix with diff preview, rollback, and safety guard

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `stage` | **yes** | `planning` / `development` / `test` / `integration` |
| `files` | **yes** | Comma-separated file paths to review |
| `request_contract_bundle` | governed mode | Private bundle locator returned by `node scripts/request-contract.cjs review-challenge --unit <id> --writer-session <id>` |
| `source_artifacts` | planning, integration | Immutable original-source files or governed bundle references; AI summaries are not substitutes |
| `baseline_ref` | planning, integration | Immutable commit/tree for the pre-change product |
| `preservation_contract` | planning, integration | Contract containing top-level `preservation.baseline_ref/intent/surfaces/vendor_sources`; each surface carries lowercase disposition, paths, evidence IDs, and destructive authority fields |
| `incident_history` | planning, integration | Immutable chronology of the original directives, later corrections, drift evidence, and current state; a selected incident excerpt or AI summary alone is insufficient |
| `context` | recommended | What was implemented/changed, issue reference |
| `req_ids` | optional | Comma-separated REQ-IDs to validate coverage |
| `deferred_req_ids` | optional | Comma-separated REQ-IDs intentionally deferred |
| `reviewers` | optional | Override default reviewers from profile |
| `--light` | optional | 1 clean round, reduced lens set |

## When to Run

| Development Phase | Review Stage | Purpose |
|-------------------|-------------|---------|
| After Plan, before Build | `planning` | Requirements ↔ Design alignment |
| After each Build phase | `development` | Code ↔ Plan alignment + REQ coverage |
| After E2E Test | `test` | Test quality + REQ-to-test mapping |
| Before Commit/Sync | `integration` | Full E2E traceability audit |

## Core Rules

> **The orchestrator AI does NOT report intermediate results to the user.**
> **CONFIRMED findings are auto-fixed with diff preview (see section 6.5).**
> **CONTESTED findings first receive independent arbitration and source-evidence verification. Ask the user only for a remaining material decision.**
> **Only the final report is shown after convergence.**
> **Governed mode forbids `--light`, caller-only file scope, unsigned deferral, and review without the exact current request-contract bundle.**
> **Planning/integration without original source, immutable baseline, and a preservation contract is NOT CLEAN.**
> **A solo CRITICAL preservation, scope, authority, or release finding is a veto and is never auto-dismissed.**
> **An unwaived deterministic `REFACTOR_REQUIRED` result blocks CLEAN before model voting.**

## Mandatory workflow

1. Validate the input schema and detect governed mode.
2. Before **planning**, read [Preflight Gates](references/preflight.md) and [Stage Profiles and Reviewer Roles](references/stage-profiles.md) in full; apply the governed and product-preservation gates.
3. Before **development**, read those same references in full; apply the governed and deterministic-complexity gates.
4. Before **test**, read those same references in full; apply the governed and deterministic-complexity gates.
5. Before **integration**, read those same references in full; apply all governed, product-preservation, and deterministic-complexity gates.
6. Before invoking any reviewer, read [Invocation and Output Contract](references/invocation-and-output.md) and [Consensus and Convergence](references/consensus-and-convergence.md) in full.
7. When resolving configuration or REQ-ID traceability, read [Configuration and Requirements](references/configuration-and-requirements.md) in full.
8. Before applying fixes, reporting a verdict, or deciding delivery eligibility, read [Reporting and Delivery](references/reporting-and-delivery.md) in full.
9. Run the stage loop until its convergence rule succeeds or a hard stop yields `NOT_CLEAN`. Never infer omitted details from this entrypoint; the linked references are normative parts of the skill.

## Reference map

- [Preflight Gates](references/preflight.md) — governed request-contract, product-preservation, and deterministic-complexity gates.
- [Stage Profiles and Reviewer Roles](references/stage-profiles.md) — reviewer counts, lenses, convergence, arbiters, and separated evidence roles.
- [Invocation and Output Contract](references/invocation-and-output.md) — encoding, prompt delivery, adapters, reviewer prompt, finding schema, and parsing.
- [Consensus and Convergence](references/consensus-and-convergence.md) — matching, vetoes, arbitration, loop algorithm, degradation, health, and anti-anchoring.
- [Configuration and Requirements](references/configuration-and-requirements.md) — config search/defaults/overrides, environment detection, REQ-ID integration, and source authority.
- [Reporting and Delivery](references/reporting-and-delivery.md) — final report schema, fix/escalation classification, light mode, and delivery gate.
