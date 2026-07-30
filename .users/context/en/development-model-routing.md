# Development Model Assignment

This document defines the model assignment criteria for the Alpha ADK root collaboration process. Where possible, perform contract checks and deterministic checks first, and use the least expensive role capable of safely handling work with a defined scope. Escalate to a higher-level role only when risk or unresolved insufficiency of evidence exists. OpenCode is not used. HY3 may be evaluated only in an isolated benchmark and is not used for production routing. Passing the benchmark alone does not automatically lift this prohibition; a separate policy decision is required.

## General Contract Layer

The canonical rules define the capabilities and evidence of the `coordinator·explorer·designer·implementer·tester·independent reviewer·mediator·translator`, rather than the model names of Codex or Claude. Specific CLI flags and model names belong only in adapters. Therefore, other tools may use this harness if they satisfy the same role capabilities, contract scope, identical revision hash, distinct role, session, and execution IDs, and blocking conditions upon failure.

Before calling a model, perform deterministic checks first and select the least expensive adapter that satisfies the required capabilities and risk level. If no adapter can provide a required independent role, block the operation rather than replacing it with a self-check.

General roles are explicitly mapped in adapters. The implementer is connected to Codex's worker, and translation uses a low-cost fallback chain in the order Claude Haiku 4.5 → Codex GPT-5.6 Luna(low) → Claude Sonnet. All CLI calls use a shared stdin-based invocation function, so long prompts are not passed as command-line arguments.

## Codex Adapter

Codex `gpt-5.6-sol` (medium reasoning level) is the default coordinator and final integration owner. This role handles contract interpretation, integration decisions, final cleanup, and final file changes.

| Work | Model and reasoning level | Execution scope |
|---|---|---|
| Scoped exploration, context mapping, evidence collection | Codex Terra, low | Read-only |
| Implementation within the approved scope | Codex Terra, medium | Workspace writes allowed |
| Analysis of scoped design alternatives | Codex Terra, high | Read-only |
| Focused testing and verification evidence collection | Codex Terra, medium | Workspace writes allowed |
| Independent adversarial review of the revision | A model and provider different from the implementer where possible; required panel: Codex Terra, high | Read-only |
| Mediation of high-risk integration or unresolved review findings | Codex Sol, high | Read-only |

## Claude Adapter

Claude does not pin a dated legacy model ID to this contract. Use the currently supported alias or model name from the installed Claude configuration.

- Lightweight role: Use for mechanical classification, translation batches, and scoped exploration when supported by the installation configuration.
- General role: Use for general analysis or implementation selected by the installation configuration.
- Higher-level role: Use only for design, safety-critical decisions, or unresolved review evidence.

Claude likewise cannot serve as both the implementer and the adversarial reviewer in the same execution.

## Independent Adversarial Review

An implementer's self-check is useful, but it is not an adversarial review. An adversarial review is mandatory and, where possible, a model or provider different from the implementer is preferred. This preference never relaxes the following mandatory independence conditions:

- `session_id`
- `execution_id`

Reviewers inspect the same immutable revision hash in read-only mode, rather than a previous or unclear state. Every change requires independent clean reviews by Codex Terra and Claude Sonnet while the revision remains unchanged. Session and execution IDs in local receipts are recalculated from the original CLI execution records preserved in `.agents/progress/review-evidence/`, and are not accepted based solely on strings entered by the caller. The Sol mediator adjudicates the evidence only when unresolved findings exist.

All review evidence must include the contract or requirement ID, revision hash, the implementer's and reviewer's session and execution IDs, and test records.

Local hooks are deterministic safeguards for the tool paths exposed to Codex through hooks. Ambiguous shell writes are blocked unless the approval contract contains the exact command pattern. The boundary that guarantees the cryptographic authenticity of processes and models is signed isolated review execution; ordinary progress JSON or local hook files do not claim to guarantee authenticity at that level.

## Cost Control

Schema, hash, mirror, index, and record checks are deterministic checks that do not call an LLM. Translation and mechanical classification process only changed inputs in lightweight model batches with hash caching. Sol's high reasoning level is used only for mediation or genuinely high-risk work.

## Quick Application Profiles

The canonical source for the primary structure is `packages/benchmark-contract/baselines/development-composition-profiles.json`. Profiles contain only roles intended for long-term retention and their safety conditions, while current model bindings are separated. When a new model becomes available, update only the small experiments and binding evidence for the relevant role rather than redesigning the profile.

- `control`: Uses Sol for all roles in separate executions. It is the quality and cost baseline and the high-risk fallback.
- `balanced`: Sol handles planning and integration, while Terra performs scoped implementation and focused testing. This is the currently available opt-in default profile.
- `economy`: In addition to `balanced`, assigns only scoped, low-risk mechanical work with precise automated validators to Luna.

Revert to Sol when the scope is not limited or the risk level is high. Independent reviews must use session and execution IDs different from those of the author and, where possible, different model bindings. The initial offering means that `balanced` is available; it does not mean that cost savings for the overall development composition have been demonstrated.

## Benchmark Candidates and Promotion Conditions

Codex `gpt-5.6-sol` is fixed as the primary coordinator and final integrator. The benchmark is a test of whether a less expensive model, provider, or adapter combination can be used for limited subordinate work; it is not a test to replace Sol. Results comparing different providers are not expressed as causal differences attributable solely to the model.

- Codex Terra: Candidates for exploration, implementation, testing, and independent review
- Codex Luna: Candidate for translation, mechanical classification, and limited exploration
- Azure `DeepSeek-V4-Flash`: Candidate for analysis, code generation, and structured output. Tool-calling capability is not claimed.
- OpenRouter `tencent/hy3`: Candidate for analysis and code generation. Tool use is evaluated only after passing functional exploration, with the actual higher-level provider and routing method fixed.
- Upstage private beta `solar-open2`: Candidate for Korean analysis, code generation, and document work. The key is injected only as `UPSTAGE_KEY` and is not placed in the repository.

A model capability benchmark runs fixed tasks on models and evaluates them with an external grader. An agent execution benchmark runs the actual runtime and fault-injection tools using a fixed model. A harness benchmark deterministically runs the actual hooks and validators rather than asking the model to guess the correct state. All retries, fallbacks, timeouts, and final failures are included in the quality and cost denominators. Korean dual context and Windows-native operation are validated separately, and promotion to production routing requires two clean independent adversarial reviews of the same revision.

Common model comparisons are limited to tool-free text and JSON tasks. Tool compatibility is recorded in provider-specific tests and is not combined with the common score. Candidate models may see only an empty temporary work folder and public inputs; the answer, grader, and manifest remain outside the candidate process and installed packages. The answer accesses the candidate output only after its hash has been fixed in a separate grading process. Each attempt uses a new session, and the caching method is recorded.

Development testing runs 24 public task bundles per path three times and is not used for production decisions. Production promotion testing runs at least 80 private task bundles five times after a priori power analysis. Sol versus the five candidates is grouped into one Holm correction family, and the task-level paired bootstrap with 10,000 iterations must show a lower bound on the quality difference of at least -5%p and an upper-bound cost reduction of at least 15%. Sol comparison workers run in minimum-privilege sessions separate from the coordinator, and coordination costs are recorded separately as common overhead.

Receipts record the provider, endpoint, API version, original model, deployment/routing model, actual higher-level provider, adapter version and hash, request configuration hash, usage conversion version, and unsupported arguments. Authorization headers, API keys, signed URLs, and credential values are not placed anywhere in records, logs, or hashes. Windows must pass separately with Node 22 or later and native PowerShell; successful remote model calls do not substitute for passing the Windows harness.

All benchmark journals create an HMAC hash chain for each record and revalidate it before analysis. On Windows, a native PowerShell helper encrypts and stores the HMAC key using CurrentUser DPAPI and does not print or save the plaintext key to a file. The core runner receives the key externally on any platform, so DPAPI is a Windows-only adapter and not a dependency of other platforms. Executions whose keys cannot later be recovered for verification are treated only as calibration material and are not used for routing decisions.
